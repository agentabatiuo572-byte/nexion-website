/* 截图助手 —— 给评审 agent 用。只打构建产物(4399),不打 dev。
 *
 * 🔴 本机有一个必须绕开的环境坑:Windows 全局暗色主题下,Chromium 无头会**非确定性地**
 *    把页面里的反白板块(浅底深字)强制反转成黑底亮字。站点代码是对的,是本机渲染环境的问题。
 *    实测唯一稳定的绕法:把装饰用的全屏 canvas(#x-bg)的 getContext 短路成 null ——
 *    没有那张涂暗色的整屏画布,Chromium 就不再判定「这页需要暗化」。
 *    所以默认关掉背景 canvas(颜色可信,但看不到氛围粒子);要看氛围加 --canvas,
 *    此时若看到本该浅色的板块变黑,那是本机环境,不是站点缺陷。
 *
 * 用法:
 *   node scripts/shots.mjs --routes / /vi/ /zh/ --size 1440x900 --out <目录>
 *   node scripts/shots.mjs --routes /nex/ --size 390x844 --out <目录>
 *   加 --canvas  保留背景粒子(颜色可能被本机翻转)
 *   加 --motion  不开「减少动态」(看磨砂导航 / 开场编排的真实态;静态构图截图别用)
 *   加 --full    另存一张整页长图
 *
 * 产物:<目录>/<slug>__<宽>x<高>__s01.png … 逐屏;--full 再加一张 __full.png
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire('D:/WORKS/PLAN/Nexion-uniapp/package.json');
const { chromium } = require('playwright');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const listOf = (n) => {
  const i = argv.indexOf('--' + n);
  if (i < 0) return [];
  const out = [];
  for (let k = i + 1; k < argv.length && !argv[k].startsWith('--'); k++) out.push(argv[k]);
  return out;
};
const one = (n, d) => listOf(n)[0] ?? d;

const BASE = one('base', 'http://localhost:4399').replace(/\/$/, '');
/* 🔴 本机 Git Bash(MSYS)会把裸参数 "/" 改写成 Git 的安装路径("C:/Program Files/Git/"),
   于是 URL 拼出来是 http://localhost:4399C:/Program Files/Git/ 直接报错。
   所以路由**用不带斜杠的写法**:home / vi / zh / nex / vi/nex / learn/staking-nex;
   带斜杠的也收,顺手把被改写掉的那一个认回首页。 */
const norm = (r) => {
  if (/^[A-Za-z]:[\\/]/.test(r) || r.includes('Program Files')) return '/';
  const s = r.replace(/^[/\\]+|[/\\]+$/g, '');
  return !s || s === 'home' ? '/' : '/' + s + '/';
};
const ROUTES = (listOf('routes').length ? listOf('routes') : ['home']).map(norm);
const [W, H] = one('size', '1440x900').split('x').map(Number);
const OUT = one('out', 'shots');
const MAX = Number(one('max', '12'));
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
  isMobile: W <= 500,
  hasTouch: W <= 500,
  reducedMotion: flag('motion') ? 'no-preference' : 'reduce',
});
if (!flag('canvas')) {
  await ctx.addInitScript(() => {
    const real = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (...a) {
      return this.id === 'x-bg' ? null : real.apply(this, a);
    };
  });
}
const page = await ctx.newPage();
const made = [];

for (const r of ROUTES) {
  const res = await page.goto(BASE + r, { waitUntil: 'networkidle' });
  if (!res || !res.ok()) { console.log(`跳过 ${r}(HTTP ${res ? res.status() : '无响应'})`); continue; }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(flag('motion') ? 2600 : 500);
  const slug = (r.replace(/^\/|\/$/g, '') || 'home').replace(/\//g, '-');
  const stem = `${OUT}/${slug}__${W}x${H}`;

  if (flag('full')) {
    await page.screenshot({ path: `${stem}__full.png`, fullPage: true });
    made.push(`${stem}__full.png`);
  }
  const total = await page.evaluate(() => document.documentElement.scrollHeight);
  const steps = Math.min(MAX, Math.max(1, Math.ceil(total / H)));
  for (let i = 0; i < steps; i++) {
    const y = Math.min(i * H, Math.max(0, total - H));
    // Lenis 在「减少动态」下不接管滚动;开了动态时用它自己的 scrollTo,免得两套滚动打架
    await page.evaluate((t) => {
      const l = window.__lenis || window.lenis;
      if (l && typeof l.scrollTo === 'function') l.scrollTo(t, { immediate: true });
      else window.scrollTo(0, t);
    }, y);
    await page.waitForTimeout(flag('motion') ? 900 : 350);
    const f = `${stem}__s${String(i + 1).padStart(2, '0')}.png`;
    await page.screenshot({ path: f });
    made.push(f);
  }
}
await browser.close();
console.log(made.join('\n'));
console.log(`\n共 ${made.length} 张。背景 canvas ${flag('canvas') ? '开(颜色可能被本机强制暗色翻转)' : '关(颜色可信,无氛围粒子)'};动态 ${flag('motion') ? '开' : '关'}。`);
