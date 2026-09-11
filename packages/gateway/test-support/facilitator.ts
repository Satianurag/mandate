/**
 * Hermetic facilitator double for the stock x402 flow.
 *
 * Speaks the real facilitator HTTP surface (`GET /supported`, `POST
 * /verify`, `POST /settle`) with schema-valid canned responses, and counts
 * calls so tests can prove what the flow touched -- and, for denies, what
 * it never touched. The 402 path only ever needs `/supported`; `/verify`
 * and `/settle` answer only when a paid request actually flows.
 */

import { createServer, type Server } from "node:http";

export interface StubFacilitator {
  url: string;
  calls: { verify: number; settle: number };
}

export function startStubFacilitator(
  t: { after: (fn: () => void) => void },
  opts: {
    verify?: { isValid: boolean; invalidReason?: string };
    settle?: { success: boolean; errorReason?: string };
  } = {}
): Promise<StubFacilitator> {
  const calls = { verify: 0, settle: 0 };
  const server: Server = createServer((req, res) => {
    const body = (obj: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.method === "GET" && req.url === "/supported") {
      return body({
        kinds: [
          {
            x402Version: 2,
            scheme: "exact",
            network: "hedera:testnet",
            extra: { feePayer: "0.0.7162784" },
          },
        ],
        extensions: [],
        signers: {},
      });
    }
    if (req.method === "POST" && req.url === "/verify") {
      calls.verify++;
      req.resume();
      const v = opts.verify ?? { isValid: true };
      return body({
        isValid: v.isValid,
        ...(v.invalidReason ? { invalidReason: v.invalidReason } : {}),
        payer: "0.0.54321",
      });
    }
    if (req.method === "POST" && req.url === "/settle") {
      calls.settle++;
      req.resume();
      const s = opts.settle ?? { success: true };
      return body({
        success: s.success,
        // The stock settle schema requires transaction + network on every
        // response, including failures.
        transaction: "0.0.54321@1757280000.000000000",
        network: "hedera:testnet",
        ...(s.errorReason ? { errorReason: s.errorReason } : {}),
      });
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      t.after(() => server.close());
      resolve({
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        calls,
      });
    });
  });
}
