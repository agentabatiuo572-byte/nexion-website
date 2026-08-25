/* 第八门 · 画布单位(静态) — R40 立,R41 由黑名单翻为白名单
   ────────────────────────────────────────────────────────────
   R40 版是黑名单:只认 clamp(...vw...) / min(...vw...) 两种写法。
   独立评审 13 例注入放行 8 例(换行写、max()、裸 vw、裸 px、写进 .ts、白名单子串绕过),
   同时误报 4 类(行尾注释、块注释续行、媒体查询、门自己提示语推荐的写法)。
   根因:黑名单只能追形状 —— 补完 minmax 还有 gradient、flex-basis、clip-path…

   R41 判据(白名单):src 里任何长度值默认必须是画布单位形态
     · calc(N * var(--u)) / calc(N * var(--uc))
     · 0 值
     · <=2px 细线(等比后只会变糊,收益为零)
     · @media 块内(窄屏段:--uc 在 1200 以下恒定,媒体查询是本体系唯一的窄屏适配手段)
     · 同行或上一行带 canvas-exempt 注释标记
   其余一律红。例外必须写下来,于是「哪些没走画布单位」永远可 grep。

   R41 红测揪出的自身 bug:声明缓冲区未在花括号处清零,导致前面的 HTML/JS 残渣
   黏在声明前面使解析失败 —— 门对真实注入**静默放行**,却仍能抓到恰好无残渣的那几条。
   故本版按字符流走,{ } ; 三者都是边界。 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const LF = String.fromCharCode(10);

// 带长度的属性(含 R40 黑名单漏掉的 grid / gradient / flex 族)
const LEN_PROP =
  /^(font-size|letter-spacing|word-spacing|text-indent|padding|padding-\w+|margin|margin-\w+|gap|row-gap|column-gap|width|height|min-width|min-height|max-width|max-height|top|right|bottom|left|inset|inset-\w+|border-radius|flex-basis|flex|grid-template-columns|grid-template-rows|grid-auto-columns|grid-auto-rows|background|background-image|background-position|background-size|translate|scroll-margin-top|scroll-padding|columns|column-width|outline-offset|text-underline-offset)$/;

const EXEMPT = /canvas-exempt/;
const LEN_TOKEN = /(-?\d[\d.]*)(px|vw|vh|svh|dvh)/g;
const CANVAS_FORM = /\*\s*var\(--uc?\)/;

const walk = (d, out = []) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(astro|css|ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
};

/* 剥注释但保留行号与本行原文(原文用于 canvas-exempt 判定) */
function stripComments(src) {
  const out = [];
  let inBlock = false;
  for (const raw of src.split(LF)) {
    let line = raw;
    if (inBlock) {
      const e = line.indexOf('*/');
      if (e < 0) {
        out.push({ code: '', raw });
        continue;
      }
      line = ' '.repeat(e + 2) + line.slice(e + 2);
      inBlock = false;
    }
    for (;;) {
      const s = line.indexOf('/*');
      if (s < 0) break;
      const e = line.indexOf('*/', s + 2);
      if (e < 0) {
        line = line.slice(0, s);
        inBlock = true;
        break;
      }
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
    let cur = '';
    let curLine = 1;

    const flush = (rawLine, ln) => {
      const d = cur.trim();
      cur = '';
      if (!d) return;
      const m = d.match(/^([a-zA-Z-]+)\s*:\s*(.+)$/);
      if (!m) return;
      const prop = m[1].toLowerCase();
      const val = m[2];
      if (!LEN_PROP.test(prop)) return;
      if (mediaDepth) return; // 窄屏段豁免
      const prev = lines[ln - 2] ? lines[ln - 2].raw : '';
      if (EXEMPT.test(rawLine || '') || EXEMPT.test(prev)) return;
      LEN_TOKEN.lastIndex = 0;
      let t;
      while ((t = LEN_TOKEN.exec(val))) {
        const num = Math.abs(+t[1]);
        const unit = t[2];
        if (num === 0) continue;
        if (unit === 'px' && num <= 2) continue; // 细线
        if (unit !== 'px' && unit !== 'vw') continue; // 高度视口单位另有语义(钉屏居中等)
        if (CANVAS_FORM.test(val.slice(t.index, t.index + 32))) continue;
        detail.push(
          `${rel(f)}:${ln} ${prop}: ${val.slice(0, 54)} —— 长度 ${t[0]} 未走画布单位;` +
            `应写 calc(N * var(--u|--uc)),或加 canvas-exempt 注释豁免`,
        );
        return; // 每条声明只报一次
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const code = lines[i].code;
      const raw = lines[i].raw;
      if (/@media/.test(code)) pendingMedia = depth;
      for (const ch of code) {
        if (ch === '{') {
          flush(raw, curLine);
          depth++;
          if (pendingMedia === depth - 1) {
            mediaDepth = depth;
            pendingMedia = -1;
          }
          curLine = i + 1;
        } else if (ch === '}') {
          flush(raw, curLine);
          if (mediaDepth === depth) mediaDepth = 0;
          depth--;
          curLine = i + 1;
        } else if (ch === ';') {
          flush(raw, curLine);
          curLine = i + 1;
        } else {
          if (!cur.trim() && ch.trim()) curLine = i + 1;
          cur += ch;
        }
      }
      cur += ' ';
    }
  }
  return { gate: 'canvas-unit(静态·白名单)', pass: detail.length === 0, detail };
}
