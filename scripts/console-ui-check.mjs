// Run against an isolated local database: CONSOLE_TEST_PASSWORD=... node scripts/console-ui-check.mjs
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const base = process.env.CONSOLE_URL ?? 'http://127.0.0.1:4399';
assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname), 'Only local acceptance is allowed');
assert(process.env.CONSOLE_TEST_PASSWORD, 'CONSOLE_TEST_PASSWORD is required');
const out = resolve(root, '.codex/ui-review');
await mkdir(out, { recursive: true });
const html = await readFile(resolve(root, 'admin/dist/index.html'), 'utf8');
assert.equal(await (await fetch(`${base}/admin/`)).text(), html, 'Preview must serve this exact build');
const browser = await chromium.launch({ headless: true, args: ['--disable-features=AutoDarkMode'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', reducedMotion: 'reduce' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') errors.push({ message: message.text(), location: message.location() }); });
const report = { build: createHash('sha256').update(html).digest('hex'), routes: [], checks: [], errors };
let originalEdit = null;
let languageRestore = null;
const readConfig = () => page.evaluate(async () => {
  const response = await fetch('/api/config');
  if (!response.ok) throw new Error(`config: ${response.status}`);
  return response.json();
});
const selectEditingLocale = async (locale) => {
  await page.locator('[data-locale-target]').selectOption(locale);
  // Native selection finishes before React Router commits the selected editor.
  await page.waitForFunction((expected) => {
    const panes = [...document.querySelectorAll('[data-editing-locale]')];
    return panes.length > 0 && panes.every((pane) => pane.dataset.editingLocale === expected);
  }, locale);
};
const selectReferenceLocale = async (locale) => {
  await page.locator('[data-locale-reference]').selectOption(locale);
  await page.waitForFunction((expected) => {
    const references = [...document.querySelectorAll('.locale-reference')];
    return references.length > 0 && references.every((reference) => reference.lang === expected);
  }, locale);
};
try {
  await page.goto(`${base}/admin/login`);
  await page.screenshot({ path: resolve(out, 'login-desktop.png'), fullPage: true });
  await page.locator('input[autocomplete="current-password"]').fill(process.env.CONSOLE_TEST_PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL((url) => url.origin === base && /^\/admin\/?$/.test(url.pathname));
  await page.locator('.dash-kpis .dash-card').first().waitFor();
  await page.locator('.dash-kpi-value').first().waitFor();
  report.checks.push('real-login');
  await context.storageState({ path: resolve(out, 'auth.json') });
  const routes = ['', 'content', 'content/languages', 'ai', 'content/downloads', 'content/stats', 'content/skus', 'content/faq', 'content/announcement', 'content/seo', 'content/legal', 'geo', 'publish', 'audit'];
  const expectedLocales = ['en', 'vi', 'es', 'pt', 'fr', 'de', 'ja', 'ko', 'zh'];
  const navPaths = await page.locator('.sidebar nav a').evaluateAll((links) => links.map((link) => new URL(link.href).pathname.replace(/^\/admin\/?/, '')));
  assert.deepEqual([...new Set(navPaths)].sort(), [...routes].sort(), 'All navigation routes must be covered');
  for (const width of [1440, 1024, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const route of routes) {
      await page.goto(`${base}/admin/${route}`);
      await page.locator('main h2').waitFor();
      await page.waitForLoadState('networkidle');
      const geometry = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, title: document.querySelector('main h2')?.textContent, fields: document.querySelectorAll('main input, main select, main textarea').length }));
      report.routes.push({ route, width, ...geometry });
      assert(geometry.scroll <= width + 1, `${route || 'dashboard'} overflows at ${width}: ${geometry.scroll}`);
      for (const choice of await page.locator('input[type=checkbox], input[type=radio]').all()) {
        if (!await choice.isVisible()) continue;
        const box = await choice.boundingBox();
        assert(box && box.width > 0 && box.width <= box.height * 2, `${route}: checkbox/radio inherits text-field width at ${width}`);
      }
      if (!route) assert(await page.locator('.dashboard a').evaluateAll((links) => links.every((link) => { const box = link.getBoundingClientRect(); return box.width >= 44 && box.height >= 44; })), `Dashboard link touch targets at ${width}`);
      if (width < 700 && ['publish', 'audit'].includes(route)) {
        const closedDetails = page.locator('details:not([open]) > summary');
        while (await closedDetails.count()) await closedDetails.first().click();
        const tables = page.locator('.table-scroll');
        assert(await tables.count() > 0, `${route}: no table scroll surface observed`);
        for (const table of await tables.all()) {
          await table.waitFor({ state: 'visible' });
          assert(await table.evaluate((element) => element.scrollWidth > element.clientWidth), `${route}: table columns compressed`);
          await table.focus();
          await page.keyboard.press('End');
          assert(await table.evaluate((element) => { element.scrollLeft = element.scrollWidth; return element.scrollLeft > 0; }), `${route}: table cannot scroll`);
          await table.evaluate((element) => { element.scrollLeft = 0; });
        }
      }
      if (width === 1440 || (width === 390 && ['', 'content/downloads', 'publish'].includes(route))) await page.screenshot({ path: resolve(out, `${route.replaceAll('/', '-') || 'dashboard'}-${width}.png`), fullPage: true });
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '打开导航' }).click();
  const sidebar = page.locator('.sidebar');
  await sidebar.waitFor({ state: 'visible' });
  assert(await sidebar.getByRole('link', { name: '网站文案', exact: true }).isVisible());
  await sidebar.getByRole('link', { name: '网站文案', exact: true }).click();
  await sidebar.waitFor({ state: 'hidden' });
  report.checks.push('mobile-menu-labeled-navigation');
  const focusChecks = [];
  for (const route of routes.filter((route) => route.startsWith('content'))) {
    await page.goto(`${base}/admin/${route}`);
    await page.locator('.editor-actions').waitFor();
    const edit = page.getByRole('button', { name: '编辑', exact: true });
    if (await edit.count()) await edit.first().click();
    await page.locator('#workspace').focus();
    let visited = 0;
    for (let step = 0; step < 500; step++) {
      await page.keyboard.press('Tab');
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      const focused = await page.evaluate(() => {
        const field = document.activeElement;
        if (!(field instanceof HTMLElement) || !field.closest('main')) return null;
        if (!field.closest('.editor-page') || field.closest('.editor-actions')) return { skip: true };
        const box = field.getBoundingClientRect();
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        const top = document.elementFromPoint(x, y);
        return { id: field.id || field.getAttribute('aria-label') || field.textContent, visible: !!top && (top === field || field.contains(top)) };
      });
      if (!focused) break;
      if (!focused.skip) { visited++; assert(focused.visible, `${route}: keyboard focus covered: ${focused.id}`); }
      assert(step < 499, `${route}: keyboard traversal did not finish`);
    }
    assert(visited > 0, `${route}: no editor controls checked`);
    focusChecks.push({ route, visited });
  }
  report.focusChecks = focusChecks;
  report.checks.push('all-editors-native-tab-focus-visible');
  for (const route of ['content/skus', 'content/faq']) {
    await page.goto(`${base}/admin/${route}`);
    const cards = page.locator('.card[draggable="true"]');
    await cards.first().waitFor();
    const order = await cards.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-field')));
    const down = cards.first().getByRole('button', { name: /下移/ });
    await down.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction((first) => document.querySelectorAll('.card[draggable="true"]')[1]?.getAttribute('data-field') === first, order[0]);
    assert(await cards.nth(1).evaluate((card) => card.contains(document.activeElement)), `${route}: reorder lost keyboard focus`);
    await page.getByRole('button', { name: '放弃本页未保存改动', exact: true }).click();
    assert.deepEqual(await cards.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-field'))), order);
  }
  report.checks.push('keyboard-reorder-and-discard-both-collections');
  for (const width of [320, 3840]) {
    await page.setViewportSize({ width, height: width === 3840 ? 2160 : 844 });
    for (const route of ['content', 'content/faq', 'content/skus', 'content/announcement', 'content/seo', 'content/legal', 'geo']) {
      await page.goto(`${base}/admin/${route}`);
      const target = page.locator('[data-locale-target]'); await target.waitFor();
      assert.deepEqual(await target.locator('option').evaluateAll((options) => options.map((option) => option.value)), expectedLocales);
      const expand = page.getByRole('button', { name: '编辑', exact: true }); if (await expand.count()) await expand.first().click();
      for (const locale of expectedLocales) {
        await selectEditingLocale(locale);
        await selectReferenceLocale(locale === 'en' ? 'vi' : 'en');
        assert.equal(await page.locator('.locale-reference input,.locale-reference textarea').count(), 0, 'Reference must never be writable');
        assert(await page.locator('.locale-target input,.locale-target textarea').evaluateAll((inputs, expected) => inputs.length > 0 && inputs.every((input) => input.lang === expected), locale), `${route}/${locale}: editing text language`);
        assert(await page.locator('.locale-target label,.locale-reference > .kv').evaluateAll((labels) => labels.every((label) => label.closest('[lang]')?.getAttribute('lang') === 'zh')), `${route}/${locale}: Chinese operation labels must keep Chinese language`);
        const panes = await page.locator('[data-editing-locale]').evaluateAll((nodes) => nodes.map((node) => ({ locale: node.dataset.editingLocale, width: node.getBoundingClientRect().width, parentWidth: node.parentElement.getBoundingClientRect().width })));
        assert(panes.length > 0 && panes.every((pane) => pane.locale === locale && pane.width >= pane.parentWidth * .4), `${route}/${locale}: collapsed or simultaneous language columns`);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${route}/${locale}: overflow at ${width}`);
      }
    }
  }
  report.checks.push('all-nine-languages-seven-editors-mobile-4k-single-target-readonly-reference');
  for (const [route, path, canonical] of [
    ['seo', 'seo.learn.description.fr', 'seo.pages.learn.description.fr'],
    ['seo', 'seo.pages.nex.title.ja', 'seo.pages.nex.title.ja'],
    ['legal', 'legal.privacy.de', 'legal.privacy.md.de'],
    ['legal', 'legal.appPrivacy.md.ko', 'legal.appPrivacy.md.ko'],
  ]) {
    await page.goto(`${base}/admin/content/${route}?focus=${encodeURIComponent(path)}`);
    await page.waitForFunction((expected) => document.activeElement?.getAttribute('data-field') === expected, canonical);
  }
  report.checks.push('reused-seo-and-legal-fields-deeplink-focus');
  await page.goto(`${base}/admin/content`);
  await page.locator('.locale-target textarea').first().waitFor();
  await selectEditingLocale('en');
  const beforeUnsaved = await readConfig();
  const englishOriginal = await page.locator('.locale-target textarea').first().inputValue();
  await page.locator('.locale-target textarea').first().fill(`${englishOriginal} [unsaved EN]`);
  await selectEditingLocale('ja');
  const japaneseOriginal = await page.locator('.locale-target textarea').first().inputValue();
  await page.locator('.locale-target textarea').first().fill(`${japaneseOriginal} [unsaved JA]`);
  await selectEditingLocale('en');
  assert.equal(await page.locator('.locale-target textarea').first().inputValue(), `${englishOriginal} [unsaved EN]`);
  await selectReferenceLocale('ja');
  assert((await page.locator('.locale-reference-text').first().textContent()).includes(`${japaneseOriginal} [unsaved JA]`), 'Reference must reflect current work copy without writing');
  await selectEditingLocale('ja');
  assert.equal(await page.locator('.locale-target textarea').first().inputValue(), `${japaneseOriginal} [unsaved JA]`);
  assert.deepEqual((await readConfig()).draft.payload, beforeUnsaved.draft.payload, 'Language switching must not save implicitly');
  await page.getByRole('button', { name: '放弃本页未保存改动', exact: true }).click();
  assert.equal(await page.locator('.locale-target textarea').first().inputValue(), japaneseOriginal);
  await selectEditingLocale('en');
  assert.equal(await page.locator('.locale-target textarea').first().inputValue(), englishOriginal);
  report.checks.push('cross-language-unsaved-values-reference-and-discard-real-ui');
  await page.goto(`${base}/admin/content/languages`);
  await page.locator('#language-zh').waitFor();
  const beforeLanguages = await readConfig();
  const originalZh = beforeLanguages.draft.payload.enabledLocales.includes('zh');
  const withoutLanguageSelection = (payload) => { const { enabledLocales, ...content } = payload; return content; };
  languageRestore = { originalZh, attemptedZh: originalZh };
  for (const enabled of [!originalZh, originalZh]) {
    await page.locator('#language-zh').setChecked(enabled);
    languageRestore.attemptedZh = enabled;
    const wrote = page.waitForResponse((response) => response.url().endsWith('/api/config/draft') && response.request().method() === 'PATCH');
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    assert.equal((await wrote).status(), 200, 'Language selection save');
    const saved = await readConfig();
    assert.equal(saved.draft.payload.enabledLocales.includes('zh'), enabled);
    assert(saved.draft.payload.enabledLocales.includes('en'), 'English default cannot be disabled');
    assert.deepEqual(saved.draft.payload.enabledLocales.filter((locale) => locale !== 'zh'), beforeLanguages.draft.payload.enabledLocales.filter((locale) => locale !== 'zh'));
    assert.deepEqual(withoutLanguageSelection(saved.draft.payload), withoutLanguageSelection(beforeLanguages.draft.payload), 'Disabling a language must preserve every translation and other setting');
    assert.deepEqual(saved.live, beforeLanguages.live, 'Saving language selection must not change the live selection or live content');
    await page.reload(); await page.locator('#language-zh').waitFor();
    assert.equal(await page.locator('#language-zh').isChecked(), enabled, 'Language selection must survive reload');
    const reloaded = await readConfig();
    assert.equal(reloaded.draft.payload.enabledLocales.includes('zh'), enabled);
    assert.deepEqual(reloaded.live, beforeLanguages.live);
  }
  languageRestore = null;
  report.checks.push('language-selection-real-save-readback-reload-restored-content-and-live-preserved');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${base}/admin/content`);
  await page.locator('[data-field] textarea').first().waitFor();
  await selectEditingLocale('en');
  const firstCard = page.locator('[data-field]').filter({ has: page.locator('textarea') }).first();
  const field = await firstCard.getAttribute('data-field');
  const key = field.replace(/^copy\./, '');
  const textarea = firstCard.locator('textarea').first();
  const original = await textarea.inputValue();
  originalEdit = { key, original };
  const edited = `${original} [UI acceptance]`;
  await textarea.fill(edited);
  let write = page.waitForResponse((r) => r.url().endsWith('/api/config/draft') && r.request().method() === 'PATCH');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  assert.equal((await write).status(), 200);
  const config = await page.evaluate(async () => { const response = await fetch('/api/config'); if (!response.ok) throw new Error(`config: ${response.status}`); return response.json(); });
  assert.equal(config.draft.payload.copy.en[key], edited);
  await page.reload();
  await page.locator('[data-field] textarea').first().waitFor();
  assert.equal(await page.locator(`[data-field="${field}"] textarea`).first().inputValue(), edited);
  report.checks.push('draft-save-api-readback-and-reload');
  await page.locator(`[data-field="${field}"] textarea`).first().fill(original);
  write = page.waitForResponse((r) => r.url().endsWith('/api/config/draft') && r.request().method() === 'PATCH');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  assert.equal((await write).status(), 200);
  const restored = await page.evaluate(async () => { const response = await fetch('/api/config'); if (!response.ok) throw new Error(`config: ${response.status}`); return response.json(); });
  assert.equal(restored.draft.payload.copy.en[key], original);
  originalEdit = null;
  report.checks.push('draft-restored');
  await page.goto(`${base}/admin/`);
  for (const days of [30, 90, 7]) {
    const response = page.waitForResponse((r) => r.url().endsWith(`/api/dash?range=${days}`));
    await page.getByRole('button', { name: `近 ${days} 天`, exact: true }).click();
    assert.equal((await response).status(), 200);
    await page.locator('.dash-kpi-value').first().waitFor();
    assert.equal(await page.locator('.dashboard .card').count(), 16);
  }
  report.checks.push('all-date-ranges-real-api');
  const sample = await page.evaluate(async () => (await fetch('/api/dash?range=90')).json());
  const firstDay = Date.parse(`${sample.from}T00:00:00Z`);
  const lastDay = Date.parse(`${sample.to}T00:00:00Z`);
  sample.trend = Array.from({ length: Math.round((lastDay - firstDay) / 86400000) + 1 }, (_, i) => ({ date: new Date(firstDay + i * 86400000).toISOString().slice(0, 10), uv: 10, pv: 20, cta: 2 }));
  await page.route('**/api/dash?range=90', (route) => route.fulfill({ json: sample }));
  await page.getByRole('button', { name: '近 90 天', exact: true }).click();
  await page.locator('.dash-chart-point').first().waitFor();
  for (const width of [1440, 1024, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator('.dash-chart-layout').scrollIntoViewIfNeeded();
    const points = page.locator('.dash-chart-point');
    for (const index of [0, 1, 8, 29, 45, sample.trend.length - 2, sample.trend.length - 1]) {
      const box = await points.nth(index).boundingBox();
      assert(box, 'Missing plotted point');
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      assert.equal(await page.locator('.dash-chart-readout time').textContent(), sample.trend[index].date, `dense chart selected wrong date at ${width}`);
    }
    const picker = page.getByRole('combobox', { name: '查看日期' });
    await picker.selectOption(sample.trend[15].date);
    assert.equal(await page.locator('.dash-chart-readout time').textContent(), sample.trend[15].date);
    const target = await picker.boundingBox();
    assert(target && target.height >= 44 && target.width >= 44, 'Date selector touch target');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Chart overflow');
  }
  await page.unroute('**/api/dash?range=90');
  report.checks.push('dense-trend-pointer-and-date-selection-browser-fixture');
  await page.goto(`${base}/admin/setup`);
  await page.getByRole('heading', { name: '已初始化' }).waitFor();
  report.checks.push('initialized-account-protected');
  const finalBuilt = await readFile(resolve(root, 'admin/dist/index.html'), 'utf8');
  assert.equal(await (await fetch(`${base}/admin/`)).text(), finalBuilt, 'Final preview differs from admin/dist/index.html');
  assert.equal(finalBuilt, html, 'Build changed during UI acceptance');
  report.checks.push('build-unchanged-through-acceptance');
  assert.deepEqual(errors, [], 'Browser errors must be investigated');
} finally {
  if (languageRestore) {
    const restored = await page.evaluate(async ({ originalZh, attemptedZh }) => {
      const response = await fetch('/api/config');
      if (!response.ok) return false;
      const config = await response.json();
      const current = config.draft.payload.enabledLocales.includes('zh');
      if (current === originalZh) return true;
      if (current !== attemptedZh) return false;
      // Restore only the option this test changed; preserve all other current draft fields.
      const before = config.draft.payload.enabledLocales;
      const after = originalZh ? [...before, 'zh'] : before.filter((locale) => locale !== 'zh');
      const write = await fetch('/api/config/draft', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operations: [{ op: 'set', fieldId: '/enabledLocales', before, after }], baseRevision: config.draft.draftRev }) });
      if (!write.ok) return false;
      const readback = await fetch('/api/config');
      return readback.ok && (await readback.json()).draft.payload.enabledLocales.includes('zh') === originalZh;
    }, languageRestore).catch(() => false);
    if (!restored) report.unrestoredLanguageSelection = true;
  }
  if (originalEdit) {
    const restored = await page.evaluate(async ({ key, original }) => {
      const response = await fetch('/api/config');
      if (!response.ok) return false;
      const config = await response.json();
      if (config.draft.payload.copy.en[key] !== `${original} [UI acceptance]`) return false;
      const fieldId = '/copy/en/' + key.replaceAll('~', '~0').replaceAll('/', '~1');
      const result = await fetch('/api/config/draft', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operations: [{ op: 'set', fieldId, before: config.draft.payload.copy.en[key], after: original }], baseRevision: config.draft.draftRev }) });
      return result.ok;
    }, originalEdit).catch(() => false);
    if (!restored) report.unrestoredDraft = originalEdit.key;
  }
  await writeFile(resolve(out, 'runtime.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
assert(!report.unrestoredDraft && !report.unrestoredLanguageSelection, 'Acceptance could not restore its temporary draft changes');
console.log(JSON.stringify({ result: 'pass', build: report.build, routes: report.routes.length, checks: report.checks, errors: errors.length }));
