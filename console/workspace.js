'use strict';
const $ = id => document.getElementById(id);
let csrf = '', current = null, refreshing = false;
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const pretty = value => JSON.stringify(value, null, 2);
const when = value => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const readable = state => String(state ?? 'unknown').replaceAll('_', ' ');
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
    signal: AbortSignal.timeout(300000),
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

function statusType(s) { return ['completed','confirmed','funded','accepted'].includes(s)?'success':['failed','stopped','expired'].includes(s)?'error':['uncertain','pending','running','interrupted'].includes(s)?'warning':'neutral'; }
const views = new Set(['home','agents','task','history','evidence','settings']);
function normalizeView(view) {
  return view === 'authority' ? 'agents' : view;
}
function showDashboardView(view, focus=true) {
 if (!views.has(view)) view='home';
 for(const panel of document.querySelectorAll('[data-view]')) panel.hidden=panel.dataset.view!==view;
 for(const button of document.querySelectorAll('nav [data-navigate]')) {
  const active=button.dataset.navigate===view;button.classList.toggle('active',active);
  if(active)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');
 }
 history.replaceState(null,'',`${location.pathname}#${view}`);
 if(focus){const heading=document.querySelector(`[data-view="${view}"] h1`);if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}window.scrollTo(0,0);}
}
async function refresh() {
 if(refreshing)return;refreshing=true;
 try {
  const state=await api('/api/state');current=state;csrf=state.csrf;
  $('workspace').hidden=false;$('appSidebar').hidden=false;
  document.body.classList.add('is-connected');$('connectionDot').className='dot connected';$('connectionText').textContent='Connected';
  $('observedAt').textContent=`Checked ${when(state.observedAt)}`;
  window.dispatchEvent(new Event('mandate:state'));
 }catch(e){if(e.status===401){$('connectionText').textContent='Reconnect';message('Your local session expired. Reload to reconnect.',true);}else{$('connectionText').textContent='Reconnecting';message(`Broker unavailable: ${e.message}`,true);}}
 finally{refreshing=false;}
}
for(const button of document.querySelectorAll('[data-navigate]'))button.addEventListener('click',()=>showDashboardView(button.dataset.navigate));
for(const button of document.querySelectorAll('[data-product-close]'))button.addEventListener('click',()=>$(button.dataset.productClose).close());
async function start(){
 // Old token links are consumed without rendering a separate login screen.
 const token=new URLSearchParams(location.hash.slice(1)).get('token');
 if(token){history.replaceState(null,'',location.pathname);try{const session=await api('/api/session',{token});csrf=session.csrf;}catch(e){message(e.message,true);}}
 await refresh();
 const initial=normalizeView(location.hash.slice(1));
 showDashboardView(views.has(initial)?initial:'home',false);
}
window.addEventListener('hashchange',()=>{
 const view=normalizeView(location.hash.slice(1));
 if(view!==location.hash.slice(1))history.replaceState(null,'',`${location.pathname}#${view}`);
 showDashboardView(view);
});
setInterval(()=>{if(!document.hidden)void refresh();},5000);
void start();
