// Build + preview on 4399 first. Checks the title's paint through reveal and fallback states.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = resolve(root, 'dist');
const pages = readdirSync(dist, { recursive: true }).filter((p) => p.endsWith('index.html'));
const homes = pages.filter((p) => readFileSync(resolve(dist, p), 'utf8').includes('<h1 class="x-display-mega"'));
assert(homes.length > 0, 'No built homepages found');
const route = (p) => '/' + relative(dist, resolve(dist, p)).split(sep).join('/').replace('index.html', '');
const base = process.env.PREVIEW_URL || 'http://localhost:4399';
const browser = await chromium.launch();
const errors = [];
let checks = 0;
const watchErrors = (page) => {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (e) => { if (e.type() === 'error') errors.push(e.text()); });
};
const paint = (e) => {
  const s = getComputedStyle(e);
  return { image: s.backgroundImage, clip: s.backgroundClip, fill: s.webkitTextFillColor, color: s.color,
    period: parseFloat(s.backgroundSize.split(',')[0].split(' ')[1]), lineHeight: parseFloat(s.lineHeight) };
};
const gradient = (p) => {
  assert(p.image.includes('linear-gradient') && p.image.includes('feTurbulence'), `Silver gradient and grain must render: ${JSON.stringify(p)}`);
  assert(p.clip.split(',').every((layer) => layer.trim() === 'text'));
  assert.equal(p.fill, 'rgba(0, 0, 0, 0)');
  assert(Number.isFinite(p.lineHeight) && Math.abs(p.period - p.lineHeight) < 0.05, 'Gradient repeats at the existing line height');
  checks++;
};
const open = async (path, options = {}) => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, ...options });
  watchErrors(page);
  const response = await page.goto(base + route(path));
  assert(response?.ok(), route(path));
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot(); // Flush a real frame after navigation/media setup before reading paint.
  return page;
};
try {
  for (const path of homes) {
    for (const [width, height] of [[320, 844], [390, 844], [844, 390], [1024, 900], [1440, 900], [1920, 1000], [2560, 1200]]) {
      console.log(`Checking ${route(path)} ${width}x${height}`);
      const page = await open(path, { reducedMotion: 'reduce', viewport: { width, height } });
      const title = page.locator('.hero h1');
      gradient(await title.evaluate(paint));
      const before = await title.boundingBox();
      // Paint-only change: disabling the finish must leave every hero element's geometry intact.
      const geometry = () => [...document.querySelectorAll('.hero, .hero *')].map((e) => e.getBoundingClientRect().toJSON());
      const painted = await page.evaluate(geometry);
      const override = await page.addStyleTag({ content: '.hero h1 { background-image:none !important; -webkit-text-fill-color:currentColor !important; }' });
      assert.deepEqual(await page.evaluate(geometry), painted);
      await override.evaluate((e) => e.remove());
      assert(before.width > 0 && before.x >= 0 && before.x + before.width <= width + 1, 'Title stays in viewport');
      await page.reload();
      await page.evaluate(() => document.fonts.ready);
      gradient(await title.evaluate(paint));
      for (const mode of ['print', 'forced']) {
        await page.emulateMedia(mode === 'print' ? { media: 'print' } : { media: 'screen', forcedColors: 'active' });
        await page.waitForFunction(() => {
          const s = getComputedStyle(document.querySelector('.hero h1'));
          return s.backgroundImage === 'none' && s.webkitTextFillColor === s.color;
        });
        const p = await title.evaluate(paint);
        assert.equal(p.image, 'none');
        assert.equal(p.fill, p.color);
        assert.notEqual(p.fill, 'rgba(0, 0, 0, 0)');
        checks++;
      }
      await page.close();
    }
    // Freeze the actual reveal mid-transition so every transient line can be inspected reliably.
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    watchErrors(page);
    await page.route('**/*.css', async (r) => {
      const response = await r.fetch();
      await r.fulfill({ response, body: await response.text() + '\n.hero .lr-inner { transition-duration: 30s !important; }' });
    });
    await page.goto(base + route(path));
    await page.locator('.hero .lr-inner.in').first().waitFor();
    for (const inner of await page.locator('.hero .lr-inner').all()) gradient(await inner.evaluate(paint));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => !document.querySelector('.hero .lr-inner'));
    gradient(await page.locator('.hero h1').evaluate(paint));
    await page.close();
    const noJS = await open(path, { javaScriptEnabled: false });
    gradient(await noJS.locator('.hero h1').evaluate(paint));
    await noJS.close();
  }
  // Enumerate built routes: the effect belongs to homepage H1s only.
  for (const path of pages) {
    const page = await open(path, { reducedMotion: 'reduce' });
    for (const heading of await page.locator('h1:not(.hero h1.x-display-mega), h2, h3').all()) {
      assert(!(await heading.evaluate(paint)).image.includes('feTurbulence'), 'Finish leaked to another heading');
    }
    await page.close();
  }
  assert.deepEqual(errors, [], 'Browser errors');
  console.log(`PASS hero finish: ${homes.length} homepages, 7 viewports, ${pages.length} routes, ${checks} paint/fallback checks; browser errors 0`);
} finally {
  await browser.close();
}
