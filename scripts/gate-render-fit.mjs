/* 门:版面在真渲染下不能自相矛盾 —— 五条判据一起判。
 *   A 行间:相邻两行的墨(含变音符与下点)不能相接;
 *   B 层间:首屏文字的墨不能钻进导航的磨砂蒙版底下;
 *   C 声明:`--x-nav-h` 的声明值必须等于导航的实测高;
 *   D 单调:视口变窄时字号不能变大(分档版式两套梯子在断点处对不齐);
 *   E 弹层:打开的 <dialog> 在每一档视口里都要装得下。
 *
 * 🔴 还有一条不叫判据、但比判据更要紧的东西:**观测面缺口一律判红(exit 3)**。
 *    判据写得再对,取样时刻 / 采样面 / 统计量不对,就是假绿。三次实证:
 *      · A 在 resize 后只等 40ms,而揭示动效那时还没还原 —— 60 次扫描 33 次看不到首屏标题,
 *        那里真有 4.4px 墨相接,门却报绿;
 *      · A/D 只在 height=900 跑,而站内有 4 个高度断点会换字号梯子;
 *      · 灯箱只在 390×844 一个尺寸验过,按推导视口全扫有 106 个组合装不下。
 *    所以现在:扫描前先把页面滚一遍让动效落终态,量不到的元素由门自己报出来,弹层开不起来也判红。
 *
 * 这门是 `gate-vi-line-fit` 的重做。上一版三天内被独立评审抓出同一种病**三次**:
 *   · 例外逐个组件写(漏 8 处)· 门的路由表手写(漏 9 条路由)· 探针的视口表手写(漏「宽屏 × 矮视口」那一格)。
 * 共同根因是**判据依赖枚举**,而枚举封不住开放集合 —— 这正是这门本来要治的病,门自己却得了三遍。
 * 重做的三条构造性替代:
 *   ① 路由 ← 从构建产物枚举(路由是产物的事实,不该手抄);
 *   ② 视口 ← 从产物 CSS **自己的断点**推导(每个断点两侧各取一格,再加地板与天花板)——
 *      断点是版面自己声明的「这里行为会变」,比任何人手挑的机型表都贴切;
 *   ③ 判据 ← 用 canvas 量**该元素自己的那串字、自己的字体**的实际墨高,与行步/蒙版底沿直接比。
 *      没有魔数、没有字体表。实测 Space Mono 1.22 / Funnel Display 1.15 / Be Vietnam Pro 1.37 倍字号 ——
 *      上一版那个「1.3」既漏了 Be Vietnam Pro,写在注释里的依据本身也是错的。
 * 因为判据是物理的,它对英文天然成立(拉丁字墨矮),所以**不再限定语言**,全站一起判。
 *
 * 豁免只有两条(写出来是为了让「放宽」这件事必须解释):
 *   · 只渲染一行的元素 —— 行距只在相邻行之间才有意义。
 *   · 元素级逃生阀:class `line-fit-ok`(留在 DOM 里看得见,不像注释那样隐形)。
 * 🔴 **「断行是作者写死的」曾经是一条豁免,已删除**:墨相撞就是相撞,与断行是谁写的无关。
 *    那条豁免整块放过了撞得最狠的一处 —— 首屏大标题(独立评审逐行实测行间 −29.2px),
 *    而门当时报绿。判据放宽一寸,就有一整族从这一寸里溜走。
 *
 * 用法:node scripts/gate-render-fit.mjs              自带静态服务伺服 dist/(verify 走这条)
 *      node scripts/gate-render-fit.mjs <baseUrl>   打一个已在跑的服务(手工复验)
 *      node scripts/gate-render-fit.mjs --self-test 证明它对该红的会红、对该绿的不红
 */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
const require = createRequire('D:/WORKS/PLAN/Nexion-uniapp/package.json');
const { chromium } = require('playwright');

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const DIST = join(ROOT, 'dist');
const EXPLICIT = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2].replace(/\/$/, '') : null;

/* ── ① 路由:从产物枚举 ── */
const allRoutes = () => {
  const out = [];
  (function walk(dir, base = '') {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, base + '/' + e);
      else if (e === 'index.html') out.push((base || '') + '/');
    }
  })(DIST);
  return out.sort();
};

