/** Operator-only return of unused Base mainnet funds to the ORIGINAL Ledger payer. */
import {createPublicClient,http,erc20Abi,parseAbiItem,verifyTypedData,type Hex} from 'viem';
import {x402Client} from '@x402/core/client';import {HTTPFacilitatorClient} from '@x402/core/http';import {ExactEvmScheme} from '@x402/evm/exact/client';
import type {ClientEvmSigner} from '@x402/evm';import type {PaymentPayload,PaymentRequirements} from '@x402/core/types';
import {Journal,digest,units} from './journal.ts';import {chainSettlementVerifier,type ExactAgentAuthority,type VerifyExactSettlement} from './agent-exact.ts';
interface ReturnRow {authority_id:string;state:string;amount:string;from_block:string;payload:string|null;offer:string|null;transaction_hash:string|null;error:string|null}
export interface AgentReturnOptions {
 authority:ExactAgentAuthority;journal:Journal;rpcUrl:string;facilitatorUrl:string;signer:ClientEvmSigner;
 chain?:{chainId:()=>Promise<number>;balance:()=>Promise<{amount:string;block:string}>;findTransaction:(payload:PaymentPayload,fromBlock:string)=>Promise<string|null>};
 facilitator?:Pick<HTTPFacilitatorClient,'verify'|'settle'>;verify?:VerifyExactSettlement;
}
export class AgentReturnController {
 private readonly options:AgentReturnOptions;private readonly chain:NonNullable<AgentReturnOptions['chain']>;private readonly facilitator:NonNullable<AgentReturnOptions['facilitator']>;private readonly verify:VerifyExactSettlement;
 private busy=false;private phase='idle';private lastError:string|null=null;
 constructor(options:AgentReturnOptions){
  this.options=options;const a=options.authority;
  if(a.network!=='eip155:8453'||options.signer.address.toLowerCase()!==a.spendingAddress.toLowerCase()||a.payerAddress.toLowerCase()===a.spendingAddress.toLowerCase())throw new Error('Only the reviewed Base mainnet spending wallet can return funds');
  options.journal.db.exec("CREATE TABLE IF NOT EXISTS agent_returns(authority_id TEXT PRIMARY KEY REFERENCES mandates(id),state TEXT NOT NULL,amount TEXT NOT NULL,from_block TEXT NOT NULL,payload TEXT,offer TEXT,transaction_hash TEXT,error TEXT)");
  const rpc=createPublicClient({transport:http(options.rpcUrl,{timeout:15000,retryCount:0})});
  this.chain=options.chain??{
   chainId:()=>rpc.getChainId(),balance:async()=>{const block=await rpc.getBlockNumber();return{amount:String(await rpc.readContract({address:a.asset as Hex,abi:erc20Abi,functionName:'balanceOf',args:[a.spendingAddress as Hex],blockNumber:block})),block:String(block)};},
   findTransaction:async(payload,fromBlock)=>{const nonce=(payload.payload as {authorization?:{nonce?:Hex}}).authorization?.nonce;if(!nonce)throw new Error('Retained return authorization has no nonce');const first=BigInt(fromBlock),latest=await rpc.getBlockNumber();const logs=await rpc.getLogs({address:a.asset as Hex,event:parseAbiItem('event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)'),args:{authorizer:a.spendingAddress as Hex,nonce},fromBlock:first,toBlock:latest<first+2000n?latest:first+2000n});return logs[0]?.transactionHash??null;},
  };
  this.facilitator=options.facilitator??new HTTPFacilitatorClient({url:options.facilitatorUrl});this.verify=options.verify??chainSettlementVerifier(options.rpcUrl,a.network);
 }
 private row():ReturnRow|undefined{return this.options.journal.db.prepare('SELECT * FROM agent_returns WHERE authority_id=?').get(this.options.authority.id) as unknown as ReturnRow|undefined;}
 status(){const row=this.row();return{state:row?.state??'none',phase:this.busy?this.phase:row&&['signed','uncertain'].includes(row.state)?'needs_reconciliation':row?.state??'idle',amountBaseUnits:row?.amount??null,transaction:row?.transaction_hash??null,error:row?.error??this.lastError,busy:this.busy};}
 private eligible(){const{journal,authority:a}=this.options;const mandate=journal.mandate(a.id);if(!mandate||mandate.deposit!=='funded'||mandate.channel_id||!['active','stopped'].includes(mandate.state))throw new Error('Only a funded, open exact-agent allowance can return unused funds');if(journal.requests(a.id).some(r=>['reserved','signed','uncertain'].includes(r.state)))throw new Error('Reconcile every pending payment before returning funds');}
 async preview(){
  this.eligible();if(this.busy)throw new Error('A return operation is already in progress');const saved=this.row();if(saved&&['signed','uncertain','confirmed'].includes(saved.state))throw new Error('Observe or reconcile the existing return; do not sign another one');
  if(await this.chain.chainId()!==8453)throw new Error('Return RPC is not Base mainnet');const balance=await this.chain.balance();units(balance.amount);
  const a=this.options.authority,approvedFundingBaseUnits=this.options.journal.effectiveAgentCeiling(a.id,a.ceilingBaseUnits);if(BigInt(balance.amount)>BigInt(approvedFundingBaseUnits))throw new Error('The spending wallet contains more than the approved Ledger funding. Resolve the additional funds explicitly rather than silently sweeping them.');
  return{network:a.network,asset:a.asset,from:a.spendingAddress,to:a.payerAddress,amountBaseUnits:balance.amount,approvedFundingBaseUnits,block:balance.block,observedAt:new Date().toISOString(),consentHash:digest({action:'return-unused-mainnet-usdc',authority:a,approvedFundingBaseUnits,amountBaseUnits:balance.amount}),
   effect:'Stop the allowance and return only the current Base mainnet USDC balance to the original Ledger payer. Previously paid service charges are not refunded.'};
 }
 async returnUnused(consentHash:string):Promise<Record<string,unknown>>{
  const review=await this.preview();if(review.consentHash!==consentHash)throw new Error('The return amount or authority changed. Review the current balance again.');
  if(this.busy)throw new Error('A return operation is already in progress');this.busy=true;this.phase='preparing';this.lastError=null;
  const{journal,authority:a}=this.options;let exported=false;
  try{
   this.eligible();journal.stop(a.id);
   const current=await this.chain.balance();if(current.amount!==review.amountBaseUnits)throw new Error('The wallet balance changed after review; no return signature was created');
   if(current.amount==='0'){
    journal.closeEmptyAgentWallet(a.id,{network:a.network,asset:a.asset,account:a.spendingAddress,balanceBaseUnits:'0',block:current.block});this.phase='confirmed';return{closed:true,returnedBaseUnits:'0',transaction:null};
   }
   journal.db.prepare("INSERT INTO agent_returns(authority_id,state,amount,from_block) VALUES(?,'prepared',?,?) ON CONFLICT(authority_id) DO UPDATE SET state='prepared',amount=excluded.amount,from_block=excluded.from_block,payload=NULL,offer=NULL,transaction_hash=NULL,error=NULL").run(a.id,current.amount,current.block);
   let signed=false;
   const signer:ClientEvmSigner={address:a.spendingAddress as Hex,signTypedData:async parameters=>{
    const domain=parameters.domain,message=parameters.message as Record<string,unknown>;
    if(signed||parameters.primaryType!=='TransferWithAuthorization'||Number(domain.chainId)!==8453||String(domain.verifyingContract).toLowerCase()!==a.asset.toLowerCase()||String(message.from).toLowerCase()!==a.spendingAddress.toLowerCase()||String(message.to).toLowerCase()!==a.payerAddress.toLowerCase()||String(message.value)!==current.amount||!Number.isSafeInteger(Number(message.validBefore))||Number(message.validBefore)*1000>Date.now()+180000||Number(message.validBefore)*1000<=Date.now())throw new Error('Return signature differs from the reviewed token, owner, amount or lifetime');
    signed=true;this.phase='signing_return';const signature=await this.options.signer.signTypedData(parameters);
    if(!await verifyTypedData({...parameters,address:a.spendingAddress as Hex,signature} as never))throw new Error('Return signature does not match the reviewed spending wallet');return signature;
   }};
   const offer:PaymentRequirements={scheme:'exact',network:a.network,asset:a.asset,amount:current.amount,payTo:a.payerAddress,maxTimeoutSeconds:120,extra:{name:'USD Coin',version:'2',assetTransferMethod:'eip3009'}};
   const client=new x402Client();client.register(a.network,new ExactEvmScheme(signer));
   const payload=await client.createPaymentPayload({x402Version:2,resource:{url:this.options.facilitatorUrl,description:'Return reviewed unused mainnet funds to their original payer'},accepts:[offer]});
   journal.db.prepare("UPDATE agent_returns SET state='signed',payload=?,offer=? WHERE authority_id=?").run(JSON.stringify(payload),JSON.stringify(offer),a.id);exported=true;
   journal.event(a.id,null,'agent.return_signed',{amountBaseUnits:current.amount,from:a.spendingAddress,to:a.payerAddress,network:a.network,authorizationDigest:digest(payload)});
   this.phase='submitting_return';const verification=await this.facilitator.verify(payload,offer);if(!verification.isValid)throw new Error('Return authorization was not verified; reconcile before attempting anything else');
   const settlement=await this.facilitator.settle(payload,offer);
   if(settlement.transaction)journal.db.prepare('UPDATE agent_returns SET transaction_hash=? WHERE authority_id=?').run(settlement.transaction,a.id);
   if(!settlement.success||settlement.network!==a.network||!settlement.transaction)throw new Error('Return settlement is not yet confirmed');
   this.phase='confirming_return';await this.confirm(payload,offer,settlement.transaction);return{closed:true,returnedBaseUnits:current.amount,transaction:settlement.transaction};
  }catch(error){const message=error instanceof Error?error.message:'Return failed';this.lastError=message;journal.db.prepare('UPDATE agent_returns SET state=?,error=? WHERE authority_id=?').run(exported?'uncertain':'failed',message,a.id);journal.event(a.id,null,'agent.return_failed',{error:message,authorizationExported:exported});this.phase='failed';throw error;}
  finally{this.busy=false;}
 }
 private async confirm(payload:PaymentPayload,offer:PaymentRequirements,transaction:string){
  const{journal,authority:a}=this.options;await this.verify({transaction,payload,offer,payer:a.spendingAddress});
  journal.closeAgentWalletReturn(a.id,{network:a.network,asset:a.asset,from:a.spendingAddress,to:a.payerAddress,returnedBaseUnits:offer.amount,transaction,chainVerified:true});
  journal.db.prepare("UPDATE agent_returns SET state='confirmed',transaction_hash=?,error=NULL WHERE authority_id=?").run(transaction,a.id);this.phase='confirmed';
 }
 async reconcile(transactionHash?:string):Promise<Record<string,unknown>>{
  if(this.busy)throw new Error('A return operation is already in progress');const row=this.row();if(row?.state==='confirmed')return{closed:true,transaction:row.transaction_hash};
  if(!row?.payload||!row.offer||!['signed','uncertain'].includes(row.state))throw new Error('No exported return authorization needs reconciliation');
  if(transactionHash&&!/^0x[0-9a-fA-F]{64}$/.test(transactionHash))throw new Error('Invalid return transaction hash');this.busy=true;this.phase='reconciling_return';
  try{
   if(await this.chain.chainId()!==8453)throw new Error('Return RPC is not Base mainnet');const payload=JSON.parse(row.payload) as PaymentPayload,offer=JSON.parse(row.offer) as PaymentRequirements;
   const transaction=transactionHash??row.transaction_hash??await this.chain.findTransaction(payload,row.from_block);
   if(!transaction)throw new Error('No confirmed matching return transfer found. No new signature or transfer was attempted.');
   await this.confirm(payload,offer,transaction);return{closed:true,transaction,returnedBaseUnits:offer.amount};
  }catch(e){this.options.journal.db.prepare("UPDATE agent_returns SET state='uncertain',error=? WHERE authority_id=?").run(e instanceof Error?e.message:'Reconciliation failed',this.options.authority.id);throw e;}finally{this.busy=false;}
 }
}
