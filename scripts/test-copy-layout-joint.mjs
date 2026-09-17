// Combination diagnostics never rewrite individual character advice.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { measureSpecimen, serve, sourceFingerprint, viewportMatrix, setMobileMenu } from './calibrate-copy-layout.mjs';
import { COPY_LAYOUT_CATALOG } from './copy-layout-catalog.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const flag = (name) => process.argv.find((arg) => arg.startsWith('--' + name + '='))?.slice(name.length + 3);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const nav = ['nav.how', 'nav.devices', 'nav.trust', 'nav.learn', 'nav.nex', 'nav.launchH5', 'nav.download'];
const hero = ['hero.title', 'hero.subtitle', 'hero.subtitle2', 'hero.note', 'hero.note2', 'hero.scrollHint'];
const buttons = ['download.ios', 'download.android', 'nav.launchH5'];
const mission = ['mission.kicker', 'mission.title', 'mission.lead', ...Array.from({ length: 6 }, (_, i) => 'mission.f' + (i + 1))];
const groups = [
  { id: 'nav', keys: nav, prefix: '.site-nav' },
  { id: 'buttons', keys: buttons, prefix: '.hero' },
  { id: 'hero', keys: [...hero, ...buttons], prefix: '.hero' },
  { id: 'mission', keys: mission, prefix: '#mission' },
  { id: 'combined', keys: [...new Set([...nav, ...hero, ...buttons, ...mission])] },
];

export function inspectCombination({ specs, locale }) {
  const restore = [], failures = [], geometry = [], skipped = [];
  // Each field repeats its neighboring geometry. Keep the measured bounds and
  // ink extents, but not thousands of duplicated per-line glyph runs; the exact
  // text and frozen build remain in the case for replay.
  const boundsOnly = ({ lines, related, ...measurement }) => ({ ...measurement,
    ...(related ? { related: related.map(boundsOnly) } : {}) });
  try {
    for (const spec of specs) {
      const elements = [...document.querySelectorAll(spec.selector)];
      if (!elements.length) { failures.push({ key: spec.key, reason: 'missing consumer', selector: spec.selector }); continue; }
      for (const element of elements) {
        if (element.matches('#mission .body')) {
          const before = [...element.childNodes], model = element.querySelector('p');
          if (!model) { failures.push({ key: spec.key, reason: 'missing paragraph host' }); continue; }
          if ([...element.querySelectorAll(':scope > p')].map((p) => p.textContent).join('\n') !== spec.source) {
            failures.push({ key: spec.key, reason: 'source not matched', selector: spec.selector }); continue;
          }
          const paragraphs = spec.value.split('\n').map((text) => {
            const paragraph = model.cloneNode(false); paragraph.textContent = text; return paragraph;
          });
          element.replaceChildren(...paragraphs);
          restore.push(() => element.replaceChildren(...before));
          continue;
        }
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let matched = false;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (node.parentElement.closest('svg,.arr,.ic,.serial,.qdot') || !node.textContent.includes(spec.source)) continue;
          const target = node, before = node.textContent;
          node.textContent = before.replace(spec.source, spec.value); matched = true;
          restore.push(() => { target.textContent = before; });
        }
        if (!matched && element.getBoundingClientRect().width > 0) failures.push({ key: spec.key, reason: 'source not matched', selector: spec.selector });
      }
    }
    for (const spec of specs) {
      const result = window.__measureCopySpecimen({ ...spec, source: spec.value, locale, corpus: 'x', inspectOnly: true });
      if (!result.observed) {
        const elements = [...document.querySelectorAll(spec.selector)];
        const hidden = elements.length > 0 && elements.every((element) => {
          if (!element.getClientRects().length) return true;
          for (let node = element; node; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return true;
          }
          return false;
        });
        if (hidden) skipped.push({ key: spec.key, selector: spec.selector, reason: 'hidden in current viewport/state' });
        else if (elements.length) failures.push({ key: spec.key, selector: spec.selector, reason: 'observation gap', detail: 'visible consumer had no observation' });
      }
      for (const observation of result.observations) {
        geometry.push({ key: spec.key, selector: spec.selector, ...boundsOnly(observation.geometry) });
        if (observation.missingText || observation.missingBoundary || observation.unresolved) failures.push({ key: spec.key,
          selector: spec.selector, reason: 'observation gap', detail: observation.reason });
        if (observation.referenceFailure) failures.push({ key: spec.key, selector: spec.selector, reason: observation.referenceFailure });
      }
    }
    return { failures, geometry, skipped };
  } finally { for (const undo of restore.reverse()) undo(); }
}

