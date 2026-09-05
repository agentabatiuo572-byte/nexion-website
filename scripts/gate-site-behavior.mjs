#!/usr/bin/env node
/* H03/H04 + M11-M15 + L01/L02 前台行为门。
   用真实 SiteConfig 物化器生成隔离变体、Astro 构建到系统临时目录，再由 Chromium 验证运行时。
   不改 src 物化文件、不占固定端口、不接触现有预览服务。 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { buildSeed } from '../worker/build-seed.mjs';
import { materializeAll } from '../schema/src/materialize.ts';
import { validateConfig } from '../schema/src/validators.ts';
import { resolveDownloadUrl } from '../src/lib/download-policy.ts';
import { renderLegalMarkdown } from '../src/lib/legal-markdown.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ASTRO = join(ROOT, 'node_modules', 'astro', 'bin', 'astro.mjs');
const { chromium } = createRequire(import.meta.url)('playwright');
const LOCALES = ['en', 'vi', 'zh'];
let checks = 0;
const failures = [];

function check(label, pass, detail = '') {
  checks++;
  if (!pass) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

function disabledDownloadsStayDisabled({ oldUrls, heroDisabled, finalDisabled, navH5 }) {
  return oldUrls === 0 && heroDisabled === 3 && finalDisabled === 3 && navH5 === 0;
}

function matchesPreciseGrowth(value) {
  return value === '157';
}

function canvasFrameLooksValid(frame) {
  if (!frame || frame.sampled <= 0) return false;
  return frame.background / frame.sampled >= 0.1
    && frame.foreground / frame.sampled >= 0.001
    && frame.colorBuckets >= 2;
}

function canvasFramePreserved(before, after, paused) {
  return paused === 'true' && canvasFrameLooksValid(before) && canvasFrameLooksValid(after);
}

function mobileHeroCopyIsClear(sample) {
  return sample?.canvasActive === true
    && sample.lineCount >= 3
    && sample.flightCount === 14
    && sample.dotCount === 2059
    && sample.shieldLineCount >= 3
    && sample.foregroundRatio >= 0.001
    && sample.worstBrightRatio <= 0.002
    && sample.peakLumaDelta <= 36;
}

function historyDidNotGrow(once, twice) {
  return once === twice;
}

function touchTargetsPass(heights) {
  return heights.length > 0 && heights.every((height) => height >= 43.5);
}

function selfTest() {
  const { config: seed, manifest } = buildSeed();
  const protocolRelative = structuredClone(seed);
  protocolRelative.announcement = {
    id: 'PROTOCOL_RELATIVE',
    enabled: true,
    text: { en: 'Notice', vi: 'Thong bao', zh: '公告' },
    href: '//external.example/path',
    startsAt: '2026-01-01T00:00:00.000Z',
    endsAt: '2027-01-01T00:00:00.000Z',
  };
  const protocolErrors = validateConfig(protocolRelative, manifest).errors;
  const cases = [
    ['三条 FAQ 好样本', ['B', 'C', 'A'].length === 3],
    ['固定十条坏样本被拒', Array.from({ length: 10 }).length !== 3],
    ['十一条不被截断', Array.from({ length: 11 }).length === 11],
    ['Unicode 同 hash 可归一', decodeURIComponent('#1-%E5%AE%89%E8%A3%85'.slice(1)) === '1-安装'],
    ['不同公告 id 不误关闭', 'old-id' !== 'new-id'],
    ['窗口结束点为排他', !(100 >= 0 && 100 < 100)],
    ['关闭下载压过旧环境', disabledDownloadsStayDisabled({ oldUrls: 0, heroDisabled: 3, finalDisabled: 3, navH5: 0 })],
    ['旧环境下载回流样本被拒', !disabledDownloadsStayDisabled({ oldUrls: 1, heroDisabled: 3, finalDisabled: 3, navH5: 0 })],
    ['小数基数正算稳定', matchesPreciseGrowth('157')],
    ['小数基数偏一坏样本被拒', !matchesPreciseGrowth('158')],
    ['下载关闭态压过旧环境', resolveDownloadUrl({ enabled: false, url: '' }, 'https://old.example') === ''],
    ['下载开启态仍可吃环境兜底', resolveDownloadUrl({ enabled: true, url: '' }, 'https://ok.example') === 'https://ok.example'],
    ['Markdown 前置空行后 H1 被提为页标题', renderLegalMarkdown('\n\n# Title\n\nBody').title === 'Title'],
    ['公告协议相对 URL 被校验器拒绝', protocolErrors.some((error) => error.path === 'announcement.href')],
    ['Legal 协议相对 URL 不生成链接', !renderLegalMarkdown('[bad](//external.example/path)').html.includes('<a ')],
    ['Legal 反斜杠路径不生成链接', !renderLegalMarkdown('[bad](/\\external.example/path)').html.includes('<a ')],
    ['粒子静帧好样本', canvasFramePreserved(
      { sampled: 1000, background: 800, foreground: 200, colorBuckets: 3 },
      { sampled: 1000, background: 790, foreground: 210, colorBuckets: 4 },
      'true',
    )],
    ['整面黑画布坏样本被拒', !canvasFramePreserved(
      { sampled: 1000, background: 0, foreground: 1000, colorBuckets: 1 },
      { sampled: 1000, background: 0, foreground: 1000, colorBuckets: 1 },
      'true',
    )],
    ['空背景画布坏样本被拒', !canvasFramePreserved(
      { sampled: 1000, background: 1000, foreground: 0, colorBuckets: 1 },
      { sampled: 1000, background: 1000, foreground: 0, colorBuckets: 1 },
      'true',
    )],
    ['手机 hero 护字好样本', mobileHeroCopyIsClear({
      canvasActive: true, lineCount: 7, flightCount: 14, dotCount: 2059, shieldLineCount: 7, foregroundRatio: 0.02, worstBrightRatio: 0.001, peakLumaDelta: 32,
    })],
    ['手机 hero 亮轨压字坏样本被拒', !mobileHeroCopyIsClear({
      canvasActive: true, lineCount: 7, flightCount: 14, dotCount: 2059, shieldLineCount: 7, foregroundRatio: 0.045, worstBrightRatio: 0.08, peakLumaDelta: 210,
    })],
    ['手机 hero 关闭画布伪修复被拒', !mobileHeroCopyIsClear({
      canvasActive: false, lineCount: 7, flightCount: 0, dotCount: 0, shieldLineCount: 0, foregroundRatio: 0, worstBrightRatio: 0, peakLumaDelta: 0,
    })],
    ['手机 hero 全局降密度伪修复被拒', !mobileHeroCopyIsClear({
      canvasActive: true, lineCount: 7, flightCount: 5, dotCount: 500, shieldLineCount: 7, foregroundRatio: 0.012, worstBrightRatio: 0, peakLumaDelta: 0,
    })],
    ['重复 hash 不增长历史', historyDidNotGrow(7, 7)],
    ['重复 hash 增长坏样本被拒', !historyDidNotGrow(7, 8)],
    ['44px 触达好样本', touchTargetsPass([44, 45.25])],
    ['32px 触达坏样本被拒', !touchTargetsPass([32, 44])],
  ];
  for (const [name, pass] of cases) check(name, pass);
  if (failures.length) {
    failures.forEach((line) => console.error(`[site-behavior:self-test] ✗ ${line}`));
    process.exit(2);
  }
  console.log(`[site-behavior:self-test] ✓ ${checks} pass`);
}

if (process.argv.includes('--self-test')) {
  selfTest();
  process.exit(0);
}

const tempParent = join(ROOT, '.verify-tmp');
mkdirSync(tempParent, { recursive: true });
/* Astro Windows 构建会从仓内 .astro 用 rename 搬资产，outDir 必须与仓库同卷。 */
const tempRoot = mkdtempSync(join(tempParent, 'site-behavior-'));
let browser;
const servers = [];

