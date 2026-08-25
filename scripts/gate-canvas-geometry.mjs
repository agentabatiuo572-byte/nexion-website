/* 第七门 · 画布几何(运行时) — R39 立,R41 补正交维度
   ────────────────────────────────────────────────────────────
   R39 缘起:把「画布 1920 封顶 + 居中」的留白加成了内边距,而全站 box-sizing:border-box,
   三个写死 max-width:780px 的内页在 2560 下正文被挤成 33.2px(24/33 路由不可读)。
   六道静态门全绿 —— 不是门坏了,是这道门不存在:那六门查文本与 token,没有一门看渲染盒子。

   R41 缘起(同一元模式第二次):R40 版只测「字号」「1440→1920」「每页一个盒子」「≥1440」,
   于是这些全在盲区里活着 ——
     · 裸视口单位字号:它在 1440→1920 的比值恰好就是判据要找的 1.3333,门必放行
     · 上限基数写错的声明:1920 以上继续涨(2560 实测 +33%),门够不着
     · 学习页卡片标题被截断、证书不放大:门只看字号不看盒子
     · 手机端被内边距挤没:门在 1440 以下零取样
     · 溢出判据被 main 的 overflow-x:clip 吃掉,结构上观测不到本站真实故障
   教训:每加一条判据必答「它查哪个维度?正交维度有第二道门吗?」

   八条判据:
     A 塌缩   2560 正文列宽 >= 1920 x 0.95       <- 留白吃掉内容
     B 留白   每页 main 左侧位移 >= 画布留白      <- 新增内页漏加 / 被简写盖掉
     C 封顶   2560 正文盒宽 <= 1920              <- 忘了封顶,超宽屏越拉越大
     D 溢出   元素级越界(2560 与 390 两档)     <- 换信号:clip 让 scrollWidth 恒等,不可用
     E 等比   字号 1440->1920 约 1.3333          <- 尺寸没走画布单位
     F 冻结   字号 1920->2560 恒等               <- 裸 vw / 上限基数写错(E 的盲区)
     G 盒子   盒宽 1440->1920 约 1.3333          <- 栅格门槛、minmax 上限没走画布单位
     H 窄屏   390/768 无越界且正文可读           <- 1440 以下整段无人看守

   报绿必带样本量:样本不足即判红(样本静默塌缩会让「全过」只体检一小撮元素)。

   用法:node scripts/gate-canvas-geometry.mjs [--reuse <port>] [--no-build]
   退出码:0 通过 · 2 有路由不合格 · 3 跑不起来(由调用方决定降级口径) */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createServer } from 'node:net';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const argv = process.argv.slice(2);
const arg = (k) => {
  const i = argv.indexOf(k);
  return i < 0 ? null : argv[i + 1];
};

const CANVAS = 1920;
const BASE_W = 1440;
const WIDE = 2560;
const NARROW = 1920;
const TINY = 390;
const TABLET = 768;
const SCALE = NARROW / BASE_W;

const MIN_RATIO = 0.95;
const MIN_CONFORM_E = 0.92;
const MIN_CONFORM_F = 0.97;
const MIN_CONFORM_G = 0.85;
const MIN_SAMPLES = 24;

/* ── playwright:本仓无依赖,借 uniapp 的 ── */
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
  // astro preview 是单例守护进程:已有实例时它拒绝起第二个,只在 stdout 报出既有地址。
  // 复用既有实例是安全的 —— 预览是静态文件服务,上面刚 build 过,dist 即新。
  child = spawn('npx', ['astro', 'preview', '--port', String(port)], {
    cwd: ROOT,
    shell: process.platform === 'win32',
  });
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
      if (r.ok) {
        up = true;
        base = target;
        if (reusedFrom) child = null; // 不是我起的,收尾不许杀
      }
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!up) {
    child?.kill();
    console.log('[geo] NOT-RUN:预览服务未能起来');
    process.exit(3);
  }
}

const smPath = join(ROOT, 'dist', 'sitemap-0.xml');
if (!existsSync(smPath)) {
  child?.kill();
  console.log('[geo] NOT-RUN:找不到 dist/sitemap-0.xml');
  process.exit(3);
}
const routes = [...readFileSync(smPath, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)]
  .map((m) => m[1].replace(/^https?:\/\/[^/]+/, ''))
  .map((p) => (p.endsWith('/') || p.includes('.') ? p : p + '/'));

