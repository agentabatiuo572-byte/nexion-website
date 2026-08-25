/* 第八门 · 画布单位(静态·禁手写上限) — R40 立
   R40 起一切尺寸写成 calc(N * var(--u|--uc)),**上限由单位统一封顶,任何地方不得再手写**。
   缘起:上一版 126 条尺寸声明里 54 条的上限是手算的,且算错(实测最多偏 −48%),
   直接后果是宽屏上字号/间距/块高各涨各的。「手写上限」这件事静态可查 —— 归零即绝种。
   放行:--u / --uc 自身的定义;上限已写成 calc(... var(--uc)) 的「真天花板」。 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const LF = String.fromCharCode(10);
const SIZE_FN = /\b(clamp|min)\(([^;{}]*)\)/g;
const HAS_VW = /[\d.]vw/;
const UNIT_DEF = /--uc?\s*:/;

function walkCss(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkCss(p, out);
    else if (name.endsWith('.astro') || name.endsWith('.css')) out.push(p);
  }
  return out;
}

export function canvasUnitGate(srcDir, rel) {
  const detail = [];
  for (const f of walkCss(srcDir)) {
    const lines = readFileSync(f, 'utf8').split(LF);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const t = line.trim();
      if (t.startsWith('*') || t.startsWith('/*') || t.startsWith('//')) continue;
      if (UNIT_DEF.test(line)) continue;
      SIZE_FN.lastIndex = 0;
      let m;
      while ((m = SIZE_FN.exec(line))) {
        const inner = m[2];
        if (!HAS_VW.test(inner)) continue;
        if (inner.includes('var(--uc)')) continue;
        detail.push(
          rel(f) + ':' + (i + 1) + ' 手写固定上限 ' + m[0].slice(0, 58) +
            ' —— 应改用 calc(N * var(--u)),或把上限写成 calc(N * var(--uc))',
        );
      }
    }
  }
  return { gate: 'canvas-unit(静态·禁手写上限)', pass: detail.length === 0, detail };
}
