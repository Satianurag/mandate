import { test } from "node:test";
import assert from "node:assert/strict";
import { joinSignature } from "./dmksigner.ts";

// joinSignature is pure and load-bearing (a malformed join is a signature
// the facilitator rejects, or worse, one that verifies for wrong bytes):
// pinned here. Device I/O itself is proven live by `npm run mandate:open`.

test("joinSignature joins r‖s‖v into a 65-byte 0x signature", () => {
  // Built programmatically: a 64-hex literal in source would trip the
  // committed-key-material check in verify.sh.
  const sig = joinSignature({ r: `0x${"11".repeat(32)}`, s: `0x${"22".repeat(32)}`, v: 27 });
  assert.equal(sig, `0x${"11".repeat(32)}${"22".repeat(32)}1b`);
});

test("joinSignature pads short r/s and accepts 0/1-style v", () => {
  const sig = joinSignature({ r: "0x1", s: "0x2", v: 0 });
  assert.equal(sig.length, 2 + 64 + 64 + 2);
  assert.ok(sig.startsWith("0x0000"));
  assert.ok(sig.endsWith("00"));
});
