/* 第八门 · 画布几何(运行时) — R39 立,R42 随机制换代重写
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
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve, extname, sep } from 'node:path';
import { createServer } from 'node:http';
import { readBuiltPages, seamRoutes, parseRoutesArg, scopeRoutes } from './gate-built-routes.mjs';

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
for (const anchor of [join(ROOT, 'package.json')]) {
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

const reuse = arg('--reuse');
let base = reuse ? `http://localhost:${reuse}` : null;
let server = null;
let browser = null;

try {
if (!base) {
  if (!argv.includes('--no-build')) {
    console.log('[geo] 构建产物…');
    execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'ignore', shell: process.platform === 'win32' });
  }
  const dist = resolve(ROOT, 'dist');
  const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.json': 'application/json', '.xml': 'application/xml', '.ico': 'image/x-icon' };
  // Static artifacts need no Astro daemon; this process owns and closes its listener.
  server = createServer((req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url || '/', 'http://127.0.0.1').pathname);
      let file = resolve(dist, `.${path}`);
      if (file !== dist && !file.startsWith(dist + sep)) { res.writeHead(404).end(); return; }
      if (!extname(file) || (existsSync(file) && statSync(file).isDirectory())) file = join(file, 'index.html');
      const body = readFileSync(file);
      res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
  base = `http://127.0.0.1:${server.address().port}`;
}

const smPath = join(ROOT, 'dist', 'sitemap-0.xml');
if (!existsSync(smPath)) throw new Error('找不到 dist/sitemap-0.xml');
const routes = [...readFileSync(smPath, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)]
  .map((m) => m[1].replace(/^https?:\/\/[^/]+/, ''))
  .map((p) => (p.endsWith('/') || p.includes('.') ? p : p + '/'));
if (!routes.length) throw new Error('sitemap 为空,判据无对象');
const generatedPages = readBuiltPages(join(ROOT, 'dist'));
const seamBaselines = seamRoutes(generatedPages);
if (generatedPages.some(({ route }) => !routes.includes(route)) || routes.some((route) => !generatedPages.some((page) => page.route === route))) {
  throw new Error('sitemap 与生成路由不一致，覆盖面不完整');
}
/* 增量裁剪只收窄实测对象,不碰上面的 sitemap↔产物一致性(那是覆盖面断言,必须全量)。
   无变化路由时直接报跳过:HTML 与静态资源都与线上一致,几何量不出第二种答案。 */
