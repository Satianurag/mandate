/**
 * node:http → the stock x402 `HTTPAdapter`.
 *
 * Both resource servers (the Hedera metered service and the mandate
 * service) are plain `node:http` skins over the stock
 * `x402HTTPResourceServer`; this adapter is the only glue they need, kept
 * in exactly one place.
 */

import type { IncomingMessage } from "node:http";
import type { HTTPAdapter } from "@x402/core/server";

export function nodeAdapter(req: IncomingMessage, base: string): HTTPAdapter {
  const url = new URL(req.url ?? "/", base);
  return {
    getHeader: (name: string) => {
      const v = req.headers[name.toLowerCase()];
      return Array.isArray(v) ? v[0] : v;
    },
    getMethod: () => req.method ?? "GET",
    getPath: () => url.pathname,
    getUrl: () => url.toString(),
    getAcceptHeader: () => req.headers.accept ?? "",
    getUserAgent: () => req.headers["user-agent"] ?? "",
    getQueryParams: () => Object.fromEntries(url.searchParams.entries()),
  };
}
