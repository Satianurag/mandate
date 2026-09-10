#!/usr/bin/env node
/**
 * Phase 0 live probes. Prints PASS/FAIL JSON. No product behavior change.
 * Exit 0 if every probe that must pass for later phases succeeded;
 * individual FAIL rows still print so FINDINGS can be honest.
 */
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const BATCH = "0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003";
const ERC3009 = "0x4020806089470a89826cB9fB1f4059150b550004";
const UPTO_PROXY = "0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002";
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

function rpc(url, method, params) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  }).then((r) => r.json());
}

async function codeAt(url, addr) {
  const j = await rpc(url, "eth_getCode", [addr, "latest"]);
  const code = j.result ?? "";
  return { address: addr, hasCode: typeof code === "string" && code !== "0x" && code.length > 2, bytes: code.length };
}

async function chainId(url) {
  const j = await rpc(url, "eth_chainId", []);
  return parseInt(j.result, 16);
}

function row(name, ok, detail) {
  console.log(JSON.stringify({ probe: name, ok, ...detail }));
  return ok;
}

const results = {};

// 1. Graph x402 testnet
{
  const host = "https://testnet.gateway.thegraph.com/api/x402";
  const subgraph = "4yYAvQLFjBhBtdRCY7eUWo181VNoTSLLFd5M7FXQAi6u";
  try {
    const res = await fetch(`${host}/subgraphs/id/${subgraph}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ _meta { block { number } } }" }),
      signal: AbortSignal.timeout(20_000),
    });
    const header = res.headers.get("payment-required");
    let challenge = null;
    if (header) {
      try {
        challenge = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
      } catch {
        challenge = { parseError: true, rawPrefix: header.slice(0, 80) };
      }
    }
    const accept = challenge?.accepts?.[0];
    results.graphX402Testnet = row("graph-x402-testnet", res.status === 402 && Boolean(accept), {
      status: res.status,
      scheme: accept?.scheme,
      network: accept?.network,
      asset: accept?.asset,
      amount: accept?.amount,
    });
  } catch (e) {
    results.graphX402Testnet = row("graph-x402-testnet", false, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// Graph x402 production still 402 (control)
{
  try {
    const res = await fetch(
      "https://gateway.thegraph.com/api/x402/subgraphs/id/43s9hQRurMGjuYnC1r2ZwS6xSQktbFyXMPMqGKUFJojb",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "{ _meta { block { number } } }" }),
        signal: AbortSignal.timeout(20_000),
      }
    );
    results.graphX402Mainnet = row("graph-x402-mainnet-control", res.status === 402, {
      status: res.status,
    });
  } catch (e) {
    results.graphX402Mainnet = row("graph-x402-mainnet-control", false, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// 2. Substreams registry + toolchain
{
  const which = async (bin) => {
    const { spawn } = await import("node:child_process");
    return new Promise((resolve) => {
      const c = spawn("which", [bin]);
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.on("close", (code) => resolve(code === 0 ? out.trim() : ""));
    });
  };
  let registry = null;
  let baseSepolia = null;
  try {
    const urls = [
      "https://raw.githubusercontent.com/graphprotocol/networks-registry/main/theGraphNetworksRegistry.json",
      "https://networks-registry.thegraph.com/",
    ];
    for (const u of urls) {
      try {
        const res = await fetch(u, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) continue;
        const json = await res.json();
        registry = { url: u, keys: Object.keys(json).slice(0, 8) };
        const text = JSON.stringify(json);
        const hit = text.match(/base[_-]?sepolia[^"]{0,80}substreams[^"]{0,80}/i);
        if (hit) baseSepolia = hit[0];
        const nets = json.networks ?? json;
        if (Array.isArray(nets)) {
          const n = nets.find((x) => /base.?sepolia/i.test(JSON.stringify(x)));
          if (n) baseSepolia = n.substreams ?? n.firehose ?? n;
        }
        break;
      } catch {
        /* try next */
      }
    }
  } catch (e) {
    registry = { error: e instanceof Error ? e.message : String(e) };
  }
  const rustc = await which("rustc");
  const substreams = await which("substreams");
  results.substreams = row(
    "substreams-base-sepolia",
    Boolean(baseSepolia) && Boolean(substreams),
    { registry, baseSepolia, rustc, substreams }
  );
}

// Pinax hostname guesses
{
  const hosts = [
    "basesepolia.substreams.pinax.network",
    "base-sepolia.substreams.pinax.network",
    "base_sepolia.substreams.pinax.network",
  ];
  const dns = [];
  const { Resolver } = await import("node:dns/promises");
  const r = new Resolver();
  for (const h of hosts) {
    try {
      const addrs = await r.resolve4(h);
      dns.push({ host: h, ok: true, addrs });
    } catch (e) {
      dns.push({ host: h, ok: false, error: e.code ?? String(e) });
    }
  }
  results.pinaxDns = row(
    "pinax-base-sepolia-dns",
    dns.some((d) => d.ok),
    { dns }
  );
}

// 3. Hedera + Base Sepolia contract code
{
  const hashio = "https://testnet.hashio.io/api";
  const base = "https://sepolia.base.org";
  try {
    const hid = await chainId(hashio);
    const bid = await chainId(base);
    const hedera = {
      chainId: hid,
      permit2: await codeAt(hashio, PERMIT2),
      batch: await codeAt(hashio, BATCH),
      erc3009: await codeAt(hashio, ERC3009),
      upto: await codeAt(hashio, UPTO_PROXY),
    };
    const sepolia = {
      chainId: bid,
      permit2: await codeAt(base, PERMIT2),
      batch: await codeAt(base, BATCH),
      erc3009: await codeAt(base, ERC3009),
      upto: await codeAt(base, UPTO_PROXY),
      usdc: await codeAt(base, USDC_SEPOLIA),
    };
    results.hederaStack = row("hedera-batch-settlement-stack", hedera.batch.hasCode && hedera.permit2.hasCode, hedera);
    results.baseSepoliaStack = row(
      "base-sepolia-batch-upto-stack",
      sepolia.batch.hasCode && sepolia.permit2.hasCode && sepolia.upto.hasCode,
      sepolia
    );
  } catch (e) {
    results.contracts = row("contract-code", false, { error: e instanceof Error ? e.message : String(e) });
  }
}

// 4. Facilitator /supported
{
  const urls = [
    "https://x402.org/facilitator",
    "https://api.testnet.blocky402.com",
  ];
  for (const url of urls) {
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}/supported`, {
        signal: AbortSignal.timeout(20_000),
      });
      const body = await res.json();
      const kinds = (body.kinds ?? []).map((k) => `${k.scheme}@${k.network}`);
      const name = url.includes("blocky") ? "blocky402-supported" : "x402org-supported";
      results[name] = row(name, res.ok && kinds.length > 0, {
        status: res.status,
        kinds: kinds.filter((k) => /upto|batch-settlement|hedera|84532|296|base-sepolia/i.test(k)),
        kindCount: kinds.length,
      });
    } catch (e) {
      const name = url.includes("blocky") ? "blocky402-supported" : "x402org-supported";
      results[name] = row(name, false, { error: e instanceof Error ? e.message : String(e) });
    }
  }
}

