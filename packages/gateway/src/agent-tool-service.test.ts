/** Stock HTTP protocol, with an explicit local test-double facilitator. No chain transactions. */
import {test} from 'node:test';import assert from 'node:assert/strict';import {createServer,type Server} from 'node:http';
import {privateKeyToAccount} from 'viem/accounts';import {x402Client} from '@x402/core/client';import {ExactEvmScheme} from '@x402/evm/exact/client';
import {decodePaymentRequiredHeader,encodePaymentSignatureHeader,decodePaymentResponseHeader} from '@x402/core/http';
import {Journal} from './journal.ts';import {createAgentToolService} from './agent-tool-service.ts';
const listen=(server:Server)=>new Promise<string>(resolve=>server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${(server.address() as {port:number}).port}`)));
const close=(server:Server)=>new Promise<void>(resolve=>{server.close(()=>resolve());server.closeIdleConnections();});
async function fixture(t:{after:(fn:()=>Promise<void>)=>void},failProvider=false){
 const counts={verified:0,settled:0,provided:0};
 const facilitator=createServer(async(req,res)=>{req.resume();await new Promise<void>(resolve=>req.on('end',resolve));res.setHeader('content-type','application/json');
  if(req.url==='/supported')res.end(JSON.stringify({kinds:[{x402Version:2,scheme:'exact',network:'eip155:84532'}],extensions:[],signers:{}}));
  else if(req.url==='/verify'){counts.verified++;res.end(JSON.stringify({isValid:true,payer:'0x0000000000000000000000000000000000000001'}));}
  else if(req.url==='/settle'){counts.settled++;res.end(JSON.stringify({success:true,transaction:`0x${'ab'.repeat(32)}`,network:'eip155:84532'}));}
  else{res.statusCode=404;res.end('{}');}
 });
 const facilitatorUrl=await listen(facilitator),journal=new Journal(':memory:');
 const server=await createAgentToolService({network:'eip155:84532',payTo:'0x0000000000000000000000000000000000000002',facilitatorUrl,journal,providers:[{id:'crypto-prices',description:'Controlled fixture data',amountBaseUnits:'1000',validate(input){if(Object.keys(input).some(k=>k!=='coin')||!['ETH','BTC'].includes(String(input.coin)))throw new Error('Unsupported fixture input');},async execute(input){counts.provided++;await new Promise(r=>setTimeout(r,15));if(failProvider)throw new Error('Controlled provider failure');return {coin:input.coin,fixtureOnly:true};}}]});
 const origin=await listen(server);t.after(async()=>{await close(server);await close(facilitator);journal.close();});
 const request=(body:unknown,headers:Record<string,string>={})=>fetch(`${origin}/tools/crypto-prices`,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
 const quote=await request({coin:'ETH'});assert.equal(quote.status,402);const required=decodePaymentRequiredHeader(quote.headers.get('payment-required')!);await quote.body?.cancel();
 const client=new x402Client();client.register('eip155:84532',new ExactEvmScheme(privateKeyToAccount(`0x${'44'.repeat(32)}`)));
 const payload=await client.createPaymentPayload(required),signature=encodePaymentSignatureHeader(payload);
 return {request,counts,signature,origin};
}
test('strict unpaid input validation and x402 challenges never invoke the paid data provider',async t=>{
 const f=await fixture(t);assert.deepEqual(f.counts,{verified:0,settled:0,provided:0});
 assert.equal((await f.request({coin:'ETH',url:'https://attacker.invalid'})).status,400);assert.equal(f.counts.verified,0);assert.equal(f.counts.provided,0);
 const read=await f.request({coin:'ETH'},{'payment-signature':f.signature,'x-mandate-reconcile':'1'});assert.equal(read.status,409);assert.equal(f.counts.verified,0);
});
test('a paid response, its retry and read-only recovery share one provider execution and one settlement',async t=>{
 const f=await fixture(t),headers={'payment-signature':f.signature};
 const first=await f.request({coin:'ETH'},headers);assert.equal(first.status,200);const body=await first.text();assert.equal(decodePaymentResponseHeader(first.headers.get('payment-response')!).success,true);
 const replay=await f.request({coin:'ETH'},headers);assert.equal(await replay.text(),body);
 const recover=await f.request({coin:'ETH'},{...headers,'x-mandate-reconcile':'1'});assert.equal(await recover.text(),body);
 const changed=await f.request({coin:'BTC'},headers);assert.equal(changed.status,409);
 assert.deepEqual(f.counts,{verified:1,settled:1,provided:1});
});
test('concurrent payment replays cannot double-execute or double-settle',async t=>{
 const f=await fixture(t);const responses=await Promise.all([f.request({coin:'ETH'},{'payment-signature':f.signature}),f.request({coin:'ETH'},{'payment-signature':f.signature})]);
 assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);await Promise.all(responses.map(r=>r.body?.cancel()));assert.equal(f.counts.provided,1);assert.equal(f.counts.settled,1);
});
test('a failed provider does not trigger after-handler settlement or automatic payment replay',async t=>{
 const f=await fixture(t,true);const first=await f.request({coin:'ETH'},{'payment-signature':f.signature});assert.equal(first.status,503);
 const retry=await f.request({coin:'ETH'},{'payment-signature':f.signature});assert.equal(retry.status,409);assert.equal(f.counts.provided,1);assert.equal(f.counts.settled,0);
});