/* ── ② 视口:从产物 CSS 自己的断点推导 ── */
const breakpoints = () => {
  const w = new Set([320, 1920]); // 地板与天花板:最窄在用机型 / 画布封顶
  const h = new Set([360, 900]);
  let found = 0;
  const add = (dim, op, v) => {
    const set = dim === 'width' ? w : h;
    v = Math.round(v);
    found++;
    // 断点两侧各取一格:分档错位一般只在边界一像素处露出来
    if (op === 'max') { set.add(v); set.add(v + 1); } else { set.add(v); set.add(v - 1); }
  };
  const css = [];
  const dir = join(DIST, '_astro');
  for (const f of readdirSync(dir)) if (f.endsWith('.css')) css.push(readFileSync(join(dir, f), 'utf8'));
  // 组件样式可能被内联进 HTML,外部 CSS 里找不到 —— 两处都要扫
  for (const r of allRoutes()) {
    const html = readFileSync(join(DIST, r, 'index.html'), 'utf8');
    for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) css.push(m[1]);
  }
  for (const text of css) {
    // 老写法 (max-width: 860px)
    for (const m of text.matchAll(/\((max|min)-(width|height)\s*:\s*([\d.]+)px\)/g)) add(m[2], m[1], +m[3]);
    // 压缩器会改写成现代区间写法 (width<=860px) —— 只认老写法会静默扫出 0 个
    for (const m of text.matchAll(/\((width|height)\s*(<=|>=|<|>)\s*([\d.]+)px\)/g)) {
      const v = +m[3];
      if (m[2] === '<=') add(m[1], 'max', v);
      else if (m[2] === '<') add(m[1], 'max', v - 1);
      else if (m[2] === '>=') add(m[1], 'min', v);
      else add(m[1], 'min', v + 1);
    }
    // 双侧区间 (600px<=width<=900px)
    for (const m of text.matchAll(/\(([\d.]+)px\s*<=?\s*(width|height)\s*<=?\s*([\d.]+)px\)/g)) {
      add(m[2], 'min', +m[1]);
      add(m[2], 'max', +m[3]);
    }
  }
  // 🔴 一个都没扫到 = 判据没对上产物的写法(压缩器改了语法、或 CSS 挪了地方),
  //    这时若拿「地板 + 天花板」照跑,门会报绿而其实什么断点都没测 —— 必须判失败,不许静默降级。
  if (!found) {
    console.log('[render-fit] NOT-RUN:在产物里一个媒体断点都没解析出来,判据与产物写法对不上,拒绝以「只测地板天花板」冒充覆盖');
    process.exit(3);
  }
  const clean = (s) => [...s].filter((v) => v >= 320 && v <= 2560).sort((a, b) => a - b);
  return { widths: clean(w), heights: clean(h), found };
};

/* ── ③ A 判据:行间墨迹(**逐行**量,不是整串量) ──
   为什么必须逐行:整串量会同时误报与漏报。上一行若没有下点、下一行若没有帽子,即使整串的墨很高
   两行也不会相撞(误报);反过来,只看整串会让「作者写死断行」的大标题被整块豁免掉,
   而它恰恰是撞得最狠的一处(独立评审逐行实测首屏 vi 标题行间 −29.2px,我的整串判据把它放过了)。
   逐行的算法:每一行取出它自己的那段字 → 用该元素的字体量这段字的实际上伸/下伸 →
   上一行的墨底与下一行的墨顶比,负数就是相接。 */
const SCAN_LINES = () => {
  const c = document.createElement('canvas').getContext('2d');
  const out = [];
  /* 🔴 观测面缺口计数:一个元素**本该被量却量不到**时,不许静默跳过 —— 记下来,由调用方判红。
     出处:判据 A 曾对**所有** `[data-lr]` 宿主结构性失明。揭示动效会把宿主的文本拆进
     `.lr-line` 子元素里,于是宿主没有直接文本节点(跳过),每个 `.lr-line` 只有一行(跳过)。
     门在 resize 后只等 40ms、又按宽度升序扫,前 11 档全落在「还没还原」的窗口内 ——
     实测 60 次扫描里 33 次看不到首屏标题,而 `/ @320` 英文标题真有 4.4px 的墨相接,门却报绿。
     判据写得再对,取样时刻不对就是假绿;所以现在由门自己报告「我漏看了几个」。 */
  const blind = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('.line-fit-ok')) continue;
    if (/^(SCRIPT|STYLE|CANVAS|IMG|BR|HR|NOSCRIPT|SELECT|OPTION|TITLE)$/.test(el.tagName)) continue;
    if (el.namespaceURI && el.namespaceURI.indexOf('svg') >= 0) continue;
    const nodes = [];
    for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) nodes.push(n);
    if (!nodes.length) {
      // 揭示动效的宿主:文本被搬进子元素了,此刻量不到 —— 这是观测面缺口,不是「没有文本」
      if (el.matches('[data-lr], [data-tw]') && el.textContent.trim()) {
        const cls = typeof el.className === 'string' ? el.className : '';
        blind.push(el.tagName.toLowerCase() + (cls ? '.' + cls.trim().split(/\s+/).join('.') : ''));
      }
      continue;
    }
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const fs = parseFloat(cs.fontSize);
    if (!(fs > 0)) continue;
    const font = `${cs.fontStyle} ${cs.fontWeight} ${fs}px ${cs.fontFamily}`;
    c.font = font;
    const fm = c.measureText('Hg');
    const A = fm.fontBoundingBoxAscent || fs * 0.8;
    const D = fm.fontBoundingBoxDescent || fs * 0.2;
    // 先按行盒顶端把每个字符归到它所在的行(字符级 Range,只对真的多行的元素做)
    const lines = new Map(); // top -> {text, top}
    let chars = 0;
    for (const n of nodes) {
      const s = n.textContent;
      for (let i = 0; i < s.length && chars < 600; i++, chars++) {
        if (!s[i].trim()) continue;
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + 1);
        const rect = r.getBoundingClientRect();
        if (!rect.height) continue;
        const key = Math.round(rect.top);
        if (!lines.has(key)) lines.set(key, { top: rect.top, h: rect.height, text: '' });
        lines.get(key).text += s[i];
      }
    }
    if (lines.size < 2) continue;
    const arr = [...lines.values()].sort((a, b) => a.top - b.top);
    let worst = null;
    for (let k = 0; k + 1 < arr.length; k++) {
      const up = arr[k];
      const dn = arr[k + 1];
      const step = dn.top - up.top;
      if (!(step > 0)) continue;
      const mu = c.measureText(up.text);
      const md = c.measureText(dn.text);
      // 行盒里的基线位置:半行距 = (行盒高 − 字身高)/2,基线 = 行盒顶 + 半行距 + 上伸
      const baseU = up.top + (up.h - (A + D)) / 2 + A;
      const baseD = dn.top + (dn.h - (A + D)) / 2 + A;
      const inkBottomU = baseU + (mu.actualBoundingBoxDescent || 0);
      const inkTopD = baseD - (md.actualBoundingBoxAscent || 0);
      const gap = inkTopD - inkBottomU;
      if (worst === null || gap < worst.gap) worst = { gap, step, up: up.text.slice(0, 14), dn: dn.text.slice(0, 14) };
    }
    if (!worst || worst.gap >= 0) continue;
    const cls = typeof el.className === 'string' ? el.className : '';
    out.push({
      sel: el.tagName.toLowerCase() + (cls ? '.' + cls.trim().split(/\s+/).join('.') : ''),
      fs: Math.round(fs * 10) / 10,
      step: Math.round(worst.step * 10) / 10,
      gap: Math.round(worst.gap * 10) / 10,
      over: Math.round(-worst.gap * 10) / 10,
      lines: arr.length,
      text: `${worst.up}⏎${worst.dn}`,
    });
  }
  return { hits: out, blind };
};

