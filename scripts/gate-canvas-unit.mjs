/* 第八门 · 画布危险写法(静态) — R42 重立
   ────────────────────────────────────────────────────────────
   R40/R41 版守的是「每条声明是否写成画布单位形态」。那套机制(逐声明模拟缩放)
   已被 R42 的整体缩放取代 —— 画布内任何 px 都自动是画布像素并随画布等比,
   「配对值掉队」整族结构性消失,**那道门失去了存在理由**(它也确实被换个写法就绕过)。

   整体缩放只剩一个真危险:**画布内的视口单位会被 zoom 二次放大**。
   实测:zoom 1.3333 下 `height:100svh` 渲染成 1333px(应 1000)、`width:50vw` 渲染成 1280(应 960)。
   这一族静态可查,且判据小而确定 —— 门因此从「追无穷种长度写法」变成「禁一类单位」。

   判据:画布作用域内(即非 @media 块内)不得出现 vw / vh / svh / dvh / lvh / vmin / vmax。
   合法例外:
     · @media 条件本身与 @media 块内(断点以下 zoom=1,视口单位是正常手段)
     · 显式换算成画布量:calc(… / var(--x-zoom))
     · 画布壳与导航壳自身的 zoom / 留白定义(它们**就是**换算的那一层)
     · 同行或上一行带 canvas-exempt 注释标记 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const LF = String.fromCharCode(10);
const VIEWPORT_UNIT = /(-?\d[\d.]*)(vw|vh|svh|dvh|lvh|lvw|svw|dvw|vmin|vmax)\b/;
const EXEMPT = /canvas-exempt/;
const CONVERTED = /var\(--x-zoom\)/;

const walk = (d, out = []) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(astro|css)$/.test(n)) out.push(p);
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

export function canvasUnitGate(srcDir, rel) {
  const detail = [];
  for (const f of walk(srcDir)) {
    const lines = stripComments(readFileSync(f, 'utf8'));
    let depth = 0;
    let mediaDepth = 0;
    let pendingMedia = -1;
    for (let i = 0; i < lines.length; i++) {
      const code = lines[i].code;
      const raw = lines[i].raw;
      const isMediaCond = /@media/.test(code);
      if (isMediaCond) pendingMedia = depth;
      for (const ch of code) {
        if (ch === '{') {
          depth++;
          if (pendingMedia === depth - 1) { mediaDepth = depth; pendingMedia = -1; }
        } else if (ch === '}') {
          if (mediaDepth === depth) mediaDepth = 0;
          depth--;
        }
      }
      if (mediaDepth || isMediaCond) continue;               // 断点以下:视口单位是正常手段
      const m = code.match(VIEWPORT_UNIT);
      if (!m) continue;
      if (CONVERTED.test(code)) continue;                     // 已显式换算成画布量
      if (/--x-zoom\s*:/.test(code)) continue;                // 换算层自身的定义
      if (/zoom\s*:/.test(code)) continue;                    // 画布壳/导航壳的 zoom
      if (EXEMPT.test(raw) || EXEMPT.test(lines[i - 1] ? lines[i - 1].raw : '')) continue;
      detail.push(
        `${rel(f)}:${i + 1} 画布内出现视口单位 ${m[0]} —— 会被 zoom 二次放大;` +
          `应改画布像素、或写成 calc(… / var(--x-zoom)),或加 canvas-exempt 注释豁免` +
          `${LF}         ${code.trim().slice(0, 72)}`,
      );
    }
  }
  return { gate: 'canvas-hazard(静态·画布内禁视口单位)', pass: detail.length === 0, detail };
}
