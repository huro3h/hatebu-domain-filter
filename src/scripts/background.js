importScripts('../lib/domainStore.js');

const { STORAGE_KEY, defaultData, getData } = DomainStore;

// chrome.action.setIcon's `path` needs fully-resolved extension URLs from a
// service worker; relative strings resolve against the wrong base.
function iconSet(suffix) {
  const sizes = [16, 32, 48, 128];
  return Object.fromEntries(
    sizes.map((size) => [size, chrome.runtime.getURL(`icons/icon${size}${suffix}.png`)])
  );
}

const ICON_ON = iconSet('');
const ICON_OFF = iconSet('-off');

async function refreshActionUi() {
  const data = await getData();
  chrome.action.setIcon({ path: data.enabled ? ICON_ON : ICON_OFF });
  chrome.action.setBadgeText({ text: data.enabled && data.domains.length ? String(data.domains.length) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#5f6368' });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(STORAGE_KEY, (result) => {
    if (!result[STORAGE_KEY]) {
      chrome.storage.local.set({ [STORAGE_KEY]: defaultData() }, refreshActionUi);
    } else {
      refreshActionUi();
    }
  });
});

chrome.runtime.onStartup.addListener(refreshActionUi);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.hasOwn(changes, STORAGE_KEY)) refreshActionUi();
});

// No popup: the toolbar icon is a shortcut to the settings page.
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
