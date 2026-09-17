/**
 * End-to-end check for Hatebu Domain Filter, run against the live
 * b.hatena.ne.jp (there is no fixture: the point is to catch Hatena's markup
 * changing under us).
 *
 * Playwright drives Brave Browser Nightly — retail Chrome silently ignores
 * --load-extension, so an unpacked extension never loads there.
 *
 *   cd /tmp/scratch && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright
 *   NODE_PATH=/tmp/scratch/node_modules node test/e2e.js
 */
const { chromium } = require('playwright');
const os = require('os'), path = require('path'), fs = require('fs');

const BRAVE = '/Applications/Brave Browser Nightly.app/Contents/MacOS/Brave Browser Nightly';
const EXT = path.resolve(__dirname, '..');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const hiddenState = (page, domain) =>
  page.evaluate((d) => {
    const cards = [...document.querySelectorAll('.hdf-card')].filter((c) => c.querySelector(`a[href^="/site/${d}/"]`));
    return { total: cards.length, hidden: cards.filter((c) => getComputedStyle(c).display === 'none').length };
  }, domain);

(async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hdf-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: BRAVE,
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });

  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  await page.goto('https://b.hatena.ne.jp/hotentry/all', { waitUntil: 'domcontentloaded', timeout: 90000 });
  // `li.entrylist-image-entry` is also used by empty ad placeholders
  // (`.river-placement`), which never become visible — wait for a real card.
  await page.waitForSelector('li.entrylist-image-entry:not(.river-placement)', { timeout: 60000 });
  await page.waitForSelector('.hdf-card', { timeout: 20000 });

  const marked = await page.evaluate(() => document.querySelectorAll('.hdf-card').length);
  check('hotentry: cards detected by content script', marked > 10, `${marked} cards`);

  // Prefer a domain with several entries, so "hides every card of a domain"
  // is actually exercised.
  const target = await page.evaluate(() => {
    const counts = new Map();
    for (const card of document.querySelectorAll('.hdf-card')) {
      const a = card.querySelector('a[href^="/site/"]');
      if (!a) continue;
      const d = decodeURIComponent(new URL(a.href, location.href).pathname.split('/')[2] || '');
      counts.set(d, (counts.get(d) || 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    return sorted.length ? { domain: sorted[0][0], count: sorted[0][1] } : null;
  });
  check('hotentry: a source domain was readable from a card', !!target, target && `${target.domain} x${target.count}`);

  const card = page.locator(`.hdf-card:has(a[href^="/site/${target.domain}/"])`).first();
  await card.scrollIntoViewIfNeeded();
  await card.hover();
  const btn = card.locator('.hdf-block-btn');
  await btn.waitFor({ state: 'attached', timeout: 10000 });
  check('hover: hide button becomes visible', (await btn.evaluate((el) => getComputedStyle(el).opacity)) === '1');
  await btn.click();

  await page.waitForFunction(
    (d) => [...document.querySelectorAll(`.hdf-card:has(a[href^="/site/${d}/"])`)].every((c) => getComputedStyle(c).display === 'none'),
    target.domain, { timeout: 10000 }
  );
  const afterClick = await hiddenState(page, target.domain);
  check('click: every card of that domain is hidden', afterClick.total > 0 && afterClick.total === afterClick.hidden, JSON.stringify(afterClick));

  const toast = await page.evaluate(() => {
    const t = document.getElementById('hdf-toast');
    return t ? { text: t.textContent, visible: getComputedStyle(t).opacity === '1' } : null;
  });
  check('click: toast with undo is shown', !!toast && toast.visible && toast.text.includes('取り消し'), toast && toast.text);

  let sw = context.serviceWorkers()[0];
  for (let i = 0; i < 30 && !sw; i++) { await page.waitForTimeout(500); sw = context.serviceWorkers()[0]; }
  const extId = sw ? new URL(sw.url()).host : null;
  check('service worker is running', !!extId, extId);

  const optionsPage = await context.newPage();
  await optionsPage.goto(`chrome-extension://${extId}/src/options/options.html`);
  await optionsPage.waitForSelector('#domain-list li', { timeout: 10000 });
  const listed = await optionsPage.evaluate(() => [...document.querySelectorAll('.domain-value')].map((e) => e.textContent));
  check('options: hidden domain appears in the list', listed.includes(target.domain), listed.join(', '));
  check('options: bulk textarea mirrors the list', (await optionsPage.inputValue('#bulk')).split('\n').includes(target.domain));

  await optionsPage.fill('#add-input', 'https://www.example.com/some/article?x=1');
  await optionsPage.click('#add-form button[type=submit]');
  await optionsPage.waitForFunction(
    () => [...document.querySelectorAll('.domain-value')].some((e) => e.textContent === 'www.example.com'),
    null, { timeout: 5000 }
  );
  check('options: a pasted URL is normalized to a hostname', true, 'www.example.com');

  // Search results use the other layout (li.bookmark-item > .centerarticle-entry).
  const searchPage = await context.newPage();
  await searchPage.goto(`https://b.hatena.ne.jp/search/text?q=${encodeURIComponent(target.domain.split('.')[0])}`,
    { waitUntil: 'domcontentloaded', timeout: 90000 });
  await searchPage.waitForSelector('li.bookmark-item', { timeout: 60000 }).catch(() => {});
  const searchInfo = await searchPage.evaluate((d) => {
    const cards = [...document.querySelectorAll('li.bookmark-item')];
    const ofDomain = cards.filter((c) => c.querySelector(`a[href^="/site/${d}/"]`));
    return { cards: cards.length, ofDomain: ofDomain.length, hidden: ofDomain.filter((c) => getComputedStyle(c).display === 'none').length };
  }, target.domain);
  check('search page: cards of a hidden domain are hidden too',
    searchInfo.ofDomain === 0 || searchInfo.ofDomain === searchInfo.hidden, JSON.stringify(searchInfo));

  // "/site/<host>/" is that domain's own listing and is deliberately exempt.
  const sitePage = await context.newPage();
  await sitePage.goto(`https://b.hatena.ne.jp/site/${target.domain}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await sitePage.waitForSelector('.entrylist-contents', { timeout: 60000 }).catch(() => {});
  const siteInfo = await sitePage.evaluate(() => {
    const cards = [...document.querySelectorAll('.hdf-card')];
    return { cards: cards.length, hidden: cards.filter((c) => getComputedStyle(c).display === 'none').length };
  });
  check('site page of a hidden domain still shows its entries', siteInfo.cards > 0 && siteInfo.hidden === 0, JSON.stringify(siteInfo));

  // Global toggle: the checkbox is visually replaced by .switch-track, so
  // click the track rather than the (0-sized) input.
  await optionsPage.bringToFront();
  const badgeOn = await sw.evaluate(() => chrome.action.getBadgeText({}));
  await optionsPage.click('.switch-track');
  await page.waitForTimeout(800);
  const whileDisabled = await hiddenState(page, target.domain);
  const badgeOff = await sw.evaluate(() => chrome.action.getBadgeText({}));
  check('global toggle off: nothing is hidden', whileDisabled.hidden === 0, JSON.stringify(whileDisabled));
  check('toolbar badge tracks the state', badgeOn !== '' && badgeOff === '', JSON.stringify([badgeOn, badgeOff]));

  await optionsPage.click('.switch-track');
  await page.waitForTimeout(800);
  const whileEnabled = await hiddenState(page, target.domain);
  check('global toggle back on: cards are hidden again', whileEnabled.hidden === whileEnabled.total, JSON.stringify(whileEnabled));

  // Removing a domain must un-hide live, without a reload.
  await optionsPage.locator(`#domain-list li:has(.domain-value:text-is("${target.domain}")) .remove`).click();
  await page.bringToFront();
  await page.waitForFunction(
    (d) => [...document.querySelectorAll('.hdf-card')].filter((c) => c.querySelector(`a[href^="/site/${d}/"]`)).every((c) => getComputedStyle(c).display !== 'none'),
    target.domain, { timeout: 10000 }
  ).then(() => check('removing a domain un-hides its cards live', true))
   .catch((e) => check('removing a domain un-hides its cards live', false, String(e).slice(0, 120)));

  await context.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(2); });