/* ── ③ B 判据:首屏文字的墨 vs 导航蒙版底沿 ── */
const SCAN_NAV = () => {
  const nav = document.querySelector('.site-nav');
  if (!nav) return [];
  const navBottom = nav.getBoundingClientRect().bottom;
  const c = document.createElement('canvas').getContext('2d');
  const out = [];
  const hero = document.querySelector('.hero') || document.querySelector('main');
  if (!hero) return [];
  for (const el of hero.querySelectorAll('*')) {
    if (el.closest('.line-fit-ok')) continue;
    let text = '';
    for (const n of el.childNodes) if (n.nodeType === 3) text += n.textContent;
    if (!text.trim()) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) continue;
    // 朗读器专用文本(1px 裁切法)对看得见的人不存在,不参与遮挡判定
    const box = el.getBoundingClientRect();
    if (box.width <= 2 || box.height <= 2) continue;
    if (cs.clip && cs.clip !== 'auto') continue;
    const r = document.createRange();
    r.selectNodeContents(el);
    const rects = [...r.getClientRects()].filter((x) => x.height > 0);
    if (!rects.length) continue;
    const first = rects.reduce((a, b) => (b.top < a.top ? b : a));
    const fs = parseFloat(cs.fontSize);
    const step = cs.lineHeight === 'normal' ? first.height : parseFloat(cs.lineHeight);
    c.font = `${cs.fontStyle} ${cs.fontWeight} ${fs}px ${cs.fontFamily}`;
    const m = c.measureText(text.trim().slice(0, 200));
    // 墨顶 = 行盒顶 + 半行距 − 上伸墨高。行高 < 1 时半行距为负,墨会**冒出行盒**。
    const halfLead = (step - fs) / 2;
    const baseline = first.top + halfLead + (m.fontBoundingBoxAscent || fs * 0.8);
    const inkTop = baseline - (m.actualBoundingBoxAscent || fs * 0.75);
    if (inkTop >= navBottom - 0.5) continue;
    const cls = typeof el.className === 'string' ? el.className : '';
    out.push({
      sel: el.tagName.toLowerCase() + (cls ? '.' + cls.trim().split(/\s+/).join('.') : ''),
      navBottom: Math.round(navBottom * 10) / 10,
      inkTop: Math.round(inkTop * 10) / 10,
      under: Math.round((navBottom - inkTop) * 10) / 10,
      text: text.trim().split(/\s+/).join(' ').slice(0, 28),
    });
  }
  return out;
};

/* ── ③ C 判据:导航高度的**声明值**必须等于**实测值** ──
   B 的修法是让首屏上内衬从 `--x-nav-h` 派生,而不是各写各的常数。但派生只解决「两处同步」,
   不解决「那个数本身对不对」—— 导航高是内容撑出来的(字标 + 内衬),改字标尺寸它就变,
   而 tokens 里的声明不会自动跟。所以声明必须被实测钉住,否则这个「单一真源」只是换了个地方写死。 */
const SCAN_NAVH = () => {
  const nav = document.querySelector('.site-nav');
  if (!nav) return null;
  const declared = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--x-nav-h'));
  /* 🔴 两个坑叠在一起,都会让这条判据变成「永远红」的假红:
     ① zoom 不能读 `--x-zoom` —— 自定义属性取到的是**声明原文**(那串 calc),parseFloat 得 NaN;
     ② 也不能沿祖先找 —— 导航在画布壳**外面**、自套一份画布,缩放在它的**子元素**上,祖先全是 1。
     所以向下找第一个真正带缩放的后代。 */
  let zoom = 1;
  for (const e of [nav, ...nav.querySelectorAll('*')]) {
    const z = parseFloat(getComputedStyle(e).zoom);
    if (z && z !== 1) { zoom = z; break; }
  }
  const measured = nav.getBoundingClientRect().height;
  if (!(declared > 0)) return { err: '未声明 --x-nav-h' };
  const expect = declared * zoom;
  return { declared, zoom: Math.round(zoom * 1e4) / 1e4, measured: Math.round(measured * 10) / 10,
    expect: Math.round(expect * 10) / 10, diff: Math.round((measured - expect) * 10) / 10 };
};