const onlyRoutes = parseRoutesArg(argv);
const scope = scopeRoutes(routes, onlyRoutes);
const scopedRoutes = scope.pages;
const scopedSeam = scopeRoutes(seamBaselines, onlyRoutes).pages;
if (scope.scoped && scopedRoutes.length === 0 && scopedSeam.length === 0) {
  console.log(`[geo] ✓ 路由裁剪:无变化路由,跳过实测(0/${scope.total})`);
  if (server) await new Promise((done) => server.close(done));
  process.exit(0);
}

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
  /* 设计上的内层裁切件(hidden/clip 才算合法):按钮悬停滑层 / 行遮罩 / 灯箱盒 / 显式标记。
     🔴 区块级 hidden/clip 一律不豁免:六个区块都带 hidden,R45 实录「说明段 ≤480 被裁 50–140px」正是被它静默吃掉,
     门却因「祖先有 hidden = 设计裁切」两次 8/8 全绿(U5 变异测试 ③)。可滚容器(auto/scroll)用户滚得到,仍算合法。 */
  // 注:行遮罩 .lr-line 已改用 clip-path(不是 overflow),不需要也不会走这条豁免
  const CLIPPERS = ".xbtn, .cert-zoom, .x-clip, [data-clip]";
  const legit = (el) => {
    if (el.ownerSVGElement || el.tagName === "svg") return true;
    for (let q = el.parentElement; q; q = q.parentElement) {
      if (q.classList.contains("x-frame") || q.tagName === "MAIN" || q.tagName === "BODY" || q.tagName === "HTML") return false;
      const ox = getComputedStyle(q).overflowX;
      if (ox === "auto" || ox === "scroll") return true;
      if ((ox === "hidden" || ox === "clip") && q.matches(CLIPPERS)) return true;
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
    const over = Math.max(r.right - de.getBoundingClientRect().width, -r.left, 0);
    if (over > worstOver) { worstOver = over; worstWho = el.tagName + "." + String(el.className).slice(0, 22); }
  }

  // 导航可点件(画布像素 = 渲染量 / navZoom)
  const nav = document.querySelector('nav');
  const nz = nav ? parseFloat(getComputedStyle(nav).zoom) || 1 : 1;
  let minTap = Infinity;
  if (nav) {
    for (const el of nav.querySelectorAll('a,button,summary,select,input')) {
      const h = el.getBoundingClientRect().height;
      if (h > 5) minTap = Math.min(minTap, h / nz);
    }
  }
  return {
    zoom: z,
    canvasL: cb ? Math.round(cb.left * 100) / 100 : null,
    canvasW: cb ? Math.round(cb.width * 100) / 100 : null,
    client: de.clientWidth,
    /* 可用布局宽 = html 的 rect 宽(不含滚动条/槽);clientWidth 在隐藏滚动条环境下不减槽宽,与布局分家 */
    avail: Math.round(de.getBoundingClientRect().width * 100) / 100,
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

/* R45:带**经典滚动条**跑(不传 Playwright 默认的 --hide-scrollbars)——主人的 Windows Chrome 就是这个环境。
   此前六轮「零溢出 / 居中」全在隐藏滚动条下量的,100vw 与可用宽差的那 15px 从未进过门。 */
browser = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
const fails = [];
const pages = {};
for (const w of [...WIDTHS, ...SEAM]) pages[w] = pages[w] || (await browser.newPage({ viewport: { width: w, height: 1000 } }));
const load = async (w, route) => {
  await pages[w].goto(base + route, { waitUntil: 'load' });
  return pages[w].evaluate(readAll);
};

let minSample = Infinity;
let classicSb = null; // 本次实测环境是否真有经典滚动条(client < inner);覆盖边界写进成功行
for (const route of scopedRoutes) {
  const snap = {};
  for (const w of WIDTHS) snap[w] = await load(w, route);
  if (classicSb === null) classicSb = snap[1440].client < snap[1440].inner;

  for (const w of WIDTHS) {
    const s = snap[w];
    // A 画布
    if (s.canvasW === null) { fails.push(`A 画布 ${route} @${w}:页面无画布壳 .x-canvas`); continue; }
    /* R45:--x-zoom 的输入改为可用布局宽(--x-vw = html rect 宽,不含滚动条/槽;100vw 只作兜底),
       门与实现同源:画布宽 = min(可用宽, 1920) 且在可用宽内居中;画布不得超出可用宽。 */
    const wantW = Math.min(s.avail, CAP);
    if (w >= CANVAS && Math.abs(s.canvasW - wantW) > 1.5)
      fails.push(`A 画布 ${route} @${w}:画布宽 ${s.canvasW} ≠ min(视口,${CAP})=${wantW}`);
    if (w >= CANVAS && Math.abs(s.canvasL - (s.avail - s.canvasW) / 2) > 1.5)
      fails.push(`A 画布 ${route} @${w}:画布未居中(左 ${s.canvasL},应 ${((s.avail - s.canvasW) / 2).toFixed(1)})`);
    if (w >= CANVAS && Math.abs(s.zoom - wantW / CANVAS) > 0.003)
      fails.push(`A 画布 ${route} @${w}:zoom ${s.zoom} ≠ 画布宽/${CANVAS}=${(wantW / CANVAS).toFixed(4)}`);
    // B 溢出
    if (s.canvasW !== null && s.canvasW > s.avail + 1.5)
      fails.push(`A 画布 ${route} @${w}:画布宽 ${s.canvasW} 超出可用宽 ${s.avail}(经典滚动条下 100vw ≠ 布局宽)`);
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
for (const route of scopedSeam) {
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

if (fails.length) {
  console.log(`[geo] ✗ 画布几何:${scopedRoutes.length} 条路由,${fails.length} 条判据不合格${scope.scoped ? ` · 路由裁剪(${scopedRoutes.length}/${scope.total})` : ''}`);
  for (const f of fails.slice(0, 24)) console.log('      ' + f);
  if (fails.length > 24) console.log(`      …另有 ${fails.length - 24} 条`);
  process.exitCode = 2;
} else console.log(
  `[geo] ✓ 画布几何:${scopedRoutes.length} 路由 × {${WIDTHS.join(',')}} + ${scopedSeam.length} 个各语首页/内页基准 × 断点两侧 {${seamW.join(',')}} 七判据全过` +
    `(A画布/B溢出/C等比/D冻结/E可读/F触达/G连续;最小字号样本 ${minSample};滚动条:${classicSb ? '经典(占位)' : '覆盖式/无(本次未覆盖经典滚动条形态)'};实测服务 ${base})` +
    (scope.scoped ? ` · 路由裁剪(${scopedRoutes.length}/${scope.total})` : ''),
);
} catch (error) {
  console.log(`[geo] NOT-RUN:${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 3;
} finally {
  try { if (browser) await browser.close(); }
  finally { if (server) await new Promise((done) => server.close(done)); }
}
