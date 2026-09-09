#!/usr/bin/env node
/**
 * Day 1 spike — open a batch-settlement channel on Base Sepolia.
 *
 * Requires (never commit):
 *   MANDATE_EVM_SIGNING_KEY  — payer with Base Sepolia ETH + USDC
 *   MANDATE_EVM_RECEIVER     — payTo address
 *   MANDATE_EVM_RECEIVER_SIGNING_KEY — optional; defaults to signing key (must control receiver)
 */

import { createServer } from "node:http";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { x402HTTPResourceServer } from "@x402/core/http";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/server";
import { BatchSettlementEvmScheme as BatchClient } from "@x402/evm/batch-settlement/client";
import { toClientEvmSigner } from "@x402/evm";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";
import {
  InMemoryClientChannelStorage,
  computeChannelId,
  buildChannelConfig,
} from "@x402/evm/batch-settlement/client";

const ROOT = new URL("..", import.meta.url).pathname;
const { MANDATE_CHANNEL_SALT } = await import(`${ROOT}/packages/gateway/src/envelope.ts`);

const FACILITATOR = "https://x402.org/facilitator";
const NETWORK = "eip155:84532";
const PORT = Number(process.env.SPIKE_PORT ?? 8410);
// Single source of truth for the channel salt lives in envelope.ts.
const SALT = process.env.MANDATE_CHANNEL_SALT ?? MANDATE_CHANNEL_SALT;

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}. Export it in your shell — never commit it.`);
    process.exit(1);
  }
  return v;
}

const privateKey = need("MANDATE_EVM_SIGNING_KEY");
const receiver = need("MANDATE_EVM_RECEIVER");

const account = privateKeyToAccount(privateKey);
const receiverAddr = receiver;
const receiverKey = process.env.MANDATE_EVM_RECEIVER_SIGNING_KEY ?? privateKey;
const receiverAuthorizer = privateKeyToAccount(receiverKey);
if (receiverAuthorizer.address.toLowerCase() !== receiverAddr.toLowerCase()) {
  console.error(
    "MANDATE_EVM_RECEIVER_SIGNING_KEY must control MANDATE_EVM_RECEIVER (batch-settlement authorizer)"
  );
  process.exit(1);
}

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR });
const batchServer = new BatchSettlementEvmScheme(receiverAddr, {
  receiverAuthorizerSigner: {
    address: receiverAuthorizer.address,
    signTypedData: (params) => receiverAuthorizer.signTypedData(params),
  },
});
const resourceServer = new x402ResourceServer(facilitatorClient).register(NETWORK, batchServer);

const routes = {
  [`GET /query`]: {
    accepts: {
      scheme: "batch-settlement",
      network: NETWORK,
      payTo: receiverAddr,
      price: "$0.01",
      description: "Mandate envelope spike",
    },
    description: "Envelope spike endpoint",
    mimeType: "application/json",
  },
};

const httpResource = new x402HTTPResourceServer(resourceServer, routes);
await httpResource.initialize();

function nodeAdapter(req) {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  return {
    getHeader: (name) => {
      const v = req.headers[name.toLowerCase()];
      return Array.isArray(v) ? v[0] : v;
    },
    getMethod: () => req.method ?? "GET",
    getPath: () => url.pathname,
    getUrl: () => url.toString(),
    getAcceptHeader: () => String(req.headers.accept ?? ""),
    getUserAgent: () => String(req.headers["user-agent"] ?? ""),
    getQueryParams: () => Object.fromEntries(url.searchParams.entries()),
    getQueryParam: (name) => url.searchParams.get(name) ?? undefined,
  };
}

function writeInstructions(res, instructions) {
  const headers = { ...instructions.headers };
  let body = instructions.body;
  if (body !== undefined && typeof body !== "string") {
    headers["content-type"] ??= "application/json";
    body = JSON.stringify(body);
  }
  res.writeHead(instructions.status, headers);
  res.end(body ?? "");
}

const server = createServer(async (req, res) => {
  const adapter = nodeAdapter(req);
  const context = {
    adapter,
    path: adapter.getPath(),
    method: adapter.getMethod(),
  };

  const result = await httpResource.processHTTPRequest(context);

  if (result.type === "no-payment-required") {
    res.writeHead(404).end();
    return;
  }

  if (result.type === "payment-error") {
    writeInstructions(res, result.response);
    return;
  }

  const handlerBody = JSON.stringify({ ok: true, message: "envelope payment accepted" });
  const transportContext = {
    request: context,
    responseBody: Buffer.from(handlerBody),
    responseHeaders: { "content-type": "application/json" },
  };

  if (result.beforeHandlerSettlement) {
    const headers = httpResource.createCompletedSettlementHeaders(result.beforeHandlerSettlement);
    res.writeHead(200, { ...headers, "content-type": "application/json" });
    res.end(handlerBody);
    return;
  }

  const settle = await httpResource.processSettlement(
    result.paymentPayload,
    result.paymentRequirements,
    result.declaredExtensions,
    transportContext,
    undefined,
    result.beforeHandlerSettlement
  );

  if (!settle.success) {
    writeInstructions(res, settle.response);
    return;
  }

  res.writeHead(200, { ...settle.headers, "content-type": "application/json" });
  res.end(handlerBody);
});

await new Promise((resolve) => server.listen(PORT, resolve));
console.log(`spike server http://127.0.0.1:${PORT}/query`);

const clientSigner = toClientEvmSigner(account);
const storage = new InMemoryClientChannelStorage();
const clientScheme = new BatchClient(clientSigner, { salt: SALT, storage });
const x402 = new x402Client().register(NETWORK, clientScheme);
const fetchWithPay = wrapFetchWithPayment(fetch, x402);

const url = `http://127.0.0.1:${PORT}/query`;
console.log(`paying via batch-settlement@${NETWORK} …`);

try {
  const res = await fetchWithPay(url);
  console.log(`HTTP ${res.status}`);
  const text = await res.text();
  console.log(text);

  if (res.status !== 200) {
    const payHdr = res.headers.get("payment-required");
    if (payHdr) {
      try {
        const { decodePaymentRequiredHeader } = await import("@x402/core/http");
        const errBody = decodePaymentRequiredHeader(payHdr);
        if (errBody.error) console.error(`facilitator error: ${errBody.error}`);
      } catch {
        /* ignore decode failures */
      }
    }
    console.error("SPIKE_FAILED: expected HTTP 200 after payment");
    process.exit(1);
  }

  const deps = { signer: clientSigner, storage, salt: SALT };
  const payReqHeader = res.headers.get("payment-required");
  if (payReqHeader) {
    const { decodePaymentRequiredHeader } = await import("@x402/core/http");
    const required = decodePaymentRequiredHeader(payReqHeader);
    const accept = required.accepts?.[0];
    if (accept) {
      const channelId = computeChannelId(buildChannelConfig(deps, accept), NETWORK);
      console.log(`channelId ${channelId}`);
    }
  } else {
    const probe = await fetch(url);
    const hdr = probe.headers.get("payment-required");
    if (hdr) {
      const { decodePaymentRequiredHeader } = await import("@x402/core/http");
      const required = decodePaymentRequiredHeader(hdr);
      const accept = required.accepts?.[0];
      if (accept) {
        const channelId = computeChannelId(buildChannelConfig(deps, accept), NETWORK);
        console.log(`channelId ${channelId}`);
      }
    }
  }
  console.log("SPIKE_OK");
} catch (e) {
  console.error("SPIKE_FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
} finally {
  server.close();
}