/* ── ③ D 判据:视口变窄时字号不许变大 ──
   分档版式有两套梯子(桌面按 --u 随视口线性长 / 窄屏按 vw 另起一套),两套在断点处不会自己对齐:
   首屏大标题在 861px 是 60.3px,在 860px 反而是 88px —— 窄一个像素反而大 46%。
   两侧**单独看都很正常**,只有把断点两侧摆在一起才看得出来,所以人工走查天然扫不到这一族
   (实测它在四十多轮走查里活了下来,直到有人把两个截图并排放)。
   判据是纯物理的:同一个元素,视口更窄不该让它更大。**不列元素清单**,全站文字元素一起判;
   宽度档沿用②推导出来的那一份(断点两侧各一格),所以新加断点自动被覆盖。
   键用 DOM 路径,两档宽下都取得到才比;取不到的(分档隐藏 / 拆行遮罩重建)跳过,不制造假红。 */
const SCAN_SIZES = () => {
  const key = (el) => {
    const parts = [];
    let n = el;
    while (n && n !== document.body && n.parentElement) {
      const p = n.parentElement;
      const same = [...p.children].filter((c) => c.tagName === n.tagName);
      parts.unshift(n.tagName.toLowerCase() + (same.length > 1 ? ':' + (same.indexOf(n) + 1) : ''));
      n = p;
    }
    return parts.join('>');
  };
  const out = {};
  for (const el of document.querySelectorAll('body *')) {
    if (/^(SCRIPT|STYLE|CANVAS|IMG|BR|HR|NOSCRIPT|SELECT|OPTION|TITLE)$/.test(el.tagName)) continue;
    if (el.namespaceURI && el.namespaceURI.indexOf('svg') >= 0) continue;
    if (el.closest('.size-jump-ok')) continue;
    /* 拆行遮罩里的临时 span 随宽度重建,键天然不稳定 —— 只判宿主自己。
       宿主在未播状态下没有直接文本节点,所以对宿主放行文本要求,直接读它的字号(拆出来的行继承它)。 */
    const isHost = el.matches('[data-lr]');
    if (!isHost && el.parentElement && el.parentElement.closest('[data-lr]')) continue;
    let text = '';
    for (const n of el.childNodes) if (n.nodeType === 3) text += n.textContent;
    if (!isHost && !text.trim()) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const box = el.getBoundingClientRect();
    if (box.width <= 2 || box.height <= 2) continue;
    const cls = typeof el.className === 'string' ? el.className : '';
    out[key(el)] = {
      fs: Math.round(parseFloat(cs.fontSize) * 100) / 100,
      lh: Math.round((parseFloat(cs.lineHeight) || 0) * 100) / 100,
      sel: el.tagName.toLowerCase() + (cls ? '.' + cls.trim().split(/\s+/).join('.') : ''),
      text: (text.trim() || el.textContent.trim()).split(/\s+/).join(' ').slice(0, 24),
    };
  }
  return out;
};
/* ── ③ E 判据:打开的弹层必须在视口里装得下 ──
   出处:把手机端证书灯箱从「按原件 1160 出图、横向平移」改成适宽时,只修了横轴。
   我的探针只测了 390×844 一个尺寸,于是横屏与平板整面没被看到 —— 按推导视口全扫,**106 个组合装不下**。
   同一族第 3 次(判据靠手挑的一张清单),所以这次不写探针,写门。
   弹层从 DOM 枚举(不列清单),开启件按本仓的 [data-src] 标记找,找不到就退回 showModal();
   开不起来的弹层记成观测面缺口判红 —— 「打不开所以没测到」不许当成「没问题」。 */
const OPEN_ONE = (idx) => {
  const dialogs = [...document.querySelectorAll('dialog')];
  for (const d of dialogs) if (d.open) d.close();
  const d = dialogs[idx];
  if (!d) return { ok: false, why: '取不到这个弹层' };
  /* 🔴 必须走**真实开启件**,不许退回 showModal():弹层里的图 src 是开启时由脚本写进去的,
     直接 showModal 会量到一张空图,而空图必然装得下 —— 那是假绿,不是通过。
     (上一版就是这么写的,独立评审当场指出:失败模式是假绿而不是判红。)
     候选面也不写死成某一个属性:凡「可能打开东西」的件都试,试到某个弹层真开为止;
     一个都开不起来 → 返回失败,由调用方记成观测面缺口判红。 */
  const cand = [...document.querySelectorAll(
    '[data-src], button, summary, [aria-haspopup], a[href$=".png"], a[href$=".jpg"], a[href$=".webp"]',
  )];
  for (const el of cand) {
    try { el.click(); } catch { /* 个别件点了会抛,继续试下一个 */ }
    if (d.open) return { ok: true, via: 'opener' };
    for (const x of dialogs) if (x.open) x.close();
  }
  return { ok: false, why: `找不到能打开它的件(试了 ${cand.length} 个候选);拒绝用 showModal() 冒充 —— 那样量到的是一张空图` };
};
const MEASURE_OPEN = () => {
  const out = [];
  for (const d of document.querySelectorAll('dialog')) {
    if (!d.open) continue;
    const r = d.getBoundingClientRect();
    const cls = typeof d.className === 'string' ? d.className : '';
    const px = (v) => Math.round(Math.max(0, v) * 10) / 10;
    out.push({
      sel: 'dialog' + (cls ? '.' + cls.trim().split(/\s+/).join('.') : ''),
      overY: Math.round((d.scrollHeight - d.clientHeight) * 10) / 10,
      overX: Math.round((d.scrollWidth - d.clientWidth) * 10) / 10,
      // 四条边都量:只量右下会让「顶出视口上缘 / 左缘」的弹层拿 0 分(独立评审指出)
      offBottom: px(r.bottom - innerHeight),
      offRight: px(r.right - innerWidth),
      offTop: px(-r.top),
      offLeft: px(-r.left),
    });
  }
  return out;
};

