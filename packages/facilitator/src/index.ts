/**
 * Mandate's x402 facilitator — self-hosted batch-settlement.
 *
 * We run our own facilitator for the same reason we ship our own paid
 * service: the demo must not depend on a third party's endpoint staying up
 * during judging, and in production a mandate operator runs settlement
 * infrastructure anyway. The scheme logic is x402's own
 * (`@x402/evm/batch-settlement/facilitator`); this file is the HTTP skin
 * plus key custody, speaking exactly the wire format `HTTPFacilitatorClient`
 * expects: GET /supported, POST /verify|/settle with
 * {x402Version, paymentPayload, paymentRequirements}.
 *
 * Networks: `eth_chainId` + `getCode` on the operator RPC, then
 * x402 `.register(caip2, scheme)`. This facilitator settles Base mainnet
 * (`eip155:8453`) only. Native Hedera x402 (`hedera:mainnet`) is a client
 * second rail on the gateway, not an EVM scheme registered here.
 *
 * Keys (sealed in the Key Ring, never on disk or in env):
 * - mandate-facilitator: Base mainnet settlement txs (needs mainnet ETH for gas).
 * - mandate-authorizer: the receiverAuthorizer — signs claim/refund EIP-712
 *   so the paid service doesn't hold a hot claiming key.
 */

import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { x402Facilitator } from "@x402/core/facilitator";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import {
  toFacilitatorEvmSigner,
  BATCH_SETTLEMENT_ADDRESS,
  ERC3009_DEPOSIT_COLLECTOR_ADDRESS,
  PERMIT2_ADDRESS,
  x402UptoPermit2ProxyAddress,
} from "@x402/evm";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/facilitator";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { UptoEvmScheme } from "@x402/evm/upto/facilitator";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { unseal } from "../../gateway/src/keyring.ts";
import { caip2ForChainId, viemChain } from "../../gateway/src/chains.ts";

export const FACILITATOR_NETWORK = "eip155:8453";
export const FACILITATOR_CHAIN_ID = 8453;

export interface FacilitatorCore {
  verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements
  ): Promise<VerifyResponse>;
  settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements
  ): Promise<SettleResponse>;
  getSupported(): {
    kinds: Array<{
      x402Version: number;
      scheme: string;
      network: string;
      extra?: Record<string, unknown>;
    }>;
    extensions: string[];
    signers: Record<string, string[]>;
  };
}

function readJsonBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      chunks.push(c);
      if (Buffer.concat(chunks).length > 1_048_576) {
        reject(new Error("body exceeds 1 MiB"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("malformed JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * The HTTP skin over an x402Facilitator. The core is injected so the wire
 * mapping is unit-testable without chain keys; production passes the real
 * x402Facilitator, which satisfies FacilitatorCore structurally.
 */
export function createApp(core: FacilitatorCore): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/supported") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(core.getSupported()));
        return;
      }
      if (req.method === "POST" && (url.pathname === "/verify" || url.pathname === "/settle")) {
        const body = (await readJsonBody(req)) as {
          paymentPayload?: unknown;
          paymentRequirements?: unknown;
        };
        if (
          typeof body !== "object" ||
          body === null ||
          typeof body.paymentPayload !== "object" ||
          typeof body.paymentRequirements !== "object"
        ) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "body must carry paymentPayload and paymentRequirements" }));
          return;
        }
        const out =
          url.pathname === "/verify"
            ? await core.verify(
                body.paymentPayload as PaymentPayload,
                body.paymentRequirements as PaymentRequirements
              )
            : await core.settle(
                body.paymentPayload as PaymentPayload,
                body.paymentRequirements as PaymentRequirements
              );
        const failed =
          ("isValid" in out && (out as { isValid?: boolean }).isValid === false) ||
          ("success" in out && (out as { success?: boolean }).success === false);
        if (failed) {
          const payload = body.paymentPayload as {
            extensions?: Record<string, { info?: { signature?: string } }>;
          };
          const ext = payload.extensions ?? {};
          const keys = Object.keys(ext);
          const sig = ext.eip2612GasSponsoring?.info?.signature;
          const v = typeof sig === "string" && sig.length >= 2 ? sig.slice(-2) : "none";
          console.error(
            `facilitator ${url.pathname} rejected:`,
            JSON.stringify(out),
            `extensions=[${keys.join(",") || "none"}] eip2612.v=0x${v}`
          );
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
        return;
      }
      res.writeHead(404).end();
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
  });
}

export interface FacilitatorKeys {
  submitter: Buffer;
  authorizer: Buffer;
}

export function wipeKeys(keys: FacilitatorKeys): void {
  keys.submitter.fill(0);
  keys.authorizer.fill(0);
}

/** Key Ring may store a raw 32-byte secret or UTF-8 hex (Hedera ECDSA seal). */
export function ecdsa32(secret: Buffer): Buffer {
  if (secret.length === 32) return secret;
  const utf = secret.toString("utf8").trim().replace(/^0x/i, "");
  if (/^[0-9a-fA-F]{64}$/.test(utf)) return Buffer.from(utf, "hex");
  throw new Error(`unsealed ECDSA key is ${secret.length} bytes, not 32-byte hex`);
}

