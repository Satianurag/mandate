/**
 * Mandate's x402 facilitator — self-hosted batch-settlement on Base Sepolia.
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
 * Keys (both sealed in the Key Ring, never on disk or in env):
 * - mandate-facilitator: submits settlement transactions (needs testnet ETH).
 * - mandate-authorizer: the receiverAuthorizer — signs claim/refund EIP-712
 *   authorizations so the paid service doesn't hold a hot claiming key.
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
} from "@x402/evm";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/facilitator";
import { createPublicClient, createWalletClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { unseal } from "../../gateway/src/keyring.ts";

export const FACILITATOR_NETWORK = "eip155:84532";
export const FACILITATOR_CHAIN_ID = 84532;

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
          console.error(`facilitator ${url.pathname} rejected:`, JSON.stringify(out));
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

/**
 * Build the signing core: viem clients over the operator RPC, composed into
 * x402's facilitator signer, with the authorizer key advertised as the
 * receiverAuthorizer servers delegate claiming to.
 */
export async function buildCore(rpcUrl: string, keys: FacilitatorKeys): Promise<FacilitatorCore> {
  const submitter = privateKeyToAccount(`0x${keys.submitter.toString("hex")}`);
  const authorizer = privateKeyToAccount(`0x${keys.authorizer.toString("hex")}`);
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
  const chainId = await publicClient.getChainId();
  if (chainId !== FACILITATOR_CHAIN_ID) {
    throw new Error(
      `RPC chain ${chainId} is not Base Sepolia (${FACILITATOR_CHAIN_ID}); refusing to settle.`
    );
  }
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
    chain: baseSepolia,
    transport: http(rpcUrl),
  });
  const signer = toFacilitatorEvmSigner(
    {
      address: submitter.address,
      readContract: (args) => publicClient.readContract(args as never) as Promise<unknown>,
      verifyTypedData: (args) => publicClient.verifyTypedData(args as never),
      writeContract: (args) =>
        walletClient.writeContract(args as never) as Promise<`0x${string}`>,
      sendTransaction: (args) =>
        walletClient.sendTransaction({ ...args, account: submitter, chain: baseSepolia }),
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
  const facilitator = new x402Facilitator().register(FACILITATOR_NETWORK, scheme);
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
    createApp(core).listen(port, host, () => {
      console.log(`mandate facilitator on ${host}:${port} (batch-settlement@${FACILITATOR_NETWORK})`);
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
