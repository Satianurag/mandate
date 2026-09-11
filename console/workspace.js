'use strict';
const $ = id => document.getElementById(id);
let csrf = '', current = null, fingerprint = '', selectedTask = null, timer = null;
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const pretty = value => JSON.stringify(value, null, 2);
const when = value => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
function units(value) {
  const n = BigInt(value ?? '0'), whole = n / 1000000n, fraction = String(n % 1000000n).padStart(6, '0').replace(/0+$/, '');
  return `${whole}${fraction ? '.' + fraction : ''}`;
}
function baseUnits(value) {
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value)) throw new Error('Use a non-negative decimal amount with at most six places.');
  const [whole, fraction = ''] = value.split('.'); return String(BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0')));
}
function badge(text, type = 'neutral') { return el('span', text, `badge ${type}`); }
function message(text, error = false) { $('globalMessage').textContent = text; $('globalMessage').className = `message${error ? ' error' : ''}`; $('globalMessage').hidden = !text; }
async function api(path, body, method) {
  const init = { method: method || (body === undefined ? 'GET' : 'POST'), credentials: 'same-origin', headers: {}, signal: AbortSignal.timeout(45000) };
  if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
  if (csrf) init.headers['x-mandate-csrf'] = csrf;
  const response = await fetch(path, init);
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error || `HTTP ${response.status}`); error.status = response.status; throw error; }
  return result;
}
function showLogin(error = '') { current = null; csrf = ''; $('workspace').hidden = true; $('loginPanel').hidden = false; $('logout').hidden = true; $('connectionDot').className = 'dot'; $('connectionText').textContent = 'Operator session required'; $('loginError').textContent = error; }
async function connect(token) {
  const session = await api('/api/session', { token }); csrf = session.csrf; $('token').value = ''; await refresh(true);
}
function statusType(state) { return ['succeeded','confirmed','funded','refunded','reconciled'].includes(state) ? 'success' : ['failed','stopped','denied','blocked'].includes(state) ? 'error' : ['uncertain','interrupted','pending','running','queued','awaiting_device','awaiting_signature'].includes(state) ? 'warning' : 'neutral'; }
function readable(state) { return String(state).replaceAll('_', ' '); }
function renderResult(task) {
  const container = $('result'); container.replaceChildren();
  if (!task) { container.append(el('div', 'No successful paid result exists yet. Run a task to obtain live, sourced data.', 'empty')); $('resultSource').textContent = 'No paid result yet'; return; }
  $('resultSource').textContent = `${task.kind === 'refund' ? 'Recovery' : 'Task'} · ${when(task.updated_at)}`;
  if (task.error) { container.append(el('p', task.error, 'result-error')); }
  if (!task.result) { if (!task.error) container.append(el('div', `Task ${readable(task.state)}. Device approval and payment confirmation cannot be simulated.`, 'empty')); return; }
  let result;
  try { result = JSON.parse(task.result); } catch { container.append(el('pre', task.result)); return; }
  const body = result.data || result;
  if (body.source) {
    const source = el('p', `Source: ${body.source.chain} · ${body.source.subgraphId}`, 'result-note'); container.append(source);
    if (body.observedAt) container.append(el('p', `Observed ${when(body.observedAt)}. The table reflects this query's selected fields.`, 'result-note'));
  }
  if (Array.isArray(body.rows)) {
    if (!body.rows.length) container.append(el('div', 'The live query returned no matching agent registrations.', 'empty'));
    else {
      const wrap = el('div', undefined, 'table-scroll'), table = el('table');
      const head = el('tr'); ['Registration','Agent wallet','Indexed feedback'].forEach(t => head.append(el('th',t))); table.append(head);
      for (const row of body.rows) { const tr = el('tr'); tr.append(el('td',row.agentId ?? row.id ?? 'Not selected'),el('td',row.agentWallet ?? 'Not selected','address'),el('td',row.totalFeedback ?? 'Not selected')); table.append(tr); }
      wrap.append(table); container.append(wrap);
    }
    container.append(el('p','Feedback counts and raw measurements are not comparable reputation ratings or permission to spend.','result-note'));
  }
  if (body.paid) container.append(el('p', `Payment stage: ${readable(body.paid.stage || 'receipt available')} · ${body.paid.amountBaseUnits ?? body.paid.amount} base units · ${body.paid.network || ''}`, 'result-note'));
  const detail = el('details'), summary = el('summary','Inspect complete result and payment receipt'); detail.append(summary,el('pre',pretty(result))); container.append(detail);
}
function renderHistory(tasks) {
  const root = $('history'); root.replaceChildren();
  if (!tasks.length) { root.append(el('p','No task has been submitted.','empty-inline')); return; }
  const table = el('table'), head = el('tr'); ['Task / request ID','State','Updated','Result'].forEach(t => head.append(el('th',t))); table.append(head);
  for (const task of tasks) {
    const row = el('tr'), id = el('td'), state = el('td'), action = el('td');
    id.append(el('strong', ({refund:'Remaining-funds recovery',settlement:'Merchant claim and settlement',evidence:'HCS evidence publication',query:'Agent0 query'})[task.kind] || task.kind),el('div',task.id,'event-meta'));
    state.append(badge(readable(task.state),statusType(task.state)));
    const button = el('button','Inspect','text-button'); button.type = 'button'; button.addEventListener('click', () => { selectedTask = task.id; renderResult(task); $('result').scrollIntoView({ block:'center', behavior: 'smooth' }); }); action.append(button);
    row.append(id,state,el('td',when(task.updated_at)),action); table.append(row);
  }
  root.append(table);
}
function renderEvidence(events) {
  const root = $('evidence'); root.replaceChildren();
  if (!events.length) { root.append(el('p','No execution events have been recorded.','empty-inline')); return; }
  for (const event of events.slice(0, 25)) {
    const row = el('div',undefined,'event'), main = el('div');
    main.append(el('div',event.kind,'event-title'),el('div',`${when(event.created_at)} · ${event.request_id || event.mandate_id}`,'event-meta'));
    const details = el('details'); details.append(el('summary','Inspect durable event'),el('pre',pretty({ id:event.id, hash:event.hash, previousHash:event.previous_hash, data:JSON.parse(event.data), hcsState:event.anchor_state, receipt:event.receipt ? JSON.parse(event.receipt) : null, anchoringError:event.error || null })));
    main.append(details); row.append(el('span',undefined,'event-marker'),main,badge(event.anchor_state === 'confirmed' ? 'HCS confirmed' : `HCS ${event.anchor_state || 'pending'}`,statusType(event.anchor_state || 'pending'))); root.append(row);
  }
}
function render(state) {
  const cfg = state.config, finance = state.financial, tasks = state.tasks;
  $('loginPanel').hidden = true; $('workspace').hidden = false; $('logout').hidden = false;
  $('legacyWarning').hidden = !state.legacy;
  if (state.legacy) $('legacyWarning').textContent = state.legacy.message;
  $('capLabel').textContent = finance?.deposit === 'funded' ? 'Confirmed funding ceiling' : 'Configured ceiling';
  $('cap').textContent = cfg ? `${units(cfg.ceilingBaseUnits)} USDC` : 'Not configured';
  $('spent').textContent = finance ? `${units(finance.spent)} USDC` : '—';
  $('reserved').textContent = finance ? `${units(finance.reserved)} USDC` : '—';
  $('remaining').textContent = finance?.state === 'refunded' ? `${units(finance.refundedBaseUnits)} USDC returned` : finance?.deposit !== 'funded' ? 'Not funded' : finance && cfg ? `${units(String(BigInt(cfg.ceilingBaseUnits) - BigInt(finance.spent) - BigInt(finance.reserved)))} USDC` : '—';
  const status = !cfg ? 'Not configured' : finance?.state === 'stopped' ? 'Stopped' : finance?.state === 'refunded' ? 'Refunded' : Date.parse(cfg.expiresAt) <= Date.now() ? 'Expired' : finance?.deposit === 'funded' ? 'Funded' : finance?.deposit === 'pending' ? 'Funding pending' : 'Not funded';
  $('mandateStatus').textContent = status; $('mandateStatus').className = `badge ${statusType(status.toLowerCase().replaceAll(' ','_'))}`;
  const facts = $('authorityFields'); facts.replaceChildren();
  const entries = cfg ? [['Network',cfg.network],['Receiver',cfg.receiver],['Per-call maximum',`${units(cfg.perCallBaseUnits)} USDC`],['Rolling budget',`${units(cfg.windowBaseUnits)} USDC / ${cfg.windowMs/60000} min`],['Permission expires',when(cfg.expiresAt)],['Resource',cfg.serviceUrl],['Ledger payer',cfg.operatorAddress],['Channel',finance?.channelId || 'No channel established']] : [['Spending authority','No reviewed mandate'],['Signing','Not requested'],['Next step','Review authority and check live dependencies']];
  for (const [term,value] of entries) { const item=el('div'); item.append(el('dt',term),el('dd',value)); facts.append(item); }
  const blocked = !cfg || ['stopped','refunded'].includes(finance?.state) || Date.parse(cfg.expiresAt) <= Date.now();
  $('runTask').disabled = blocked;
  $('fundingConsent').hidden = !cfg || finance?.deposit === 'funded';
  $('taskHint').textContent = !cfg ? 'Review a mandate before running paid work.' : blocked ? 'This mandate cannot authorize new work.' : finance?.deposit === 'funded' ? 'Uses the funded channel; no new deposit authority.' : 'The first paid task requires explicit Ledger funding approval.';
  $('stop').disabled = !cfg || ['stopped','refunded'].includes(finance?.state);
  $('refund').disabled = !cfg || !finance?.channelId || finance?.state === 'refunded';
  $('delegate').disabled = !cfg || finance?.deposit !== 'funded' || finance?.state !== 'active';
  $('reconcile').disabled = !finance?.channelId;
  $('settle').disabled = !state.merchantLifecycleAvailable || !finance?.channelId || finance?.deposit !== 'funded';
  $('publishEvidence').disabled = !state.hcsConfigured;
  $('anchorHint').textContent = state.hcsConfigured ? 'Explicit publication uses testnet HBAR. Local evidence remains available if HCS is unreachable.' : 'HCS publisher is not configured. Pending evidence is retained locally, not reported as confirmed.';
  const latest = tasks.find(t=>t.kind==='query') || tasks[0];
  $('taskStatus').textContent = latest ? readable(latest.state) : 'No task yet'; $('taskStatus').className=`badge ${statusType(latest?.state)}`;
  renderHistory(tasks); renderResult(tasks.find(t=>t.id===selectedTask) || tasks.find(t=>t.kind==='query'&&t.state==='succeeded') || latest);
  const events = [...state.events, ...(finance?.events || []), ...(state.merchantEvidence?.events || [])].sort((a,b)=>b.created_at-a.created_at);
  renderEvidence(events);
  const valid = state.eventChainValid && finance?.eventChainValid !== false && state.merchantEvidence?.eventChainValid !== false;
  $('chainIntegrity').textContent=valid?'Local hash chain verified':'Integrity check failed'; $('chainIntegrity').className=`badge ${valid?'success':'error'}`;
}
async function refresh(force = false) {
  try {
    const state = await api('/api/state'); current=state; csrf=state.csrf;
    $('connectionDot').className='dot connected'; $('connectionText').textContent='Connected to local broker';
    $('observedAt').textContent=`State checked ${when(state.observedAt)}`;
    const next = JSON.stringify([state.config,state.financial,state.tasks,state.events,state.merchantEvidence,state.legacy]);
    if (force || next!==fingerprint) { fingerprint=next; render(state); }
    if (!$('query').value) $('query').value=state.comparisonQuery;
  } catch (e) {
    if (e.status===401) showLogin();
    else { $('connectionDot').className='dot'; $('connectionText').textContent='Broker unavailable'; message(`Live state unavailable: ${e.message}`,true); $('runTask').disabled=true; }
  }
}
function fillConfig() {
  const cfg=current?.config, legacy=current?.legacy;
  for (const id of ['operatorAddress','rpcUrl','serviceUrl','asset','receiver','receiverAuthorizer','withdrawDelay','sessionKey']) if (cfg?.[id]!==undefined) $(id).value=cfg[id];
  if (!cfg && legacy) for (const id of ['rpcUrl','serviceUrl','receiver']) if(legacy[id]) $(id).value=legacy[id];
  $('ceilingInput').value=units(cfg?.ceilingBaseUnits || '100000');
  $('perCallInput').value=units(cfg?.perCallBaseUnits || '10000'); $('windowInput').value=units(cfg?.windowBaseUnits || '30000'); $('windowMinutes').value=String((cfg?.windowMs || 3600000)/60000);
  const date=cfg ? new Date(cfg.expiresAt) : new Date(Date.now()+3600000); date.setMinutes(date.getMinutes()-date.getTimezoneOffset()); $('expiresInput').value=date.toISOString().slice(0,16);
  $('configError').textContent=''; $('configDialog').showModal();
}
$('loginForm').addEventListener('submit',async event=>{event.preventDefault(); try{await connect($('token').value.trim());}catch(e){showLogin(e.message);}});
$('logout').addEventListener('click',async()=>{try{await api('/api/session',{},'DELETE');showLogin();}catch(e){message(e.message,true);}});
$('configure').addEventListener('click',fillConfig);
for(const button of document.querySelectorAll('[data-close]')) button.addEventListener('click',()=>$(button.dataset.close).close());
$('configForm').addEventListener('submit',async event=>{
  event.preventDefault(); $('configError').textContent='';
  try{
    const fields=Object.fromEntries(new FormData(event.target));
    const cfg={...fields,withdrawDelay:Number($('withdrawDelay').value),ceilingBaseUnits:baseUnits($('ceilingInput').value),perCallBaseUnits:baseUnits($('perCallInput').value),windowBaseUnits:baseUnits($('windowInput').value),windowMs:Number($('windowMinutes').value)*60000,expiresAt:new Date($('expiresInput').value).toISOString(),sessionKey:$('sessionKey').value,derivationPath:"44'/60'/0'/0/0"};
    await api('/api/config',cfg);$('configDialog').close();await refresh(true);message('Reviewed scope saved. No funds have been authorized or moved.');
  }catch(e){$('configError').textContent=e.message;}
});
$('readDevice').addEventListener('click',async()=>{
  const b=$('readDevice');b.disabled=true;$('configError').textContent='Reading the connected Ledger address. No signature is requested.';
  try{const result=await api('/api/device',{});$('operatorAddress').value=result.address;$('configError').textContent='Address read. Verify this is your intended payer; this was not payment approval.';}catch(e){$('configError').textContent=e.message;}finally{b.disabled=false;}
});
$('probeDraft').addEventListener('click',async()=>{
  const b=$('probeDraft');b.disabled=true;$('draftProbe').hidden=false;$('draftProbe').textContent='Reading the live chain and unpaid offer…';
  try{const result=await api('/api/preflight',{rpcUrl:$('rpcUrl').value,serviceUrl:$('serviceUrl').value});$('draftProbe').textContent=pretty(result);const offered=result.service?.requirements;if(offered){$('receiver').value=offered.payTo;$('asset').value=offered.asset;$('receiverAuthorizer').value=offered.extra.receiverAuthorizer;$('withdrawDelay').value=offered.extra.withdrawDelay;$('configError').textContent='Recipient, asset, authorizer and withdrawal delay came from this live offer. Independently review these proposed values before saving.';}}catch(e){$('draftProbe').textContent=e.message;}finally{b.disabled=false;}
});
$('preflight').addEventListener('click',async()=>{
  const b=$('preflight');b.disabled=true;$('preflightDetails').open=true;$('preflightResult').textContent='Checking live dependencies without signing or paying…';
  try{$('preflightResult').textContent=pretty(await api('/api/preflight',{}));await refresh();}catch(e){$('preflightResult').textContent=e.message;}finally{b.disabled=false;}
});
$('resetQuery').addEventListener('click',()=>{$('query').value=current?.comparisonQuery || '';});
$('taskForm').addEventListener('submit',async event=>{
  event.preventDefault();const b=$('runTask');b.disabled=true;
  try{if(current?.financial?.deposit!=='funded'&&!$('authorizeFunding').checked)throw new Error('Review and explicitly authorize initial funding before requesting a Ledger signature.');const result=await api('/api/tasks',{query:$('query').value,authorizeFunding:current?.financial?.deposit!=='funded'&&$('authorizeFunding').checked,requestId:crypto.randomUUID()});selectedTask=result.task.id;message(`Task ${result.task.id} queued. Follow the real device and payment state below.`);await refresh(true);}catch(e){message(e.message,true);}finally{if(current)await refresh();}
});
$('stop').addEventListener('click',async()=>{try{await api('/api/stop',{});message('New work stopped and agent capabilities revoked. Existing payments were not reversed.');await refresh(true);}catch(e){message(e.message,true);}});
$('reconcile').addEventListener('click',async()=>{try{const pending=current?.financial?.requests?.find(r=>['signed','uncertain'].includes(r.state));const result=await api('/api/reconcile',pending?{requestId:pending.id}:{});message(`Existing state reconciled without requesting a new payment: ${pretty(result.totals || result.snapshot || result)}`);await refresh(true);}catch(e){message(e.message,true);}});
$('settle').addEventListener('click',async()=>{try{if(!window.confirm('Claim accepted vouchers and settle merchant revenue on Base Sepolia? The facilitator pays testnet gas.'))return;const result=await api('/api/settle',{confirm:'claim_and_settle_testnet'});selectedTask=result.task.id;message('Merchant settlement requested. Waiting for on-chain reconciliation.');await refresh(true);}catch(e){message(e.message,true);}});
$('refund').addEventListener('click',()=>$('refundDialog').showModal());
$('confirmRefund').addEventListener('click',async()=>{try{const result=await api('/api/refund',{confirm:'request_refund'});selectedTask=result.task.id;$('refundDialog').close();message('Recovery requested. This is not yet a confirmed refund.');await refresh(true);}catch(e){message(e.message,true);$('refundDialog').close();}});
$('delegate').addEventListener('click',async()=>{try{const cap=await api('/api/capabilities',{query:$('query').value});message(`Scoped agent capability saved privately to ${cap.capabilityFile}. Run npm run agent -- --capability ${cap.capabilityFile}. The agent cannot fund, widen authority or recover funds.`);await refresh();}catch(e){message(e.message,true);}});
$('publishEvidence').addEventListener('click',async()=>{try{if(!window.confirm('Publish up to 20 pending signed records to Hedera testnet using the configured account? This uses testnet HBAR.'))return;message('Submitting signed anchors and waiting for consensus receipts.');const result=await api('/api/evidence/publish',{confirm:'publish_testnet_evidence'});selectedTask=result.task.id;message('Evidence publication queued. Each anchor becomes confirmed only after its consensus receipt.');await refresh(true);}catch(e){message(e.message,true);}});
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
  timer = setInterval(() => { if (!document.hidden && !connecting) void refresh(); }, 2500);
})();
