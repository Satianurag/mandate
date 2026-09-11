import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { KeyRingError, listKeys } from "./keyring.ts";

async function fakeWallet(directory: string, body: string): Promise<void> {
  const path = join(directory, "wallet-cli");
  await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  await chmod(path, 0o700);
}

test("wallet-cli is bounded, killed on timeout/output overflow, sanitizes diagnostics, and recovers for later work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mandate-keyring-"));
  const previous = {
    PATH: process.env.PATH,
    WALLET_PASS: process.env.WALLET_PASS,
    timeout: process.env.MANDATE_WALLET_CLI_TIMEOUT_MS,
    output: process.env.MANDATE_WALLET_CLI_MAX_OUTPUT_BYTES,
  };
  process.env.PATH = `${directory}${delimiter}${previous.PATH ?? ""}`;
  process.env.WALLET_PASS = "super-secret-test-password";
  process.env.MANDATE_WALLET_CLI_TIMEOUT_MS = "75";
  process.env.MANDATE_WALLET_CLI_MAX_OUTPUT_BYTES = "512";
  try {
    await fakeWallet(directory, "sleep 10");
    const began = Date.now();
    await assert.rejects(() => listKeys(), (error: unknown) => {
      assert.ok(error instanceof KeyRingError);
      assert.match(error.message, /timed out after 75 ms/);
      return true;
    });
    assert.ok(Date.now() - began < 1500, "timeout must terminate promptly");

    process.env.MANDATE_WALLET_CLI_TIMEOUT_MS = "1000";
    await fakeWallet(directory, "dd if=/dev/zero bs=1024 count=2 2>/dev/null | tr '\\000' A");
    await assert.rejects(() => listKeys(), (error: unknown) => {
      assert.ok(error instanceof KeyRingError);
      assert.match(error.message, /512-byte output bound/);
      return true;
    });

    const privateLike = "0x" + "ab".repeat(32);
    await fakeWallet(directory, `echo "failure $WALLET_PASS ${privateLike}" >&2\nexit 7`);
    await assert.rejects(() => listKeys(), (error: unknown) => {
      assert.ok(error instanceof KeyRingError);
      assert.equal(error.code, 7);
      assert.equal(error.stderr?.includes("super-secret-test-password"), false);
      assert.equal(error.stderr?.includes(privateLike), false);
      assert.match(error.stderr ?? "", /REDACTED_PASSWORD/);
      assert.match(error.stderr ?? "", /REDACTED_32_BYTE_VALUE/);
      return true;
    });

    await fakeWallet(directory, `printf '%s' '{"ok":true,"data":{"keys":["graph-gateway"]}}'`);
    assert.deepEqual(await listKeys(), ["graph-gateway"]);
  } finally {
    if (previous.PATH === undefined) delete process.env.PATH; else process.env.PATH = previous.PATH;
    if (previous.WALLET_PASS === undefined) delete process.env.WALLET_PASS; else process.env.WALLET_PASS = previous.WALLET_PASS;
    if (previous.timeout === undefined) delete process.env.MANDATE_WALLET_CLI_TIMEOUT_MS; else process.env.MANDATE_WALLET_CLI_TIMEOUT_MS = previous.timeout;
    if (previous.output === undefined) delete process.env.MANDATE_WALLET_CLI_MAX_OUTPUT_BYTES; else process.env.MANDATE_WALLET_CLI_MAX_OUTPUT_BYTES = previous.output;
    await rm(directory, { recursive: true, force: true });
  }
});
