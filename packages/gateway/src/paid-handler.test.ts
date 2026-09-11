import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { x402HTTPResourceServer } from "@x402/core/server";
import { Journal } from "./journal.ts";
import { handlePaidRequest } from "./paid-handler.ts";

async function malformed(path: string) {
  const journal = new Journal(":memory:");
  let prepared = 0;
  let paymentMethodsRead = 0;
  const httpServer = new Proxy({}, {
    get() {
      paymentMethodsRead += 1;
      throw new Error("payment processing must not be reached for malformed source input");
    },
  }) as x402HTTPResourceServer;
  const server = createServer((req, res) => {
    void handlePaidRequest({
      req,
      res,
      httpServer,
      journal,
      prepare: async () => { prepared += 1; return {}; },
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
    return { response, body: await response.json() as Record<string, unknown>, prepared, paymentMethodsRead };
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    journal.close();
  }
}

test("malformed research source fails as unpaid HTTP 400 before x402 or Graph work", async () => {
  const cases = [
    "/analytics?sourceChain=bsc-chapel",
    "/analytics?sourceDeployment=BTjind17gmRZ6YhT9peaCM13SvWuqztsmqyfjpntbg3Z",
    "/analytics?sourceChain=mainnet&sourceDeployment=BTjind17gmRZ6YhT9peaCM13SvWuqztsmqyfjpntbg3Z",
    "/analytics?sourceChain=bsc-chapel&sourceDeployment=guess",
    "/analytics?q=%7Bagents%7Bid%7D%7D&q=%7Bagents%7Bid%7D%7D",
    "/analytics?receiver=0x0000000000000000000000000000000000000001",
  ];
  for (const path of cases) {
    const result = await malformed(path);
    assert.equal(result.response.status, 400, path);
    assert.equal(result.body.paymentCommitted, false, path);
    assert.equal(result.body.paymentProcessingAttempted, false, path);
    assert.equal(result.prepared, 0, path);
    assert.equal(result.paymentMethodsRead, 0, path);
  }
});
