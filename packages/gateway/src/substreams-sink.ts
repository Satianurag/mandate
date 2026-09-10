/**
 * Tiny Substreams sink reader: parse `substreams run` text for live-discovered
 * contract hits. Used by evidence (`npm run e2e:substreams`), not an in-memory fake db.
 */

export interface X402Hit {
  tx: string;
  address: string;
  block?: number;
}

const HIT_RE = /x402_hit tx=(0x[0-9a-fA-F]+) address=(0x[0-9a-fA-F]+)(?: block=(\d+))?/gi;

export function parseSubstreamsHits(output: string): X402Hit[] {
  const hits: X402Hit[] = [];
  for (const m of output.matchAll(HIT_RE)) {
    hits.push({
      tx: m[1]!.toLowerCase(),
      address: m[2]!.toLowerCase(),
      block: m[3] ? Number(m[3]) : undefined,
    });
  }
  return hits;
}

export function findTx(hits: X402Hit[], txHash: string): X402Hit | undefined {
  const want = txHash.toLowerCase();
  return hits.find((h) => h.tx === want || h.tx.includes(want.slice(2, 18)));
}