const faqItem = (id, sort, visible = true, deleted = false) => ({
  id,
  q: Object.fromEntries(LOCALES.map((locale) => [locale, `FAQ_${id}_${locale}`])),
  a: Object.fromEntries(LOCALES.map((locale) => [locale, `ANSWER_${id}_${locale}`])),
  sort,
  visible,
  ...(deleted ? { deleted: true } : {}),
});

function writeFixture(dir, materialized) {
  mkdirSync(dir, { recursive: true });
  for (const locale of LOCALES) writeFileSync(join(dir, `${locale}.json`), materialized.i18n[locale]);
  writeFileSync(join(dir, 'site.json'), materialized.siteJson);
}

function buildVariant(name, config, manifest) {
  const fixtureDir = join(tempRoot, `${name}-fixture`);
  const outDir = join(tempRoot, `${name}-dist`);
  writeFixture(fixtureDir, materializeAll(config, manifest));
  const run = spawnSync(process.execPath, [ASTRO, 'build', '--outDir', outDir], {
    cwd: ROOT,
    env: {
      ...process.env,
      NEXGRID_SITE_FIXTURE_DIR: fixtureDir,
      PUBLIC_IOS_URL: 'https://example.com/OLD_IOS_ENV',
      PUBLIC_ANDROID_URL: 'https://example.com/OLD_ANDROID_ENV',
      PUBLIC_H5_URL: 'https://example.com/OLD_H5_ENV',
    },
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (run.status !== 0) {
    const tail = `${run.stdout || ''}\n${run.stderr || ''}`.trim().split('\n').slice(-30).join('\n');
    throw new Error(`${name} 变体构建失败(exit ${run.status})\n${tail}`);
  }
  return outDir;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

async function serve(dist) {
  const root = resolve(dist);
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      let pathname = decodeURIComponent(url.pathname);
      let file = resolve(root, `.${pathname}`);
      if (!file.startsWith(root + sep) && file !== root) throw new Error('path traversal');
      if (pathname.endsWith('/')) file = join(file, 'index.html');
      else if ((!existsSync(file) || statSync(file).isDirectory()) && !extname(pathname)) file = join(file, 'index.html');
      if (!existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(readFileSync(file));
    } catch {
      res.writeHead(400).end('bad request');
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  servers.push(server);
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

const pagePath = (locale, path) => `${locale === 'en' ? '' : `/${locale}`}${path}`;
const htmlPath = (dist, locale, path) => {
  const route = pagePath(locale, path).replace(/^\//, '').replace(/\/$/, '');
  return join(dist, route, 'index.html');
};

async function faqData(page) {
  const labels = await page.locator('#faq details .q').allTextContents();
  const scripts = await page.locator('script[type="application/ld+json"]').allTextContents();
  const json = scripts.map((text) => {
    try { return JSON.parse(text); } catch { return null; }
  }).find((value) => value?.['@type'] === 'FAQPage');
  return { labels, json };
}

function sampleCanvas(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('x-bg');
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !canvas.width || !canvas.height) {
      return { sampled: 0, background: 0, foreground: 0, colorBuckets: 0 };
    }
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let sampled = 0;
    let background = 0;
    const buckets = new Set();
    for (let i = 0; i < data.length; i += 64) {
      sampled++;
      const red = data[i];
      const green = data[i + 1];
      const blue = data[i + 2];
      if (red === 12 && green === 12 && blue === 13) background++;
      buckets.add(`${red >> 4},${green >> 4},${blue >> 4}`);
    }
    return { sampled, background, foreground: sampled - background, colorBuckets: buckets.size };
  });
}

function sampleMobileHeroCopy(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('x-bg');
    const ctx = canvas?.getContext('2d');
    const canvasRect = canvas?.getBoundingClientRect();
    if (!canvas || !ctx || !canvasRect || !canvas.width || !canvas.height || !canvasRect.width || !canvasRect.height) {
      return { canvasActive: false, lineCount: 0, flightCount: 0, dotCount: 0, shieldLineCount: 0, foregroundRatio: 0, worstBrightRatio: 1, peakLumaDelta: 255 };
    }

    const colorProbe = document.createElement('span');
    colorProbe.style.color = 'var(--x-bg)';
    document.body.append(colorProbe);
    const rgb = getComputedStyle(colorProbe).color.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [12, 12, 13];
    colorProbe.remove();
    const bgLuma = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    const scaleX = canvas.width / canvasRect.width;
    const scaleY = canvas.height / canvasRect.height;
    let foreground = 0;
    let fieldSamples = 0;
    for (let y = 0; y < canvas.height; y += 8) {
      for (let x = 0; x < canvas.width; x += 8) {
        const pixel = ctx.getImageData(x, y, 1, 1).data;
        const delta = Math.max(Math.abs(pixel[0] - rgb[0]), Math.abs(pixel[1] - rgb[1]), Math.abs(pixel[2] - rgb[2]));
        if (delta >= 12) foreground++;
        fieldSamples++;
      }
    }

    let lineCount = 0;
    let worstBrightRatio = 0;
    let peakLuma = bgLuma;
    for (const element of document.querySelectorAll('.hero h1, .hero .sub, .hero .sub2')) {
      const revealLines = [...element.querySelectorAll(':scope > .lr-line')];
      const rects = revealLines.length
        ? revealLines.map((line) => {
            const box = line.getBoundingClientRect();
            const inner = line.querySelector('.lr-inner');
            if (!inner) return box;
            const range = document.createRange();
            range.selectNodeContents(inner);
            const ink = [...range.getClientRects()].filter((rect) => rect.width > 0);
            return ink.length ? {
              left: Math.min(...ink.map((rect) => rect.left)),
              right: Math.max(...ink.map((rect) => rect.right)),
              top: Math.min(...ink.map((rect) => rect.top)),
              bottom: Math.max(...ink.map((rect) => rect.bottom)),
              width: Math.max(...ink.map((rect) => rect.right)) - Math.min(...ink.map((rect) => rect.left)),
              height: Math.max(...ink.map((rect) => rect.bottom)) - Math.min(...ink.map((rect) => rect.top)),
            } : box;
          })
        : (() => {
            const range = document.createRange();
            range.selectNodeContents(element);
            return [...range.getClientRects()];
          })();
      for (const rect of rects) {
        if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.top >= innerHeight) continue;
        const x0 = Math.max(0, Math.floor((rect.left - canvasRect.left) * scaleX));
        const y0 = Math.max(0, Math.floor((rect.top - canvasRect.top) * scaleY));
        const x1 = Math.min(canvas.width, Math.ceil((rect.right - canvasRect.left) * scaleX));
        const y1 = Math.min(canvas.height, Math.ceil((rect.bottom - canvasRect.top) * scaleY));
        if (x1 <= x0 || y1 <= y0) continue;
        const data = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
        let bright = 0;
        for (let index = 0; index < data.length; index += 4) {
          const luma = 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
          if (luma - bgLuma > 36) bright++;
          peakLuma = Math.max(peakLuma, luma);
        }
        lineCount++;
        worstBrightRatio = Math.max(worstBrightRatio, bright / (data.length / 4));
      }
    }
    return {
      canvasActive: Number(window.__xbg?.renders) > 2,
      lineCount,
      flightCount: Number(window.__xbg?.fl) || 0,
      dotCount: Number(window.__xbg?.dots) || 0,
      shieldLineCount: Number(window.__xbg?.shieldLines) || 0,
      foregroundRatio: fieldSamples ? foreground / fieldSamples : 0,
      worstBrightRatio,
      peakLumaDelta: peakLuma - bgLuma,
    };
  });
}

