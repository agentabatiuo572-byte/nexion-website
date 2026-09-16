// Built-preview typography gate. --baseline records old sizes; no configuration writes are allowed.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const baseline = process.argv.includes('--baseline');
assert(process.argv.slice(2).every((arg) => arg === '--baseline'), 'Usage: node scripts/console-typography-check.mjs [--baseline]');
const base = new URL(process.env.CONSOLE_URL ?? 'http://127.0.0.1:4399');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) && ['4399', '4409'].includes(base.port), 'Use the local built preview on port 4399 or explicitly select port 4409');
const out = resolve(root, '.codex/type-review');
await mkdir(out, { recursive: true });
const resultPath = resolve(out, `${baseline ? 'baseline' : 'final'}.json`);
await writeFile(resultPath, JSON.stringify({ mode: baseline ? 'baseline' : 'final', status: 'running' }));
const digest = (value) => createHash('sha256').update(value).digest('hex');
const built = await readFile(resolve(root, 'admin/dist/index.html'), 'utf8');
assert.equal(await (await fetch(new URL('/admin/', base))).text(), built, 'Preview differs from admin/dist/index.html');
const report = { mode: baseline ? 'baseline' : 'final', build: digest(built), routes: [], samples: [], localeChecks: [], focus: [], resize: [], errors: [], blockedWrites: [], failures: [] };
const expectedLocales = ['en', 'vi', 'es', 'pt', 'fr', 'de', 'ja', 'ko', 'zh'];
let old;
try { old = JSON.parse(await readFile(resolve(out, 'baseline.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
let auth;
try { auth = JSON.parse(await readFile(resolve(root, '.codex/ui-review/auth.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const browser = await chromium.launch({ headless: true, args: ['--disable-features=AutoDarkMode'] });
const profiles = [320, 390, 1024, 1440, 1920, 2560, 3840].map((width) => ({ width, dpr: 1 }));
profiles.push({ width: 2560, dpr: 1.5 }, { width: 1920, dpr: 2 });
let allowLogin = false;
async function context(profile, storageState) {
  const height = profile.width >= 1920 ? profile.width * 9 / 16 : profile.width >= 1024 ? 1000 : profile.width === 320 ? 740 : 844;
  const ctx = await browser.newContext({ storageState, viewport: { width: profile.width, height }, deviceScaleFactor: profile.dpr, colorScheme: 'light', reducedMotion: 'reduce' });
  await ctx.route('**/api/**', (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (!['GET', 'HEAD'].includes(request.method()) && !(allowLogin && request.method() === 'POST' && path === '/api/auth/login')) {
      report.blockedWrites.push({ method: request.method(), path });
      return route.abort();
    }
    return route.continue();
  });
  return ctx;
}
function track(page) {
  page.on('pageerror', (error) => report.errors.push({ route: new URL(page.url()).pathname, message: error.message }));
  page.on('console', (message) => { if (message.type() === 'error') report.errors.push({ route: new URL(page.url()).pathname, message: message.text(), location: message.location() }); });
}
async function navigate(page, route) {
  await page.goto(new URL(route, base).href);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
}
async function capture(page, profile, route, variant = '') {
  const sample = await page.evaluate(() => {
    const visible = (el) => {
      if (!el.getClientRects().length) return false;
      for (let node = el; node; node = node.parentElement) {
        const css = getComputedStyle(node), box = node.getBoundingClientRect();
        if (css.display === 'none' || css.visibility === 'hidden' || css.visibility === 'collapse' || Number(css.opacity) === 0) return false;
        if (box.width <= 2 && box.height <= 2 && (css.clip !== 'auto' || css.clipPath !== 'none')) return false;
        if (node.tagName === 'DETAILS' && !node.open && !node.querySelector(':scope > summary')?.contains(el)) return false;
      }
      return true;
    };
    const rootFont = parseFloat(getComputedStyle(document.documentElement).fontSize), floor = Math.max(14, rootFont * .875);
    const texts = [], controls = [], occurrences = new Map();
    for (const el of document.querySelectorAll('body *')) {
      if (!visible(el) || ['SCRIPT', 'STYLE'].includes(el.tagName)) continue;
      const css = getComputedStyle(el), direct = [...el.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
      const valueControl = el.matches('input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=button]):not([type=submit]),textarea,select');
      if (!direct.length && !valueControl) continue;
      const text = valueControl ? (el.getAttribute('aria-label') || [...el.labels || []].map((label) => label.textContent).join(' ') || el.id || el.tagName) : direct.map((node) => node.textContent).join(' ').trim();
      const normalized = text.replace(/\s+/g, ' ').replace(/\d+/g, '#').slice(0, 160);
      const stem = el.id ? `${el.tagName}#${el.id}` : `${el.tagName}.${[...el.classList].join('.')}|${normalized}`;
      const index = occurrences.get(stem) ?? 0; occurrences.set(stem, index + 1);
      const box = el.getBoundingClientRect();
      texts.push({ key: `${stem}|${index}`, text: normalized, tag: el.tagName, size: parseFloat(css.fontSize), lineHeight: css.lineHeight, width: box.width, height: box.height, input: valueControl });
      // Body text and labels must not collapse into overlapping glyphs after unit conversion.
      if (parseFloat(css.letterSpacing) < -.1 * parseFloat(css.fontSize)) controls.push({ key: stem, issue: 'excessive-negative-tracking', tracking: css.letterSpacing });
      // Native fields intentionally scroll long values. Check their vertical space, not value width.
      if (valueControl && el.tagName !== 'TEXTAREA') {
        const usable = el.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom);
        if (usable + 1 < parseFloat(css.fontSize)) controls.push({ key: stem, issue: 'field-line-clipped', usable, font: parseFloat(css.fontSize) });
      }
      const control = el.closest('button,a,summary');
      if (!control) continue;
      const frame = control.getBoundingClientRect();
      let intentional = false;
      for (let node = el; node && control.contains(node); node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.textOverflow === 'ellipsis' || Number(style.webkitLineClamp) > 0) intentional = true;
      }
      if (intentional) continue;
      for (const node of direct) {
        const range = document.createRange(); range.selectNodeContents(node);
        for (const rect of range.getClientRects()) if (rect.width && rect.height && (rect.left < frame.left - 1 || rect.right > frame.right + 1 || rect.top < frame.top - 1 || rect.bottom > frame.bottom + 1)) {
          controls.push({ key: stem, issue: 'control-text-outside-box' }); break;
        }
      }
    }
    const groups = Object.fromEntries(Object.entries({ body: 'body', nav: '.sidebar .nav', label: 'label', input: 'input,textarea,select', table: 'th,td', kv: '.kv', h2: 'h2', kpi: '.dash-kpi-value' }).map(([name, selector]) => [name, [...document.querySelectorAll(selector)].filter(visible).map((el) => parseFloat(getComputedStyle(el).fontSize))]));
    const titles = [...document.querySelectorAll('[data-field^="downloads."] > .row > b, [data-field^="faq.items."] > .row > b')].filter(visible).map((el) => {
      const range = document.createRange(); range.selectNodeContents(el);
      const rects = [...range.getClientRects()].filter((rect) => rect.width && rect.height), box = el.getBoundingClientRect(), css = getComputedStyle(el);
      const lines = new Set(rects.map((rect) => Math.round(rect.top))).size;
      const clipped = ['hidden', 'clip'].includes(css.overflowX) && (el.scrollWidth > el.clientWidth + 1 || rects.some((rect) => rect.right > box.right + 1));
      return { key: el.closest('[data-field]').getAttribute('data-field'), text: el.textContent.trim(), lines, clipped, width: box.width, scrollWidth: el.scrollWidth };
    });
    return { rootFont, floor, width: innerWidth, dpr: devicePixelRatio, physicalWidth: innerWidth * devicePixelRatio, scrollWidth: document.documentElement.scrollWidth, groups, texts, controls, titles };
  });
  const id = `${profile.width}@${profile.dpr}:${route}${variant}`;
  const small = sample.texts.filter((text) => text.size + .05 < sample.floor);
  const smallInputs = sample.texts.filter((text) => text.input && text.size + .05 < sample.rootFont);
  const primarySmall = ['body', 'nav', 'label'].filter((group) => sample.groups[group].some((size) => size + .05 < sample.rootFont));
  report.samples.push({ id, route, variant, ...sample, small: small.map((text) => text.key), smallInputs: smallInputs.map((text) => text.key) });
  if (sample.scrollWidth > sample.width + 1) report.failures.push({ id, issue: 'page-overflow', width: sample.width, scrollWidth: sample.scrollWidth });
  report.failures.push(...sample.controls.map((failure) => ({ id, ...failure })));
  if (!baseline) report.failures.push(...small.map((text) => ({ id, key: text.key, issue: 'text-below-floor', actual: text.size, expected: sample.floor })), ...smallInputs.map((text) => ({ id, key: text.key, issue: 'input-below-root', actual: text.size, expected: sample.rootFont })), ...primarySmall.map((group) => ({ id, issue: 'primary-text-below-root', group, expected: sample.rootFont })));
  // Independent of the measured root: a fixed 16px root must fail on large screens.
  const absoluteFloor = { 1920: 18, 2560: 20, 3840: 24 }[profile.width];
  if (!baseline && absoluteFloor) {
    for (const [group, actual] of [['root', sample.rootFont], ['body', sample.groups.body[0]]]) {
      if (!(actual + .05 >= absoluteFloor)) report.failures.push({ id, issue: 'large-screen-text-below-floor', group, actual, expected: absoluteFloor });
    }
  }
  if (route === '/admin/content/downloads') {
    assert.equal(sample.titles.length, 3, `${id}: download title coverage missing`);
    report.failures.push(...sample.titles.filter((title) => title.lines !== 1 || title.clipped).map((title) => ({ id, issue: 'download-title-not-single-line', ...title })));
  }
  if (route === '/admin/content/faq') assert(sample.titles.length > 0, `${id}: FAQ title coverage missing`);
  assert(sample.texts.length > 0, `${id}: no rendered text measured`);
  if (!variant && [1440, 3840].includes(profile.width) && profile.dpr === 1 && ['/admin/', '/admin/content', '/admin/login'].includes(route)) {
    await page.screenshot({ path: resolve(out, `${baseline ? 'baseline' : 'final'}-${route === '/admin/' ? 'dashboard' : route.split('/').at(-1)}-${profile.width}.png`), fullPage: true });
  }
}
async function keyboard(page, id) {
  await page.locator('#workspace').focus(); let visited = 0, finished = false;
  for (let step = 0; step < 350; step++) {
    await page.keyboard.press('Tab');
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const field = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el?.closest('main')) return { end: true };
      if (!el.matches('input,textarea,select') || el.closest('.editor-actions')) return {};
      const rect = el.getBoundingClientRect();
      const covered = [rect.top + 3, rect.top + rect.height / 2, rect.bottom - 3].some((y) => {
        const top = document.elementFromPoint(rect.left + rect.width / 2, y);
        return !top || (top !== el && !el.contains(top));
      });
      return { key: el.id || el.getAttribute('aria-label') || el.tagName, covered };
    });
    if (field.end) { finished = true; break; }
    if (field.key) { visited++; if (field.covered) report.failures.push({ id, issue: 'keyboard-field-covered', key: field.key }); }
  }
  report.focus.push({ id, visited, finished });
  if (!visited || !finished) report.failures.push({ id, issue: 'keyboard-coverage-incomplete' });
}
try {
  assert(baseline || old?.samples?.length > 0, 'Run --baseline before comparing typography; missing comparison evidence');
  const bootstrap = await context({ width: 1440, dpr: 1 }, auth);
  const login = await bootstrap.newPage(); await navigate(login, '/admin/login');
  // Chromium permits Secure cookies on loopback HTTP; APIRequestContext does not use that browser exception.
  if (!await login.evaluate(async () => (await fetch('/api/me')).ok)) {
    assert(process.env.CONSOLE_TEST_PASSWORD, 'Authentication expired: refresh .codex/ui-review/auth.json or supply CONSOLE_TEST_PASSWORD');
    allowLogin = true;
    await login.locator('input[autocomplete="current-password"]').fill(process.env.CONSOLE_TEST_PASSWORD);
    await login.getByRole('button', { name: '登录', exact: true }).click();
    await login.waitForURL((url) => /^\/admin\/?$/.test(url.pathname)); allowLogin = false;
  }
  auth = await bootstrap.storageState(); // Kept in memory only; never overwrite the shared session file.
  const inventory = await bootstrap.newPage(); await navigate(inventory, '/admin/');
  report.routes = await inventory.locator('.sidebar nav a[href]').evaluateAll((links) => [...new Set(links.map((link) => {
    const path = new URL(link.href).pathname;
    return path === '/admin' ? '/admin/' : path;
  }))]);
  assert(report.routes.length === 14 && report.routes.includes('/admin/content/languages') && report.routes.includes('/admin/ai') && report.routes.every((route) => route.startsWith('/admin')), 'Expected all 14 shell routes from actual navigation');
  await bootstrap.close();
  for (const profile of profiles) {
    const ctx = await context(profile, auth), page = await ctx.newPage(); track(page);
    for (const route of report.routes) {
      await navigate(page, route); assert.equal(new URL(page.url()).pathname.replace(/\/$/, ''), route.replace(/\/$/, ''), `Unexpected redirect: ${route}`);
      await page.locator('main h2').waitFor(); await capture(page, profile, route);
      const edit = page.getByRole('button', { name: '编辑', exact: true });
      if (route.startsWith('/admin/content') && await edit.count()) { await edit.first().click(); await capture(page, profile, route, ':expanded'); }
      const target = page.locator('[data-locale-target]');
      if (profile.dpr === 1 && [320, 3840].includes(profile.width) && await target.count()) {
        assert.deepEqual(await target.locator('option').evaluateAll((options) => options.map((option) => option.value)), expectedLocales, `${route}: incomplete language picker`);
        for (const locale of expectedLocales) {
          await target.selectOption(locale);
          // Selection completes before React Router commits the matching language panes.
          await page.waitForFunction((expected) => {
            const panes = [...document.querySelectorAll('[data-editing-locale]')];
            return panes.length > 0 && panes.every((pane) => pane.dataset.editingLocale === expected);
          }, locale);
          await page.locator('[data-locale-reference]').selectOption(locale === 'en' ? 'vi' : 'en');
          await page.waitForFunction((expected) => {
            const references = [...document.querySelectorAll('.locale-reference')];
            return references.length > 0 && references.every((reference) => reference.lang === expected);
          }, locale === 'en' ? 'vi' : 'en');
          assert.equal(await page.locator('.locale-reference input,.locale-reference textarea').count(), 0, `${route}: editable reference`);
          const panes = await page.locator('[data-editing-locale]').evaluateAll((nodes) => nodes.map((node) => ({ locale: node.dataset.editingLocale, width: node.getBoundingClientRect().width, parentWidth: node.parentElement.getBoundingClientRect().width })));
          assert(panes.length > 0 && panes.every((pane) => pane.locale === locale && pane.width >= pane.parentWidth * .4), `${route}/${locale}: collapsed or simultaneous language columns`);
          await capture(page, profile, route, `:language-${locale}`);
          report.localeChecks.push({ route, width: profile.width, locale, panes: panes.length });
        }
      }
      if (profile.dpr === 1 && [320, 390, 3840].includes(profile.width) && route.startsWith('/admin/content')) await keyboard(page, `${profile.width}:${route}`);
    }
    await ctx.close();
    const publicContext = await context(profile), publicPage = await publicContext.newPage(); track(publicPage);
    for (const route of ['/admin/login', '/admin/setup']) { await navigate(publicPage, route); await capture(publicPage, profile, route); }
    if (!await publicPage.locator('form').count()) {
      await publicContext.route('**/api/auth/state', (route) => route.fulfill({ json: { initialized: false } }));
      await navigate(publicPage, '/admin/setup'); await capture(publicPage, profile, '/admin/setup', ':first-use-ui-fixture');
    }
    await publicContext.close();
    console.log(`Measured ${profile.width} CSS px @ DPR ${profile.dpr} (${profile.width * profile.dpr} physical px)`);
  }
  const faqSamples = report.samples.filter((sample) => sample.route === '/admin/content/faq' && !sample.variant && sample.dpr === 1);
  const wideFaq = faqSamples.find((sample) => sample.width === 3840);
  assert(wideFaq, 'Missing 4K FAQ comparison');
  for (const sample of faqSamples.filter((entry) => [1440, 1920, 2560].includes(entry.width))) {
    for (const title of sample.titles.filter((entry) => !entry.clipped)) {
      const wider = wideFaq.titles.find((entry) => entry.key === title.key && entry.text === title.text);
      if (!wider) report.failures.push({ id: wideFaq.id, issue: 'faq-title-comparison-missing', key: title.key });
      else if (wider.clipped) report.failures.push({ id: wideFaq.id, issue: 'faq-title-truncated-earlier-on-4k', key: title.key, narrowerWidth: sample.width, narrower: title, wider });
    }
  }
  const resizeContext = await context({ width: 3840, dpr: 1 }, auth), resizePage = await resizeContext.newPage(); track(resizePage);
  const editorRoutes = report.routes.filter((path) => path.startsWith('/admin/content'));
  assert.equal(editorRoutes.length, 9, 'Expected all nine draft editors for focused resize');
  for (const route of editorRoutes) {
    await resizePage.setViewportSize({ width: 3840, height: 2160 }); await navigate(resizePage, route);
    const edit = resizePage.getByRole('button', { name: '编辑', exact: true }); if (await edit.count()) await edit.first().click();
    const textarea = resizePage.locator('.editor-page textarea:visible:not(:disabled):not([readonly])').first();
    const field = await textarea.count() ? textarea : resizePage.locator('.editor-page input:visible:not(:disabled):not([readonly]),.editor-page select:visible:not(:disabled)').first();
    assert(await field.count(), `${route}: no editable field for focused resize`);
    const element = await field.elementHandle(), initialValue = await field.inputValue();
    assert(element, `${route}: field detached before resize`);
    await field.focus(); // Focus once. Re-focusing after resize would hide the regression.
    for (const width of [3840, 1440, 390, 320, 3840]) {
      await resizePage.setViewportSize({ width, height: width === 3840 ? 2160 : width === 1440 ? 1000 : width === 320 ? 740 : 844 });
      await resizePage.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      const active = await element.evaluate((el, original) => {
        const rect = el.getBoundingClientRect(), actions = el.closest('.editor-page')?.querySelector('.editor-actions')?.getBoundingClientRect();
        const inViewport = rect.width > 0 && rect.height > 0 && rect.left >= -1 && rect.top >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1;
        const coveredByActions = Boolean(actions && rect.left < actions.right && rect.right > actions.left && rect.top < actions.bottom && rect.bottom > actions.top);
        // Rounded corners belong to the parent visually; sample inside the actual field surface.
        const css = getComputedStyle(el);
        const inset = Math.min(rect.width / 2, Math.max(3, ...[css.borderTopLeftRadius, css.borderTopRightRadius, css.borderBottomLeftRadius, css.borderBottomRightRadius].map(parseFloat)));
        const covered = [rect.left + inset, rect.left + rect.width / 2, rect.right - inset].some((x) => [rect.top + 3, rect.top + rect.height / 2, rect.bottom - 3].some((y) => {
          const top = document.elementFromPoint(x, y); return !top || (top !== el && !el.contains(top));
        }));
        return { key: el.id || el.getAttribute('aria-label') || el.tagName, focused: el.isConnected && document.activeElement === el, valueUnchanged: el.value === original, inViewport, coveredByActions, covered, rect: rect.toJSON(), actions: actions?.toJSON() };
      }, initialValue); // Compare only in memory; do not put field values in the report.
      const fields = await resizePage.locator('textarea').evaluateAll((elements) => elements.filter((el) => el.getClientRects().length).map((el) => {
        const css = getComputedStyle(el), clipped = el.scrollHeight > el.clientHeight + 2, previous = el.scrollTop;
        el.scrollTop = el.scrollHeight;
        const scrollable = ['auto', 'scroll'].includes(css.overflowY) && el.scrollTop > 0;
        el.scrollTop = previous;
        return { key: el.id || el.getAttribute('aria-label'), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, overflowY: css.overflowY, clipped: clipped && !scrollable };
      }));
      report.resize.push({ route, width, fields, active });
      report.failures.push(...fields.filter((field) => field.clipped).map((field) => ({ id: `${width}:${route}`, issue: 'textarea-resize-clipped', ...field })));
      if (!active.focused) report.failures.push({ id: `${width}:${route}`, issue: 'resize-focus-lost', key: active.key });
      if (!active.valueUnchanged) report.failures.push({ id: `${width}:${route}`, issue: 'resize-field-value-changed', key: active.key });
      if (!active.inViewport || active.coveredByActions || active.covered) report.failures.push({ id: `${width}:${route}`, issue: 'resize-focused-field-covered', ...active });
    }
    await element.dispose();
  }
  await resizeContext.close();
  if (!baseline && old) report.comparison = report.samples.map((sample) => {
    const previous = old.samples.find((entry) => entry.id === sample.id), byKey = new Map(previous?.texts.map((text) => [text.key, text]) ?? []);
    const matched = sample.texts.filter((text) => byKey.has(text.key));
    return { id: sample.id, matched: matched.length, unmatched: sample.texts.length - matched.length, changed: matched.filter((text) => Math.abs(text.size - byKey.get(text.key).size) > .05).map((text) => ({ key: text.key, before: byKey.get(text.key).size, after: text.size })) };
  });
  if (!baseline) assert(report.comparison.every((sample) => sample.matched > 0), 'A route or viewport has no comparable baseline text');
  const finalBuilt = await readFile(resolve(root, 'admin/dist/index.html'), 'utf8');
  assert.equal(await (await fetch(new URL('/admin/', base))).text(), finalBuilt, 'Final preview differs from admin/dist/index.html');
  assert.equal(finalBuilt, built, 'Build changed during measurement');
  report.buildStable = true;
} catch (error) {
  report.failures.push({ issue: 'execution-incomplete', message: error.message.replaceAll(process.env.CONSOLE_TEST_PASSWORD || '\0', '[REDACTED_SECRET]') });
} finally {
  await browser.close();
  report.failures.push(...report.errors.map((error) => ({ issue: 'browser-error', ...error })), ...report.blockedWrites.map((request) => ({ issue: 'write-attempt-blocked', ...request })));
  report.status = report.failures.length ? 'fail' : 'pass';
  await writeFile(resultPath, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ mode: report.mode, result: report.failures.length ? 'FAIL' : 'PASS', samples: report.samples.length, textMeasurements: report.samples.reduce((sum, sample) => sum + sample.texts.length, 0), failures: report.failures.length, report: resolve(out, `${report.mode}.json`) }));
process.exitCode = report.failures.length ? 1 : 0;