// 5. Subgraph MCP package on npm
{
  try {
    const res = await fetch("https://registry.npmjs.org/@graphprotocol/mcp", {
      signal: AbortSignal.timeout(15_000),
    });
    const alt = await fetch("https://registry.npmjs.org/subgraph-mcp", {
      signal: AbortSignal.timeout(15_000),
    });
    const graphops = await fetch("https://registry.npmjs.org/@graphops/subgraph-mcp", {
      signal: AbortSignal.timeout(15_000),
    });
    const packs = {
      "@graphprotocol/mcp": res.status,
      "subgraph-mcp": alt.status,
      "@graphops/subgraph-mcp": graphops.status,
    };
    results.subgraphMcp = row(
      "subgraph-mcp-npm",
      Object.values(packs).some((s) => s === 200),
      { packs }
    );
  } catch (e) {
    results.subgraphMcp = row("subgraph-mcp-npm", false, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// 6. Graph Explorer Agent0 subgraph search (no API key)
{
  try {
    const q = `{ subgraphs(first: 5, where: { displayName_contains_nocase: "agent0" }) { displayName currentVersion { subgraphDeployment { ipfsHash } } } }`;
    const res = await fetch("https://api.thegraph.com/subgraphs/name/graphprotocol/graph-network-arbitrum", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: q }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.json();
    results.agent0Discovery = row("agent0-explorer-discovery", !body.errors, {
      status: res.status,
      errors: body.errors,
      n: body.data?.subgraphs?.length,
    });
  } catch (e) {
    results.agent0Discovery = row("agent0-explorer-discovery", false, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

console.log("\nPHASE0_SUMMARY " + JSON.stringify({
  graphX402Testnet: results.graphX402Testnet,
  substreams: results.substreams,
  pinaxDns: results.pinaxDns,
  hederaBatch: results.hederaStack,
  baseSepoliaUpto: results.baseSepoliaStack,
  subgraphMcp: results.subgraphMcp,
}));
