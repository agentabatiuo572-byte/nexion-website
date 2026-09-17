// Advisory character budgets from the real built page. This never changes publication policy.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { LOCALES } from '../schema/src/locales.ts';
import { COPY_LAYOUT_CATALOG } from './copy-layout-catalog.mjs';
import { readBuiltPages } from './gate-built-routes.mjs';
import { measureSpecimen } from './copy-layout-probe.mjs';
export { measureSpecimen } from './copy-layout-probe.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, '.cache/copy-length');
const DATA = join(ROOT, 'admin/src/lib/text-layout-limits.json');
const RECORD = join(ROOT, 'docs/copy-layout-calibration.json');
const CORRECTION = join(ROOT, '.cache/copy-length-correction');
const flag = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const digest = (value) => createHash('sha256').update(value).digest('hex');
// Fixed ordinary-language specimens, deliberately independent of current authored copy length.
export const CORPUS = {
  en: ['Connect devices and share computing power with the global network. ', 'Explore reliable technology for teams around the world. '],
  vi: ['Kết nối thiết bị và chia sẻ sức mạnh tính toán với mạng lưới toàn cầu. ', 'Khám phá công nghệ đáng tin cậy dành cho cộng đồng. '],
  es: ['Conecta dispositivos y comparte potencia de cómputo con la red global. ', 'Descubre tecnología confiable para equipos de todo el mundo. '],
  pt: ['Conecte dispositivos e compartilhe capacidade de computação na rede global. ', 'Descubra tecnologia confiável para equipes ao redor do mundo. '],
  fr: ['Connectez les appareils et partagez la puissance de calcul du réseau mondial. ', 'Découvrez une technologie fiable pour les équipes du monde entier. '],
  de: ['Verbinde Geräte und teile Rechenleistung mit dem weltweiten Netzwerk. ', 'Entdecke zuverlässige Technologie für Teams auf der ganzen Welt. '],
  ja: ['デバイスを接続し、世界中のネットワークで計算能力を共有します。', '信頼できる技術で世界中のチームをつなぎ、新しい可能性を広げます。'],
  ko: ['기기를 연결하고 전 세계 네트워크와 연산 능력을 공유하세요. ', '신뢰할 수 있는 기술로 세계 곳곳의 팀과 함께 새로운 가능성을 만듭니다. '],
  zh: ['连接设备，与全球网络共享算力，让可靠的技术服务更多团队。', '探索计算的更多可能，让世界各地的设备共同参与网络建设。'],
};

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? files(join(dir, entry.name)) : [join(dir, entry.name)]).sort();
}
export function sourceFingerprint(layoutOnly = false, portable = false) {
  // Published content changes do not invalidate the typography ruler. Layout/font/code changes do.
  const sources = files(join(ROOT, 'src')).filter((file) => !layoutOnly || !['.json', '.md', '.mdx'].includes(extname(file)));
  const inputs = [...sources, join(ROOT, 'astro.config.mjs'), join(ROOT, 'package-lock.json'),
    join(ROOT, 'schema/src/locales.ts'), join(ROOT, 'scripts/copy-layout-catalog.mjs'), join(ROOT, 'scripts/copy-layout-probe.mjs'),
    fileURLToPath(import.meta.url)];
  const hash = createHash('sha256');
  for (const file of inputs) hash.update(relative(ROOT, file).replaceAll(sep, '/'))
    .update(portable ? readFileSync(file, 'utf8').replace(/\r\n?/g, '\n') : readFileSync(file));
  return hash.digest('hex');
}

