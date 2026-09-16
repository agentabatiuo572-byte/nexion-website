// Runs the production hash handler with real Lenis and a deterministic stale dimensions cache.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { transpileModule } from 'typescript';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = readFileSync(resolve(root, 'src/scripts/fx.ts'), 'utf8');
const start = source.indexOf('function initHashNavigation()');
const end = source.indexOf('function initCertZoom()', start);
assert(start >= 0 && end > start, 'Production hash navigation source');
const handler = source.slice(start, end);
const sourceSha = createHash('sha256').update(handler).digest('hex');
const out = process.env.HASH_NAVIGATION_OUT;
if (out) mkdirSync(out, { recursive: true });
const cases = [
  { name: 'expand-then-click', hidden: false, reduced: false },
  { name: 'target-in-closed-details', hidden: true, reduced: false },
  { name: 'reduced-native', hidden: true, reduced: true },
];
assert(cases.length > 0, 'Hash navigation requires fixtures');
const browser = await chromium.launch();
const results = [];
const errors = [];
try {
  for (const test of cases) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: test.reduced ? 'reduce' : 'no-preference' });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (e) => { if (e.type() === 'error') errors.push(e.text()); });
    const target = '<h2 id="end-of-policy">End of policy</h2>';
    await page.route('http://hash-navigation.test/', (r) => r.fulfill({ contentType: 'text/html', body: `
      <style>body{margin:0;padding-top:80px}.site-nav{position:fixed;inset:0 0 auto;height:64px;background:white}h2{margin:0}.expansion{height:2400px}footer{height:1000px}</style>
      <nav class="site-nav"><a href="#end-of-policy">Last section</a></nav>
      <details><summary>Contents</summary><div class="expansion"></div>${test.hidden ? target : ''}</details>
      ${test.hidden ? '' : target}<footer></footer>` }));
    await page.goto('http://hash-navigation.test/');
    await page.addScriptTag({ path: resolve(root, 'node_modules/lenis/dist/lenis.js') });
    const code = transpileModule(`
      const reduced = ${test.reduced};
      const lenisInst = reduced ? null : new Lenis({ autoResize: false, autoRaf: true, duration: 0.12, lerp: 0, easing: (t: number) => t });
      window.__lenis = lenisInst;
      ${handler}
      initHashNavigation();`, { compilerOptions: { target: 99 } }).outputText;
    await page.addScriptTag({ content: code });
    const before = await page.evaluate(() => ({ limit: window.__lenis?.limit ?? null, height: document.documentElement.scrollHeight }));
    // Expansion and click share one browser task: there is no resize-observer wait to hide the bug.
    await page.evaluate((hidden) => {
      if (!hidden) document.querySelector('details').open = true;
      document.querySelector('a').click();
    }, test.hidden);
    await page.waitForFunction(() => Math.abs(document.querySelector('h2').getBoundingClientRect().top - document.querySelector('.site-nav').getBoundingClientRect().bottom - 10) < 1, null, { timeout: 1500 }).catch((error) => {
      if (error.name !== 'TimeoutError') throw error; // A wrong landing is recorded below; other browser failures are not swallowed.
    });
    const after = await page.evaluate(() => {
      const target = document.querySelector('h2').getBoundingClientRect();
      return { limit: window.__lenis?.limit ?? null, height: document.documentElement.scrollHeight,
        targetTop: target.top, targetBottom: target.bottom, navBottom: document.querySelector('.site-nav').getBoundingClientRect().bottom,
        viewport: innerHeight, scrollY, hash: location.hash, focus: document.activeElement.id, open: document.querySelector('details').open };
    });
    const pass = after.open && after.hash === '#end-of-policy' && after.focus === 'end-of-policy'
      && Math.abs(after.targetTop - after.navBottom - 10) < 1 && after.targetBottom <= after.viewport;
    assert(after.height > before.height + 2000, `${test.name}: the fixture must actually expand`);
    const result = { ...test, before, after, pass };
    results.push(result);
    if (!pass) console.error(JSON.stringify(result));
    if (out) await page.screenshot({ path: resolve(out, `${test.name}.png`) });
    await page.evaluate(() => window.__lenis?.destroy());
    await page.close();
  }
  if (out) writeFileSync(resolve(out, 'report.json'), JSON.stringify({ sourceSha, results, errors }, null, 2));
  assert.equal(results.length, cases.length, 'Every navigation fixture ran');
  assert.deepEqual(errors, [], 'Browser errors');
  assert(results.every((r) => r.pass), 'Expanded anchors must land below navigation, in view, focused, with the correct hash');
  console.log(`hash-navigation self-test: ${results.length} pass (real Lenis, immediate expansion, hidden target, reduced motion)`);
} finally { await browser.close(); }
