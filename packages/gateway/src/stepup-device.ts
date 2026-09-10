/**
 * DMK device step-up — lazy-loaded so tests and headless paths skip native HID.
 */
import { buildStepUpTypedData, formatStepUpMessage } from "./descriptor.ts";
import { formatLedgerError } from "./ledger-errors.ts";
import { awaitDeviceAction, resetDmk, withDeviceSession } from "./dmk-session.ts";
import { buildEthSigner } from "./dmksigner.ts";
import type { PaymentProposal } from "./types.ts";

const DERIVATION_PATH = process.env.MANDATE_LEDGER_PATH ?? "44'/60'/0'/0/0";
const DEVICE_ATTEMPTS = Number(process.env.MANDATE_STEPUP_ATTEMPTS ?? 5);
const RETRY_DELAY_MS = Number(process.env.MANDATE_STEPUP_RETRY_MS ?? 6000);
const DISCOVER_MS = Number(process.env.MANDATE_STEPUP_DISCOVER_MS ?? 12_000);

function isRetryableDeviceError(message: string): boolean {
  return /timed out|no device|unknown error|disconnected|locked|busy|HID|OpenAppCommandError|Device is locked/i.test(
    message
  );
}

function enrichStepUpError(message: string): string {
  if (/6982|Canceled by user|stopped by user/i.test(message)) {
    return `${message} — you rejected on device; tap Approve/Confirm to continue`;
  }
  if (/Unknown application name|6807|OpenAppCommandError/i.test(message)) {
    return (
      `${message} — install/update the Ethereum app in Ledger Wallet → My Ledger, ` +
      `update device OS first, then open Ethereum app on device (or set MANDATE_ETH_APP_OPEN=1)`
    );
  }
  if (/6985|Condition not satisfied|InvalidStatusWord|blind/i.test(message)) {
    return (
      `${message} — Ethereum app → Settings → Blind signing → Enabled, then Approve on screen. ` +
      `See docs/STEPUP.md (interim path until ERC-7730 registry merge).`
    );
  }
  if (/6901|Unexpected device exchange|Device is locked/i.test(message)) {
    return (
      `${message} — enter PIN, keep Ethereum app open, quit Ledger Wallet desktop, retry.`
    );
  }
  return message;
}

export async function signStepUpOnDevice(
  proposal: PaymentProposal,
  reason: string,
  timeoutMs: number
): Promise<void> {
  const mode = (process.env.MANDATE_STEPUP_MODE ?? "clear").toLowerCase();
  if (mode === "clear") {
    return verifyStepUpOnDevice(proposal, reason, timeoutMs);
  }
  return signMessageStepUpOnDevice(proposal, reason, timeoutMs);
}

/** Clear-screen path — verify address on device (no blind signing). Payment context logged first. */
async function verifyStepUpOnDevice(
  proposal: PaymentProposal,
  reason: string,
  timeoutMs: number
): Promise<void> {
  console.error("--- Step-up context (approve on device next) ---");
  console.error(formatStepUpMessage(proposal, reason));
  console.error("--- Confirm your address on the Ledger screen ---\n");

  const skipOpenApp = process.env.MANDATE_ETH_APP_OPEN === "1";
  await runWithRetries(async () => {
    await withDeviceSession(async (sessionId) => {
      const { signer } = await buildEthSigner(sessionId);
      const { observable } = signer.getAddress(DERIVATION_PATH, {
        checkOnDevice: true,
        skipOpenApp,
      });
      await awaitDeviceAction(observable, timeoutMs);
    }, DISCOVER_MS);
  });
}

/** signMessage path — requires blind signing until ERC-7730 registry entry exists. */
async function signMessageStepUpOnDevice(
  proposal: PaymentProposal,
  reason: string,
  timeoutMs: number
): Promise<void> {
  const typedData = buildStepUpTypedData(proposal, reason);
  const skipOpenApp = process.env.MANDATE_ETH_APP_OPEN === "1";

  await runWithRetries(async () => {
    await withDeviceSession(async (sessionId) => {
      const { signer } = await buildEthSigner(sessionId);
      const useEip712 = process.env.MANDATE_STEPUP_EIP712 === "1";
      const { observable } = useEip712
        ? signer.signTypedData(DERIVATION_PATH, typedData, { skipOpenApp })
        : signer.signMessage(DERIVATION_PATH, formatStepUpMessage(proposal, reason), {
            skipOpenApp,
          });
      await awaitDeviceAction(observable, timeoutMs);
    }, DISCOVER_MS);
  });
}

async function runWithRetries(fn: () => Promise<void>): Promise<void> {
  let lastError = "device unavailable";

  for (let attempt = 1; attempt <= DEVICE_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      console.error(`step-up retry ${attempt}/${DEVICE_ATTEMPTS} — unlock device / approve on screen…`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }

    try {
      await fn();
      return;
    } catch (e) {
      lastError = formatLedgerError(e);
      if (attempt < DEVICE_ATTEMPTS && isRetryableDeviceError(lastError)) {
        continue;
      }
      throw new Error(enrichStepUpError(lastError));
    } finally {
      resetDmk();
    }
  }

  throw new Error(lastError);
}