try {
  const { config: seed, manifest } = buildSeed();
  const core = structuredClone(seed);
  core.faq.items = [
    faqItem('A', 30),
    faqItem('HIDDEN', 0, false),
    faqItem('C', 20),
    faqItem('DELETED', 5, true, true),
    faqItem('B', 10),
  ];
  core.downloads = {
    ios: { enabled: false, url: '' },
    android: { enabled: false, url: '' },
    h5: { enabled: false, url: '' },
  };
  core.stats = {
    activeDevices: 28_432,
    activeJobs: 4_812,
    nodes: 156,
    countries: 47,
    uptime: 99.7,
    asOf: '2026-09',
    growth: {
      enabled: true,
      since: '2026-09-01',
      daily: { activeDevices: 24, activeJobs: 5, nodes: 0.2, countries: 1 },
    },
  };
  core.announcement = {
    id: 'ANNOUNCEMENT_NEW_ID',
    enabled: true,
    text: Object.fromEntries(LOCALES.map((locale) => [locale, `ANNOUNCEMENT_${locale}`])),
    href: '/learn/',
    startsAt: '2020-01-01T00:00:00.000Z',
    endsAt: '2099-01-01T00:00:00.000Z',
  };
  for (const [pageId, value] of Object.entries(core.seo.pages)) {
    value.title = Object.fromEntries(LOCALES.map((locale) => [locale, `SEO_TITLE_${pageId}_${locale}`]));
    value.description = Object.fromEntries(LOCALES.map((locale) => [locale, `SEO_DESC_${pageId}_${locale}`]));
  }
  core.footer = {
    contactEmail: 'site-gate@example.com',
    social: [
      { id: 'audit-social', url: 'https://example.com/SOCIAL_CANARY', enabled: true },
      { id: 'hidden-social', url: 'https://example.com/HIDDEN_SOCIAL', enabled: false },
    ],
  };
  core.legal = {
    terms: {
      md: {
        en: '\n\n# TERMS_EN_CANARY\n\n## Clause\n\nEnglish terms.',
        vi: '',
        zh: '\n# TERMS_ZH_CANARY\n\n## 条款\n\n中文条款。',
      },
      updatedAt: '2099-01-02',
    },
    privacy: {
      md: Object.fromEntries(LOCALES.map((locale) => [locale, `# PRIVACY_${locale}_CANARY\n\n## Scope\n\nPrivacy ${locale}.`])),
      updatedAt: '2099-02-03',
    },
    appPrivacy: {
      md: Object.fromEntries(LOCALES.map((locale) => [locale, `# APP_PRIVACY_${locale}_CANARY\n\n## Data\n\n**Strong** [safe](https://example.com/) <script>bad()</script> [bad](javascript:bad())`])),
      updatedAt: '2099-03-04',
    },
  };

  const eleven = structuredClone(core);
  eleven.faq.items = Array.from({ length: 11 }, (_, index) => faqItem(`ELEVEN_${index + 1}`, index + 1));
  eleven.announcement.enabled = false;

  const coreDist = buildVariant('core', core, manifest);
  const elevenDist = buildVariant('eleven', eleven, manifest);
  const coreUrl = await serve(coreDist);
  const elevenUrl = await serve(elevenDist);
  browser = await chromium.launch({ headless: true });

  const staticContext = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1280, height: 800 } });
  const page = await staticContext.newPage();
  for (const locale of LOCALES) {
    await page.goto(`${coreUrl}${pagePath(locale, '/')}`, { waitUntil: 'domcontentloaded' });
    const three = await faqData(page);
    check(`H04 ${locale} 三条 FAQ`, three.labels.length === 3, `实际 ${three.labels.length}`);
    check(`H04 ${locale} 隐藏/删除/排序`, three.labels.join('|') === `FAQ_B_${locale}|FAQ_C_${locale}|FAQ_A_${locale}`, three.labels.join('|'));
    check(`H04 ${locale} JSON-LD 同源`, three.json?.mainEntity?.length === 3 && three.json.mainEntity[0]?.name === `FAQ_B_${locale}`);

    await page.goto(`${elevenUrl}${pagePath(locale, '/')}`, { waitUntil: 'domcontentloaded' });
    const elevenFaq = await faqData(page);
    check(`H04 ${locale} 十一条不截断`, elevenFaq.labels.length === 11 && elevenFaq.json?.mainEntity?.length === 11, `DOM=${elevenFaq.labels.length}`);
  }

  /* L01 的 hash 展开/聚焦是信息导航，不得被初始 reduced-motion 连带关闭。 */
  for (const locale of LOCALES) {
    await page.goto(`${coreUrl}${pagePath(locale, '/')}`, { waitUntil: 'domcontentloaded' });
    const refs = page.locator('#why .ink-ref a[href^="#why-src-"]');
    const refCount = await refs.count();
    check(`L01 ${locale} 初始 reduce 引注数量`, refCount === 6, `实际 ${refCount}`);
    for (let index = 0; index < refCount; index++) {
      const ref = refs.nth(index);
      const refId = (await ref.getAttribute('href'))?.slice(1) ?? '';
      await page.evaluate((id) => {
        const details = document.getElementById(id)?.closest('details');
        if (details) details.open = false;
      }, refId);
      await ref.click();
      await page.waitForTimeout(20);
      const state = await page.evaluate((id) => ({
        active: document.activeElement?.id,
        open: document.getElementById(id)?.closest('details')?.open,
      }), refId);
      check(`L01 ${locale} 初始 reduce 引注 ${index + 1}`, state.active === refId && state.open === true, JSON.stringify(state));
    }
    const bgState = await page.locator('[data-bg-toggle]').evaluate((button) => ({
      pressed: button.getAttribute('aria-pressed'),
      disabled: button.disabled,
      label: button.textContent?.trim(),
      expected: button.dataset.labelReduced,
    }));
    check(
      `M15 ${locale} 初始 reduce 背景状态讲真话`,
      bgState.pressed === 'true' && bgState.disabled && bgState.label === bgState.expected,
      JSON.stringify(bgState),
    );
  }

  const seoRoutes = {
    home: '/',
    learn: '/learn/',
    nex: '/nex/',
    'legal-privacy': '/legal/privacy/',
    'legal-terms': '/legal/terms/',
    'legal-app-privacy': '/legal/app-privacy/',
  };
  for (const locale of LOCALES) {
    for (const [pageId, route] of Object.entries(seoRoutes)) {
      const html = readFileSync(htmlPath(coreDist, locale, route), 'utf8');
      check(`H03 SEO ${pageId}/${locale} title`, html.includes(`SEO_TITLE_${pageId}_${locale}`));
      check(`H03 SEO ${pageId}/${locale} description`, html.includes(`SEO_DESC_${pageId}_${locale}`));
    }
  }

  await page.goto(`${coreUrl}/`, { waitUntil: 'domcontentloaded' });
  const announcement = page.locator('#x-announcement');
  check('H03 公告窗口内显示', await announcement.isVisible());
  check('H03 公告使用当前语言', (await announcement.textContent())?.includes('ANNOUNCEMENT_en'));
  await page.locator('[data-announcement-close]').click();
  await page.goto(`${coreUrl}/learn/`, { waitUntil: 'domcontentloaded' });
  check('H03 公告同会话关闭记忆', await page.locator('#x-announcement').isHidden());
  await page.evaluate(() => sessionStorage.setItem('x-announcement-dismissed', 'OLDER_ANNOUNCEMENT_ID'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  check('H03 新公告 id 重新显示', await page.locator('#x-announcement').isVisible());

  for (const locale of LOCALES) {
    await page.goto(`${coreUrl}${pagePath(locale, '/')}`, { waitUntil: 'domcontentloaded' });
    check(`H03 footer 邮箱 ${locale}`, (await page.locator('footer a[href="mailto:site-gate@example.com"]').count()) >= 1);
    check(`H03 footer 社媒 ${locale}`, (await page.locator('footer a[href="https://example.com/SOCIAL_CANARY"]').count()) === 1);
    check(`H03 footer 禁用社媒 ${locale}`, (await page.locator('footer a[href="https://example.com/HIDDEN_SOCIAL_CANARY"]').count()) === 0);
  }

  const legalExpected = {
    terms: { path: '/legal/terms/', date: '2099-01-02', en: 'TERMS_EN_CANARY', vi: 'TERMS_EN_CANARY', zh: 'TERMS_ZH_CANARY' },
    privacy: { path: '/legal/privacy/', date: '2099-02-03', en: 'PRIVACY_en_CANARY', vi: 'PRIVACY_vi_CANARY', zh: 'PRIVACY_zh_CANARY' },
    appPrivacy: { path: '/legal/app-privacy/', date: '2099-03-04', en: 'APP_PRIVACY_en_CANARY', vi: 'APP_PRIVACY_vi_CANARY', zh: 'APP_PRIVACY_zh_CANARY' },
  };
  for (const [doc, expected] of Object.entries(legalExpected)) {
    for (const locale of LOCALES) {
      await page.goto(`${coreUrl}${pagePath(locale, expected.path)}`, { waitUntil: 'domcontentloaded' });
      const root = page.locator('main.legal');
      check(`H03 Legal ${doc}/${locale} 正文`, (await root.locator('h1').textContent())?.trim() === expected[locale]);
      check(`H03 Legal ${doc}/${locale} updatedAt`, (await root.locator('time').getAttribute('datetime')) === expected.date);
      if (doc === 'terms' && locale === 'vi') check('H03 Legal 英文兜底提示', (await root.locator('.prevails').count()) === 1);
    }
  }
  await page.goto(`${coreUrl}/legal/app-privacy/`, { waitUntil: 'domcontentloaded' });
  check('H03 Legal 原始 HTML 不执行', (await page.locator('main.legal script').count()) === 0 && (await page.evaluate(() => window.bad)) === undefined);
  check('H03 Legal javascript 链接不生成', (await page.locator('main.legal a[href^="javascript:"]').count()) === 0);

  await page.goto(`${coreUrl}/`, { waitUntil: 'domcontentloaded' });
  const oldUrls = await page.locator('a[href*="OLD_"]').count();
  const heroDisabled = await page.locator('#download .dl button[aria-disabled="true"]').count();
  const finalDisabled = await page.locator('#final-cta .dl button[aria-disabled="true"]').count();
  const navH5 = await page.locator('#site-nav .h5').count();
  check(
    'M11 disabled 压过旧 PUBLIC_URL',
    disabledDownloadsStayDisabled({ oldUrls, heroDisabled, finalDisabled, navH5 }),
    `旧链=${oldUrls}, hero禁用=${heroDisabled}, final禁用=${finalDisabled}, navH5=${navH5}`,
  );

  const expiredContext = await browser.newContext({ reducedMotion: 'reduce' });
  await expiredContext.addInitScript(() => { Date.now = () => Date.parse('2100-01-01T00:00:00Z'); });
  const expiredPage = await expiredContext.newPage();
  await expiredPage.goto(`${coreUrl}/`, { waitUntil: 'domcontentloaded' });
  check('H03 公告窗口外隐藏', await expiredPage.locator('#x-announcement').isHidden());
  await expiredContext.close();

  const futureContext = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1280, height: 800 } });
  await futureContext.addInitScript(() => { Date.now = () => Date.parse('2026-09-08T12:00:00Z'); });
  const futurePage = await futureContext.newPage();
  await futurePage.goto(`${coreUrl}/`, { waitUntil: 'domcontentloaded' });
  const nodeValue = await futurePage.locator('#stats .num[data-key="nodes"]').getAttribute('data-target');
  check('M12 小数日增量从精确基数正算', matchesPreciseGrowth(nodeValue), `实际 ${nodeValue}`);
  const devicesValue = await futurePage.locator('#stats .num[data-key="activeDevices"]').getAttribute('data-target');
  const socialText = (await futurePage.locator('#social h2').textContent()) || '';
  check('M13 数字条与社证跨日同步', devicesValue === '28600' && socialText.includes('28,600') && socialText.includes('54'), `${devicesValue} / ${socialText}`);
  await futureContext.close();

  /* M16 保留真实动态 canvas，在独立复核复现的 390×844 稳定态逐行取样。
     同时看全画布前景占比，避免通过关 canvas / 清空粒子得到假绿。 */
  const mobileCanvasContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    reducedMotion: 'no-preference',
  });
  const mobileCanvasPage = await mobileCanvasContext.newPage();
  for (const locale of LOCALES) {
    await mobileCanvasPage.goto(`${coreUrl}${pagePath(locale, '/')}`, { waitUntil: 'networkidle' });
    await mobileCanvasPage.evaluate(() => document.fonts.ready);
    await mobileCanvasPage.waitForFunction(() => Number(window.__xbg?.renders) > 2);
    await mobileCanvasPage.waitForFunction(() => performance.now() >= 900);
    const openingSample = await sampleMobileHeroCopy(mobileCanvasPage);
    check(`M16 ${locale} 手机 hero 开场文字区无亮粒子压字`, mobileHeroCopyIsClear(openingSample), JSON.stringify(openingSample));
    await mobileCanvasPage.waitForFunction(() => performance.now() >= 3400);
    for (let frame = 1; frame <= 3; frame++) {
      const sample = await sampleMobileHeroCopy(mobileCanvasPage);
      check(`M16 ${locale} 手机 hero 稳定态 ${frame}/3 无亮粒子压字`, mobileHeroCopyIsClear(sample), JSON.stringify(sample));
      await mobileCanvasPage.waitForTimeout(120);
    }
  }
  await mobileCanvasContext.close();

  const pauseContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const pausePage = await pauseContext.newPage();
  await pausePage.goto(`${coreUrl}/`, { waitUntil: 'domcontentloaded' });
  await pausePage.waitForFunction(() => window.__xbg?.renders > 2);
  const desktopParticleModel = await pausePage.evaluate(() => ({
    flights: window.__xbg?.fl,
    dots: window.__xbg?.dots,
    shieldLines: window.__xbg?.shieldLines,
  }));
  check(
    'M16 桌面粒子密度原样且不启用护字区',
    desktopParticleModel.flights === 36 && desktopParticleModel.dots === 4118 && desktopParticleModel.shieldLines === 0,
    JSON.stringify(desktopParticleModel),
  );
  await pausePage.locator('[data-bg-toggle]').click();
  await pausePage.waitForTimeout(100);
  const beforeResize = await sampleCanvas(pausePage);
  await pausePage.setViewportSize({ width: 1180, height: 760 });
  await pausePage.waitForTimeout(250);
  const afterResize = await sampleCanvas(pausePage);
  const paused = await pausePage.locator('[data-bg-toggle]').getAttribute('aria-pressed');
  check(
    'M14 暂停后 resize 保留有背景和轨迹的静帧',
    canvasFramePreserved(beforeResize, afterResize, paused),
    `${JSON.stringify(beforeResize)} → ${JSON.stringify(afterResize)}, paused=${paused}`,
  );
  await pauseContext.close();

  /* M15 另开全新 context，避免用脚本伪造 M14 按钮的内部状态后得到假绿。 */
  const motionContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const motionPage = await motionContext.newPage();
  await motionPage.goto(`${coreUrl}/`, { waitUntil: 'domcontentloaded' });
  await motionPage.waitForFunction(() => window.__xbg?.renders > 2);
  await motionPage.waitForFunction(() => document.querySelector('#devices')?.classList.contains('decked'));
  await motionPage.emulateMedia({ reducedMotion: 'reduce' });
  await motionPage.waitForFunction(() => matchMedia('(prefers-reduced-motion: reduce)').matches && !document.querySelector('#devices')?.classList.contains('decked'));
  await motionPage.waitForTimeout(100);
  const renderA = await motionPage.evaluate(() => window.__xbg?.renders);
  await motionPage.waitForTimeout(350);
  const renderB = await motionPage.evaluate(() => window.__xbg?.renders);
  const parallaxClear = await motionPage.locator('[data-plx]').evaluateAll((els) => els.every((el) => !el.style.transform));
  const reducedState = await motionPage.evaluate(() => ({
    splitLines: document.querySelectorAll('.lr-line').length,
    typing: document.querySelectorAll('.tw').length,
    hiddenReveals: [...document.querySelectorAll('[data-rv]')].filter((el) => !el.classList.contains('in')).length,
    nodeText: document.querySelector('#stats .num[data-key="nodes"]')?.textContent?.trim(),
    nodeTarget: document.querySelector('#stats .num[data-key="nodes"]')?.getAttribute('data-target'),
  }));
  check(
    'M15 运行中 reduce 停全部 JS 动效并直显终态',
    renderA === renderB && parallaxClear && reducedState.splitLines === 0 && reducedState.typing === 0
      && reducedState.hiddenReveals === 0 && reducedState.nodeText === reducedState.nodeTarget,
    `renders ${renderA} → ${renderB}; ${JSON.stringify(reducedState)}`,
  );

  await motionPage.emulateMedia({ reducedMotion: 'no-preference' });
  await motionPage.waitForFunction(() => document.querySelector('#devices')?.classList.contains('decked'));
  const firstRef = motionPage.locator('#why .ink-ref a[href^="#why-src-"]').first();
  const refId = (await firstRef.getAttribute('href')).slice(1);
  await firstRef.click();
  await motionPage.waitForTimeout(80);
  const focusState = await motionPage.evaluate((id) => ({ active: document.activeElement?.id, open: document.getElementById(id)?.closest('details')?.open }), refId);
  check('L01 引注展开后焦点落到来源', focusState.active === refId && focusState.open === true, JSON.stringify(focusState));

  for (const locale of ['vi', 'zh']) {
    await motionPage.goto(`${coreUrl}/${locale}/learn/getting-started/`, { waitUntil: 'domcontentloaded' });
    const toc = motionPage.locator('.toc a[href^="#"]').first();
    await toc.click();
    await motionPage.waitForTimeout(30);
    const once = await motionPage.evaluate(() => history.length);
    await toc.click();
    await motionPage.waitForTimeout(30);
    const twice = await motionPage.evaluate(() => history.length);
    check(`L02 ${locale} 同 Unicode hash 不重复压历史`, historyDidNotGrow(once, twice), `${once} → ${twice}`);
  }
  await motionContext.close();

  /* 三类审查实测失败的点击件，锁住三语与窄/桌面两档的 44px 触达高度。 */
  const touchContext = await browser.newContext({ reducedMotion: 'reduce' });
  const touchPage = await touchContext.newPage();
  for (const width of [390, 1440]) {
    await touchPage.setViewportSize({ width, height: 900 });
    for (const locale of LOCALES) {
      await touchPage.goto(`${coreUrl}${pagePath(locale, '/')}`, { waitUntil: 'domcontentloaded' });
      await touchPage.evaluate(() => document.fonts.ready);
      const heights = await touchPage.evaluate(() => {
        const collect = (selector) => [...document.querySelectorAll(selector)]
          .filter((element) => {
            const style = getComputedStyle(element);
            return style.display !== 'none' && style.visibility !== 'hidden';
          })
          .map((element) => element.getBoundingClientRect().height);
        return {
          footerToggle: collect('[data-bg-toggle]'),
          trustCta: collect('#trust a.vcta'),
          announcementLink: collect('#x-announcement a.message'),
        };
      });
      for (const [kind, values] of Object.entries(heights)) {
        check(`触达 ${locale}/${width} ${kind} ≥44px`, touchTargetsPass(values), JSON.stringify(values));
      }
    }
  }

  /* 键盘焦点的 outline 也必须完整落在手机视口内。 */
  await touchPage.setViewportSize({ width: 390, height: 844 });
  await touchPage.goto(`${coreUrl}/`, { waitUntil: 'domcontentloaded' });
  await touchPage.keyboard.press('Tab');
  const browseAll = touchPage.locator('.learn-entry .more .xbtn');
  await browseAll.focus();
  await touchPage.waitForTimeout(50);
  const focusFit = await browseAll.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const outlineWidth = Number.parseFloat(style.outlineWidth) || 0;
    const outlineOffset = Number.parseFloat(style.outlineOffset) || 0;
    const extent = Math.max(0, outlineWidth + outlineOffset);
    return {
      top: rect.top,
      bottom: rect.bottom,
      viewport: innerHeight,
      extent,
      pass: rect.top - extent >= -0.5 && rect.bottom + extent <= innerHeight + 0.5,
    };
  });
  check('手机 Browse all guides 键盘焦点环完整可见', focusFit.pass, JSON.stringify(focusFit));
  await touchContext.close();
  await staticContext.close();
} catch (error) {
  failures.push(error instanceof Error ? error.stack || error.message : String(error));
} finally {
  if (browser) await browser.close().catch(() => undefined);
  await Promise.all(servers.map((server) => new Promise((done) => server.close(done))));
  rmSync(tempRoot, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`[site-behavior] ✗ ${failures.length} failure(s) / ${checks} checks`);
  failures.forEach((failure) => console.error(`  - ${failure}`));
  process.exit(2);
}
console.log(`[site-behavior] ✓ ${checks} checks pass`);
