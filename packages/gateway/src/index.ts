/**
 * Mandate -- a hardware trust boundary for x402 agent payments.
 *
 * Runs as a local HTTP proxy in front of the agent. The agent makes ordinary
 * requests; Mandate pays the 402s through the stock x402 client with its
 * judgment hooks attached (see client.ts), and maps denies to 403s.
 */

import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { wrapFetchWithPayment } from "@x402/fetch";
import { DEFAULT_POLICY } from "./policy.ts";
import { createMandateClient } from "./client.ts";
import { BLOCKY402_URL } from "./facilitators.ts";
import { withSecret } from "./keyring.ts";
import type { StepUpDeps } from "./stepup.ts";
import { loadRequiredPresence } from "./presence.ts";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const PORT = Number(process.env.MANDATE_PORT ?? 8402);
const HOST = process.env.MANDATE_HOST ?? "127.0.0.1";
const UPSTREAM = process.env.MANDATE_UPSTREAM ?? "http://127.0.0.1:8403/analytics";
const HCS_TOPIC = process.env.MANDATE_HCS_TOPIC_ID;
const GRAPH_KEY_PATH =
  process.env.MANDATE_GRAPH_KEY_ENC ?? join(PROJECT_ROOT, "secrets/graph.enc");
const HEDERA_KEY_PATH =
  process.env.MANDATE_HEDERA_KEY_ENC ?? join(PROJECT_ROOT, "secrets/hedera.enc");

/**
 * Unseal the Graph gateway key from the Key Ring. Returns null when no
 * sealed key exists on this host — the client then records reputation as
 * unavailable (never as trusted). There is no env-var path: a plaintext
 * API key in the environment would violate invariant 1.
 */
async function loadGraphKey(): Promise<string | null> {
  const { readFile } = await import("node:fs/promises");
  // Paths resolve at call time: proxyFetch is also imported by tests and
  // scripts that set the environment after this module loads.
  const keyPath = process.env.MANDATE_GRAPH_KEY_ENC ?? GRAPH_KEY_PATH;
  const enc = await readFile(keyPath).catch(() => null);
  if (!enc) return null;
  return withSecret("graph-gateway", enc, (buf) =>
    Promise.resolve(buf.toString("utf8").trim())
  );
}

async function loadHederaKeyEnc(): Promise<Buffer> {
  const { readFile } = await import("node:fs/promises");
  return readFile(process.env.MANDATE_HEDERA_KEY_ENC ?? HEDERA_KEY_PATH);
}

/**
 * Proxy one upstream URL through the stock paid-fetch flow.
 *
 * A preflight request first: resources that do not challenge pass through
 * untouched, without loading keys or building a client. On a 402 the
 * mandate client takes over -- judge, sign, retry -- and a denied payment
 * becomes a 403 carrying the policy reason and trace.
 *
 * `init.body`, when present, must be re-readable (Buffer/string): the
 * preflight sends it once and the paid retry sends it again. The gateway
 * boot path always passes a Buffer.
 */
export async function proxyFetch(
  upstreamUrl: string,
  init?: RequestInit,
  deps: { stepUp?: StepUpDeps } = {}
) {
  const preflight = await fetch(upstreamUrl, init);
  if (preflight.status !== 402) return preflight;

  const accountId = process.env.MANDATE_HEDERA_ACCOUNT_ID;
  if (!accountId) {
    return new Response(
      JSON.stringify({ error: "MANDATE_HEDERA_ACCOUNT_ID unset — cannot sign" }),
      { status: 503, headers: { "content-type": "application/json" } }
    );
  }

  let hederaEnc: Buffer;
  try {
    hederaEnc = await loadHederaKeyEnc();
  } catch {
    return new Response(
      JSON.stringify({
        error: "Hedera signing key not sealed — see docs/plan.md pre-code checklist",
      }),
      { status: 503, headers: { "content-type": "application/json" } }
    );
  }

  const graphKey = await loadGraphKey();
  let presence;
  try {
    presence = await loadRequiredPresence();
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      { status: 403, headers: { "content-type": "application/json" } }
    );
  }
  const { x402, getLastDecision } = createMandateClient({
    hederaCiphertext: hederaEnc,
    accountId,
    graphApiKey: graphKey,
    hcsTopic: process.env.MANDATE_HCS_TOPIC_ID,
    stepUp: deps.stepUp,
    presence,
  });

  try {
    return await wrapFetchWithPayment(fetch, x402)(upstreamUrl, init);
  } catch (e) {
    // A denial aborts payment creation inside the stock client, which
    // surfaces as a throw. The judgment itself is stashed by the hook, so
    // the 403 carries the real reason without parsing SDK error strings.
    const last = getLastDecision();
    if (last && last.decision.verdict === "deny") {
      return new Response(
        JSON.stringify({ error: last.decision.reason, trace: last.decision.trace }),
        { status: 403, headers: { "content-type": "application/json" } }
      );
    }
    throw e;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // The audit trail is load-bearing: a gateway that cannot record verdicts
  // must not serve. No silent degraded mode.
  if (!HCS_TOPIC) {
    console.error("Set MANDATE_HCS_TOPIC_ID before starting the gateway (npm run provision:hcs).");
    process.exit(1);
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
    if (url.pathname !== "/proxy") {
      res.writeHead(404).end("Use GET /proxy?q=…\n");
      return;
    }
    const target = new URL(UPSTREAM);
    target.search = url.search;

    try {
      // Forward the body so POST/PUT x402 flows survive the proxy; hop-by-hop
      // and identity headers must not leak through (Host would misroute).
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const headers = { ...(req.headers as Record<string, string | string[] | undefined>) };
      for (const h of ["host", "connection", "content-length", "transfer-encoding"]) delete headers[h];

      const upstream = await proxyFetch(target.toString(), {
        method: req.method ?? "GET",
        headers: headers as HeadersInit,
        body,
      });
      res.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
  });

  // Loopback by default: this proxy spends money on whoever calls it.
  // Bind wider only behind an authenticated front door (MANDATE_HOST=0.0.0.0).
  server.listen(PORT, HOST, () => {
    console.log(`Mandate listening on ${HOST}:${PORT}`);
    console.log(`  proxy        GET /proxy → ${UPSTREAM}`);
    console.log(`  hedera       ${BLOCKY402_URL} · exact@hedera:testnet`);
    console.log(`  per-call     ${DEFAULT_POLICY.perCallCeiling}`);
    console.log(`  window       ${DEFAULT_POLICY.windowBudget} / ${DEFAULT_POLICY.windowMs / 3.6e6}h`);
    console.log(`  custody      Ledger Key Ring (no .env secrets)`);
  });
}
