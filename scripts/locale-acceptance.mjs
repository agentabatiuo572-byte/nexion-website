// Build real language selections without modifying authored content or the running site.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { buildSeed } from '../worker/build-seed.mjs';
import { materializeAll } from '../schema/src/materialize.ts';
import { LOCALES, DEFAULT_ENABLED_LOCALES } from '../schema/src/locales.ts';
import { SiteConfigSchema } from '../schema/src/site-config.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = join(root, '.codex/locale-review');
mkdirSync(output, { recursive: true });
const temp = mkdtempSync(join(output, 'artifacts-'));
const args = process.argv.slice(2);
assert(args.length === 0 || (args.length === 4 && args[0] === '--draft' && args[2] === '--sha'), 'Usage: locale-acceptance.mjs [--draft frozen-config.json --sha SHA256]');
const seed = buildSeed();
let config = seed.config;
let source = { kind: 'seed' };
if (args.length) {
  const bytes = readFileSync(resolve(args[1]));
  const sha = createHash('sha256').update(bytes).digest('hex');
  assert.equal(sha, args[3].toLowerCase(), 'Frozen draft SHA-256 does not match');
  config = SiteConfigSchema.parse(JSON.parse(bytes.toString('utf8')));
  source = { kind: 'frozen-draft', path: resolve(args[1]), sha };
}
const { manifest } = seed;
const report = { status: 'running', source, variants: [], errors: [] };
writeFileSync(join(output, 'public-runtime.json'), JSON.stringify(report));
const articles = readdirSync(join(root, 'src/content/learn/en')).filter((name) => name.endsWith('.md'));
const paths = ['/', '/nex/', '/learn/', '/legal/terms/', '/legal/privacy/', '/legal/app-privacy/', ...articles.map((name) => `/learn/${name.slice(0, -3)}/`)];
const route = (locale, path) => `${locale === 'en' ? '' : `/${locale}`}${path}`;
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.xml': 'application/xml', '.ico': 'image/x-icon' };

async function build(name, enabled) {
  const fixture = join(temp, `${name}-fixture`), dist = join(temp, `${name}-dist`);
  mkdirSync(fixture);
  const files = materializeAll({ ...config, enabledLocales: enabled }, manifest);
  for (const locale of LOCALES) writeFileSync(join(fixture, `${locale}.json`), files.i18n[locale]);
  writeFileSync(join(fixture, 'site.json'), files.siteJson);
  await new Promise((done, reject) => {
    const buildEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AI_|OPENAI_)/i.test(key)));
    const child = spawn(process.execPath, [join(root, 'node_modules/astro/bin/astro.mjs'), 'build', '--outDir', dist], { cwd: root, env: { ...buildEnv, NEXGRID_SITE_FIXTURE_DIR: fixture }, windowsHide: true });
    let log = '';
    child.stdout.on('data', (data) => { log += data; });
    child.stderr.on('data', (data) => { log += data; });
    child.on('error', reject);
    child.on('close', (code) => { writeFileSync(join(output, `build-${name}.log`), log); code === 0 ? done() : reject(new Error(`${name} build failed: ${log.slice(-4000)}`)); });
  });
  return dist;
}

