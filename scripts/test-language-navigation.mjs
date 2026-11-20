// node scripts/test-language-navigation.mjs [http://localhost:4399] [--webkit]
// The normal behavior gate reuses its Chromium and isolated static build.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';

const normalized = text => text.replace(/\s+/gu, ' ').trim();
const pagePath = (locale, route) => `${locale === 'en' ? '' : `/${locale}`}${route}`;

async function activateText(page, label, touch, observeScramble = false) {
  await label.scrollIntoViewIfNeeded();
  const original = await label.textContent();
  const point = await label.evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const rect = range.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  if (touch) {
    await page.touchscreen.tap(point.x, point.y);
    return;
  }
  await page.mouse.move(point.x, point.y);
  if (observeScramble) {
    await page.waitForFunction(({ element, original }) => element.textContent !== original,
      { element: await label.elementHandle(), original });
  } else {
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  }
  const textNode = await label.evaluateHandle(element => element.firstChild);
  await page.mouse.down();
  // WebKit cancels click if pointerdown replaces the hit-tested text node.
  // Chromium keeps dispatching click, so also enforce hit-target continuity there.
  assert(await textNode.evaluate(node => node.isConnected), 'pointerdown detached the clicked text node');
  await textNode.dispose();
  await page.mouse.up();
}

export async function testLanguageNavigation(browser, baseUrl, enabledLocales) {
  let checks = 0;
  for (const touch of [false, true]) {
    const context = await browser.newContext({
      viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      hasTouch: touch, isMobile: touch, reducedMotion: 'no-preference',
    });
    try {
      // Static previews have no Worker analytics endpoint; navigation is the scope here.
      await context.route(new URL('/api/e', baseUrl).href, route => route.fulfill({ status: 204 }));
      const page = await context.newPage();
      page.setDefaultTimeout(7000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => {
        if (message.type() === 'error') errors.push(`${message.text()} (${message.location().url})`);
      });
      await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
      const locales = await page.locator('.lang-picker a').evaluateAll(links => links.map(link => link.hreflang));
      assert(locales.length > 0, 'language menu has no enabled locales');
      if (enabledLocales) assert.deepEqual(locales, enabledLocales, 'language menu differs from enabled locales');
      const copy = Object.fromEntries(locales.map(locale => [locale,
        JSON.parse(readFileSync(new URL(`../src/i18n/${locale}.json`, import.meta.url), 'utf8'))]));
      const picker = page.locator('.lang-picker');
      const summary = picker.locator('summary');
      for (const route of ['/', '/uvt/']) {
        let current = locales[0];
        await page.goto(`${baseUrl}${pagePath(current, route)}`, { waitUntil: 'networkidle' });
        // Rotate the list so every item is reached by a real language change.
        for (const locale of [...locales.slice(1), locales[0]]) {
          if (touch) await page.locator('.menu-toggle').tap();
          else {
            await page.mouse.move(0, 400);
            await page.waitForTimeout(650); // Shared hover engine arms 600ms after navigation.
          }
          await activateText(page, summary.locator('[data-scr-label]'), touch, current === 'en');
          assert.equal(await picker.evaluate(element => element.open), true, `${current}${route}: text opens menu`);
          const link = picker.locator(`a[hreflang="${locale}"]`);
          const destination = new URL(pagePath(locale, route), baseUrl).href;
          assert.equal(new URL(await link.getAttribute('href'), baseUrl).href, destination);
          await activateText(page, link, touch, locale === 'en');
          await page.waitForURL(destination, { waitUntil: 'networkidle' });
          assert.equal(await page.locator('html').getAttribute('lang'), locale);
          const expected = route === '/' ? copy[locale].hero : copy[locale].uvt;
          const heading = await page.locator('h1').evaluate(element => {
            const copy = element.cloneNode(true);
            copy.querySelectorAll('[aria-hidden="true"]').forEach(node => node.remove());
            return copy.textContent;
          });
          assert.equal(normalized(heading),
            normalized(route === '/' ? expected.title : expected.pageTitle));
          assert.equal(normalized(await page.locator(route === '/' ? '.hero .note' : '.uvt-page .lead').textContent()),
            normalized(route === '/' ? expected.subtitle : expected.pageLead));
          current = locale;
          checks++;
        }
        if (touch) await page.locator('.menu-toggle').tap();
        await summary.focus();
        await page.keyboard.press('Enter');
        assert.equal(await picker.evaluate(element => element.open), true, 'Enter opens language menu');
        await page.keyboard.press('Escape');
        assert.equal(await picker.evaluate(element => element.open), false, 'Escape closes language menu');
        assert(await summary.evaluate(element => element === document.activeElement), 'Escape returns summary focus');
        await page.keyboard.press('Space');
        assert.equal(await picker.evaluate(element => element.open), true, 'Space opens language menu');
        // This WebKit host skips anchors in sequential focus; test Enter activation
        // with explicit focus there, and retain real Tab-order coverage in Chromium.
        const target = locales.length > 1 ? locales[1] : locales[0];
        if (browser.browserType().name() === 'webkit') await picker.locator(`a[hreflang="${target}"]`).focus();
        else for (let tab = 0; tab <= locales.indexOf(target); tab++) await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('hreflang')), target);
        await page.keyboard.press('Enter');
        await page.waitForURL(new URL(pagePath(target, route), baseUrl).href, { waitUntil: 'networkidle' });
        assert.equal(await page.locator('html').getAttribute('lang'), target);
        checks++;
      }
      assert.deepEqual(errors, [], 'language navigation must not emit browser errors');
    } finally {
      await context.close();
    }
  }
  console.log(`[language-navigation] ✓ ${checks} pointer/touch/keyboard navigation paths`);
  return checks;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const baseUrl = process.argv.slice(2).find(argument => !argument.startsWith('--')) || 'http://localhost:4399';
  const browser = await (process.argv.includes('--webkit') ? webkit : chromium).launch({ headless: true });
  try {
    await testLanguageNavigation(browser, baseUrl);
  } finally {
    await browser.close();
  }
}