async function selfTest() {
  const browser = await chromium.launch(), page = await browser.newPage();
  try {
    await page.setContent('<h1 class="title" style="white-space:pre-line">Uvel\nLet compute flow</h1>');
    await page.evaluate(() => { window.__measureCopySpecimen = () => ({ observed: 1, observations: [{ geometry: {} }] }); });
    const before = await page.content();
    const specs = [{ key: 'hero.title', selector: '.title', source: 'Uvel\nLet compute flow', value: 'Uvel\nLet compute flow again' }];
    assert.equal((await page.evaluate(inspectCombination, { specs, locale: 'en' })).failures.length, 0);
    assert.equal(await page.content(), before, 'Diagnostics must restore input');
    assert.equal((await page.evaluate(inspectCombination, { specs: [{ ...specs[0], selector: '.missing' }], locale: 'en' })).failures.length, 1);
    assert.equal((await page.evaluate(inspectCombination, { specs: [{ ...specs[0], source: 'wrong' }], locale: 'en' })).failures.length, 1);
    await page.evaluate(() => { window.__measureCopySpecimen = () => ({ observed: 1, observations: [{ geometry: {
      box: { left: 1, right: 100 }, ink: { top: 3, bottom: 20 }, lines: [{ text: 'Hello' }],
      related: [{ box: { left: 7, right: 80 }, ink: { top: 30, bottom: 40 }, lines: [{ text: 'Neighbor' }] }],
    } }] }); });
    const compact = (await page.evaluate(inspectCombination, { specs, locale: 'en' })).geometry[0];
    assert.equal(compact.lines, undefined); assert.equal(compact.related[0].lines, undefined);
    assert.deepEqual(compact.ink, { top: 3, bottom: 20 }); assert.equal(compact.related[0].box.right, 80);
    console.log('[copy-layout-joint v2] source, missing-consumer and restoration checks pass; no factor path exists');
  } finally { await browser.close(); }
}