export function viewportMatrix(dist) {
  const widths = new Set([320, 390, 1024, 1366, 1440, 1920, 2560]), heights = new Set([360, 768, 844, 900]);
  let found = 0;
  const add = (dimension, edge, value) => {
    found++;
    const set = dimension === 'width' ? widths : heights;
    set.add(Math.round(value)); set.add(Math.round(value) + (edge === 'max' ? 1 : -1));
  };
  for (const file of files(dist).filter((file) => ['.css', '.html'].includes(extname(file)))) {
    const input = readFileSync(file, 'utf8');
    for (const m of input.matchAll(/\((max|min)-(width|height)\s*:\s*([\d.]+)px\)/g)) add(m[2], m[1], +m[3]);
    for (const m of input.matchAll(/\((width|height)\s*(<=|>=|<|>)\s*([\d.]+)px\)/g)) {
      add(m[1], m[2].startsWith('<') ? 'max' : 'min', +m[3] + (m[2] === '<' ? -1 : m[2] === '>' ? 1 : 0));
    }
  }
  assert(found > 0, 'No CSS breakpoints found; refusing an incomplete calibration');
  const w = [...widths].filter((n) => n >= 320 && n <= 2560).sort((a, b) => a - b);
  const h = [...heights].filter((n) => n >= 320 && n <= 900).sort((a, b) => a - b);
  return { widths: w, heights: h, views: [...w.map((width) => ({ width, height: width <= 860 ? 844 : 900 })),
    ...h.filter((height) => height !== 900).flatMap((height) => [390, 1024, 1440].map((width) => ({ width, height }))) ] };
}

function fixtureSite(linkedAnnouncement = false) {
  const site = JSON.parse(readFileSync(join(ROOT, 'src/config/site.json'), 'utf8'));
  site.enabledLocales = [...LOCALES];
  site.announcement.enabled = true;
  site.announcement.id = 'copy-layout-calibration';
  site.announcement.startsAt = '2020-01-01T00:00:00Z'; site.announcement.endsAt = '2099-12-31T00:00:00Z';
  // Empty announcements have no authored positive control. A short brand label
  // makes the real optional surface measurable before adding the locale corpus.
  for (const locale of LOCALES) site.announcement.text[locale] ||= 'NexGrid';
  if (linkedAnnouncement) site.announcement.href ||= 'https://example.com/announcement';
  else delete site.announcement.href;
  site.footer.contactEmail ||= 'teams@example.com';
  if (!site.skus.some((sku) => sku.status === 'coming')) site.skus.at(-1).status = 'coming';
  for (const platform of ['ios', 'android', 'h5']) site.downloads[platform] = { enabled: true, url: `https://example.com/${platform}` };
  return site;
}

export async function buildFixture({ linkedAnnouncement = false } = {}) {
  mkdirSync(OUT, { recursive: true });
  const temp = mkdtempSync(join(OUT, 'build-')), fixture = join(temp, 'fixture'), dist = join(temp, 'dist');
  mkdirSync(fixture);
  for (const locale of LOCALES) writeFileSync(join(fixture, `${locale}.json`), readFileSync(join(ROOT, `src/i18n/${locale}.json`)));
  const site = fixtureSite(linkedAnnouncement);
  writeFileSync(join(fixture, 'site.json'), JSON.stringify(site));
  await new Promise((done, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'node_modules/astro/bin/astro.mjs'), 'build', '--outDir', dist],
      { cwd: ROOT, env: { ...process.env, NEXGRID_SITE_FIXTURE_DIR: fixture }, windowsHide: true });
    let log = ''; child.stdout.on('data', (data) => { log += data; }); child.stderr.on('data', (data) => { log += data; });
    child.on('error', reject); child.on('close', (code) => { writeFileSync(join(temp, 'build.log'), log); code === 0 ? done() : reject(new Error(log.slice(-2400))); });
  });
  return { dist, fixture };
}

