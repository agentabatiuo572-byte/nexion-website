/* 逐元素视觉回归比对 — R43 立
   ────────────────────────────────────────────────────────────
   缘起(我自己的失效模式,三轮踩三次):
   做大范围机械改写后,我用**总量指标**(页面高度、门全绿)验收,而总量对**逐个元素的回归是瞎的**。
   R42 里我第一次改写把手机端页高撑大 19~28%,用页高发现并「修好」;
   **那个修法本身把窄屏标题砍掉 44%**,页高恰好看起来正常,于是没被发现 ——
   直到独立评审逐元素量才抓到。

   更关键的是:我本来有这把尺子,但它用 DOM 序号做键,我一改结构(插了两层包装)序号整体平移,
   比对全是噪声;**我当时放弃了它,而不是修好它**。这个文件就是修好它。

   键 = 标签 + 类名 + 文本前 40 字 + 同签名内序号 —— 插包装层不影响,改内容才影响(那时本就该重看)。
   量 = 渲染尺寸(计算值 × zoom)、盒宽高、相对画布左缘的位置。

   用法:
     node scripts/visual-diff.mjs snap <base-url> <out.json> [宽度,逗号分隔]
     node scripts/visual-diff.mjs diff <before.json> <after.json> [容差%]
   典型:改动前后各起一个服务,各 snap 一次,再 diff。 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const MODE = process.argv[2];
const DEFAULT_WIDTHS = [390, 768, 1024, 1440, 1920, 2560];

const collect = () => {
  const cv = document.querySelector('.x-canvas');
  const z = cv ? parseFloat(getComputedStyle(cv).zoom) || 1 : 1;
  const cl = cv ? cv.getBoundingClientRect().left : 0;
  const seen = new Map();
  const out = {};
  for (const el of document.querySelectorAll('*')) {
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'META' || el.tagName === 'LINK') continue;
    const b = el.getBoundingClientRect();
    if (b.width < 1 && b.height < 1) continue;
    // 🔴 数字一律归一:页面上有实时时钟等随时间变的文本,不归一的话键会对不上,
    //    该元素被**静默排除**出比对 —— 这正是我一直栽的「样本静默丢失」。
    const txt = (el.textContent || '').replace(/\s+/g, ' ').replace(/\d/g, '#').trim().slice(0, 40);
    const cls = String(el.className || '').replace(/\s+/g, ' ').trim().slice(0, 48);
    const base = el.tagName + '|' + cls + '|' + txt;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    const cs = getComputedStyle(el);
    // 渲染量:画布内元素的计算值是画布量,乘 zoom 才是屏幕上看到的
    const inCanvas = cv ? cv.contains(el) : false;
    const k = inCanvas ? z : 1;
    out[base + '#' + n] = [
      Math.round(b.width * 10) / 10,
      Math.round(b.height * 10) / 10,
      Math.round((b.left - cl) * 10) / 10,
      Math.round(parseFloat(cs.fontSize) * k * 100) / 100,
    ];
  }
  return out;
};

if (MODE === 'snap') {
  const base = process.argv[3];
  const outFile = process.argv[4];
  const widths = (process.argv[5] || '').split(',').filter(Boolean).map(Number);
  const W = widths.length ? widths : DEFAULT_WIDTHS;
  let chromium;
  for (const anchor of ['D:/WORKS/PLAN/Nexion-uniapp/package.json', join(ROOT, 'package.json')]) {
    try { chromium = createRequire(anchor)('playwright').chromium; break; } catch { /* next */ }
  }
  if (!chromium) { console.error('playwright 不可用'); process.exit(3); }
  const smPath = join(ROOT, 'dist', 'sitemap-0.xml');
  const routes = existsSync(smPath)
    ? [...readFileSync(smPath, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)]
        .map((m) => m[1].replace(/^https?:\/\/[^/]+/, ''))
        .map((p) => (p.endsWith('/') || p.includes('.') ? p : p + '/'))
    : ['/'];
  const browser = await chromium.launch();
  const snap = {};
  for (const w of W) {
    // reducedMotion:动画中途态不是回归,排除掉才比得准
    const ctx = await browser.newContext({ viewport: { width: w, height: 1000 }, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    for (const r of routes) {
      await page.goto(base + r, { waitUntil: 'load' });
      await page.waitForTimeout(350);
      snap[w + '|' + r] = await page.evaluate(collect);
    }
    await ctx.close();
    console.log('  ' + w + 'px 完成(' + routes.length + ' 路由)');
  }
  await browser.close();
  writeFileSync(outFile, JSON.stringify(snap));
  console.log('快照写入 ' + outFile);
  process.exit(0);
}

if (MODE === 'diff') {
  const A = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  const B = JSON.parse(readFileSync(process.argv[4], 'utf8'));
  const TOL = (+(process.argv[5] || 2)) / 100;
  const LABEL = ['宽', '高', '左', '字号'];
  const byWidth = new Map();
  for (const page of Object.keys(A)) {
    const [w, route] = page.split('|');
    const a = A[page];
    const b = B[page] || {};
    if (!byWidth.has(w)) byWidth.set(w, { matched: 0, changed: 0, items: [] });
    const S = byWidth.get(w);
    for (const key of Object.keys(a)) {
      const x = a[key];
      const y = b[key];
      if (!y) continue;
      S.matched++;
      let worst = 0;
      let which = -1;
      for (let i = 0; i < 4; i++) {
        if (!x[i] && !y[i]) continue;
        const denom = Math.max(Math.abs(x[i]), 1);
        const d = Math.abs(y[i] - x[i]) / denom;
        if (d > worst) { worst = d; which = i; }
      }
      if (worst > TOL) {
        S.changed++;
        S.items.push({ route, key, m: LABEL[which], from: x[which], to: y[which], pct: worst * 100 });
      }
    }
  }
  let total = 0;
  for (const [w, S] of [...byWidth.entries()].sort((p, q) => +p[0] - +q[0])) {
    total += S.changed;
    console.log(`\n${w}px:配对 ${S.matched} 个元素,超出 ${(TOL * 100).toFixed(0)}% 容差的 ${S.changed} 个`);
    const top = S.items.sort((p, q) => q.pct - p.pct).slice(0, 8);
    for (const t of top)
      console.log(`   ${t.pct.toFixed(0).padStart(3)}%  ${t.m} ${t.from}→${t.to}   ${t.route} ${t.key.slice(0, 62)}`);
    if (S.items.length > 8) console.log(`   …另有 ${S.items.length - 8} 个`);
  }
  console.log(`\n合计变化 ${total} 个元素`);
  process.exit(total ? 1 : 0);
}

console.log('用法:visual-diff.mjs snap <url> <out.json> [宽度] | diff <a.json> <b.json> [容差%]');
process.exit(2);
