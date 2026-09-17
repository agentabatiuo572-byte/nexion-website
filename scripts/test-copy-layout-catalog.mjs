import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve, join, extname } from 'node:path';
import { COPY_LAYOUT_CATALOG as catalog } from './copy-layout-catalog.mjs';

const manifest = JSON.parse(readFileSync(new URL('../worker/seed/copy-manifest.json', import.meta.url), 'utf8'));
const families = ['sku.name', 'sku.tagline', 'faq.q', 'faq.a', 'announcement.text', 'seo.title', 'seo.description', 'legal.md', 'footer.contactEmail', 'geo.title', 'geo.body', 'link'];
assert.deepEqual(Object.keys(catalog).sort(), [...manifest.editable, ...families].sort(), 'Every editable copy key and field family needs explicit classification.');
for (const [key, field] of Object.entries(catalog)) {
  assert.ok(['bounded', 'flowing', 'metadata', 'seo', 'system'].includes(field.kind), `${key}: invalid kind`);
  assert.ok(field.basis === undefined || field.basis === 'reference', `${key}: invalid optional basis`);
  if (field.basis === 'reference') assert.equal(field.kind, 'bounded', `${key}: reference estimates need the advisory-budget kind`);
  assert.ok(field.description.trim(), `${key}: explain the actual layout classification`);
  assert.ok(Array.isArray(field.consumers), `${key}: missing consumers`);
  if (['bounded', 'flowing'].includes(field.kind)) assert.ok(field.consumers.length, `${key}: visible text needs a consumer`);
  for (const consumer of field.consumers) {
    assert.ok(['home', 'nex', 'learn', 'article', 'legal', '404', 'all'].includes(consumer.route), `${key}: invalid route`);
    assert.ok(consumer.selector.trim(), `${key}: missing selector`);
    if (field.kind === 'bounded') {
      assert.ok(['inline', 'block', 'hero', 'section', 'card'].includes(consumer.constraint), `${key}: missing constraint`);
      assert.ok(consumer.boundary?.trim(), `${key}: missing real structural boundary`);
    } else {
      assert.equal(consumer.maxLines, undefined, `${key}: growing content cannot inherit an arbitrary line cap`);
    }
  }
}
assert.equal(catalog['faq.a'].kind, 'flowing');
assert.equal(catalog['legal.md'].kind, 'flowing');
assert.equal(catalog['final.title'].kind, 'flowing');
assert.equal(catalog['nex.getApp'].consumers.length, 3, 'App CTA is shared by NEX, Learn list and articles.');
assert.equal(catalog['nex.whitepaper'].consumers.length, 2, 'PDF CTA is shared by homepage and NEX.');
assert.equal(catalog['learn.toc'].consumers.length, 2, 'TOC label is shared by articles and legal pages.');
assert.equal(catalog['nav.trust'].consumers.length, 2, 'Trust navigation label is also a section kicker.');
assert.equal(catalog['nav.learn'].consumers.length, 2, 'Learn navigation label is also a section kicker.');
for (const key of ['hero.title', 'hero.subtitle', 'hero.subtitle2', 'hero.note', 'hero.note2', 'hero.scrollHint']) {
  assert.equal(catalog[key].basis, 'reference', `${key}: hero uses the approved composition as a reference, not a fixed container maximum`);
  assert.ok(catalog[key].description.includes('默认断行/版式') && catalog[key].description.includes('可自动增高') && catalog[key].description.includes('不代表截断'), `${key}: explain the scope of the reference estimate`);
  assert.ok(catalog[key].consumers.every((consumer) => consumer.maxLines === undefined), `${key}: a default line count must not become a hard line cap`);
}
for (const key of ['sku.name', 'sku.tagline', 'devices.free', 'devices.multiplierLabel']) {
  assert.equal(catalog[key].basis, 'reference', `${key}: aspect-ratio alone is not a fixed card height`);
  assert.ok(catalog[key].description.includes('可自然增高') && catalog[key].description.includes('不代表截断'));
}
assert.equal(catalog['nav.skip'].kind, 'flowing', 'The skip link has no nowrap rule or fixed text height.');
assert.equal(catalog['trust.openOriginal'].kind, 'flowing', 'The original-image link wraps while the dialog image can shrink.');
console.log(`copy-layout-catalog: ${manifest.editable.length} editable keys + ${families.length} families; explicit classification and shared consumers pass`);

