#!/usr/bin/env node
/** The one application entry point. Startup never signs, unlocks or sends payments. */
import { createOperatorApp } from '../packages/gateway/src/operator.ts';
import { maybeStartFacilitator } from './start-facilitator.mjs';
import { resolve } from 'node:path';
const root = resolve(new URL('..', import.meta.url).pathname);
if (process.env.MANDATE_CONSOLE_PORT && process.env.MANDATE_CONSOLE_PORT !== '8410') throw new Error('Mandate has one canonical port: 8410');
const facilitator = await maybeStartFacilitator({ rpcUrl: process.env.MANDATE_EVM_RPC_URL });
if (facilitator.child) console.error(facilitator.reason);
else if (process.env.MANDATE_FACILITATOR_REQUIRED === '1') {
  console.error(facilitator.reason);
  process.exit(1);
}
const app = await createOperatorApp({ root, dataDir: resolve(root, 'state/mainnet/operator'), port: 8410 });
app.server.on('error', async error => {
  console.error(error.code === 'EADDRINUSE' ? 'Mandate is already using port 8410. Open the existing app; no fallback port was started.' : error.message);
  facilitator.child?.kill('SIGTERM');
  await app.close();
  process.exitCode = 1;
});
app.server.listen(8410, '127.0.0.1', () => console.log('Mandate mainnet workspace: http://127.0.0.1:8410. No payment occurs at startup.'));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    facilitator.child?.kill('SIGTERM');
    void app.close().then(() => process.exit(0));
  });
}
