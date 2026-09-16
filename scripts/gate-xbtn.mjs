// Built-page regression: button outlines must not reuse decorative hairline contrast.
// node scripts/gate-xbtn.mjs [isolated-dist]; always serve that artifact ourselves.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { preview } from 'vite';
import { readBuiltPages } from './gate-built-routes.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = resolve(process.argv[2] || resolve(root, 'dist'));
const out = process.env.XBTN_OUT && resolve(process.env.XBTN_OUT);
if (out) mkdirSync(out, { recursive: true });
const server = await preview({ configFile: false, root, build: { outDir: dist }, preview: { host: '127.0.0.1', port: 0, open: false } });
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch();
const failures = [], samples = [], errors = [];
let mutations = 0;

// Compute CSS surface contrast with alpha compositing. Decorative canvas/gradients are
// deliberately excluded: screenshots with motion are the separate visual evidence.
function measure(button) {
  const ctx = document.createElement('canvas').getContext('2d');
  const rgba = (color) => {
    ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
    const p = ctx.getImageData(0, 0, 1, 1).data;
    return [p[0], p[1], p[2], p[3] / 255];
  };
  const over = (a, b) => a.slice(0, 3).map((v, i) => v * a[3] + b[i] * (1 - a[3]));
  const luminance = (color) => color.reduce((sum, v, i) => {
    const c = v / 255;
    return sum + (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][i];
  }, 0);
  const chain = [];
  for (let el = button; el; el = el.parentElement) chain.unshift(el);
  let background = [255, 255, 255];
  for (const el of chain) background = over(rgba(getComputedStyle(el).backgroundColor), background);
  const s = getComputedStyle(button), border = rgba(s.borderTopColor);
  const a = luminance(over(border, background)), b = luminance(background);
  const rect = button.getBoundingClientRect();
  return {
    text: (button.querySelector('.xbtn-a, .static') || button).textContent.trim(),
    class: button.className, section: button.closest('section, dialog, nav, main')?.id || button.closest('section, dialog, nav, main')?.className,
    disabled: button.getAttribute('aria-disabled') === 'true', solid: button.classList.contains('solid'),
    paper: Boolean(button.closest('.cert-zoom')), visible: Boolean(rect.width && rect.height),
    border: s.borderTopColor, borderWidth: s.borderTopWidth, borderStyle: s.borderTopStyle,
    color: s.color, background: s.backgroundColor, surface: background,
    ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
    geometry: [rect.width, rect.height, s.padding, s.font, s.borderRadius],
    href: button.getAttribute('href'), outline: [s.outlineStyle, s.outlineWidth],
  };
}

function violations(sample) {
  if (!sample.visible) return [];
  const issues = [];
  // CSS zoom quantizes a declared 1px border (e.g. 0.755906px at 1920).
  if (!(parseFloat(sample.borderWidth) > 0 && parseFloat(sample.borderWidth) <= 1.1) || sample.borderStyle !== 'solid') issues.push('thin outline missing');
  // Preserve the existing independent light-dialog treatment and solid brand fill.
  if (!sample.paper && !sample.solid && sample.ratio < (sample.disabled ? 2 : 3)) issues.push(`faint outline ${sample.ratio.toFixed(2)}:1`);
  if (sample.solid && (sample.background !== 'rgb(158, 220, 29)' || sample.border !== sample.background)) issues.push('solid brand changed');
  if (sample.paper && sample.border !== 'rgba(12, 12, 13, 0.23)') issues.push('light dialog changed');
  return issues;
}

async function record(page, route, width, phase = 'rest') {
  const buttons = page.locator('.xbtn');
  for (let index = 0; index < await buttons.count(); index++) {
    const sample = { route, width, phase, index, ...await buttons.nth(index).evaluate(measure) };
    samples.push(sample);
    for (const issue of violations(sample)) failures.push(`${route} ${width} ${phase} #${index}: ${issue}`);
  }
}