// Optional read-only browser check against an explicit built snapshot. The server's
// response is compared byte-for-byte with that snapshot before selectors are checked.
const built = process.argv.find((arg) => arg.startsWith('--dist='))?.slice('--dist='.length);
if (built) {
  const dist = resolve(built);
  const names = readdirSync(dist, { recursive: true }).filter((name) => extname(name) === '.html');
  assert.ok(names.length, 'Built snapshot must contain HTML pages.');
  const pages = names.map((name) => {
    const path = name.replaceAll('\\', '/');
    const parts = path.split('/');
    const locale = ['vi', 'es', 'pt', 'fr', 'de', 'ja', 'ko', 'zh'].includes(parts[0]) ? parts.shift() : 'en';
    const route = parts[0] === '404.html' ? '404' : parts[0] === 'nex' ? 'nex'
      : parts[0] === 'legal' ? 'legal' : parts[0] === 'learn' ? parts.length > 2 ? 'article' : 'learn' : 'home';
    return { path, locale, route, html: readFileSync(join(dist, name), 'utf8') };
  });
  const expectedLocales = Object.keys(manifest).filter((key) => key !== 'editable').sort();
  assert.deepEqual([...new Set(pages.map((page) => page.locale))].sort(), expectedLocales, 'Consumer acceptance needs the complete language snapshot.');
  assert.deepEqual(pages.filter((page) => page.route === '404').map((page) => page.locale).sort(), expectedLocales, 'Each language needs its own 404 document.');
  // Only these individual positions are conditional. In particular the H5 navigation
  // link can be absent, but both H5 download buttons still render in their disabled state.
  const conditional = new Set(['nav.launchH5:0', 'devices.comingBadge:0', 'announcement.text:0', 'footer.contact:0', 'footer.contactEmail:0', 'learn.enOnly:0', 'learn.untranslated:0', 'legal.enPrevails:0', 'stats.asOf:0']);
  const byPath = new Map(pages.map((page) => [`/${page.path}`, page.html]));
  const server = createServer((request, response) => {
    const html = byPath.get(new URL(request.url, 'http://localhost').pathname);
    response.writeHead(html === undefined ? 404 : 200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(html ?? 'Not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const require = createRequire(new URL('../../Nexion-uniapp/package.json', import.meta.url));
  let browser;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ javaScriptEnabled: false });
    const tab = await context.newPage();
    const matches = new Map();
    const port = server.address().port;
    for (const page of pages) {
      const response = await tab.goto(`http://127.0.0.1:${port}/${page.path}`, { waitUntil: 'domcontentloaded' });
      assert.equal(await response.text(), page.html, `Wrong snapshot served for ${page.path}`);
      const candidates = Object.entries(catalog).flatMap(([key, field]) => field.consumers
        .map((consumer, index) => ({ key, index, ...consumer }))
        .filter((consumer) => consumer.route === 'all' || consumer.route === page.route));
      const counts = await tab.evaluate((candidates) => candidates.map((consumer) => {
        const elements = [...document.querySelectorAll(consumer.selector)];
        const missingBoundary = consumer.boundary ? elements.some((element) => !element.closest(consumer.boundary)) : false;
        return { key: consumer.key, index: consumer.index, count: elements.length, missingBoundary };
      }), candidates);
      for (const result of counts) {
        assert.equal(result.missingBoundary, false, `${page.path} ${result.key}: consumer has no matching boundary`);
        const consumer = catalog[result.key].consumers[result.index];
        if (consumer.route === 'all' && !result.key.startsWith('notfound.') && !result.key.startsWith('geo.') && !conditional.has(`${result.key}:${result.index}`)) {
          assert.ok(result.count > 0, `${page.path} ${result.key}: mandatory shared consumer is missing on this page`);
        }
        const id = `${page.locale}:${result.key}:${result.index}`;
        matches.set(id, (matches.get(id) ?? 0) + result.count);
      }
      if (page.route === '404') {
        const blocks = await tab.evaluate(() => [...document.querySelectorAll('.nf .blk')].map((block) => ({
          locale: block.getAttribute('lang'),
          hasTitle: Boolean(block.querySelector('.title')),
          hasBody: Boolean(block.querySelector('.body')),
          hasHome: Boolean(block.querySelector('.xbtn')),
        })));
        assert.deepEqual(blocks.map((block) => block.locale), [page.locale], '404 must include only its own language block.');
        assert.ok(blocks.every((block) => block.hasTitle && block.hasBody && block.hasHome), 'Each 404 language block needs its title, body and home button.');
      }
    }
    const unmatched = [];
    for (const locale of [...new Set(pages.map((page) => page.locale))]) {
      for (const [key, field] of Object.entries(catalog)) {
        if (key.startsWith('geo.')) continue; // Worker HTML is outside an Astro snapshot.
        for (const [index, consumer] of field.consumers.entries()) {
          if (!(matches.get(`${locale}:${key}:${index}`) > 0)) {
            const label = `${locale}:${key}:${consumer.selector}`;
            assert.ok(conditional.has(`${key}:${index}`), `Missing source consumer: ${label}`);
            unmatched.push(label);
          }
        }
      }
    }
    console.log(JSON.stringify({ builtPages: pages.length, locales: [...new Set(pages.map((page) => page.locale))].sort(), conditionalMissing: unmatched }, null, 2));
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
