/** Explicit Ledger funding. This is NOT a claim that broker policy executes on the device. */
import {randomUUID} from 'node:crypto';
import {createPublicClient,http,erc20Abi,getAddress,verifyTypedData,parseAbiItem,type Hex} from 'viem';
import {x402Client} from '@x402/core/client';
import {HTTPFacilitatorClient} from '@x402/core/http';
import type {PaymentPayload,PaymentRequirements,SettleResponse} from '@x402/core/types';
import type {ClientEvmSigner} from '@x402/evm';
import {ExactEvmScheme} from '@x402/evm/exact/client';
import {Journal,digest,units,type AgentAllowanceIncreaseRow} from './journal.ts';
import {chainSettlementVerifier,type ExactAgentAuthority,type VerifyExactSettlement} from './agent-exact.ts';

const MAX_EFFECTIVE_ALLOWANCE_BASE_UNITS=5000000n;
export interface AgentFundingSigner extends ClientEvmSigner {lastClearSigning?:unknown}
export interface AgentFundingOptions {
  authority:ExactAgentAuthority;journal:Journal;rpcUrl:string;facilitatorUrl:string;
  signer:()=>Promise<AgentFundingSigner>;
  /** Hermetic injection only. Production uses read-only RPC and stock facilitator calls. */
  chain?:{chainId:()=>Promise<number>;balance:()=>Promise<bigint>;block:()=>Promise<bigint>;findTransaction:(payload:PaymentPayload,fromBlock:string)=>Promise<string|null>};
  facilitator?:Pick<HTTPFacilitatorClient,'getSupported'|'verify'|'settle'>;
  verify?:VerifyExactSettlement;
}
export class AgentFundingController {
  private readonly options:AgentFundingOptions;
  private readonly chain:NonNullable<AgentFundingOptions['chain']>;
  private readonly facilitator:NonNullable<AgentFundingOptions['facilitator']>;
  private readonly verify:VerifyExactSettlement;
  private phase='idle';private error:string|null=null;private running=false;
  private increasePhase='idle';private increaseError:string|null=null;private increaseRunning=false;
  constructor(options:AgentFundingOptions){
    this.options=options;
    if(options.authority.payerAddress.toLowerCase()===options.authority.spendingAddress.toLowerCase())throw new Error('Funding needs a distinct, dedicated software spending wallet');
    if(options.authority.network!=='eip155:84532')throw new Error('Agent funding is restricted to Base Sepolia testnet');
    const url=new URL(options.facilitatorUrl);
    if(!(url.protocol==='https:'||url.protocol==='http:'&&url.hostname==='127.0.0.1')||url.username||url.password||url.search||url.hash)throw new Error('Invalid reviewed funding facilitator');
    const rpc=createPublicClient({transport:http(options.rpcUrl,{timeout:15000,retryCount:0})}), a=options.authority;
    this.chain=options.chain??{
      chainId:()=>rpc.getChainId(),
      balance:()=>rpc.readContract({address:a.asset as Hex,abi:erc20Abi,functionName:'balanceOf',args:[a.payerAddress as Hex]}),
      block:()=>rpc.getBlockNumber(),
      findTransaction:async(payload,fromBlock)=>{
        const authorization=(payload.payload as {authorization?:{nonce?:Hex}}).authorization;
        if(!authorization?.nonce)throw new Error('Retained funding authorization has no nonce');
        const latest=await rpc.getBlockNumber(),first=BigInt(fromBlock);
        const end=latest<first+2000n?latest:first+2000n;
        const logs=await rpc.getLogs({address:a.asset as Hex,event:parseAbiItem('event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)'),args:{authorizer:a.payerAddress as Hex,nonce:authorization.nonce},fromBlock:first,toBlock:end});
        return logs[0]?.transactionHash??null;
      },
    };
    this.facilitator=options.facilitator??new HTTPFacilitatorClient({url:options.facilitatorUrl});
    this.verify=options.verify??chainSettlementVerifier(options.rpcUrl,a.network);
  }
  private event(kind:string,data:unknown){this.options.journal.event(this.options.authority.id,null,kind,data);}
  private saved(kind:string):Record<string,unknown>|null{
    const row=this.options.journal.db.prepare('SELECT data FROM events WHERE mandate_id=? AND kind=? ORDER BY seq DESC LIMIT 1').get(this.options.authority.id,kind) as {data:string}|undefined;
    return row?JSON.parse(row.data):null;
  }
  private increaseRows(){return this.options.journal.agentAllowanceIncreases(this.options.authority.id);}
  private latestIncrease(){return this.increaseRows().at(-1)??null;}
  private unresolvedIncrease(){return [...this.increaseRows()].reverse().find(row=>['signed','uncertain'].includes(row.state))??null;}
  private effectiveCeiling(){return this.options.journal.effectiveAgentCeiling(this.options.authority.id,this.options.authority.ceilingBaseUnits);}
  review(){
    const {authority:a,journal}=this.options,row=journal.mandate(a.id),totals=journal.totals(a.id,a.windowMs);
    const effectiveCeilingBaseUnits=this.effectiveCeiling();
    const remaining=BigInt(effectiveCeilingBaseUnits)-BigInt(totals.spent)-BigInt(totals.reserved);
    const proof=this.saved('agent.funding_confirmed'), increases=this.increaseRows(), latest=this.latestIncrease(), unresolved=this.unresolvedIncrease(), currentIncrease=unresolved??latest;
    return {authority:structuredClone(a),effectiveCeilingBaseUnits,confirmedIncreaseBaseUnits:journal.confirmedAgentAllowanceIncrease(a.id),consentHash:digest({action:'fund-testnet-agent-allowance',authority:a}),funding:{status:row?.deposit??'none',phase:this.running?this.phase:row?.deposit==='pending'?'needs_reconciliation':this.phase,error:this.error,transaction:proof?.transaction??null},
      increase:{status:this.increaseRunning?'running':currentIncrease?.state??'none',phase:this.increaseRunning?this.increasePhase:unresolved?'needs_reconciliation':currentIncrease?.state==='confirmed'?'confirmed':this.increasePhase,error:this.increaseError??unresolved?.error??null,amountBaseUnits:currentIncrease?.amount??null,resultingCeilingBaseUnits:currentIncrease?.resulting_ceiling??null,transaction:currentIncrease?.transaction_hash??null},
      increases:increases.filter(item=>item.state==='confirmed').map(item=>({id:item.id,amountBaseUnits:item.amount,resultingCeilingBaseUnits:item.resulting_ceiling,transaction:item.transaction_hash,confirmed:true,createdAt:item.created_at})),
      totals:{...totals,remaining:remaining>0n?String(remaining):'0'},state:row?.state??'not_configured',
      pendingPayments:journal.requests(a.id).filter(r=>['reserved','signed','uncertain'].includes(r.state)).map(r=>({id:r.id,network:r.network,amountBaseUnits:r.maximum,state:r.state,error:r.error})),
      custody:'Ledger approves Base Sepolia USDC transfers to a dedicated software spending wallet. Every allowance increase requires another explicit Ledger signature. The trusted broker keeps services, recipients, per-call limits, rolling limits and expiry unchanged. Hedera uses the explicitly reviewed existing Key Ring-protected testnet account, not a bridge or a hardware-held Hedera key.',
      inferenceBilling:'Vertex inference is billed separately from x402 service spending; token usage is recorded per run.'};
  }
  private async supported(){
    if(await this.chain.chainId()!==84532)throw new Error('Funding RPC is not Base Sepolia');
    const supported=await this.facilitator.getSupported();
    if(!supported.kinds.some(k=>k.x402Version===2&&k.scheme==='exact'&&k.network===this.options.authority.network))throw new Error('Funding facilitator does not advertise exact Base Sepolia');
  }
  private async createPayload(amountBaseUnits:string, description:string, onPhase:(phase:string)=>void){
    const {authority:a,journal}=this.options;
    if(await this.chain.balance()<BigInt(amountBaseUnits))throw new Error('Ledger payer has insufficient Base Sepolia test USDC');
    await this.supported();
    onPhase('connecting_device');const ledger=await this.options.signer();
    if(getAddress(ledger.address)!==getAddress(a.payerAddress))throw new Error('Connected Ledger does not match the reviewed payer');
    let signCalls=0;
    const signer:ClientEvmSigner={address:ledger.address,signTypedData:async parameters=>{
      journal.assertActive(a.id);if(++signCalls!==1)throw new Error('A funding attempt may produce only one signature');
      const domain=parameters.domain,message=parameters.message as Record<string,unknown>;
      if(parameters.primaryType!=='TransferWithAuthorization'||Number(domain.chainId)!==84532||String(domain.verifyingContract).toLowerCase()!==a.asset.toLowerCase()||String(message.from).toLowerCase()!==a.payerAddress.toLowerCase()||String(message.to).toLowerCase()!==a.spendingAddress.toLowerCase()||BigInt(String(message.value))!==BigInt(amountBaseUnits)||!Number.isSafeInteger(Number(message.validBefore))||Number(message.validBefore)*1000<=Date.now()||Number(message.validBefore)*1000>Math.min(Date.now()+360000,a.expiresAt))throw new Error('Funding signature does not match the reviewed token, amount, recipient or lifetime');
      onPhase('awaiting_device');const signature=await ledger.signTypedData(parameters);
      if(!await verifyTypedData({...parameters,address:a.payerAddress as Hex,signature} as never))throw new Error('Ledger funding signature does not recover the reviewed payer');
      return signature;
    }};
    const offer:PaymentRequirements={scheme:'exact',network:a.network,asset:a.asset,amount:amountBaseUnits,payTo:a.spendingAddress,maxTimeoutSeconds:300,extra:{name:'USDC',version:'2',assetTransferMethod:'eip3009'}};
    const fromBlock=String(await this.chain.block());
    const client=new x402Client();client.register(a.network,new ExactEvmScheme(signer));
    const payload=await client.createPaymentPayload({x402Version:2,resource:{url:this.options.facilitatorUrl,description},accepts:[offer]});
    return {payload,offer,fromBlock,ledgerReport:ledger.lastClearSigning??null};
  }
  async fund(consentHash:string):Promise<Record<string,unknown>>{
    const {authority:a,journal}=this.options;
    if(consentHash!==this.review().consentHash)throw new Error('Funding review changed; review the exact authority again');
    if(this.running||this.increaseRunning)throw new Error('Funding or reconciliation is already in progress');
    if(Date.now()+360000>=a.expiresAt)throw new Error('Allowance expiry is too close for a new funding authorization');
    journal.assertActive(a.id);journal.depositOnce(a.id);this.running=true;this.error=null;this.phase='checking';
    let exported=false;
    try{
      const created=await this.createPayload(a.ceilingBaseUnits,'Fund the reviewed Mandate testnet spending wallet',phase=>this.phase=phase);
      this.event('deposit.signature_verified',{...created,authorityHash:digest(a)});exported=true;
      journal.assertActive(a.id);const verification=await this.facilitator.verify(created.payload,created.offer);
      if(!verification.isValid)throw new Error(`Funding facilitator rejected the authorization: ${verification.invalidReason??'unknown reason'}`);
      journal.assertActive(a.id);this.phase='submitting';this.event('agent.funding_submission_started',{authorityHash:digest(a)});
      const settlement=await this.facilitator.settle(created.payload,created.offer);this.event('agent.funding_settlement_response',settlement);
      if(!settlement.success||!settlement.transaction||settlement.network!==a.network)throw new Error('Funding settlement is not confirmed; reconcile without creating another signature');
      this.phase='confirming';await this.confirmInitial(created.payload,created.offer,settlement);this.phase='confirmed';
      return {transaction:settlement.transaction,network:a.network,amountBaseUnits:a.ceilingBaseUnits};
    }catch(error){
      this.error=error instanceof Error?error.message:'Funding failed';this.phase=exported?'needs_reconciliation':'failed';this.event('agent.funding_error',{error:this.error,signatureExported:exported});
      if(!exported)journal.resetUnsignedDeposit(a.id);throw error;
    }finally{this.running=false;}
  }
  private async confirmInitial(payload:PaymentPayload,offer:PaymentRequirements,settlement:Pick<SettleResponse,'transaction'|'network'>){
    const {authority:a,journal}=this.options;await this.verify({transaction:settlement.transaction!,payload,offer,payer:a.payerAddress});
    const proof={transaction:settlement.transaction,network:a.network,amountBaseUnits:a.ceilingBaseUnits,from:a.payerAddress,to:a.spendingAddress,authorityHash:digest(a),chainVerified:true};
    journal.funded(a.id,proof);this.event('agent.funding_confirmed',proof);
  }
  async reconcile(transactionHash?:string):Promise<Record<string,unknown>>{
    if(this.running||this.increaseRunning)throw new Error('Funding or reconciliation is already in progress');
    const {authority:a,journal}=this.options;
    if(journal.mandate(a.id)?.deposit==='funded')return {status:'funded',transaction:this.saved('agent.funding_confirmed')?.transaction??null};
    const saved=this.saved('deposit.signature_verified') as {payload:PaymentPayload;offer:PaymentRequirements;fromBlock:string}|null;
    if(!saved)throw new Error('No exported funding authorization exists to reconcile');
    if(transactionHash&&!/^0x[0-9a-fA-F]{64}$/.test(transactionHash))throw new Error('Invalid funding transaction hash');
    this.running=true;this.phase='reconciling';this.error=null;
    try{
      if(await this.chain.chainId()!==84532)throw new Error('Funding RPC is not Base Sepolia');
      const retained=this.saved('agent.funding_settlement_response');
      const transaction=transactionHash??(typeof retained?.transaction==='string'?retained.transaction:null)??await this.chain.findTransaction(saved.payload,saved.fromBlock);
      if(!transaction)throw new Error('No confirmed matching funding transfer found. The authorization remains pending; no new signature or payment was attempted.');
      await this.confirmInitial(saved.payload,saved.offer,{transaction,network:a.network});this.phase='confirmed';return {status:'funded',transaction};
    }catch(error){this.error=error instanceof Error?error.message:'Reconciliation failed';this.phase='needs_reconciliation';throw error;}finally{this.running=false;}
  }
  reviewIncrease(amountBaseUnits:string){
    const {authority:a,journal}=this.options;const amount=units(amountBaseUnits,true),row=journal.mandate(a.id);
    if(row?.deposit!=='funded'||row.state!=='active')throw new Error('Increase allowance is available only for an active, Ledger-funded allowance');
    if(this.running||this.increaseRunning)throw new Error('Another allowance operation is already in progress');
    if(this.unresolvedIncrease())throw new Error('Reconcile the existing allowance increase before reviewing another one');
    if(journal.requests(a.id).some(r=>['reserved','signed','uncertain'].includes(r.state)))throw new Error('Reconcile pending service payments before increasing the allowance');
    if(Date.now()+360000>=a.expiresAt)throw new Error('Allowance expiry is too close to increase it');
    const current=BigInt(this.effectiveCeiling()),resulting=current+amount;
    if(resulting>MAX_EFFECTIVE_ALLOWANCE_BASE_UNITS)throw new Error('The total allowance cannot exceed 5 test USDC');
    const review={network:a.network,asset:a.asset,from:a.payerAddress,to:a.spendingAddress,amountBaseUnits:String(amount),currentCeilingBaseUnits:String(current),resultingCeilingBaseUnits:String(resulting),unchanged:{perCallBaseUnits:a.perCallBaseUnits,windowBaseUnits:a.windowBaseUnits,windowMs:a.windowMs,expiresAt:a.expiresAt,toolsHash:digest({tools:a.tools,hedera:a.hedera??null})}};
    return {...review,consentHash:digest({action:'increase-testnet-agent-allowance',authorityHash:digest(a),...review})};
  }
  async increase(amountBaseUnits:string,consentHash:string):Promise<Record<string,unknown>>{
    const review=this.reviewIncrease(amountBaseUnits);if(review.consentHash!==consentHash)throw new Error('Allowance increase review changed; review it again');
    const {authority:a,journal}=this.options;this.increaseRunning=true;this.increaseError=null;this.increasePhase='checking';let exported=false,increaseId:string|null=null;
    try{
      const created=await this.createPayload(review.amountBaseUnits,'Increase the reviewed Mandate testnet allowance',phase=>this.increasePhase=phase);
      increaseId=randomUUID();
      journal.db.prepare("INSERT INTO agent_allowance_increases(id,mandate_id,state,amount,resulting_ceiling,consent_hash,from_block,payload,offer,created_at) VALUES(?,?,'signed',?,?,?,?,?,?,?)")
        .run(increaseId,a.id,review.amountBaseUnits,review.resultingCeilingBaseUnits,review.consentHash,created.fromBlock,JSON.stringify(created.payload),JSON.stringify(created.offer),Date.now());
      this.event('agent.allowance_increase_signature_verified',{increaseId,amountBaseUnits:review.amountBaseUnits,resultingCeilingBaseUnits:review.resultingCeilingBaseUnits,authorityHash:digest(a),ledgerReport:created.ledgerReport});exported=true;
      journal.assertActive(a.id);const verification=await this.facilitator.verify(created.payload,created.offer);
      if(!verification.isValid)throw new Error(`Funding facilitator rejected the increase authorization: ${verification.invalidReason??'unknown reason'}`);
      journal.assertActive(a.id);this.increasePhase='submitting';this.event('agent.allowance_increase_submission_started',{increaseId});
      const settlement=await this.facilitator.settle(created.payload,created.offer);
      if(settlement.transaction)journal.db.prepare('UPDATE agent_allowance_increases SET transaction_hash=? WHERE id=?').run(settlement.transaction,increaseId);
      this.event('agent.allowance_increase_settlement_response',{increaseId,...settlement});
      if(!settlement.success||!settlement.transaction||settlement.network!==a.network)throw new Error('Allowance increase settlement is not confirmed; reconcile without another Ledger signature');
      this.increasePhase='confirming';await this.confirmIncrease(increaseId,created.payload,created.offer,settlement.transaction);this.increasePhase='confirmed';
      return {increaseId,transaction:settlement.transaction,network:a.network,amountBaseUnits:review.amountBaseUnits,resultingCeilingBaseUnits:review.resultingCeilingBaseUnits};
    }catch(error){
      this.increaseError=error instanceof Error?error.message:'Allowance increase failed';this.increasePhase=exported?'needs_reconciliation':'failed';
      if(increaseId)journal.db.prepare("UPDATE agent_allowance_increases SET state=?,error=? WHERE id=?").run(exported?'uncertain':'failed',this.increaseError,increaseId);
      this.event('agent.allowance_increase_error',{increaseId,error:this.increaseError,signatureExported:exported});throw error;
    }finally{this.increaseRunning=false;}
  }
  private async confirmIncrease(id:string,payload:PaymentPayload,offer:PaymentRequirements,transaction:string){
    const {authority:a,journal}=this.options;const row=journal.db.prepare('SELECT * FROM agent_allowance_increases WHERE id=? AND mandate_id=?').get(id,a.id) as unknown as AgentAllowanceIncreaseRow|undefined;
    if(!row)throw new Error('Unknown allowance increase');if(row.state==='confirmed'){if(row.transaction_hash!==transaction)throw new Error('Conflicting allowance increase receipt');return;}
    if(!['signed','uncertain'].includes(row.state)||offer.amount!==row.amount||offer.payTo.toLowerCase()!==a.spendingAddress.toLowerCase())throw new Error('Allowance increase receipt does not match the retained review');
    await this.verify({transaction,payload,offer,payer:a.payerAddress});
    journal.db.prepare("UPDATE agent_allowance_increases SET state='confirmed',transaction_hash=?,error=NULL WHERE id=?").run(transaction,id);
    this.event('agent.allowance_increase_confirmed',{increaseId:id,transaction,network:a.network,amountBaseUnits:row.amount,resultingCeilingBaseUnits:row.resulting_ceiling,from:a.payerAddress,to:a.spendingAddress,chainVerified:true});
  }
  async reconcileIncrease(transactionHash?:string):Promise<Record<string,unknown>>{
    if(this.running||this.increaseRunning)throw new Error('Another allowance operation is already in progress');
    if(transactionHash&&!/^0x[0-9a-fA-F]{64}$/.test(transactionHash))throw new Error('Invalid allowance increase transaction hash');
    const row=this.unresolvedIncrease();if(!row?.payload||!row.offer||!row.from_block)throw new Error('No exported allowance increase needs reconciliation');
    this.increaseRunning=true;this.increasePhase='reconciling';this.increaseError=null;
    try{
      if(await this.chain.chainId()!==84532)throw new Error('Funding RPC is not Base Sepolia');
      const payload=JSON.parse(row.payload) as PaymentPayload,offer=JSON.parse(row.offer) as PaymentRequirements;
      const transaction=transactionHash??row.transaction_hash??await this.chain.findTransaction(payload,row.from_block);
      if(!transaction)throw new Error('No confirmed matching allowance increase was found. No new Ledger signature or payment was attempted.');
      await this.confirmIncrease(row.id,payload,offer,transaction);this.increasePhase='confirmed';return {status:'confirmed',increaseId:row.id,transaction,resultingCeilingBaseUnits:row.resulting_ceiling};
    }catch(error){this.increaseError=error instanceof Error?error.message:'Allowance increase reconciliation failed';this.increasePhase='needs_reconciliation';this.options.journal.db.prepare("UPDATE agent_allowance_increases SET state='uncertain',error=? WHERE id=?").run(this.increaseError,row.id);throw error;}finally{this.increaseRunning=false;}
  }
}