/* 1% 是 vw 制字号的亚像素噪声带(同一条 clamp 在相邻两档宽下本来就差零点几个百分点),
   不是给「小台阶」留的口子:这一族的成因是两套梯子各算各的,差距一向是两位数百分比。 */
const SIZE_TOL = 0.01;
/* 比较写成函数,自检跑的就是**这一份**判据本身,不是它的一份手抄件(手抄件会各自漂) */
const sizeViolations = (narrowSizes, wideSizes) => {
  const out = [];
  for (const [key, wide] of Object.entries(wideSizes)) {
    const narrow = narrowSizes[key];
    if (!narrow || !(wide.fs > 0)) continue;
    if (narrow.fs <= wide.fs * (1 + SIZE_TOL)) continue;
    out.push({ key, sel: narrow.sel, text: narrow.text, narrowFs: narrow.fs, wideFs: wide.fs,
      pct: Math.round(((narrow.fs - wide.fs) / wide.fs) * 1000) / 10 });
  }
  return out;
};

/* ── 自检 ── */
const FIXTURE = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><style>
  /* 0.7 与 2.4 是刻意选在「任何字体都过不了 / 任何字体都过得了」的两侧 ——
     夹具若挑一个贴近门槛的值,红不红会取决于本机装了什么字体,那样测的就不是判据了。 */
  body { margin: 0; width: 300px; font-family: monospace; }
  p { font-size: 16px; }
  .bad { line-height: 0.7; }
  .good { line-height: 2.4; }
  .authored { line-height: 0.7; white-space: pre-line; }
  .esc { line-height: 0.7; }
  .short { line-height: 0.7; }
  .nowrap { line-height: 0.7; white-space: nowrap; }
</style></head><body>
  <p class="bad">Nhà cung cấp dịch vụ chia sẻ năng lực tính toán cho mạng lưới AI phân tán</p>
  <p class="good">Nhà cung cấp dịch vụ chia sẻ năng lực tính toán cho mạng lưới AI phân tán</p>
  <p class="authored">Nhà cung cấp dịch vụ
chia sẻ năng lực tính toán</p>
  <p class="esc line-fit-ok">Nhà cung cấp dịch vụ chia sẻ năng lực tính toán cho mạng lưới AI phân tán</p>
  <p class="short">Ngắn</p>
  <p class="nowrap">Nhà cung cấp dịch vụ chia sẻ năng lực tính toán cho mạng lưới AI phân tán</p>
</body></html>`;

/* D 的夹具:同一份文档在两档宽下量。h1 窄档反而大(该红)、h2 窄档更小(不该红)、
   h3 两档一样(不该红)。数值挑成 3 倍差,任何字体 / 亚像素都翻不了案。 */
const FIXTURE_D = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
  body { margin: 0; font-family: monospace; }
  h1, h2, h3 { font-size: 20px; }
  @media (max-width: 500px) { h1 { font-size: 60px; } h2 { font-size: 7px; } }
</style></head><body><h1>reverse</h1><h2>forward</h2><h3>flat</h3></body></html>`;