export async function serve(dist) {
  const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon' };
  const server = createServer((request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (pathname === '/api/e') return response.writeHead(204).end();
      let file = resolve(dist, `.${pathname}`);
      if (file !== dist && !file.startsWith(dist + sep)) return response.writeHead(400).end();
      if (pathname.endsWith('/')) file = join(file, 'index.html');
      if (!existsSync(file) || !statSync(file).isFile()) return response.writeHead(404).end();
      response.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' }).end(readFileSync(file));
    } catch { response.writeHead(400).end(); }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

export function routeMatches(route, family, home) {
  if (family === 'all') return true;
  if (family === '404') return route.endsWith('/404.html');
  if (family === 'home') return home;
  if (family === 'article') return /\/learn\/[^/]+\/$/.test(route);
  if (family === 'legal') return /\/legal\//.test(route);
  return route.endsWith(`/${family}/`);
}

export async function setMobileMenu(page, open) {
  const toggle = page.locator('.site-nav .menu-toggle');
  if (!await toggle.isVisible()) return;
  if ((await toggle.getAttribute('aria-expanded') === 'true') !== open) await toggle.click();
  await page.waitForFunction((expected) => {
    const nav = document.querySelector('.site-nav');
    return nav.querySelector('.menu-toggle').getAttribute('aria-expanded') === String(expected)
      && nav.classList.contains('menu-open') === expected && !nav.classList.contains('menu-switch');
  }, open);
}

// A reference is a positive control, not a post-hoc floor applied to an invalid budget.
export function referenceFor(key, locale, dictionaries, site, instance) {
  if (key === 'sku.name') return site.skus.find((sku) => sku.id === instance)?.name;
  if (key === 'sku.tagline') return dictionaries[locale].devices.tagline[instance];
  if (key === 'announcement.text') return site.announcement.text[locale];
  return key.split('.').reduce((value, part) => value?.[part], dictionaries[locale]);
}

export function mergeEvidence(previous, observation) {
  const observations = (previous?.observations || 0) + 1;
  if (observation.referenceFailure || observation.unresolved) return { ...observation, status: 'preview', observations };
  if (previous?.referenceFailure || previous?.unresolved) return { ...previous, observations };
  if (!previous || (observation.status === 'measured' && (previous.status !== 'measured' || observation.limit < previous.limit)))
    return { ...observation, observations };
  return { ...previous, observations };
}

export function searchBudget(previous, source, locale) {
  if (previous?.referenceFailure || previous?.unresolved) return { inspectOnly: true,
    searchReason: 'Earlier measurement prevents numeric advice; checking every remaining default display state.' };
  if (previous?.status !== 'measured') return { ceiling: 512 };
  const length = [...new Intl.Segmenter(locale, { granularity: 'grapheme' }).segment(source.replace(/\r\n?/g, '\n'))].length;
  return { ceiling: Math.min(512, Math.max(1, previous.limit + 1 - length)),
    searchReason: 'Scan every length through the existing shared minimum plus one; only a tighter boundary can change the advice.' };
}

function aggregationSelfTest() {
  const measured = { status: 'measured', limit: 40 }, uncertain = { status: 'preview', unresolved: true }, growing = { status: 'preview' };
  for (const taint of [uncertain, { status: 'preview', referenceFailure: 'clipped' }]) {
    assert.equal(mergeEvidence(mergeEvidence(undefined, measured), taint).status, 'preview');
    assert.equal(mergeEvidence(mergeEvidence(undefined, taint), measured).status, 'preview');
  }
  assert.equal(mergeEvidence(mergeEvidence(undefined, growing), measured).limit, 40);
  assert.equal(mergeEvidence(mergeEvidence(undefined, measured), growing).limit, 40);
  assert.equal(mergeEvidence(mergeEvidence(undefined, measured), { status: 'measured', limit: 30 }).limit, 30);
  assert.deepEqual(searchBudget(undefined, 'Hello', 'en'), { ceiling: 512 });
  assert.equal(searchBudget(measured, 'Hello', 'en').ceiling, 36);
  assert.equal(searchBudget({ ...measured, limit: 24 }, 'NexGrid\nLet compute flow', 'en').ceiling, 1);
  assert.equal(searchBudget(uncertain, 'Hello', 'en').inspectOnly, true);
  console.log('[copy-layout v2] unresolved/baseline exceptions veto advice in either order; flowing observations do not');
}

function validate(data, report) {
  assert.equal(data.version, 2, 'Legacy synthetic minima are not accepted');
  assert.equal(report.version, 2);
  assert.equal(data.evidenceSha256, digest(JSON.stringify(report)), 'Calibration evidence changed');
  assert.equal(data.portableLayoutHash, sourceFingerprint(true, true), 'Layout/probe changed; recalibrate');
  assert.equal(report.portableLayoutHash, data.portableLayoutHash);
  assert.equal(data.sourceHash, report.sourceHash);
  assert.equal(report.scope, 'full');
  assert.equal(report.problems.length, 0, 'Calibration coverage has gaps');
  assert(report.expectedCoverage.length > 0, 'Missing consumer coverage contract');
  for (const consumer of report.expectedCoverage) assert(report.coverage[consumer] > 0, 'Unmeasured consumer: ' + consumer);
  assert.deepEqual(data.locales, [...LOCALES]);
  assert.deepEqual(Object.keys(data.fields).sort(), Object.keys(COPY_LAYOUT_CATALOG).sort());
  let measured = 0, preview = 0;
  const count = (value, locale) => [...new Intl.Segmenter(locale, { granularity: 'grapheme' }).segment(value.replace(/\r\n?/g, '\n'))].length;
  for (const [key, field] of Object.entries(data.fields)) {
    assert.equal(field.kind, COPY_LAYOUT_CATALOG[key].kind, key);
    assert.equal(field.basis, COPY_LAYOUT_CATALOG[key].basis, key + ': changed advice basis');
    assert.equal(field.jointLimits, undefined, 'Joint factors must not redefine single-field advice');
    if (field.kind !== 'bounded') continue;
    const entries = field.instances ? Object.entries(field.instances) : [['', field]];
    if (key.startsWith('sku.')) assert.deepEqual(entries.map(([id]) => id).sort(), report.skuIds.slice().sort());
    for (const [instance, advice] of entries) for (const locale of LOCALES) {
      const id = [key, instance, locale].join('|'), record = report.records[id];
      assert(record, id + ': missing evidence');
      assert.equal(advice.references[locale], record.authoredReference ?? record.reference);
      assert(record.observations > 0, id + ': not measured');
      if (advice.limits?.[locale] !== undefined) {
        const limit = advice.limits[locale];
        assert.equal(record.status, 'measured');
        assert(Number.isInteger(limit) && limit >= count(record.reference, locale));
        assert.equal(limit, record.limit);
        assert.equal(count(record.accepted, locale), limit);
        assert.equal(count(record.failing, locale), limit + 1);
        assert.equal(record.failingLength, limit + 1);
        assert(record.reason && !record.referenceFailure && record.accepted.startsWith(record.reference));
        assert.equal(advice.previewReasons?.[locale], undefined);
        measured++;
      } else {
        assert.equal(record.status, 'preview');
        assert(advice.previewReasons?.[locale] && record.reason, id + ': unexplained missing number');
        preview++;
      }
    }
  }
  console.log('[copy-layout v2] reference controls and evidence match: ' + measured + ' measured / ' + preview + ' preview-dependent');
}

export function check() {
  validate(JSON.parse(readFileSync(DATA, 'utf8')), JSON.parse(readFileSync(RECORD, 'utf8')));
}

async function calibrate() {
  mkdirSync(CORRECTION, { recursive: true });
  const sourceHash = sourceFingerprint(), portableLayoutHash = sourceFingerprint(true, true);
  const fixtureResult = flag('dist') ? { dist: resolve(flag('dist')), fixture: join(dirname(resolve(flag('dist'))), 'fixture') } : await buildFixture();
  const { dist, fixture } = fixtureResult, { server, base } = await serve(dist);
  const linkedFixture = await buildFixture({ linkedAnnouncement: true });
  assert.deepEqual(JSON.parse(readFileSync(join(linkedFixture.fixture, 'site.json'), 'utf8')), fixtureSite(true));
  const typography = (directory) => files(join(directory, '_astro')).filter((file) => /\.(css|woff2?)$/.test(file))
    .map((file) => [relative(directory, file).replaceAll(sep, '/'), digest(readFileSync(file))]);
  assert.deepEqual(typography(linkedFixture.dist), typography(dist), 'Announcement variants must use identical CSS and fonts');
  const site = JSON.parse(readFileSync(join(fixture, 'site.json'), 'utf8'));
  assert.deepEqual(site, fixtureSite(), 'Stale fixture site configuration');
  const authoredSite = JSON.parse(readFileSync(join(ROOT, 'src/config/site.json'), 'utf8'));
  const dictionaries = Object.fromEntries(LOCALES.map((locale) => [locale, JSON.parse(readFileSync(join(fixture, locale + '.json'), 'utf8'))]));
  for (const locale of LOCALES) assert.deepEqual(dictionaries[locale], JSON.parse(readFileSync(join(ROOT, 'src/i18n', locale + '.json'), 'utf8')), 'Stale fixture dictionary: ' + locale);
  const matrix = viewportMatrix(dist), smoke = process.argv.includes('--smoke');
  // Every viewport is retained. Tight spaces establish the shared minimum
  // first, so later wider states need fewer sequential candidate checks.
  matrix.views.sort((a, b) => a.width * a.height - b.width * b.height);
  const allPages = [...readBuiltPages(dist), ...LOCALES.map((locale) => ({ route: `${locale === 'en' ? '' : '/' + locale}/404.html`, locale, home: false }))];
  assert.deepEqual([...new Set(allPages.map((page) => page.locale))].sort(), [...LOCALES].sort());
  const pages = smoke ? allPages.filter((page) => page.home && ['en', 'vi', 'zh'].includes(page.locale)) : allPages;
  if (smoke) matrix.views = [{ width: 320, height: 844 }, { width: 390, height: 521 }, { width: 1440, height: 900 }];
  const buildHash = digest(readFileSync(join(dist, 'index.html')));
  assert.equal(digest(await (await fetch(base)).text()), buildHash, 'Wrong built snapshot served');
  const report = { version: 2, scope: smoke ? 'smoke' : 'full', generatedAt: new Date().toISOString(), sourceHash, portableLayoutHash,
    buildHash, dist, fixture, linkedAnnouncement: { ...linkedFixture,
      buildHash: digest(readFileSync(join(linkedFixture.dist, 'index.html'))), pages: {} }, matrix, corpus: CORPUS, skuIds: site.skus.map((sku) => sku.id),
    contract: 'Append to real references preserving paragraph/line/template structure; actual clipping is distinct from composition reference. Joint scenarios never multiply field advice.',
    records: {}, coverage: {}, expectedCoverage: [], baselineExceptions: [], problems: [], pages: [] };
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ reducedMotion: 'reduce', colorScheme: 'light' });
  await context.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (...args) { return this.id === 'x-bg' ? null : original.apply(this, args); };
  });
  await context.addInitScript({ content: 'window.__measureCopySpecimen = ' + measureSpecimen.toString() + ';' });
  function consume(entry, view, state, results) {
    for (const { key, instance, consumer, sample, result, searchReason } of results) {
      const coverageKey = [key, instance || '', entry.locale, entry.route, consumer.selector, state].join('|');
      report.coverage[coverageKey] = (report.coverage[coverageKey] || 0) + result.observed;
      if (!result.domCandidates || (result.candidates > 0 && !result.observed)) report.problems.push({
        id: [key, instance || '', entry.locale].join('|'), route: entry.route, viewport: view, state, selector: consumer.selector,
        reason: !result.domCandidates ? 'Missing consumer in built document' : 'Visible consumer produced no observation',
      });
      for (const observation of result.observations || []) {
        const id = [key, instance || '', entry.locale].join('|');
        const record = { ...observation, ...(key === 'announcement.text' ? { authoredReference: authoredSite.announcement.text[entry.locale] } : {}),
          route: entry.route, viewport: view, state, selector: consumer.selector, sample, ...(searchReason ? { searchReason } : {}) };
        if (observation.missingText || observation.missingBoundary) { report.problems.push({ id, ...record }); continue; }
        if (typeof observation.reference !== 'string') { report.problems.push({ id, reason: 'No actual reference', ...record }); continue; }
        const previous = report.records[id];
        if (previous && previous.reference !== observation.reference) {
          report.problems.push({ id, reason: 'Same field resolved to different authored references', before: previous.reference, after: observation.reference });
          continue;
        }
        // A baseline ambiguity must not become a misleading smaller numeric cap.
        if (observation.referenceFailure || observation.unresolved) {
          report.baselineExceptions.push({ id, route: entry.route, viewport: view, state, selector: consumer.selector,
            reason: observation.referenceFailure || observation.reason, unresolved: observation.unresolved || false });
        }
        report.records[id] = mergeEvidence(previous, record);
      }
    }
  }
  async function measurePage(entry, index) {
    const page = await context.newPage();
    try {
      const targets = Object.entries(COPY_LAYOUT_CATALOG).flatMap(([key, rule]) => rule.kind !== 'bounded' ? [] : rule.consumers
        .filter((consumer) => routeMatches(entry.route, consumer.route, entry.home))
        .flatMap((consumer) => key.startsWith('sku.') ? site.skus.map((sku, slot) => ({ key, rule, instance: sku.id,
          consumer: { ...consumer, selector: consumer.selector.replace('#devices .card', '#devices .card:nth-child(' + (slot + 1) + ')') } }))
          : [{ key, rule, consumer }]));
      if (!targets.length) return;
      for (const target of targets) {
        const states = target.key === 'trust.certClose' ? ['dialog-open']
          : target.consumer.selector.startsWith('.site-nav') ? ['navigation-open'] : ['static'];
        if (target.key === 'announcement.text') states.push('linked-announcement');
        if (entry.home && (target.key.startsWith('devices.') || target.key.startsWith('sku.'))) states.push('decked');
        for (const state of states) report.expectedCoverage.push([target.key, target.instance || '', entry.locale, entry.route, target.consumer.selector, state].join('|'));
      }
      await page.setViewportSize(matrix.views[0]);
      const response = await page.goto(base + entry.route, { waitUntil: 'load' });
      assert(response.ok());
      const file = entry.route.endsWith('/404.html') ? join(dist, entry.route.slice(1)) : join(dist, entry.route.slice(1), 'index.html');
      assert.equal(digest(await response.text()), digest(readFileSync(file)), 'Served HTML differs from built file');
      report.pages.push({ ...entry, sha256: digest(readFileSync(file)) });
      const linkedFile = join(linkedFixture.dist, relative(dist, file));
      const linkedHtml = readFileSync(linkedFile, 'utf8');
      // Reuse the exact Astro-built branch, including scoped attributes and the
      // decorative arrow. The message has no listeners; its original node is
      // restored after each observation so other fields keep their real state.
      const linkedMessage = await page.evaluate((html) => {
        const message = new DOMParser().parseFromString(html, 'text/html').querySelector('#x-announcement a.message');
        return message?.querySelector('[aria-hidden]')?.textContent === ' ↗' ? message.outerHTML : null;
      }, linkedHtml);
      assert(linkedMessage, 'Missing actual linked-announcement branch: ' + entry.route);
      report.linkedAnnouncement.pages[entry.route] = { sha256: digest(linkedHtml), messageSha256: digest(linkedMessage) };
      console.log('[copy-layout v2] ' + (index + 1) + '/' + pages.length + ' ' + entry.locale + ' ' + entry.route);
      for (const view of matrix.views) {
        await page.mouse.move(-1, -1);
        await page.setViewportSize(view);
        await page.evaluate(async () => {
          window.scrollTo(0, 0); await document.fonts.ready;
          await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        });
        const specs = targets.flatMap(({ key, instance, rule, consumer }) => CORPUS[entry.locale].map((corpus, sample) => ({
          key, instance, consumer, sample, input: { ...consumer, basis: rule.basis || 'container',
            source: referenceFor(key, entry.locale, dictionaries, site, instance), locale: entry.locale, corpus },
        })));
        const run = async (subset, state) => {
          const trials = subset.map((item) => {
            const budget = searchBudget(report.records[[item.key, item.instance || '', entry.locale].join('|')], item.input.source, entry.locale);
            return { ...item, searchReason: budget.searchReason, input: { ...item.input, ...budget } };
          });
          const results = await page.evaluate((items) => items.map((item) => ({ ...item, input: undefined, result: window.__measureCopySpecimen(item.input) })), trials);
          consume(entry, view, state, results);
        };
        await setMobileMenu(page, true);
        await run(specs.filter((spec) => spec.consumer.selector.startsWith('.site-nav')), 'navigation-open');
        await setMobileMenu(page, false);
        await run(specs.filter((spec) => !spec.consumer.selector.startsWith('.site-nav')), 'static');
        const announcements = specs.filter((spec) => spec.key === 'announcement.text');
        if (announcements.length) {
          await page.evaluate((html) => {
            const original = document.querySelector('#x-announcement .message');
            const template = document.createElement('template'); template.innerHTML = html;
            window.__unlinkedAnnouncement = original;
            original.replaceWith(template.content.firstElementChild);
          }, linkedMessage);
          try { await run(announcements, 'linked-announcement'); }
          finally { await page.evaluate(() => {
            document.querySelector('#x-announcement .message').replaceWith(window.__unlinkedAnnouncement);
            delete window.__unlinkedAnnouncement;
          }); }
        }
        if (entry.home && view.width > 860) {
          await page.emulateMedia({ reducedMotion: 'no-preference' });
          await page.waitForFunction(() => document.querySelector('#devices').classList.contains('decked'));
          // Settle entrance/typewriter without forcing a synthetic card layout.
          await page.waitForTimeout(350);
          await run(specs.filter((spec) => spec.key.startsWith('devices.') || spec.key.startsWith('sku.')), 'decked');
          await page.emulateMedia({ reducedMotion: 'reduce' });
        }
        if (entry.home) {
          await page.locator('.cert-open').first().click();
          await page.locator('.cert-zoom[open] img').evaluate((image) => image.decode());
          await run(specs.filter((spec) => spec.key === 'trust.certClose'), 'dialog-open');
          await page.keyboard.press('Escape');
        }
      }
    } finally { await page.close(); }
  }
  try {
    let next = 0;
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (next < pages.length) { const index = next++; await measurePage(pages[index], index); }
    }));
  } finally { await browser.close(); await new Promise((done) => server.close(done)); }
  assert.equal(sourceFingerprint(), sourceHash, 'Source changed during calibration');
  for (const consumer of report.expectedCoverage) if (!report.coverage[consumer]) report.problems.push({ consumer, reason: 'Consumer was never observed in its display state' });
  const fields = Object.fromEntries(Object.entries(COPY_LAYOUT_CATALOG).map(([key, { consumers, ...rule }]) => {
    if (rule.kind !== 'bounded') return [key, rule];
    const instanceIds = key.startsWith('sku.') ? site.skus.map((sku) => sku.id) : [''];
    const advice = Object.fromEntries(instanceIds.map((instance) => {
      const value = { references: {}, limits: {}, previewReasons: {} };
      for (const locale of LOCALES) {
        const id = [key, instance, locale].join('|'), record = report.records[id];
        if (!record || record.observations <= 0) { if (!smoke) report.problems.push({ id, reason: 'No rendered reference evidence' }); continue; }
        value.references[locale] = record.authoredReference ?? record.reference;
        if (record.status === 'measured') value.limits[locale] = record.limit;
        else value.previewReasons[locale] = record.referenceFailure
          ? '该字段受同区域内容及显示状态影响，无法给出可靠的固定字数上限，请查看前台预览。'
          : '扩写测试未得到可靠的固定字数边界，请结合前台预览检查换行及内容显示。';
      }
      return [instance, value];
    }));
    return [key, key.startsWith('sku.') ? { ...rule, instances: advice } : { ...rule, ...advice[''] }];
  }));
  report.summary = { records: Object.keys(report.records).length, observations: Object.values(report.coverage).reduce((a, b) => a + b, 0),
    measured: Object.values(report.records).filter((record) => record.status === 'measured').length,
    preview: Object.values(report.records).filter((record) => record.status === 'preview').length, gaps: report.problems.length };
  writeFileSync(join(CORRECTION, smoke ? 'calibration-smoke.json' : 'calibration-run.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report.summary));
  if (smoke) return;
  const data = { version: 2, sourceHash, portableLayoutHash, locales: [...LOCALES], fields, evidenceSha256: digest(JSON.stringify(report)) };
  validate(data, report);
  if (process.argv.includes('--write')) {
    writeFileSync(RECORD, JSON.stringify(report, null, 2) + '\n');
    writeFileSync(DATA, JSON.stringify(data, null, 2) + '\n');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const arg of process.argv.slice(2)) assert(['--check', '--smoke', '--write', '--self-test', '--apply-joint'].includes(arg) || arg.startsWith('--dist='), 'Unknown calibration argument: ' + arg);
  if (process.argv.includes('--check')) check();
  else if (process.argv.includes('--apply-joint')) throw new Error('Joint factors are withdrawn. Joint tests diagnose combinations; they must not overwrite field advice.');
  else if (process.argv.includes('--self-test')) {
    aggregationSelfTest();
    const { selfTest } = await import('./copy-layout-probe.mjs'); await selfTest();
  } else await calibrate();
}
