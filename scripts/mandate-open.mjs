#!/usr/bin/env node
// Use the same authenticated execution path as the UI; explicit --authorize-funding is required for a new channel.
process.argv.splice(2,0,'query');
await import('./operator-task.mjs');
