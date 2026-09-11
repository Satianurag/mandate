/** Claims and sweeps are distinct durable operations, including after a restart between them. */
export interface LifecycleResult { claims: Array<{vouchers:number;transaction:string}>; settle?: {transaction:string}; alreadySettled: boolean }
export async function completeMerchantLifecycle(opts: {
  claim: () => Promise<LifecycleResult['claims']>;
  settle: () => Promise<{transaction:string}>;
  receiverState: () => Promise<{claimed:bigint;settled:bigint}>;
  record: (kind:string,data:unknown) => void;
  retryDelayMs?: number;
}): Promise<LifecycleResult> {
  const claims = await opts.claim();
  for (const claim of claims) opts.record('merchant.claim_confirmed',claim);
  for (let attempt=0;attempt<4;attempt++) {
    const state=await opts.receiverState();
    if(state.claimed<state.settled)throw new Error('Invalid receiver accounting');
    if(state.claimed===state.settled) {
      if(claims.length && attempt<3) {await new Promise(resolve=>setTimeout(resolve,opts.retryDelayMs??1500));continue;}
      opts.record('merchant.no_unsettled_revenue',{claimed:String(state.claimed),settled:String(state.settled)});
      return {claims,alreadySettled:true};
    }
    try {
      const settle=await opts.settle();
      opts.record('merchant.revenue_settled',settle);
      return {claims,settle,alreadySettled:false};
    } catch(error) {
      // This specific stock error is emitted before any sweep transaction is constructed.
      // An RPC can momentarily lag a newly confirmed claim. Never retry an ambiguous send failure.
      if(!String(error).includes('invalid_batch_settlement_evm_nothing_to_settle') || attempt===3)throw error;
      opts.record('merchant.rpc_visibility_retry',{attempt:attempt+1});
      await new Promise(resolve=>setTimeout(resolve,opts.retryDelayMs??1500));
    }
  }
  throw new Error('Merchant accounting did not converge');
}