/**
 * Build the signing core: viem clients over the operator RPC, composed into
 * x402's facilitator signer, with the authorizer key advertised as the
 * receiverAuthorizer servers delegate claiming to.
 */
export async function buildCore(
  rpcUrl: string,
  keys: FacilitatorKeys,
  existing: x402Facilitator = new x402Facilitator()
): Promise<FacilitatorCore> {
  const submitter = privateKeyToAccount(`0x${ecdsa32(keys.submitter).toString("hex")}`);
  const authorizer = privateKeyToAccount(`0x${ecdsa32(keys.authorizer).toString("hex")}`);
  const probe = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await probe.getChainId();
  const network = caip2ForChainId(chainId);
  const chain = viemChain(chainId, rpcUrl);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  // The settlement contracts must exist where we settle. A chain without
  // them would fail per-settlement with opaque reverts — refuse at boot.
  for (const address of [BATCH_SETTLEMENT_ADDRESS, ERC3009_DEPOSIT_COLLECTOR_ADDRESS]) {
    const code = await publicClient.getCode({ address });
    if (!code || code === "0x") {
      throw new Error(`No contract at ${address} on chain ${chainId}; refusing to settle.`);
    }
  }
  const walletClient = createWalletClient({
    account: submitter,
    chain,
    transport: http(rpcUrl),
  });
  const signer = toFacilitatorEvmSigner(
    {
      address: submitter.address,
      // x402UptoPermit2Proxy.settle / settleWithPermit revert UnauthorizedFacilitator
      // unless msg.sender == witness.facilitator. viem eth_call defaults from 0x0,
      // so simulation must set `from` to the submitter or every upto verify
      // collapses into permit2_allowance_required (on-chain allowance is still 0
      // until settleWithPermit actually runs).
      readContract: async (args) => {
        try {
          return await publicClient.readContract({
            ...args,
            account: submitter.address,
          } as never);
        } catch (e) {
          const name = (args as { functionName?: string }).functionName;
          if (name === "settle" || name === "settleWithPermit") {
            const msg =
              e && typeof e === "object" && "shortMessage" in e
                ? String((e as { shortMessage: unknown }).shortMessage)
                : e instanceof Error
                  ? e.message
                  : String(e);
            console.error(`upto ${name} eth_call as ${submitter.address} failed:`, msg);
          }
          throw e;
        }
      },
      verifyTypedData: (args) => publicClient.verifyTypedData(args as never),
      writeContract: (args) =>
        walletClient.writeContract(args as never) as Promise<`0x${string}`>,
      sendTransaction: (args) =>
        walletClient.sendTransaction({ ...args, account: submitter, chain }),
      waitForTransactionReceipt: async (args) => {
        const receipt = await publicClient.waitForTransactionReceipt(args);
        return { status: receipt.status, logs: receipt.logs };
      },
      getCode: (args) => publicClient.getCode(args),
    },
    { confirmationTimeoutMs: 120_000 }
  );
  const scheme = new BatchSettlementEvmScheme(signer, {
    address: authorizer.address,
    signTypedData: (params) =>
      authorizer.signTypedData({
        domain: params.domain,
        types: params.types,
        primaryType: params.primaryType,
        message: params.message,
      } as never) as Promise<`0x${string}`>,
  });
  let facilitator = existing.register(network, scheme).register(network, new ExactEvmScheme(signer));

  const [permit2, uptoProxy] = await Promise.all([
    publicClient.getCode({ address: PERMIT2_ADDRESS }),
    publicClient.getCode({ address: x402UptoPermit2ProxyAddress }),
  ]);
  if (permit2 && permit2 !== "0x" && uptoProxy && uptoProxy !== "0x") {
    facilitator = facilitator
      .register(network, new UptoEvmScheme(signer))
      // Stock x402 keys — advertised on /supported so clients can attach
      // EIP-2612 permits when the payer has no Permit2 allowance (and no ETH).
      .registerExtension({ key: "eip2612GasSponsoring" })
      .registerExtension({ key: "erc20ApprovalGasSponsoring" });
  }
  return facilitator;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const need = (name: string): string => {
    const v = process.env[name];
    if (!v) {
      console.error(`Missing ${name}`);
      process.exit(1);
    }
    return v;
  };
  const root = new URL("../../..", import.meta.url).pathname;
  const keys: FacilitatorKeys = {
    submitter: await unseal(
      "mandate-facilitator",
      await readFile(`${root}/secrets/mandate-facilitator.enc`)
    ),
    authorizer: await unseal(
      "mandate-authorizer",
      await readFile(`${root}/secrets/mandate-authorizer.enc`)
    ),
  };
  try {
    const core = await buildCore(need("MANDATE_EVM_RPC_URL"), keys);
    const port = Number(process.env.FACILITATOR_PORT ?? 8406);
    const host = process.env.FACILITATOR_HOST ?? "127.0.0.1";
    const kinds = core.getSupported().kinds.map((k) => `${k.scheme}@${k.network}`).join(" ");
    createApp(core).listen(port, host, () => {
      console.log(`mandate facilitator on ${host}:${port} (${kinds})`);
    });
  } catch (e) {
    console.error(`Cannot start facilitator: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  } finally {
    // Our buffers are wiped; viem holds string copies until GC (documented
    // keyring caveat — the keys never touch disk, env, or logs).
    wipeKeys(keys);
  }
}