/* ── 页内采集:单次 evaluate 取全部维度 ── */
const readAll = () => {
  const de = document.documentElement;
  const m = document.querySelector('main');
  const cs = m ? getComputedStyle(m) : null;
  const r = m ? m.getBoundingClientRect() : null;
  const padL = cs ? parseFloat(cs.paddingLeft) || 0 : 0;

  const leaves = [];
  const boxes = [];
  const over = [];
  const BOX = /^(FIGURE|ARTICLE|LI)$/;
  // 真溢出 = 越界**且没有任何祖先把它裁住**。
  // 只看 rect 会把三类合法写法误报成缺陷:按钮悬停层停在屏外、SVG 内部坐标、横向可滚的表格。
  // 谁先裁住它,谁决定性质:
  //   · 内层容器先裁(按钮悬停层、可滚表格、叠卡舞台)→ 合法,是设计
  //   · 一路到 main/body/html 才被裁 → 真缺陷(内容被静默切掉,用户既看不见也滚不到)
  //  🔴 不可把 main 的 overflow-x:clip 也算作「裁住了就没事」——那是全站兜底网,
  //     把它当合法裁剪会让本判据对 main 内的一切失明(R41 红测当场揪出)。
  const clipped = (el) => {
    if (el.ownerSVGElement || el.tagName === 'svg') return true;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const tag = p.tagName;
      if (tag === 'MAIN' || tag === 'BODY' || tag === 'HTML') return false;
      const ox = getComputedStyle(p).overflowX;
      if (ox === 'hidden' || ox === 'clip' || ox === 'auto' || ox === 'scroll') return true;
    }
    return false;
  };
  document.querySelectorAll('*').forEach((el, i) => {
    const b = el.getBoundingClientRect();
    if (b.width > 0 && b.height > 0 && (b.right > de.clientWidth + 1.5 || b.left < -1.5)) {
      const st = getComputedStyle(el);
      // 叠卡编舞:卡片**故意**停在屏外、由屏缘裁入,是设计不是缺陷。
      // 这是本判据唯一的显式盲区;叠卡的横向几何另由卡宽/锚位断言看守。
      const inDeck = el.closest('[data-deck]') !== null;
      if (st.position !== 'fixed' && !inDeck && !clipped(el)) {
        over.push(el.tagName + '.' + String(el.className).slice(0, 20) + ' [' + b.left.toFixed(0) + ',' + b.right.toFixed(0) + ']');
      }
    }
    if (el.children.length === 0) {
      const t = (el.textContent || '').trim();
      if (t && b.width >= 2 && b.height >= 2) {
        leaves.push([i, Math.round(parseFloat(getComputedStyle(el).fontSize) * 100) / 100, t.slice(0, 40)]);
      }
    } else if (BOX.test(el.tagName) && b.width >= 40 && b.height >= 20) {
      boxes.push([i, Math.round(b.width * 100) / 100]);
    }
  });
  return {
    contentW: r ? Math.round((r.width - padL - (cs ? parseFloat(cs.paddingRight) || 0 : 0)) * 100) / 100 : null,
    padL: Math.round(padL * 100) / 100,
    marginL: cs ? Math.round((parseFloat(cs.marginLeft) || 0) * 100) / 100 : 0,
    client: de.clientWidth,
    leaves,
    boxes,
    over: over.slice(0, 3),
  };
};

/* 按位置序号 + 文字全等配对,规避动画中途态造成的元素错配 */
const conform = (a, b, want, tol, byText) => {
  const mb = new Map(b.map((x) => [x[0], x]));
  let ok = 0;
  let all = 0;
  for (const x of a) {
    const y = mb.get(x[0]);
    if (!y) continue;
    if (byText && y[2] !== x[2]) continue;
    if (!x[1]) continue;
    all++;
    if (Math.abs(y[1] / x[1] - want) < tol) ok++;
  }
  return { ok, all, rate: all ? ok / all : 0 };
};

const browser = await chromium.launch();
const fails = [];
const pages = {};
for (const w of [TINY, TABLET, BASE_W, NARROW, WIDE]) {
  pages[w] = await browser.newPage({ viewport: { width: w, height: 1000 } });
}
// R41:改 load 不用 domcontentloaded —— dcl 会让两档落在不同动画瞬态,配对样本静默塌到 7%
const load = async (w, route) => {
  await pages[w].goto(base + route, { waitUntil: 'load' });
  return pages[w].evaluate(readAll);
};

let minE = Infinity;
let minG = Infinity;

