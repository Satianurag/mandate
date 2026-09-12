#!/usr/bin/env node
/**
 * Loopback ERC-7730 CAL bridge for the ledger-dev Ethereum app (CAL_TEST_KEY=1).
 * Signs processor output with Ledger's app-ethereum cal.pem. Never copies that
 * private fixture into this repo. Loopback only. Base mainnet descriptors only.
 */
import http from 'node:http';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const HOST = '127.0.0.1';
const PORT = Number(process.env.MANDATE_LEDGER_TEST_CAL_PORT || 8427);
const PROCESSOR = 'https://app.devicesdk.ledger-test.com';
const PROD_CAL = 'https://global.api.prd.ledger.com/cal/v1';
const ROOT = resolve(import.meta.dirname, '..');
const CHAIN_ID = 8453;
const EXPECTED_CAL_TEST_KEY_SHA256 = 'a1609ceb5c83174145c39e67826ad702e3c84aa191b7d85e4799cb61ce13e386';
const DEFAULT_KEY = '/Users/Apple/Documents/ledger-dev/app-ethereum/client/src/ledger_app_clients/ethereum/keychain/cal.pem';
const keyFile = process.env.MANDATE_LEDGER_CAL_TEST_KEY_FILE?.trim() || DEFAULT_KEY;
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['docs/erc7730/eip712-USDC-base-mainnet.json'];

if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) {
  throw new Error('MANDATE_LEDGER_TEST_CAL_PORT must be a non-privileged TCP port');
}

const testPrivateKey = createPrivateKey(await readFile(resolve(keyFile)));
const testPublicKey = createPublicKey(testPrivateKey);
const jwk = testPublicKey.export({ format: 'jwk' });
if (jwk.kty !== 'EC' || jwk.crv !== 'secp256k1' || !jwk.x || !jwk.y) {
  throw new Error('Ledger CAL test fixture must be a secp256k1 EC key');
}
const uncompressedPublicKey = Buffer.concat([
  Buffer.from([0x04]),
  Buffer.from(jwk.x, 'base64url'),
  Buffer.from(jwk.y, 'base64url'),
]);
const testKeyFingerprint = createHash('sha256').update(uncompressedPublicKey).digest('hex');
if (testKeyFingerprint !== EXPECTED_CAL_TEST_KEY_SHA256) {
  throw new Error(`unexpected Ledger CAL test-key fingerprint ${testKeyFingerprint}`);
}

function assertHex(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) {
    throw new Error(`${label} must be non-empty even-length hex`);
  }
}

function signHexPayload(payloadHex, label) {
  assertHex(payloadHex, label);
  const payload = Buffer.from(payloadHex, 'hex');
  const signature = cryptoSign('sha256', payload, {
    key: testPrivateKey,
    dsaEncoding: 'der',
  });
  if (!cryptoVerify('sha256', payload, testPublicKey, signature)) {
    throw new Error(`${label}: local CAL test signature self-verification failed`);
  }
  return signature.toString('hex');
}

function resignEip712Tree(input, label) {
  const value = structuredClone(input);
  let signedInstructions = 0;
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.instructions)) {
      for (const instruction of node.instructions) {
        if (!instruction || typeof instruction !== 'object') throw new Error(`${label}: malformed instruction`);
        if (Number(instruction.chain_id) !== CHAIN_ID) throw new Error(`${label}: refusing non-Base-mainnet instruction`);
        if (!instruction.signatures || typeof instruction.signatures !== 'object') {
          throw new Error(`${label}: instruction signatures missing`);
        }
        instruction.signatures.test = signHexPayload(instruction.descriptor, `${label}: instruction`);
        signedInstructions++;
      }
      return;
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(value);
  if (signedInstructions === 0) throw new Error(`${label}: processor returned no EIP-712 instructions`);
  return { value, signedInstructions };
}

function resignTokenRows(rows) {
  if (!Array.isArray(rows)) throw new Error('CAL token response must be an array');
  return rows.map((row) => {
    if (!row?.descriptor?.data || !row?.descriptor?.signatures) return row;
    const copy = structuredClone(row);
    copy.descriptor.signatures.test = signHexPayload(copy.descriptor.data, 'token descriptor');
    return copy;
  });
}

async function jsonFetch(url, init = {}) {
  const signal = AbortSignal.timeout(20_000);
  const response = await fetch(url, { ...init, signal });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} from ${url}`);
  return response.json();
}

const descriptors = new Map();
let signedInstructionCount = 0;
for (const name of files) {
  const file = resolve(ROOT, name);
  const raw = await readFile(file, 'utf8');
  const descriptor = JSON.parse(raw);
  const deployments = descriptor?.context?.eip712?.deployments || descriptor?.context?.contract?.deployments || [];
  if (!deployments.length || deployments.some((d) => Number(d.chainId) !== CHAIN_ID)) {
    throw new Error(`${name}: Ledger development bridge is Base mainnet (8453) only`);
  }
  const processed = await jsonFetch(`${PROCESSOR}/api/process-erc7730-descriptor`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw,
  });
  for (const [key, rawValue] of Object.entries(processed.descriptors || {})) {
    if (!key.startsWith(`${CHAIN_ID}:`)) throw new Error(`processor returned off-network descriptor ${key}`);
    const { value, signedInstructions } = resignEip712Tree(rawValue, name);
    signedInstructionCount += signedInstructions;
    descriptors.set(key.toLowerCase(), value);
  }
}

function send(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
    if (req.method !== 'GET') return send(res, 405, { error: 'GET only' });

    if (url.pathname === '/health') {
      return send(res, 200, {
        ok: true,
        mode: 'ledger-cal-test-key',
        network: 'eip155:8453',
        descriptorKeys: [...descriptors.keys()],
        signedInstructions: signedInstructionCount,
        pkiCertificates: 0,
        testKeyFingerprint,
      });
    }

    if (url.pathname === '/dapps') {
      const chainId = Number(url.searchParams.get('chain_id'));
      const contracts = (url.searchParams.get('contracts') || '')
        .split(',')
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean);
      if (chainId !== CHAIN_ID || contracts.length !== 1) return send(res, 404, []);
      return send(res, 200, descriptors.get(`${chainId}:${contracts[0]}`) || []);
    }

    if (url.pathname === '/certificates') return send(res, 200, []);

    if (url.pathname === '/tokens') {
      const chainId = Number(url.searchParams.get('chain_id'));
      if (chainId !== CHAIN_ID) return send(res, 404, []);
      const upstream = new URL(`${PROD_CAL}/tokens`);
      for (const [key, value] of url.searchParams) upstream.searchParams.append(key, value);
      return send(res, 200, resignTokenRows(await jsonFetch(upstream)));
    }

    return send(res, 404, { error: 'unsupported Ledger test-CAL path' });
  } catch (error) {
    return send(res, 502, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`LEDGER_TEST_CAL_READY http://${HOST}:${PORT}`);
  console.log(JSON.stringify({
    descriptorKeys: [...descriptors.keys()],
    signedInstructions: signedInstructionCount,
    testKeyFingerprint,
    pkiCertificates: 0,
  }));
});
