// Build and verify the preview first. Compare actual reveal rows with native text layout.
// LINE_REVEAL_OUT writes the evidence outside the repository; --home limits the red/green probe.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
if (process.argv.includes('--self-test')) {
  // Execute the production function, not a second implementation of its splitting logic.
  const { transpileModule } = await import('typescript');
  const source = readFileSync(resolve(root, 'src/scripts/fx.ts'), 'utf8');
  const start = source.indexOf('function initLineReveal()');
  const end = source.indexOf('function initType()', start);
  assert(start >= 0 && end > start, 'Production initLineReveal source');
  const code = transpileModule(`let reduced = false; const BEAT_T0 = performance.now();\n${source.slice(start, end)}\ninitLineReveal();`, { compilerOptions: { target: 99 } }).outputText;
  const browser = await chromium.launch();
  let passes = 0;
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => { errors.push(e.message); console.error(e.message); });
    await page.setContent('<html class="x-boot"><style>h2{margin:0;width:180px;font:32px/1.4 sans-serif;white-space:pre-line;text-wrap:balance}.lr-line,.lr-inner{display:block}.x-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}</style><body></body></html>');
    const cases = [
      ['en', 'What the network computes'], ['vi', 'Nhận thanh toán bằng USDT'],
      ...['en', 'vi', 'zh', 'ja', 'ko'].flatMap((lang) => ['\u00a0', '\u202f', '\u2060', '\ufeff'].map((glue) => [lang, `前 甲${glue}乙 後`])),
      ['en', 'alpha   beta\ngamma'], ['en', 'A\n\nB'], ['en', '\nA\n'], ['en', '  \n  '], ['en', ''],
      ['zh', '甲乙 丙丁\n戊己'], ['ja', '演算 NEX 計算 USDT'], ['ko', '연산 NEX 처리 USDT'],
      ['vi', 'a\u0306\u0301 lực 👩‍💻 mạnh'],
    ];
    assert(cases.length > 0, 'Self-test requires fixtures');
    await page.evaluate((cases) => {
      for (const [lang, text] of cases) {
        const el = document.createElement('h2');
        el.lang = lang; el.dataset.lr = 'load'; el.dataset.lrDelay = '200'; el.textContent = text;
        document.body.append(el);
      }
      window.__geometry = (el) => {
        const origin = el.getBoundingClientRect();
        const glyphs = [];
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (node.parentElement.closest('.x-sr')) continue;
          let offset = 0;
          for (const char of node.data) {
            const range = document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + char.length);
            const rect = range.getBoundingClientRect();
            if (rect.width && rect.height && !/^\s+$/.test(char)) glyphs.push([char, rect.x - origin.x, rect.y - origin.y]);
            offset += char.length;
          }
        }
        return { height: origin.height, glyphs };
      };
    }, cases);
    const native = await page.locator('h2').evaluateAll((els) => els.map(window.__geometry));
    assert.equal(native.length, cases.length, 'Every fixture has a native baseline');
    await page.addScriptTag({ content: code });
    await page.waitForFunction(() => [...document.querySelectorAll('h2')].every((el) => el.querySelector('.lr-inner')), null, { timeout: 5000 });
    const split = await page.locator('h2').evaluateAll((els) => els.map((el) => ({ ...window.__geometry(el), text: [...el.querySelectorAll('.lr-inner')].map((e) => e.textContent).join(''), innerHeight: [...el.querySelectorAll('.lr-line')].reduce((sum, e) => sum + e.getBoundingClientRect().height, 0) })));
    assert.equal(split.length, cases.length, 'Every fixture was inspected');
    for (const [i, value] of split.entries()) {
      assert.equal(value.text, cases[i][1], `case ${i} exact text`);
      assert.deepEqual(value.glyphs, native[i].glyphs, `case ${i} natural character positions`);
      assert(Math.abs(value.innerHeight - native[i].height) < 0.1, `case ${i} blank lines and line height`);
      passes++;
    }
    // No transition in this fixture: the production fallback timer must still restore every title.
    await page.waitForFunction(() => !document.querySelector('.lr-inner'), null, { timeout: 5000 });
    assert.deepEqual(await page.locator('h2').allTextContents(), cases.map((c) => c[1]), 'Normal completion exact original');
    passes++;
    assert.equal(passes, cases.length + 1);
    const resizePage = await browser.newPage({ viewport: { width: 390, height: 400 } });
    resizePage.on('pageerror', (e) => errors.push(e.message));
    await resizePage.setContent('<style>body{padding-top:1000px}h2{margin:0;width:80%;font:32px/1.4 sans-serif;text-wrap:balance}.lr-line,.lr-inner{display:block}.x-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}</style><h2 data-lr>What the network computes across a growing collection of connected devices</h2>');
    await resizePage.addScriptTag({ content: `window.__geometry = ${await page.evaluate(() => window.__geometry.toString())}` });
    const resizedNative = await resizePage.locator('h2').evaluate((el) => window.__geometry(el));
    const resizeOriginal = await resizePage.locator('h2').textContent();
    await resizePage.setViewportSize({ width: 800, height: 400 });
    await resizePage.addScriptTag({ content: code });
    await resizePage.waitForFunction(() => document.querySelector('.lr-inner'), null, { timeout: 5000 });
    await resizePage.evaluate(() => { window.__oldLine = document.querySelector('.lr-inner'); });
    await resizePage.setViewportSize({ width: 390, height: 400 });
    await resizePage.waitForFunction(() => document.querySelector('.lr-inner') !== window.__oldLine, null, { timeout: 5000 });
    assert.deepEqual(await resizePage.locator('h2').evaluate((el) => window.__geometry(el)), resizedNative, 'Unplayed headings rebuild to native geometry after resize');
    passes++;
    await resizePage.evaluate(() => { reduced = true; document.dispatchEvent(new Event('x:motion-preference')); });
    assert.equal(await resizePage.locator('h2').textContent(), resizeOriginal);
    assert.equal(await resizePage.locator('.lr-inner').count(), 0, 'Reduced-motion clears unplayed lines');
    passes++;
    assert.deepEqual(errors, [], 'Browser errors');
    console.log(`line-reveal self-test: ${passes} pass (production function, native geometry, Unicode, blank lines, restoration)`);
  } finally { await browser.close(); }
  process.exit(0);
}
const dist = resolve(root, 'dist');
const routes = readdirSync(dist, { recursive: true })
  .filter((p) => p.endsWith('index.html') && readFileSync(resolve(dist, p), 'utf8').includes('data-lr'))
  .map((p) => '/' + p.split(sep).join('/').replace('index.html', ''))
  .filter((p) => !process.argv.includes('--home') || p === '/' || p === '/vi/');