if (process.argv.includes('--self-test')) {
  const b = await chromium.launch();
  const c = await b.newContext({ viewport: { width: 320, height: 700 }, deviceScaleFactor: 1 });
  const p = await c.newPage();
  await p.setContent(FIXTURE, { waitUntil: 'load' });
  const scanned = await p.evaluate(SCAN_LINES);
  const names = scanned.hits.map((f) => f.sel).join(' ');
  // 观测面缺口自检:文本被搬进子元素的揭示宿主必须被记成 blind,而不是静默跳过
  await p.setContent(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body>' +
      '<h1 data-lr><span class="lr-line">one</span><span class="lr-line">two</span></h1>' +
      '<h2><span>plain wrapper</span></h2></body></html>',
    { waitUntil: 'load' },
  );
  const blindCase = await p.evaluate(SCAN_LINES);
  // D:同一份文档,窄档 400 与宽档 600 各量一次,走的是主循环用的同一个 sizeViolations
  await p.setContent(FIXTURE_D, { waitUntil: 'load' });
  await p.setViewportSize({ width: 400, height: 700 });
  const dNarrow = await p.evaluate(SCAN_SIZES);
  await p.setViewportSize({ width: 600, height: 700 });
  const dWide = await p.evaluate(SCAN_SIZES);
  const dHit = sizeViolations(dNarrow, dWide).map((v) => v.sel).join(' ');
  await b.close();
  const expect = [
    ['① 行距不足的多行文本 → 抓到', names.indexOf('bad') >= 0],
    ['② 行距够的不抓', names.indexOf('good') < 0],
    // ③ 作者写死断行**不豁免**:墨相撞就是相撞,与断行是谁写的无关。
    //    上一版按「作者断行」整块豁免,结果放过了撞得最狠的首屏大标题(独立评审逐行实测 −29.2px)。
    ['③ 作者写死断行的也要抓(不豁免)', names.indexOf('authored') >= 0],
    ['④ 逃生阀 line-fit-ok 生效', names.indexOf('esc') < 0],
    ['⑤ 短文本不判(折不了行)', names.indexOf('short') < 0],
    ['⑥ nowrap 不判(不会折行)', names.indexOf('nowrap') < 0],
    ['⑦ D 窄档反而更大 → 抓到', dHit.indexOf('h1') >= 0],
    ['⑧ D 窄档更小 → 不抓', dHit.indexOf('h2') < 0],
    ['⑨ D 两档同尺 → 不抓', dHit.indexOf('h3') < 0],
    ['⑩ 拆行态的揭示宿主记成观测面缺口(不静默跳过)', blindCase.blind.some((b) => b.startsWith('h1'))],
    ['⑪ 普通的 span 包裹不算缺口', !blindCase.blind.some((b) => b.startsWith('h2'))],
  ];
  let bad = 0;
  for (const [n, ok] of expect) { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}`); if (!ok) bad++; }
  console.log(`gate-render-fit 自检: ${expect.length - bad} pass / ${bad} fail`);
  if (bad) console.log('  A 实际抓到:', names || '(空)', '| D 实际抓到:', dHit || '(空)');
  process.exit(bad ? 1 : 0);
}

/* ── 静态服务:dist 是静态文件,起个自己的服务,不跟 astro preview 抢单例 ── */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
const serveDist = async () => {
  const server = createServer(async (req, res) => {
    try {
      const p = decodeURIComponent((req.url || '/').split('?')[0]);
      let file = join(DIST, p);
      const st = await stat(file).catch(() => null);
      if (!st || st.isDirectory()) file = join(DIST, p, 'index.html');
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
};

let server = null;
let BASE = EXPLICIT;
if (!BASE) {
  if (!(await stat(join(DIST, 'index.html')).catch(() => null))) {
    console.log('[render-fit] NOT-RUN:找不到 dist/index.html,先 npm run build');
    process.exit(3);
  }
  server = await serveDist();
  BASE = server.url;
}

const ROUTES = allRoutes();
const { widths, heights } = breakpoints();
// 首屏层间判据只需首页三语,但视口要走全部「宽 × 矮档高」组合
const HOME = ROUTES.filter((r) => r === '/' || r === '/vi/' || r === '/zh/');
const SHORT_H = heights.filter((h) => h <= 900);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const hitsA = new Map();
const hitsB = new Map();
const hitsD = new Map();
const blindSpots = new Map(); // 观测面缺口:本该量却量不到的元素
let scansA = 0;
let heightSensitive = 0;

/* 稳态:先把全页滚一遍,让所有靠进入视口触发的揭示动效放完,再等宿主还原成纯文本。
   放完之后 resize 不会重新拆行(fx 只重拆未播的),所以每条路由做一次就够。
   等不到也不硬等 —— 真正的判决交给 blind 计数,静默跳过才是假绿的来源。 */
const settle = async () => {
  await page.evaluate(async () => {
    const l = window.__lenis || window.lenis;
    const go = (y) => (l && l.scrollTo ? l.scrollTo(y, { immediate: true }) : window.scrollTo(0, y));
    const step = Math.max(200, innerHeight * 0.8);
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      go(y);
      await new Promise((res) => setTimeout(res, 45));
    }
    go(0);
  });
  await page
    .waitForFunction(() => [...document.querySelectorAll('[data-lr], [data-tw]')].every((e) => e.children.length === 0), null, { timeout: 6000 })
    .catch(() => {});
  /* R48 补拍「点名唤醒」:个别宿主会在冲刺滚动里错过 IO(玻璃瓷砖版式让触发时点更挤,
     /vi/ @320 实录一处 h3 未还原)。把还带结构的逐个滚进视口正中再给一轮还原窗;
     仍未还原的才落 blind —— 判据一点不放宽,只是观测面不自己制造盲点。 */
  const stuck = await page.evaluate(() => [...document.querySelectorAll('[data-lr], [data-tw]')].filter((e) => e.children.length > 0).length);
  if (stuck > 0) {
    await page.evaluate(async () => {
      const left = [...document.querySelectorAll('[data-lr], [data-tw]')].filter((e) => e.children.length > 0);
      for (const e of left) {
        e.scrollIntoView({ block: 'center' });
        await new Promise((r) => setTimeout(r, 350));
      }
      window.scrollTo(0, 0);
    });
    await page
      .waitForFunction(() => [...document.querySelectorAll('[data-lr], [data-tw]')].every((e) => e.children.length === 0), null, { timeout: 3000 })
      .catch(() => {});
  }
  await page.waitForTimeout(60);
};

/* 指纹必须带行高:只改 `line-height` 的高度断点会产生完全相同的字号指纹 → 整条路由被判「不敏感」
   → 那些高度档判据 A 一次都不扫,而 A 判的恰恰是行间。今天仓里没有这种规则,写进来是封住它。 */
const fingerprint = (sizes) => Object.entries(sizes).map(([k, v]) => `${k}:${v.fs}/${v.lh}`).join('|');
const scanA = async (r, w, h) => {
  const { hits, blind } = await page.evaluate(SCAN_LINES);
  scansA++;
  for (const x of hits) {
    const k = `${r}|${x.sel}`;
    const prev = hitsA.get(k);
    if (!prev || x.over > prev.over) hitsA.set(k, { ...x, where: `${r} @${w}×${h}` });
  }
  for (const b of blind) if (!blindSpots.has(`${r}|${b}`)) blindSpots.set(`${r}|${b}`, `${r} @${w}×${h}  ${b}`);
};

for (const r of ROUTES) {
  const res = await page.goto(BASE + r, { waitUntil: 'networkidle' }).catch(() => null);
  if (!res || !res.ok()) { hitsA.set('route:' + r, `${r}  路由取不到`); continue; }
  await page.evaluate(() => document.fonts.ready);
  await settle();

  /* 这条路由对**视口高**敏不敏感?在最窄与最宽两档各试一遍全部高度档,版式指纹变了就是敏感。
     不敏感的路由只在 900 扫(与从前一致);敏感的路由按高度分档扫 —— 高度断点会换字号梯子,
     只在 900 扫等于漏掉矮视口整面(判据 A 与 D 从前都只跑 900)。 */
  let sensitive = false;
  for (const refW of [widths[0], widths[widths.length - 1]]) {
    const seen = new Set();
    for (const hh of heights) {
      await page.setViewportSize({ width: refW, height: hh });
      await page.waitForTimeout(35);
      seen.add(fingerprint(await page.evaluate(SCAN_SIZES)));
      if (seen.size > 1) { sensitive = true; break; }
    }
    if (sensitive) break;
  }
  if (sensitive) heightSensitive++;

  let prevW = null;
  let prevSizes = null;
  for (const w of widths) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(40);
    const sizes900 = await page.evaluate(SCAN_SIZES);
    await scanA(r, w, 900);

    if (sensitive) {
      // 同一宽度下,版式完全等价的高度档只量一次(指纹去重),不同的都要量
      const seen = new Set([fingerprint(sizes900)]);
      for (const hh of heights) {
        if (hh === 900) continue;
        await page.setViewportSize({ width: w, height: hh });
        await page.waitForTimeout(35);
        const fp = fingerprint(await page.evaluate(SCAN_SIZES));
        if (seen.has(fp)) continue;
        seen.add(fp);
        await scanA(r, w, hh);
      }
      await page.setViewportSize({ width: w, height: 900 });
      await page.waitForTimeout(30);
    }

    // D:widths 升序,prevW 一定是更窄的那一侧;它的字号更大就是反向跳变
    if (prevSizes) {
      for (const v of sizeViolations(prevSizes, sizes900)) {
        const k = `${r}|${v.key}`;
        const prev = hitsD.get(k);
        if (!prev || v.pct > prev.pct) hitsD.set(k, { ...v, route: r, narrowW: prevW, wideW: w });
      }
    }
    prevW = w;
    prevSizes = sizes900;
  }
}
/* ── E:弹层装不装得下 ── */
const hitsE = new Map();
let dialogRoutes = 0;
for (const r of ROUTES) {
  await page.goto(BASE + r, { waitUntil: 'networkidle' }).catch(() => null);
  const n = await page.evaluate(() => document.querySelectorAll('dialog').length);
  if (!n) continue;
  dialogRoutes++;
  for (let idx = 0; idx < n; idx++) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(60);
    const opened = await page.evaluate(OPEN_ONE, idx);
    if (!opened.ok) { blindSpots.set(`${r}|dialog#${idx}`, `${r}  第 ${idx + 1} 个弹层${opened.why}`); continue; }
    // 开着不关,直接换视口量 —— 每档重开一次既慢又会丢滚动位
    for (const w of widths) {
      for (const hh of heights) {
        await page.setViewportSize({ width: w, height: hh });
        await page.waitForTimeout(35);
        for (const m of await page.evaluate(MEASURE_OPEN)) {
          const worst = Math.max(m.overY, m.overX, m.offBottom, m.offRight, m.offTop, m.offLeft);
          if (worst <= 1) continue;
          const k = `${r}|${m.sel}`;
          const prev = hitsE.get(k);
          if (!prev || worst > prev.worst) hitsE.set(k, { ...m, worst, where: `${r} @${w}×${hh}` });
        }
      }
    }
    await page.evaluate(() => { for (const d of document.querySelectorAll('dialog')) if (d.open) d.close(); });
  }
}

