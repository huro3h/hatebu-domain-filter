/**
 * Shared storage/data-model module for Hatebu Domain Filter.
 * Loaded as a plain script in the options page, the content script and the
 * service worker (attaches itself to `self.DomainStore`).
 */
(function (root) {
  'use strict';

  const STORAGE_KEY = 'hatebuDomainFilterData';

  function defaultData() {
    return {
      enabled: true,
      // [{ id, value, createdAt }] — `value` is a normalized hostname.
      // Matching is exact-host only (see normalizeDomain): registering
      // "example.com" does NOT hide "news.example.com".
      domains: [],
    };
  }

  function genId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Turn whatever the user typed into a bare hostname, or return null if it
   * can't be one. Accepts a full URL ("https://example.com/a?b=1"), a
   * host:port, or a bare host. IDNs come back punycoded, which is also the
   * form Hatena puts in its own "/site/<host>/" links, so the two sides match.
   */
  function normalizeDomain(input) {
    const raw = String(input || '').trim().toLowerCase();
    if (!raw) return null;

    let host = null;
    try {
      // The scheme is dropped by the URL parser either way; adding one lets a
      // bare host go through the same path as a pasted URL.
      host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `http://${raw}`).hostname;
    } catch (e) {
      return null;
    }

    // A trailing dot ("example.com.") is a valid FQDN but never what Hatena
    // renders, so treat it as the same host.
    host = host.replace(/\.$/, '');

    if (!host || host.length > 253) return null;
    // Require at least one dot: single labels ("localhost", a stray word typed
    // into the add form) are never article domains on Hatena.
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) return null;

    return host;
  }

  function getData() {
    return new Promise((resolve) => {
      chrome.storage.local.get(STORAGE_KEY, (result) => {
        const data = result[STORAGE_KEY];
        if (!data || !Array.isArray(data.domains)) {
          resolve(defaultData());
          return;
        }
        if (typeof data.enabled !== 'boolean') data.enabled = true;
        resolve(data);
      });
    });
  }

  function setData(data) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEY]: data }, resolve);
    });
  }

  async function addDomain(value) {
    const host = normalizeDomain(value);
    if (!host) return { data: await getData(), added: null, reason: 'invalid' };

    const data = await getData();
    if (data.domains.some((d) => d.value === host)) {
      return { data, added: null, reason: 'duplicate' };
    }

    const entry = { id: genId(), value: host, createdAt: Date.now() };
    data.domains.push(entry);
    await setData(data);
    return { data, added: entry, reason: null };
  }

  async function removeDomain(id) {
    const data = await getData();
    data.domains = data.domains.filter((d) => d.id !== id);
    await setData(data);
    return data;
  }

  async function removeDomainByValue(value) {
    const host = normalizeDomain(value);
    if (!host) return getData();
    const data = await getData();
    data.domains = data.domains.filter((d) => d.value !== host);
    await setData(data);
    return data;
  }

  async function setEnabled(enabled) {
    const data = await getData();
    data.enabled = !!enabled;
    await setData(data);
    return data;
  }

  /**
   * Replace the whole list from newline-separated text (the options page's
   * bulk edit box). Unparseable lines are reported back rather than dropped
   * silently, and duplicates collapse to the first occurrence. Existing
   * entries keep their id/createdAt so a no-op save doesn't reshuffle the list.
   */
  async function replaceDomainsFromText(text) {
    const data = await getData();
    const previous = new Map(data.domains.map((d) => [d.value, d]));
    const seen = new Set();
    const invalid = [];
    const next = [];

    for (const line of String(text || '').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const host = normalizeDomain(trimmed);
      if (!host) {
        invalid.push(trimmed);
        continue;
      }
      if (seen.has(host)) continue;
      seen.add(host);
      next.push(previous.get(host) || { id: genId(), value: host, createdAt: Date.now() });
    }

    data.domains = next;
    await setData(data);
    return { data, invalid };
  }

  /** Fast lookup structure for the content script. */
  function compile(data) {
    const enabled = !!data.enabled;
    return {
      enabled,
      blocked: enabled ? new Set(data.domains.map((d) => d.value)) : new Set(),
    };
  }

  root.DomainStore = {
    STORAGE_KEY,
    defaultData,
    normalizeDomain,
    getData,
    setData,
    addDomain,
    removeDomain,
    removeDomainByValue,
    setEnabled,
    replaceDomainsFromText,
    compile,
  };
})(typeof window !== 'undefined' ? window : self);
