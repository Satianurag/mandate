import type { ServerResponse } from "node:http";
import type { StoredResponse } from "./journal.ts";

export function writeStored(res: ServerResponse, response: StoredResponse): void {
  res.writeHead(response.status, { "content-type": "application/json", "cache-control": "private, no-store", ...response.headers });
  res.end(response.body);
}
