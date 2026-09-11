'use strict';

const $ = id => document.getElementById(id);
const PENDING_TASK_KEY = 'mandate.pending-task.v1';
const TERMINAL_TASK_STATES = new Set(['succeeded', 'failed', 'blocked', 'reconciled', 'cancelled']);
const TERMINAL_MANDATE_STATES = new Set(['refunded', 'closed']);
let csrf = '';
let current = null;
let fingerprint = '';
let selectedTask = null;
let refreshTimer = null;
let clockTimer = null;
let researchSources = [];

const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const pretty = value => JSON.stringify(value, null, 2);
const when = value => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const readable = state => String(state ?? 'unknown').replaceAll('_', ' ');
const sourceLabel = chain => ({
  'base-sepolia': 'Base Sepolia',
  'ethereum-sepolia': 'Ethereum Sepolia',
  'bsc-chapel': 'BNB Smart Chain Chapel',
  'monad-testnet': 'Monad Testnet',
})[chain] || readable(chain);

function units(value) {
  const n = BigInt(value ?? '0');
  const whole = n / 1000000n;
  const fraction = String(n % 1000000n).padStart(6, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}`;
}
function baseUnits(value) {
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value)) throw new Error('Use a non-negative decimal amount with at most six places.');
  const [whole, fraction = ''] = value.split('.');
  return String(BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0')));
}
function badge(text, type = 'neutral') { return el('span', text, `badge ${type}`); }
function message(text, error = false) {
  $('globalMessage').textContent = text;
  $('globalMessage').className = `message${error ? ' error' : ''}`;
  $('globalMessage').hidden = !text;
}
async function api(path, body, method) {
  const init = {
    method: method || (body === undefined ? 'GET' : 'POST'),
    credentials: 'same-origin',
    headers: {},
    signal: AbortSignal.timeout(45000),
  };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (csrf) init.headers['x-mandate-csrf'] = csrf;
  const response = await fetch(path, init);
  const text = await response.text();
  let result;
  try { result = JSON.parse(text); } catch { result = { error: text || `HTTP ${response.status}` }; }
  if (!response.ok) {
    const error = new Error(result.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return result;
}
function showLogin(error = '') {
  current = null;
  csrf = '';
  $('workspace').hidden = true;
  $('loginPanel').hidden = false;
  $('logout').hidden = true;
  $('connectionDot').className = 'dot';
  $('connectionText').textContent = 'Operator session required';
  $('loginError').textContent = error;
}
async function connect(token) {
  const session = await api('/api/session', { token });
  csrf = session.csrf;
  $('token').value = '';
  await refresh(true);
}
function statusType(state) {
  return ['succeeded', 'confirmed', 'funded', 'refunded', 'reconciled', 'closed'].includes(state) ? 'success'
    : ['failed', 'stopped', 'denied', 'blocked', 'expired'].includes(state) ? 'error'
      : ['uncertain', 'interrupted', 'pending', 'running', 'queued', 'awaiting_device', 'awaiting_signature', 'funding_pending'].includes(state) ? 'warning'
        : 'neutral';
}

function readPendingIntent() {
  let raw;
  try { raw = localStorage.getItem(PENDING_TASK_KEY); } catch { return null; }
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (value?.version !== 1 || !/^[A-Za-z0-9_-]{8,128}$/.test(value.requestId || '') || !value.payload?.task) throw new Error();
    return value;
  } catch {
    try { localStorage.removeItem(PENDING_TASK_KEY); } catch { /* unavailable storage */ }
    return null;
  }
}
function persistPendingIntent(value) {
  const serialized = JSON.stringify(value);
  try {
    localStorage.setItem(PENDING_TASK_KEY, serialized);
    if (localStorage.getItem(PENDING_TASK_KEY) !== serialized) throw new Error();
  } catch {
    throw new Error('This browser cannot durably save the paid request ID. No task was submitted because a lost response could otherwise cause a duplicate charge.');
  }
}
function clearPendingIntent(requestId) {
  const pending = readPendingIntent();
  if (!pending || (requestId && pending.requestId !== requestId)) return;
  try { localStorage.removeItem(PENDING_TASK_KEY); } catch { /* already unusable */ }
}
function syncPendingIntent(state) {
  const pending = readPendingIntent();
  const notice = $('pendingIntent');
  if (!pending) { notice.hidden = true; return null; }
  const task = state?.tasks?.find(item => item.id === pending.requestId);
  if (task && TERMINAL_TASK_STATES.has(task.state)) {
    clearPendingIntent(pending.requestId);
    notice.hidden = true;
    return null;
  }
  notice.hidden = false;
  const ageMinutes = Math.max(0, Math.floor((Date.now() - pending.createdAt) / 60000));
  $('pendingIntentText').textContent = task
    ? `Request ${pending.requestId} is ${readable(task.state)}. Observe or reconcile this exact task before starting another paid run.`
    : `Request ${pending.requestId} was saved ${ageMinutes} min ago, but server acceptance is not yet known. Check the same ID before retrying.`;
  return pending;
}
function selectedResearchTask() {
  const base = current?.defaultTask;
  if (!base || !current?.config?.researchSource) throw new Error('Create a source-bound Mandate before running paid research.');
  const maxResults = Number($('maxResults').value);
  if (!Number.isInteger(maxResults) || maxResults < 2 || maxResults > 10) throw new Error('Choose between 2 and 10 candidates.');
  return { version: 1, template: 'agent0-due-diligence', source: { ...base.source }, maxResults };
}

function appendDefinition(container, term, value) {
  const item = el('div');
  item.append(el('span', term), el('strong', value));
  container.append(item);
}
function renderTaskDefinition(state) {
  const root = $('taskDefinition');
  root.replaceChildren();
  if (!state.config?.researchSource) {
    appendDefinition(root, 'Task', 'Compare Agent0 service registrations');
    appendDefinition(root, 'Research source', 'Create a new source-bound Mandate');
    return;
  }
  appendDefinition(root, 'Task', 'Evidence-based Agent0 due diligence');
  appendDefinition(root, 'Research source', `${sourceLabel(state.config.researchSource.chain)} · ${state.config.researchSource.deployment}`);
  const mandateKey = state.config.salt;
  if ($('maxResults').dataset.mandate !== mandateKey) {
    $('maxResults').dataset.mandate = mandateKey;
    $('maxResults').value = String(state.defaultTask?.maxResults ?? 5);
  }
}
function appendFact(root, term, value) {
  const item = el('div');
  item.append(el('dt', term), el('dd', value));
  root.append(item);
}

function renderBrief(container, result) {
  const brief = result.brief;
  const recommendation = brief.recommendation;
  const hero = el('section', undefined, `result-hero ${recommendation.status === 'best_supported_record' ? 'supported' : 'insufficient'}`);
  hero.append(el('span', recommendation.status === 'best_supported_record' ? 'BEST-SUPPORTED RECORD' : 'INSUFFICIENT EVIDENCE', 'eyebrow'));
  hero.append(el('h4', recommendation.registration || 'No candidate selected'));
  if (recommendation.wallet) hero.append(el('code', recommendation.wallet, 'address result-address'));
  hero.append(el('p', recommendation.basis, 'result-note'));
  container.append(hero);

  if (Array.isArray(brief.candidates) && brief.candidates.length) {
    const title = el('div', undefined, 'section-title');
    title.append(el('h4', 'Evidence comparison'), el('span', `${brief.candidates.length} registrations`, 'subtle'));
    container.append(title);
    const wrap = el('div', undefined, 'table-scroll');
    const table = el('table');
    const head = el('tr');
    ['Registration', 'Service wallet', 'Indexed feedback', 'Recent sample'].forEach(text => head.append(el('th', text)));
    table.append(head);
    for (const candidate of brief.candidates) {
      const row = el('tr');
      row.append(
        el('td', candidate.registration),
        el('td', candidate.wallet || 'Not available', 'address'),
        el('td', candidate.indexedFeedback ?? 'Not available'),
        el('td', `${candidate.activeSampledFeedback} active / ${candidate.revokedSampledFeedback} revoked`),
      );
      table.append(row);
    }
    wrap.append(table);
    container.append(wrap);
  }

  const limitations = el('section', undefined, 'result-section');
  limitations.append(el('h4', 'What this evidence cannot prove'));
  const list = el('ul');
  for (const item of brief.limitations || []) list.append(el('li', item));
  limitations.append(list);
  container.append(limitations);

  const proof = el('section', undefined, 'result-proof-grid');
  const provenance = el('div');
  provenance.append(el('span', 'SOURCE PROVENANCE', 'eyebrow'));
  provenance.append(el('strong', sourceLabel(brief.provenance.chain)));
  provenance.append(el('p', `Deployment ${brief.provenance.deployment}`, 'address result-note'));
  provenance.append(el('p', `Block ${brief.provenance.blockNumber ?? 'not reported'} · observed ${when(brief.provenance.observedAt)}`, 'result-note'));
  const accounting = el('div');
  accounting.append(el('span', 'MANDATE ACCOUNTING', 'eyebrow'));
  accounting.append(el('strong', `${units(brief.accounting.acceptedCostBaseUnits)} USDC accepted`));
  accounting.append(el('p', `${units(brief.accounting.remainingAuthorityBaseUnits)} USDC authority remains · ${brief.accounting.paidCalls} paid call`, 'result-note'));
  proof.append(provenance, accounting);
  container.append(proof);
}
function renderResult(task) {
  const container = $('result');
  container.replaceChildren();
  if (!task) {
    container.append(el('div', 'No successful paid result exists yet. Run a task to obtain live, sourced evidence.', 'empty'));
    $('resultSource').textContent = 'No paid result yet';
    return;
  }
  $('resultSource').textContent = `${task.kind === 'refund' ? 'Recovery' : task.kind === 'query' ? 'Research task' : readable(task.kind)} · ${when(task.updated_at)}`;
  if (task.error) container.append(el('p', task.error, 'result-error'));
  if (!task.result) {
    if (!task.error) container.append(el('div', `Task ${readable(task.state)}. Device approval and payment confirmation cannot be simulated.`, 'empty'));
    return;
  }
  let result;
  try { result = JSON.parse(task.result); } catch { container.append(el('pre', task.result)); return; }
  if (result.schemaVersion === 1 && result.brief) {
    renderBrief(container, result);
  } else {
    const body = result.data || result;
    if (body.source) {
      container.append(el('p', `Source: ${body.source.chain} · ${body.source.subgraphId}`, 'result-note'));
      if (body.observedAt) container.append(el('p', `Observed ${when(body.observedAt)}.`, 'result-note'));
    }
    if (Array.isArray(body.rows)) {
      if (!body.rows.length) container.append(el('div', 'The live query returned no matching agent registrations.', 'empty'));
      else {
        const wrap = el('div', undefined, 'table-scroll');
        const table = el('table');
        const head = el('tr');
        ['Registration', 'Agent wallet', 'Indexed feedback'].forEach(text => head.append(el('th', text)));
        table.append(head);
        for (const row of body.rows) {
          const tr = el('tr');
          tr.append(el('td', row.agentId ?? row.id ?? 'Not selected'), el('td', row.agentWallet ?? 'Not selected', 'address'), el('td', row.totalFeedback ?? 'Not selected'));
          table.append(tr);
        }
        wrap.append(table);
        container.append(wrap);
      }
      container.append(el('p', 'Legacy result: feedback counts and raw measurements are not comparable reputation ratings or permission to spend.', 'result-note'));
    }
    if (body.paid) container.append(el('p', `Payment stage: ${readable(body.paid.stage || 'receipt available')} · ${body.paid.amountBaseUnits ?? body.paid.amount} base units · ${body.paid.network || ''}`, 'result-note'));
  }
  const detail = el('details');
  detail.append(el('summary', 'Inspect complete evidence and payment receipt'), el('pre', pretty(result)));
  container.append(detail);
}
function renderHistory(tasks, historicalTaskCount = 0) {
  const root = $('history');
  root.replaceChildren();
  if (!tasks.length) {
    const suffix = historicalTaskCount > 0 ? ` ${historicalTaskCount} task${historicalTaskCount === 1 ? '' : 's'} from prior Mandates remain preserved outside this workspace.` : '';
    root.append(el('p', `No task has been submitted for this Mandate.${suffix}`, 'empty-inline'));
    return;
  }
  const table = el('table');
  const head = el('tr');
  ['Task / request ID', 'State', 'Updated', 'Result'].forEach(text => head.append(el('th', text)));
  table.append(head);
  for (const task of tasks) {
    const row = el('tr');
    const id = el('td');
    const title = ({ refund: 'Remaining-funds recovery', settlement: 'Merchant claim and settlement', evidence: 'HCS evidence publication', query: 'Agent0 due diligence' })[task.kind] || readable(task.kind);
    id.append(el('strong', title), el('div', task.id, 'event-meta'));
    if (task.task?.source) id.append(el('div', `${sourceLabel(task.task.source.chain)} · ${task.task.maxResults} candidates`, 'event-meta'));
    const state = el('td');
    state.append(badge(readable(task.state), statusType(task.state)));
    const action = el('td');
    const button = el('button', 'Inspect', 'text-button');
    button.type = 'button';
    button.addEventListener('click', () => {
      selectedTask = task.id;
      renderResult(task);
      $('result').scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    action.append(button);
    row.append(id, state, el('td', when(task.updated_at)), action);
    table.append(row);
  }
  root.append(table);
  if (historicalTaskCount > 0) root.append(el('p', `Showing this Mandate only. ${historicalTaskCount} prior task${historicalTaskCount === 1 ? '' : 's'} remain preserved.`, 'subtle history-scope'));
}
function renderEvidence(events) {
  const root = $('evidence');
  root.replaceChildren();
  if (!events.length) { root.append(el('p', 'No execution events have been recorded.', 'empty-inline')); return; }
  for (const event of events.slice(0, 25)) {
    const row = el('div', undefined, 'event');
    const main = el('div');
    main.append(el('div', event.kind, 'event-title'), el('div', `${when(event.created_at)} · ${event.request_id || event.mandate_id}`, 'event-meta'));
    const details = el('details');
    details.append(el('summary', 'Inspect durable event'), el('pre', pretty({
      id: event.id,
      hash: event.hash,
      previousHash: event.previous_hash,
      data: JSON.parse(event.data),
      hcsState: event.anchor_state,
      receipt: event.receipt ? JSON.parse(event.receipt) : null,
      anchoringError: event.error || null,
    })));
    main.append(details);
    row.append(el('span', undefined, 'event-marker'), main, badge(event.anchor_state === 'confirmed' ? 'HCS confirmed' : `HCS ${event.anchor_state || 'pending'}`, statusType(event.anchor_state || 'pending')));
    root.append(row);
  }
}
function mandateStatus(state) {
  const cfg = state.config;
  const finance = state.financial;
  if (!cfg) return 'Not configured';
  if (finance?.state === 'closed') return 'Closed';
  if (finance?.state === 'refunded') return 'Refunded';
  if (finance?.state === 'stopped') return 'Stopped';
  if (Date.parse(cfg.expiresAt) <= Date.now()) return 'Expired';
  if (finance?.deposit === 'funded') return 'Funded';
  if (finance?.deposit === 'pending') return 'Funding pending';
  return 'Not funded';
}
function updateActionAvailability(state = current) {
  if (!state) return;
  const cfg = state.config;
  const finance = state.financial;
  const expired = cfg ? Date.parse(cfg.expiresAt) <= Date.now() : false;
  const terminal = TERMINAL_MANDATE_STATES.has(finance?.state);
  const pending = readPendingIntent();
  const sourceBound = Boolean(cfg?.researchSource && state.defaultTask);
  const remaining = cfg && finance ? BigInt(cfg.ceilingBaseUnits) - BigInt(finance.spent || '0') - BigInt(finance.reserved || '0') : 0n;
  const authorityAtCapacity = Boolean(cfg && finance && remaining <= 0n);
  const blocked = !cfg || terminal || finance?.state === 'stopped' || expired || !sourceBound || authorityAtCapacity;
  $('runTask').disabled = blocked || Boolean(pending);
  $('runTask').title = pending
    ? 'Observe the existing paid intent before starting another.'
    : authorityAtCapacity
      ? 'No lifetime authority remains. Settle and close this Mandate before creating another.'
      : blocked ? 'This Mandate cannot authorize a new source-bound task.' : '';
  $('fundingConsent').hidden = !cfg || finance?.deposit === 'funded' || terminal;
  $('taskHint').textContent = !cfg ? 'Review a Mandate before running paid work.'
    : !sourceBound ? 'Legacy authority is recoverable, but new research requires an explicitly bound source.'
      : pending ? 'An earlier request ID must be observed before another paid run.'
        : terminal || finance?.state === 'stopped' ? 'This Mandate cannot authorize new work.'
          : expired ? 'Permission expired. Existing receipts remain recoverable.'
            : authorityAtCapacity
              ? BigInt(finance?.reserved || '0') > 0n
                ? 'All remaining authority is reserved. Observe or reconcile the current request before retrying.'
                : 'Lifetime authority exhausted. Settle and close this Mandate, then create a fresh one.'
              : finance?.deposit === 'funded' ? 'Uses the existing funded channel; no new deposit authority.'
                : 'The first paid task requires explicit Ledger funding approval.';
  const status = mandateStatus(state);
  const configure = $('configure');
  configure.textContent = terminal ? 'Create new Mandate' : 'Review authority';
  configure.title = terminal ? `The current Mandate is ${readable(finance.state)}. A fresh Mandate starts unfunded with a new salt and separately reviewed authority.` : 'Review the exact source, service and spending authority before funding.';

  $('stop').disabled = !cfg || terminal || finance?.state === 'stopped';
  $('stop').title = !cfg ? 'Review a Mandate first.' : terminal ? `The Mandate is already ${readable(finance.state)}.` : finance?.state === 'stopped' ? 'New work is already stopped.' : '';
  $('refund').disabled = !cfg || !finance?.channelId || terminal || remaining <= 0n;
  $('refund').title = !cfg || !finance?.channelId ? 'A confirmed funded channel is required.' : terminal ? `The Mandate is already ${readable(finance.state)}.` : remaining <= 0n ? 'No unspent authority remains to refund.' : '';
  $('closeMandate').disabled = !cfg || !finance?.channelId || terminal || BigInt(finance?.reserved || '0') !== 0n || BigInt(finance?.spent || '0') !== BigInt(cfg.ceilingBaseUnits);
  $('closeMandate').title = terminal ? `The Mandate is already ${readable(finance.state)}.` : !cfg || !finance?.channelId ? 'A confirmed funded channel is required.' : BigInt(finance?.reserved || '0') !== 0n ? 'Resolve reserved or uncertain payments first.' : BigInt(finance?.spent || '0') !== BigInt(cfg.ceilingBaseUnits) ? 'Only a fully spent Mandate can close without a refund.' : '';
  $('delegate').disabled = !sourceBound || finance?.deposit !== 'funded' || finance?.state !== 'active' || expired;
  $('delegate').title = terminal ? `The Mandate is already ${readable(finance.state)}.` : !sourceBound ? 'A source-bound research Mandate is required.' : finance?.deposit !== 'funded' ? 'Confirm Ledger-funded authority first.' : finance?.state !== 'active' ? 'The Mandate is not active.' : expired ? 'The permission has expired.' : '';
  $('reconcile').disabled = !finance?.channelId;
  $('reconcile').title = finance?.channelId ? 'Read existing channel and receipt state without creating another payment.' : 'No channel exists to reconcile.';
  const settleReason = !state.merchantLifecycleAvailable ? 'The configured merchant lifecycle is unavailable.'
    : !finance?.channelId || finance?.deposit !== 'funded' ? 'A confirmed funded channel is required.'
      : terminal ? `The Mandate is already ${readable(finance.state)}; no merchant settlement action is available.`
        : BigInt(finance?.spent || '0') === 0n ? 'No accepted payment liability exists to claim or settle.' : '';
  $('settle').disabled = Boolean(settleReason);
  $('settle').title = settleReason;
  $('publishEvidence').disabled = !state.hcsConfigured || !state.evidencePublication || state.evidencePublication.plannedRecords === 0;
  $('authorityHint').textContent = terminal
    ? `This Mandate is ${readable(finance.state)}. No new work, settlement, closure or second refund is available. Create a fresh Mandate for another run.`
    : finance?.state === 'stopped'
      ? 'New work and delegated access are stopped. Existing liabilities can still be reconciled, merchant revenue settled, and eligible funds recovered.'
      : expired
        ? 'Permission has expired. New work is blocked; existing receipts, settlement and recovery remain available.'
        : 'Stop blocks future requests and revokes agent access. It does not reverse accepted payments. Closure and refund are separate verified terminal flows.';
  $('mandateStatus').textContent = status;
  $('mandateStatus').className = `badge ${statusType(status.toLowerCase().replaceAll(' ', '_'))}`;
}
function render(state) {
  const cfg = state.config;
  const finance = state.financial;
  const tasks = state.tasks;
  $('loginPanel').hidden = true;
  $('workspace').hidden = false;
  $('logout').hidden = false;
  $('legacyWarning').hidden = !state.legacy && Boolean(cfg?.researchSource);
  if (state.legacy) $('legacyWarning').textContent = state.legacy.message;
  else if (cfg && !cfg.researchSource) $('legacyWarning').textContent = 'This legacy v2 Mandate remains available for reconciliation and recovery, but new paid research is blocked until a fresh source-bound Mandate is reviewed.';

  $('capLabel').textContent = finance?.deposit === 'funded' ? 'Confirmed funding ceiling' : 'Configured ceiling';
  $('cap').textContent = cfg ? `${units(cfg.ceilingBaseUnits)} USDC` : 'Not configured';
  $('spent').textContent = finance ? `${units(finance.spent)} USDC` : '—';
  $('reserved').textContent = finance ? `${units(finance.reserved)} USDC` : '—';
  if (finance?.state === 'refunded') $('remaining').textContent = `${units(finance.refundedBaseUnits)} USDC returned`;
  else if (finance?.state === 'closed') $('remaining').textContent = '0 USDC · closed';
  else if (finance?.deposit !== 'funded') $('remaining').textContent = 'Not funded';
  else if (finance && cfg) {
    const remaining = BigInt(cfg.ceilingBaseUnits) - BigInt(finance.spent) - BigInt(finance.reserved);
    $('remaining').textContent = `${units(String(remaining > 0n ? remaining : 0n))} USDC`;
  } else $('remaining').textContent = '—';

  const facts = $('authorityFields');
  facts.replaceChildren();
  if (cfg) {
    appendFact(facts, 'Payment network', `${cfg.network} · Base Sepolia testnet`);
    appendFact(facts, 'Research network', cfg.researchSource ? sourceLabel(cfg.researchSource.chain) : 'Not bound (legacy)');
    appendFact(facts, 'Research deployment', cfg.researchSource?.deployment || 'Not bound (new work blocked)');
    appendFact(facts, 'Paid service', cfg.serviceUrl);
    appendFact(facts, 'Merchant receiver', cfg.receiver);
    appendFact(facts, 'Per-call maximum', `${units(cfg.perCallBaseUnits)} USDC`);
    appendFact(facts, 'Rolling budget', `${units(cfg.windowBaseUnits)} USDC / ${cfg.windowMs / 60000} min`);
    appendFact(facts, 'Permission expires', when(cfg.expiresAt));
    appendFact(facts, 'Ledger payer', cfg.operatorAddress);
    appendFact(facts, 'Channel', finance?.channelId || 'No channel established');
  } else {
    appendFact(facts, 'Spending authority', 'No reviewed Mandate');
    appendFact(facts, 'Signing', 'Not requested');
    appendFact(facts, 'Next step', 'Review authority and verify live dependencies');
  }

  renderTaskDefinition(state);
  const latest = tasks.find(task => task.kind === 'query') || tasks[0];
  $('taskStatus').textContent = latest ? readable(latest.state) : 'No task yet';
  $('taskStatus').className = `badge ${statusType(latest?.state)}`;
  renderHistory(tasks, state.historicalTaskCount || 0);
  renderResult(tasks.find(task => task.id === selectedTask) || tasks.find(task => task.kind === 'query' && task.state === 'succeeded') || latest);
  const events = [...state.events, ...(finance?.events || []), ...(state.merchantEvidence?.events || [])].sort((a, b) => b.created_at - a.created_at);
  renderEvidence(events);
  const valid = state.eventChainValid && finance?.eventChainValid !== false && state.merchantEvidence?.eventChainValid !== false;
  $('chainIntegrity').textContent = valid ? 'Local hash chain verified' : 'Integrity check failed';
  $('chainIntegrity').className = `badge ${valid ? 'success' : 'error'}`;
  const publication = state.evidencePublication;
  $('anchorHint').textContent = !state.hcsConfigured
    ? 'HCS publisher is not configured. Pending evidence stays local and is not reported as confirmed.'
    : !publication || publication.plannedRecords === 0
      ? 'No pending evidence records are available for publication.'
      : `${publication.pendingRecords} pending records. This action will attempt exactly ${publication.plannedRecords}, capped at ${publication.maxRecordsPerAction} across all journals, with up to ${publication.estimatedSubmissions} Hedera testnet submissions. Configured transaction-fee cap: ${publication.perRecordMaxTransactionFeeHbar} HBAR each, ${publication.worstCaseConfiguredMaxFeeHbar} HBAR combined.`;
  syncPendingIntent(state);
  updateActionAvailability(state);
}
async function refresh(force = false) {
  try {
    const state = await api('/api/state');
    current = state;
    csrf = state.csrf;
    $('connectionDot').className = 'dot connected';
    $('connectionText').textContent = 'Connected to local broker';
    $('observedAt').textContent = `State checked ${when(state.observedAt)}`;
    const next = JSON.stringify([state.config, state.financial, state.tasks, state.events, state.merchantEvidence, state.legacy, state.defaultTask]);
    if (force || next !== fingerprint) {
      fingerprint = next;
      render(state);
    } else {
      syncPendingIntent(state);
      updateActionAvailability(state);
    }
  } catch (error) {
    if (error.status === 401) showLogin();
    else {
      $('connectionDot').className = 'dot';
      $('connectionText').textContent = 'Broker unavailable';
      message(`Live state unavailable: ${error.message}`, true);
      $('runTask').disabled = true;
      updateActionAvailability(current);
    }
  }
}

function setSourceOptions(sources, selected) {
  researchSources = sources;
  const select = $('researchSource');
  select.replaceChildren(new Option('Choose a verified Agent0 deployment', ''));
  for (const source of sources) {
    const option = new Option(`${sourceLabel(source.chain)} · ${source.deployment.slice(0, 10)}…${source.deployment.slice(-6)}`, source.chain);
    option.dataset.deployment = source.deployment;
    select.append(option);
  }
  const match = selected && sources.find(source => source.chain === selected.chain && source.deployment === selected.deployment);
  if (match) select.value = match.chain;
  updateResearchSourceDetail();
}
function updateResearchSourceDetail() {
  const selected = researchSources.find(source => source.chain === $('researchSource').value);
  $('researchSourceDetail').textContent = selected
    ? `Exact deployment ${selected.deployment}. Payment remains on Base Sepolia; this source cannot silently fail over to another chain.`
    : 'Payment stays on Base Sepolia. Verify live sources, then bind the data chain and exact subgraph deployment.';
}
async function loadResearchSources() {
  const button = $('loadSources');
  button.disabled = true;
  $('configError').textContent = 'Verifying current Agent0 testnet deployments. No payment or signature is requested.';
  try {
    const result = await api('/api/research/sources');
    setSourceOptions(result.sources || [], current?.config?.researchSource);
    $('configError').textContent = `Verified ${result.sources.length} source${result.sources.length === 1 ? '' : 's'} at ${when(result.observedAt)}. Select the exact deployment to review.`;
  } catch (error) {
    $('configError').textContent = error.message;
  } finally { button.disabled = false; }
}
function fillConfig() {
  const cfg = current?.config;
  const legacy = current?.legacy;
  for (const id of ['operatorAddress', 'rpcUrl', 'serviceUrl', 'asset', 'receiver', 'receiverAuthorizer', 'withdrawDelay', 'sessionKey']) {
    if (cfg?.[id] !== undefined) $(id).value = cfg[id];
  }
  if (!cfg && legacy) for (const id of ['rpcUrl', 'serviceUrl', 'receiver']) if (legacy[id]) $(id).value = legacy[id];
  $('ceilingInput').value = units(cfg?.ceilingBaseUnits || '100000');
  $('perCallInput').value = units(cfg?.perCallBaseUnits || '10000');
  $('windowInput').value = units(cfg?.windowBaseUnits || '30000');
  $('windowMinutes').value = String((cfg?.windowMs || 3600000) / 60000);
  const terminal = cfg && TERMINAL_MANDATE_STATES.has(current?.financial?.state);
  const date = cfg && !terminal ? new Date(cfg.expiresAt) : new Date(Date.now() + 3600000);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  $('expiresInput').value = date.toISOString().slice(0, 16);
  setSourceOptions(cfg?.researchSource ? [cfg.researchSource] : [], cfg?.researchSource);
  $('configError').textContent = '';
  $('configDialog').showModal();
  void loadResearchSources();
}

$('loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  try { await connect($('token').value.trim()); } catch (error) { showLogin(error.message); }
});
$('logout').addEventListener('click', async () => {
  try { await api('/api/session', {}, 'DELETE'); showLogin(); } catch (error) { message(error.message, true); }
});
$('configure').addEventListener('click', fillConfig);
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => $(button.dataset.close).close());
$('researchSource').addEventListener('change', updateResearchSourceDetail);
$('loadSources').addEventListener('click', () => { void loadResearchSources(); });
$('configForm').addEventListener('submit', async event => {
  event.preventDefault();
  $('configError').textContent = '';
  try {
    const selectedSource = researchSources.find(source => source.chain === $('researchSource').value);
    if (!selectedSource) throw new Error('Verify and select one exact Agent0 research source.');
    const fields = Object.fromEntries(new FormData(event.target));
    const cfg = {
      ...fields,
      withdrawDelay: Number($('withdrawDelay').value),
      ceilingBaseUnits: baseUnits($('ceilingInput').value),
      perCallBaseUnits: baseUnits($('perCallInput').value),
      windowBaseUnits: baseUnits($('windowInput').value),
      windowMs: Number($('windowMinutes').value) * 60000,
      expiresAt: new Date($('expiresInput').value).toISOString(),
      sessionKey: $('sessionKey').value,
      derivationPath: "44'/60'/0'/0/0",
      researchSource: { provider: 'the-graph', chain: selectedSource.chain, deployment: selectedSource.deployment },
    };
    await api('/api/config', cfg);
    $('configDialog').close();
    await refresh(true);
    message('Reviewed source-bound Mandate saved. No funds were authorized or moved.');
  } catch (error) { $('configError').textContent = error.message; }
});
$('readDevice').addEventListener('click', async () => {
  const button = $('readDevice');
  button.disabled = true;
  $('configError').textContent = 'Reading the connected Ledger address. No signature is requested.';
  try {
    const result = await api('/api/device', {});
    $('operatorAddress').value = result.address;
    $('configError').textContent = 'Address read. Verify this is your intended payer; this was not payment approval.';
  } catch (error) { $('configError').textContent = error.message; }
  finally { button.disabled = false; }
});
$('probeDraft').addEventListener('click', async () => {
  const button = $('probeDraft');
  button.disabled = true;
  $('draftProbe').hidden = false;
  $('draftProbe').textContent = 'Reading the live chain and unpaid offer…';
  try {
    const selectedSource = researchSources.find(source => source.chain === $('researchSource').value);
    if (!selectedSource) throw new Error('Verify and select one exact Agent0 research source before inspecting the offer.');
    const result = await api('/api/preflight', {
      reviewDraft: true,
      rpcUrl: $('rpcUrl').value.trim(),
      serviceUrl: $('serviceUrl').value.trim(),
      operatorAddress: $('operatorAddress').value.trim(),
      sessionKey: $('sessionKey').value.trim(),
      researchSource: { provider: 'the-graph', chain: selectedSource.chain, deployment: selectedSource.deployment },
    });
    $('draftProbe').textContent = pretty(result);
    if (!result.chain?.ok) throw new Error(result.chain?.error || 'The selected RPC is not Base Sepolia.');
    if (!result.research?.ok) throw new Error(result.research?.error || `The selected ${sourceLabel(selectedSource.chain)} deployment is not currently available.`);
    if (!result.service?.ok) throw new Error(result.service?.error || 'The paid service did not return a valid unsigned offer.');
    const offered = result.service.requirements;
    $('receiver').value = offered.payTo;
    $('asset').value = offered.asset;
    $('receiverAuthorizer').value = offered.extra.receiverAuthorizer;
    $('withdrawDelay').value = offered.extra.withdrawDelay;
    $('configError').textContent = 'Recipient, asset, authorizer and withdrawal delay came from this live unpaid offer. Independently review them before saving.';
  } catch (error) {
    $('draftProbe').textContent = error.message;
    $('configError').textContent = error.message;
  }
  finally { button.disabled = false; }
});
$('preflight').addEventListener('click', async () => {
  const button = $('preflight');
  button.disabled = true;
  $('preflightDetails').open = true;
  $('preflightResult').textContent = 'Checking live dependencies without signing or paying…';
  try { $('preflightResult').textContent = pretty(await api('/api/preflight', {})); await refresh(); }
  catch (error) { $('preflightResult').textContent = error.message; }
  finally { button.disabled = false; }
});
$('taskForm').addEventListener('submit', async event => {
  event.preventDefault();
  const existing = readPendingIntent();
  if (existing) {
    selectedTask = existing.requestId;
    syncPendingIntent(current);
    updateActionAvailability(current);
    message(`Request ${existing.requestId} already needs observation. No new paid task was created.`, true);
    return;
  }
  const button = $('runTask');
  button.disabled = true;
  let requestId = null;
  try {
    const needsFunding = current?.financial?.deposit !== 'funded';
    if (needsFunding && !$('authorizeFunding').checked) throw new Error('Review and explicitly authorize initial funding before requesting a Ledger signature.');
    const task = selectedResearchTask();
    requestId = crypto.randomUUID();
    const payload = { task, authorizeFunding: needsFunding && $('authorizeFunding').checked, requestId };
    persistPendingIntent({ version: 1, requestId, mandateSalt: current.config.salt, payload, createdAt: Date.now() });
    syncPendingIntent(current);
    message(`Paid intent ${requestId} saved locally. Submitting this exact request once.`);
    const result = await api('/api/tasks', payload);
    selectedTask = result.task.id;
    message(`Task ${result.task.id} accepted by the broker. Observe this exact request until it reaches a terminal state.`);
    await refresh(true);
  } catch (error) {
    if (requestId && [400, 401, 403, 404, 413, 415, 422, 429].includes(error.status)) clearPendingIntent(requestId);
    const pending = requestId && readPendingIntent()?.requestId === requestId;
    message(pending
      ? `${error.message} The request ID remains saved because server acceptance is uncertain; check the existing task before retrying.`
      : error.message, true);
  } finally {
    if (current) await refresh();
  }
});
$('checkPendingTask').addEventListener('click', async () => {
  const pending = readPendingIntent();
  if (!pending) { message('No unresolved browser request ID exists.'); await refresh(); return; }
  const button = $('checkPendingTask');
  button.disabled = true;
  try {
    const result = await api(`/api/tasks/${encodeURIComponent(pending.requestId)}`);
    selectedTask = result.task.id;
    renderResult(result.task);
    if (TERMINAL_TASK_STATES.has(result.task.state)) {
      clearPendingIntent(pending.requestId);
      message(`Task ${pending.requestId} is ${readable(result.task.state)}. The browser intent is now resolved.`);
    } else message(`Task ${pending.requestId} is ${readable(result.task.state)}. Continue observing or reconcile it; no new paid task was created.`);
    await refresh(true);
  } catch (error) {
    if (error.status === 404) {
      clearPendingIntent(pending.requestId);
      message(`The broker confirmed that ${pending.requestId} does not exist. A new run may now use a new ID.`);
      await refresh(true);
    } else message(`Could not establish the outcome of ${pending.requestId}: ${error.message}`, true);
  } finally { button.disabled = false; }
});
$('stop').addEventListener('click', async () => {
  try { await api('/api/stop', {}); message('New work stopped and agent capabilities revoked. Existing accepted payments were not reversed.'); await refresh(true); }
  catch (error) { message(error.message, true); }
});
$('reconcile').addEventListener('click', async () => {
  try {
    const pending = current?.financial?.requests?.find(request => ['signed', 'uncertain'].includes(request.state));
    const result = await api('/api/reconcile', pending ? { requestId: pending.id } : {});
    message(`Existing state reconciled without requesting a new payment: ${pretty(result.totals || result.snapshot || result)}`);
    await refresh(true);
  } catch (error) { message(error.message, true); }
});
$('settle').addEventListener('click', async () => {
  try {
    if (!window.confirm('Claim accepted vouchers and settle merchant revenue on Base Sepolia? The facilitator pays testnet gas.')) return;
    const result = await api('/api/settle', { confirm: 'claim_and_settle_testnet' });
    selectedTask = result.task.id;
    message('Merchant settlement requested. Waiting for on-chain reconciliation.');
    await refresh(true);
  } catch (error) { message(error.message, true); }
});
$('closeMandate').addEventListener('click', async () => {
  try {
    if (!window.confirm('Close this fully spent Mandate after read-only on-chain reconciliation? No refund transaction will be created.')) return;
    const result = await api('/api/close', { confirm: 'close_fully_spent_testnet' });
    message(`Mandate closed as ${readable(result.reason)}. No zero-value refund was created.`);
    await refresh(true);
  } catch (error) { message(error.message, true); }
});
$('refund').addEventListener('click', () => $('refundDialog').showModal());
$('confirmRefund').addEventListener('click', async () => {
  try {
    const result = await api('/api/refund', { confirm: 'request_refund' });
    selectedTask = result.task.id;
    $('refundDialog').close();
    message('Recovery requested. This is not yet a confirmed refund.');
    await refresh(true);
  } catch (error) { message(error.message, true); $('refundDialog').close(); }
});
$('delegate').addEventListener('click', async () => {
  try {
    const cap = await api('/api/capabilities', { task: selectedResearchTask() });
    message(`Scoped agent capability saved privately to ${cap.capabilityFile}. Run npm run agent -- --capability ${cap.capabilityFile}. The agent cannot fund, change the research source, widen limits or recover funds.`);
    await refresh();
  } catch (error) { message(error.message, true); }
});
$('publishEvidence').addEventListener('click', async () => {
  try {
    const plan = current?.evidencePublication;
    if (!plan || plan.plannedRecords === 0) throw new Error('No pending evidence batch is available.');
    const consent = `Publish exactly ${plan.plannedRecords} of ${plan.pendingRecords} pending signed records to Hedera testnet? This action is capped at ${plan.maxRecordsPerAction} records across all journals and up to ${plan.estimatedSubmissions} submissions. Each submission has a configured maximum transaction fee of ${plan.perRecordMaxTransactionFeeHbar} HBAR; the combined configured maximum is ${plan.worstCaseConfiguredMaxFeeHbar} HBAR.`;
    if (!window.confirm(consent)) return;
    message('Submitting the reviewed evidence batch and waiting for consensus receipts.');
    const result = await api('/api/evidence/publish', { confirm: 'publish_testnet_evidence', consentHash: plan.consentHash });
    selectedTask = result.task.id;
    message(`Evidence batch of ${result.plan.plannedRecords} queued. Each anchor becomes confirmed only after its consensus receipt.`);
    await refresh(true);
  } catch (error) { message(error.message, true); }
});

let connecting = false;
async function consumeLoginFragment() {
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  if (!token || connecting) return false;
  connecting = true;
  history.replaceState(null, '', location.pathname);
  try { await connect(token); } catch (error) { showLogin(error.message); }
  finally { connecting = false; }
  return true;
}
window.addEventListener('hashchange', () => { void consumeLoginFragment(); });
(async () => {
  if (!(await consumeLoginFragment())) await refresh(true);
  refreshTimer = setInterval(() => { if (!document.hidden && !connecting) void refresh(); }, 2500);
  clockTimer = setInterval(() => { if (current) updateActionAvailability(current); }, 1000);
})();
