import { test } from "node:test";
import assert from "node:assert/strict";
import { PrivateKey, TransferTransaction, TransactionId, AccountId } from "@x402/hedera";
import { validateHederaScope, assertHederaOffer, assertHederaPayload, AGENT_HEDERA_USDC } from "./agent-hedera.ts";
import type { PaymentRequirements } from "@x402/core/types";

const scope = { accountId: "0.0.5001", payTo: "0.0.5002", feePayer: "0.0.5003", endpoint: "http://127.0.0.1:8423/tools/hedera-analysis" };
const offer: PaymentRequirements = {
  scheme: "exact",
  network: "hedera:mainnet",
  asset: AGENT_HEDERA_USDC,
  amount: "2000",
  payTo: scope.payTo,
  maxTimeoutSeconds: 120,
  extra: { feePayer: scope.feePayer },
};

async function signed(amount = 2000, recipient = scope.payTo) {
  const tx = new TransferTransaction()
    .setTransactionId(TransactionId.generate(scope.feePayer))
    .setNodeAccountIds([AccountId.fromString("0.0.3")])
    .setTransactionValidDuration(120)
    .addTokenTransfer(AGENT_HEDERA_USDC, scope.accountId, -amount)
    .addTokenTransfer(AGENT_HEDERA_USDC, recipient, amount)
    .freeze();
  await tx.sign(PrivateKey.generateECDSA());
  return Buffer.from(tx.toBytes()).toString("base64");
}

test("Hedera authority and offers reject testnet and self-payments", () => {
  assert.deepEqual(validateHederaScope(scope), scope);
  assert.throws(() => validateHederaScope({ ...scope, payTo: scope.accountId }), /differ/);
  assert.throws(() => assertHederaOffer(scope, { ...offer, network: "hedera:testnet" }), /changed/);
});

test("actual SDK Hedera bytes bind to reviewed token transfers", async () => {
  const bytes = await signed();
  assert.match(assertHederaPayload(scope, offer, bytes), /^0\.0\.5003-\d+-\d+$/);
  assert.throws(() => assertHederaPayload(scope, { ...offer, amount: "1999" }, bytes), /amount/);
});
