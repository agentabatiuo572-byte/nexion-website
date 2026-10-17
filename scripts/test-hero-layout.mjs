// Built homepage layout regression, including every locale present in dist.
// For all nine languages, build with the copy-layout fixture before running.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { readBuiltPages } from './gate-built-routes.mjs';

const base = process.argv[2] || 'http://localhost:4399';
const output = process.argv[3] || 'output/hero-layout';
const homes = readBuiltPages('dist').filter(page => page.home);
const views = [[320, 521], [320, 568], [320, 844], [390, 521], [390, 568], [390, 844], [390, 1000],
  [520, 521], [520, 620], [752, 900], [860, 844], [844, 390], [390, 360]];
mkdirSync(output, { recursive: true });
const browser = await chromium.launch();
const failures = [], samples = [], errors = [];
try {
  for (const home of homes) for (const [width, height] of views) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
    await page.route('**/api/e', route => route.fulfill({ status: 204 }));
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (...args) {
        return this.id === 'x-bg' ? null : original.apply(this, args);
      };
    });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    assert((await page.goto(base + home.route)).ok());
    assert.equal(await page.locator('.hero .subs').evaluate(el => getComputedStyle(el).animationName), 'none', 'Reduced motion must show supporting copy immediately.');
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => document.querySelector('#download.floating'));
    await page.waitForTimeout(600); // Allow the initial reveal and measured announcement offset to settle.
    const dictionary = JSON.parse(readFileSync(`src/i18n/${home.locale}.json`, 'utf8'));
    assert.equal(await page.locator('.hero h1').textContent(), dictionary.hero.title, 'The segmented headline must retain the exact authored text.');
    for (const announcement of ['visible', 'dismissed']) {
      if (announcement === 'dismissed') {
        const close = page.locator('[data-announcement-close]');
        if (!await close.isVisible()) continue;
        await close.click();
        await page.waitForFunction(() => document.querySelector('#x-announcement').hidden);
        await page.waitForTimeout(350); // Navigation animates its top offset after dismissal.
      }
      const result = await page.evaluate(() => {
        const rect = el => el.getBoundingClientRect();
        const title = document.querySelector('.hero h1'), subs = document.querySelector('.hero .subs');
        const dock = rect(document.querySelector('#download')), nav = rect(document.querySelector('.site-nav'));
        const overlap = (a, b) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
        const problems = [], html = document.documentElement;
        for (const el of [title, ...subs.children]) {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            if (!walker.currentNode.textContent.trim()) continue;
            const range = document.createRange(); range.selectNodeContents(walker.currentNode);
            for (const r of range.getClientRects()) {
              if (!r.width || !r.height) continue;
              if (r.left < -1 || r.right > html.clientWidth + 1) problems.push('text overflows horizontally');
              if (overlap(r, nav)) problems.push('navigation obscures text');
              if (overlap(r, dock)) problems.push('download obscures text');
              if (el === title && overlap(r, rect(subs))) problems.push('headline overlaps supporting copy');
            }
          }
        }
        if (html.scrollWidth > html.clientWidth + 1) problems.push('horizontal page overflow');
        const gap = rect(title).top - nav.bottom;
        if (innerHeight >= 521 && Math.abs(gap - 40) > 1) problems.push(`headline/nav gap ${gap}, expected 40px`);
        return { problems: [...new Set(problems)], gap, titleHeight: rect(title).height,
          textBottom: rect(subs).bottom, dockTop: dock.top, fontSize: getComputedStyle(title).fontSize };
      });
      const sample = { locale: home.locale, width, height, announcement, ...result };
      samples.push(sample);
      if (result.problems.length) failures.push(sample);
      if (width === 390 && height === 844) await page.screenshot({ path: `${output}/${home.locale}-${announcement}.png` });
    }
    await page.close();
  }
  for (const home of homes) {
    const page = await browser.newPage({ javaScriptEnabled: false, viewport: { width: 320, height: 568 } });
    assert((await page.goto(base + home.route)).ok());
    await page.evaluate(() => document.fonts.ready);
    const overflow = await page.locator('.site-nav a, .site-nav summary').evaluateAll(elements => elements.filter(el => {
      const r = el.getBoundingClientRect();
      return r.width && (r.left < -1 || r.right > document.documentElement.clientWidth + 1);
    }).map(el => el.textContent.trim()));
    assert.deepEqual(overflow, [], `${home.locale} no-JS navigation overflow`);
    assert.equal(await page.locator('#download .xbtn:visible').count(), 3);
    await page.close();
  }
} finally { await browser.close(); }
writeFileSync(`${output}/results.json`, JSON.stringify({ samples, failures, errors }, null, 2));
assert.deepEqual(errors, [], 'browser errors');
assert.equal(failures.length, 0, `${failures.length} hero layout failures; see ${output}/results.json`);
console.log(`PASS hero layout: ${homes.length} locales, ${samples.length} viewport/announcement cases; console errors=0`);
