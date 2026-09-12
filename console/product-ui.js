'use strict';

// Presentation-only product polish. Core payment, Ledger, run and recovery logic stays in workspace.js/agents.js.
(() => {
  const $ = id => document.getElementById(id);
  const compatStyle = document.createElement('style');
  compatStyle.textContent = 'body:not(.agent-mode) .compat-only{display:block!important}body:not(.agent-mode) #newMandate{display:none!important}.text-button,summary{min-height:44px}.text-button{min-width:44px}';
  document.head.append(compatStyle);
  $('loginTitle')?.setAttribute('aria-label', 'Let the agent work. Keep spending controlled.');

  const clickHiddenCreate = () => $('newMandate')?.click();
  $('createAgentShortcut')?.addEventListener('click', clickHiddenCreate);
  for (const button of document.querySelectorAll('[data-product-close]')) button.addEventListener('click', () => $(button.dataset.productClose)?.close());

  function polishPrimaryAction() {
    const button = $('agentHomePrimary');
    if (!button) return;
    if (button.textContent.trim() === 'Choose an agent') button.textContent = 'New task';
    if (button.textContent.trim() === 'Set up allowance') button.textContent = 'Set up budget';
  }

  function polishAgentCards() {
    const root = $('agentCards');
    if (!root) return;
    for (const card of root.querySelectorAll('.agent-card:not(.agent-create)')) {
      const primary = card.querySelector('.actions .primary');
      if (primary?.textContent.trim() === 'Give it a goal') { primary.setAttribute('aria-label', 'Give it a goal'); primary.textContent = 'Use agent'; }
      const allowance = card.querySelector('.agent-allowance');
      if (allowance) { const next = allowance.textContent.replace('Up to ', 'Run budget · ').replace(' per run', ''); if (next !== allowance.textContent) allowance.textContent = next; }
    }
  }

  function polishGuardrails() {
    const root = $('agentAllowanceFacts');
    if (!root) return;
    const rename = new Map([
      ['Shared allowance', 'Approved total'],
      ['Initial Ledger funding', 'Initial approval'],
      ['Confirmed increases', 'Added later'],
      ['Per-call limit', 'Max per purchase'],
      ['Rolling limit', 'Max per hour'],
      ['Allowed services', 'Approved services'],
    ]);
    const hide = new Set(['Ledger payer', 'Funded software wallet', 'Hedera payment account']);
    for (const row of root.children) {
      const dt = row.querySelector('dt');
      if (!dt) continue;
      const label = dt.textContent.trim();
      const shouldHide = hide.has(label); if (row.hidden !== shouldHide) row.hidden = shouldHide;
      if (rename.has(label)) dt.textContent = rename.get(label);
    }
  }

  function polishReviewFacts(root) {
    if (!root) return;
    const rename = new Map([
      ['Current allowance', 'Current approved'],
      ['Additional funding', 'Add'],
      ['New allowance', 'New approved total'],
      ['Per-call stays', 'Max per purchase'],
      ['Funded wallet', 'Destination'],
      ['Ledger payer', 'From Ledger'],
      ['Original Ledger payer', 'Return to Ledger'],
      ['Shared allowance', 'Approved total'],
      ['Per-call limit', 'Max per purchase'],
      ['Rolling limit', 'Max per hour'],
      ['Funded software wallet', 'Destination'],
      ['Allowed services', 'Approved services'],
      ['Observed balance', 'Unused balance'],
      ['Source block', 'Verified at block'],
    ]);
    for (const dt of root.querySelectorAll('dt')) {
      const label = dt.textContent.trim();
      if (rename.has(label)) dt.textContent = rename.get(label);
    }
  }

  function polishRunBoundary() {
    const node = $('agentLaunchLimits');
    if (!node) return;
    const raw = node.textContent.trim();
    if (!raw) return;
    const match = raw.match(/^([0-9.]+) test USDC maximum per run · ([0-9.]+) per call/);
    if (match) node.textContent = `Run budget · ${match[1]} test USDC   ·   Max per purchase · ${match[2]} test USDC. This run cannot increase your Ledger budget.`;
  }

  function polishStatusCopy() {
    for (const id of ['agentHomeReadiness', 'agentReadiness']) {
      const node = $(id); if (!node) continue;
      const raw = node.textContent.trim();
      if (/^Ready:.*x402/i.test(raw) || /testnet x402 services/i.test(raw)) node.textContent = 'Ready to run';
    }
    const connection = $('connectionText');
    if (connection?.textContent.trim() === 'Connected to local broker') connection.textContent = 'Local';
  }

  function polishReceipts() {
    for (const row of document.querySelectorAll('.agent-receipt')) {
      const link = row.querySelector('a');
      if (link && link.textContent.startsWith('View verified transfer')) link.textContent = 'View transaction';
    }
  }

  function syncCompatibilityState() {
    const agentMode = document.body.classList.contains('agent-mode');
    for (const root of document.querySelectorAll('.compat-only')) {
      if (agentMode) root.setAttribute('aria-hidden', 'true');
      else root.removeAttribute('aria-hidden');
    }
  }

  function ensurePrimaryView() {
    const workspace = $('workspace');
    if (!workspace || workspace.hidden) return;
    const views = [...document.querySelectorAll('.product-view[data-view]')];
    if (views.some(view => !view.hidden)) return;
    document.querySelector('nav [data-navigate="home"]')?.click();
  }

  function polish() {
    polishPrimaryAction();
    polishAgentCards();
    polishGuardrails();
    polishReviewFacts($('agentFundingReviewFacts'));
    polishReviewFacts($('agentIncreaseReviewFacts'));
    polishReviewFacts($('agentReturnReviewFacts'));
    const fundingFacts = $('agentFundingReviewFacts');
    if (fundingFacts) for (const row of fundingFacts.children) { const label = row.querySelector('dt')?.textContent.trim(); if (label === 'Hedera payment account') row.hidden = true; }
    polishRunBoundary();
    polishStatusCopy();
    polishReceipts();
    syncCompatibilityState();
    ensurePrimaryView();
  }

  window.addEventListener('mandate:state', () => setTimeout(polish, 0));
  const observer = new MutationObserver(polish);
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'class'] });
  polish();
})();