try {
  const pages = [...readBuiltPages(dist), { route: '/404.html', home: false }];
  for (const width of [390, 1440, 1920]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    // Static preview has no telemetry Worker; this probe does not validate analytics.
    await page.route('**/api/e', (route) => route.fulfill({ status: 204 }));
    await page.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (...args) {
        return this.id === 'x-bg' ? null : getContext.apply(this, args);
      };
    });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (e) => { if (e.type() === 'error') errors.push(e.text()); });
    for (const { route, home } of pages) {
      const response = await page.goto(base + route);
      assert(response.ok(), route);
      await page.evaluate(() => document.fonts.ready);
      assert(await page.locator('.xbtn').count() > 0, `No buttons: ${route}`);
      await record(page, route, width);
      if (home) {
        for (const selector of ['.hero .dl', '#path .cards', '#nex .more', '#learn-entry .more', '#final-cta .dl']) {
          const target = page.locator(selector);
          assert.equal(await target.count(), 1, selector);
          await target.scrollIntoViewIfNeeded();
          if (out && width !== 1920) await target.screenshot({ path: resolve(out, `${route === '/' ? 'en' : route.split('/')[1]}-${width}-${selector.replaceAll(/[^a-z0-9]/gi, '_')}.png`) });
        }
        // Hover and keyboard focus must preserve the border and the slide-swap interaction.
        const ghost = page.locator('#nex .xbtn');
        const resting = await ghost.evaluate(measure);
        await ghost.hover();
        await page.waitForFunction(() => getComputedStyle(document.querySelector('#nex .xbtn-b')).transform === 'matrix(1, 0, 0, 1, 0, 0)');
        const hover = await ghost.evaluate(measure);
        assert.equal(hover.border, resting.border);
        assert.equal(await ghost.locator('.xbtn-b').evaluate((el) => getComputedStyle(el).transform), 'matrix(1, 0, 0, 1, 0, 0)');
        await page.mouse.move(0, 0);
        await ghost.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
        assert(await ghost.evaluate((el) => el.matches(':focus-visible')));
        const focused = await ghost.evaluate(measure);
        assert.notEqual(focused.outline[0], 'none');
        assert.equal(focused.border, resting.border);
        const disabled = page.locator('.hero .xbtn.disabled');
        if (await disabled.count()) {
          const url = page.url();
          await disabled.first().focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Space');
          assert.equal(page.url(), url);
          assert.equal(await disabled.first().getAttribute('aria-disabled'), 'true');
        }
        await page.locator('a[data-src]').first().click();
        assert(await page.locator('.cert-zoom').isVisible(), 'Real certificate opener');
        await record(page, route, width, 'dialog');
        if (out && width !== 1920) await page.locator('.cert-zoom-close').screenshot({ path: resolve(out, `${route === '/' ? 'en' : route.split('/')[1]}-${width}-dialog.png`) });
        await page.locator('.cert-zoom .xbtn').click();
        assert(!(await page.locator('.cert-zoom').isVisible()), 'Real close action');
        // Execute the same measurement against the actual old token-based declarations.
        const old = await page.addStyleTag({ content: '.xbtn:not(.solid) { border-color:var(--x-line) !important } .xbtn.disabled { border-color:var(--x-line-soft) !important }' });
        await page.waitForFunction(() => getComputedStyle(document.querySelector('#nex .xbtn')).borderTopColor === 'rgba(255, 255, 255, 0.16)');
        const oldGhost = await ghost.evaluate(measure);
        assert(violations(oldGhost).length > 0, `Old --x-line must fail: ${JSON.stringify(oldGhost)}`); mutations++;
        if (await disabled.count()) {
          assert(violations(await disabled.first().evaluate(measure)).length > 0, 'Old --x-line-soft must fail'); mutations++;
        }
        await old.evaluate((el) => el.remove());
        await page.reload(); await page.evaluate(() => document.fonts.ready);
        await record(page, route, width, 'reload');
      }
    }
    await page.close();
  }
  assert(mutations > 0, 'Missing mutation controls');
  assert.equal(errors.length, 0, `Browser errors: ${errors.join('; ')}`);
} finally {
  if (out) writeFileSync(resolve(out, 'evidence.json'), JSON.stringify({ samples, failures, errors, mutations }, null, 2));
  await browser.close();
  await new Promise((done) => server.httpServer.close(done));
}
console.log(`[xbtn] ${samples.length} samples, ${mutations} red controls, ${failures.length} failures`);
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
