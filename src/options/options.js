(function () {
  'use strict';

  const els = {
    enabled: document.getElementById('enabled'),
    enabledLabel: document.getElementById('enabled-label'),
    addForm: document.getElementById('add-form'),
    addInput: document.getElementById('add-input'),
    addMessage: document.getElementById('add-message'),
    list: document.getElementById('domain-list'),
    count: document.getElementById('count'),
    empty: document.getElementById('empty'),
    bulk: document.getElementById('bulk'),
    bulkApply: document.getElementById('bulk-apply'),
    bulkReset: document.getElementById('bulk-reset'),
    bulkMessage: document.getElementById('bulk-message'),
  };

  // The bulk textarea is a free-text draft: while the user is editing it we
  // don't overwrite it from storage (e.g. when a card is hidden in another tab).
  let bulkDirty = false;

  const dateFormat = new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  function setMessage(el, text, ok) {
    el.textContent = text;
    el.classList.toggle('ok', !!ok);
  }

  function render(data) {
    els.enabled.checked = data.enabled;
    els.enabledLabel.textContent = data.enabled ? '有効' : '無効';

    const sorted = data.domains.slice().sort((a, b) => a.value.localeCompare(b.value));

    els.list.textContent = '';
    for (const entry of sorted) {
      const li = document.createElement('li');

      const value = document.createElement('span');
      value.className = 'domain-value';
      value.textContent = entry.value;
      li.appendChild(value);

      const date = document.createElement('span');
      date.className = 'domain-date';
      date.textContent = entry.createdAt ? dateFormat.format(new Date(entry.createdAt)) : '';
      li.appendChild(date);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove';
      remove.textContent = '削除';
      remove.title = `${entry.value} を削除`;
      remove.addEventListener('click', async () => {
        render(await DomainStore.removeDomain(entry.id));
      });
      li.appendChild(remove);

      els.list.appendChild(li);
    }

    els.count.textContent = data.domains.length ? `(${data.domains.length})` : '';
    els.empty.hidden = data.domains.length > 0;

    if (!bulkDirty) {
      els.bulk.value = sorted.map((d) => d.value).join('\n');
    }
  }

  async function reload() {
    render(await DomainStore.getData());
  }

  els.enabled.addEventListener('change', async () => {
    render(await DomainStore.setEnabled(els.enabled.checked));
  });

  els.addForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = els.addInput.value;
    if (!value.trim()) return;

    const { data, added, reason } = await DomainStore.addDomain(value);
    if (added) {
      els.addInput.value = '';
      setMessage(els.addMessage, `${added.value} を追加しました`, true);
    } else if (reason === 'duplicate') {
      setMessage(els.addMessage, `${DomainStore.normalizeDomain(value)} はすでに登録されています`);
    } else {
      setMessage(els.addMessage, 'ドメインとして読み取れませんでした');
    }
    render(data);
  });

  els.bulk.addEventListener('input', () => {
    bulkDirty = true;
    setMessage(els.bulkMessage, '');
  });

  els.bulkApply.addEventListener('click', async () => {
    const { data, invalid } = await DomainStore.replaceDomainsFromText(els.bulk.value);
    bulkDirty = false;
    render(data);
    if (invalid.length) {
      setMessage(els.bulkMessage, `${invalid.length}行を無視しました: ${invalid.slice(0, 3).join(', ')}`);
    } else {
      setMessage(els.bulkMessage, `${data.domains.length}件を保存しました`, true);
    }
  });

  els.bulkReset.addEventListener('click', async () => {
    bulkDirty = false;
    setMessage(els.bulkMessage, '');
    await reload();
  });

  // Keep the page in sync with hides done from a Hatena tab while it's open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && Object.hasOwn(changes, DomainStore.STORAGE_KEY)) reload();
  });

  reload();
})();