assert(routes.length > 0, 'No built line-reveal routes');
const out = process.env.LINE_REVEAL_OUT;
if (out) mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const report = [];
const failures = [];
const errors = [];

// Runs before the real production module. The observer reads its output without changing timing.
function observeReveal() {
  const real = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (...args) {
    return this.id === 'x-bg' ? null : real.apply(this, args);
  };
  window.__lrEvidence = new Map();
  const built = new WeakMap();
  const clean = (s) => s.replace(/\s+/g, ' ').trim();
  const rows = (el) => {
    const lines = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      for (let i = 0; i < node.length; i++) {
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const rect = range.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        let line = lines.find((l) => Math.abs(l.top - rect.top) < 2);
        if (!line) lines.push(line = { top: rect.top, text: '' });
        line.text += node.data[i];
      }
    }
    return lines.map((l) => clean(l.text)).filter(Boolean);
  };
  window.__lrRows = rows;
  new MutationObserver(() => {
    for (const el of document.querySelectorAll('[data-lr]')) {
      let evidence = window.__lrEvidence.get(el);
      const inners = [...el.querySelectorAll('.lr-inner')];
      if (!evidence) {
        evidence = { original: el.querySelector('.x-sr')?.textContent ?? el.textContent };
        window.__lrEvidence.set(el, evidence);
      }
      if (!inners.length || built.get(el) === inners[0]) continue;
      built.set(el, inners[0]);
      evidence.split = inners.flatMap(rows);
      evidence.innerHeight = [...el.querySelectorAll('.lr-line')].reduce((sum, line) => sum + line.getBoundingClientRect().height, 0);
      const boxes = inners.map((inner) => {
        const range = document.createRange(); range.selectNodeContents(inner);
        const rect = range.getBoundingClientRect();
        const shift = inner.getBoundingClientRect().top - inner.parentElement.getBoundingClientRect().top;
        return { top: rect.top - shift, bottom: rect.bottom - shift, height: rect.height };
      }).filter((box) => box.height);
      evidence.contentHeight = boxes.length ? Math.max(...boxes.map((b) => b.bottom)) - Math.min(...boxes.map((b) => b.top)) : 0;
      evidence.label = el.id || `${el.tagName}.${el.className}: ${evidence.original}`;
      evidence.lang = el.closest('[lang]')?.getAttribute('lang');
    }
  }).observe(document, { childList: true, subtree: true });
}

