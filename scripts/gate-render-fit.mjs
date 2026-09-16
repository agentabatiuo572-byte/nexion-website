/* 门:版面在真渲染下不能自相矛盾 —— 七条判据一起判。
 *   A 行间:相邻两行的墨(含变音符与下点)不能相接;
 *   B 层间:首屏文字的墨不能钻进导航的磨砂蒙版底下;
 *   C 声明:`--x-nav-h` 的声明值必须等于导航的实测高;
 *   D 单调:视口变窄时字号不能变大(分档版式两套梯子在断点处对不齐);
 *   E 弹层:打开的 <dialog> 在每一档视口里都要装得下;
 *   F 弹层:**关闭态**的 <dialog> 必须真隐藏(载入即测 + 开关一轮后再测)——
 *     基类写 display 会顶掉 UA 的 `dialog:not([open]){display:none}`,弹层自首帧常驻可见、
 *     吞掉底下内容的点击。这一族曾在 13 门全绿下溜进产物,靠两路独立终审肉眼抓回(R49 收线 P0)。
 *   G 兄弟:同一行里同 class 的兄弟,其对应子元素必须顶齐 —— grid/flex 的轨拉伸会把多出来的高度
 *     平摊给容器内各行,让本该齐平的大数字下沉「行高 ÷ 3」。判据只在「上游完全一致」时才判,
 *     结构或前序高度一分叉就收手,所以正常文档流(上面标题折两行、下面正文自然更低)不会误报。
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
import { readdirSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { readBuiltPages, homeRoutes, parseRoutesArg, scopeRoutes } from './gate-built-routes.mjs';
import { checkUiLayout } from './check-ui-layout.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const DIST = join(ROOT, 'dist');
const EXPLICIT = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2].replace(/\/$/, '') : null;

/* ── ① 路由:从产物枚举 ── */
const allRoutes = () => readBuiltPages(DIST).map((page) => page.route);

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
    const r = document.createRange();
    for (const n of nodes) {
      const s = n.textContent;
      for (let i = 0; i < s.length && chars < 600; i++, chars++) {
        if (!s[i].trim()) continue;
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
/* ── ③ F 判据量具:关闭态弹层必须真隐藏 ──
   从 DOM 枚举 `dialog:not([open])`(不列清单):display 既非 none、visibility 又非 hidden、
   还占着 >1px 的盒 → 它在真渲染里是可见的。逃生阀 class `closed-dialog-ok`(有意常显才加)。 */
const MEASURE_CLOSED = () => {
  const out = [];
  for (const d of document.querySelectorAll('dialog:not([open])')) {
    if (d.classList.contains('closed-dialog-ok')) continue;
    const cs = getComputedStyle(d);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = d.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) continue;
    const cls = typeof d.className === 'string' ? d.className : '';
    out.push({
      sel: 'dialog' + (cls ? '.' + cls.trim().split(/\s+/).join('.') : ''),
      display: cs.display,
      w: Math.round(r.width),
      h: Math.round(r.height),
    });
  }
  return out;
};

/* ── ③ G 判据:同类兄弟的对应子元素必须顶齐 ──
   出处:数字条 `.cell` 与行业数据 `.wcell` 都是「三条 auto 轨 + 默认 align-content:stretch」。
   同一行里某格的标签多折一行,那多出来的高度被**平摊给该格的三条轨**,于是这一格的大数字
   被下推「行高 ÷ 3」。实测 en/vi/zh 三语 × 320~2560 共 85 处,其中行业数据那处在**桌面主视口
   三语全中**、熬过四十多轮人工走查 —— 人眼对「两个大数字差 5px」天然不敏感,这是机器该接的活。

   判据构造性(不列元素清单):从 DOM 自己枚举「同一父元素下、标签+class 完全相同、且盒顶相同
   (= 同一视觉行)」的兄弟组,再把各成员的子元素按序并排比。同签名兄弟 = **作者明示的同类**,
   这正是「它们该长得一样」的依据,不需要我去猜哪些容器算一族。

   两条收敛规则(把误报面压到近乎为零,而不是靠加逃生阀):
     ① 结构一分叉就停:第 k 个子元素签名对不上,后面全部不可比,立刻收手;
     ② **内容高一分叉就停,且这一问必须问在「判顶」之前** —— 一个元素自己的内容本来就该不一样高时
        (左格标题一行、右格两行),容器若是居中或末端对齐,它的顶天然错开,那是**作者点名要的**,
        不是缺陷;它之后的兄弟也进入正常文档流,同样不可判。所以判的只有「上游与自身内容全一致、
        它却偏了」这一种情形 —— 那只能是容器在分配空白。
        量内容高必须用 Range,不能用盒高:拉伸恰恰会把盒撑大,用盒高会在抓到缺陷前就收手(自检 ⑯⑰)。

   🔴 这条收敛换来的**已知覆盖缺口**,写在这里而不是让它静默存在:
      若某一族错位恰好发生在「自身内容高也不一致」的元素上,G 判不了它。
      代价是自愿付的 —— 六宫格 `li.cell` 的名称栏(1 行 vs 2 行、`align-items:center`)实景确认是
      **有意居中**,上一版判据把它报成 17.84px 错位;宁可放过那个理论缺口,也不能让门天天报正当版式。
      **缺口已实测普查,不是估计**:5 路由 × 6 档宽下共 19 个点位落进这个缺口,其中 16 个此刻顶本来就是齐的
      (放过无害),**3 个真顶不齐、且全部是上面那处有意居中**(/vi/ @1024 21.59px、/ @1920 14.55px、
      /zh/ @1024 10.8px)。即:缺口里目前只装着一个已被认可的设计,没有别的东西。
      🔴 **主人 2026-09-02 据此普查拍板「维持现状,不补这个缺口」——这是决定,不是没做完。**
      要收紧判据去覆盖它之前,先重跑那次普查:只要缺口里仍然只有有意居中,补它的收益就是 0,
      代价是门开始报一个主人认可过的版面(逃生阀一多,门就名存实亡)。
   递归只在「顶齐且等高」的子元素上继续下钻,即上游完全对齐时才往深处看,不制造下游连锁误报。
   逃生阀:容器加 class `sibling-align-ok`(有意让同类兄弟错位才加)。 */
const SIB_TOL = 1.5; // 画布 zoom 会让 rect 带小数;真缺陷一向是 4.75px 起步,这条带子隔得开
const SCAN_SIBS = () => {
  const TOL = 1.5;
  const out = [];
  const sig = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).sort().join('.') : '';
    return el.tagName.toLowerCase() + (cls ? '.' + cls : '');
  };
  const vis = (el) => {
    if (/^(SCRIPT|STYLE|BR|HR|NOSCRIPT|TITLE|META|LINK)$/.test(el.tagName)) return false;
    if (el.namespaceURI && el.namespaceURI.indexOf('svg') >= 0) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const txt = (el) => (el.textContent || '').split(/\s+/).join(' ').trim().slice(0, 24);
  /* 🔴 内容高 ≠ 盒高。拉伸会把盒撑大(首子元素 40 vs 30),拿盒高当「内容分叉」的信号,
     会在走到真正错位的那个子元素之前就收手 —— 判据自检 ⑯⑰ 当场量到这一点。
     Range 量的是内容自己的排布范围,与容器给了多少空间无关,正是这里要的那把尺。 */
  const contentH = (el) => {
    const rg = document.createRange();
    rg.selectNodeContents(el);
    const h = rg.getBoundingClientRect().height;
    return h > 0 ? h : el.getBoundingClientRect().height; // 替换元素/空元素退回盒高
  };
  const walk = (group, path, depth) => {
    if (depth > 4) return;
    const kids = group.map((g) => [...g.children].filter(vis));
    const n = Math.min(...kids.map((k) => k.length));
    for (let i = 0; i < n; i++) {
      const row = kids.map((k) => k[i]);
      const s0 = sig(row[0]);
      if (!row.every((e) => sig(e) === s0)) return; // ① 结构分叉 → 不可比
      /* ② 先问「它自己的内容本来就该一样高吗」,再判顶 —— 顺序不能反。
         内容高一分叉,这个元素的顶就不可判了(容器若是居中/末端对齐,它天然错开),
         它之后的兄弟也不可判(正常文档流)。所以分叉即收手。 */
      const hs = row.map(contentH);
      if (Math.max(...hs) - Math.min(...hs) > TOL) return;
      const tops = row.map((e) => e.getBoundingClientRect().top);
      const dTop = Math.round((Math.max(...tops) - Math.min(...tops)) * 100) / 100;
      if (dTop > TOL) {
        out.push({ path, sel: s0, delta: dTop, tops: tops.map((t) => Math.round(t * 10) / 10),
          members: row.length, text: txt(row.find((e) => txt(e)) || row[0]) });
        return; // 同一组只报最上游那一处,下游都是它的连锁
      }
      walk(row, path + '>' + s0, depth + 1);
    }
  };
  for (const p of document.querySelectorAll('body *')) {
    if (p.closest('.sibling-align-ok')) continue;
    const kids = [...p.children].filter(vis);
    if (kids.length < 2) continue;
    const bySig = new Map();
    for (const k of kids) { const s0 = sig(k); if (!bySig.has(s0)) bySig.set(s0, []); bySig.get(s0).push(k); }
    for (const [s0, arr] of bySig) {
      if (arr.length < 2) continue;
      const rows = [];
      for (const e of arr) {
        const t = e.getBoundingClientRect().top;
        const r = rows.find((r) => Math.abs(r.top - t) <= 1);
        if (r) r.items.push(e); else rows.push({ top: t, items: [e] });
      }
      for (const r of rows) if (r.items.length >= 2) walk(r.items, s0, 1);
    }
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

/* G 的夹具:五种情形各一格。
   .bug   同类兄弟 + 轨拉伸 → 第一个子元素被下推(该红)
   .fixed 同一结构加了 align-content:start(不该红)
   .flow  前序子元素高度先分叉,下游自然更低(不该红 —— 那是正常文档流,不是缺陷)
   .esc   与 .bug 同病但容器挂了逃生阀(不该红)
   .diff  两个兄弟 class 不同 = 不是同类,不参与比对(不该红)
   .mid   有意居中:名称一行 vs 两行、align-items:center,顶天然错开(不该红)——
          这一格是从**实景**里回灌的:上一版判据把六宫格名称栏报成 17.84px 错位,
          看图确认那是作者点名要的居中版式。红测里钉死它,防止判据日后又放宽回去。 */
const FIXTURE_G = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
  body { margin: 0; font-family: monospace; }
  .wrap { display: grid; grid-template-columns: 1fr 1fr; width: 420px; }
  .bug, .fixed, .esc, .diff1, .diff2 { display: grid; }
  .fixed { align-content: start; }
  .flow { display: block; }
  .mid { display: flex; align-items: center; gap: 10px; }
  .mid .th { width: 60px; height: 60px; background: #333; }
  span { display: block; font-size: 16px; line-height: 30px; }
</style></head><body>
  <div class="wrap bugwrap">
    <div class="bug"><span class="i">01</span><span class="n">111</span><span class="l">one</span></div>
    <div class="bug"><span class="i">02</span><span class="n">222</span><span class="l">two<br>lines</span></div>
  </div>
  <div class="wrap fixedwrap">
    <div class="fixed"><span class="i">01</span><span class="n">111</span><span class="l">one</span></div>
    <div class="fixed"><span class="i">02</span><span class="n">222</span><span class="l">two<br>lines</span></div>
  </div>
  <div class="wrap flowwrap">
    <div class="flow"><span class="t">head<br>wraps</span><span class="b">body</span></div>
    <div class="flow"><span class="t">head</span><span class="b">body</span></div>
  </div>
  <div class="wrap escwrap sibling-align-ok">
    <div class="esc"><span class="i">01</span><span class="n">111</span><span class="l">one</span></div>
    <div class="esc"><span class="i">02</span><span class="n">222</span><span class="l">two<br>lines</span></div>
  </div>
  <div class="wrap diffwrap">
    <div class="diff1"><span class="i">01</span><span class="n">111</span><span class="l">one</span></div>
    <div class="diff2"><span class="i">02</span><span class="n">222</span><span class="l">two<br>lines</span></div>
  </div>
  <div class="wrap midwrap">
    <div class="mid"><img class="th" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" width="60" height="60"><span class="nm">one line</span></div>
    <div class="mid"><img class="th" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" width="60" height="60"><span class="nm">two<br>lines</span></div>
  </div>
</body></html>`;

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
  // F:关闭态弹层 —— 强制可见的要抓、UA 默认隐藏的不抓、逃生阀生效、打开态不归 F 管(E 的地盘)
  await p.setContent(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><style>.bad-dialog{display:flex}.esc-dialog{display:flex}</style></head><body>' +
      '<dialog class="bad-dialog">forced visible</dialog>' +
      '<dialog class="ua-hidden">normal closed</dialog>' +
      '<dialog class="esc-dialog closed-dialog-ok">escaped</dialog>' +
      '<dialog open class="open-one">open one</dialog></body></html>',
    { waitUntil: 'load' },
  );
  const fHit = (await p.evaluate(MEASURE_CLOSED)).map((x) => x.sel).join(' ');
  // G:走的是主循环用的同一份 SCAN_SIBS
  await p.setViewportSize({ width: 800, height: 700 });
  await p.setContent(FIXTURE_G, { waitUntil: 'load' });
  const gRaw = await p.evaluate(SCAN_SIBS);
  const gHit = gRaw.map((x) => x.path + ' ' + x.sel).join(' | ');
  const gDelta = gRaw.find((x) => x.path.indexOf('bug') >= 0)?.delta ?? 0;
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
    ['⑫ F 关闭态被样式顶成可见 → 抓到', fHit.indexOf('bad-dialog') >= 0],
    ['⑬ F UA 默认隐藏的不抓', fHit.indexOf('ua-hidden') < 0],
    ['⑭ F 逃生阀 closed-dialog-ok 生效', fHit.indexOf('esc-dialog') < 0],
    ['⑮ F 打开态不归 F 管', fHit.indexOf('open-one') < 0],
    // G:该红的四种边界各一条 —— 抓得到、量得准、三种正当情形一条都不许误报
    ['⑯ G 轨拉伸把同类兄弟的首子元素推歪 → 抓到', gHit.indexOf('div.bug') >= 0],
    ['⑰ G 推歪量 = 折行高度÷3(10px,±0.5)', Math.abs(gDelta - 10) < 0.5],
    ['⑱ G 加了 align-content:start 的不抓', gHit.indexOf('div.fixed') < 0],
    ['⑲ G 前序高度先分叉的下游错位不抓(正常文档流)', gHit.indexOf('div.flow') < 0],
    ['⑳ G 逃生阀 sibling-align-ok 生效', gHit.indexOf('div.esc') < 0],
    ['㉑ G class 不同 = 不是同类,不比对', gHit.indexOf('div.diff') < 0],
    ['㉒ G 有意居中(自身内容就不等高)不报 —— 实景回灌的红测', gHit.indexOf('div.mid') < 0],
  ];
  let bad = 0;
  for (const [n, ok] of expect) { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}`); if (!ok) bad++; }
  console.log(`gate-render-fit 自检: ${expect.length - bad} pass / ${bad} fail`);
  if (bad) console.log('  A 实际抓到:', names || '(空)', '| D 实际抓到:', dHit || '(空)', '| G 实际抓到:', gHit || '(空)');
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

const ALL_ROUTES = allRoutes();
const ALL_HOME = homeRoutes(readBuiltPages(DIST));
/* 增量裁剪:只实测变化路由。显式单路由模式(EXPLICIT)优先；裁剪到空即如实报跳过，
   在起浏览器之前退出 —— HTML 与静态资源都未变，量不出第二种答案。 */
const onlyRoutes = EXPLICIT ? null : parseRoutesArg(process.argv.slice(2));
const routeScope = scopeRoutes(ALL_ROUTES, onlyRoutes);
const homeScope = scopeRoutes(ALL_HOME, onlyRoutes);
const ROUTES = routeScope.pages;
const HOME = homeScope.pages;
if (routeScope.scoped && ROUTES.length === 0 && HOME.length === 0) {
  console.log(`[render-fit] ✓ 路由裁剪:无变化路由,跳过实测(0/${routeScope.total})`);
  process.exit(0);
}
const { widths, heights } = breakpoints();
// 首屏层间判据只需首页多语,但视口要走全部「宽 × 矮档高」组合
const SHORT_H = heights.filter((h) => h <= 900);
const progress = (detail) => console.log('[publish-progress] ' + JSON.stringify({ detail }));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const hitsA = new Map();
const hitsB = new Map();
const hitsD = new Map();
const hitsG = new Map();
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
        /* 逐个等它**自己**还原,而不是统一给一个固定窗:固定 350ms 在页面变高、
           IO 触发更挤时不够(R3d 实录 /vi/ @320 补拍后仍 blind),而按元素等待
           既给足慢的、又不拖快的。判据一点不放宽,只是观测面不自己制造盲点。 */
        const t0 = Date.now();
        while (e.children.length > 0 && Date.now() - t0 < 1500) await new Promise((r) => setTimeout(r, 50));
      }
      window.scrollTo(0, 0);
    });
    await page
      .waitForFunction(() => [...document.querySelectorAll('[data-lr], [data-tw]')].every((e) => e.children.length === 0), null, { timeout: 5000 })
      .catch(() => {});
  }
  await page.waitForTimeout(60);
};

