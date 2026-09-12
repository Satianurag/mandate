'use strict';
// Authenticated goal workspace. All amounts, progress and receipts come from the broker.
(() => {
  const toolLabels = { 'graph-agent0': 'Agent registrations', 'graph-protocol': 'Protocol activity', 'web-search': 'Web search', 'crypto-news': 'Crypto news', 'crypto-prices': 'Market prices', 'hedera-analysis': 'Evidence Lab' };
  const networkLabel = n => n === 'hedera:testnet' ? 'Hedera testnet' : n === 'eip155:84532' ? 'Base Sepolia' : n;
  const terminal = new Set(['completed', 'partial', 'failed', 'stopped', 'interrupted']);
  const pendingKey = 'mandate.agent-run.pending.v1';
  const selectedKey = 'mandate.agent-run.selected.v1';
  const tone = s => s === 'completed' || s === 'accepted' ? 'success' : ['partial', 'uncertain', 'interrupted', 'stopping'].includes(s) ? 'warning' : statusType(s);
  const phaseLabel = { idle: 'Review the allowance before funding.', checking: 'Checking testnet balance and settlement support.', connecting_device: 'Connecting to the Ledger. Unlock it and open the Ethereum app.', awaiting_device: 'Review the actual amount and recipient on your Ledger.', submitting: 'Submitting the signed testnet funding transfer.', confirming: 'Verifying the transfer on Base Sepolia.', confirmed: 'Funding confirmed on Base Sepolia.', needs_reconciliation: 'The funding outcome needs review. Do not create another signature.', reconciling: 'Looking up the existing funding receipt. No new payment is being made.', failed: 'Funding did not complete.' };
  const increasePhaseLabel = { idle: '', checking: 'Checking the additional amount and settlement support.', connecting_device: 'Connecting to Ledger for the allowance increase.', awaiting_device: 'Review the additional amount and recipient on your Ledger.', submitting: 'Submitting the signed allowance increase.', confirming: 'Verifying the additional transfer on Base Sepolia.', confirmed: 'Allowance increase confirmed.', needs_reconciliation: 'The increase outcome is uncertain. Reconcile it; never sign another increase.', reconciling: 'Checking the existing increase receipt without a new signature.', failed: 'The allowance increase did not complete.' };
  let catalog = null, editing = null, launching = null, selectedRun = null, busy = false, last = '', runLast = '', reviewedHash = null, returnReview = null, increaseReview = null;
  try { selectedRun = sessionStorage.getItem(selectedKey); } catch { /* Storage is optional for viewing. */ }
  let restoreRunView = Boolean(selectedRun);
  const button = (text, style, action) => { const b = el('button', text, style); b.type = 'button'; b.onclick = action; return b; };
  const selectRun = id => { selectedRun = id; runLast = ''; try { sessionStorage.setItem(selectedKey, id); } catch {} showDashboardView('task'); void refreshRun(); };
  function fact(root, label, value) { const row = el('div'); row.append(el('dt', label), el('dd', String(value))); root.append(row); }
  function safeLink(raw, label, className = 'source-link') {
    try { const url = new URL(raw); if (url.protocol !== 'https:' || url.username || url.password) return el('span', label); const a = el('a', label, className); a.href = url.toString(); a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; } catch { return el('span', label); }
  }
  function explorer(network, transaction) {
    if (network === 'eip155:84532' && /^0x[0-9a-fA-F]{64}$/.test(transaction || '')) return `https://sepolia.basescan.org/tx/${transaction}`;
    if (network === 'hedera:testnet' && /^0\.0\.\d+[-@]\d+[-.]\d{1,9}$/.test(transaction || '')) return `https://hashscan.io/testnet/transaction/${encodeURIComponent(transaction)}`;
    return null;
  }
  // A deliberately small Markdown renderer. No HTML, model-authored image or embedded script executes.
  function inline(parent, text) {
    const pattern = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]{1,300})\]\((https:\/\/[^\s)]+)\))/g;
    let cursor = 0;
    for (const match of text.matchAll(pattern)) {
      parent.append(document.createTextNode(text.slice(cursor, match.index)));
      if (match[2]) parent.append(el('strong', match[2])); else if (match[3]) parent.append(el('code', match[3])); else parent.append(safeLink(match[5], match[4]));
      cursor = match.index + match[0].length;
    }
    parent.append(document.createTextNode(text.slice(cursor)));
  }
  function renderMarkdown(text) {
    const root = el('div', undefined, 'agent-report-body'), lines = String(text).slice(0, 50000).split('\n');
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) { index++; continue; }
      if (/^```/.test(line)) { const code = []; index++; while (index < lines.length && !/^```/.test(lines[index])) code.push(lines[index++]); root.append(el('pre', code.join('\n'))); index++; continue; }
      const heading = /^(#{1,6})\s+(.+)$/.exec(line);
      if (heading) { const node = el(heading[1].length < 3 ? 'h4' : 'h5'); inline(node, heading[2]); root.append(node); index++; continue; }
      if (line.trim().startsWith('|') && index + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[index + 1])) {
        const table = el('table'), head = el('thead'), row = el('tr'), split = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
        for (const value of split(line)) { const cell = el('th'); cell.scope = 'col'; inline(cell, value); row.append(cell); }
        head.append(row); table.append(head); index += 2; const body = el('tbody');
        while (index < lines.length && lines[index].trim().startsWith('|')) { const tr = el('tr'); for (const value of split(lines[index++])) { const cell = el('td'); inline(cell, value); tr.append(cell); } body.append(tr); }
        table.append(body); const scroll = el('div', undefined, 'table-scroll'); scroll.tabIndex = 0; scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', 'Investigation comparison table'); scroll.append(table); root.append(scroll); continue;
      }
      if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
        const list = el(/^\s*\d+\./.test(line) ? 'ol' : 'ul');
        while (index < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[index])) { const item = el('li'); inline(item, lines[index++].replace(/^\s*([-*]|\d+\.)\s+/, '')); list.append(item); }
        root.append(list); continue;
      }
      if (/^\s*---+\s*$/.test(line)) { root.append(el('hr')); index++; continue; }
      const paragraph = el(line.startsWith('> ') ? 'blockquote' : 'p'); inline(paragraph, line.replace(/^>\s?/, '')); root.append(paragraph); index++;
    }
    return root;
  }
  function pendingIntent() {
    try { const value = JSON.parse(localStorage.getItem(pendingKey) || 'null'); return value && /^[A-Za-z0-9_-]{8,128}$/.test(value.requestId) && typeof value.goal === 'string' && typeof value.agentId === 'string' ? value : null; } catch { return null; }
  }
  function renderPending() {
    const pending = pendingIntent(); $('agentPendingSubmission').hidden = !pending;
    if (pending) $('agentPendingSubmissionText').textContent = `The request for “${pending.goal.slice(0, 150)}” may already exist. Check it before submitting another investigation.`;
  }
  async function observePending() {
    const pending = pendingIntent(); if (!pending) return;
    try { const { run } = await api(`/api/agent-runs/${encodeURIComponent(pending.requestId)}`); localStorage.removeItem(pendingKey); renderPending(); selectRun(run.id); }
    catch (error) {
      if (error.status === 404) { localStorage.removeItem(pendingKey); renderPending(); message('The broker confirms that request does not exist. No run was repeated. You may submit your goal again.'); }
      else message(`The existing request could not be observed: ${error.message}`, true);
    }
  }
  function openEditor(profile = null) {
    editing = profile;
    $('agentEditorTitle').textContent = profile ? 'Edit agent' : 'Create an agent';
    for (const [element, key] of [['agentName', 'name'], ['agentDescription', 'description'], ['agentGoal', 'goal'], ['agentInstructions', 'instructions'], ['agentOutput', 'output']]) $(element).value = profile?.[key] || '';
    $('agentBudget').value = units(profile?.budgetBaseUnits ?? '100000'); $('agentPerCall').value = units(profile?.perCallBaseUnits ?? '20000');
    $('agentSteps').value = profile?.maxSteps ?? 12; $('agentDuration').value = profile?.maxDurationSeconds ?? 300;
    $('agentToolChoices').replaceChildren();
    for (const [id, label] of Object.entries(toolLabels)) {
      const row = el('label', undefined, 'checkline'), input = el('input'); input.type = 'checkbox'; input.value = id;
      const available = !catalog?.setup || catalog.availableTools.includes(id);
      input.disabled = !available;
      input.checked = profile ? profile.toolIds.includes(id) : catalog?.setup ? ['graph-protocol', 'hedera-analysis', 'crypto-prices'].includes(id) && available : id === 'web-search';
      row.append(input, el('span', `${label}${!available ? ' · not configured' : ''}`)); $('agentToolChoices').append(row);
    }
    $('agentEditorError').textContent = ''; $('agentEditor').showModal();
  }
  function openLaunch(profile) {
    launching = profile; $('agentLaunchTitle').textContent = profile.name; $('agentLaunchDescription').textContent = profile.description; $('agentLaunchGoal').value = profile.goal || (profile.id === 'protocol-investigator' ? `Investigate ${catalog?.setup?.researchSources?.[0]?.label || 'the configured protocol'}: compare the most recent complete UTC day with earlier days, investigate data-quality anomalies, and explain which conclusions the evidence supports and which remain unresolved.` : profile.id === 'agent-selection-analyst' ? 'Find an agent for monitoring onchain protocol activity. Compare available candidates, their declared capabilities and feedback coverage. Explain whether there is enough verified evidence to hire one.' : '');
    const configured = profile.toolIds.filter(id => catalog.availableTools.includes(id)).map(id => toolLabels[id]).join(', ');
    $('agentLaunchLimits').textContent = `${units(profile.budgetBaseUnits)} test USDC maximum per run · ${units(profile.perCallBaseUnits)} per call · ${profile.maxSteps} decisions · ${profile.maxDurationSeconds} seconds. ${configured ? `Available tools: ${configured}. ` : ''}This does not increase the shared allowance. Vertex model usage is billed separately.`;
    const readiness = catalog?.availability?.[profile.id], running = catalog?.runningCount > 0;
    $('launchAgent').disabled = !readiness?.ready || running; $('agentLaunchError').textContent = running ? 'Another investigation is using this allowance. Finish or stop it before starting this goal.' : readiness?.ready ? '' : readiness?.reason || catalog?.readiness || 'Checking readiness';
    $('agentLaunch').showModal();
  }
  function allowanceFacts(root, setup, compact = false) {
    root.replaceChildren(); const a = setup.authority, effective = setup.effectiveCeilingBaseUnits || a.ceilingBaseUnits;
    fact(root, 'Shared allowance', `${units(effective)} test USDC across both payment networks`);
    if (BigInt(effective) !== BigInt(a.ceilingBaseUnits)) { fact(root, 'Initial Ledger funding', `${units(a.ceilingBaseUnits)} test USDC`); fact(root, 'Confirmed increases', `${units(setup.confirmedIncreaseBaseUnits || '0')} test USDC`); }
    fact(root, 'Per-call limit', `${units(a.perCallBaseUnits)} test USDC · unchanged by increases`);
    fact(root, 'Rolling limit', `${units(a.windowBaseUnits)} test USDC per ${a.windowMs / 60000} minutes · unchanged`);
    fact(root, 'Expires', when(a.expiresAt));
    fact(root, 'Ledger payer', a.payerAddress); fact(root, 'Funded software wallet', a.spendingAddress);
    if (a.hedera) fact(root, 'Hedera payment account', `${a.hedera.accountId} → ${a.hedera.payTo} · native testnet USDC`);
    if (!compact) fact(root, 'Allowed services', (setup.configuredTools || []).map(t => toolLabels[t.id] || t.id).join(', '));
  }
  function renderSetup(data) {
    const setup = data.setup; document.body.classList.toggle('agent-mode', Boolean(setup)); $('agentHomeOverview').hidden = !setup;
    if (!setup) return;
    const { authority: a, totals = {}, funding = {} } = setup, effective = setup.effectiveCeilingBaseUnits || a.ceilingBaseUnits, increase = setup.increase || {};
    const spent = totals.spent || '0', reserved = totals.reserved || '0', remaining = totals.remaining || '0';
    $('agentHomeReadiness').textContent = data.readiness;
    $('agentHeaderStatus').textContent = data.runningCount ? 'Investigation running' : funding.status === 'funded' && setup.state === 'active' ? 'Ledger-funded allowance' : setup.state !== 'active' ? readable(setup.state) : 'Ledger approval needed';
    $('agentHeaderStatus').className = `badge agent-only ${funding.status === 'funded' && setup.state === 'active' ? 'success' : 'neutral'}`;
    $('agentHomeCeiling').textContent = `${units(effective)} test USDC`;
    $('agentHomeSpent').textContent = units(spent); $('agentHomeReserved').textContent = units(reserved);
    $('agentHomeRemaining').textContent = setup.state !== 'active' ? readable(setup.state) : Date.now() >= a.expiresAt ? 'Expired' : funding.status === 'funded' ? units(remaining) : 'Not funded';
    $('agentBudgetProgress').value = BigInt(effective) > 0n ? Number((BigInt(spent) + BigInt(reserved)) * 100n / BigInt(effective)) : 0;
    $('agentHomePrimary').textContent = funding.status === 'funded' ? 'Choose an agent' : 'Set up allowance';
    $('agentHomePrimary').onclick = () => showDashboardView(funding.status === 'funded' ? 'task' : 'authority');
    const state = setup.state !== 'active' ? setup.state : Date.now() >= a.expiresAt ? 'expired' : funding.status === 'funded' ? 'funded' : funding.status === 'pending' ? 'pending' : 'unfunded';
    $('agentAllowanceStatus').textContent = readable(state); $('agentAllowanceStatus').className = `badge ${tone(state)}`;
    $('agentAllowanceSummary').textContent = setup.state === 'closed' ? 'This allowance is closed. Its history and verified receipts remain available; it cannot make new payments.' : setup.state === 'stopped' ? 'New payments are stopped. Review pending receipts before returning unused funds.' : funding.status === 'funded' ? `${units(remaining)} test USDC remains from a ${units(effective)} test-USDC shared allowance. You can increase it only with another explicit Ledger approval.` : `Approve ${units(a.ceilingBaseUnits)} test USDC initially. Agents can never increase this allowance themselves.`;
    allowanceFacts($('agentAllowanceFacts'), setup);
    $('agentAllowanceTechnical').textContent = JSON.stringify({ authority: a, effectiveCeilingBaseUnits: effective, confirmedIncreases: setup.increases || [], model: setup.vertex, custody: setup.custody, inferenceBilling: setup.inferenceBilling }, null, 2);
    $('agentFundingProgress').textContent = funding.transaction ? `Confirmed transfer: ${funding.transaction}` : phaseLabel[funding.phase] || phaseLabel.idle;
    $('agentFundingError').textContent = funding.error || '';
    $('agentReviewFunding').hidden = funding.status !== 'none'; $('agentReviewFunding').disabled = state !== 'unfunded';
    $('agentReconcileFunding').hidden = funding.status !== 'pending';
    $('agentReconcileFunding').disabled = !['needs_reconciliation', 'failed'].includes(funding.phase);
    const unresolvedIncrease = ['signed', 'uncertain'].includes(increase.status) || increase.phase === 'needs_reconciliation';
    $('agentIncreaseAllowance').hidden = funding.status !== 'funded' || setup.state !== 'active' || unresolvedIncrease;
    $('agentIncreaseAllowance').disabled = data.runningCount > 0 || Boolean(data.busy) || BigInt(reserved) > 0n || Date.now() >= a.expiresAt;
    $('agentReconcileIncrease').hidden = !unresolvedIncrease; $('agentReconcileIncrease').disabled = Boolean(data.busy) || data.runningCount > 0;
    $('agentIncreaseProgress').textContent = unresolvedIncrease ? increasePhaseLabel[increase.phase] || 'The allowance increase needs reconciliation.' : increase.phase === 'confirmed' && increase.transaction ? `Latest increase confirmed: ${increase.transaction}` : '';
    $('agentIncreaseError').textContent = increase.error || '';
    $('agentStopAllowance').hidden = setup.state !== 'active';
    const returned = setup.returnStatus || {}, returnBusy = Boolean(returned.busy);
    $('agentReviewReturn').hidden = !setup.returnSupported || funding.status !== 'funded' || setup.state === 'closed' || ['signed', 'uncertain', 'confirmed'].includes(returned.state);
    $('agentReviewReturn').disabled = data.runningCount > 0 || returnBusy || BigInt(reserved) > 0n;
    $('agentReconcileReturn').hidden = !['signed', 'uncertain'].includes(returned.state); $('agentReconcileReturn').disabled = returnBusy;
    $('agentReturnProgress').textContent = returned.state === 'confirmed' ? `Returned ${units(returned.amountBaseUnits)} test USDC to the original payer. Transfer: ${returned.transaction}` : returnBusy ? `Returning unused funds: ${readable(returned.phase)}. No new agent work is allowed.` : returned.phase === 'needs_reconciliation' ? 'The return outcome needs reconciliation. Do not authorize another transfer.' : '';
    $('agentReturnError').textContent = returned.error || '';

    $('agentAllReceipts').replaceChildren(receiptList(setup.payments || [], data.runningCount > 0));
    const recent = $('agentRecentWork'); recent.replaceChildren();
    if (!data.runs.length) { const empty = el('div', undefined, 'agent-empty'); empty.append(el('h3', 'Your first goal starts here.'), el('p', 'Investigate a protocol, review agent candidates, or describe your own job. Results and receipts stay together.', 'subtle')); recent.append(empty); }
    for (const run of data.runs.slice(0, 3)) recent.append(historyRow(run));
    const newButtonLabel = $('newMandate').querySelector('span'); if (newButtonLabel) newButtonLabel.textContent = 'Create agent';
    const agentSidebar = document.querySelector('.sidebar-group .service-avatar.agent')?.nextElementSibling; if (agentSidebar) agentSidebar.textContent = 'Agent workspace';
  }
  function historyRow(run) {
    const row = button('', 'agent-history-row', () => selectRun(run.id)), body = el('div', undefined, 'agent-history-copy');
    body.append(el('strong', run.agent.name), el('p', run.goal, 'subtle'), el('small', when(run.createdAt)));
    row.append(body, badge(readable(run.state), tone(run.state))); return row;
  }
  function renderAgents(data) {
    catalog = data; $('agentReadiness').textContent = data.readiness; renderSetup(data); renderPending();
    const cards = $('agentCards'); cards.replaceChildren();
    for (const profile of data.agents) {
      const card = el('article', undefined, 'agent-card');
      card.append(el('span', profile.template ? 'SPECIALIST' : 'YOUR AGENT', 'eyebrow'), el('h3', profile.name), el('p', profile.description || profile.output, 'subtle'));
      const pills = el('div', undefined, 'agent-tool-pills');
      for (const id of profile.toolIds.filter(id => data.availableTools.includes(id))) pills.append(el('span', toolLabels[id], 'agent-tool-pill'));
      const allowance = el('p', `Up to ${units(profile.budgetBaseUnits)} test USDC per run`, 'agent-allowance');
      const actions = el('div', undefined, 'actions'); actions.append(button('Give it a goal', 'primary', () => openLaunch(profile)));
      if (!profile.template) actions.append(button('Edit', 'secondary', () => openEditor(profile)));
      card.append(pills, allowance, actions); cards.append(card);
    }
    const create = button('', 'agent-card agent-create', () => openEditor()); create.append(el('span', '+', 'agent-plus'), el('strong', 'Create an agent'), el('span', 'Describe the job. Define the result.', 'subtle')); cards.insertBefore(create, cards.children[2] || null);
    const history = $('agentHistory'); history.replaceChildren();
    if (!data.runs.length) history.append(el('p', 'Completed investigations, partial results and interrupted work will appear here.', 'empty-inline'));
    for (const run of data.runs) history.append(historyRow(run));
    if ($('agentLaunch').open && launching) { const r = data.availability[launching.id]; $('launchAgent').disabled = !r?.ready || data.runningCount > 0; }
  }
  function receiptList(payments, running = false) {
    const root = el('div', undefined, 'agent-receipt-list');
    if (!payments.length) { root.append(el('p', 'No paid tool calls yet. Preparing an agent or opening this page does not spend funds.', 'empty-inline')); return root; }
    for (const payment of payments) {
      const row = el('div', undefined, 'agent-receipt'), head = el('div', undefined, 'agent-receipt-heading');
      head.append(el('strong', `${units(payment.amountBaseUnits)} test USDC`), badge(networkLabel(payment.network), 'neutral'), badge(readable(payment.state), tone(payment.state))); row.append(head);
      const link = payment.chainVerified && explorer(payment.network, payment.transaction);
      if (link) row.append(safeLink(link, `View verified transfer · ${payment.transaction.slice(0, 18)}…`));
      else row.append(el('p', 'No independently confirmed transfer receipt yet.', 'subtle'));
      row.append(el('small', `Request ${payment.id}`));
      if (payment.error && payment.state !== 'accepted') row.append(el('p', payment.error, 'error'));
      if (['signed', 'uncertain'].includes(payment.state)) {
        const recover = button('Check existing receipt', 'secondary', async () => {
          recover.disabled = true;
          try { await api('/api/agent-payments/reconcile', { requestId: payment.id }); message('The existing receipt was verified. No new signature or payment was requested.'); runLast = ''; last = ''; await refreshAgents(); }
          catch (e) { message(e.message, true); } finally { recover.disabled = running; }
        }); recover.disabled = running; row.append(recover);
      }
      root.append(row);
    }
    return root;
  }
  async function refreshRun() {
    if (!selectedRun || !current) return;
    let loaded;
    try { loaded = await api(`/api/agent-runs/${encodeURIComponent(selectedRun)}`); }
    catch (e) { if (e.status === 404) { selectedRun = null; $('agentRunDetail').hidden = true; return; } throw e; }
    const { run, events, report } = loaded, fingerprint = JSON.stringify(loaded);
    if (fingerprint === runLast) return; runLast = fingerprint;
    const detail = $('agentRunDetail'), openDetails = new Set([...detail.querySelectorAll('details[open]')].map(d => d.dataset.group));
    detail.hidden = false; detail.replaceChildren();
    const heading = el('div', undefined, 'agent-run-heading'), identity = el('div'); identity.append(el('p', 'INVESTIGATION', 'eyebrow'), el('h3', run.agent.name), el('p', run.goal, 'agent-run-goal'));
    heading.append(identity, badge(readable(run.state), tone(run.state))); detail.append(heading);
    if (!terminal.has(run.state)) {
      const latest = [...events].reverse().find(e => ['action_selected', 'tool_observation', 'unpaid_tool_failure', 'payment_requested', 'price_blocked'].includes(e.kind));
      const progress = el('div', undefined, 'agent-live-status'); progress.setAttribute('role', 'status');
      let state = 'Choosing a useful first step within your allowance.';
      if (latest?.kind === 'action_selected') state = latest.data.reason;
      else if (latest?.kind === 'payment_requested') state = `Verifying ${units(latest.data.quote.amountBaseUnits)} test USDC on ${networkLabel(latest.data.quote.network)} for ${toolLabels[latest.data.quote.toolId]}.`;
      else if (latest?.kind === 'tool_observation') state = `${toolLabels[latest.data.toolId]} returned evidence. The agent is deciding what to do next.`;
      else if (latest) state = 'Reconsidering the next permitted step after a service or price limit.';
      if (run.state === 'stopping') state = 'Stopping new work. Any in-flight payment must still be reconciled.';
      progress.append(el('span', '', 'agent-live-dot'), el('p', state)); detail.append(progress);
      detail.append(button('Stop investigation', 'secondary', async () => { try { await api(`/api/agent-runs/${encodeURIComponent(run.id)}/stop`, {}); runLast = ''; await refreshRun(); } catch (e) { message(e.message, true); } }));
    }
    if (report) {
      const metrics = el('div', undefined, 'agent-run-metrics');
      for (const [label, value] of [['Confirmed spending', `${units(report.paidBaseUnits)} test USDC`], ['Reserved / uncertain', `${units(report.reservedBaseUnits)} test USDC`], ['Evidence sources', String(report.evidence.length)]]) { const item = el('div'); item.append(el('span', label), el('strong', value)); metrics.append(item); }
      detail.append(metrics);
    }
    if (report?.evidenceWarnings?.length) {
      const warning = el('aside', undefined, 'boundary'); warning.append(el('strong', 'Evidence-quality limits'));
      const list = el('ul'); for (const text of report.evidenceWarnings) list.append(el('li', text)); warning.append(list); detail.append(warning);
    }
    if (run.result) detail.append(renderMarkdown(run.result));
    if (run.error && !report?.reportRecovered) detail.append(el('p', run.error, 'error'));
    if (report?.recoveredAfterRun) detail.append(el('p', 'A receipt was recovered after execution stopped. The goal was not automatically rerun or marked complete.', 'boundary'));
    const exportLink = el('a', 'Export investigation', 'secondary agent-export'); exportLink.href = `/api/agent-runs/${encodeURIComponent(run.id)}/report`; exportLink.download = `mandate-${run.id}.md`; detail.append(exportLink);
    const timeline = el('details'); timeline.dataset.group = 'steps'; timeline.open = openDetails.has('steps') || !terminal.has(run.state); timeline.append(el('summary', 'Decisions and evidence'));
    for (const event of events.filter(e => ['action_selected', 'tool_observation', 'unpaid_tool_failure', 'price_blocked', 'payment_uncertain'].includes(e.kind))) {
      const row = el('div', undefined, 'agent-step');
      if (event.kind === 'action_selected') { row.append(el('span', String(event.data.step), 'agent-step-number'), el('div')); const text = row.lastChild; text.append(el('strong', toolLabels[event.data.toolId] || event.data.toolId), el('p', event.data.reason, 'subtle')); }
      else if (event.kind === 'tool_observation') row.append(el('p', `${toolLabels[event.data.toolId]} · ${event.data.error ? 'paid result needs attention' : 'evidence received'} · ${units(event.data.receipt.amountBaseUnits)} test USDC`, 'subtle'));
      else row.append(el('p', event.data.reason || readable(event.kind), 'error'));
      timeline.append(row);
    }
    detail.append(timeline);
    if (report) {
      const proof = el('details'); proof.dataset.group = 'receipts'; proof.open = openDetails.has('receipts'); proof.append(el('summary', `Payment receipts · ${report.receipts.length}`), receiptList(report.receipts, !terminal.has(run.state))); detail.append(proof);
      if (report.sources.length) { const sources = el('section', undefined, 'agent-sources'); sources.append(el('h4', 'Sources')); for (const source of report.sources) sources.append(safeLink(source.url, source.title)); detail.append(sources); }
      const usage = el('p', `${report.inference.calls} recorded Vertex model calls · ${report.inference.totalTokens.toLocaleString()} reported tokens · ${report.inference.models.join(', ') || 'model not used'}. Cloud billing is separate from x402 payments.${report.inference.usageIncomplete ? ' A failed request has incomplete usage metadata; this is not a complete bill.' : ''}`, 'agent-inference'); detail.append(usage);
    }
    const advanced = el('details'); advanced.dataset.group = 'raw'; advanced.open = openDetails.has('raw'); advanced.append(el('summary', `Technical evidence · ${events.length} events`));
    for (const event of events) { const row = el('div', undefined, 'agent-event'); row.append(el('strong', readable(event.kind)), el('pre', JSON.stringify(event.data, null, 2))); advanced.append(row); } detail.append(advanced);
  }
  async function refreshAgents() {
    if (!current || busy) return; busy = true;
    try { const data = await api('/api/agents'), fingerprint = JSON.stringify(data); if (fingerprint !== last) { last = fingerprint; renderAgents(data); } await refreshRun(); if (restoreRunView && selectedRun) { showDashboardView('task'); restoreRunView = false; } }
    catch (e) { if (e.status !== 401) $('agentReadiness').textContent = `Agent state unavailable: ${e.message}`; }
    finally { busy = false; }
  }
  function openFunding() {
    const setup = catalog?.setup; if (!setup) return; reviewedHash = setup.consentHash;
    $('agentFundingReviewText').textContent = `Fund ${units(setup.authority.ceilingBaseUnits)} test USDC on Base Sepolia. This is not a mainnet transfer.`;
    allowanceFacts($('agentFundingReviewFacts'), setup); $('agentFundingConsent').checked = false; $('agentFundingDialogError').textContent = ''; $('agentConfirmFunding').disabled = false; $('agentFundingDialog').showModal();
  }
  $('agentFundingForm').onsubmit = async event => {
    event.preventDefault(); if (!$('agentFundingConsent').checked) return; $('agentConfirmFunding').disabled = true;
    try { await api('/api/agent-setup/fund', { consentHash: reviewedHash, confirm: 'fund_testnet_agent_allowance' }); $('agentFundingDialog').close(); showDashboardView('authority'); message('Review the funding transfer on your physical Ledger. The workspace will verify the chain receipt before enabling paid work.'); last = ''; await refreshAgents(); }
    catch (e) { $('agentFundingDialogError').textContent = e.message; $('agentConfirmFunding').disabled = false; }
  };
  async function previewIncrease() {
    $('agentIncreaseDialogError').textContent = ''; $('agentPreviewIncrease').disabled = true; $('agentIncreaseReview').hidden = true; increaseReview = null;
    try {
      const amountBaseUnits = baseUnits($('agentIncreaseAmount').value.trim());
      const { review } = await api('/api/agent-setup/increase-preview', { amountBaseUnits }); increaseReview = review;
      $('agentIncreaseReviewText').textContent = `Add ${units(review.amountBaseUnits)} test USDC: shared allowance becomes ${units(review.resultingCeilingBaseUnits)} test USDC.`;
      const facts = $('agentIncreaseReviewFacts'); facts.replaceChildren(); fact(facts, 'Current allowance', `${units(review.currentCeilingBaseUnits)} test USDC`); fact(facts, 'Additional funding', `${units(review.amountBaseUnits)} test USDC`); fact(facts, 'New allowance', `${units(review.resultingCeilingBaseUnits)} test USDC`); fact(facts, 'Ledger payer', review.from); fact(facts, 'Funded wallet', review.to); fact(facts, 'Per-call stays', `${units(review.unchanged.perCallBaseUnits)} test USDC`); fact(facts, 'Expiry stays', when(review.unchanged.expiresAt));
      $('agentIncreaseConsent').checked = false; $('agentConfirmIncrease').disabled = false; $('agentIncreaseReview').hidden = false;
    } catch (e) { $('agentIncreaseDialogError').textContent = e.message; } finally { $('agentPreviewIncrease').disabled = false; }
  }
  $('agentIncreaseAllowance').onclick = () => { increaseReview = null; $('agentIncreaseAmount').value = '0.10'; $('agentIncreaseReview').hidden = true; $('agentIncreaseDialogError').textContent = ''; $('agentIncreaseDialog').showModal(); void previewIncrease(); };
  $('closeAgentIncrease').onclick = () => $('agentIncreaseDialog').close();
  $('agentIncreaseAmount').oninput = () => { increaseReview = null; $('agentIncreaseReview').hidden = true; $('agentIncreaseDialogError').textContent = ''; };
  $('agentPreviewIncrease').onclick = previewIncrease;
  $('agentIncreaseForm').onsubmit = async event => {
    event.preventDefault(); if (!increaseReview || !$('agentIncreaseConsent').checked) return;
    let amountBaseUnits; try { amountBaseUnits = baseUnits($('agentIncreaseAmount').value.trim()); } catch (e) { $('agentIncreaseDialogError').textContent = e.message; return; }
    if (amountBaseUnits !== increaseReview.amountBaseUnits) { $('agentIncreaseDialogError').textContent = 'Amount changed. Review the increase again before signing.'; $('agentIncreaseReview').hidden = true; increaseReview = null; return; }
    $('agentConfirmIncrease').disabled = true;
    try { await api('/api/agent-setup/increase', { amountBaseUnits, consentHash: increaseReview.consentHash, confirm: 'increase_testnet_agent_allowance' }); $('agentIncreaseDialog').close(); message('Review the additional funding transfer on your physical Ledger. The allowance increases only after chain verification.'); last = ''; await refreshAgents(); }
    catch (e) { $('agentIncreaseDialogError').textContent = e.message; $('agentConfirmIncrease').disabled = false; }
  };
  $('agentReconcileIncrease').onclick = async () => { try { await api('/api/agent-setup/increase-reconcile', {}); last = ''; await refreshAgents(); message('The existing allowance increase was checked without creating another Ledger signature.'); } catch (e) { message(e.message, true); } };
  $('agentReviewReturn').onclick = async () => {
    $('agentReviewReturn').disabled = true;
    try {
      const { review } = await api('/api/agent-setup/return-preview'); returnReview = review;
      $('agentReturnReviewText').textContent = review.amountBaseUnits === '0' ? 'The broker will verify that the fully spent wallet has no remaining test USDC. No zero-value transfer will be created.' : `Return ${units(review.amountBaseUnits)} test USDC on Base Sepolia. No mainnet funds are involved.`;
      const facts = $('agentReturnReviewFacts'); facts.replaceChildren(); fact(facts, 'From', review.from); fact(facts, 'Original Ledger payer', review.to); fact(facts, 'Observed balance', `${units(review.amountBaseUnits)} test USDC`); fact(facts, 'Source block', review.block);
      $('agentReturnConsent').checked = false; $('agentReturnDialogError').textContent = ''; $('agentConfirmReturn').disabled = false; $('agentConfirmReturn').textContent = review.amountBaseUnits === '0' ? 'Close fully spent allowance' : 'Stop and return unused funds'; $('agentReturnDialog').showModal();
    } catch (e) { message(e.message, true); } finally { $('agentReviewReturn').disabled = false; }
  };
  $('closeAgentReturn').onclick = () => $('agentReturnDialog').close();
  $('agentReturnForm').onsubmit = async event => {
    event.preventDefault(); if (!$('agentReturnConsent').checked || !returnReview) return; $('agentConfirmReturn').disabled = true;
    try { await api('/api/agent-setup/return', { consentHash: returnReview.consentHash, confirm: 'return_unused_test_usdc' }); $('agentReturnDialog').close(); last = ''; await refreshAgents(); message('The return was requested. The allowance closes only after the transfer is verified.'); }
    catch (e) { $('agentReturnDialogError').textContent = e.message; $('agentConfirmReturn').disabled = false; }
  };
  $('agentReconcileReturn').onclick = async () => { try { await api('/api/agent-setup/return-reconcile', {}); last = ''; await refreshAgents(); } catch (e) { message(e.message, true); } };
  $('agentReviewFunding').onclick = openFunding; $('closeAgentFunding').onclick = () => $('agentFundingDialog').close();
  $('agentReviewShortcut').onclick = () => showDashboardView('authority');
  $('agentReconcileFunding').onclick = async () => { try { await api('/api/agent-setup/reconcile', {}); last = ''; await refreshAgents(); } catch (e) { message(e.message, true); } };
  $('agentStopAllowance').onclick = async () => {
    if (!confirm('Stop this entire allowance? New agent payments will be blocked. This does not reverse submitted payments or automatically return unused funds.')) return;
    try { await api('/api/agent-setup/stop', { confirm: 'stop_agent_allowance' }); last = ''; await refreshAgents(); message('The allowance is stopped. Existing receipts remain available for review.'); } catch (e) { message(e.message, true); }
  };
  $('newMandate').addEventListener('click', event => { if (catalog?.setup) { event.stopImmediatePropagation(); event.preventDefault(); openEditor(); } }, true);
  $('agentObserveSubmission').onclick = observePending;
  $('closeAgentEditor').onclick = () => $('agentEditor').close(); $('closeAgentLaunch').onclick = () => $('agentLaunch').close();
  $('agentEditorForm').onsubmit = async event => {
    event.preventDefault(); const submit = event.submitter; submit.disabled = true;
    try {
      const body = { name: $('agentName').value, description: $('agentDescription').value, goal: $('agentGoal').value, instructions: $('agentInstructions').value, output: $('agentOutput').value, toolIds: [...$('agentToolChoices').querySelectorAll('input:checked:not(:disabled)')].map(i => i.value), budgetBaseUnits: baseUnits($('agentBudget').value.trim()), perCallBaseUnits: baseUnits($('agentPerCall').value.trim()), maxSteps: Number($('agentSteps').value), maxDurationSeconds: Number($('agentDuration').value) };
      await api(editing ? `/api/agents/${editing.id}` : '/api/agents', editing ? { ...body, expectedVersion: editing.version } : body, editing ? 'PUT' : 'POST'); $('agentEditor').close(); last = ''; await refreshAgents();
    } catch (e) { $('agentEditorError').textContent = e.message; } finally { submit.disabled = false; }
  };
  $('agentLaunchForm').onsubmit = async event => {
    event.preventDefault(); $('launchAgent').disabled = true; let sent = false;
    try {
      const goal = $('agentLaunchGoal').value.trim(), previous = pendingIntent();
      if (previous && (previous.goal !== goal || previous.agentId !== launching.id)) throw new Error('A previous submission needs observation. Use “Check existing request” before creating different work.');
      const body = previous || { requestId: crypto.randomUUID(), agentId: launching.id, goal };
      localStorage.setItem(pendingKey, JSON.stringify(body)); if (localStorage.getItem(pendingKey) !== JSON.stringify(body)) throw new Error('Cannot save the request ID safely. No run was submitted.');
      sent = true; const { run } = await api('/api/agent-runs', body); localStorage.removeItem(pendingKey); $('agentLaunch').close(); selectedRun = run.id; runLast = ''; last = ''; try { sessionStorage.setItem(selectedKey, run.id); } catch {} await refreshAgents();
    } catch (e) { if (sent && [400, 401, 403, 409].includes(e.status)) localStorage.removeItem(pendingKey); $('agentLaunchError').textContent = e.message; renderPending(); }
    finally { $('launchAgent').disabled = !catalog?.availability?.[launching?.id]?.ready || catalog?.runningCount > 0; }
  };
  window.addEventListener('mandate:state', () => { void refreshAgents(); });
  window.addEventListener('focus', () => { void refreshAgents(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshAgents(); });
  setInterval(() => { if (!document.hidden) void refreshAgents(); }, 2500);
  void refreshAgents();
})();
