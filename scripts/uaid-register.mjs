#!/usr/bin/env node
/**
 * HCS-14 UAID registration: derive the operator's deterministic UAID,
 * inscribe the HCS-11 AI-agent profile carrying it, then read the profile
 * back from the account memo and verify the UAID matches.
 *
 * Inscription path (best → fallback):
 *   1. Registry Broker — authenticateWithLedgerCredentials + inscribeViaRegistryBroker
 *      (official HOL path; no tier.bot API key needed)
 *   2. tier.bot / kiloscribe — sealed secrets/tier-api.enc + MANDATE_TIER_API_URL
 *   3. direct HCS — TopicCreate + message submit (testnet fallback when APIs fail)
 *   4. HCS11Client.createAndInscribeProfile — kiloscribe server signature auth
 */

import { readFile } from "node:fs/promises";
import { ensureWalletPass } from "./load-wallet-pass.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const REGISTRY_BROKER_URL =
  process.env.MANDATE_REGISTRY_BROKER_URL?.trim() || "https://hol.org/registry/api/v1";
const TIER_API_URL =
  process.env.MANDATE_TIER_API_URL?.trim() || "https://v2-api.tier.bot/api";

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}`);
    process.exit(1);
  }
  return v;
}

await ensureWalletPass();
const accountId = need("MANDATE_HEDERA_ACCOUNT_ID");
if (!process.env.WALLET_PASS) {
  console.error("WALLET_PASS missing — run npm run device first");
  process.exit(1);
}

const network = process.env.MANDATE_HEDERA_NETWORK ?? "hedera:testnet";
const sdkNetwork =
  network === "hedera:mainnet" ? "mainnet" : network === "hedera:testnet" ? "testnet" : null;
if (!sdkNetwork) {
  console.error(`HCS11Client supports hedera:mainnet/testnet only, got ${network}`);
  process.exit(1);
}

const { deriveOperatorUaid, buildOperatorProfile } = await import(
  `${ROOT}/packages/gateway/src/uaid.ts`
);
const { withSecret } = await import(`${ROOT}/packages/gateway/src/keyring.ts`);
const {
  HCS11Client,
  RegistryBrokerClient,
  inscribeViaRegistryBroker,
  inscribe,
  retrieveInscription,
} = await import("@hashgraphonline/standards-sdk");
const { PrivateKey } = await import("@hiero-ledger/sdk");
const hederaEnc = await readFile(`${ROOT}/secrets/hedera.enc`);

let tierEnc = null;
try {
  tierEnc = await readFile(`${ROOT}/secrets/tier-api.enc`);
} catch {
  /* optional */
}

function profileInput(profile) {
  const profileJson = JSON.stringify(profile);
  const fileName = `profile-${profile.display_name.toLowerCase().replace(/\s+/g, "-")}.json`;
  return {
    type: "buffer",
    buffer: Buffer.from(profileJson, "utf8"),
    fileName,
    mimeType: "application/json",
  };
}

function topicFromInscription(inscription) {
  return (
    inscription?.topicId ??
    inscription?.topic_id ??
    inscription?.jsonTopicId ??
    inscription?.topic?.topicId
  );
}

function mirrorBase(sdkNetwork) {
  return sdkNetwork === "mainnet"
    ? "https://mainnet-public.mirrornode.hedera.com"
    : "https://testnet.mirrornode.hedera.com";
}

async function profileTopicFromAccountMemo(accountId, sdkNetwork) {
  const res = await fetch(`${mirrorBase(sdkNetwork)}/api/v1/accounts/${accountId}`);
  if (!res.ok) return null;
  const data = await res.json();
  const memo = String(data.memo ?? "");
  const m = memo.match(/hcs:\/\/1\/(0\.0\.\d+)/);
  return m?.[1] ?? null;
}

async function readProfileFromMirror(topicId, sdkNetwork) {
  const res = await fetch(
    `${mirrorBase(sdkNetwork)}/api/v1/topics/${topicId}/messages?order=desc&limit=1`
  );
  if (!res.ok) {
    throw new Error(`mirror topic fetch failed: ${res.status}`);
  }
  const data = await res.json();
  const raw = data.messages?.[0]?.message;
  if (!raw) {
    throw new Error("mirror topic has no messages yet");
  }
  return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
}

async function verifyProfileReadback(client, accountId, sdkNetwork, uaid, topicId) {
  const cdn = await client.fetchProfileByAccountId(accountId, sdkNetwork);
  if (cdn.success && cdn.profile?.uaid === uaid) {
    return cdn.profile;
  }
  const mirror = await readProfileFromMirror(topicId, sdkNetwork);
  if (mirror?.uaid !== uaid) {
    throw new Error("profile UAID mismatch on mirror read-back");
  }
  return mirror;
}

async function inscribeViaDirectHcs(profile, accountId, privateKeyHex, sdkNetwork) {
  const { Client, PrivateKey, TopicCreateTransaction, TopicMessageSubmitTransaction } =
    await import("@hiero-ledger/sdk");
  const PK = PrivateKey.fromStringECDSA(privateKeyHex);
  const client =
    sdkNetwork === "mainnet"
      ? Client.forMainnet().setOperator(accountId, PK)
      : Client.forTestnet().setOperator(accountId, PK);
  const profileJson = JSON.stringify(profile);
  try {
    const create = await new TopicCreateTransaction().setTopicMemo("hcs-1:0").execute(client);
    const receipt = await create.getReceipt(client);
    const topicId = receipt.topicId.toString();
    await new TopicMessageSubmitTransaction()
      .setTopicId(topicId)
      .setMessage(profileJson)
      .execute(client);
    return { profileTopicId: topicId };
  } finally {
    await client.close();
  }
}

async function pollTierInscription(txId, retrieveOpts) {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const row = await retrieveInscription(txId, retrieveOpts);
    const status = String(row?.status ?? "").toLowerCase();
    if (status === "completed" || status === "success" || row?.completed) {
      const topicId = topicFromInscription(row);
      if (topicId) return { topicId: String(topicId), transactionId: txId };
    }
    if (status === "failed") {
      throw new Error("tier API inscription failed on server");
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error("tier API inscription timed out waiting for completion");
}

async function brokerSign(privateKeyHex, message) {
  const PK = PrivateKey.fromStringECDSA(privateKeyHex);
  const signature = await PK.sign(Buffer.from(message, "utf8"));
  return {
    signature: Buffer.from(signature).toString("base64"),
    signatureKind: "raw",
    publicKey: PK.publicKey.toString(),
  };
}

async function inscribeViaBroker(profile, privateKeyHex) {
  const broker = new RegistryBrokerClient({ baseUrl: REGISTRY_BROKER_URL });
  const auth = await broker.authenticateWithLedgerCredentials({
    accountId,
    network,
    sign: (message) => brokerSign(privateKeyHex, message),
    expiresInMinutes: 30,
  });
  const result = await inscribeViaRegistryBroker(profileInput(profile), {
    ledgerApiKey: auth.key,
    baseUrl: REGISTRY_BROKER_URL,
    mode: "file",
    waitForConfirmation: true,
    waitTimeoutMs: 10 * 60_000,
    pollIntervalMs: 3000,
  });
  if (!result.confirmed || !result.topicId) {
    throw new Error(result.error ?? "registry broker inscription did not confirm");
  }
  return { profileTopicId: String(result.topicId), transactionId: result.jobId };
}

async function inscribeViaTier(profile, privateKeyHex, apiKey) {
  const PK = PrivateKey.fromStringECDSA(privateKeyHex);
  let response;
  try {
    response = await inscribe(
      profileInput(profile),
      { accountId, privateKey: PK, network: sdkNetwork },
      {
        apiKey,
        baseURL: TIER_API_URL,
        waitForConfirmation: false,
        mode: "file",
        connectionMode: "http",
        network: sdkNetwork,
      }
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const m = msg.match(/Inscription\s+(\S+)\s+did not complete/);
    if (!m) throw e;
    response = { result: { transactionId: m[1] } };
  }
  const txId = response.result?.transactionId ?? response.result?.jobId;
  if (!txId) throw new Error("no transaction id from tier API");
  console.log(`inscription tx submitted: ${txId}`);
  const done = await pollTierInscription(txId, {
    apiKey,
    baseURL: TIER_API_URL,
    network: sdkNetwork,
    accountId,
    privateKey: PK,
  });
  return { profileTopicId: done.topicId, transactionId: done.transactionId };
}

const uaid = await deriveOperatorUaid(accountId, network);
console.log(`operator UAID: ${uaid}`);
const profile = buildOperatorProfile(uaid, accountId);

const existingTopic = await profileTopicFromAccountMemo(accountId, sdkNetwork);
if (existingTopic) {
  try {
    const existing = await readProfileFromMirror(existingTopic, sdkNetwork);
    if (existing?.uaid === uaid) {
      console.log(`profile topic: ${existingTopic} via existing-memo`);
      console.log(`UAID_OK topic=${existingTopic}`);
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(`${ROOT}/.live-results`, { recursive: true });
      await writeFile(
        `${ROOT}/.live-results/uaid-register.txt`,
        JSON.stringify({ ok: true, uaid, topic: existingTopic, path: "existing-memo" }, null, 2) + "\n"
      );
      process.exit(0);
    }
  } catch {
    /* memo present but unreadable — re-inscribe below */
  }
}

await withSecret("hedera-payment", hederaEnc, async (key) => {
  const privateKeyHex = key.toString("utf8").trim().replace(/^0x/, "");
  const client = new HCS11Client({
    network: sdkNetwork,
    auth: { operatorId: accountId, privateKey: privateKeyHex },
    keyType: "ecdsa",
    silent: true,
  });

  let inscribed;
  let path = "registry-broker";
  try {
    inscribed = await inscribeViaBroker(profile, privateKeyHex);
  } catch (brokerErr) {
    const brokerMsg = brokerErr instanceof Error ? brokerErr.message : String(brokerErr);
    console.error(`registry broker path failed: ${brokerMsg}`);
    if (tierEnc) {
      path = "tier-api";
      try {
        await withSecret("tier-api", tierEnc, async (apiBuf) => {
          inscribed = await inscribeViaTier(
            profile,
            privateKeyHex,
            apiBuf.toString("utf8").trim()
          );
        });
      } catch (tierErr) {
        const tierMsg = tierErr instanceof Error ? tierErr.message : String(tierErr);
        console.error(`tier-api path failed: ${tierMsg}`);
        path = "direct-hcs";
        inscribed = await inscribeViaDirectHcs(
          profile,
          accountId,
          privateKeyHex,
          sdkNetwork
        );
      }
    } else {
      try {
        path = "hcs11-signature";
        inscribed = await client.createAndInscribeProfile(profile);
        if (!inscribed?.success) {
          throw new Error(inscribed?.error ?? "HCS11 createAndInscribeProfile failed");
        }
      } catch (sigErr) {
        const sigMsg = sigErr instanceof Error ? sigErr.message : String(sigErr);
        console.error(`hcs11-signature path failed: ${sigMsg}`);
        path = "direct-hcs";
        inscribed = await inscribeViaDirectHcs(
          profile,
          accountId,
          privateKeyHex,
          sdkNetwork
        );
      }
    }
  }

  if (!inscribed?.profileTopicId) {
    console.error("INSCRIBE_FAILED: no profile topic");
    process.exit(1);
  }

  if (path !== "hcs11-signature") {
    const memoResult = await client.updateAccountMemoWithProfile(
      accountId,
      inscribed.profileTopicId
    );
    if (!memoResult.success) {
      console.error(`INSCRIBE_FAILED: ${memoResult.error ?? "account memo update failed"}`);
      process.exit(1);
    }
  }

  console.log(`profile topic: ${inscribed.profileTopicId} via ${path}`);
  if (inscribed.transactionId) {
    console.log(`tx/job: ${inscribed.transactionId}`);
  }

  try {
    await verifyProfileReadback(
      client,
      accountId,
      sdkNetwork,
      uaid,
      inscribed.profileTopicId
    );
  } catch (readErr) {
    console.error(
      `READBACK_FAILED: ${readErr instanceof Error ? readErr.message : readErr}`
    );
    process.exit(1);
  }
  console.log(`UAID_OK topic=${inscribed.profileTopicId}`);
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(`${ROOT}/.live-results`, { recursive: true });
  await writeFile(
    `${ROOT}/.live-results/uaid-register.txt`,
    JSON.stringify(
      {
        ok: true,
        uaid,
        topic: inscribed.profileTopicId,
        path,
        transactionId: inscribed.transactionId ?? null,
      },
      null,
      2
    ) + "\n"
  );
});
