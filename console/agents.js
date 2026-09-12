'use strict';
// Uses the authenticated API/session established by workspace.js.
(() => {
  const toolLabels = { 'graph-agent0': 'Agent0 records · The Graph', 'graph-protocol': 'Protocol activity · The Graph', 'web-search': 'Web search', 'crypto-news': 'Crypto news', 'crypto-prices': 'Market prices', 'hedera-analysis': 'Analysis · Hedera' };
  let catalog = null, editing = null, launching = null, selectedRun = null, busy = false, last = '';
  const terminal = new Set(['completed', 'partial', 'failed', 'stopped', 'interrupted']);
  const pendingKey = 'mandate.agent-run.pending.v1';
  function openEditor(profile = null) {
    editing = profile;
    $('agentEditorTitle').textContent = profile ? 'Edit agent' : 'Create an agent';
    for (const [element, key] of [['agentName', 'name'], ['agentDescription', 'description'], ['agentGoal', 'goal'], ['agentInstructions', 'instructions'], ['agentOutput', 'output']]) $(element).value = profile?.[key] || '';
    $('agentBudget').value = units(profile?.budgetBaseUnits ?? '100000');
    $('agentPerCall').value = units(profile?.perCallBaseUnits ?? '20000');
    $('agentSteps').value = profile?.maxSteps ?? 12; $('agentDuration').value = profile?.maxDurationSeconds ?? 300;
    $('agentToolChoices').replaceChildren();
    for (const [id, label] of Object.entries(toolLabels)) {
      const row = el('label', undefined, 'checkline'), input = el('input'); input.type = 'checkbox'; input.value = id;
      input.checked = profile ? profile.toolIds.includes(id) : id === 'web-search'; row.append(input, el('span', label)); $('agentToolChoices').append(row);
    }
    $('agentEditorError').textContent = ''; $('agentEditor').showModal();
  }
  function openLaunch(profile) {
    launching = profile;
    $('agentLaunchTitle').textContent = profile.name; $('agentLaunchDescription').textContent = profile.description;
    $('agentLaunchGoal').value = profile.goal;
    $('agentLaunchLimits').textContent = `${units(profile.budgetBaseUnits)} USDC maximum · ${units(profile.perCallBaseUnits)} per call · ${profile.maxSteps} decisions · ${profile.maxDurationSeconds} seconds. Spending remains subject to your reviewed authority.`;
    const readiness = catalog?.availability?.[profile.id];
    $('launchAgent').disabled = !readiness?.ready; $('agentLaunchError').textContent = readiness?.ready ? '' : readiness?.reason || catalog?.readiness || 'Checking readiness';
    $('agentLaunch').showModal();
  }
  function renderAgents(data) {
    catalog = data;
    $('agentReadiness').textContent = data.readiness;
    const cards = $('agentCards'); cards.replaceChildren();
    for (const profile of data.agents) {
      const card = el('article', undefined, 'agent-card');
      card.append(el('span', profile.template ? 'SPECIALIST' : 'YOUR AGENT', 'eyebrow'), el('h3', profile.name), el('p', profile.description || profile.output, 'subtle'));
      const allowance = el('p', `Up to ${units(profile.budgetBaseUnits)} USDC per run`, 'agent-allowance');
      const actions = el('div', undefined, 'actions'), run = el('button', 'Give it a goal', 'primary'); run.type = 'button'; run.onclick = () => openLaunch(profile); actions.append(run);
      if (!profile.template) { const edit = el('button', 'Edit', 'secondary'); edit.type = 'button'; edit.onclick = () => openEditor(profile); actions.append(edit); }
      card.append(allowance, actions); cards.append(card);
    }
    const create = el('button', undefined, 'agent-card agent-create'); create.type = 'button'; create.append(el('span', '+', 'agent-plus'), el('strong', 'Create an agent'), el('span', 'Describe a goal. Make it yours.', 'subtle')); create.onclick = () => openEditor(); cards.insertBefore(create, cards.children[2] || null);
    const history = $('agentHistory'); history.replaceChildren();
    if (!data.runs.length) history.append(el('p', 'Your investigations will appear here, including partial results and interrupted work.', 'empty-inline'));
    for (const run of data.runs) {
      const row = el('button', undefined, 'agent-history-row'); row.type = 'button';
      row.append(el('strong', run.agent.name), el('span', run.goal, 'subtle'), badge(readable(run.state), statusType(run.state)));
      row.onclick = () => { selectedRun = run.id; showDashboardView('task'); void refreshRun(); }; history.append(row);
    }
  }
  async function refreshRun() {
    if (!selectedRun) return;
    const { run, events } = await api(`/api/agent-runs/${encodeURIComponent(selectedRun)}`);
    const detail = $('agentRunDetail'); detail.hidden = false; detail.replaceChildren();
    detail.append(el('h3', run.agent.name), el('p', run.goal), badge(readable(run.state), statusType(run.state)));
    if (!terminal.has(run.state)) {
      const stop = el('button', 'Stop investigation', 'secondary'); stop.type = 'button'; stop.onclick = async () => { try { await api(`/api/agent-runs/${encodeURIComponent(run.id)}/stop`, {}); await refreshRun(); } catch (e) { message(e.message, true); } }; detail.append(stop);
    }
    if (run.result) detail.append(el('div', run.result, 'agent-result-text'));
    if (run.error) detail.append(el('p', run.error, 'error'));
    const activity = el('details'), summary = el('summary', `Activity and receipts · ${events.length} events`); activity.append(summary);
    for (const event of events) {
      const row = el('div', undefined, 'agent-event'); row.append(el('strong', readable(event.kind)), el('pre', JSON.stringify(event.data, null, 2))); activity.append(row);
    }
    detail.append(activity);
  }
  async function refreshAgents() {
    if (!current || busy) return;
    busy = true;
    try {
      const data = await api('/api/agents'), next = JSON.stringify(data);
      if (next !== last) { last = next; renderAgents(data); }
      await refreshRun();
    } catch (e) { $('agentReadiness').textContent = `Agent state unavailable: ${e.message}`; }
    finally { busy = false; }
  }
  $('closeAgentEditor').onclick = () => $('agentEditor').close(); $('closeAgentLaunch').onclick = () => $('agentLaunch').close();
  $('agentEditorForm').onsubmit = async event => {
    event.preventDefault(); const submit = event.submitter; submit.disabled = true;
    try {
      const body = { name: $('agentName').value, description: $('agentDescription').value, goal: $('agentGoal').value, instructions: $('agentInstructions').value, output: $('agentOutput').value, toolIds: [...$('agentToolChoices').querySelectorAll('input:checked')].map(i => i.value), budgetBaseUnits: baseUnits($('agentBudget').value.trim()), perCallBaseUnits: baseUnits($('agentPerCall').value.trim()), maxSteps: Number($('agentSteps').value), maxDurationSeconds: Number($('agentDuration').value) };
      await api(editing ? `/api/agents/${editing.id}` : '/api/agents', editing ? { ...body, expectedVersion: editing.version } : body, editing ? 'PUT' : 'POST');
      $('agentEditor').close(); await refreshAgents();
    } catch (e) { $('agentEditorError').textContent = e.message; } finally { submit.disabled = false; }
  };
  $('agentLaunchForm').onsubmit = async event => {
    event.preventDefault(); $('launchAgent').disabled = true;
    try {
      const goal = $('agentLaunchGoal').value.trim();
      const previous = JSON.parse(localStorage.getItem(pendingKey) || 'null');
      if (previous && (previous.goal !== goal || previous.agentId !== launching.id)) throw new Error('A previous submission needs observation. Reopen that agent with the same goal before submitting new work.');
      const body = previous || { requestId: crypto.randomUUID(), agentId: launching.id, goal };
      localStorage.setItem(pendingKey, JSON.stringify(body));
      if (localStorage.getItem(pendingKey) !== JSON.stringify(body)) throw new Error('Cannot save the request ID safely. No run was submitted.');
      const { run } = await api('/api/agent-runs', body); selectedRun = run.id; localStorage.removeItem(pendingKey);
      $('agentLaunch').close(); await refreshAgents();
    } catch (e) { $('agentLaunchError').textContent = e.message; } finally { $('launchAgent').disabled = !catalog?.availability?.[launching?.id]?.ready; }
  };
  window.addEventListener('mandate:state', () => { void refreshAgents(); });
  void refreshAgents();
})();