/* 指纹必须带行高:只改 `line-height` 的高度断点会产生完全相同的字号指纹 → 整条路由被判「不敏感」
   → 那些高度档判据 A 一次都不扫,而 A 判的恰恰是行间。今天仓里没有这种规则,写进来是封住它。 */
const fingerprint = (sizes) => Object.entries(sizes).map(([k, v]) => `${k}:${v.fs}/${v.lh}`).join('|');
const scanA = async (r, w, h) => {
  let { hits, blind } = await page.evaluate(SCAN_LINES);
  /* 🔴 settle 只在路由载入后跑一次,而这之后视口要换 18 档宽 —— 揭示动效的触发窗
     与视口尺寸相关,在 settle 那个尺寸下触发过的,换个尺寸可能仍带着结构
     (R3d 实录 /vi/ @320:冲刺滚动后 3 处卡住,在**该尺寸下**点名唤醒即全部还原)。
     扫到盲点才唤醒重扫:正常情况零开销,判据一点不放宽,只是观测面不自己制造盲点。 */
  if (blind.length) {
    await page.evaluate(async () => {
      const left = [...document.querySelectorAll('[data-lr], [data-tw]')].filter((e) => e.children.length > 0);
      for (const e of left) {
        e.scrollIntoView({ block: 'center' });
        const t0 = Date.now();
        while (e.children.length > 0 && Date.now() - t0 < 1200) await new Promise((res) => setTimeout(res, 50));
      }
      window.scrollTo(0, 0);
    });
    ({ hits, blind } = await page.evaluate(SCAN_LINES));
  }
  scansA++;
  // G 蹭 A 的点位:同类兄弟对齐只随宽度变,A 已经把「路由 × 宽 × 敏感高度档」走全了
  for (const g of await page.evaluate(SCAN_SIBS)) {
    const k = `${r}|${g.path}|${g.sel}`;
    const prev = hitsG.get(k);
    if (!prev || g.delta > prev.delta) hitsG.set(k, { ...g, where: `${r} @${w}×${h}` });
  }
  for (const x of hits) {
    const k = `${r}|${x.sel}`;
    const prev = hitsA.get(k);
    if (!prev || x.over > prev.over) hitsA.set(k, { ...x, where: `${r} @${w}×${h}` });
  }
  for (const b of blind) if (!blindSpots.has(`${r}|${b}`)) blindSpots.set(`${r}|${b}`, `${r} @${w}×${h}  ${b}`);
};

