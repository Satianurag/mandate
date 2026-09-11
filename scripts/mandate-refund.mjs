#!/usr/bin/env node
// Recovered funds are confirmed on-chain by the same broker path as the UI. No second stack or payer key.
process.argv.splice(2,0,'refund');
await import('./operator-task.mjs');