const hitsC = [];
for (const r of HOME) {
  await page.goto(BASE + r, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  for (const w of widths) {
    for (const hh of SHORT_H) {
      await page.setViewportSize({ width: w, height: hh });
      await page.waitForTimeout(40);
      for (const b of await page.evaluate(SCAN_NAV)) {
        const k = `${r}|${b.sel}`;
        const prev = hitsB.get(k);
        if (!prev || b.under > prev.under) hitsB.set(k, { ...b, where: `${r} @${w}×${hh}` });
      }
    }
    // C 只随宽度变(导航高与视口高无关),每档宽核一次
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(40);
    const c = await page.evaluate(SCAN_NAVH);
    if (c && (c.err || Math.abs(c.diff) > 1)) {
      hitsC.push(c.err ? `${r} @${w}  ${c.err}` :
        `${r} @${w}  声明 --x-nav-h=${c.declared} × zoom ${c.zoom} = ${c.expect},实测 ${c.measured}(差 ${c.diff}px)`);
    }
  }
}
await browser.close();
if (server) await server.close();

const A = [...hitsA.values()].sort((a, b) => (b.over || 0) - (a.over || 0));
const B = [...hitsB.values()].sort((a, b) => b.under - a.under);
console.log(`[render-fit] 路由 ${ROUTES.length} 条(从产物枚举)· 宽 ${widths.length} 档 / 矮档高 ${SHORT_H.length} 档(从产物 CSS 断点推导)`);
console.log(`             宽: ${widths.join(' ')}`);
console.log(`             高: ${SHORT_H.join(' ')}`);
const D = [...hitsD.values()].sort((a, b) => b.pct - a.pct);
const E = [...hitsE.values()].sort((a, b) => b.worst - a.worst);
console.log(`             判据 A 实扫 ${scansA} 次(${heightSensitive}/${ROUTES.length} 条路由对视口高敏感,按高度分档加扫)`);
console.log(`             判据 E 覆盖 ${dialogRoutes} 条带弹层的路由 × ${widths.length * heights.length} 档视口`);

/* 🔴 观测面缺口 = NOT-RUN,不是「没问题」。
   判据再对,取样时刻不对就是假绿:曾有 60 次扫描里 33 次看不到首屏标题,而那里真有 4.4px 墨相接。 */
if (blindSpots.size) {
  console.log(`[render-fit] NOT-RUN:${blindSpots.size} 处元素本该量却量不到(揭示动效未还原,文本还在子元素里)`);
  for (const v of [...blindSpots.values()].slice(0, 12)) console.log('  - ' + v);
  if (blindSpots.size > 12) console.log(`  …另有 ${blindSpots.size - 12} 处`);
  console.log('  这不是「没有缺陷」,是**没量到**。修法:延长 settle 等待,或让揭示动效在门里直接落终态。');
  process.exit(3);
}

if (!A.length && !B.length && !hitsC.length && !D.length && !E.length) {
  console.log('[render-fit] ✓ 墨迹无相撞 · 导航高声明=实测 · 字号随视口单调 · 弹层各档视口装得下 · 无观测面缺口');
  process.exit(0);
}
if (hitsC.length) {
  console.log(`[render-fit] ✘ C 导航高:${hitsC.length} 处声明值与实测值对不上(派生常数已漂)`);
  for (const c of hitsC) console.log('  - ' + c);
}
if (A.length) {
  console.log(`[render-fit] ✘ A 行间:${A.length} 处相邻行的墨会相接`);
  for (const h of A) console.log(`  - ${h.where || h}  ${h.sel}  行步 ${h.step} · 墨隙 ${h.gap}(相接 ${h.over}px,字号 ${h.fs},共 ${h.lines} 行)  「${h.text}」`);
}
if (B.length) {
  console.log(`[render-fit] ✘ B 层间:${B.length} 处首屏文字钻到导航蒙版底下`);
  for (const b of B) console.log(`  - ${b.where}  ${b.sel}  墨顶 ${b.inkTop} < 导航底沿 ${b.navBottom}(压 ${b.under}px)  「${b.text}」`);
}
if (D.length) {
  console.log(`[render-fit] ✘ D 反向跳变:${D.length} 处「视口更窄反而字更大」`);
  for (const d of D) {
    console.log(`  - ${d.route} ${d.sel}  ${d.narrowW}px=${d.narrowFs} → ${d.wideW}px=${d.wideFs}(窄侧大 ${d.pct}%)  「${d.text}」`);
  }
}
if (E.length) {
  console.log(`[render-fit] ✘ E 弹层装不下:${E.length} 处在某档视口里溢出或出界`);
  for (const x of E) {
    console.log(`  - ${x.where}  ${x.sel}  盒内需滚 纵 ${x.overY} 横 ${x.overX};出界 上 ${x.offTop} 下 ${x.offBottom} 左 ${x.offLeft} 右 ${x.offRight}`);
  }
}
console.log('  修法:A 提行高到墨高之上(优先改 tokens.css 型类层);B 首屏上内衬按导航实高派生,别写死常数;');
console.log('        D 把窄档的上限接到断点另一侧的实算值(取整下调留方向余量),不要另挑一个好看的数;');
console.log('        E 让弹层内容按剩余空间收缩(竖向 flex + min-height:0 + object-fit:contain),别写死关闭行高度。');
console.log('  确系有意:A/B 给元素加 class line-fit-ok;D 加 class size-jump-ok。');
process.exit(1);
