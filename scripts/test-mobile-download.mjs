// Built-page regression for the narrow-screen conversion disclosure.
// Run against the asserted production preview: node scripts/test-mobile-download.mjs [base-url]
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { homeRoutes, readBuiltPages } from './gate-built-routes.mjs';

const base = process.argv[2] || 'http://127.0.0.1:4399';
const browser = await chromium.launch();
const errors = [];
let checks = 0;
const views = [[320, 521], [320, 568], [390, 521], [390, 568], [390, 844], [520, 521], [520, 568], [520, 620], [520, 720], [752, 900], [844, 390], [390, 360], [860, 844]];
try {
  for (const route of homeRoutes(readBuiltPages('dist'))) for (const [width, height] of views) {
    const locale = route === '/' ? '' : route.slice(0, -1);
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
    await page.route('**/api/e', (route) => route.fulfill({ status: 204 }));
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (...args) { return this.id === 'x-bg' ? null : original.apply(this, args); };
    });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    assert((await page.goto(`${base}${locale}/`)).ok());
    await page.evaluate(() => document.fonts.ready);
    const dock = page.locator('#download'), options = page.locator('#download-options'), toggle = page.locator('.download-toggle');
    await page.waitForFunction(() => document.querySelector('#download').classList.contains('floating'));
    assert(await options.isVisible()); assert(await toggle.isHidden());
    assert.equal(await options.locator('.xbtn:visible').count(), 3);
    const fit = async () => {
      const sample = await dock.evaluate((el) => {
        const r = el.getBoundingClientRect(), nav = document.querySelector('.site-nav').getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, navBottom: nav.bottom,
          viewport: document.documentElement.getBoundingClientRect().width, height: innerHeight,
          buttons: [...el.querySelectorAll('.xbtn')].filter(b => b.getClientRects().length).map(b => ({ width: b.getBoundingClientRect().width, height: b.getBoundingClientRect().height, overflow: b.scrollWidth - b.clientWidth })) };
      });
      assert(sample.left >= 0 && sample.right <= sample.viewport + 1, JSON.stringify(sample));
      assert(sample.top >= sample.navBottom && sample.bottom <= sample.height, JSON.stringify(sample));
      assert(sample.buttons.every(b => b.width >= 44 && b.height >= 44 && b.overflow <= 1), JSON.stringify(sample));
    };
    await fit();
    const collisions = await page.evaluate(() => {
      const dock = document.querySelector('#download').getBoundingClientRect();
      return [...document.querySelectorAll('.hero h1, .hero .subs p')].flatMap(el => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), boxes = [];
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (!node.textContent.trim() || node.parentElement.closest('.x-sr')) continue;
          const range = document.createRange(); range.selectNodeContents(node);
          for (const r of range.getClientRects()) if (r.width > 0 && r.top < dock.bottom && r.bottom > dock.top && r.left < dock.right && r.right > dock.left) boxes.push(node.textContent.trim());
        }
        return boxes;
      });
    });
    assert.deepEqual(collisions, [], `${locale} ${width}x${height} hero copy obscured`);
    const hrefs = await options.locator('.xbtn').evaluateAll(els => els.map(el => el.getAttribute('href')));
    assert.deepEqual(hrefs, await page.locator('#final-cta .dl .xbtn').evaluateAll(els => els.map(el => el.getAttribute('href'))));
    await options.locator('.xbtn').first().focus();
    await page.evaluate(() => scrollTo(0, 160));
    await toggle.waitFor({ state: 'visible' });
    assert(await options.isHidden()); assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert(await toggle.evaluate(el => el === document.activeElement));
    await fit();
    await toggle.click(); assert(await options.isVisible()); assert(await toggle.isHidden());
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true'); await fit();
    const focusFits = await options.evaluate(el => {
      const box = el.getBoundingClientRect();
      return [...el.querySelectorAll('.xbtn')].every(button => {
        button.focus();
        const r = button.getBoundingClientRect(), style = getComputedStyle(button);
        const ring = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
        return r.left - ring >= box.left && r.right + ring <= box.right && r.bottom + ring <= box.bottom;
      });
    });
    assert(focusFits, `${locale} ${width}x${height} focus ring clipped`);
    await options.locator('.xbtn').first().focus();
    await page.keyboard.press('Escape'); assert(await options.isHidden()); assert(await toggle.evaluate(el => el === document.activeElement));
    await page.keyboard.press('Enter'); assert(await options.isVisible()); assert(await toggle.isHidden());
    assert(await options.locator('.xbtn').first().evaluate(el => el === document.activeElement));
    await page.mouse.click(3, height / 2); assert(await options.isHidden()); assert(await toggle.isVisible());
    await toggle.click();
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForFunction(() => scrollY <= 8);
    await toggle.waitFor({ state: 'hidden' }); assert(await options.isVisible());
    await page.locator('.menu-toggle').click();
    assert(await dock.evaluate(el => Boolean(el.closest('[inert]'))));
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1024, height: 844 });
    await page.waitForFunction(() => !document.querySelector('#download').classList.contains('floating'));
    assert(await toggle.isHidden()); assert(await options.isVisible());
    assert.equal(await dock.evaluate(el => getComputedStyle(el).position), 'static');
    await page.setViewportSize({ width, height });
    await page.waitForFunction(() => document.querySelector('#download').classList.contains('floating'));
    await page.evaluate(() => scrollTo(0, 1500));
    await toggle.waitFor({ state: 'visible' }); assert(await options.isHidden());
    await page.locator('#devices .cta').click();
    await page.waitForFunction(() => scrollY <= 8);
    await options.waitFor({ state: 'visible' });
    assert(await options.isVisible());
    await page.goto(`${base}${locale}/#download`);
    await page.waitForTimeout(300);
    assert(await options.isVisible(), `${locale} ${width} direct download fragment must expose the links`);
    await page.close(); checks++;
  }
  const noJs = await browser.newPage({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  await noJs.goto(base);
  assert.equal(await noJs.locator('#download .xbtn:visible').count(), 3);
  assert(await noJs.locator('.download-toggle').isHidden());
  await noJs.close();
  assert.equal(errors.length, 0, errors.join('; '));
  console.log(`PASS mobile downloads: ${checks} locale/viewport journeys, no-JS fallback, console errors=0`);
} finally { await browser.close(); }
