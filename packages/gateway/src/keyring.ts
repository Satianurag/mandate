/**
 * Ledger Key Ring custody adapter. Ciphertext stays on disk; decrypt uses the
 * CLI's password-protected member and network trustchain. After provisioning,
 * Key Ring decryption need not use USB. The CLI still consumes WALLET_PASS in
 * its child environment; same-user host processes are not isolated by this API.
 * Only the trusted broker may invoke it. Agents run behind a separate boundary.
 * Buffer cleanup is best-effort: derived JavaScript strings cannot be wiped.
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

  // F6 proved `ring decrypt` returns raw plaintext over a pipe. A JSON
  // envelope here means the CLI changed behaviour — fail loudly with the
  // exact output. Never unwrap-and-continue: returning `{"ok":true,...}` as
  // if it were key material would fail far downstream, unreadably.
  const env = tryEnvelope(out.toString("utf8"));
  if (env) {
    const e = env as { ok?: boolean; error?: { message?: string } };
    if (e.ok === false) {
      throw new KeyRingError(
        `ring decrypt failed for key "${keyName}": ${e.error?.message ?? "unknown"}`
      );
    }
    throw new KeyRingError(
      `ring decrypt returned a JSON envelope rather than raw plaintext for key ` +
        `"${keyName}" (wallet-cli behaviour change — update this adapter).`
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
 * (verified 2026-09-08). Anything else is a CLI behaviour change and throws
 * rather than guessing: silently misreading the key list would seal secrets
 * under the wrong identity.
 */
export async function listKeys(): Promise<string[]> {
  const out = (await run(["ring", "keys", "--output", "json"], Buffer.alloc(0))).toString(
    "utf8"
  );
  const env = tryEnvelope(out);
  const parsed = (env && typeof env === "object" ? env : JSON.parse(out)) as {
    data?: unknown;
    keys?: Array<{ domain?: string; name?: string } | string>;
  };
  const fromData = (parsed as { data?: { keys?: unknown } }).data;
  const candidates = [
    parsed.keys,
    (fromData as { keys?: unknown })?.keys,
    Array.isArray(fromData) ? fromData : null,
  ];
  for (const keys of candidates) {
    if (!Array.isArray(keys)) continue;
    return keys.map((k) =>
      typeof k === "string" ? k : String(k.domain ?? k.name ?? k)
    );
  }
  throw new KeyRingError(
    `ring keys returned unparseable output (wallet-cli behaviour change): ${out.slice(0, 200)}`
  );
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

const DEFAULT_WALLET_CLI_TIMEOUT_MS = 60_000;
const DEFAULT_WALLET_CLI_MAX_OUTPUT_BYTES = 1_000_000;
const MAX_WALLET_CLI_TIMEOUT_MS = 120_000;
const MAX_WALLET_CLI_OUTPUT_BYTES = 4_000_000;
const MAX_WALLET_CLI_INPUT_BYTES = 1_000_000;

function boundedSetting(name: string, fallback: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 10 || value > maximum) {
    throw new KeyRingError(`${name} must be an integer from 10 to ${maximum}`);
  }
  return value;
}

function sanitizeDiagnostic(input: string): string {
  let value = input;
  const password = process.env.WALLET_PASS;
  if (password) value = value.split(password).join("[REDACTED_PASSWORD]");
  value = value.replace(/(?:0x)?[a-fA-F0-9]{64}/g, "[REDACTED_32_BYTE_VALUE]");
  value = value.replace(/[A-Za-z0-9+/=_-]{96,}/g, "[REDACTED_LONG_VALUE]");
  return value.slice(0, 4096);
}

function run(args: string[], input: Buffer): Promise<Buffer> {
  if (input.length > MAX_WALLET_CLI_INPUT_BYTES) {
    return Promise.reject(new KeyRingError(`wallet-cli input exceeds the ${MAX_WALLET_CLI_INPUT_BYTES}-byte bound`));
  }
  const timeoutMs = boundedSetting("MANDATE_WALLET_CLI_TIMEOUT_MS", DEFAULT_WALLET_CLI_TIMEOUT_MS, MAX_WALLET_CLI_TIMEOUT_MS);
  const maxOutputBytes = boundedSetting("MANDATE_WALLET_CLI_MAX_OUTPUT_BYTES", DEFAULT_WALLET_CLI_MAX_OUTPUT_BYTES, MAX_WALLET_CLI_OUTPUT_BYTES);
  return new Promise((resolve, reject) => {
    const child = spawn("wallet-cli", args, {
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      // Pass WALLET_PASS through explicitly rather than inheriting the whole
      // environment, so an unrelated leaked variable cannot ride along.
      env: { PATH: process.env.PATH ?? "", WALLET_PASS: process.env.WALLET_PASS ?? "" },
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let totalOutput = 0;
    let settled = false;
    const command = `wallet-cli ${args.slice(0, 2).join(" ")}`;
    const kill = () => {
      if (!child.pid) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch { /* process already exited */ }
      }
    };
    const finishReject = (error: KeyRingError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      kill();
      reject(error);
    };
    const collect = (target: Buffer[], chunk: Buffer) => {
      if (settled) return;
      totalOutput += chunk.length;
      if (totalOutput > maxOutputBytes) {
        finishReject(new KeyRingError(`${command} exceeded the ${maxOutputBytes}-byte output bound`));
        return;
      }
      target.push(Buffer.from(chunk));
    };
    const timer = setTimeout(() => {
      finishReject(new KeyRingError(`${command} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    timer.unref();

    child.stdout.on("data", (chunk: Buffer) => collect(out, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(err, chunk));
    child.stdin.on("error", error => {
      if ((error as NodeJS.ErrnoException).code !== "EPIPE") finishReject(new KeyRingError(`${command} input failed: ${error.message}`));
    });
    child.on("error", error => {
      finishReject(new KeyRingError(`Could not run wallet-cli. Install it with: npm i -g @ledgerhq/wallet-cli (${sanitizeDiagnostic(error.message)})`));
    });
    child.on("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(Buffer.concat(out));
        return;
      }
      reject(new KeyRingError(`${command} exited ${code}`, sanitizeDiagnostic(Buffer.concat(err).toString("utf8")), code ?? undefined));
    });

    if (input.length) child.stdin.write(input);
    child.stdin.end();
  });
}
