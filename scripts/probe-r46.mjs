/* R46 逐条落地探针:只跑本轮四项改动的运行时判据,不替代 verify 门链。
   A4 字距归档 · B1 开场拍序(含慢字体) · C1 断点连续 · C2 手机灯箱适宽
   用法:node scripts/probe-r46.mjs          (自带静态服务伺服 dist,不与 astro preview 抢单例) */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
const require = createRequire('D:/WORKS/PLAN/Nexion-uniapp/package.json');
const { chromium } = require('playwright');

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const DIST = join(ROOT, 'dist');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};
const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent((req.url || '/').split('?')[0]);
    let file = join(DIST, p);
    const st = await stat(file).catch(() => null);
    if (!st || st.isDirectory()) file = join(DIST, p, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

const LANGS = [['en', '/'], ['vi', '/vi/'], ['zh', '/zh/']];
const rows = [];
const ok = (name, pass, detail) => rows.push({ name, pass, detail });

/* ── C1:视口变窄时字号不许变大(本站唯一的反向跳变) ── */
{
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  for (const [lang, route] of LANGS) {
    await page.goto(BASE + route, { waitUntil: 'load' });
    const series = [];
    for (const w of [390, 544, 546, 700, 859, 860, 861, 900, 1024, 1440]) {
      await page.setViewportSize({ width: w, height: 900 });
      const px = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.hero h1')).fontSize));
      series.push([w, Number(px.toFixed(2))]);
    }
    let bad = null;
    for (let i = 1; i < series.length; i++) {
      if (series[i][1] < series[i - 1][1] - 0.01) bad = `${series[i - 1][0]}px→${series[i][0]}px 反而变大: ${series[i - 1][1]}→${series[i][1]}`;
    }
    ok(`C1 ${lang} 宽度单调(不出现「更窄反而更大」)`, !bad, bad || series.map((s) => s.join('=')).join('  '));
    const a = series.find((s) => s[0] === 860)[1];
    const b = series.find((s) => s[0] === 861)[1];
    const jump = Math.abs(b - a) / Math.min(a, b);
    ok(`C1 ${lang} 860/861 跨度 ≤10%`, jump <= 0.1, `${a} → ${b} = ${(jump * 100).toFixed(1)}%`);
  }
  await ctx.close();
}

/* ── C1b:521/520 边界只许变小(矮视口压缩是对的,变大才是 bug) ── */
{
  const ctx = await browser.newContext({ viewport: { width: 860, height: 900 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  for (const [lang, route] of LANGS) {
    await page.goto(BASE + route, { waitUntil: 'load' });
    const m = {};
    for (const h of [521, 520]) {
      await page.setViewportSize({ width: 860, height: h });
      m[h] = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.hero h1')).fontSize));
    }
    const d = ((m[520] - m[521]) / m[521]) * 100;
    ok(`C1b ${lang} 860×521→520 只降不升`, m[520] <= m[521] + 0.01, `${m[521].toFixed(1)} → ${m[520].toFixed(1)} (${d.toFixed(1)}%)`);
  }
  await ctx.close();
}

/* ── B1:开场拍序 + 首屏到齐时刻(不吃 reduced-motion 豁免) ── */
const revealProbe = () =>
  new Promise((res) => {
    const h1 = document.querySelector('.hero h1');
    const sub = document.querySelector('.hero .sub');
    const t0 = performance.now();
    let start = -1;
    const tick = () => {
      // 起滑:遮罩已建且内层已挂 .in
      if (start < 0 && h1.querySelector('.in')) start = performance.now() - t0;
      // 完成:fx 播完把宿主还原成纯文本(children 清空)
      const done = h1.classList.contains('lr-ready') && h1.children.length === 0;
      if (done) {
        return res({ start, done: performance.now() - t0, subDelay: parseFloat(getComputedStyle(sub).animationDelay) * 1000 });
      }
      if (performance.now() - t0 > 6000) return res({ start, done: -1, subDelay: parseFloat(getComputedStyle(sub).animationDelay) * 1000 });
      requestAnimationFrame(tick);
    };
    tick();
  });

{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  for (const [lang, route] of LANGS) {
    await page.goto(BASE + route, { waitUntil: 'commit' });
    const t = await page.evaluate(revealProbe);
    const beats = await page.evaluate(() => {
      const d = (sel) => parseFloat(getComputedStyle(document.querySelector(sel)).animationDelay) || 0;
      return { boot: document.documentElement.classList.contains('x-boot'), nav: d('.site-nav'), sub: d('.hero .sub'), dl: d('.hero .dl-wrap') };
    });
    ok(`B1 ${lang} 开场仍按序(导航拍 ≤ 标题拍 ≤ 副题拍,副题与下载键同拍)`,
      beats.boot && beats.nav <= 0.2 && 0.2 <= beats.sub && beats.sub === beats.dl,
      `导航 ${beats.nav}s · 标题 0.2s · 副题 ${beats.sub}s · 下载键 ${beats.dl}s`);
    ok(`B1 ${lang} 首屏内容到齐 ≤1.1s`, beats.sub + 0.5 <= 1.1, `副题拍 ${beats.sub}s + 0.5s 时长 = ${(beats.sub + 0.5).toFixed(2)}s`);
    ok(`B1 ${lang} 标题起滑早于副题拍`, t.start >= 0 && t.start < t.subDelay, `起滑 ${t.start.toFixed(0)}ms < 副题拍 ${t.subDelay.toFixed(0)}ms`);
    ok(`B1 ${lang} 标题揭幕完成 <1.5s(旧的 900ms 固定成本已消失)`, t.done >= 0 && t.done < 1500, `${t.done.toFixed(0)}ms`);
  }
  await ctx.close();
}

/* ── B1b:字体慢到货时,标题仍先于副题(兜底 400ms 必须小于副题拍) ── */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route('**/*.woff2', async (r) => {
    await new Promise((res) => setTimeout(res, 2000));
    await r.continue();
  });
  const page = await ctx.newPage();
  for (const [lang, route] of LANGS) {
    await page.goto(BASE + route, { waitUntil: 'commit' });
    const t = await page.evaluate(revealProbe);
    ok(`B1b ${lang} 字体延迟 2s 时标题仍先于副题`, t.start >= 0 && t.start < t.subDelay,
      `起滑 ${t.start.toFixed(0)}ms < 副题拍 ${t.subDelay.toFixed(0)}ms`);
  }
  await ctx.close();
}

/* ── C2:手机灯箱整张适宽,无横向平移 ── */
{
  for (const [lang, route] of LANGS) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto(BASE + route, { waitUntil: 'load' });
    const r = await page.evaluate(async () => {
      const a = document.querySelector('.cert-open');
      if (!a) return { err: 'no .cert-open' };
      a.scrollIntoView();
      a.click();
      await new Promise((res) => setTimeout(res, 900));
      const dlg = document.querySelector('.cert-zoom');
      const img = dlg && dlg.querySelector('img');
      if (!dlg || !dlg.open || !img) return { err: 'dialog not open' };
      const b = img.getBoundingClientRect();
      return {
        dlgW: dlg.clientWidth, dlgScrollW: dlg.scrollWidth,
        imgW: Math.round(b.width), imgH: Math.round(b.height),
        vw: innerWidth, vh: innerHeight,
        src: (img.currentSrc || '').split('/').pop(),
      };
    });
    ok(`C2 ${lang} 灯箱无横向平移(scrollWidth ≤ clientWidth)`, !r.err && r.dlgScrollW <= r.dlgW + 1, JSON.stringify(r));
    ok(`C2 ${lang} 整张一屏可见(图高 + 关闭行 ≤ 视口高)`, !r.err && r.imgH + 70 <= r.vh, r.err || `图 ${r.imgW}×${r.imgH} / 视口高 ${r.vh}`);
    ok(`C2 ${lang} 仍取 @2x 原件(放大不糊)`, !r.err && /2x/.test(r.src || ''), r.err || String(r.src));
    await ctx.close();
  }
}

/* ── A4:三处字距归档到 -0.02em ── */
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  for (const [route, sel, label] of [
    ['/', '.name', 'MissionSection .name'],
    ['/nex/', '.list b', 'NexContent .list b'],
    ['/nex/', '.mcard h3', 'NexContent .mcard h3'],
  ]) {
    await page.goto(BASE + route, { waitUntil: 'load' });
    const r = await page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { ls: parseFloat(cs.letterSpacing), fs: parseFloat(cs.fontSize) };
    }, sel);
    ok(`A4 ${label} = -0.02em`, !!r && Math.abs(r.ls / r.fs + 0.02) < 0.002,
      r ? `${r.ls.toFixed(3)}px / ${r.fs.toFixed(1)}px = ${(r.ls / r.fs).toFixed(4)}em` : '找不到元素');
  }
  await ctx.close();
}

await browser.close();
await new Promise((r) => server.close(r));
const fail = rows.filter((r) => !r.pass);
for (const r of rows) console.log(`${r.pass ? '\u2713' : '\u2717'} ${r.name} — ${r.detail}`);
console.log(`\n${rows.length - fail.length}/${rows.length} pass`);
process.exit(fail.length ? 1 : 0);
