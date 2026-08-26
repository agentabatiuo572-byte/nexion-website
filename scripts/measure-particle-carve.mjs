/* 粒子丝线「刻痕」的**唯一口径**(谷/峰比)。
 *
 * 为什么要入仓:同一份产物,不同人不同写法量出来 0.094 / 0.144 / 0.222 / 0.263 / 0.278 / 0.366 / 0.406 —— 4 倍散布。
 * 那不是产物在变,是量法在变(patch 位置、扫描步长、峰阈、谷取法、聚合统计量各选各的)。
 * 指标一旦不可复验,「在不在目标带里」就成了换个人就换的结论。这里把五件事钉死,以后一律跑这个脚本。
 *
 * 口径(改任何一条都要在这里改,并说明为什么):
 *   1. 视口 1455×900、DPR 1(画布 zoom 恰为 1,画布像素 = CSS 像素);
 *   2. patch = 首屏左上 (120,240) 起 520×420 —— 该区只有粒子、没有文字与按钮;
 *   3. 冻帧后再取:等 fonts.ready + 2.5s 让流光跑开,然后 `requestAnimationFrame = () => 0`;
 *   4. 每 3 行取一条水平扫描线;峰 = 局部极大且高于该行均值;相邻峰之间取最小值为谷;
 *      比值 = 谷 / 两峰均值;两峰间距 <3px 的对丢弃(抗锯齿噪声);
 *   5. 聚合用**中位数**(均值被少数极亮谷拉偏)。
 *
 * 参照:参考站同法读数 0.142–0.264 → 目标带 0.15–0.27。
 * 用法:node scripts/measure-particle-carve.mjs [url]   默认 http://localhost:4399/
 */
import { createRequire } from 'node:module';

const require = createRequire('D:/WORKS/PLAN/Nexion-uniapp/package.json');
const { chromium } = require('playwright');

const URL_ = process.argv[2] || 'http://localhost:4399/';
const PATCH = { x: 120, y: 240, width: 520, height: 420 };
const BAND = [0.15, 0.27];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1455, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
await page.goto(URL_, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(2500);
await page.evaluate(() => {
  window.requestAnimationFrame = () => 0;
});
await page.waitForTimeout(200);
const png = (await page.screenshot({ clip: PATCH })).toString('base64');

const stat = await page.evaluate(async (d) => {
  const im = new Image();
  await new Promise((res) => {
    im.onload = res;
    im.src = 'data:image/png;base64,' + d;
  });
  const c = document.createElement('canvas');
  c.width = im.width;
  c.height = im.height;
  const g = c.getContext('2d');
  g.drawImage(im, 0, 0);
  const px = g.getImageData(0, 0, c.width, c.height).data;
  const L = (x, y) => {
    const i = (y * c.width + x) * 4;
    return 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
  };
  const all = [];
  for (let y = 0; y < c.height; y += 3) {
    const row = [];
    for (let x = 0; x < c.width; x++) row.push(L(x, y));
    const mean = row.reduce((s, v) => s + v, 0) / row.length;
    const peaks = [];
    for (let x = 2; x < row.length - 2; x++) {
      if (row[x] > mean && row[x] >= row[x - 1] && row[x] >= row[x + 1] && row[x] > row[x - 2] && row[x] > row[x + 2]) peaks.push(x);
    }
    for (let i = 0; i + 1 < peaks.length; i++) {
      const a = peaks[i];
      const b = peaks[i + 1];
      if (b - a < 3) continue;
      let lo = Infinity;
      for (let x = a + 1; x < b; x++) lo = Math.min(lo, row[x]);
      const hi = (row[a] + row[b]) / 2;
      if (hi > 8) all.push(lo / hi);
    }
  }
  all.sort((p, q) => p - q);
  const q = (f) => (all.length ? all[Math.floor(all.length * f)] : NaN);
  return { n: all.length, median: q(0.5), p25: q(0.25), p75: q(0.75), mean: all.reduce((s, v) => s + v, 0) / (all.length || 1) };
});
await browser.close();

const inBand = stat.median >= BAND[0] && stat.median <= BAND[1];
console.log(`[carve] ${URL_}`);
console.log(`  样本 ${stat.n} · 中位数 ${stat.median.toFixed(3)} · p25 ${stat.p25.toFixed(3)} · p75 ${stat.p75.toFixed(3)} · 均值 ${stat.mean.toFixed(3)}`);
console.log(`  目标带 ${BAND[0]}–${BAND[1]}(参考站同法 0.142–0.264)→ ${inBand ? '✓ 带内' : stat.median > BAND[1] ? '✗ 偏浅(丝间不够黑)' : '✗ 偏深'}`);
process.exit(inBand ? 0 : 1);
