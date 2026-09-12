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

test("wallet-cli is bounded and killed on timeout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mandate-keyring-"));
  const previous = {
    PATH: process.env.PATH,
    WALLET_PASS: process.env.WALLET_PASS,
    timeout: process.env.MANDATE_WALLET_CLI_TIMEOUT_MS,
  };
  process.env.PATH = `${directory}${delimiter}${previous.PATH ?? ""}`;
  process.env.WALLET_PASS = "super-secret-test-password";
  process.env.MANDATE_WALLET_CLI_TIMEOUT_MS = "75";
  try {
    await fakeWallet(directory, "sleep 10");
    await assert.rejects(() => listKeys(), (error: unknown) => {
      assert.ok(error instanceof KeyRingError);
      assert.match(error.message, /timed out after 75 ms/);
      return true;
    });
  } finally {
    process.env.PATH = previous.PATH;
    if (previous.WALLET_PASS === undefined) delete process.env.WALLET_PASS;
    else process.env.WALLET_PASS = previous.WALLET_PASS;
    if (previous.timeout === undefined) delete process.env.MANDATE_WALLET_CLI_TIMEOUT_MS;
    else process.env.MANDATE_WALLET_CLI_TIMEOUT_MS = previous.timeout;
    await rm(directory, { recursive: true, force: true });
  }
});
