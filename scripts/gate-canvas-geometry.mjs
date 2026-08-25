/* 第七门 · 画布几何(运行时) — R39 立,R42 随机制换代重写
   ────────────────────────────────────────────────────────────
   R39/R40/R41 版守的是「逐条声明模拟缩放」那套机制的漏点(等比/冻结/盒子/塌缩…)。
   R42 换成整体缩放(画布壳 zoom)后,那些漏点**按构造消失**:画布内任何 px 都是画布像素,
   字号/盒子/间距/边框/渐变止点/栅格一起等比,不存在「一半缩另一半不缩」。

   于是判据从「查每条声明有没有走对形态」换成「查画布这一层不变量成不成立」——
   小、确定、且覆盖真实事故形态。

   七条判据:
     A 画布   画布宽 = min(视口, 1920) 且居中,zoom = 画布宽/1440
     B 溢出   任何宽度下无横向溢出(停放的叠卡由全宽裁切框裁在屏缘)
     C 等比   渲染字号 1440→1920 比值 = 1.3333
     D 冻结   渲染字号 1920→2560 恒等(封顶真的封住)
     E 可读   任何采样宽度下,可见文字渲染字号 >= 11px
     F 触达   导航可点件 >= 44 画布像素(R41 曾因单位断点掉到 36.7px)
     G 连续   **从产物 CSS 读出所有断点**,逐个在两侧探:缩放曲线不得跳变(桌面段另守页高与字号)
              ← R41 在 1200 留下 16.7% 硬跳变,而当时的门在该处零取样,结构上看不见

   报绿必带样本量;样本不足即判红。

   用法:node scripts/gate-canvas-geometry.mjs [--reuse <port>] [--no-build]
   退出码:0 通过 · 2 不合格 · 3 跑不起来 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createServer } from 'node:net';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const argv = process.argv.slice(2);
const arg = (k) => {
  const i = argv.indexOf(k);
  return i < 0 ? null : argv[i + 1];
};

const CANVAS = 1440;      // 设计画布宽
const CAP = 1920;         // 画布封顶宽
const SCALE = CAP / CANVAS;
const WIDTHS = [390, 1024, 1440, 1920, 2560];
const SEAM = []; // R43:断点由产物 CSS 动态读出,此处不再写死(旧值是死代码,却被写进成功行)
const MIN_FONT = 11;      // 画布制下可见文字渲染字号下限
const MIN_TAP = 44;       // 画布像素
const MIN_SAMPLES = 24;
const CONFORM = 0.98;

let chromium;
for (const anchor of ['D:/WORKS/PLAN/Nexion-uniapp/package.json', join(ROOT, 'package.json')]) {
  try {
    chromium = createRequire(anchor)('playwright').chromium;
    break;
  } catch {
    /* 下一个锚点 */
  }
}
if (!chromium) {
  console.log('[geo] NOT-RUN:playwright 不可用(本仓无依赖,且未找到可借用的安装)');
  process.exit(3);
}

const freePort = () =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });

const reuse = arg('--reuse');
let base = reuse ? `http://localhost:${reuse}` : null;
let child = null;

