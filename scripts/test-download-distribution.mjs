// Node 24+: node scripts/test-download-distribution.mjs
// Serves the published build and an isolated build with explicitly enabled CMS destinations.
// Download targets are simulated HTTPS fixtures, not production pages or real APKs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { buildDownloadFixture, fixtureTargets as fixture } from './download-build-fixture.mjs';
import '../worker/register-ts-ext.mjs';
const { resolveDownloadUrl } = await import('../src/lib/download-policy.ts');

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(repo, 'dist');
const started = new Date();
const output = resolve(process.env.DOWNLOAD_QA_DIR || join(repo, '..', 'qa', `distribution-${started.toISOString().replaceAll(':', '-')}`));
const match = process.env.DOWNLOAD_TEST_MATCH ? new RegExp(process.env.DOWNLOAD_TEST_MATCH) : null;
const published = JSON.parse(await readFile(join(process.env.NEXGRID_SITE_FIXTURE_DIR || join(repo, 'src/config'), 'site.json'), 'utf8')).downloads;
const expectedPublished = Object.fromEntries(Object.keys(fixture).map(platform => [platform, resolveDownloadUrl(published[platform], platform)]));
const deviceProfiles = {
  desktop: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', platform: 'Win32', touch: 0, viewport: { width: 1440, height: 1000 } },
  ios: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', platform: 'iPhone', touch: 5, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  android: { userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36', platform: 'Linux armv8l', touch: 5, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  ipad: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', platform: 'MacIntel', touch: 5, viewport: { width: 820, height: 1180 }, hasTouch: true },
  unknown: { userAgent: 'Unrecognized Mobile/1.0', platform: 'Unknown', touch: 5, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
};
const pages = [];
async function enumerate(dir, route = '/') {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const file = join(dir, item.name);
    if (item.isDirectory()) await enumerate(file, `${route}${item.name}/`);
    else if (item.name === 'index.html') {
      const html = await readFile(file, 'utf8');
      pages.push({ route, html, hash: createHash('sha256').update(html).digest('hex') });
    }
  }
}
await enumerate(dist);
const landingPages = pages.filter(({ html }) => html.includes('data-distribution-page'));
assert(landingPages.length > 0, 'No built distribution page: run the product build before this test');
const locales = landingPages.map(({ route, html }) => ({ route,
  locale: html.match(/<html[^>]+lang="([^"]+)"/)?.[1], home: route.replace(/download\/$/, '') }));
assert(locales.every(({ locale, home }) => locale && pages.some(p => p.route === home)), 'Each distribution locale needs a generated home');
await mkdir(output, { recursive: true });

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.pdf': 'application/pdf' };
function createSiteServer(directory) {
  return createServer(async (request, response) => {
    try {
      const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      let file = resolve(directory, `.${path}`);
      if (file !== directory && !file.startsWith(directory + sep)) { response.writeHead(403).end(); return; }
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      const body = await readFile(file);
      response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body);
    } catch { response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); }
  });
}
async function listen(server) {
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  return `http://127.0.0.1:${server.address().port}`;
}
const enabledBuild = await buildDownloadFixture();
const enabledServer = createSiteServer(enabledBuild.dist), publishedServer = createSiteServer(dist);
let base, publishedBase, browser;
const results = [];
const card = page => page.locator('[data-distribution-card]');
const countTarget = (session, platform) => session.targets.filter(url => url === fixture[platform]).length;
const encodeAttribute = value => JSON.stringify(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;');

async function session(profile = 'desktop', options = {}) {
  const settings = { ...deviceProfiles[profile], ...options };
  const context = await browser.newContext({ viewport: settings.viewport, userAgent: settings.userAgent + (settings.embedded ? ' MicroMessenger/8.0.50' : ''),
    isMobile: settings.isMobile || false, hasTouch: settings.hasTouch || false, reducedMotion: settings.reducedMotion || 'reduce', acceptDownloads: true });
  const state = { context, page: await context.newPage(), targets: [], downloads: [], metrics: [], errors: [], unexpected: [], injected: 0 };
  await context.addInitScript(({ platform, touch, dnt }) => {
    Object.defineProperty(navigator, 'platform', { get: () => platform });
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => touch });
    Object.defineProperty(navigator, 'doNotTrack', { get: () => dnt ? '1' : '0' });
    // Repository screenshot protocol: avoid GPU-dependent force-dark behavior on the marketing canvas.
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (...args) { return this.id === 'x-bg' ? null : original.apply(this, args); };
  }, { platform: settings.platform, touch: settings.touch, dnt: !!settings.dnt });
  const urls = options.urls;
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (Object.values(fixture).some(target => new URL(target).origin === url.origin)) {
      if (Object.values(fixture).includes(url.href)) state.targets.push(url.href);
      if (url.href === fixture.android) {
        await route.fulfill({ status: 200, headers: { 'content-type': 'application/vnd.android.package-archive', 'content-disposition': 'attachment; filename="simulated-uvel.apk"' }, body: 'SIMULATED APK FIXTURE - NOT AN INSTALLABLE APPLICATION' }); return;
      }
      if (url.href === fixture.ios || url.href === fixture.h5) {
        await route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><title>Simulated destination</title><h1 data-fixture>${url.href === fixture.ios ? 'Simulated App Store destination' : 'Simulated H5 application'}</h1>` }); return;
      }
      if (url.pathname === '/favicon.ico') { await route.fulfill({ status: 204 }); return; }
    }
    if (![base, publishedBase].includes(url.origin)) { state.unexpected.push(url.href); await route.abort('blockedbyclient'); return; }
    if (url.pathname === '/api/e') { state.metrics.push(...request.postDataJSON().events); await route.fulfill({ status: 204 }); return; }
    // Exercise malformed payload handling separately from the real enabled and published builds.
    if (request.isNavigationRequest() && urls) {
      const response = await route.fetch();
      const html = await response.text();
      if (html.includes('data-distribution-card')) {
        let replacements = 0;
        const patched = html.replace(/data-urls="[^"]*"/g, () => { replacements++; return `data-urls="${encodeAttribute(urls)}"`; });
        assert.equal(replacements, 1, `Expected one download configuration in ${url.pathname}`);
        state.injected++;
        await route.fulfill({ response, body: patched }); return;
      }
      await route.fulfill({ response }); return;
    }
    await route.continue();
  });
  state.page.on('pageerror', error => state.errors.push(error.message));
  state.page.on('console', message => { if (message.type() === 'error') state.errors.push(message.text()); });
  state.page.on('download', download => state.downloads.push(download));
  state.page.setDefaultTimeout(12000);
  return state;
}

async function goto(page, path) {
  const url = new URL(path, base);
  // A script-initiated attachment can prevent Chromium's navigation waiter from observing
  // DOMContentLoaded, even though the landing document and its controls are already live.
  const isLanding = url.pathname.endsWith('/download/');
  const response = await page.goto(url.href, { waitUntil: isLanding ? 'commit' : 'domcontentloaded' });
  assert(response?.ok(), `Could not open ${path}`);
  if (isLanding) await page.waitForFunction(() => document.querySelector('[data-distribution-card]')?.dataset.state || document.querySelector('[data-fixture]'));
}
async function stateIs(page, expected) {
  await page.waitForFunction(expected => document.querySelector('[data-distribution-card]')?.dataset.state === expected, expected);
}
async function settle(page) { await page.waitForTimeout(180); }
async function fit(page, includeDialog = false) {
  await page.evaluate(() => document.fonts.ready);
  const geometry = await page.evaluate(includeDialog => {
    const root = document.querySelector('[data-distribution-card]'), box = root.getBoundingClientRect();
    const dialog = includeDialog ? document.querySelector('#distribution-dialog').getBoundingClientRect() : null;
    const bad = [...root.querySelectorAll('a,button,input,summary')].filter(el => el.getClientRects().length).filter(el => {
      const r = el.getBoundingClientRect();
      // A rotated decorative plus can extend a summary's scroll bounds while staying
      // safely inside the card; text-bearing link/button/input overflow is meaningful.
      return r.left < box.left - 1 || r.right > box.right + 1 || (el.matches('a,button,input') && el.scrollWidth > el.clientWidth + 2);
    }).map(el => `${el.tagName}: ${el.textContent.trim()}`);
    return { viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, left: box.left, right: box.right,
      bad, dialog: dialog && { left: dialog.left, right: dialog.right, top: dialog.top, bottom: dialog.bottom }, height: innerHeight };
  }, includeDialog);
  assert(geometry.scrollWidth <= geometry.viewport + 1, `Document overflows: ${JSON.stringify(geometry)}`);
  assert(geometry.left >= -1 && geometry.right <= geometry.viewport + 1, `Card overflows: ${JSON.stringify(geometry)}`);
  assert.deepEqual(geometry.bad, [], `Card controls overflow: ${JSON.stringify(geometry)}`);
  if (geometry.dialog) assert(geometry.dialog.top >= -1 && geometry.dialog.bottom <= geometry.height + 1, `Dialog outside viewport: ${JSON.stringify(geometry)}`);
  return geometry;
}
async function screenshot(page, name) {
  const path = join(output, `${name}.png`);
  await page.screenshot({ path, fullPage: false });
  return path;
}
async function checkQr(page, expected) {
  const image = page.locator('[data-distribution-qr]');
  await image.locator('svg').waitFor({ state: 'visible' });
  const png = PNG.sync.read(await image.screenshot());
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  assert(decoded, 'Rendered QR image could not be decoded');
  assert.equal(decoded.data, expected, 'Rendered QR must contain the expected destination');
  assert.equal(await page.locator('[data-distribution-link]').inputValue(), expected);
}
async function popoverIsOpen(page, platform) {
  await page.waitForFunction(platform => {
    const panel = document.querySelector('#distribution-dialog');
    return panel?.open && panel.dataset.presentation === 'popover' && panel.dataset.open === 'true'
      && document.querySelector('[data-distribution-card]')?.dataset.platform === platform;
  }, platform);
  const semantics = await page.locator('#distribution-dialog').evaluate(el => ({ modal: el.matches(':modal'), ariaModal: el.getAttribute('aria-modal') }));
  assert.equal(semantics.modal, false, 'Hover/focus QR should leave the page interactive');
  assert.notEqual(semantics.ariaModal, 'true', 'Non-modal QR should not claim modal semantics');
}
async function panelGeometry(page) {
  await page.evaluate(() => document.fonts.ready);
  // Include descendants and light pseudo-elements: the QR is usable only after the
  // complete entrance has settled, regardless of which surface animates it.
  await page.waitForFunction(() => {
    const panel = document.querySelector('#distribution-dialog');
    return panel?.open && panel.dataset.open === 'true'
      && !panel.getAnimations({ subtree: true }).some(animation => animation.playState === 'running' || animation.pending);
  });
  return page.locator('#distribution-dialog').evaluate(el => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height,
      viewportWidth: innerWidth, viewportHeight: innerHeight, placement: el.dataset.placement };
  });
}
function assertPopoverFits(box) {
  assert(Math.abs(box.width - 304) <= 1, `Desktop QR panel must be 304px wide: ${JSON.stringify(box)}`);
  assert(box.left >= 7 && box.right <= box.viewportWidth - 7, `Popover horizontal edge clearance: ${JSON.stringify(box)}`);
  assert(box.top >= 7 && box.bottom <= box.viewportHeight - 7, `Popover vertical edge clearance: ${JSON.stringify(box)}`);
}
function outsidePoint(box, button) {
  const candidates = [{ x: 3, y: 3 }, { x: box.viewportWidth - 3, y: 3 }, { x: 3, y: box.viewportHeight - 3 },
    { x: box.viewportWidth - 3, y: box.viewportHeight - 3 }];
  const inside = (p, b) => p.x >= b.left && p.x <= b.right && p.y >= b.top && p.y <= b.bottom;
  const target = candidates.find(p => !inside(p, box) && !inside(p, { left: button.x, right: button.x + button.width, top: button.y, bottom: button.y + button.height }));
  assert(target, 'No pointer exit point outside both trigger and panel');
  return target;
}
async function moveAcrossGap(page, button) {
  const trigger = await button.boundingBox(), panel = await panelGeometry(page);
  assert(trigger, 'Visible trigger geometry is required');
  const overlapLeft = Math.max(trigger.x, panel.left), overlapRight = Math.min(trigger.x + trigger.width, panel.right);
  assert(overlapRight > overlapLeft + 2, 'Anchored panel must overlap its trigger horizontally');
  const x = (overlapLeft + overlapRight) / 2;
  let gapY, panelY;
  if (panel.bottom <= trigger.y + 1) { gapY = (panel.bottom + trigger.y) / 2; panelY = panel.bottom - 14; }
  else if (panel.top >= trigger.y + trigger.height - 1) { gapY = (panel.top + trigger.y + trigger.height) / 2; panelY = panel.top + 14; }
  else assert.fail(`Popover overlaps its trigger vertically: ${JSON.stringify({ trigger, panel })}`);
  await page.mouse.move(x, trigger.y + trigger.height / 2);
  await page.mouse.move(x, gapY);
  await page.waitForTimeout(60);
  assert(await page.locator('#distribution-dialog').isVisible(), 'Short pointer transfer through the trigger-panel gap must not close the QR');
  await page.mouse.move(x, panelY, { steps: 3 });
  await page.waitForTimeout(450);
  assert.equal(await page.locator('#distribution-dialog').getAttribute('data-open'), 'true', 'Entering the panel must cancel leave dismissal');
  await page.mouse.move(x, gapY);
  await page.waitForTimeout(60);
  await page.mouse.move(x, trigger.y + trigger.height / 2, { steps: 3 });
  await page.waitForTimeout(450);
  assert.equal(await page.locator('#distribution-dialog').getAttribute('data-open'), 'true', 'Returning to the trigger must preserve the QR');
  return { trigger, panel, gapPoint: { x, y: gapY } };
}
function samplePanelFrames(page, duration = 850) {
  return page.evaluate(duration => new Promise(resolveFrames => {
    const start = performance.now(), frames = [];
    const collect = () => {
      const panel = document.querySelector('#distribution-dialog'), surface = panel.querySelector('.distribution-panel');
      const style = getComputedStyle(surface), r = panel.getBoundingClientRect();
      const light = getComputedStyle(panel.querySelector('.distribution-boot-glow'));
      frames.push({ ms: performance.now() - start, open: panel.open, state: panel.dataset.open, opacity: Number(style.opacity),
        top: r.top, left: r.left, width: r.width, height: r.height, transform: style.transform, filter: style.filter,
        clipPath: style.clipPath, display: style.display, lightOpacity: Number(light.opacity), lightTransform: light.transform,
        animations: panel.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running' || animation.pending).length });
      if (performance.now() - start >= duration) resolveFrames(frames);
      else requestAnimationFrame(collect);
    };
    collect();
  }), duration);
}
async function assertQrResting(page, expected) {
  const geometry = await panelGeometry(page);
  assertPopoverFits(geometry);
  const resting = await page.locator('[data-distribution-qr] svg').evaluate(svg => {
    const panel = document.querySelector('#distribution-dialog'), chain = [];
    for (let el = svg; el; el = el.parentElement) {
      const style = getComputedStyle(el);
      chain.push({ element: el.id || el.className?.baseVal || el.className || el.tagName,
        transform: style.transform, filter: style.filter, opacity: style.opacity });
      if (el === panel) break;
    }
    const light = getComputedStyle(panel.querySelector('.distribution-boot-glow'));
    return { chain, lightOpacity: Number(light.opacity), lightDisplay: light.display };
  });
  assert(resting.chain.every(item => item.transform === 'none' && item.filter === 'none' && Number(item.opacity) === 1),
    `Settled QR and its ancestors must be sharp, fully visible, and untransformed: ${JSON.stringify(resting)}`);
  assert(resting.lightOpacity === 0 || resting.lightDisplay === 'none', 'Entry light must disappear instead of covering the settled QR');
  const frames = await samplePanelFrames(page, 180);
  assert(frames.every(frame => frame.open && frame.state === 'true' && frame.animations === 0), 'Settled QR must remain open without looping effects');
  assert(frames.every(frame => Math.abs(frame.top - geometry.top) <= .5 && Math.abs(frame.left - geometry.left) <= .5), 'Settled QR must remain stationary');
  await checkQr(page, expected);
  return { geometry, resting };
}
function assertLightAperture(frames, phase) {
  const visible = frames.filter(frame => frame.open && frame.display !== 'none');
  const clipped = visible.filter(frame => frame.clipPath !== 'none' && frame.clipPath !== 'inset(0%)' && frame.clipPath !== 'inset(0px)');
  assert(new Set(clipped.map(frame => frame.clipPath)).size >= 3, `${phase} must reveal/conceal the card through a changing aperture`);
  assert(visible.some(frame => frame.lightOpacity > .02 && frame.lightOpacity < 1), `${phase} must include a visible transient light`);
  assert(visible.some(frame => frame.animations > 0), `${phase} must contain observable animation frames`);
}
async function keyboardFocusEntry(page, platform) {
  for (let steps = 0; steps < 80; steps++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate(platform => document.activeElement?.getAttribute('data-download-entry') === platform, platform)) return steps + 1;
  }
  assert.fail(`Keyboard could not reach ${platform} entry within 80 Tab presses`);
}
async function viewportDownloadControls(page) {
  return page.evaluate(() => {
    const candidates = [...document.querySelectorAll('[data-download-entry], .site-nav .dl-btn, #download .download-toggle')];
    return candidates.filter(el => {
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight;
    }).map(el => ({ entry: el.getAttribute('data-download-entry') || (el.matches('.download-toggle') ? 'toggle' : 'nav-download'),
      group: el.closest('#final-cta') ? 'footer' : el.closest('#download') ? 'hero' : el.closest('.site-nav') ? 'nav' : 'other' }));
  });
}
async function assertTarget(session, platform, action) {
  const prior = countTarget(session, platform);
  if (platform === 'android') {
    const promise = session.page.waitForEvent('download');
    await action();
    const download = await promise;
    assert.equal(download.url(), fixture.android);
    assert.equal(download.suggestedFilename(), 'simulated-uvel.apk');
    assert.equal(await download.failure(), null);
  } else {
    await action();
    await session.page.waitForURL(fixture[platform]);
    assert(await session.page.locator('[data-fixture]').isVisible());
  }
  assert.equal(countTarget(session, platform), prior + 1);
}
async function run(name, profile, options, check) {
  if (match && !match.test(name)) return;
  const begin = Date.now(), current = await session(profile, options);
  try {
    const evidence = await check(current);
    await settle(current.page);
    assert.deepEqual(current.errors, [], 'Browser errors');
    assert.deepEqual(current.unexpected, [], 'Unexpected external requests');
    if (options?.urls) assert(current.injected > 0, 'Runtime payload scenario did not reach a built page');
    results.push({ name, status: 'passed', elapsedMs: Date.now() - begin, fixture: options?.urls ? 'runtime payload' : options?.published ? 'published build configuration' : 'isolated enabled build', evidence,
      targetRequests: current.targets, downloads: current.downloads.map(d => ({ url: d.url(), filename: d.suggestedFilename() })) });
    console.log(`PASS ${name}`);
  } catch (error) {
    const failureScreenshot = await screenshot(current.page, `FAIL-${name.replaceAll(/[^a-zA-Z0-9_-]/g, '-')}`).catch(() => null);
    const failureState = await current.page.evaluate(() => ({ url: location.href, state: document.querySelector('[data-distribution-card]')?.dataset.state,
      navigationType: performance.getEntriesByType('navigation')[0]?.type, historyLength: history.length })).catch(() => null);
    results.push({ name, status: 'failed', elapsedMs: Date.now() - begin, error: error.stack, errors: current.errors, unexpected: current.unexpected,
      targetRequests: current.targets, failureState, failureScreenshot });
    console.error(`FAIL ${name}: ${error.message}`);
    console.error(JSON.stringify({ failureState, targets: current.targets, unexpected: current.unexpected }));
  } finally { await current.context.close(); }
}

try {
  base = await listen(enabledServer);
  publishedBase = await listen(publishedServer);
  browser = await chromium.launch();
  for (const locale of locales) {
    await run(`desktop clicks on explicit platform entries ${locale.locale}`, 'desktop', {}, async s => {
      for (const group of ['#download', '#final-cta']) for (const platform of Object.keys(fixture)) {
        await goto(s.page, locale.home);
        const entry = s.page.locator(`${group} [data-download-entry="${platform}"]`);
        assert.equal(await entry.getAttribute('href'), fixture[platform]);
        await assertTarget(s, platform, () => entry.click());
      }
      return { clickedEntries: 6, directDestinations: true };
    });
    await run(`published download settings and bookmarks ${locale.locale}`, 'desktop', { published: true }, async s => {
      await goto(s.page, publishedBase + locale.home);
      assert.deepEqual(await card(s.page).evaluate(el => JSON.parse(el.dataset.urls)), expectedPublished);
      for (const [platform, expected] of Object.entries(expectedPublished)) {
        const entries = s.page.locator(`#download [data-download-entry="${platform}"], #final-cta [data-download-entry="${platform}"]`);
        assert.equal(await entries.count(), 2);
        for (const entry of await entries.all()) assert.equal(await entry.getAttribute('href'), expected || null);
        if (expected) continue;
        await entries.first().click(); await stateIs(s.page, 'unavailable');
        assert(await s.page.locator('[data-distribution-qr]').isHidden());
        assert(await s.page.locator('[data-distribution-copy]').isHidden());
        assert.equal(await s.page.locator('[data-distribution-action]').getAttribute('href'), null);
        assert(await s.page.locator('[data-distribution-title]').innerText());
        await s.page.keyboard.press('Escape');
        await s.page.locator('#distribution-dialog').waitFor({ state: 'hidden' });
        await goto(s.page, `${publishedBase}${locale.route}?platform=${platform}`); await stateIs(s.page, 'unavailable');
        assert(await s.page.locator('[data-distribution-qr]').isHidden());
        assert(await s.page.locator('[data-distribution-copy]').isHidden());
        assert.equal(await s.page.locator('[data-distribution-action]').getAttribute('href'), null);
        await goto(s.page, publishedBase + locale.home);
      }
      assert.equal(s.targets.length, 0);
      return { checked: Object.keys(expectedPublished) };
    });
    for (const device of ['ios', 'android']) for (const entryGroup of ['hero', 'footer']) {
      await run(`phone ${device} clicks auto ${entryGroup} ${locale.locale}`, device, {}, async s => {
        await goto(s.page, locale.home);
        const group = s.page.locator(entryGroup === 'hero' ? '#download' : '#final-cta');
        if (entryGroup === 'footer') await group.scrollIntoViewIfNeeded();
        const button = group.locator('[data-download-entry="auto"]');
        await button.waitFor({ state: 'visible' });
        assert(await group.locator('[data-download-entry="ios"]').isHidden());
        assert(await group.locator('[data-download-entry="android"]').isHidden());
        assert.equal(await group.locator('[data-download-entry]:visible').count(), 2, 'Mobile group exposes only auto App and H5');
        await assertTarget(s, device, () => button.click());
        assert.deepEqual(s.targets, [fixture[device]], 'Phone App button must choose actual OS');
        assert.deepEqual(s.metrics.filter(event => event.t === 'cta').map(event => event.cta), [device], 'One real platform CTA must be sent before navigation');
        return { clicked: 'auto', entryGroup, destinationOS: device };
      });
    }
  }
  const first = locales.find(l => l.locale === 'en') || locales[0];
  for (const locale of locales) for (const platform of ['ios', 'h5']) for (const dnt of [false, true]) {
    await run(`metrics immediate ${platform} DNT=${dnt} ${locale.locale}`, 'ios', { dnt }, async s => {
      await assertTarget(s, platform, () => goto(s.page, `${locale.route}?platform=${platform}`));
      await settle(s.page);
      const pvs = s.metrics.filter(event => event.t === 'pv');
      if (dnt) assert.deepEqual(s.metrics, [], 'DNT disables every beacon including the pre-navigation flush');
      else { assert.equal(pvs.length, 1); assert.equal(pvs[0].path, locale.route); assert.equal(pvs[0].loc, locale.locale); }
      return { dnt, pageViews: pvs.length };
    });
  }
  for (const profile of ['ios', 'android', 'unknown', 'desktop']) {
    const urls = profile === 'ios' ? { ...fixture, ios: '' } : profile === 'android' ? { ...fixture, android: '' } : fixture;
    await run(`metrics auto without resolved target ${profile}`, profile, { urls }, async s => {
      await goto(s.page, first.home);
      assert.equal(await s.page.locator('#download [data-download-entry="auto"]').getAttribute('data-m'), null);
      return { unavailableHasNoCta: true };
    });
  }
  // These cases extend the original routing matrix with the wide-desktop QR popover.
  // Every opener is activated by an actual pointer or keyboard action.
  for (const locale of locales) {
    await run(`popover hover all App entry points ${locale.locale}`, 'desktop', {}, async s => {
      await goto(s.page, locale.home);
      assert(await s.page.evaluate(() => matchMedia('(min-width: 761px) and (hover: hover) and (pointer: fine)').matches));
      let hovered = 0;
      const placements = [];
      for (const platform of ['ios', 'android']) {
        const buttons = s.page.locator(`[data-download-entry="${platform}"]`);
        for (let index = 0; index < await buttons.count(); index++) {
          const button = buttons.nth(index);
          await button.hover(); await popoverIsOpen(s.page, platform);
          const geometry = await panelGeometry(s.page); assertPopoverFits(geometry);
          await checkQr(s.page, fixture[platform]);
          assert(await button.evaluate(el => el !== document.activeElement), 'Pointer hover must not steal keyboard focus');
          assert.equal(await button.getAttribute('aria-expanded'), 'true');
          const pointer = outsidePoint(geometry, await button.boundingBox());
          await s.page.mouse.move(pointer.x, pointer.y);
          await s.page.locator('#distribution-dialog').waitFor({ state: 'hidden' });
          assert.equal(await button.getAttribute('aria-expanded'), 'false');
          placements.push(geometry.placement); hovered++;
        }
      }
      assert.equal(s.targets.length, 0);
      return { hoveredAppEntryPoints: hovered, placements, qrDecoded: true };
    });
  }
  await run('popover transfer gap keeps QR open both directions', 'desktop', {}, async s => {
    await goto(s.page, first.home);
    const button = s.page.locator('#download [data-download-entry="ios"]');
    await button.hover(); await popoverIsOpen(s.page, 'ios');
    const geometry = await moveAcrossGap(s.page, button);
    await checkQr(s.page, fixture.ios);
    return { ...geometry, screenshot: await screenshot(s.page, 'popover-transfer') };
  });
  await run('popover light opening settles into a crisp stationary QR', 'desktop', { reducedMotion: 'no-preference' }, async s => {
    await goto(s.page, first.home);
    await s.page.waitForFunction(() => !document.documentElement.classList.contains('x-boot'));
    const button = s.page.locator('#download [data-download-entry="android"]');
    await button.scrollIntoViewIfNeeded();
    const trigger = await button.boundingBox();
    const pendingFrames = samplePanelFrames(s.page, 900);
    await s.page.mouse.move(trigger.x + trigger.width / 2, trigger.y + trigger.height / 2);
    await popoverIsOpen(s.page, 'android');
    const frames = await pendingFrames;
    assertLightAperture(frames, 'Opening');
    const active = frames.filter(frame => frame.open && frame.animations > 0);
    assert(active.at(-1).ms - active[0].ms >= 200 && active.at(-1).ms - active[0].ms <= 650, 'Opening must have a perceptible, bounded duration');
    const resting = await assertQrResting(s.page, fixture.android);
    return { frames, ...resting, screenshot: await screenshot(s.page, 'popover-motion-resting') };
  });
  await run('popover leave uses grace then visible light collapse', 'desktop', { reducedMotion: 'no-preference' }, async s => {
    await goto(s.page, first.home);
    const button = s.page.locator('#download [data-download-entry="android"]');
    await button.hover(); await popoverIsOpen(s.page, 'android');
    const geometry = await panelGeometry(s.page), pointer = outsidePoint(geometry, await button.boundingBox());
    const pendingFrames = samplePanelFrames(s.page);
    await s.page.mouse.move(pointer.x, pointer.y);
    const frames = await pendingFrames;
    const leaving = frames.find(frame => frame.open && frame.state === 'false');
    const closed = frames.find(frame => !frame.open);
    assert(leaving && leaving.ms >= 80 && leaving.ms <= 500, `Expected a short leave grace before animation: ${JSON.stringify(frames)}`);
    assert(closed && closed.ms > leaving.ms && closed.ms <= 850, 'Panel must close after its exit phase');
    const animated = frames.filter(frame => frame.open && frame.state === 'false');
    assert(animated.some(frame => frame.opacity > 0.01 && frame.opacity < 0.99), 'Exit must visibly fade before dialog.close()');
    assertLightAperture(animated, 'Closing');
    assert(closed.ms - leaving.ms >= 150 && closed.ms - leaving.ms <= 500, 'Closing must finish its visible collapse before hiding the dialog');
    assert(animated.every(frame => Math.abs(frame.top - geometry.top) <= .5 && Math.abs(frame.left - geometry.left) <= .5), 'The anchor shell must remain in place while its screen collapses');
    assert(await s.page.locator('#distribution-dialog').isHidden());
    return { geometry, frames };
  });
  await run('popover reentry cancels an in-progress exit', 'desktop', { reducedMotion: 'no-preference' }, async s => {
    await goto(s.page, first.home);
    const button = s.page.locator('#download [data-download-entry="ios"]');
    await button.hover(); await popoverIsOpen(s.page, 'ios');
    const geometry = await panelGeometry(s.page), trigger = await button.boundingBox(), pointer = outsidePoint(geometry, trigger);
    await s.page.mouse.move(pointer.x, pointer.y);
    await s.page.waitForFunction(() => { const panel = document.querySelector('#distribution-dialog'); return panel.open && panel.dataset.open === 'false'; });
    await s.page.waitForTimeout(90);
    const pendingFrames = samplePanelFrames(s.page, 900);
    await s.page.mouse.move(trigger.x + trigger.width / 2, trigger.y + trigger.height / 2);
    await popoverIsOpen(s.page, 'ios');
    const frames = await pendingFrames;
    assert(frames.every(frame => frame.open), 'Reentry must reverse the exit without a hidden flash or delayed close');
    await popoverIsOpen(s.page, 'ios');
    const resting = await assertQrResting(s.page, fixture.ios);
    return { exitCancelledOnTriggerReentry: true, frames, ...resting };
  });
  await run('popover reduced motion opens and closes without animation', 'desktop', { reducedMotion: 'reduce' }, async s => {
    await goto(s.page, first.home);
    const button = s.page.locator('#download [data-download-entry="ios"]');
    const trigger = await button.boundingBox();
    const pendingFrames = samplePanelFrames(s.page, 450);
    await s.page.mouse.move(trigger.x + trigger.width / 2, trigger.y + trigger.height / 2);
    await popoverIsOpen(s.page, 'ios');
    const frames = await pendingFrames;
    const displayed = frames.filter(frame => frame.open && frame.state === 'true');
    assert(displayed.length > 0, 'Reduced motion must still show the QR');
    assert(displayed.every(frame => frame.animations === 0 && frame.transform === 'none' && frame.filter === 'none' && frame.opacity === 1 && frame.lightOpacity === 0),
      `Reduced motion must skip all visual effects: ${JSON.stringify(displayed)}`);
    const resting = await assertQrResting(s.page, fixture.ios);
    const closeFrames = samplePanelFrames(s.page, 200);
    await s.page.keyboard.press('Escape');
    await s.page.locator('#distribution-dialog').waitFor({ state: 'hidden' });
    const closing = await closeFrames;
    assert(closing.every(frame => !frame.open || frame.state === 'true'), 'Reduced motion must not retain an animated closing phase');
    assert(closing.find(frame => !frame.open)?.ms <= 100, 'Reduced motion Escape must close immediately');
    return { frames, closing, ...resting };
  });
  await run('popover keyboard focus and Escape preserve focus without reopening', 'desktop', {}, async s => {
    await goto(s.page, first.home);
    const tabs = await keyboardFocusEntry(s.page, 'ios');
    const focused = s.page.locator('[data-download-entry="ios"]:focus');
    assert.equal(await focused.count(), 1);
    await popoverIsOpen(s.page, 'ios');
    assert(await focused.evaluate(el => el === document.activeElement), 'Focus opener must retain focus');
    await s.page.keyboard.press('Shift+Tab');
    await s.page.locator('#distribution-dialog').waitFor({ state: 'hidden' });
    await s.page.keyboard.press('Tab'); await popoverIsOpen(s.page, 'ios');
    await s.page.keyboard.press('Escape');
    await s.page.locator('#distribution-dialog').waitFor({ state: 'hidden' });
    assert.equal(await s.page.locator('[data-download-entry="ios"]:focus').count(), 1);
    await s.page.waitForTimeout(450);
    assert(await s.page.locator('#distribution-dialog').isHidden(), 'Escape focus restoration must not immediately reopen the popover');
    return { tabsToEntry: tabs, focusRestored: true, escapeRemainsClosed: true };
  });
  for (const reducedMotion of ['no-preference', 'reduce']) {
    await run(`popover keyboard Copy Escape stays closed ${reducedMotion}`, 'desktop', { reducedMotion }, async s => {
      await goto(s.page, first.home);
      const tabs = await keyboardFocusEntry(s.page, 'ios');
      const trigger = s.page.locator('#download [data-download-entry="ios"]');
      await popoverIsOpen(s.page, 'ios');
      await panelGeometry(s.page);
      await s.page.keyboard.press('ArrowDown');
      assert(await s.page.locator('[data-distribution-copy]').evaluate(el => el === document.activeElement),
        'ArrowDown must move real keyboard focus from the iOS entry into Copy');
      await s.page.keyboard.press('Escape');
      await s.page.locator('#distribution-dialog').waitFor({ state: 'hidden' });
      assert(await trigger.evaluate(el => el === document.activeElement), 'Escape from Copy must restore the iOS opener');
      const frames = await samplePanelFrames(s.page, 1100);
      assert(frames.every(frame => !frame.open && frame.state === 'false' && frame.animations === 0),
        `Native focus restoration must not reopen the QR after Escape: ${JSON.stringify(frames)}`);
      assert(await trigger.evaluate(el => el === document.activeElement), 'The restored opener must retain focus after the closing timers expire');
      assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
      return { tabsToEntry: tabs, keyboardPath: ['Tab to iOS', 'ArrowDown to Copy', 'Escape'], focusRestored: true, frames };
    });
  }
  await run('popover hover switches platform without a click', 'desktop', {}, async s => {
    await goto(s.page, first.home);
    const ios = s.page.locator('#download [data-download-entry="ios"]'), android = s.page.locator('#download [data-download-entry="android"]');
    await ios.hover(); await popoverIsOpen(s.page, 'ios');
    await android.hover(); await popoverIsOpen(s.page, 'android');
    assert.equal(await ios.getAttribute('aria-expanded'), 'false');
    assert.equal(await android.getAttribute('aria-expanded'), 'true');
    await checkQr(s.page, fixture.android);
    assert.equal(s.targets.length, 0);
    return { switchedTo: 'android', screenshot: await screenshot(s.page, 'popover-android') };
  });
  for (const width of [761, 1440, 1920]) {
    await run(`popover stays in viewport near edges ${width}`, 'desktop', { viewport: { width, height: 844 } }, async s => {
      await goto(s.page, first.home);
      const buttons = s.page.locator('[data-download-entry="android"]');
      const samples = [];
      for (const index of [0, await buttons.count() - 1]) {
        const button = buttons.nth(index);
        await button.scrollIntoViewIfNeeded(); await button.hover(); await popoverIsOpen(s.page, 'android');
        const geometry = await panelGeometry(s.page); assertPopoverFits(geometry); samples.push(geometry);
        const pointer = outsidePoint(geometry, await button.boundingBox()); await s.page.mouse.move(pointer.x, pointer.y);
        await s.page.locator('#distribution-dialog').waitFor({ state: 'hidden' });
      }
      return { geometry: samples };
    });
  }
  for (const width of [390, 760]) {
    await run(`popover disabled on narrow desktop ${width}`, 'desktop', { viewport: { width, height: 844 } }, async s => {
      await goto(s.page, first.home);
      const button = s.page.locator('#download [data-download-entry="auto"]'), panel = s.page.locator('#distribution-dialog');
      await button.hover(); await s.page.waitForTimeout(450);
      assert(await panel.isHidden(), 'Narrow-screen hover must not open the QR');
      await button.click(); await stateIs(s.page, 'qr');
      assert(await panel.evaluate(el => el.matches(':modal')), 'Narrow-screen click must use the modal QR');
      await checkQr(s.page, fixture.android);
      if (width === 760) await s.page.locator('[data-distribution-close]').click();
      else await s.page.keyboard.press('Escape');
      await panel.waitFor({ state: 'hidden' });
      return { width, hoverIgnored: true, clickModal: true };
    });
  }
  await run('popover disabled for a wide coarse pointer', 'desktop', { hasTouch: true }, async s => {
    await goto(s.page, first.home);
    assert.equal(await s.page.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches), false);
    const button = s.page.locator('#download [data-download-entry="android"]'), panel = s.page.locator('#distribution-dialog');
    await button.hover(); await s.page.waitForTimeout(450); assert(await panel.isHidden());
    await assertTarget(s, 'android', () => button.click());
    return { coarsePointerHoverIgnored: true, directDownload: true };
  });
  await run('homepage hero Web App shows a direct QR while retaining click navigation', 'desktop', {}, async s => {
    await goto(s.page, first.home);
    const hero = s.page.locator('#download [data-download-entry="h5"]');
    const footer = s.page.locator('#final-cta [data-download-entry="h5"]');
    const panel = s.page.locator('#distribution-dialog');
    await hero.hover(); await popoverIsOpen(s.page, 'h5');
    await checkQr(s.page, fixture.h5);
    assert.equal(countTarget(s, 'h5'), 0);
    await footer.hover(); await panel.waitFor({ state: 'hidden' });
    await hero.hover(); await popoverIsOpen(s.page, 'h5');
    await hero.click(); await s.page.waitForURL(fixture.h5);
    assert.equal(countTarget(s, 'h5'), 1);
    return { heroQr: true, footerHoverIgnored: true, directClick: true };
  });
  for (const locale of locales) for (const width of [390, 760, 761, 1440]) {
    await run(`download hierarchy preserves navigation and responsive groups ${locale.locale} ${width}`, 'desktop', { viewport: { width, height: 844 } }, async s => {
      await goto(s.page, locale.home);
      await s.page.waitForTimeout(300);
      const expected = width <= 760 ? ['auto', 'h5'] : ['android', 'h5', 'ios'];
      const desktopNavigation = width >= 881;
      const expectedViewport = [...expected, ...(desktopNavigation ? ['nav-download'] : [])].sort();
      const navigation = s.page.locator('.site-nav .dl-btn');
      assert.equal(await s.page.locator('.site-nav [data-download-entry="h5"]').count(), 0, 'Homepage navigation must not render a duplicate WebApp link');
      assert.equal(await navigation.getAttribute('href'), width <= 760 ? null : '#download',
        'Desktop navigation scrolls to the choices, while a narrow desktop uses the auto chooser');
      assert(await navigation.evaluate(el => !el.inert && el.getAttribute('aria-hidden') !== 'true'), 'Navigation Download must remain in the accessibility sequence');
      const initial = await viewportDownloadControls(s.page);
      assert.deepEqual(initial.map(item => item.entry).sort(), expectedViewport, `Incorrect download hierarchy at page top: ${JSON.stringify(initial)}`);
      assert(initial.filter(item => item.entry !== 'nav-download').every(item => item.group === 'hero'), 'Main platform choices should be in the hero');
      let intermediate = null;
      if (desktopNavigation) {
        const navColor = await navigation.evaluate(el => getComputedStyle(el).backgroundColor);
        const channels = navColor.match(/[0-9.]+/g)?.map(Number) || [];
        assert(channels.length >= 3 && channels[1] > channels[0] && channels[1] > channels[2], `Navigation Download must retain its green emphasis: ${navColor}`);
        await s.page.locator('#how').scrollIntoViewIfNeeded(); await s.page.waitForTimeout(400);
        intermediate = await viewportDownloadControls(s.page);
        assert.deepEqual(intermediate.map(item => item.entry).sort(), ['nav-download'], 'Navigation Download must stay visible between platform groups');
        assert(intermediate.every(item => item.group === 'nav'));
        await navigation.click();
        await s.page.waitForFunction(() => {
          const rect = document.querySelector('#download').getBoundingClientRect();
          return rect.top >= 0 && rect.bottom <= innerHeight;
        });
        assert.equal(s.targets.length, 0, 'Desktop navigation Download must scroll to choices without opening an external destination');
        assert(await s.page.locator('#distribution-dialog').isHidden(), 'Desktop navigation Download must not open a QR by itself');
      }
      const footer = s.page.locator('#final-cta');
      await footer.scrollIntoViewIfNeeded();
      await s.page.waitForTimeout(400);
      const atFooter = await viewportDownloadControls(s.page);
      assert.deepEqual(atFooter.map(item => item.entry).sort(), expectedViewport, `Incorrect download hierarchy at footer: ${JSON.stringify(atFooter)}`);
      assert(atFooter.filter(item => item.entry !== 'nav-download').every(item => item.group === 'footer'), 'Floating dock must yield to footer platform choices');
      if (width <= 760) assert(await s.page.locator('#download').evaluate(el => el.inert && el.getAttribute('aria-hidden') === 'true'),
        'Hidden mobile dock must not retain keyboard/screen-reader controls');
      await s.page.keyboard.press('Control+Home');
      await s.page.waitForFunction(() => scrollY <= 8);
      await s.page.waitForTimeout(300);
      const restored = await viewportDownloadControls(s.page);
      assert.deepEqual(restored.map(item => item.entry).sort(), expectedViewport);
      assert(restored.filter(item => item.entry !== 'nav-download').every(item => item.group === 'hero'), 'Main download group should return after leaving footer');
      if (width <= 760) {
        assert.equal(await s.page.locator('#download .download-toggle').getAttribute('aria-expanded'), 'true', 'Keyboard return to top must restore expanded platform choices');
        assert(await s.page.locator('#download').evaluate(el => !el.inert && el.getAttribute('aria-hidden') !== 'true'), 'Restored dock must be keyboard and screen-reader accessible');
      }
      return { initial, intermediate, atFooter, restored, screenshot: await screenshot(s.page, `download-group-${locale.locale}-${width}`) };
    });
  }
  for (const locale of locales) {
    await run(`inner page retains navigation WebApp ${locale.locale}`, 'desktop', {}, async s => {
      const route = `${locale.home}uvt/`;
      assert(pages.some(page => page.route === route), 'Generated inner-page fixture must exist');
      await goto(s.page, route);
      const h5 = s.page.locator('.site-nav [data-download-entry="h5"]');
      assert.equal(await h5.count(), 1, 'Inner pages need one navigation WebApp link');
      assert(await h5.isVisible(), 'Inner-page WebApp must remain visible on desktop');
      assert.equal(await s.page.locator('.site-nav .dl-btn').getAttribute('href'), `${locale.home}#download`);
      assert.equal(await h5.getAttribute('href'), fixture.h5);
      await assertTarget(s, 'h5', () => h5.click());
      return { route, navigationWebAppWorks: true };
    });
  }
  for (const locale of locales) for (const entryGroup of ['hero', 'footer']) {
    await run(`Android attachment keeps feedback retry and close usable ${locale.locale} ${entryGroup}`, 'android', {}, async s => {
      await goto(s.page, locale.home);
      const group = s.page.locator(entryGroup === 'hero' ? '#download' : '#final-cta');
      if (entryGroup === 'footer') await group.scrollIntoViewIfNeeded();
      const trigger = group.locator('[data-download-entry="auto"]');
      await assertTarget(s, 'android', () => trigger.click());
      assert.equal(s.page.url(), `${base}${locale.home}`, 'An APK attachment must leave the original page available');
      await stateIs(s.page, 'initiated');
      const panel = s.page.locator('#distribution-dialog'), retry = s.page.locator('[data-distribution-action]');
      assert(await panel.isVisible(), 'Attachment initiation must expose its feedback dialog on the original page');
      assert(await panel.evaluate(el => el.matches(':modal')), 'Phone download feedback should be a dismissible modal');
      assert(await s.page.locator('[data-distribution-status]').isVisible(), 'Downloading status must be visible after the browser accepts the attachment');
      assert((await s.page.locator('[data-distribution-status]').innerText()).trim(), 'Downloading status must explain what is happening');
      const help = s.page.locator('[data-distribution-help]');
      assert(await help.isVisible() && await help.getAttribute('open') !== null, 'Android installation help must remain expanded and visible');
      assert(await help.locator('li').first().isVisible(), 'Installation guidance must expose its steps');
      assert(await retry.isVisible(), 'Retry must stay visible after the attachment starts');
      assert.equal(await retry.getAttribute('href'), fixture.android);
      const retryLabel = await retry.innerText();
      assert(retryLabel.trim(), 'Retry needs a readable label');
      await fit(s.page, true);
      await assertTarget(s, 'android', () => retry.click());
      await stateIs(s.page, 'initiated');
      assert(await panel.isVisible() && await retry.isVisible(), 'Retry must preserve usable feedback on the original page');
      assert.equal(s.downloads.length, 2, 'One initial request plus one explicit retry should create exactly two simulated attachments');
      const image = await screenshot(s.page, `android-feedback-${locale.locale}-${entryGroup}`);
      if (entryGroup === 'hero') await s.page.keyboard.press('Escape');
      else await s.page.locator('[data-distribution-close]').click();
      await panel.waitFor({ state: 'hidden' });
      assert(await trigger.evaluate(el => el === document.activeElement), 'Dismissal must return focus to the App button');
      await s.page.waitForTimeout(450);
      assert(await panel.isHidden(), 'Dismissal must leave the feedback closed');
      assert.equal(s.targets.length, 2, 'Closing the feedback must not repeat the APK request');
      return { entryGroup, downloads: 2, retryLabel, feedbackVisible: true, helpExpanded: true, dismissal: entryGroup === 'hero' ? 'Escape' : 'close button', screenshot: image };
    });
  }
  for (const width of [320, 390]) {
    await run(`narrow desktop remains desktop ${width}`, 'desktop', { viewport: { width, height: 844 } }, async s => {
      await goto(s.page, first.home);
      await s.page.locator('#download [data-download-entry="auto"]').click(); await stateIs(s.page, 'qr');
      await checkQr(s.page, fixture.android);
      const geometry = await fit(s.page, true);
      assert.equal(s.targets.length, 0);
      return { geometry, screenshot: await screenshot(s.page, `desktop-qr-${width}`) };
    });
    await run(`standalone page fits ${width}`, 'unknown', { viewport: { width, height: 844 } }, async s => {
      await goto(s.page, `${first.route}?platform=auto`); await stateIs(s.page, 'choose');
      return { geometry: await fit(s.page), screenshot: await screenshot(s.page, `manual-choice-${width}`) };
    });
  }
  await run('standalone desktop page fits 1440', 'desktop', {}, async s => {
    await goto(s.page, `${first.route}?platform=android`); await stateIs(s.page, 'qr');
    await checkQr(s.page, fixture.android);
    return { geometry: await fit(s.page), screenshot: await screenshot(s.page, 'desktop-download-1440') };
  });
  for (const device of ['ios', 'android']) {
    for (const request of [device, 'auto']) await run(`scan ${request} on ${device}`, device, {}, async s => {
      await assertTarget(s, device, () => goto(s.page, `${first.route}?platform=${request}`));
      if (device === 'android') {
        await stateIs(s.page, 'initiated'); assert(await s.page.locator('[data-distribution-help]').getAttribute('open') !== null);
        await fit(s.page);
      }
      return { request, detectedOS: device };
    });
    const opposite = device === 'ios' ? 'android' : 'ios';
    await run(`mismatched ${opposite} scan corrected on ${device}`, device, {}, async s => {
      await goto(s.page, `${first.route}?platform=${opposite}`); await stateIs(s.page, 'mismatch');
      assert.equal(s.targets.length, 0); assert(await s.page.locator('[data-distribution-action]').isHidden());
      const image = await screenshot(s.page, `mismatch-on-${device}`);
      await assertTarget(s, device, () => s.page.locator('[data-distribution-switch]').click());
      assert.deepEqual(s.targets, [fixture[device]]);
      return { screenshot: image, correctedOS: device };
    });
    await run(`history traversal avoids automatic ${device} retry`, device, {}, async s => {
      await goto(s.page, first.home);
      if (device === 'ios') {
        // Correct a scanned Android link first, so the user's click creates an ordinary
        // history entry. Initial-load redirects may legally replace their landing entry.
        await goto(s.page, `${first.route}?platform=android`); await stateIs(s.page, 'mismatch');
        await assertTarget(s, device, () => s.page.locator('[data-distribution-switch]').click());
      } else await assertTarget(s, device, () => goto(s.page, `${first.route}?platform=auto`));
      if (device === 'ios') {
        await s.page.goBack({ waitUntil: 'domcontentloaded' }); await stateIs(s.page, 'navigate');
        await s.page.goBack({ waitUntil: 'domcontentloaded' });
        await s.page.goForward({ waitUntil: 'domcontentloaded' }); await stateIs(s.page, 'navigate');
      } else {
        await s.page.locator('.download-home').click();
        await s.page.goBack({ waitUntil: 'domcontentloaded' }); await stateIs(s.page, 'navigate');
        await s.page.goForward({ waitUntil: 'domcontentloaded' });
        await s.page.goBack({ waitUntil: 'domcontentloaded' }); await stateIs(s.page, 'navigate');
      }
      await settle(s.page); assert.equal(countTarget(s, device), 1, 'History must not repeat external navigation or APK request');
      assert.equal(await s.page.evaluate(() => performance.getEntriesByType('navigation')[0]?.type), 'back_forward');
      await assertTarget(s, device, () => s.page.locator('[data-distribution-action]').click());
      return { automaticRequests: 1, explicitRetryWorks: true };
    });
    await run(`embedded ${device} App guidance`, device, { embedded: true }, async s => {
      await goto(s.page, first.home);
      await s.page.locator('#download [data-download-entry="auto"]').click(); await stateIs(s.page, 'browser');
      assert.equal(await card(s.page).getAttribute('data-platform'), device); assert.equal(s.targets.length, 0);
      assert(await s.page.locator('[data-distribution-action]').isHidden());
      assert(await s.page.locator('[data-distribution-description]').innerText());
      return { screenshot: await screenshot(s.page, `embedded-${device}`) };
    });
  }
  await run('desktop-mode iPad honors the selected Android entry', 'ipad', {}, async s => {
    await goto(s.page, first.home);
    await assertTarget(s, 'android', () => s.page.locator('#download [data-download-entry="android"]').click());
    return { platform: 'MacIntel', maxTouchPoints: 5, destination: 'android' };
  });
  await run('automatic iOS redirect can be left with Back', 'ios', {}, async s => {
    await goto(s.page, first.home);
    await assertTarget(s, 'ios', () => goto(s.page, `${first.route}?platform=auto`));
    await s.page.goBack({ waitUntil: 'domcontentloaded' });
    await settle(s.page);
    assert(s.page.url().startsWith(base), 'Back must return to a local page instead of immediately reopening iOS');
    assert.equal(countTarget(s, 'ios'), 1);
    return { returnedTo: s.page.url(), targetRequests: 1 };
  });
  for (const device of ['ios', 'android']) {
    const opposite = device === 'ios' ? 'android' : 'ios';
    await run(`button-source bookmark honors ${opposite} on ${device}`, device, {}, async s => {
      await assertTarget(s, opposite, () => goto(s.page, `${first.route}?platform=${opposite}&source=button`));
      assert.deepEqual(s.targets, [fixture[opposite]]);
      return { selectedPlatform: opposite, source: 'button', detectedOS: device };
    });
  }
  for (const device of ['desktop', 'ios', 'android', 'unknown']) {
    await run(`H5 button works on ${device}`, device, {}, async s => {
      await goto(s.page, first.home);
      await assertTarget(s, 'h5', () => s.page.locator('#download [data-download-entry="h5"]').click());
      assert.deepEqual(s.targets, [fixture.h5]);
      return { destination: 'simulated H5 page' };
    });
    await run(`embedded H5 guidance on ${device}`, device, { embedded: true }, async s => {
      await goto(s.page, `${first.route}?platform=h5`); await stateIs(s.page, 'browser');
      assert.equal(s.targets.length, 0); assert(await s.page.locator('[data-distribution-description]').innerText());
      await assertTarget(s, 'h5', () => s.page.locator('[data-distribution-action]').click());
      return { automaticRequests: 0, explicitContinueWorks: true };
    });
  }
  await run('unknown mobile selects a version manually', 'unknown', {}, async s => {
    await goto(s.page, `${first.route}?platform=auto`); await stateIs(s.page, 'choose');
    assert.equal(s.targets.length, 0);
    assert.equal(await s.page.locator('[data-distribution-option]:visible').count(), 3);
    await assertTarget(s, 'ios', () => s.page.locator('[data-distribution-option="ios"]').click());
    return { manualSelection: 'ios' };
  });
  await run('query redirect injection is ignored', 'android', {}, async s => {
    const query = new URLSearchParams({ platform: 'javascript:alert(1)', url: 'https://evil.example.test/app', redirect: 'https://evil.example.test/app', next: '//evil.example.test' });
    await assertTarget(s, 'android', () => goto(s.page, `${first.route}?${query}`));
    assert.deepEqual(s.targets, [fixture.android]);
    return { onlyConfiguredTargetOpened: true };
  });
  for (const unsafe of ['javascript:alert(1)', 'https://user:password@evil.example.test/app', '//evil.example.test/app', '/downloads/local.apk', 'http://downloads.example.test/app']) {
    await run(`unsafe configured destination rejected ${unsafe}`, 'android', { urls: { ios: unsafe, android: unsafe, h5: unsafe } }, async s => {
      await goto(s.page, `${first.route}?platform=auto`); await stateIs(s.page, 'unavailable');
      assert.equal(await s.page.locator('[data-distribution-action]').getAttribute('href'), null);
      assert.equal(await s.page.locator('[data-distribution-action]').getAttribute('aria-disabled'), 'true');
      assert.equal(s.targets.length, 0);
      return { rejected: unsafe };
    });
  }
  await run('copy action writes the same target as the rendered QR', 'desktop', {}, async s => {
    await s.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    await goto(s.page, first.home);
    for (const platform of Object.keys(fixture)) {
      await s.page.locator(`#download [data-download-entry="${platform}"]`).hover();
      await popoverIsOpen(s.page, platform);
      await checkQr(s.page, fixture[platform]);
      await s.page.locator('[data-distribution-copy]').click();
      await s.page.waitForFunction(expected => navigator.clipboard.readText().then(value => value === expected), fixture[platform]);
    }
    return { copiedAndDecoded: Object.keys(fixture) };
  });
  await run('clipboard failure exposes configured target URL', 'desktop', {}, async s => {
    await s.page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('Simulated denied clipboard permission')) } }));
    const locale = locales.find(l => l.locale !== 'en') || first;
    await goto(s.page, locale.home);
    await s.page.locator('#download [data-download-entry="android"]').hover(); await popoverIsOpen(s.page, 'android');
    await s.page.locator('[data-distribution-copy]').click();
    const input = s.page.locator('[data-distribution-link]'); await input.waitFor({ state: 'visible' });
    assert.equal(await input.inputValue(), fixture.android);
    assert(await input.evaluate(el => el === document.activeElement));
    assert(await s.page.locator('[data-copy-status]').innerText());
    return { fallbackURL: await input.inputValue() };
  });
} finally {
  await browser?.close();
  await Promise.all([enabledServer, publishedServer].filter(server => server.listening).map(server => new Promise(resolveClose => server.close(resolveClose))));
  await rm(enabledBuild.directory, { recursive: true, force: true });
  const report = { capability: 'runtime', startedAt: started.toISOString(), finishedAt: new Date().toISOString(), base,
    limitations: ['Real Playwright Chromium browser with simulated user agents; not a physical iOS/Android or embedded-browser device.',
      'Configured positive destinations use intercepted HTTPS fixtures. The APK is intentionally non-installable. Real package availability, signing, installation, and external iOS/H5 service behavior are not verified.'],
    fixtureAddresses: fixture, filter: match?.source || null, generatedLocales: locales,
    builtDocuments: pages.map(({ route, hash }) => ({ route, sha256: hash })),
    summary: { passed: results.filter(r => r.status === 'passed').length, failed: results.filter(r => r.status === 'failed').length }, results };
  const reportPath = join(output, 'report.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Download distribution QA: ${report.summary.passed} passed; ${report.summary.failed} failed; report=${reportPath}`);
  if (!results.length || report.summary.failed) process.exitCode = 1;
}
