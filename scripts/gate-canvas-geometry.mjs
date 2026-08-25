/* 第七门 · 画布几何(运行时) — R39 立
   缘起:R39 把「画布 1920 封顶 + 居中」的留白加成了内边距,而全站 box-sizing:border-box,
   于是三个写死 max-width:780px 的内页在 2560 视口下正文被挤成 33.2px 宽(24/33 路由不可读)。
   六道静态门全绿——**不是门坏了,是这道门不存在**:那六门查的是文本与 token,没有一门看渲染盒子。

   为什么必须是运行时门:该缺陷不溢出、不裁切、不报错、源码 grep 也看不出来
   (每个声明单独看都对,坏在「max-width + border-box + 留白进 padding」三者相乘)。
   只有真渲染出来量盒子才抓得到。

   四条判据(覆盖三类同型事故):
     A 塌缩  2560 正文列宽 ≥ 1920 正文列宽 × 0.95   ← 留白吃掉内容
     B 留白  每页 main 左内边距 ≥ 画布留白           ← 新增内页漏加 / 被简写盖掉
     C 封顶  2560 正文盒宽 ≤ 1920                    ← 忘了封顶,超宽屏越拉越大
     D 溢出  2560 下无横向溢出
     E 等比  1440→1920 可见文字字号比值 ≈1.3333(守住「一切尺寸走画布单位」,不被裸像素值绕过)

   用法:node scripts/gate-canvas-geometry.mjs [--reuse <port>] [--no-build]
   退出码:0 通过 · 2 有路由不合格 · 3 跑不起来(playwright 缺失等,由调用方决定降级口径) */
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

const CANVAS = 1920; // 画布封顶宽(=参考站 1440 基准 ×1.3333)
const WIDE = 2560;
const NARROW = 1920;
const MIN_RATIO = 0.95;
const BASE_W = 1440;      // 设计画布宽
const SCALE = 1920 / 1440; // 1920 处应有的等比倍率
const MIN_CONFORM = 0.92;  // 单条路由等比达标率下限(留动画中途态噪声余量)

/* ── playwright:本仓无依赖,借 uniapp 的(与仓内其它探针同口径) ── */
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

/* ── 产物:默认自建自起,不依赖外部先决条件(产物是静态文件,build 覆盖即新) ── */
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
  // astro preview 是**单例守护进程**:已有实例时它拒绝起第二个,只在 stdout 报出既有地址。
  // 复用既有实例是安全的——预览是静态文件服务,上面刚 build 过,dist 即新。
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

/* ── 路由清单从 sitemap 取(避免手写漏页;新增页面自动进门) ── */
const smPath = join(ROOT, 'dist', 'sitemap-0.xml');
if (!existsSync(smPath)) {
  child?.kill();
  console.log('[geo] NOT-RUN:找不到 dist/sitemap-0.xml');
  process.exit(3);
}
const routes = [...readFileSync(smPath, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)]
  .map((m) => m[1].replace(/^https?:\/\/[^/]+/, ''))
  .map((p) => (p.endsWith('/') || p.includes('.') ? p : p + '/'));

const readLeaves = () => {
  const o = [];
  document.querySelectorAll('*').forEach((el, i) => {
    if (el.children.length) return;                        // 只取叶子
    const t = (el.textContent || '').trim(); if (!t) return; // 必须真显示文字
    const b = el.getBoundingClientRect(); if (b.width < 2 || b.height < 2) return;
    o.push([i, Math.round(parseFloat(getComputedStyle(el).fontSize) * 100) / 100, t.slice(0, 40)]);
  });
  return o;
};

const readMain = () => {
  const m = document.querySelector('main');
  if (!m) return null;
  const cs = getComputedStyle(m);
  const r = m.getBoundingClientRect();
  const padL = parseFloat(cs.paddingLeft) || 0;
  const de = document.documentElement;
  return {
    contentW: +(r.width - padL - (parseFloat(cs.paddingRight) || 0)).toFixed(1),
    padL: +padL.toFixed(1),
    marginL: +(parseFloat(cs.marginLeft) || 0).toFixed(1),
    overflow: de.scrollWidth - de.clientWidth,
    client: de.clientWidth,
  };
};

const browser = await chromium.launch();
const fails = [];
const pages = {};
for (const w of [BASE_W, NARROW, WIDE]) pages[w] = await browser.newPage({ viewport: { width: w, height: 1000 } });

for (const route of routes) {
  const got = {};
  for (const w of [NARROW, WIDE]) {
    await pages[w].goto(base + route, { waitUntil: 'domcontentloaded' });
    got[w] = await pages[w].evaluate(readMain);
  }
  const n = got[NARROW];
  const d = got[WIDE];
  if (!n || !d) {
    fails.push(`${route}:页面无 <main>,无法判定`);
    continue;
  }
  // 画布留白 = (视口 − 画布)/2;内页 main 另有自身 --x-pad,故只判「不少于」
  const gut = Math.max(0, (d.client - CANVAS) / 2);
  const ratio = n.contentW > 0 ? d.contentW / n.contentW : 0;
  if (ratio < MIN_RATIO)
    fails.push(`A 塌缩 ${route}:正文列 ${NARROW}px→${n.contentW} / ${WIDE}px→${d.contentW}(仅剩 ${(ratio * 100).toFixed(1)}%)`);
  if (d.padL + d.marginL < gut - 1)
    fails.push(`B 留白 ${route}:main 左侧位移 ${(d.padL + d.marginL).toFixed(1)} < 画布留白 ${gut.toFixed(1)}`);
  if (d.contentW > CANVAS + 1) fails.push(`C 封顶 ${route}:${WIDE}px 下正文盒宽 ${d.contentW} > 画布 ${CANVAS}`);
  // E 等比:只比「同一位置且文字相同」的叶子,规避动画中途态造成的元素错配
  await pages[BASE_W].goto(base + route, { waitUntil: 'domcontentloaded' });
  const L0 = await pages[BASE_W].evaluate(readLeaves);
  const L1 = await pages[NARROW].evaluate(readLeaves);
  const m1 = new Map(L1.map((x) => [x[0], x]));
  let okN = 0, allN = 0;
  for (const x of L0) {
    const y = m1.get(x[0]);
    if (!y || y[2] !== x[2] || !x[1]) continue;
    allN++;
    if (Math.abs(y[1] / x[1] - SCALE) < 0.02) okN++;
  }
  if (allN >= 8 && okN / allN < MIN_CONFORM)
    fails.push(`E 等比 ${route}:1440→1920 字号等比达标率仅 ${((okN / allN) * 100).toFixed(1)}%(应 ≥${MIN_CONFORM * 100}%)——有尺寸没走画布单位`);
  if (d.overflow > 1) fails.push(`D 溢出 ${route}:${WIDE}px 下横向溢出 ${d.overflow}px`);
}

await browser.close();
child?.kill();

if (fails.length) {
  console.log(`[geo] ✗ 画布几何:${routes.length} 条路由中 ${new Set(fails.map((f) => f.split(' ')[1])).size} 条不合格`);
  for (const f of fails.slice(0, 24)) console.log(`      ${f}`);
  if (fails.length > 24) console.log(`      …另有 ${fails.length - 24} 条`);
  process.exit(2);
}
console.log(`[geo] ✓ 画布几何:${routes.length} 条路由 × {${BASE_W},${NARROW},${WIDE}} 五判据全过(A 塌缩 / B 留白 / C 封顶 / D 溢出 / E 等比)`);
process.exit(0);
