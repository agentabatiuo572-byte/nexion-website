// Built Admin acceptance with an isolated, in-memory API fixture. No Worker DB or deployment.
// Run after npm --prefix admin run build: node scripts/test-copy-hints-runtime.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startConsolePreview } from './console-preview.mjs';

await import('../worker/register-ts-ext.mjs');
const { LOCALES } = await import('../schema/src/locales.ts');
const { applyDraftPatch, enumerateDraftFields } = await import('../schema/src/draft-fields.ts');
const { validateConfig, sensitivePaths } = await import('../schema/src/validators.ts');
const { diffPaths } = await import('../schema/src/diff.ts');
const { SiteConfigSchema } = await import('../schema/src/site-config.ts');
const root = fileURLToPath(new URL('..', import.meta.url));
const out = resolve(root, '.cache/copy-length-correction/admin-runtime');
const json = async (path) => JSON.parse(await readFile(resolve(root, path), 'utf8'));
const hash = (value) => createHash('sha256').update(value).digest('hex');
async function treeHash(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const digest = createHash('sha256');
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const contentHash = entry.isDirectory() ? await treeHash(resolve(path, entry.name)) : hash(await readFile(resolve(path, entry.name)));
    digest.update(JSON.stringify([entry.name, entry.isDirectory(), contentHash]));
  }
  return digest.digest('hex');
}
async function checkGeoRendering() {
  const { Hono } = createRequire(new URL('../worker/package.json', import.meta.url))('hono');
  const { geoMiddleware, resetGeoCache, resetGeoLimiters } = await import('../worker/src/geo.ts');
  const { CORPUS } = await import('./calibrate-copy-layout.mjs');
  const result = { status: 'running', evidence: 'real-geoMiddleware-and-Hono-451-html / fake-D1-KV-only / Chromium', samples: [], risks: [], errors: [] };
  let rules, logWrites = 0;
  const unexpected = [];
  const env = { ENVIRONMENT: 'preview', BYPASS_SECRET: '',
    KV: { get: async (key) => { assert.equal(key, 'geo:rules'); return JSON.stringify(rules); } },
    DB: { prepare(sql) {
      const statement = { bind() { return statement; }, async first() {
        if (sql.includes('FROM geo_rule_state')) return null;
        if (sql.includes('FROM config_versions')) return { payload: JSON.stringify({ enabledLocales: LOCALES }) };
        unexpected.push(sql); throw new Error('Unexpected Geo fixture read');
      }, async run() {
        if (sql.startsWith('INSERT INTO raw_events')) { logWrites++; return { success: true }; }
        unexpected.push(sql); throw new Error('Unexpected Geo fixture write');
      } };
      return statement;
    } } };
  const app = new Hono();
  app.use('*', geoMiddleware);
  app.get('*', (context) => context.text('not blocked'));
  const browser = await chromium.launch({ headless: true, args: ['--disable-features=AutoDarkMode'] });
  const page = await browser.newPage({ colorScheme: 'dark' });
  page.on('pageerror', (error) => result.errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') result.errors.push(message.text()); });
  const views = [{ width: 320, height: 844 }, { width: 390, height: 844 }, { width: 1440, height: 900 },
    { width: 2560, height: 900 }, { width: 390, height: 360 }, { width: 1440, height: 360 }];
  try {
    for (const variant of ['short', 'ordinary-max', 'unbroken-max']) {
      const specimen = (locale, max) => variant === 'unbroken-max' ? 'W'.repeat(max)
        : CORPUS[locale][0].repeat(20).slice(0, variant === 'short' ? 20 : max).trimEnd();
      rules = { enabled: true, countries: ['CN'], blockPage: {
        title: Object.fromEntries(LOCALES.map((locale) => [locale, specimen(locale, 120)])),
        body: Object.fromEntries(LOCALES.map((locale) => [locale, specimen(locale, 300)])) } };
      resetGeoCache(); resetGeoLimiters();
      for (const locale of LOCALES) {
        const response = await app.request(locale === 'en' ? '/' : `/${locale}/`, {
          headers: { accept: 'text/html', 'x-geo-sim': 'CN', 'cf-connecting-ip': '192.0.2.21' },
        }, env);
        assert.equal(response.status, 451, `${locale}: the real Geo middleware must generate the response`);
        const html = await response.text();
        for (const view of views) {
          await page.setViewportSize(view);
          await page.setContent(html);
          const geometry = await page.evaluate(() => {
            const main = document.querySelector('main'), title = main.querySelector('h1'), body = main.querySelector('p');
            const box = main.getBoundingClientRect();
            return { locale: document.documentElement.lang, title: title.textContent, body: body.textContent,
              titleSize: parseFloat(getComputedStyle(title).fontSize), bodySize: parseFloat(getComputedStyle(body).fontSize),
              mainHeight: box.height, left: box.left, right: box.right, top: box.top, bottom: box.bottom,
              scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight };
          });
          assert.equal(geometry.locale, locale, 'Published locale must select the matching Geo text');
          assert.equal(geometry.title, rules.blockPage.title[locale]);
          assert.equal(geometry.body, rules.blockPage.body[locale]);
          assert.equal(geometry.titleSize, 19); assert.equal(geometry.bodySize, 15);
          assert(geometry.top >= -1 && geometry.scrollHeight >= geometry.bottom - 1, 'The entire Geo copy must remain vertically reachable');
          const sample = { locale, variant, viewport: view, htmlHash: hash(html), titleLength: geometry.title.length,
            bodyLength: geometry.body.length, ...Object.fromEntries(Object.entries(geometry).filter(([key]) => !['title', 'body'].includes(key))) };
          result.samples.push(sample);
          const overflow = geometry.scrollWidth > view.width + 1 || geometry.left < -1 || geometry.right > view.width + 1;
          if (variant === 'unbroken-max') {
            if (overflow) result.risks.push({ locale, viewport: view, issue: 'unbroken-words-overflow-existing-Geo-layout', scrollWidth: geometry.scrollWidth, left: geometry.left, right: geometry.right });
          } else assert(!overflow, `${locale}/${view.width}: ordinary Geo prose must wrap within the viewport`);
          if (locale === 'en' && view.width === 390 && view.height === 360 && variant !== 'short') await page.screenshot({ path: resolve(out, `geo-${variant}-390.png`), fullPage: true });
        }
      }
    }
    for (const locale of LOCALES) {
      const at = (variant) => result.samples.find((row) => row.locale === locale && row.variant === variant && row.viewport.width === 320);
      assert(at('ordinary-max').mainHeight > at('short').mainHeight, `${locale}: the actual Geo page must grow naturally with prose`);
    }
    assert.equal(logWrites, LOCALES.length * 3, 'Geo responses must pass through the real middleware event path');
    assert.deepEqual(unexpected, []); assert.deepEqual(result.errors, []);
    result.status = 'pass-with-recorded-risk';
  } catch (error) { result.status = 'fail'; result.errors.push(error.stack ?? error.message); }
  finally { await browser.close(); resetGeoCache(); resetGeoLimiters(); }
  await writeFile(resolve(out, 'geo-report.json'), JSON.stringify(result, null, 2));
  return result;
}
await mkdir(out, { recursive: true });
if (process.argv.includes('--geo-only')) {
  const result = await checkGeoRendering();
  console.log(JSON.stringify({ status: result.status, samples: result.samples.length, risks: result.risks.length, errors: result.errors, report: resolve(out, 'geo-report.json') }));
  process.exit(result.status === 'fail' ? 1 : 0);
}
const seed = await json('worker/seed/site-config.seed.json');
const manifest = await json('worker/seed/copy-manifest.json');
const policies = await json('admin/src/lib/text-layout-limits.json');
assert.equal(policies.version, 2, 'Only corrected version-2 recommendations may enter runtime acceptance');
const built = await readFile(resolve(root, 'admin/dist/index.html'), 'utf8');
const sourceHash = await treeHash(resolve(root, 'admin/src'));
const buildHash = await treeHash(resolve(root, 'admin/dist'));
const report = { status: 'running', evidence: 'built-admin-browser / in-memory-api-fixture / real-schema-and-patch-functions',
  limits: 'No real Worker persistence, AI provider call, managed publisher, or public deployment is exercised.',
  sourceHash, buildHash, policyHash: hash(JSON.stringify(policies)), locales: LOCALES,
  disabledLocales: LOCALES.filter((locale) => !seed.enabledLocales.includes(locale)),
  fields: [], defaults: [], boundaries: [], roundtrips: [], previews: [], referenceBreaks: [], checks: [], requests: [], failures: [], errors: [] };
let draft = structuredClone(seed), revision = 1, aiText = '', publishCalls = 0;
let checkingDefaults = true;
const live = structuredClone(seed);
const overview = () => ({ liveVersion: 1, livePublishedAt: 1, geo: { enabled: false, countries: 0, degraded: false },
  drift: null, lastPublishFailed: null, draft: { payload: draft, draftRev: revision, updatedAt: Date.now() },
  live: { payload: live }, dirty: diffPaths(live, draft).length, changedPaths: diffPaths(live, draft), sensitiveChanged: sensitivePaths(diffPaths(live, draft)) });
const geo = { rules: { enabled: false, countries: [], blockPage: {
  title: Object.fromEntries(LOCALES.map((locale) => [locale, 'Service unavailable'])),
  body: Object.fromEntries(LOCALES.map((locale) => [locale, 'Please contact support.'])) } },
  degraded: false, authority: { status: 'ready', source: 'd1', version: 1, currentFingerprint: 'isolated-copy-hint-fixture' },
  bypassAvailable: true, stats: { last7: [], todayLive: 0, blocked7: 0, shareOfRequests: 0 } };
const cases = [
  { route: 'content/skus', ids: seed.skus.map((sku) => sku.id), expand: (id) => `skus.${id}`,
    fields: (id, locale) => [{ id: `sku-${id}-name`, path: `/skus/${id}/name`, shared: true }, { id: `sku-${id}-${locale}`, path: `/skus/${id}/tagline/${locale}` }] },
  { route: 'content/faq', ids: seed.faq.items.filter((item) => !item.deleted).map((item) => item.id), expand: (id) => `faq.items.${id}`,
    fields: (id, locale) => ['q', 'a'].map((field) => ({ id: `faq-${id}-${field}-${locale}`, path: `/faq/items/${id}/${field}/${locale}` })) },
  { route: 'content/announcement', ids: ['text'], fields: (_, locale) => [{ id: `announcement-${locale}`, path: `/announcement/text/${locale}` }] },
  { route: 'content/seo', ids: Object.keys(seed.seo.pages), tab: (id) => `seo.pages.${id}`,
    fields: (id, locale) => ['title', 'description'].map((field) => ({ id: `seo-${id}-${field}-${locale}`, path: `/seo/pages/${id}/${field}/${locale}` })) },
  { route: 'content/legal', ids: Object.keys(seed.legal), tab: (id) => `legal.${id}`,
    fields: (id, locale) => [{ id: 'legal-source', path: `/legal/${id}/md/${locale}` }] },
  { route: 'geo', ids: ['blockPage'], fields: (_, locale) => ['title', 'body'].map((field) => ({ id: `geo-${field}-${locale}`, path: `/geo/blockPage/${field}/${locale}` })) },
];
let preview, browser, page;
const input = (id) => page.locator(`[id=${JSON.stringify(id)}]`);
async function selectLocale(locale) {
  await page.locator('[data-locale-target]').selectOption(locale);
  await page.waitForFunction((expected) => {
    const panes = [...document.querySelectorAll('[data-editing-locale]')];
    return panes.length > 0 && panes.every((pane) => pane.dataset.editingLocale === expected);
  }, locale);
}
async function navigate(path) {
  await page.goto(new URL('/admin/' + path, report.origin).href);
  await page.locator('main h2').waitFor();
}
async function scan(ids, locale, route) {
  assert(ids.length > 0, `${route}: no expected input fields`);
  await input(ids[0]).waitFor();
  await input(ids[0] + '-length').waitFor();
  const rows = await page.evaluate(({ ids, locale }) => ids.map((id) => {
    const field = document.getElementById(id), hint = document.getElementById(id + '-length');
    if (!field || !hint) return { id, missing: !field ? 'input' : 'hint' };
    const described = (field.getAttribute('aria-describedby') ?? '').split(' ');
    let count = 0;
    for (const _ of new Intl.Segmenter(locale, { granularity: 'grapheme' }).segment(field.value.replace(/\r\n?/g, '\n'))) count++;
    return { id, key: hint.dataset.textLimitKey, value: field.value, basis: hint.dataset.textLimitBasis, count, displayedCount: Number(hint.dataset.count),
      limit: hint.hasAttribute('data-limit') ? Number(hint.dataset.limit) : null,
      over: hint.dataset.textLimitOver === 'true', described: described.includes(hint.id),
      visible: hint.getClientRects().length > 0, text: hint.textContent, color: hint.style.color,
      maxLength: field.getAttribute('maxlength'), invalid: field.getAttribute('aria-invalid') };
  }), { ids, locale });
  for (const row of rows) {
    assert(!row.missing, `${route}/${locale}/${row.id}: missing ${row.missing}`);
    assert(row.described && row.visible, `${row.id}: hint is not visible and associated with the input`);
    assert.equal(row.displayedCount, row.count, `${row.id}: input character count`);
    const rule = policies.fields[row.key];
    assert(rule, `${row.id}: unknown policy ${row.key}`);
    const instance = row.key.startsWith('sku.') ? draft.skus.find((sku) => row.id === `sku-${sku.id}-name` || row.id === `sku-${sku.id}-${locale}`)?.id : undefined;
    const measurement = row.key.startsWith('sku.') ? rule.instances?.[instance] : rule;
    const languages = row.key === 'sku.name' ? LOCALES : [locale];
    const limits = languages.map((language) => measurement?.limits?.[language]);
    const reason = languages.map((language) => measurement?.previewReasons?.[language]).find(Boolean);
    const expected = rule.kind === 'bounded' && !reason && limits.every((limit) => Number.isInteger(limit) && limit > 0) ? Math.min(...limits) : null;
    const basis = measurement?.basis ?? rule.basis;
    const guidance = { flowing: '无固定排版上限', metadata: '辅助说明文字', seo: '搜索', system: '按实际内容填写',
      bounded: expected === null ? '需检查前台预览' : basis === 'reference' ? '按默认断行建议约' : '建议最多' };
    assert(row.text.includes(guidance[rule.kind]), `${row.id}: wrong policy explanation or stale Admin build`);
    if (rule.syntax) assert(row.text.includes(rule.syntax === 'template' ? '占位符' : '格式标记'), `${row.id}: formatting guidance missing`);
    if (reason) assert(row.text.includes(reason), `${row.id}: its actual preview reason must remain visible`);
    if (expected === null && rule.kind === 'bounded') {
      assert(!row.text.includes('尚未校准') && !row.over, `${row.id}: a known preview-only field is neutral, not uncalibrated or invalid`);
      report.previews.push({ key: row.key, instance, locale, count: row.count, reason: reason ?? 'unmeasured-instance-or-locale' });
    }
    const reference = measurement?.references?.[locale];
    const newlines = (value) => value.replace(/\r\n?/g, '\n').split('\n').length - 1;
    const changedBreaks = basis === 'reference' && reference !== undefined && newlines(row.value) !== newlines(reference);
    assert.equal(row.text.includes('手动换行数量与默认文案不同'), changedBreaks, `${row.id}: newline guidance must follow the actual reference`);
    assert.equal(row.limit, expected, `${row.id}: wrong locale policy or stale Admin build`);
    assert.equal(row.over, rule.kind === 'bounded' && expected !== null && row.count > expected, `${row.id}: warning state`);
    assert.equal(row.maxLength, null, `${row.id}: hint must not truncate input`);
    assert.notEqual(row.invalid, 'true', `${row.id}: soft warning must not mark input invalid`);
    if (row.over) {
      assert(row.text.includes('超出建议') && row.text.includes('仍可'), `${row.id}: warning must explain the soft boundary`);
      assert.equal(row.color, 'var(--bad)', `${row.id}: warning must use the error color as well as text`);
      if (basis === 'reference') assert(row.text.includes('增加行数或改变原有排版比例') && !row.text.includes('内容被截断'), `${row.id}: reference advice must describe composition rather than assert clipping`);
    }
    const evidence = { route, locale, id: row.id, key: row.key, instance, count: row.count, limit: row.limit, over: row.over, basis, changedBreaks };
    if (checkingDefaults) {
      assert.equal(row.over, false, `${row.id}: the original default must never be flagged as exceeding its recommendation`);
      if (reference !== undefined) assert.equal(row.value, reference, `${row.id}: runtime default must match the measured default reference`);
      report.defaults.push(evidence);
    }
    report.fields.push(evidence);
  }
  return rows;
}
async function fillAndCheck(id, value, locale) {
  assert(!checkingDefaults, 'All default inputs must be inspected before any artificial boundary input');
  await input(id).fill(value);
  const actual = await input(id).inputValue();
  assert.equal(actual, value, `${id}: input value was truncated or changed`);
  await page.waitForFunction(({ id, value }) => {
    const field = document.getElementById(id), hint = document.getElementById(id + '-length');
    return field?.value === value && hint?.dataset.count === String([...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value.replace(/\r\n?/g, '\n'))].length);
  }, { id, value });
  return (await scan([id], locale, new URL(page.url()).pathname))[0];
}
async function boundaries(id, locale) {
  const before = await input(id).inputValue();
  const row = (await scan([id], locale, new URL(page.url()).pathname))[0];
  if (policies.fields[row.key].kind === 'bounded' && row.limit !== null) {
    for (const delta of [-1, 0, 1]) {
      const value = 'W'.repeat(row.limit + delta);
      const observed = await fillAndCheck(id, value, locale);
      assert.equal(observed.over, delta > 0, `${id}: N${delta >= 0 ? '+' : ''}${delta}`);
      report.boundaries.push({ id, key: row.key, locale, delta, count: observed.count, over: observed.over });
    }
  }
  const unicode = 'e\u0301 👩‍👩‍👧‍👦';
  const sample = await fillAndCheck(id, unicode, locale);
  assert.equal(sample.count, 3, `${id}: combining accent, space and family emoji must be three characters`);
  if (await input(id).evaluate((field) => field.tagName === 'TEXTAREA')) {
    const multiline = await fillAndCheck(id, unicode + '\n[[wide]] __word__ {year} ^1^', locale);
    assert.equal(multiline.count, 32, `${id}: count must include newlines, placeholders and formatting syntax`);
  }
  await fillAndCheck(id, before, locale);
  return row;
}
async function pasteAndCheck(id, locale) {
  const original = await input(id).inputValue();
  const value = 'e\u0301 👩‍👩‍👧‍👦\n[[wide]] __word__ {year} ^1^';
  try {
    await page.evaluate(async ({ id, value }) => {
      await navigator.clipboard.writeText(value);
      window.__copyHintPaste = null;
      document.getElementById(id).addEventListener('paste', (event) => {
        window.__copyHintPaste = { trusted: event.isTrusted, exactClipboardText: event.clipboardData?.getData('text/plain').replace(/\r\n?/g, '\n') === value };
      }, { once: true });
    }, { id, value });
    await input(id).focus();
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${modifier}+A`);
    await page.keyboard.press(`${modifier}+V`);
    await page.waitForFunction(({ id, value }) => document.getElementById(id)?.value === value && document.getElementById(id + '-length')?.dataset.count === '32', { id, value });
    assert.deepEqual(await page.evaluate(() => window.__copyHintPaste), { trusted: true, exactClipboardText: true }, 'A real trusted browser paste event must carry the complete original text');
    assert.equal(await input(id).inputValue(), value);
    const row = (await scan([id], locale, 'native-clipboard-paste'))[0];
    assert.equal(row.count, 32, 'Pasted Unicode, spaces, newline and syntax must retain their complete input count');
    report.clipboard = { status: 'pass', trustedPasteEvent: true, count: row.count, exactValue: true };
  } catch (error) {
    report.clipboard = { status: 'failed-or-unavailable', reason: error.message };
    throw error; // Filling programmatically is not evidence that paste works.
  } finally { await input(id).fill(original); }
}
async function checkKeyboard(id) {
  await input(id).focus();
  await page.keyboard.press('Tab');
  const next = await page.evaluate(() => ({ id: document.activeElement?.id, tag: document.activeElement?.tagName }));
  assert.notEqual(next.id, id, `${id}: keyboard focus must leave the input`);
  await page.keyboard.press('Shift+Tab');
  assert(await input(id).evaluate((field) => document.activeElement === field), `${id}: reverse tab must return to the input`);
  const state = await input(id).evaluate((field) => {
    const box = field.getBoundingClientRect(), hint = document.getElementById(field.id + '-length');
    const hintStyle = getComputedStyle(hint);
    const hit = document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, box.left + box.width / 2)), Math.min(innerHeight - 1, Math.max(0, box.top + box.height / 2)));
    return { visibleFocus: field.matches(':focus-visible'), unobscured: hit === field,
      description: field.getAttribute('aria-describedby')?.split(' ').includes(hint?.id),
      hintText: hint?.textContent, hintColor: hintStyle.color, hintFontSize: hintStyle.fontSize,
      hintLineHeight: hintStyle.lineHeight, viewport: `${innerWidth}x${innerHeight}` };
  });
  assert(state.visibleFocus && state.unobscured && state.description, `${id}: keyboard focus must be visible, unobscured and associated with the hint`);
  report.keyboard ??= [];
  report.keyboard.push({ id, next, ...state });
}
async function saveAndReload(expected, reopen = async () => {}) {
  const oldRevision = revision;
  const save = page.getByRole('button', { name: '保存草稿', exact: true });
  assert(await save.isEnabled(), 'A soft warning must not disable saving');
  const response = page.waitForResponse((entry) => new URL(entry.url()).pathname === '/api/config/draft' && entry.request().method() === 'PATCH');
  await save.click();
  assert.equal((await response).status(), 200, 'Fixture draft PATCH must pass the real schema');
  await page.waitForFunction(() => !document.querySelector('.editor-actions button.btn.primary')?.textContent.includes('保存中'));
  assert.equal(revision, oldRevision + 1);
  const fields = new Map(enumerateDraftFields(draft, manifest).map((field) => [field.fieldId, field.value]));
  for (const entry of expected) assert.equal(fields.get(entry.fieldId), entry.value, `${entry.fieldId}: fixture persisted value`);
  await page.reload();
  await page.locator('main h2').waitFor();
  await reopen();
  for (const entry of expected) {
    if (entry.locale) await selectLocale(entry.locale);
    assert.equal(await input(entry.id).inputValue(), entry.value, `${entry.id}: save/reload roundtrip`);
    await scan([entry.id], entry.locale ?? 'en', new URL(page.url()).pathname);
  }
  report.roundtrips.push({ route: new URL(page.url()).pathname, values: expected.length, revision });
}
try {
  report.geo = await checkGeoRendering();
  assert.notEqual(report.geo.status, 'fail', 'Real Worker Geo HTML browser acceptance failed');
  // All non-admin requests are intercepted below. The proxy target has no running service.
  preview = await startConsolePreview({ port: 0, apiOrigin: 'http://127.0.0.1:1' });
  report.origin = `http://127.0.0.1:${preview.httpServer.address().port}`;
  assert.equal(await (await fetch(report.origin + '/admin/')).text(), built, 'Preview must serve this exact Admin build');
  browser = await chromium.launch({ headless: true, args: ['--disable-features=AutoDarkMode'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] });
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin === report.origin && url.pathname.startsWith('/admin/')) return route.continue();
    report.requests.push({ method, path: url.pathname });
    const respond = (body, status = 200) => route.fulfill({ status, json: body });
    try {
      assert.equal(url.origin, report.origin, 'Unexpected external request');
      if (method === 'GET' && url.pathname === '/api/me') return respond({ username: 'isolated-browser-fixture' });
      if (method === 'GET' && url.pathname === '/api/config') return respond(overview());
      if (method === 'GET' && url.pathname === '/api/translations') return respond({ draftRev: revision, counts: {}, states: [], items: [], nextCursor: null });
      if (method === 'GET' && url.pathname === '/api/geo') return respond(geo);
      if (method === 'PATCH' && url.pathname === '/api/config/draft') {
        const body = request.postDataJSON();
        const next = applyDraftPatch(draft, body.operations, manifest);
        assert(next.ok, 'UI generated an invalid or conflicting draft patch');
        assert(SiteConfigSchema.safeParse(next.config).success, 'UI crossed an existing hard schema limit');
        draft = next.config; revision++;
        return respond({ ok: true, draftRev: revision });
      }
      if (method === 'POST' && url.pathname === '/api/ai/translate') {
        assert(aiText, 'AI fixture response must be deliberately set by the test');
        return respond({ text: aiText });
      }
      if (method === 'GET' && url.pathname === '/api/publish/preflight') {
        const validation = validateConfig(draft, manifest);
        const changed = diffPaths(live, draft), sensitive = sensitivePaths(changed);
        return respond({ ...validation, ready: changed.length > 0 && validation.errors.length === 0,
          changedPaths: changed, changed: changed.length, sensitiveChanged: sensitive, reasonRequired: sensitive.length > 0, draftRev: revision });
      }
      if (method === 'GET' && url.pathname === '/api/publish/status') return respond({ activeVersion: null, stepsOfVersion: null, steps: [],
        versions: [], stepNames: ['materialize', 'gates', 'build', 'swap'], drift: null,
        executor: { mode: 'fixture', ready: true, reason: '', lastSeenAt: Date.now() } });
      if (method === 'POST' && url.pathname === '/api/publish') {
        assert.equal(request.postDataJSON().draftRev, revision);
        if (sensitivePaths(diffPaths(live, draft)).length) assert(request.postDataJSON().reason.trim().length >= 8, 'Existing sensitive-change reason is still required');
        assert.deepEqual(validateConfig(draft, manifest).errors, [], 'Existing publication rules still apply');
        publishCalls++;
        return respond({ ok: true, version: 2 });
      }
      throw new Error(`Unmocked request ${method} ${url.pathname}`);
    } catch (error) {
      report.failures.push(error.message);
      return respond({ error: 'isolated-fixture-failed' }, 500);
    }
  });
  page = await context.newPage();
  page.on('dialog', (dialog) => dialog.accept());
  page.on('pageerror', (error) => report.errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') report.errors.push(message.text()); });
  await navigate('content');
  await page.getByRole('searchbox', { name: '搜索全部网站文案' }).fill('.');
  await page.locator('.locale-target textarea').first().waitFor();
  assert.equal(manifest.editable.length, Object.keys(seed.copy.en).length, 'Copy fixture and editable manifest differ');
  for (const locale of LOCALES) {
    await selectLocale(locale);
    await scan(manifest.editable.map((key) => `copy-${key}-${locale}`), locale, 'content-all-groups');
  }
  for (const spec of cases) {
    await navigate(spec.route);
    for (const item of spec.ids) {
      if (spec.expand) await page.locator(`[data-field=${JSON.stringify(spec.expand(item))}]`).getByRole('button', { name: '编辑', exact: true }).click();
      if (spec.tab) await page.locator(`button[data-field=${JSON.stringify(spec.tab(item))}]`).click();
      for (const locale of LOCALES) {
        await selectLocale(locale);
        await scan(spec.fields(item, locale).map((field) => field.id), locale, `defaults/${spec.route}`);
      }
    }
  }
  await navigate('content/downloads');
  await scan(['download-ios', 'download-android', 'download-h5'], 'en', 'defaults/links');
  await navigate('content/announcement'); await scan(['announcement-link'], 'en', 'defaults/announcement-link');
  await navigate('content/seo'); await scan(['contact-email'], 'en', 'defaults/footer-email');
  report.checks.push('every-default-input-all-nine-locales-and-instances-before-artificial-boundaries');
  await navigate('content?focus=copy.en.hero.title');
  assert.equal(await input('copy-hero.title-en').inputValue(), 'NexGrid\nLet compute flow');
  await checkKeyboard('copy-hero.title-en');
  await page.screenshot({ path: resolve(out, 'default-hero-desktop.png') });
  await input('copy-hero.title-en').locator('..').screenshot({ path: resolve(out, 'default-hero-desktop-field.png') });
  await page.setViewportSize({ width: 320, height: 844 });
  await checkKeyboard('copy-hero.title-en');
  await page.screenshot({ path: resolve(out, 'default-hero-mobile.png') });
  await input('copy-hero.title-en').locator('..').screenshot({ path: resolve(out, 'default-hero-mobile-field.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  checkingDefaults = false;
  for (const locale of LOCALES) {
    await selectLocale(locale);
    const id = `copy-hero.title-${locale}`, original = await input(id).inputValue();
    const reference = policies.fields['hero.title'].references[locale];
    const changed = reference.includes('\n') ? reference.replaceAll('\n', ' ') : '\n';
    const row = await fillAndCheck(id, changed, locale);
    assert(!row.over && row.text.includes('手动换行数量与默认文案不同'), `${locale}: changing explicit line breaks must request a neutral preview below the suggestion`);
    report.referenceBreaks.push({ key: 'hero.title', locale, count: row.count, limit: row.limit });
    await boundaries(id, locale);
    await fillAndCheck(id, original, locale);
  }
  // Reference fields can legitimately become preview-only. Select every remaining
  // numeric copy rule from the current table so boundary coverage cannot disappear.
  await navigate('content');
  await page.getByRole('searchbox', { name: '搜索全部网站文案' }).fill('.');
  await page.locator('.locale-target textarea').first().waitFor();
  const numericCopy = [];
  for (const locale of LOCALES) {
    await selectLocale(locale);
    for (const key of manifest.editable) {
      const rule = policies.fields[key];
      if (rule.kind !== 'bounded' || !Number.isInteger(rule.limits?.[locale]) || rule.previewReasons?.[locale]) continue;
      const id = `copy-${key}-${locale}`;
      await boundaries(id, locale);
      numericCopy.push({ key, locale, id, limit: rule.limits[locale] });
    }
  }
  report.checks.push('every-reliable-copy-number-N-minus-one-N-N-plus-one');
  const warningExample = numericCopy.find((entry) => entry.locale === 'en') ?? numericCopy[0];
  if (warningExample) {
    const { key, locale, id, limit } = warningExample;
    await navigate(`content?focus=copy.${locale}.${key}`);
    const original = await input(id).inputValue();
    const row = await fillAndCheck(id, 'W'.repeat(limit + 1), locale);
    assert(row.over, 'The numeric-warning screenshot must show an actual over-recommendation warning');
    await checkKeyboard(id);
    await page.screenshot({ path: resolve(out, 'numeric-warning-desktop.png') });
    await input(id).locator('..').screenshot({ path: resolve(out, 'numeric-warning-desktop-field.png') });
    await page.setViewportSize({ width: 320, height: 844 });
    await checkKeyboard(id);
    await page.screenshot({ path: resolve(out, 'numeric-warning-mobile.png') });
    await input(id).locator('..').screenshot({ path: resolve(out, 'numeric-warning-mobile-field.png') });
    report.numericWarning = { key, locale, limit, count: row.count, over: row.over };
    await fillAndCheck(id, original, locale);
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  const beforeUnknown = structuredClone(draft);
  draft.skus.push({ ...structuredClone(draft.skus[0]), id: 'copy-hints-unmeasured', name: 'Unmeasured product' });
  await navigate('content/skus');
  await page.locator('[data-field="skus.copy-hints-unmeasured"]').getByRole('button', { name: '编辑', exact: true }).click();
  for (const locale of LOCALES) {
    await selectLocale(locale);
    const rows = await scan(['sku-copy-hints-unmeasured-name', `sku-copy-hints-unmeasured-${locale}`], locale, 'unmeasured-sku-api-fixture');
    assert(rows.every((row) => row.limit === null && !row.over && row.text.includes('这个产品尚无对应的排版测量结果')), 'An unknown SKU must not inherit another product number');
  }
  draft = beforeUnknown;
  report.checks.push('reference-linebreak-neutral-preview-and-unmeasured-sku-no-number');
  await navigate('content?focus=copy.en.nav.download');
  await pasteAndCheck('copy-nav.download-en', 'en');
  const copyEdits = [];
  for (const locale of LOCALES) {
    await selectLocale(locale);
    const id = `copy-nav.download-${locale}`;
    const row = await boundaries(id, locale);
    const value = 'W'.repeat((row.limit ?? 64) + 1);
    await fillAndCheck(id, value, locale);
    const beforeSwitch = revision;
    await selectLocale(locale === 'en' ? 'zh' : 'en');
    await selectLocale(locale);
    assert.equal(await input(id).inputValue(), value, 'Switching languages must preserve over-limit input');
    assert.equal(revision, beforeSwitch, 'Language switching must not save implicitly');
    if (locale !== 'en') {
      aiText = 'i'.repeat((row.limit ?? 64) + 2);
      await input(id).locator('..').getByRole('button', { name: 'AI 翻译', exact: true }).click();
      await page.waitForFunction(({ id, expected }) => document.getElementById(id)?.value === expected, { id, expected: aiText });
      const ai = (await scan([id], locale, 'ai-filled'))[0];
      assert.equal(ai.over, row.limit !== null, 'AI-filled value must use the same numeric or preview-only advice');
      assert.equal(revision, beforeSwitch, 'AI fill must not save implicitly');
      copyEdits.push({ id, locale, fieldId: `/copy/${locale}/nav.download`, value: aiText });
    } else copyEdits.push({ id, locale, fieldId: `/copy/${locale}/nav.download`, value });
  }
  await checkKeyboard('copy-nav.download-zh');
  await page.screenshot({ path: resolve(out, 'copy-overlimit-desktop.png') });
  await saveAndReload(copyEdits, async () => {
    await page.getByRole('searchbox', { name: '搜索全部网站文案' }).fill('nav.download');
  });
  report.checks.push('manual-and-ai-fill-switch-save-reload-remain-soft');

  for (const spec of cases) {
    await navigate(spec.route);
    for (const item of spec.ids) {
      if (spec.expand) await page.locator(`[data-field=${JSON.stringify(spec.expand(item))}]`).getByRole('button', { name: '编辑', exact: true }).click();
      if (spec.tab) await page.locator(`button[data-field=${JSON.stringify(spec.tab(item))}]`).click();
      for (const locale of LOCALES) {
        await selectLocale(locale);
        await scan(spec.fields(item, locale).map((field) => field.id), locale, spec.route);
        if (item === spec.ids[0] || spec.route === 'content/skus') for (const field of spec.fields(item, locale)) if (!field.shared || locale === 'en') await boundaries(field.id, locale);
      }
    }
    report.checks.push(`${spec.route}-all-items-and-locales`);
    // Each draft editor gets an independent save/reload; Geo uses the immediate-rule path.
    if (spec.route !== 'geo') {
      const item = spec.ids[0];
      if (spec.expand && !await input(spec.fields(item, 'en')[0].id).count()) await page.locator(`[data-field=${JSON.stringify(spec.expand(item))}]`).getByRole('button', { name: '编辑', exact: true }).click();
      if (spec.tab) await page.locator(`button[data-field=${JSON.stringify(spec.tab(item))}]`).click();
      const edited = [];
      for (const locale of LOCALES) {
        await selectLocale(locale);
        for (const field of spec.fields(item, locale).filter((field) => !field.shared)) {
          const row = (await scan([field.id], locale, spec.route))[0];
          const value = policies.fields[row.key].kind === 'bounded' && row.limit !== null ? 'i'.repeat(row.limit + 1) : `Copy hint ${locale}`;
          await fillAndCheck(field.id, value, locale);
          edited.push({ ...field, fieldId: field.path, locale, value });
        }
      }
      await saveAndReload(edited, async () => {
        if (spec.expand) await page.locator(`[data-field=${JSON.stringify(spec.expand(item))}]`).getByRole('button', { name: '编辑', exact: true }).click();
      });
    } else {
      await selectLocale('en');
      await fillAndCheck('geo-title-en', 'Copy hints retain the existing action', 'en');
      const apply = page.getByRole('button', { name: '应用变更(确认+理由)', exact: true });
      assert(await apply.isEnabled(), 'Geo character advice must preserve the existing apply action');
      for (const [id, hardLimit] of [['geo-title-en', 120], ['geo-body-en', 300]]) {
        const before = await input(id).inputValue();
        await fillAndCheck(id, 'W'.repeat(hardLimit + 1), 'en');
        assert(await apply.isDisabled(), `${id}: existing hard limit must remain enforced`);
        await fillAndCheck(id, before, 'en');
      }
      await page.getByRole('button', { name: '放弃改动', exact: true }).click();
    }
  }
  await navigate('content/downloads');
  await scan(['download-ios', 'download-android', 'download-h5'], 'en', 'download-links');
  await fillAndCheck('download-ios', 'https://example.com/copy-hints-fixture', 'en');
  await saveAndReload([{ id: 'download-ios', fieldId: '/downloads/ios/url', value: 'https://example.com/copy-hints-fixture' }]);
  await navigate('content/announcement');
  await scan(['announcement-link'], 'en', 'announcement-link');
  await fillAndCheck('announcement-link', '/learn?copy-hints-fixture=1', 'en');
  await saveAndReload([{ id: 'announcement-link', fieldId: '/announcement/href', value: '/learn?copy-hints-fixture=1' }]);
  await selectLocale('en');
  const announcementBefore = await input('announcement-en').inputValue();
  await fillAndCheck('announcement-en', 'W'.repeat(121), 'en');
  assert(await page.getByRole('button', { name: '保存草稿', exact: true }).isDisabled(), 'The existing 120-character announcement rule must remain enforced');
  await fillAndCheck('announcement-en', announcementBefore, 'en');
  await navigate('content/seo');
  await scan(['contact-email'], 'en', 'footer-email');
  await input('contact-email').fill('copy-hints-fixture@example.com');
  await saveAndReload([{ id: 'contact-email', fieldId: '/footer/contactEmail', value: 'copy-hints-fixture@example.com' }]);
  await page.setViewportSize({ width: 320, height: 844 });
  for (const route of ['content?focus=copy.ja.nav.download', 'content/skus', 'content/faq', 'content/announcement', 'content/seo', 'content/legal', 'content/downloads', 'geo']) {
    await navigate(route);
    if (['content/skus', 'content/faq'].includes(route)) {
      const edit = page.getByRole('button', { name: '编辑', exact: true }).first();
      await edit.waitFor();
      await edit.click();
    }
    await page.locator('[data-text-limit-key]').first().waitFor();
    const width = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth }));
    assert(width.scrollWidth <= width.innerWidth + 1, `${route}: hints overflow at 320px`);
    report.mobile ??= [];
    report.mobile.push({ route, ...width });
  }
  await navigate('content?focus=copy.ja.nav.download');
  await input('copy-nav.download-ja').scrollIntoViewIfNeeded();
  await checkKeyboard('copy-nav.download-ja');
  await page.screenshot({ path: resolve(out, 'copy-overlimit-mobile.png') });
  await input('copy-nav.download-ja').locator('..').screenshot({ path: resolve(out, 'copy-overlimit-mobile-field.png') });
  const numericDefaults = new Map(report.defaults
    .filter((row) => row.limit !== null && (row.key !== 'sku.name' || row.locale === 'en'))
    .map((row) => [`${row.id}|${row.locale}`, row]));
  for (const row of numericDefaults.values()) for (const delta of [-1, 0, 1]) {
    assert(report.boundaries.some((sample) => sample.id === row.id && sample.locale === row.locale && sample.delta === delta),
      `${row.id}/${row.locale}: a displayed numeric recommendation lacks runtime boundary coverage`);
  }
  report.numericCoverage = { distinctDisplayedRecommendations: numericDefaults.size, requiredBoundarySamples: numericDefaults.size * 3 };
  await navigate('publish');
  await page.getByRole('button', { name: '检查并发布', exact: true }).waitFor();
  assert(await page.getByRole('button', { name: '检查并发布', exact: true }).isEnabled(), 'Existing preflight must permit the soft-only copy edits');
  await page.getByRole('button', { name: '检查并发布', exact: true }).click();
  if (await input('publish-reason').count()) await input('publish-reason').fill('隔离浏览器文案提示测试');
  const published = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/publish' && response.request().method() === 'POST');
  await page.getByRole('button', { name: '确认', exact: true }).click();
  assert.equal((await published).status(), 200);
  assert.equal(publishCalls, 1);
  report.checks.push('soft-hints-preserve-existing-preflight-and-publish-request');
  assert.deepEqual(validateConfig(draft, manifest).errors, [], 'Soft edits must remain valid under existing validators');
  assert.equal(await treeHash(resolve(root, 'admin/src')), sourceHash, 'Admin source changed during acceptance');
  assert.equal(await treeHash(resolve(root, 'admin/dist')), buildHash, 'Admin build changed during acceptance');
  assert.equal(await (await fetch(report.origin + '/admin/')).text(), built, 'Preview build changed');
  assert.deepEqual(report.errors, [], 'Browser console/runtime errors');
  assert.deepEqual(report.failures, [], 'Unexpected API fixture failure');
  report.status = 'pass';
} catch (error) {
  report.status = 'fail';
  report.failures.push(error.stack ?? error.message);
  if (page) await page.screenshot({ path: resolve(out, 'failure.png') }).catch(() => {});
} finally {
  await browser?.close();
  await new Promise((done) => preview?.httpServer ? preview.httpServer.close(done) : done());
  await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ status: report.status, evidence: report.evidence, fields: report.fields.length,
  defaults: report.defaults.length, boundaries: report.boundaries.length, roundtrips: report.roundtrips.length, clipboard: report.clipboard,
  previews: report.previews.length, referenceBreaks: report.referenceBreaks.length, geoStatus: report.geo?.status, geoRisks: report.geo?.risks.length, checks: report.checks,
  failures: report.failures, report: resolve(out, 'report.json') }));
process.exitCode = report.status === 'pass' ? 0 : 1;