// These are real language islands consumed by initLineReveal, including its Segmenter branch.
const fixtures = ['zh', 'ja', 'ko'].flatMap((lang) => [
  ['nbsp', '前 甲\u00a0乙 後'], ['nnbsp', '前 甲\u202f乙 後'], ['joiner', '前 甲\u2060乙 後'],
  ['spaces', '甲乙 丙丁 戊己'], ['newline', '甲乙\n丙丁'],
].map(([name, text]) => `<h2 id="lr-${lang}-${name}" lang="${lang}" data-lr style="font:32px/1.4 sans-serif;letter-spacing:0;white-space:pre-line;width:100px;text-wrap:wrap">${text}</h2>`)).join('');

try {
  for (const width of [390, 1440, 1920]) {
    for (const route of routes) {
      console.log(`Checking line reveal ${route} ${width}`);
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      page.on('pageerror', (e) => errors.push(`${route}: ${e.message}`));
      page.on('console', (e) => { if (e.type() === 'error') errors.push(`${route}: ${e.text()}`); });
      await page.addInitScript(observeReveal);
      if (route === '/') await page.route('**/*', async (r) => {
        if (r.request().resourceType() !== 'document') return r.continue();
        const response = await r.fetch();
        await r.fulfill({ response, body: (await response.text()).replace('</body>', `<section>${fixtures}</section></body>`) });
      });
      const response = await page.goto('http://localhost:4399' + route, { waitUntil: 'networkidle' });
      assert(response?.ok(), `HTTP ${route}`);
      await page.evaluate(() => document.fonts.ready);
      const native = await page.evaluate(() => [...document.querySelectorAll('[data-lr]')].map((el) => {
        const range = document.createRange(); range.selectNodeContents(el);
        return { original: el.textContent, rows: window.__lrRows(el), height: range.getBoundingClientRect().height };
      }));
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.reload({ waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(() => window.__lrEvidence?.size && [...window.__lrEvidence.values()].every((e) => e.split));
      const before = await page.evaluate(() => [...window.__lrEvidence.values()]);
      assert.equal(before.length, native.length, `${route} all native headings were split`);
      for (const [i, evidence] of before.entries()) {
        assert.equal(evidence.original, native[i].original, `${route} original text`);
        evidence.native = native[i].rows;
        assert(Math.abs(evidence.contentHeight - native[i].height) < 1, `${route} line geometry ${evidence.contentHeight} vs ${native[i].height}: ${evidence.label}`);
        const row = { route, width, ...evidence };
        report.push(row);
        if (JSON.stringify(evidence.native) !== JSON.stringify(evidence.split)) failures.push(row);
      }
      if (route === '/vi/' && width === 390 && out) await page.screenshot({ path: resolve(out, 'vi-390-split.png') });
      // The homepage's normal animation must restore the exact original, including no-break characters.
      if (route === '/' || route === '/vi/') {
        await page.waitForFunction(() => !document.querySelector('.hero .lr-inner'));
        const hero = await page.evaluate(() => {
          const el = document.querySelector('.hero h1');
          return { text: el.textContent, original: window.__lrEvidence.get(el).original, rows: window.__lrRows(el) };
        });
        assert.equal(hero.text, hero.original, `${route} normal completion preserves original`);
        const heroBefore = before.find((e) => e.label.startsWith('H1.'));
        assert.deepEqual(hero.rows, heroBefore.native, `${route} final native rows`);
        if (route === '/vi/' && width === 390 && out) await page.screenshot({ path: resolve(out, 'vi-390-restored.png') });
      }
      // This also restores below-fold headings; no orphaned hidden/duplicated text may survive.
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.waitForFunction(() => !document.querySelector('.lr-inner'));
      assert(await page.evaluate(() => [...window.__lrEvidence].every(([el, e]) => el.textContent === e.original && getComputedStyle(el).visibility === 'visible')), `${route} reduced-motion restoration`);
      const finalRows = await page.evaluate(() => [...window.__lrEvidence].map(([el]) => window.__lrRows(el)));
      for (const [i, rows] of finalRows.entries()) assert.deepEqual(rows, native[i].rows, `${route} natural baseline agrees with actual restored title: ${before[i].label}`);
      await page.reload({ waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      assert(await page.evaluate(() => !document.querySelector('.lr-inner') && [...document.querySelectorAll('[data-lr]')].every((el) => el.textContent.trim() && getComputedStyle(el).visibility === 'visible')), `${route} reduced-motion reload`);
      await page.close();
    }
  }
  if (out) writeFileSync(resolve(out, 'report.json'), JSON.stringify({ report, failures, errors }, null, 2));
  for (const { route, width, label, split, native } of failures) console.error(JSON.stringify({ route, width, label, split, native }));
  assert.deepEqual(errors, [], 'Browser errors');
  assert.equal(failures.length, 0, 'Reveal rows must equal native text rows');
  console.log(`PASS line reveal: ${routes.length} routes, 3 viewports, ${report.length} headings/islands, exact restoration and reduced-motion reload; browser errors 0`);
} finally {
  await browser.close();
}
