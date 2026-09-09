#!/usr/bin/env node
/**
 * Print the Key Ring key list as JSON (exit 0), or the exact unseal error
 * (exit 1). Single shell entry point to the strict keyring adapter — no
 * output-format guessing in bash.
 */
import { ensureWalletPass } from "./load-wallet-pass.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const { listKeys } = await import(`${ROOT}/packages/gateway/src/keyring.ts`);

await ensureWalletPass();
try {
  console.log(JSON.stringify(await listKeys()));
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