async function serve(dist) {
  const server = createServer((req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (pathname === '/api/e') return res.writeHead(204).end();
      let file = resolve(dist, `.${pathname}`);
      if (!file.startsWith(dist + sep) && file !== dist) return res.writeHead(400).end();
      if (pathname.endsWith('/')) file = join(file, 'index.html');
      if (!existsSync(file) || !statSync(file).isFile()) return res.writeHead(404).end('Not found');
      res.writeHead(200, { 'Content-Type': `${mime[extname(file)] ?? 'application/octet-stream'}; charset=utf-8` }).end(readFileSync(file));
    } catch { res.writeHead(400).end(); }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const browser = await chromium.launch({ headless: true, args: ['--disable-features=AutoDarkMode'] });
try {
  const variants = [['all-nine', [...LOCALES]], ['english-only', ['en']], ['default-selection', [...DEFAULT_ENABLED_LOCALES]]];
  if (source.kind === 'frozen-draft' && config.enabledLocales.length !== LOCALES.length) variants.unshift(['actual-selection', config.enabledLocales]);
  for (const [name, enabled] of variants) {
    const dist = await build(name, enabled);
    const { server, base } = await serve(dist);
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', colorScheme: 'light' });
    await context.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (...args) { return this.id === 'x-bg' ? null : getContext.apply(this, args); };
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => report.errors.push({ variant: name, url: page.url(), error: error.message }));
    page.on('console', (message) => { if (message.type() === 'error') report.errors.push({ variant: name, url: page.url(), error: message.text() }); });
    const result = { name, enabled, routes: [], menu: [], screenshots: [] };
    report.variants.push(result);
    try {
      const sitemap = readdirSync(dist).filter((file) => /^sitemap.*[.]xml$/.test(file)).map((file) => readFileSync(join(dist, file), 'utf8')).join('');
      for (const locale of LOCALES) {
        for (const path of paths) {
          const url = route(locale, path);
          if (!enabled.includes(locale)) {
            assert.equal((await fetch(base + url)).status, 404, `${name}: disabled route ${url}`);
            assert(!sitemap.includes(`https://nexgrid.ai${url}<`), `${name}: disabled sitemap ${url}`);
            continue;
          }
          const response = await page.goto(base + url);
          assert.equal(response.status(), 200, `${name}: ${url}`);
          assert.equal(await page.locator('html').getAttribute('lang'), locale);
          assert(await page.locator('main').innerText(), `${url}: empty page`);
          const seoId = ({ '/': 'home', '/nex/': 'nex', '/learn/': 'learn', '/legal/privacy/': 'legal-privacy', '/legal/terms/': 'legal-terms', '/legal/app-privacy/': 'legal-app-privacy' })[path];
          const seo = config.seo.pages[seoId];
          if (seo?.title[locale]?.trim()) {
            const title = seo.title[locale].trim();
            assert.equal(await page.title(), title.includes('NexGrid') ? title : `${title} — NexGrid`, `${url}: actual SEO title`);
          }
          if (seo?.description[locale]?.trim()) assert.equal(await page.locator('meta[name="description"]').getAttribute('content'), seo.description[locale].trim(), `${url}: actual SEO description`);
          if (path === '/') {
            const text = value => value.replace(/\s+/gu, ' ').trim();
            const localized = values => values[locale]?.trim() ? values[locale] : values.en;
            const scrollCopy = config.copy[locale]['hero.scrollHint'];
            assert.equal(text(await page.locator('.hero .scroll-hint .txt').textContent()), text(scrollCopy?.trim() ? scrollCopy : config.copy.en['hero.scrollHint']), `${url}: actual draft copy`);
            const faq = config.faq.items.filter(item => item.visible && !item.deleted).sort((a, b) => a.sort - b.sort);
            assert.equal(await page.locator('#faq details').count(), faq.length, `${url}: actual FAQ count`);
            for (let i = 0; i < faq.length; i++) {
              const item = page.locator('#faq details').nth(i);
              assert.equal(text(await item.locator('.q').textContent()), text(localized(faq[i].q)), `${url}: FAQ question ${faq[i].id}`);
              await item.locator('summary').click();
              assert.equal(await item.getAttribute('open') !== null, true, `${url}: FAQ opens ${faq[i].id}`);
              assert.equal(text(await item.locator('p').textContent()), text(localized(faq[i].a)), `${url}: FAQ answer ${faq[i].id}`);
              await item.locator('summary').click();
            }
            const skus = config.skus.filter(item => item.visible).sort((a, b) => a.sort - b.sort);
            assert.equal(await page.locator('#devices [data-deck-card]').count(), skus.length, `${url}: actual SKU count`);
            for (let i = 0; i < skus.length; i++) {
              const columns = page.locator('#devices [data-deck-card]').nth(i).locator('p.col');
              assert.equal(await columns.count(), 2, `${url}: SKU content columns ${skus[i].id}`);
              assert.equal(text(await columns.nth(1).textContent()), text(localized(skus[i].tagline)), `${url}: SKU ${skus[i].id}`);
            }
          }
          const alternatives = await page.locator('head link[rel=alternate][hreflang]').evaluateAll((links) => links.map((link) => link.hreflang).filter((lang) => lang !== 'x-default'));
          assert.deepEqual(alternatives.sort(), [...enabled].sort(), `${url}: hreflang selection`);
          assert.deepEqual((await page.locator('.lang a').evaluateAll((links) => links.map((link) => link.hreflang))).sort(), [...enabled].sort(), `${url}: menu selection`);
          assert(sitemap.includes(`https://nexgrid.ai${url}<`), `${url}: missing sitemap route`);
          result.routes.push(url);
        }
        if (!enabled.includes(locale)) continue;
        await page.goto(base + route(locale, '/nex/'));
        const picker = page.locator('.lang-picker');
        await picker.locator('summary').focus();
        await page.keyboard.press('Enter');
        assert(await picker.getAttribute('open') !== null, `${locale}: keyboard menu opening`);
        const target = enabled[(enabled.indexOf(locale) + 1) % enabled.length];
        await picker.locator(`a[hreflang="${target}"]`).click();
        await page.waitForURL(base + route(target, '/nex/'));
        assert.equal(await page.locator('html').getAttribute('lang'), target);
        result.menu.push({ from: locale, to: target });
        if (name === 'all-nine') for (const width of [320, 390, 1440, 3840]) {
          await page.setViewportSize({ width, height: width === 3840 ? 2160 : 1000 });
          await page.goto(base + route(locale, '/'));
          await page.evaluate(() => document.fonts.ready);
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${locale}: horizontal overflow at ${width}`);
          const titleRows = await page.locator('h1').evaluate((heading) => {
            const rows = new Map();
            const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              for (let index = 0; index < node.textContent.length; index++) {
                const character = node.textContent[index];
                if (!character.trim()) continue;
                const range = document.createRange();
                range.setStart(node, index); range.setEnd(node, index + 1);
                const top = Math.round(range.getBoundingClientRect().top);
                rows.set(top, (rows.get(top) ?? '') + character);
              }
            }
            return [...rows.values()];
          });
          assert(!/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(titleRows.at(-1) ?? ''), `${locale}: isolated final title character at ${width}: ${titleRows.join(' | ')}`);
          if (width <= 390) await page.locator('.menu-toggle').click();
          await picker.locator('summary').click();
          const menuBox = await picker.locator('.lang').boundingBox();
          assert(menuBox && menuBox.x >= -1 && menuBox.x + menuBox.width <= width + 1, `${locale}: menu clipping at ${width}`);
          const shot = `${locale}-${width}.png`;
          await page.screenshot({ path: join(output, shot) });
          result.screenshots.push(shot);
        }
        await page.setViewportSize({ width: 1440, height: 1000 });
      }
      const notFound = readFileSync(join(dist, '404.html'), 'utf8');
      for (const locale of LOCALES.filter((locale) => !enabled.includes(locale))) assert(!notFound.includes(`hreflang="${locale}"`), `404 leaked ${locale}`);
      console.log(`${name}: ${result.routes.length} rendered routes, ${result.menu.length} language-switch journeys passed`);
    } finally { await context.close(); await new Promise((done) => server.close(done)); }
  }
  assert.deepEqual(report.errors, [], 'Browser runtime errors');
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.failure = error.stack; throw error; }
finally { await browser.close(); writeFileSync(join(output, 'public-runtime.json'), JSON.stringify(report, null, 2)); }
