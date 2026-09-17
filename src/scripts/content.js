(function () {
  'use strict';

  const HIDDEN_CLASS = 'hdf-hidden';
  const CARD_CLASS = 'hdf-card';
  const BUTTON_CLASS = 'hdf-block-btn';
  const TOAST_ID = 'hdf-toast';

  // Every entry card on b.hatena.ne.jp links its source domain as
  // "/site/<host>/" ("『<host>』の新着エントリー"). That link is the one piece
  // of markup shared by every list layout, so it — not the card class — is
  // what we search for.
  const SITE_LINK_SELECTOR = [
    'a[href^="/site/"]',
    'a[href^="https://b.hatena.ne.jp/site/"]',
    'a[href^="http://b.hatena.ne.jp/site/"]',
  ].join(',');

  // The element to actually hide, given a site link. Two layouts exist:
  // - top / hotentry / entrylist / site: li.entrylist-image-entry > div.entrylist-contents
  // - search results:                    li.bookmark-item > div.centerarticle-entry
  // Prefer the outer <li> so no empty list item (with its margins and
  // separator border) is left behind; the inner container is the fallback for
  // layouts that drop the <li> wrapper.
  const OUTER_CARD_SELECTOR = 'li.entrylist-image-entry, li.bookmark-item, li.js-keyboard-selectable-item';
  const INNER_CARD_SELECTOR = '.entrylist-contents, .centerarticle-entry';

  const BLOCK_ICON_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="8.4"></circle><line x1="6.1" y1="17.9" x2="17.9" y2="6.1"></line></svg>';

  // "/site/<host>/" pages are a single domain's own listing: filtering there
  // would just blank the page the user deliberately opened. The hide button
  // still works (registering from a site page is useful), only the hiding is
  // skipped.
  const filteringAllowedHere = !location.pathname.startsWith('/site/');

  const domainCache = new WeakMap();
  let blocked = new Set();

  function extensionAlive() {
    try {
      return !!chrome.runtime?.id;
    } catch (e) {
      return false;
    }
  }

  function cardOf(link) {
    return link.closest(OUTER_CARD_SELECTOR) || link.closest(INNER_CARD_SELECTOR);
  }

  function domainOfLink(link) {
    let path;
    try {
      path = new URL(link.href, location.href).pathname;
    } catch (e) {
      return null;
    }
    const m = /^\/site\/([^/]+)/.exec(path);
    if (!m) return null;
    try {
      return decodeURIComponent(m[1]).toLowerCase();
    } catch (e) {
      return m[1].toLowerCase();
    }
  }

  function domainOfCard(card) {
    if (domainCache.has(card)) return domainCache.get(card);
    const link = card.querySelector(SITE_LINK_SELECTOR);
    const domain = link ? domainOfLink(link) : null;
    domainCache.set(card, domain);
    return domain;
  }

  function applyCard(card) {
    card.classList.add(CARD_CLASS);
    const domain = domainOfCard(card);
    const hide = filteringAllowedHere && !!domain && blocked.has(domain);
    card.classList.toggle(HIDDEN_CLASS, hide);
  }

  function scan(root) {
    if (!root) return;
    if (root.nodeType === Node.ELEMENT_NODE && root.matches(SITE_LINK_SELECTOR)) {
      const card = cardOf(root);
      if (card) applyCard(card);
    }
    if (typeof root.querySelectorAll !== 'function') return;
    for (const link of root.querySelectorAll(SITE_LINK_SELECTOR)) {
      const card = cardOf(link);
      if (card) applyCard(card);
    }
  }

  // Re-evaluate everything already marked, so removing a domain un-hides its
  // cards without a reload, then pick up anything not seen yet.
  function applyAll() {
    for (const card of document.querySelectorAll('.' + CARD_CLASS)) applyCard(card);
    scan(document);
  }

  // ---- hide button -------------------------------------------------------

  function ensureButton(card) {
    if (card.querySelector('.' + BUTTON_CLASS)) return;
    const domain = domainOfCard(card);
    if (!domain) return;
    const link = card.querySelector(SITE_LINK_SELECTOR);
    if (!link) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = BUTTON_CLASS;
    btn.title = `${domain} の記事を非表示にする`;
    btn.innerHTML = `${BLOCK_ICON_SVG}<span class="hdf-block-btn-label">非表示</span>`;
    btn.addEventListener('click', async (event) => {
      // The card itself is clickable in places; keep the click from opening
      // the entry underneath.
      event.preventDefault();
      event.stopPropagation();
      if (!extensionAlive()) return;
      const { added, reason } = await DomainStore.addDomain(domain);
      // storage.onChanged re-applies the filter, so the card disappears on its
      // own — no need to hide it here.
      showToast(domain, reason === 'duplicate' && !added);
    });

    link.insertAdjacentElement('afterend', btn);
  }

  // ---- toast -------------------------------------------------------------

  let toastTimer = null;

  function showToast(domain, alreadyRegistered) {
    if (!document.body) return;

    let toast = document.getElementById(TOAST_ID);
    if (!toast) {
      toast = document.createElement('div');
      toast.id = TOAST_ID;
      document.body.appendChild(toast);
    }
    toast.textContent = '';

    const text = document.createElement('span');
    text.className = 'hdf-toast-text';
    text.textContent = alreadyRegistered
      ? `${domain} はすでに非表示ドメインです`
      : `${domain} を非表示にしました`;
    toast.appendChild(text);

    if (!alreadyRegistered) {
      const undo = document.createElement('button');
      undo.type = 'button';
      undo.className = 'hdf-toast-undo';
      undo.textContent = '取り消し';
      undo.addEventListener('click', async () => {
        if (extensionAlive()) await DomainStore.removeDomainByValue(domain);
        hideToast();
      });
      toast.appendChild(undo);
    }

    toast.classList.add('hdf-toast-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 6000);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    const toast = document.getElementById(TOAST_ID);
    if (toast) toast.classList.remove('hdf-toast-visible');
  }

  // ---- wiring ------------------------------------------------------------

  async function refresh() {
    if (!extensionAlive()) return;
    const data = await DomainStore.getData();
    blocked = DomainStore.compile(data).blocked;
    applyAll();
  }

  // Runs at document_start: the observer is attached before the entry list is
  // parsed, so cards are hidden as they arrive rather than after first paint.
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) scan(node);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // The button is created on demand instead of up front: a hotentry page holds
  // dozens of cards and most are never hovered.
  document.addEventListener('mouseover', (event) => {
    const target = event.target;
    if (!target || target.nodeType !== Node.ELEMENT_NODE) return;
    const card = target.closest(`.${CARD_CLASS}`);
    if (card && !card.classList.contains(HIDDEN_CLASS)) ensureButton(card);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && Object.hasOwn(changes, DomainStore.STORAGE_KEY)) refresh();
  });

  refresh();
  document.addEventListener('DOMContentLoaded', applyAll);
})();
