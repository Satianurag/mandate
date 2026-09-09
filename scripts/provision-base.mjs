#!/usr/bin/env node
/**
 * Generate a Base Sepolia payer/receiver pair for the batch-settlement spike.
 * Does not fund — use the printed faucet links, then export the env vars.
 *
 * Usage: npm run setup:base
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const payerKey = generatePrivateKey();
const payer = privateKeyToAccount(payerKey);
const receiverKey = generatePrivateKey();
const receiver = privateKeyToAccount(receiverKey);

console.log("Base Sepolia wallets for npm run spike:envelope\n");
console.log(`export MANDATE_EVM_SIGNING_KEY=${payerKey}`);
console.log(`export MANDATE_EVM_RECEIVER=${receiver.address}`);
console.log(`\nPayer (needs ETH + USDC):  ${payer.address}`);
console.log(`Receiver (payTo / channel): ${receiver.address}`);
console.log("\nFund the payer:");
console.log("  ETH:  https://www.alchemy.com/faucets/base-sepolia");
console.log("  USDC: https://faucet.circle.com/");
console.log("\nThen: npm run check:spike && npm run spike:envelope");
