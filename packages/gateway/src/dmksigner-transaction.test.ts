import { test } from "node:test";
import assert from "node:assert/strict";
import { of } from "rxjs";
import { privateKeyToAccount } from "viem/accounts";
import { getAddress, hexToBytes, parseTransaction, type Hex } from "viem";
import { BATCH_SETTLEMENT_ADDRESS, type ChannelConfig } from "@x402/evm";
import { computeChannelId } from "@x402/evm/batch-settlement/client";
import { DeviceActionStatus } from "./ledger-cjs.ts";
import { digest } from "./journal.ts";
import { signWithdrawalWithEthSigner } from "./dmksigner.ts";
import {
  serializeUnsignedWithdrawal,
  withdrawalStateFingerprint,
  type PreparedWithdrawalTransaction,
} from "./withdrawal.ts";
import type { ChannelSnapshot } from "./reconciliation.ts";

function fixture() {
  const account = privateKeyToAccount(`0x${"99".repeat(32)}`);
  const config: ChannelConfig = {
    payer: account.address,
    payerAuthorizer: "0x0000000000000000000000000000000000000002",
    receiver: "0x0000000000000000000000000000000000000003",
    receiverAuthorizer: "0x0000000000000000000000000000000000000004",
    token: "0x0000000000000000000000000000000000000005",
    withdrawDelay: 900,
    salt: `0x${"11".repeat(32)}`,
  };
  const channelId = computeChannelId(config, 8453);
  const snapshot: ChannelSnapshot = {
    network: "eip155:8453", blockNumber: "1", observedAt: "2026-09-11T00:00:00.000Z", channelId,
    balanceBaseUnits: "100000", claimedBaseUnits: "30000", payerBalanceBaseUnits: "0", receiverBalanceBaseUnits: "0",
    receiverAggregateClaimedBaseUnits: "30000", receiverAggregateSettledBaseUnits: "30000",
    withdrawalAmountBaseUnits: "0", withdrawalInitiatedAt: 0, refundNonce: "0",
  };
  const encoded = serializeUnsignedWithdrawal({
    kind: "initiate", config, channelId, amountBaseUnits: "70000", nonce: 2,
    gas: 100000n, maxFeePerGas: 1000n, maxPriorityFeePerGas: 100n,
  });
  const base: Omit<PreparedWithdrawalTransaction, "planHash"> = {
    version: 1, kind: "initiate", network: "eip155:8453", chainId: 8453, channelId,
    contract: getAddress(BATCH_SETTLEMENT_ADDRESS), payer: account.address, token: config.token, receiver: config.receiver,
    withdrawDelay: config.withdrawDelay, amountBaseUnits: "70000", callData: encoded.callData, selector: encoded.selector,
    nonce: 2, gas: "100000", maxFeePerGas: "1000", maxPriorityFeePerGas: "100", maxGasCostWei: "100000000",
    payerNativeBalanceWei: "100000001", unsignedSerialized: encoded.unsignedSerialized, unsignedHash: encoded.unsignedHash,
    preparedAt: "2026-09-11T00:00:00.000Z", sourceBlock: "1", stateFingerprint: withdrawalStateFingerprint(snapshot, "30000"),
  };
  return { account, plan: { ...base, planHash: digest(base) } as PreparedWithdrawalTransaction };
}

test("DMK withdrawal signer passes exact unsigned bytes, reports device trace, verifies payer, and never broadcasts", async () => {
  const { account, plan } = fixture();
  const signed = await account.signTransaction(parseTransaction(plan.unsignedSerialized));
  const parsed = parseTransaction(signed);
  let calls = 0;
  let received: Uint8Array | null = null;
  const signer = {
    signTransaction(path: string, transaction: Uint8Array, options?: { skipOpenApp?: boolean }) {
      calls += 1;
      assert.equal(path, "44'/60'/0'/0/7");
      assert.equal(options?.skipOpenApp, true);
      received = transaction;
      return {
        observable: of(
          { status: DeviceActionStatus.Pending, intermediateValue: { requiredUserInteraction: "sign-transaction", step: "signer.eth.steps.signTransaction" } },
          { status: DeviceActionStatus.Completed, output: { r: parsed.r as Hex, s: parsed.s as Hex, v: parsed.yParity! } },
        ),
        cancel: () => {},
      };
    },
  };
  const result = await signWithdrawalWithEthSigner(signer as never, plan, account.address, {
    path: "44'/60'/0'/0/7", timeoutMs: 1000, skipOpenApp: true,
  });
  assert.equal(calls, 1);
  assert.deepEqual(received, hexToBytes(plan.unsignedSerialized));
  assert.equal(result.signedSerialized, signed);
  assert.equal(result.signer, account.address);
  assert.ok(result.trace.some(item => item.interaction === "sign-transaction"));
  assert.equal("broadcast" in result, false);
});

test("DMK withdrawal signer rejects a reviewed payer mismatch before opening a device action", async () => {
  const { plan } = fixture();
  let calls = 0;
  const signer = { signTransaction() { calls += 1; throw new Error("must not be called"); } };
  await assert.rejects(() => signWithdrawalWithEthSigner(signer as never, plan, "0x0000000000000000000000000000000000000009"), /payer differs/);
  assert.equal(calls, 0);
});
