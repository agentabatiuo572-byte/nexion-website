/* 第八门 · 画布危险写法(静态) — R42 立,R43 按评审 8 例注入(放行 6)收口
   ────────────────────────────────────────────────────────────
   整体缩放下,画布内任何 px 都自动是画布像素,「配对值掉队」整族按构造消失。
   只剩两类静态可查的真危险:

   ① **画布内的视口单位会被 zoom 二次放大**
      实测 zoom 1.3333 下 `height:100svh` 渲染成 1333px(应 1000)。
      合法例外:
        · `@media` 条件为 `max-width <= 1439`(断点以下画布退场,视口单位是正常手段)
        · 显式换算 `… / var(--x-zoom)`(按**声明**判定,不是按行 —— 同行放一个换算不能给别的项发通行证)
        · `clamp(Apx, Bvw, CAP)` 且 **B×14.4 ≥ CAP**:上限在 1440 处先夹住,视口项在画布内永不生效
          (R43 实证:这类声明的 vw 中项是**刻意调得比画布比例大的**,窄屏需要相对更大的展示字;
           R42 一刀切禁掉它们,导致 768 宽首屏标题 −44%、页脚巨字 −47%。门规则逼出的回归。)
        · 同行或上一行带 canvas-exempt 标记

   ② **引用未定义的自定义属性**
      CSS 对未定义变量的处理是**让整条声明静默作废**——不报错、不警告。
      R42 删掉留白变量却漏删两处引用,白带因此在 2560 下两侧各露 320px 黑边,占全页 41% 滚动长度,
      而当时两道门都看不见。这条判据纯静态、零误报。 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const LF = String.fromCharCode(10);
/* 视口单位全表:标准 + 逻辑(vi/vb)+ small/large/dynamic 前缀;大小写不敏感 */
const VU = '(?:[sldSLD]?[vV](?:[wWhH]|[iI]|[bB]|min|max|MIN|MAX|Min|Max))';
const VU_TOKEN = new RegExp('(-?\\d[\\d.]*)\\s*(' + VU + ')\\b');
const VU_GLOBAL = new RegExp('(-?\\d[\\d.]*)\\s*(' + VU + ')\\b', 'g');
const EXEMPT = /canvas-exempt/;
const SAFE_CLAMP = /clamp\(\s*([\d.]+)px\s*,\s*([\d.]+)vw\s*,\s*(?:calc\(\s*([\d.]+)\s*\*\s*var\(--uc?\)\s*\)|([\d.]+)px)\s*\)/gi;
const CANVAS = 1440;

const walk = (d, out = []) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(astro|css|ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
};

function stripComments(src) {
  const out = [];
  let inBlock = false;
  for (const raw of src.split(LF)) {
    let line = raw;
    if (inBlock) {
      const e = line.indexOf('*/');
      if (e < 0) { out.push({ code: '', raw }); continue; }
      line = ' '.repeat(e + 2) + line.slice(e + 2);
      inBlock = false;
    }
    for (;;) {
      const s = line.indexOf('/*');
      if (s < 0) break;
      const e = line.indexOf('*/', s + 2);
      if (e < 0) { line = line.slice(0, s); inBlock = true; break; }
      line = line.slice(0, s) + ' '.repeat(e + 2 - s) + line.slice(e + 2);
    }
    const l = line.indexOf('//');
    if (l >= 0 && !/https?:$/.test(line.slice(0, l))) line = line.slice(0, l);
    out.push({ code: line, raw });
  }
  return out;
}

/* @media 条件是否「只在断点以下生效」——只有这种才豁免。
   R43:此前把「有 @media」等同于「断点以下」,于是 min-width / print / 特性查询全被放行,
   而 min-width:1441 恰恰是缩放区内部、最该查的地方。 */
function isNarrowOnly(cond) {
  const maxes = [...cond.matchAll(/(?:max-width\s*:\s*|width\s*<=\s*)(\d+)px/gi)].map((m) => +m[1]);
  const mins = [...cond.matchAll(/(?:min-width\s*:\s*|width\s*>=\s*)(\d+)px/gi)].map((m) => +m[1]);
  if (!maxes.length) return false;
  if (mins.some((n) => n >= CANVAS)) return false;
  return maxes.every((n) => n < CANVAS);
}

/* 把一行按分号切成「声明」,逐条判定豁免——同行的一个换算不能给别的项发通行证 */
function declsOf(code) {
  return code.split(';').filter((d) => d.trim());
}

export function canvasUnitGate(srcDir, rel) {
  const detail = [];
  const defined = new Set(['--x-zoom', '--u', '--uc']);
  const refs = [];
  const files = walk(srcDir);

  // 先扫一遍收集所有自定义属性定义(含组件内联)
  for (const f of files) {
    for (const m of readFileSync(f, 'utf8').matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]);
  }

  for (const f of files) {
    const lines = stripComments(readFileSync(f, 'utf8'));
    let depth = 0;
    let exemptDepth = 0;
    let pending = null;
    for (let i = 0; i < lines.length; i++) {
      const code = lines[i].code;
      const raw = lines[i].raw;

      const mq = code.match(/@media([^{]*)/);
      if (mq) pending = { depth, narrow: isNarrowOnly(mq[1]) };
      for (const ch of code) {
        if (ch === '{') {
          depth++;
          if (pending && pending.depth === depth - 1) { if (pending.narrow) exemptDepth = depth; pending = null; }
        } else if (ch === '}') {
          if (exemptDepth === depth) exemptDepth = 0;
          depth--;
        }
      }

      // ② 未定义变量引用(任何位置都查,包括豁免块)
      // 只拦**没有兜底值**的引用:`var(--x, 0s)` 即使未定义也不会作废,是运行时由 JS 赋值的合法写法
      for (const m of code.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) {
        if (!defined.has(m[1]))
          refs.push(`${rel(f)}:${i + 1} 引用了未定义的 ${m[1]} 且无兜底值 —— CSS 会让整条声明**静默作废**(R42 白带黑边即此)`);
      }

      if (exemptDepth) continue; // 断点以下:视口单位是正常手段
      if (mq) continue;

      for (const d of declsOf(code)) {
        if (!VU_TOKEN.test(d)) continue;
        if (/--x-zoom\s*:/.test(d) || /zoom\s*:/.test(d)) continue;         // 换算层自身
        if (EXEMPT.test(raw) || EXEMPT.test(lines[i - 1] ? lines[i - 1].raw : '')) continue;
        // 显式换算:视口项必须处在 「/ var(--x-zoom)」 的分子侧
        if (/\/\s*var\(--x-zoom\)/.test(d)) continue;
        // 安全 clamp:上限在 1440 处先夹住 ⇒ 视口项在画布内永不生效
        let safe = false;
        SAFE_CLAMP.lastIndex = 0;
        let cm;
        while ((cm = SAFE_CLAMP.exec(d))) {
          const B = +cm[2];
          const CAP = +(cm[3] ?? cm[4]);
          if (B * (CANVAS / 100) >= CAP - 0.01) safe = true;
        }
        if (safe) continue;
        const t = d.match(VU_TOKEN);
        detail.push(
          `${rel(f)}:${i + 1} 画布内出现视口单位 ${t[0]} —— 会被 zoom 二次放大;` +
            `应改画布像素、写成 calc(… / var(--x-zoom))、或用上限夹得住的 clamp,或加 canvas-exempt 豁免` +
            `${LF}         ${d.trim().slice(0, 74)}`,
        );
      }
    }
  }
  const all = [...refs, ...detail];
  return { gate: 'canvas-hazard(静态·视口单位 + 死引用)', pass: all.length === 0, detail: all };
}
