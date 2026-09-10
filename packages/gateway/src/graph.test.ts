/**
 * Graph x402 constants and challenge parsing — hermetic.
 * Live payment is `npm run e2e:graph-x402`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GRAPH_X402_PRODUCTION,
  GRAPH_X402_TESTNET,
  GRAPH_X402_TESTNET_DOCUMENTED,
  GRAPH_X402_TESTNET_SUBGRAPH,
  isSepoliaX402Challenge,
  parseChallenge,
  type GraphChallenge,
} from "./graph.ts";

/** Live unpaid 402 from gateway.testnet.thegraph.com on 10 Sep 2026. */
const SEPOLIA_PAYMENT_REQUIRED =
  "eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJQYXltZW50LVNpZ25hdHVyZSBoZWFkZXIgaXMgcmVxdWlyZWQiLCJyZXNvdXJjZSI6eyJ1cmwiOiJodHRwOi8vZ2F0ZXdheS50ZXN0bmV0LnRoZWdyYXBoLmNvbS9zdWJncmFwaHMvaWQvNHlZQXZRTEZqQmhCdGRSQ1k3ZVVXbzE4MVZOb1RTTExGZDVNN0ZYUUFpNnUifSwiYWNjZXB0cyI6W3sic2NoZW1lIjoiZXhhY3QiLCJuZXR3b3JrIjoiZWlwMTU1Ojg0NTMyIiwiYW1vdW50IjoiNDIiLCJwYXlUbyI6IjB4MzAxNjcyZUVmMjNGMGU1ZjE2NWNmYmEyNjc2MjcwMkYyMEE3NDQzMCIsIm1heFRpbWVvdXRTZWNvbmRzIjozMDAsImFzc2V0IjoiMHgwMzZDYkQ1Mzg0MmM1NDI2NjM0ZTc5Mjk1NDFlQzIzMThmM2RDRjdlIiwiZXh0cmEiOnsiYXNzZXRUcmFuc2Zlck1ldGhvZCI6ImVpcDMwMDkiLCJuYW1lIjoiVVNEQyIsInZlcnNpb24iOiIyIn19XX0=";

function headersWith(paymentRequired: string): Headers {
  return new Headers({ "payment-required": paymentRequired });
}

test("live testnet host is the subdomain swap, not the documented NXDOMAIN name", () => {
  assert.equal(GRAPH_X402_TESTNET, "https://gateway.testnet.thegraph.com/api/x402");
  assert.equal(GRAPH_X402_TESTNET_DOCUMENTED, "https://testnet.gateway.thegraph.com/api/x402");
  assert.notEqual(GRAPH_X402_TESTNET, GRAPH_X402_TESTNET_DOCUMENTED);
  assert.notEqual(GRAPH_X402_TESTNET, GRAPH_X402_PRODUCTION);
  assert.equal(GRAPH_X402_TESTNET_SUBGRAPH, "ErqkB52VhmToVRxAWLaJ3cTDiwQMk93VKDEGtSSDB1yP");
});

test("parseChallenge decodes Graph's header-only 402", () => {
  const challenge = parseChallenge(headersWith(SEPOLIA_PAYMENT_REQUIRED));
  assert.ok(challenge);
  assert.equal(challenge.x402Version, 2);
  assert.equal(challenge.accepts[0]?.scheme, "exact");
  assert.equal(challenge.accepts[0]?.network, "eip155:84532");
  assert.equal(challenge.accepts[0]?.amount, "42");
  assert.equal(challenge.accepts[0]?.asset, "0x036CbD53842c5426634e7929541eC2318f3dCF7e");
  assert.equal(challenge.accepts[0]?.extra?.assetTransferMethod, "eip3009");
});

test("isSepoliaX402Challenge accepts Base Sepolia and rejects mainnet", () => {
  const sepolia = parseChallenge(headersWith(SEPOLIA_PAYMENT_REQUIRED)) as GraphChallenge;
  assert.equal(isSepoliaX402Challenge(sepolia), true);

  const mainnet: GraphChallenge = {
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        amount: "10000",
        payTo: "0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        maxTimeoutSeconds: 300,
      },
    ],
  };
  assert.equal(isSepoliaX402Challenge(mainnet), false);
});

test("parseChallenge returns null on garbage", () => {
  assert.equal(parseChallenge(new Headers()), null);
  assert.equal(parseChallenge(headersWith("not-base64-json!!!")), null);
});