for (const route of routes) {
  const t = await load(TINY, route);
  const tb = await load(TABLET, route);
  const b0 = await load(BASE_W, route);
  const n = await load(NARROW, route);
  const d = await load(WIDE, route);
  if (n.contentW === null || d.contentW === null) {
    fails.push(route + ':页面无 <main>,无法判定');
    continue;
  }

  const gut = Math.max(0, (d.client - CANVAS) / 2);
  const ratio = n.contentW > 0 ? d.contentW / n.contentW : 0;
  if (ratio < MIN_RATIO)
    fails.push('A 塌缩 ' + route + ':正文列 1920px→' + n.contentW + ' / 2560px→' + d.contentW + '(仅剩 ' + (ratio * 100).toFixed(1) + '%)');
  if (d.padL + d.marginL < gut - 1)
    fails.push('B 留白 ' + route + ':main 左侧位移 ' + (d.padL + d.marginL).toFixed(1) + ' < 画布留白 ' + gut.toFixed(1));
  if (d.contentW > CANVAS + 1) fails.push('C 封顶 ' + route + ':2560px 下正文盒宽 ' + d.contentW + ' > 画布 ' + CANVAS);

  for (const pair of [[WIDE, d], [TINY, t]]) {
    if (pair[1].over.length) fails.push('D 溢出 ' + route + ' @' + pair[0] + ':元素越界 ' + pair[1].over.join(' ; '));
  }

  const e = conform(b0.leaves, n.leaves, SCALE, 0.02, true);
  minE = Math.min(minE, e.all);
  if (e.all < MIN_SAMPLES)
    fails.push('E 样本 ' + route + ':字号可比样本仅 ' + e.all + '(应 >=' + MIN_SAMPLES + ')——判据形同虚设,不许算过');
  else if (e.rate < MIN_CONFORM_E)
    fails.push('E 等比 ' + route + ':字号 1440→1920 达标 ' + (e.rate * 100).toFixed(1) + '%(' + e.ok + '/' + e.all + ')——有尺寸没走画布单位');

  const fr = conform(n.leaves, d.leaves, 1, 0.02, true);
  if (fr.all >= MIN_SAMPLES && fr.rate < MIN_CONFORM_F)
    fails.push('F 冻结 ' + route + ':字号 1920→2560 恒等仅 ' + (fr.rate * 100).toFixed(1) + '%(' + fr.ok + '/' + fr.all + ')——有尺寸击穿 1920 封顶');

  // G 用「冻结盒计数」而非达标率:一两个写死宽度的盒子淹没在达标率里(R41 红测实证 —— 证书
  // 退回写死 330px,达标率仍 >85%,判据放行)。任何 1440→1920 宽度纹丝不动的盒子 = 写死了宽。
  const mb = new Map(n.boxes.map((x) => [x[0], x]));
  const frozen = [];
  let gAll = 0;
  for (const x of b0.boxes) {
    const y = mb.get(x[0]);
    if (!y || !x[1]) continue;
    gAll++;
    if (Math.abs(y[1] / x[1] - 1) < 0.005) frozen.push(x[1] + 'px');
  }
  minG = Math.min(minG, gAll);
  if (frozen.length)
    fails.push('G 盒子 ' + route + ':' + frozen.length + ' 个盒子在 1440→1920 宽度纹丝不动(' + frozen.slice(0, 4).join(' ') + ')——写死了宽,没走画布单位');

  for (const pair of [[TINY, t], [TABLET, tb]]) {
    if (pair[1].contentW !== null && pair[1].contentW < 200)
      fails.push('H 窄屏 ' + route + ' @' + pair[0] + ':正文列仅 ' + pair[1].contentW + 'px(<200)——窄屏被内边距挤没');
  }
}

await browser.close();
child?.kill();

if (fails.length) {
  console.log('[geo] ✗ 画布几何:' + routes.length + ' 条路由,' + fails.length + ' 条判据不合格');
  for (const f of fails.slice(0, 24)) console.log('      ' + f);
  if (fails.length > 24) console.log('      …另有 ' + (fails.length - 24) + ' 条');
  process.exit(2);
}
console.log(
  '[geo] ✓ 画布几何:' + routes.length + ' 路由 × {390,768,1440,1920,2560} 八判据全过' +
    '(A塌缩/B留白/C封顶/D溢出/E等比/F冻结/G盒子/H窄屏;最小样本 字号' + minE + ' 盒子' + minG + ')',
);
process.exit(0);
