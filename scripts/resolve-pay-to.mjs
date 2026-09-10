/**
 * Distinct Hedera merchant (SERVICE_PAY_TO) for stock exact@hedera:testnet.
 * Self-transfers net to zero and fail facilitator verify.
 */
import { readFile } from "node:fs/promises";

const ROOT = new URL("..", import.meta.url).pathname;
export const SERVICE_PAY_TO_FILE = `${ROOT}/.live-results/service-pay-to.txt`;

export function pickPayTo({ envPayTo, filePayTo, payer }) {
  const env = envPayTo?.trim() ?? "";
  const file = filePayTo?.trim() ?? "";
  if (env && payer && env !== payer) return env;
  if (file && payer && file !== payer) return file;
  if (env && !payer) return env;
  return null;
}

export async function findServicePayTo(payer) {
  let filePayTo = "";
  try {
    filePayTo = (await readFile(SERVICE_PAY_TO_FILE, "utf8")).trim().split(/\s+/)[0] ?? "";
  } catch {
    filePayTo = "";
  }
  const chosen = pickPayTo({
    envPayTo: process.env.SERVICE_PAY_TO,
    filePayTo,
    payer,
  });
  if (chosen) process.env.SERVICE_PAY_TO = chosen;
  return chosen;
}

export async function resolveServicePayTo(payer) {
  const payTo = await findServicePayTo(payer);
  if (!payTo) {
    console.error(
      `SERVICE_PAY_TO must differ from the payer (${payer}). Run: npm run setup:merchant`
    );
    process.exit(1);
  }
  return payTo;
}