for (const [index, r] of ROUTES.entries()) {
  progress(`页面布局：文字与字号 ${index + 1}/${ROUTES.length}，当前 ${r}`);
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
/* ── E:弹层装不装得下 · F:关闭态必须真隐藏 ── */
const hitsE = new Map();
const hitsF = new Map();
let dialogRoutes = 0;
for (const [index, r] of ROUTES.entries()) {
  progress(`页面布局：弹层检查 ${index + 1}/${ROUTES.length}，当前 ${r}`);
  await page.goto(BASE + r, { waitUntil: 'networkidle' }).catch(() => null);
  const n = await page.evaluate(() => document.querySelectorAll('dialog').length);
  if (!n) continue;
  dialogRoutes++;
  // F(载入即测):最窄与最宽两档 —— 基类规则与媒体块规则两侧都看得到
  for (const w of [widths[0], widths[widths.length - 1]]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(40);
    for (const m of await page.evaluate(MEASURE_CLOSED)) {
      const k = `${r}|${m.sel}|fresh`;
      if (!hitsF.has(k)) hitsF.set(k, { ...m, where: `${r} @${w}×900 载入即可见` });
    }
  }
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
  // F(开关一轮后):黑盒实录残留面板会迁到页顶盖住 hero 下载键 —— 交互后的关闭态同样要真隐藏
  await page.waitForTimeout(60);
  for (const m of await page.evaluate(MEASURE_CLOSED)) {
    const k = `${r}|${m.sel}|after`;
    if (!hitsF.has(k)) hitsF.set(k, { ...m, where: `${r} 开关一轮后仍可见` });
  }
}

const hitsC = [];
for (const [index, r] of HOME.entries()) {
  progress(`页面布局：导航检查 ${index + 1}/${HOME.length}，当前 ${r}`);
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

/* ── H:字符宽比值 --x-ch-* 必须等于配对字体真实的「0」前进宽 ──
   R50 背景:行长上限原本写 Nch,而 ch 会双稳(「0」量不到时规范要求回落 0.5em,同一构建连拍两次
   版面在两态之间翻)。改写成 calc(N * var(--x-ch-*)) 治好了双稳,代价是比值从「自动跟着字体走」
   变成「一个写死的数」—— 换字体就静默失真(Funnel ↔ Be Vietnam Pro 差 17.6%)。这条判据把代价买回来:
   在真浏览器里量首选字体的「0」前进宽,与 tokens 里声明的值逐条对,漂了就红。
   机制已由两条独立线交叉验证(别再当假设):坏态宽 ÷ 该元素**自身**字号,在 11 / 11.38 / 11.87 /
   12 / 15.21 / 15.88 六个不同字号上**全部等于 25.000**(= 50 × 0.5),即规范的「0 不可量则 1ch 取 0.5em」;
   且翻的只有宽高、**字号全程恒定**,这一条排除了「字号档位切换带动布局」那一类替代解释。
   ⚠️ 触发条件在浏览器内部、概率性,至今**无法在真实页面上按需触发**(四条线都没做到)——
   所以这份修法的验收是结构性的(产物里此类单位命中 0 + 静态门整族封 + 本判据核比值),不是统计性的。
   别把「我没复现到」当验收证据:同一份产物在 216 次页面加载里现过一次(/vi/ @390 的 .note 拍到 300px,
   = 50 × 0.5em × 12px 精确吻合),而事后 30 次定向重测 + 6 轮复刻配方都没能再现。
   ⚠️ 「拦掉 woff2 复现不出低位态」不构成反证:拦掉得到的是**回退字体**的度量(本机实测 351.562px),
   与「0 不可量 → 1ch 取 0.5em」是两个不同状态,拿前者证伪后者会得出反向结论(已有一条线因此误撤根因)。
   名单从产物 CSS 枚举(不是手写清单),语言档取三个首页路由 —— :root / :lang(vi) / :lang(en) 三个声明块
   各覆盖一次;将来新增语言块若只换字体不换比值,那门语言的首页会立刻红。
   ⚠️ 已知天花板:按 **400 字重**量(当前 consumer 全是 400,已逐个核过 —— mono 三处 + display 一处)。
      同族不同字重的「0」宽:Space Mono 与 Funnel Display 三档同值,而 **Be Vietnam Pro 400=0.676、
      500/700=0.684(差 1.18%)**。所以缝只在 --x-ch-display × vi 这一格:若有人把它的 consumer
      从 .x-display(w400)换成 .x-h24 / .x-display-mega(w500),本判据会判「相符」而实际偏 1.18%。
      锁文件挡得住换字体,挡不住换字重。这个前提每次跑门都打印出来(见下方 H 那行),不留隐形前提;
      真要封死得把 consumer 的实际字重解析进来,届时再做。
   ✅ 自指已拆除(2026-09-01):本判据一度用浏览器自己的 `ch`(width:1000ch)去量真实字身宽 ——
      拿那个不可靠的单位来执法「禁用它」的规则。虽然方向安全(撞上兜底态是误报红、不会放过),
      但「量尺本身可能就是被测的病」这层前提没有必要留着。现改用 canvas `measureText('0').width`
      直接量「0」的前进宽,那正是 ch 的定义,且完全不经过 CSS 长度解算。
      换法前做过等价实测:三语 × 两个 token,canvas 与 ch 两路读数**差 0%**(0.612 / 0.575 / 0.676 逐位相同)。
      🔴 别改回 ch 量:这条判据是禁 ch 的执法者,执法者自己不能吃那口。
   来源:判据本体与 SCAN_CH 取自 claude/inspiring-hamilton-6fde54 的 7bc8c13,交叉验证段取自其 5a62518,
   字重缝与本条自指提醒由 claude/heuristic-bohr-68a3fb 复核指出;三条线独立收敛出同一套修法,
   本条是差集,单独摘取(其余整份丢弃,因与 f1e0fc9 重复)。 */
const SCAN_CH = (names) => {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const out = [];
  for (const n of names) {
    const declared = cs.getPropertyValue(n).trim();
    const fontVar = n.replace('--x-ch-', '--x-font-');
    const stack = cs.getPropertyValue(fontVar).trim();
    if (!declared) { out.push({ n, err: '声明缺席(被谁删了?)' }); continue; }
    if (!stack) { out.push({ n, err: '配对的 ' + fontVar + ' 未定义 —— 比值失去归属' }); continue; }
    const m = declared.match(/^([0-9.]+)em$/);
    if (!m) { out.push({ n, err: '值「' + declared + '」不是 N em 形式,无法与字体度量比对' }); continue; }
    // canvas 直接量「0」的前进宽(= ch 的定义),不经过 CSS 长度解算,故不吃 ch 的兜底态。
    // 字重固定 400:与上面「已知天花板」那条对应,变了要连那条一起改。
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = '400 100px ' + stack;
    const measured = ctx.measureText('0').width / 100;
    out.push({ n, declared: +m[1], measured: Math.round(measured * 1e5) / 1e5,
      font: stack.split(',')[0].replace(/["']/g, ''), lang: root.lang });
  }
  return out;
};
const CH_NAMES = [...new Set(readdirSync(join(DIST, '_astro'))
  .filter((f) => f.endsWith('.css'))
  .map((f) => readFileSync(join(DIST, '_astro', f), 'utf8'))
  .join(' ')
  .match(/--x-ch-[a-z-]+/g) || [])];
const hitsH = [];
for (const [index, r] of HOME.entries()) {
  progress(`页面布局：字体检查 ${index + 1}/${HOME.length}，当前 ${r}`);
  await page.goto(BASE + r, { waitUntil: 'networkidle' }).catch(() => null);
  await page.evaluate(() => document.fonts.ready);
  for (const g of await page.evaluate(SCAN_CH, CH_NAMES)) {
    if (g.err) { hitsH.push(r + '  ' + g.n + ':' + g.err); continue; }
    const off = Math.abs(g.declared - g.measured) / g.measured;
    if (off > 0.005)
      hitsH.push(r + ' (lang=' + g.lang + ')  ' + g.n + ' 声明 ' + g.declared + 'em,而 ' + g.font +
        ' 实测每 ch = ' + g.measured + 'em(差 ' + (off * 100).toFixed(1) + '%)');
  }
}
let layout;
try {
  await ctx.close();
  layout = await checkUiLayout(browser, BASE, scopeRoutes(readBuiltPages(DIST), onlyRoutes).pages, progress);
} finally {
  await browser.close();
  if (server) await server.close();
}

const A = [...hitsA.values()].sort((a, b) => (b.over || 0) - (a.over || 0));
const B = [...hitsB.values()].sort((a, b) => b.under - a.under);
console.log(`[render-fit] 审计布局回归样本 ${JSON.stringify(layout.samples)}`);
for (const failure of layout.failures) console.log(`[render-fit] ✘ UI ${failure}`);
console.log(`[render-fit] 路由 ${ROUTES.length} 条(从产物枚举)${routeScope.scoped ? ` · 增量裁剪(${ROUTES.length}/${routeScope.total})` : ''}· 宽 ${widths.length} 档 / 矮档高 ${SHORT_H.length} 档(从产物 CSS 断点推导)`);
console.log(`             宽: ${widths.join(' ')}`);
console.log(`             高: ${SHORT_H.join(' ')}`);
const D = [...hitsD.values()].sort((a, b) => b.pct - a.pct);
const E = [...hitsE.values()].sort((a, b) => b.worst - a.worst);
const F = [...hitsF.values()];
const G = [...hitsG.values()].sort((a, b) => b.delta - a.delta);
console.log(`             判据 A 实扫 ${scansA} 次(${heightSensitive}/${ROUTES.length} 条路由对视口高敏感,按高度分档加扫)`);
console.log(`             判据 E 覆盖 ${dialogRoutes} 条带弹层的路由 × ${widths.length * heights.length} 档视口;判据 F 同路由载入即测+开关一轮后再测`);
console.log(`             判据 H 核 ${CH_NAMES.length} 个字符宽比值 × ${HOME.length} 个语言档(名单从产物 CSS 枚举)· 按 w400 量,consumer 改字重需回来纳条件`);

/* 🔴 观测面缺口 = NOT-RUN,不是「没问题」。
   判据再对,取样时刻不对就是假绿:曾有 60 次扫描里 33 次看不到首屏标题,而那里真有 4.4px 墨相接。 */
if (blindSpots.size) {
  console.log(`[render-fit] NOT-RUN:${blindSpots.size} 处元素本该量却量不到(揭示动效未还原,文本还在子元素里)`);
  for (const v of [...blindSpots.values()].slice(0, 12)) console.log('  - ' + v);
  if (blindSpots.size > 12) console.log(`  …另有 ${blindSpots.size - 12} 处`);
  console.log('  这不是「没有缺陷」,是**没量到**。修法:延长 settle 等待,或让揭示动效在门里直接落终态。');
  process.exit(3);
}

if (!A.length && !B.length && !hitsC.length && !D.length && !E.length && !F.length && !G.length && !hitsH.length && !layout.failures.length) {
  console.log('[render-fit] ✓ 墨迹无相撞 · 导航高声明=实测 · 字号随视口单调 · 弹层各档装得下且关闭态真隐藏 · 同类兄弟顶齐 · 字符宽比值=真字体度量 · 无观测面缺口');
  process.exit(0);
}
if (hitsH.length) {
  console.log(`[render-fit] ✘ H 字符宽比值失真:${hitsH.length} 处 --x-ch-* 与配对字体的实测度量对不上`);
  for (const g of hitsH) console.log('  - ' + g);
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
if (F.length) {
  console.log(`[render-fit] ✘ F 关闭态弹层可见:${F.length} 处(UA 的 dialog:not([open]) 隐藏被样式顶掉)`);
  for (const x of F) console.log(`  - ${x.where}  ${x.sel}  display=${x.display} ${x.w}×${x.h}`);
}
if (G.length) {
  console.log(`[render-fit] ✘ G 同类兄弟错位:${G.length} 处「同一行、同 class 的兄弟,对应子元素顶不齐」`);
  for (const x of G) {
    console.log(`  - ${x.where}  ${x.path} 内的 ${x.sel}(${x.members} 个同类)顶差 ${x.delta}px  顶 [${x.tops.join(' ')}]  「${x.text}」`);
  }
}
console.log('  修法:A 提行高到墨高之上(优先改 tokens.css 型类层);B 首屏上内衬按导航实高派生,别写死常数;');
console.log('        D 把窄档的上限接到断点另一侧的实算值(取整下调留方向余量),不要另挑一个好看的数;');
console.log('        E 让弹层内容按剩余空间收缩(竖向 flex + min-height:0 + object-fit:contain),别写死关闭行高度;');
console.log('        F 弹层的 display/弹性只挂 [open] 态,别写进基类。');
console.log('        G 容器别吃轨拉伸(grid 加 align-content:start / flex 加 align-content:flex-start),别去逐个补空白。');
console.log('        H 改字体必须同改 tokens.css 里配对的 --x-ch-*(值 = 实测每 ch 的 em 比),别改回 Nch。');
console.log('  确系有意:A/B 给元素加 class line-fit-ok;D 加 class size-jump-ok;常显 dialog 加 class closed-dialog-ok;');
console.log('           同类兄弟有意错位给容器加 class sibling-align-ok。');
process.exit(1);
