#!/usr/bin/env node
/**
 * Unpaid inspect + Vertex plan + x402 probe. Never signs, verifies, or settles.
 */
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { inspectSetup } from '../../packages/gateway/src/workspace-setup.ts';
import { ExactAgentExecutor, EXACT_USDC } from '../../packages/gateway/src/agent-exact.ts';
import { VertexAgentModel } from '../../packages/gateway/src/agent-model.ts';
import { previewAgentPlan } from '../../packages/gateway/src/agent-plan.ts';
import { Journal } from '../../packages/gateway/src/journal.ts';
import { createAgentTools } from '../../packages/gateway/src/agent-tools.ts';
import { DEFAULT_FACILITATOR_URL } from '../../packages/gateway/src/facilitators.ts';
const FACILITATOR = process.env.MANDATE_FACILITATOR_URL?.trim() || DEFAULT_FACILITATOR_URL;
const USDC = EXACT_USDC['eip155:8453'];
const report = {
  ok: false,
  paymentMade: false,
  signed: false,
  settled: false,
  facilitator: FACILITATOR,
  inspect: null,
  plan: null,
  error: null,
};

let secret = '';
try {
  const inspected = await inspectSetup({
    vertex: { project: 'project-028d7846-2659-4a57-af2', location: 'global', model: 'gemini-3.5-flash' },
    payerAddress: '',
    rpcUrl: 'https://mainnet.base.org',
    facilitatorUrl: FACILITATOR,
    ceilingBaseUnits: '250000',
    perCallBaseUnits: '20000',
    windowBaseUnits: '100000',
    windowMs: 3600000,
    durationHours: 24,
    ringKey: 'mandate-session',
    toolIds: ['web-search', 'crypto-news', 'crypto-prices'],
  });
  if (inspected.paymentMade !== false) throw new Error('inspect claimed a payment');
  report.inspect = {
    network: inspected.network,
    paymentMade: inspected.paymentMade,
    services: inspected.services.map((s) => ({ id: s.id, origin: s.origin, amountBaseUnits: s.amountBaseUnits, payTo: s.payTo })),
  };

  secret = generatePrivateKey();
  const account = privateKeyToAccount(secret);
  const journal = new Journal(':memory:');
  const executor = new ExactAgentExecutor({
    authority: {
      id: 'unpaid-preview',
      network: 'eip155:8453',
      asset: USDC,
      payerAddress: '0x57a2a47Ca22AE52867c5313c4d9ab43070D7C202',
      spendingAddress: account.address,
      expiresAt: Date.now() + 24 * 3600000,
      ceilingBaseUnits: '250000',
      perCallBaseUnits: '20000',
      windowBaseUnits: '100000',
      windowMs: 3600000,
      tools: inspected.services.map((s) => ({ id: s.id, origin: s.origin, pathname: s.pathname, payTo: s.payTo })),
    },
    journal,
    tools: createAgentTools(),
    signer: {
      address: account.address,
      signTypedData: async () => {
        throw new Error('unpaid probe does not sign');
      },
    },
    verify: async () => {
      throw new Error('unpaid probe does not verify settlement');
    },
  });
  const now = Date.now();
  const agent = {
    id: 'unpaid-preview',
    version: 1,
    template: false,
    name: 'Unpaid preview',
    description: 'Live unpaid plan and probe',
    instructions: 'Use only the supplied tools. Prefer crypto-prices for a ticker. Do not invent URLs or tool IDs.',
    goal: '',
    output: 'A sourced BTC price or a short statement of what the approved tools can show, with limitations.',
    toolIds: ['crypto-prices', 'web-search', 'crypto-news'],
    budgetBaseUnits: '100000',
    perCallBaseUnits: '20000',
    maxSteps: 8,
    maxDurationSeconds: 120,
  };
  const goal = 'Report the current BTC spot price using the approved price tool and name the source.';
  const plan = await previewAgentPlan(
    new VertexAgentModel({ project: 'project-028d7846-2659-4a57-af2', location: 'global', model: 'gemini-3.5-flash' }),
    executor,
    {
      id: 'unpaid-preview-run',
      agent,
      goal,
      authorityId: 'unpaid-preview',
      intentHash: 'preview',
      state: 'queued',
      createdAt: now,
      updatedAt: now,
      deadline: now + 120000,
      result: null,
      error: null,
    },
    AbortSignal.timeout(240000),
  );
  report.plan = {
    reasoning: plan.reasoning,
    steps: plan.steps.map((s, i) => ({ toolId: s.toolId, reason: s.reason, price: plan.stepPrices[i] })),
    estimatedBaseUnits: plan.estimatedBaseUnits,
    billedThroughX402: plan.modelUsage?.billedThroughX402 === true,
    model: plan.modelUsage?.model,
    phase: plan.modelUsage?.phase,
  };
  if (report.plan.billedThroughX402) throw new Error('plan claimed x402 billing');
  journal.close();
  report.ok = true;
} catch (e) {
  report.error = e instanceof Error ? e.message : String(e);
} finally {
  if (secret) secret = '';
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