if (!base) {
  if (!argv.includes('--no-build')) {
    console.log('[geo] 构建产物…');
    execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'ignore', shell: process.platform === 'win32' });
  }
  const port = await freePort();
  base = `http://localhost:${port}`;
  // astro preview 是单例守护进程:已有实例时它拒绝起第二个,只在 stdout 报出既有地址
  child = spawn('npx', ['astro', 'preview', '--port', String(port)], { cwd: ROOT, shell: process.platform === 'win32' });
  let reusedFrom = null;
  const sniff = (d) => {
    const m = String(d).match(/already running at (http:\/\/[^\s"\\]+)/);
    if (m) reusedFrom = m[1].replace(/\/$/, '');
  };
  child.stdout?.on('data', sniff);
  child.stderr?.on('data', sniff);
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    const target = reusedFrom || base;
    try {
      const r = await fetch(target + '/', { signal: AbortSignal.timeout(1000) });
      if (r.ok) { up = true; base = target; if (reusedFrom) child = null; }
    } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  if (!up) { child?.kill(); console.log('[geo] NOT-RUN:预览服务未能起来'); process.exit(3); }
}

const smPath = join(ROOT, 'dist', 'sitemap-0.xml');
if (!existsSync(smPath)) { child?.kill(); console.log('[geo] NOT-RUN:找不到 dist/sitemap-0.xml'); process.exit(3); }
const routes = [...readFileSync(smPath, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)]
  .map((m) => m[1].replace(/^https?:\/\/[^/]+/, ''))
  .map((p) => (p.endsWith('/') || p.includes('.') ? p : p + '/'));
if (!routes.length) { child?.kill(); console.log('[geo] NOT-RUN:sitemap 为空,判据无对象'); process.exit(3); }

/* 页内采集:渲染量 = 布局量 × zoom(画布内的 computed 值是画布量) */
const readAll = () => {
  const de = document.documentElement;
  const cv = document.querySelector('.x-canvas');
  const z = cv ? parseFloat(getComputedStyle(cv).zoom) || 1 : 1;
  const cb = cv ? cv.getBoundingClientRect() : null;
  const leaves = [];
  let minFont = Infinity;
  let minFontWhere = '';
  document.querySelectorAll('*').forEach((el, i) => {
    if (el.children.length) return;
    const t = (el.textContent || '').trim();
    if (!t) return;
    const b = el.getBoundingClientRect();
    if (b.width < 2 || b.height < 2) return;
    const rendered = Math.round(parseFloat(getComputedStyle(el).fontSize) * z * 100) / 100;
    leaves.push([i, rendered, t.slice(0, 40)]);
    if (rendered < minFont) { minFont = rendered; minFontWhere = el.tagName + '.' + String(el.className).slice(0, 20); }
  });
  /* B 判据的量法:.x-frame 的 overflow-x:clip 让 scrollWidth 恒等于 clientWidth,
     原来的 scrollWidth 差值是**恒真空转**(评审注入超宽卡越屏 480~1430px,判据报 0)。
     改为逐元素越界,并把「设计上就该停在屏外」的叠卡编舞显式排除。 */
  /* 谁先裁住它,谁决定性质:
       · 内层容器先裁(按钮悬停滑层、可滚表格、SVG 视口)→ 合法,是设计
       · 一路到 .x-frame / main / body / html 才被裁 → 真缺陷(内容被静默切掉,用户既看不见也滚不到)
     🔴 不可把 .x-frame 的 clip 也算作合法裁剪 —— 那是全站兜底网,把它当合法会让本判据对一切失明。 */
  const legit = (el) => {
    if (el.ownerSVGElement || el.tagName === "svg") return true;
    for (let q = el.parentElement; q; q = q.parentElement) {
      if (q.classList.contains("x-frame") || q.tagName === "MAIN" || q.tagName === "BODY" || q.tagName === "HTML") return false;
      const ox = getComputedStyle(q).overflowX;
      if (ox === "hidden" || ox === "clip" || ox === "auto" || ox === "scroll") return true;
    }
    return false;
  };
  let worstOver = 0;
  let worstWho = "";
  for (const el of document.querySelectorAll("*")) {
    if (el.closest("[data-deck]")) continue;   // 叠卡编舞:卡片故意停在屏外由屏缘裁入
    const st = getComputedStyle(el);
    if (st.position === "fixed") continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (legit(el)) continue;
    const over = Math.max(r.right - de.clientWidth, -r.left, 0);
    if (over > worstOver) { worstOver = over; worstWho = el.tagName + "." + String(el.className).slice(0, 22); }
  }

  // 导航可点件(画布像素 = 渲染量 / navZoom)
  const nav = document.querySelector('nav');
  const nz = nav ? parseFloat(getComputedStyle(nav).zoom) || 1 : 1;
  let minTap = Infinity;
  if (nav) {
    for (const el of nav.querySelectorAll('a,button')) {
      const h = el.getBoundingClientRect().height;
      if (h > 5) minTap = Math.min(minTap, h / nz);
    }
  }
  return {
    zoom: z,
    canvasL: cb ? Math.round(cb.left * 100) / 100 : null,
    canvasW: cb ? Math.round(cb.width * 100) / 100 : null,
    client: de.clientWidth,
    inner: window.innerWidth,
    overflow: Math.round(worstOver * 10) / 10,
    overflowWho: worstWho,
    docH: de.scrollHeight,
    leaves,
    minFont: minFont === Infinity ? null : minFont,
    minFontWhere,
    minTap: minTap === Infinity ? null : Math.round(minTap * 10) / 10,
  };
};

const conform = (a, b, want) => {
  const mb = new Map(b.map((x) => [x[0], x]));
  let ok = 0;
  let all = 0;
  for (const x of a) {
    const y = mb.get(x[0]);
    if (!y || y[2] !== x[2] || !x[1]) continue;
    all++;
    if (Math.abs(y[1] / x[1] - want) < 0.02) ok++;
  }
  return { ok, all, rate: all ? ok / all : 0 };
};

const browser = await chromium.launch();
const fails = [];
const pages = {};
for (const w of [...WIDTHS, ...SEAM]) pages[w] = pages[w] || (await browser.newPage({ viewport: { width: w, height: 1000 } }));
const load = async (w, route) => {
  await pages[w].goto(base + route, { waitUntil: 'load' });
  return pages[w].evaluate(readAll);
};

let minSample = Infinity;
for (const route of routes) {
  const snap = {};
  for (const w of WIDTHS) snap[w] = await load(w, route);

  for (const w of WIDTHS) {
    const s = snap[w];
    // A 画布
    if (s.canvasW === null) { fails.push(`A 画布 ${route} @${w}:页面无画布壳 .x-canvas`); continue; }
    /* CSS 里 --x-zoom 用 100vw(**含**经典滚动条),而 clientWidth 不含。
       真浏览器上两者差一条滚动条 ⇒ 画布比可视区宽 ~15px,右侧留白被啃掉。
       门必须与实现同源(用 innerWidth)判 zoom,另立一条判据查「画布不得超出可视区」。 */
    const wantW = Math.min(s.inner, CAP);
    if (w >= CANVAS && Math.abs(s.canvasW - wantW) > 1.5)
      fails.push(`A 画布 ${route} @${w}:画布宽 ${s.canvasW} ≠ min(视口,${CAP})=${wantW}`);
    if (w >= CANVAS && Math.abs(s.canvasL - (s.client - s.canvasW) / 2) > 1.5)
      fails.push(`A 画布 ${route} @${w}:画布未居中(左 ${s.canvasL},应 ${((s.client - s.canvasW) / 2).toFixed(1)})`);
    if (w >= CANVAS && Math.abs(s.zoom - wantW / CANVAS) > 0.003)
      fails.push(`A 画布 ${route} @${w}:zoom ${s.zoom} ≠ 画布宽/${CANVAS}=${(wantW / CANVAS).toFixed(4)}`);
    // B 溢出
    if (s.canvasW !== null && s.canvasW > s.client + 1.5)
      fails.push(`A 画布 ${route} @${w}:画布宽 ${s.canvasW} 超出可视区 ${s.client}(经典滚动条下 100vw ≠ 布局宽)`);
    if (s.overflow > 1.5) fails.push(`B 溢出 ${route} @${w}:元素越界 ${s.overflow}px(${s.overflowWho})`);
    // E 可读
    if (s.minFont !== null && s.minFont < MIN_FONT)
      fails.push(`E 可读 ${route} @${w}:最小可见字号 ${s.minFont}px < ${MIN_FONT}(${s.minFontWhere})`);
    // F 触达
    if (s.minTap !== null && s.minTap < MIN_TAP - 0.5)
      fails.push(`F 触达 ${route} @${w}:导航可点件最小 ${s.minTap} 画布像素 < ${MIN_TAP}`);
  }

  // C 等比 / D 冻结
  const c = conform(snap[1440].leaves, snap[1920].leaves, SCALE);
  minSample = Math.min(minSample, c.all);
  if (c.all < MIN_SAMPLES) fails.push(`C 样本 ${route}:可比样本仅 ${c.all}(应 ≥${MIN_SAMPLES})——判据形同虚设,不许算过`);
  else if (c.rate < CONFORM)
    fails.push(`C 等比 ${route}:渲染字号 1440→1920 达标 ${(c.rate * 100).toFixed(1)}%(${c.ok}/${c.all})`);
  const d = conform(snap[1920].leaves, snap[2560].leaves, 1);
  if (d.all >= MIN_SAMPLES && d.rate < CONFORM)
    fails.push(`D 冻结 ${route}:渲染字号 1920→2560 恒等仅 ${(d.rate * 100).toFixed(1)}%(${d.ok}/${d.all})——封顶没封住`);
}

/* G 连续:断点两侧不得跳变。
   🔴 断点位置**从产物 CSS 里读出来**,不写死 —— 写死的话,断点一挪门就又瞎了,
   而这正是 R41 那道 16.7% 硬缝溜过去的失效模式(当时的门在缝所在的宽度零取样)。 */
const cssFiles = readdirSync(join(ROOT, 'dist', '_astro')).filter((f) => f.endsWith('.css'));
const bps = new Set();
for (const f of cssFiles) {
  const txt = readFileSync(join(ROOT, 'dist', '_astro', f), 'utf8');
  // 构建会把 max-width:Npx 压成新式区间写法 width<=Npx —— 两种都要认,否则一个断点都读不到
  for (const m of txt.matchAll(/(?:(?:max|min)-width\s*:\s*|width\s*[<>]=?\s*)(\d+)px/g)) {
    const n = +m[1];
    if (n >= 700 && n <= 2600) bps.add(n); // 桌面段断点;移动重排断点另有设计意图
  }
}
const seamW = [...bps].sort((a, b) => a - b);
if (!seamW.length) fails.push('G 连续:产物 CSS 里一个桌面断点都没读到 —— 判据无对象,不许算过');
for (const route of [routes[0], ...routes.filter((r) => /legal|learn\//.test(r)).slice(0, 1)]) {
  for (const bp of seamW) {
    for (const w of [bp - 1, bp, bp + 1]) {
      if (!pages[w]) pages[w] = await browser.newPage({ viewport: { width: w, height: 1000 } });
    }
    const s = {};
    for (const w of [bp - 1, bp, bp + 1]) s[w] = await load(w, route);
    for (const [a, b] of [[bp - 1, bp], [bp, bp + 1]]) {
      /* 守的是**缩放曲线**的连续性,不是版式的连续性:
         移动断点(860 等)整版重排、页高与字号本就该跳,那是设计;
         而缩放系数在任何断点都不该跳 —— R41 那道缝正是 zoom 从 1 突降到 0.8333。 */
      const za = s[a].zoom;
      const zb = s[b].zoom;
      if (za && zb && Math.abs(zb - za) / za > 0.02)
        fails.push(`G 连续 ${route}:断点 ${bp} 处 ${a}→${b} 画布缩放 ${za}→${zb} 跳变 ${(((zb - za) / za) * 100).toFixed(1)}%(应 <2%)——硬缝`);
      // 桌面段(同一版式)另守页高与字号;移动重排段豁免
      if (bp < 1000) continue;
      const dh = Math.abs(s[b].docH - s[a].docH) / (s[a].docH || 1);
      if (dh > 0.02)
        fails.push(`G 连续 ${route}:断点 ${bp} 处 ${a}→${b} 页面总高跳变 ${(dh * 100).toFixed(1)}%(应 <2%)——留下硬缝`);
      const fa = s[a].minFont;
      const fb = s[b].minFont;
      if (fa && fb && Math.abs(fb - fa) / fa > 0.02)
        fails.push(`G 连续 ${route}:断点 ${bp} 处 ${a}→${b} 最小字号 ${fa}→${fb} 跳变 ${(((fb - fa) / fa) * 100).toFixed(1)}%`);
    }
  }
}

await browser.close();
child?.kill();

if (fails.length) {
  console.log(`[geo] ✗ 画布几何:${routes.length} 条路由,${fails.length} 条判据不合格`);
  for (const f of fails.slice(0, 24)) console.log('      ' + f);
  if (fails.length > 24) console.log(`      …另有 ${fails.length - 24} 条`);
  process.exit(2);
}
console.log(
  `[geo] ✓ 画布几何:${routes.length} 路由 × {${WIDTHS.join(',')}} + 断点两侧 {${seamW.join(',')}} 七判据全过` +
    `(A画布/B溢出/C等比/D冻结/E可读/F触达/G连续;最小字号样本 ${minSample};实测服务 ${base})`,
);
process.exit(0);
