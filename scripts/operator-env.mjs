/** Read public operator IDs only. Never source executable shell or load plaintext secrets. */
import { readFile } from 'node:fs/promises';
export async function loadOperatorEnvironment(root = new URL('..', import.meta.url).pathname) {
  const allowed = new Set(['MANDATE_HEDERA_ACCOUNT_ID','MANDATE_HCS_TOPIC_ID','SERVICE_PAY_TO','MANDATE_EVM_RPC_URL','MANDATE_TREASURY_ID','MANDATE_HEDERA_NETWORK']);
  const text = await readFile(`${root}/.live-results/operator-ids.env`, 'utf8').catch(() => '');
  for (const line of text.split('\n')) {
    const match = /^(?:export\s+)?([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!match || !allowed.has(match[1]) || process.env[match[1]]) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1,-1);
    if (/[`$\r\n]/.test(value)) throw new Error(`Public setting ${match[1]} must be a literal value`);
    process.env[match[1]] = value;
  }
  if (process.env.MANDATE_HEDERA_NETWORK && process.env.MANDATE_HEDERA_NETWORK !== 'hedera:testnet') throw new Error('Testnet-only: invalid Hedera network configuration');
  process.env.MANDATE_HEDERA_NETWORK = 'hedera:testnet';
}
