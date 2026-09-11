#!/usr/bin/env node
// Opens the local trusted operator session. Never prints the bearer token.
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const root = new URL('..', import.meta.url).pathname;
const directory = process.env.MANDATE_OPERATOR_STATE ?? resolve(root, 'state/live/operator');
const token = (await readFile(resolve(directory, 'operator-token'), 'utf8')).trim();
if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Malformed local operator token');
const port = Number(process.env.MANDATE_CONSOLE_PORT ?? 8410);
const origin = `http://127.0.0.1:${port}`;
const response = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(3000) });
if (!response.ok || (await response.json()).service !== 'mandate-operator') throw new Error('Start npm run console first');
const command = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : null;
if (!command) throw new Error('Use the manual token input on the local workspace on this platform');
const child = spawn(command, [`${origin}/#token=${token}`], { stdio: 'ignore' });
child.on('error', e => { console.error(`Browser launch failed: ${e.message}`); process.exitCode = 1; });
child.on('exit', code => { if (code) process.exitCode = 1; });
console.log(`Opening ${origin} with a local operator session. No key material is exposed.`);
