/**
 * Ledger Key Ring custody.
 *
 * Mandate holds no plaintext secrets on disk and no secrets in environment
 * variables. Everything -- the Hedera payment key, the Graph gateway API key,
 * upstream service credentials -- is sealed with `wallet-cli ring encrypt` and
 * unsealed only for the lifetime of a single operation.
 *
 * The Ledger Key Ring Protocol encrypts under keys tied to the device
 * (AES-256-GCM, per-name derivation from a BIP32-style tree), so a blob sealed
 * once on a machine with the device attached can be opened later on a VPS or
 * CI runner with no device present. That non-USB path is the whole reason this
 * module exists.
 *
 * Docs: https://developers.ledger.com/docs/ai-tools/ledger-cli#key-ring
 */

import { spawn } from "node:child_process";

export class KeyRingError extends Error {
  readonly stderr?: string;
  readonly code?: number;

  constructor(message: string, stderr?: string, code?: number) {
    super(message);
    this.name = "KeyRingError";
    this.stderr = stderr;
    this.code = code;
  }
}

/**
 * Unseal a named secret.
 *
 * Reads ciphertext from `stdin` and writes plaintext to `stdout`, so the
 * secret never touches the filesystem. The CLI reads its password from
 * WALLET_PASS when there is no interactive terminal -- which is exactly the
 * headless case -- so the caller is responsible for sourcing that from the OS
 * keychain rather than a literal.
 *
 *   macOS:  WALLET_PASS=$(security find-generic-password -a default -s ledger-wallet-cli -w)
 *   Linux:  WALLET_PASS=$(secret-tool lookup service ledger-wallet-cli account default)
 *
 * Never write the password literally into a command; it would land in shell
 * history, the process list, and CI logs.
 */
export async function unseal(keyName: string, ciphertext: Buffer): Promise<Buffer> {
  if (!process.env.WALLET_PASS) {
    throw new KeyRingError(
      "WALLET_PASS is not set. Mandate runs headless and cannot prompt. " +
        "Source it from the OS keychain before starting the gateway."
    );
  }

  const out = await run(["ring", "decrypt", "--key", keyName], ciphertext);

  // Guard against the CLI wrapping plaintext in its JSON envelope when stdout
  // is a pipe. Returning `{"ok":true,...}` as if it were a private key would
  // fail far downstream with an unreadable error, so catch it here.
  const env = tryEnvelope(out.toString("utf8"));
  if (env) {
    const e = env as { ok?: boolean; error?: { message?: string }; data?: unknown };
    if (e.ok === false) {
      throw new KeyRingError(
        `ring decrypt failed for key "${keyName}": ${e.error?.message ?? "unknown"}`
      );
    }
    if (typeof e.data === "string") return Buffer.from(e.data, "utf8");
    throw new KeyRingError(
      `ring decrypt returned a JSON envelope rather than raw plaintext for key ` +
        `"${keyName}". Pass --output explicitly or update this adapter.`
    );
  }

  if (out.length === 0) {
    throw new KeyRingError(`ring decrypt returned empty output for key "${keyName}".`);
  }
  return out;
}

/** Seal a secret under a named Key Ring key. Provisioning-time only. */
export async function seal(keyName: string, plaintext: Buffer): Promise<Buffer> {
  return run(["ring", "encrypt", "--key", keyName], plaintext);
}

/**
 * List keys provisioned on this machine. Used by the preflight check.
 *
 * wallet-cli 2.1.0 emits a `{ok, data}` JSON envelope when stdout is a pipe
 * (verified 2026-09-08), so this parses the envelope rather than splitting
 * lines. Falls back to line-splitting if a future version emits plain text.
 */
export async function listKeys(): Promise<string[]> {
  const out = (await run(["ring", "keys"], Buffer.alloc(0))).toString("utf8");
  const env = tryEnvelope(out);
  if (env && typeof env === "object") {
    const data = (env as { data?: unknown }).data;
    if (Array.isArray(data)) return data.map(String);
    const keys = (data as { keys?: unknown })?.keys;
    if (Array.isArray(keys)) return keys.map(String);
  }
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/**
 * wallet-cli wraps results as {"ok":true,"data":...} and errors as
 * {"ok":false,"error":{...}}. Returns the parsed object, or null if the output
 * is not an envelope -- which is the case for raw binary, and is exactly what
 * `ring decrypt` should produce.
 */
function tryEnvelope(text: string): unknown | null {
  const t = text.trimStart();
  if (!t.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(t) as { ok?: unknown };
    return typeof parsed?.ok === "boolean" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Unseal, use, and forget.
 *
 * The plaintext buffer is zeroed as soon as `fn` returns, including on the
 * throw path. This is a best-effort scrub -- V8 may still hold copies if the
 * secret was converted to a string, so `fn` should consume the Buffer
 * directly wherever the downstream API allows it.
 */
export async function withSecret<T>(
  keyName: string,
  ciphertext: Buffer,
  fn: (secret: Buffer) => Promise<T>
): Promise<T> {
  const secret = await unseal(keyName, ciphertext);
  try {
    return await fn(secret);
  } finally {
    secret.fill(0);
  }
}

function run(args: string[], input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("wallet-cli", args, {
      stdio: ["pipe", "pipe", "pipe"],
      // Pass WALLET_PASS through explicitly rather than inheriting the whole
      // environment, so an unrelated leaked variable cannot ride along.
      env: { PATH: process.env.PATH ?? "", WALLET_PASS: process.env.WALLET_PASS ?? "" },
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));

    child.on("error", (e) =>
      reject(
        new KeyRingError(
          `Could not run wallet-cli. Install it with: npm i -g @ledgerhq/wallet-cli (${e.message})`
        )
      )
    );

    child.on("close", (code) => {
      if (code === 0) return resolve(Buffer.concat(out));
      reject(
        new KeyRingError(
          `wallet-cli ${args[0]} ${args[1]} exited ${code}`,
          Buffer.concat(err).toString("utf8"),
          code ?? undefined
        )
      );
    });

    if (input.length) child.stdin.write(input);
    child.stdin.end();
  });
}
