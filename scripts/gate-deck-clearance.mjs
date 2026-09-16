/* ── 叠卡编舞几何门(R47.6)──
   守两层(都是 9e24b27 真实翻过的车,主人肉眼抓到,当时十门全绿):
   ① 任一滚动相位下,叠卡不得侵入左栏文字(.gutter .sub)——当时侵入 29-67px;
   ② 卡的定位基必须是全钉屏区宽:computed width/left 相对 .pin 宽 ≈ 45.14% / 27.43%(±1.5pp)
      —— 兜底栅格档的 max-width(1120 轨道 / 520 卡)一旦再漏进编舞档,百分比会按小轨道算,
      ①的相交只是症状,②直接钉住根因(包含块缩水)。
   采样:en+vi × 宽 1440/1920 × 相位 0/.25/.5/.75/1;dist 复用(canvas-geometry 已构建),自起静态服务。
   用法:node scripts/gate-deck-clearance.mjs [--dist <dir>]
   退出码:0 通过 · 2 不合格 · 3 跑不起来 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, extname } from 'node:path';
import { readBuiltPages, homeRoutes, parseRoutesArg, scopeRoutes } from './gate-built-routes.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const argv = process.argv.slice(2);
const di = argv.indexOf('--dist');
const DIST = di >= 0 ? argv[di + 1] : join(ROOT, 'dist');

if (!existsSync(join(DIST, 'index.html'))) {
  console.log(`[deck] NOT-RUN:dist 不存在(${DIST}),先构建`);
  process.exit(3);
}
const scope = scopeRoutes(homeRoutes(readBuiltPages(DIST)), parseRoutesArg(argv));
const HOME = scope.pages;
if (scope.scoped && HOME.length === 0) {
  console.log(`[deck] ✓ 路由裁剪:生成首页无变化,跳过实测(0/${scope.total})`);
  process.exit(0);
}
let chromium;
for (const anchor of [join(ROOT, 'package.json')]) {
  try {
    chromium = createRequire(anchor)('playwright').chromium;
    break;
  } catch {
    /* 下一个锚点 */
  }
}
if (!chromium) {
  console.log('[deck] NOT-RUN:playwright 不可用');
  process.exit(3);
}

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.json': 'application/json', '.xml': 'application/xml', '.ico': 'image/x-icon', '.jpg': 'image/jpeg' };
const server = createServer((req, res) => {
  try {
    const url = decodeURIComponent(req.url.split('?')[0]);
    let p = join(DIST, url);
    if (!extname(p)) p = join(p, 'index.html');
    if (!existsSync(p) || statSync(p).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(readFileSync(p));
  } catch {
    res.writeHead(500).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

const fails = [];
let checked = 0;
const browser = await chromium.launch();
try {
  for (const W of [1440, 1920]) {
    const page = await browser.newPage({ viewport: { width: W, height: 900 } });
    for (const loc of HOME) {
      await page.goto(`http://127.0.0.1:${PORT}${loc}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1200);
      const decked = await page.evaluate(() => {
        const sec = document.getElementById('devices');
        sec?.scrollIntoView();
        return !!sec;
      });
      if (!decked) {
        fails.push(`${W}/${loc || 'en'}:找不到 #devices`);
        continue;
      }
      await page.waitForTimeout(500);
      const on = await page.evaluate(() => document.getElementById('devices').classList.contains('decked'));
      if (!on) {
        fails.push(`${W}/${loc || 'en'}:编舞未挂(decked 缺失)——桌面 fine-pointer 下不该缺`);
        continue;
      }
      for (const ph of [0, 0.25, 0.5, 0.75, 1]) {
        const m = await page.evaluate(async (phase) => {
          const sec = document.getElementById('devices');
          const secTop = sec.getBoundingClientRect().top + scrollY;
          window.scrollTo(0, secTop + (sec.offsetHeight - innerHeight) * phase);
          await new Promise((r) => setTimeout(r, 450));
          const sub = sec.querySelector('.gutter .sub');
          const pin = sec.querySelector('[data-deck-pin]');
          const sr = sub.getBoundingClientRect();
          let worst = 0;
          let ratioW = 0,
            ratioL = 0;
          for (const c of sec.querySelectorAll('[data-deck-card]')) {
            const cr = c.getBoundingClientRect();
            if (cr.top < sr.bottom && cr.bottom > sr.top && cr.left < sr.right && cr.right > sr.left)
              worst = Math.max(worst, Math.min(sr.right, cr.right) - Math.max(sr.left, cr.left));
            const cs = getComputedStyle(c);
            ratioW = parseFloat(cs.width) / pin.offsetWidth;
            ratioL = parseFloat(cs.left) / pin.offsetWidth;
          }
          /* 🔴 判据③(2026-09-01 第十轮独立验收 P0):**分母不能是被守的那个量**。
             ②量的是「卡宽 ÷ pin 自身宽」——pin 一缩,分子分母同比缩,比值纹丝不动,
             于是②对「包含块整体缩水」这件它自称直接钉住的事**完全瞎**
             (实测注入 `.decked .pin{max-width:1120px}`:pin 1905→1482 屏幕像素、卡宽 860→669,
              deck-clearance / canvas-geometry / render-fit **三门全绿**)。
             改用**不会跟着缩的参照**:画布 `.x-canvas` 的宽度由 R42 画布壳固定,
             pin 应当占满它。分母独立于被守物,缩水才藏不住。 */
          const canvas = document.querySelector('.x-canvas');
          const pinOfCanvas = canvas && pin ? pin.offsetWidth / canvas.offsetWidth : null;
          return { worst: +worst.toFixed(1), ratioW: +ratioW.toFixed(4), ratioL: +ratioL.toFixed(4), pinOfCanvas: pinOfCanvas === null ? null : +pinOfCanvas.toFixed(4) };
        }, ph);
        checked++;
        if (m.worst > 1) fails.push(`${W}/${loc || 'en'} 相位 ${ph}:卡侵入左栏文字 ${m.worst}px`);
        /* 取不到参照要报错,不能当成通过——「量不到所以跳过」是假绿制造机 */
        if (m.pinOfCanvas === null) fails.push(`${W}/${loc || 'en'} 相位 ${ph}:量不到 .x-canvas,判据③ 无从判断(门已失效,先修门)`);
        else if (Math.abs(m.pinOfCanvas - 1) > 0.005) fails.push(`${W}/${loc || 'en'} 相位 ${ph}:钉屏区只占画布 ${(m.pinOfCanvas * 100).toFixed(1)}%,应占满 —— 包含块被缩水了(②按 pin 自身归一化,看不见这种)`);
        if (Math.abs(m.ratioW - 0.4514) > 0.015) fails.push(`${W}/${loc || 'en'} 相位 ${ph}:卡宽/钉屏区 = ${(m.ratioW * 100).toFixed(1)}%,应 45.14%(包含块疑似被兜底档 max-width 缩水)`);
        if (Math.abs(m.ratioL - 0.2743) > 0.015) fails.push(`${W}/${loc || 'en'} 相位 ${ph}:卡锚/钉屏区 = ${(m.ratioL * 100).toFixed(1)}%,应 27.43%`);
      }
    }
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}

if (fails.length) {
  for (const f of fails) console.log(`[deck] ✗ ${f}`);
  process.exit(2);
}
console.log(`[deck] ✓ ${checked} 采样(${HOME.length} 个生成首页 × 1440/1920 × 5 相位)全部:零侵入 · 锚 27.43% · 卡宽 45.14%${scope.scoped ? ` · 路由裁剪(${HOME.length}/${scope.total})` : ''}`);
process.exit(0);