async function run() {
  for (const retired of ['joint-limits', 'candidate-from']) assert.equal(flag(retired), undefined, 'Group factors are withdrawn');
  const data = json(join(root, 'admin/src/lib/text-layout-limits.json'));
  const calibration = json(join(root, 'docs/copy-layout-calibration.json'));
  assert.equal(data.version, 2); assert.equal(data.portableLayoutHash, sourceFingerprint(true, true));
  const dist = resolve(flag('dist') || calibration.dist), matrix = viewportMatrix(dist);
  assert.equal(digest(readFileSync(join(dist, 'index.html'))), calibration.buildHash);
  const smoke = process.argv.includes('--smoke');
  if (smoke) matrix.views = [{ width: 320, height: 844 }, { width: 390, height: 521 }, { width: 1440, height: 900 }];
  const locales = smoke ? ['en', 'vi', 'zh'] : data.locales;
  const out = resolve(flag('out') || join(root, '.cache/copy-length-correction/joint-report.json'));
  const report = { version: 2, scope: smoke ? 'smoke' : 'full', status: 'running', generatedAt: new Date().toISOString(),
    portableLayoutHash: data.portableLayoutHash, buildHash: calibration.buildHash, matrix, cases: [], errors: [],
    contract: 'Record actual default, simultaneous measured extensions and equal-count adversarial strings. Combination failures require preview; no proportional reduction or fabricated per-field cap.',
    geometryDetail: 'Measured element/ink/neighbor/occlusion bounds retained; duplicated per-line glyph runs omitted. Replay uses exact values and the fingerprinted build.' };
  const { server, base } = await serve(dist), browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ reducedMotion: 'reduce', colorScheme: 'light' });
  await context.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (...args) { return this.id === 'x-bg' ? null : original.apply(this, args); };
  });
  await context.addInitScript({ content: 'window.__measureCopySpecimen = ' + measureSpecimen.toString() + ';' });
  try {
    let next = 0;
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (next < locales.length) {
        const locale = locales[next++], page = await context.newPage();
        try {
          const route = locale === 'en' ? '/' : '/' + locale + '/';
          await page.goto(base + route, { waitUntil: 'load' });
          await page.evaluate(() => document.fonts.ready);
          const count = (value) => [...new Intl.Segmenter(locale, { granularity: 'grapheme' }).segment(value)].length;
          for (const view of matrix.views) {
            await page.setViewportSize(view);
            for (const group of groups) {
              await setMobileMenu(page, ['nav', 'combined'].includes(group.id));
              const authored = group.keys.flatMap((key) => {
                const rule = data.fields[key], reference = rule.references?.[locale];
                assert.equal(typeof reference, 'string', key + '/' + locale);
                return COPY_LAYOUT_CATALOG[key].consumers.filter((consumer) => ['home', 'all'].includes(consumer.route)
                  && (!group.prefix || consumer.selector.startsWith(group.prefix))).map((consumer) => ({ key, ...consumer, basis: rule.basis || 'container', source: reference }));
              });
              for (const sample of ['default', 'at-advice', 'wide-same-count', 'changed-breaks']) {
                const specs = authored.map((spec) => {
                  const record = calibration.records[[spec.key, '', locale].join('|')];
                  const reference = spec.source;
                  const value = sample === 'at-advice' && record.status === 'measured' ? record.accepted
                    : sample === 'wide-same-count' ? 'W'.repeat(count(reference))
                    : sample === 'changed-breaks' ? reference.replaceAll(' ', '\n') : reference;
                  return { ...spec, value };
                });
                const result = await page.evaluate(inspectCombination, { specs, locale });
                const technical = result.failures.filter((failure) => ['missing consumer', 'source not matched', 'missing paragraph host', 'observation gap'].includes(failure.reason));
                if (technical.length) report.errors.push({ locale, view, group: group.id, sample, failures: technical });
                report.cases.push({ locale, view, group: group.id, sample, values: Object.fromEntries(specs.map((spec) => [spec.key, spec.value])), ...result });
              }
            }
          }
          console.log('[copy-layout-joint v2] ' + locale + ' diagnostics recorded');
        } finally { await page.close(); }
      }
    }));
    assert.equal(data.portableLayoutHash, sourceFingerprint(true, true), 'Measured layout changed');
    report.summary = Object.fromEntries(['default', 'at-advice', 'wide-same-count', 'changed-breaks'].map((sample) => {
      const cases = report.cases.filter((entry) => entry.sample === sample);
      return [sample, { cases: cases.length, physicalConcerns: cases.filter((entry) => entry.failures.length).length }];
    }));
    report.status = report.errors.length ? 'failed' : 'diagnostic-complete';
    if (report.errors.length) process.exitCode = 1;
  } finally {
    await browser.close(); await new Promise((done) => server.close(done));
    mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(report) + '\n');
    if (flag('summary')) {
      const summary = { ...report, cases: undefined, fullReport: { path: out, sha256: digest(readFileSync(out)) },
        examples: ['default', 'at-advice', 'wide-same-count', 'changed-breaks'].map((sample) => report.cases.find((entry) => entry.sample === sample && entry.failures.length)).filter(Boolean) };
      writeFileSync(resolve(flag('summary')), JSON.stringify(summary, null, 2) + '\n');
    }
    console.log('[copy-layout-joint v2] ' + report.status + ': ' + out);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--self-test')) await selfTest();
  else await run();
}
