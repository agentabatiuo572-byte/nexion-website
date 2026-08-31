/* 门:被层叠悄悄压掉的 CSS 声明(css-shadowed)。
 *
 * 为什么要有这道门 —— 同型两次,两次都是「写进去了但从未生效,而且没有任何反馈」:
 *   ① `.faq > p` 同一条规则里写了两个 `max-width`(新值在前、旧值在后)→ 后者赢,「已修」从未生效;
 *   ② 手机菜单的 `@media (max-height:520px)` 压缩块写在它要压的基础规则**前面**,而嵌套 media
 *      不增加特异度、同一上下文里靠源序决胜 → 六条声明只落地三条。
 * 两次都是独立评审逐像素量出来的,靠肉眼与「我改了」的记忆都发现不了。
 *
 * 判据(只报**确定无疑**的两类,不猜意图):
 *   A 同一条规则块内,同一属性出现 ≥2 次且值不同 —— 写第二遍必然是意外(要覆盖不会写在同一块里)。
 *   B 同一个 <style> 内、同一 media 上下文里,**完全相同的选择器**出现 ≥2 次且声明了相同属性、值不同
 *     —— 后写的赢,前面那条是死声明。要覆盖应当靠更窄的选择器或更后的位置,而不是同上下文重复。
 * 有意的覆盖(不同选择器 / 不同 media 条件 / 不同文件)一律不报,所以零误报是这道门的设计目标。
 *
 * 逃生阀:声明行尾加 `/* shadow-ok *​/` 注释(确有意为之时留痕)。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';

const SRC = new URL('../src/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const p = `${dir}/${name}`;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(astro|css)$/.test(name)) out.push(p);
  }
  return out;
};

/** 注释里可能有花括号,会骗过扫描;用等长空格替换以保住行号与偏移(带 shadow-ok 的整段保留给 declsOf 认) */
const blankComments = (css) =>
  css.replace(/\/\*[\s\S]*?\*\//g, (m) => (m.includes('shadow-ok') ? m : m.replace(/[^\n]/g, ' ')));

/** 把一段 CSS 拆成 [{ sel, body, at, line }],at = 所在 @media/@supports 条件串(嵌套用 ' && ' 连)。
 *  按花括号深度跟踪 at-rule 栈 —— 手写「遇到 } 就猜着弹栈」的版本会把嵌套 media 里的规则整段丢掉(实测)。 */
const parseRules = (raw, baseLine = 1) => {
  const css = blankComments(raw);
  const rules = [];
  const stack = []; // { cond, depth }
  let i = 0;
  let line = baseLine;
  let depth = 0;
  let chunkStart = 0;
  const countLines = (from, to) => (css.slice(from, to).match(/\n/g) || []).length;
  while (i < css.length) {
    const ch = css[i];
    if (ch === '\n') line++;
    else if (ch === '{') {
      const prelude = css.slice(chunkStart, i).trim().replace(/\s+/g, ' ');
      depth++;
      if (prelude.startsWith('@')) {
        stack.push({ cond: prelude, depth });
        chunkStart = i + 1;
      } else if (prelude) {
        // 普通规则:整块消费到配对的 }
        let d = 1;
        let j = i + 1;
        while (j < css.length && d > 0) {
          if (css[j] === '{') d++;
          else if (css[j] === '}') d--;
          j++;
        }
        rules.push({ sel: prelude, body: raw.slice(i + 1, j - 1), at: stack.map((s) => s.cond).join(' && '), line });
        line += countLines(i, j);
        i = j;
        depth--;
        chunkStart = i;
        continue;
      } else {
        chunkStart = i + 1;
      }
    } else if (ch === '}') {
      depth--;
      while (stack.length && stack[stack.length - 1].depth > depth) stack.pop();
      chunkStart = i + 1;
    }
    i++;
  }
  return rules;
};

/** 从规则体里取出顶层声明 [{ prop, value, raw }](跳过嵌套块与注释) */
const declsOf = (body) => {
  const out = [];
  let depth = 0;
  let buf = '';
  const src = body.replace(/\/\*[\s\S]*?\*\//g, (m) => (m.includes('shadow-ok') ? m : ' '.repeat(m.length)));
  for (const ch of src) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === ';' && depth === 0) { out.push(buf); buf = ''; continue; }
    if (depth === 0) buf += ch;
  }
  if (buf.trim()) out.push(buf);
  return out
    .map((d) => {
      const raw = d.trim();
      const m = raw.match(/^([a-zA-Z-]+)\s*:\s*([\s\S]+)$/);
      if (!m) return null;
      return { prop: m[1].toLowerCase(), value: m[2].trim(), raw };
    })
    .filter(Boolean)
    .filter((d) => !/^--/.test(d.prop));
};

const hits = [];
for (const file of walk(SRC)) {
  const text = readFileSync(file, 'utf8').split('\r\n').join('\n');
  // .astro 只看 <style> 段;.css 整份
  const chunks = file.endsWith('.css')
    ? [{ css: text, base: 1 }]
    : [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => ({
        css: m[1],
        base: text.slice(0, m.index).split('\n').length,
      }));
  const rel = file.slice(file.indexOf('/src/') + 1);
  for (const { css, base } of chunks) {
    const rules = parseRules(css, base);

    // A:同一规则块内同属性重复且值不同
    for (const r of rules) {
      const seen = new Map();
      for (const d of declsOf(r.body)) {
        if (/shadow-ok/.test(d.raw)) continue;
        const prev = seen.get(d.prop);
        if (prev !== undefined && prev !== d.value) {
          hits.push(`${rel}:${r.line}  规则 \`${r.sel}\` 内 \`${d.prop}\` 声明了两次(\`${prev}\` → \`${d.value}\`),前一条是死声明`);
        }
        seen.set(d.prop, d.value);
      }
    }

    /* B:同一选择器 + 同一属性,在特异度相同的两处声明,而**先写的那条永远赢不了**。
       两种形态都收:
         B1 两处的 media 条件完全相同 —— 同上下文重复,后写的赢;
         B2 先写的那条条件**更窄**(是后者条件的超集,如「860 宽」内再套「520 高」),后写的更宽
            —— 嵌套 media 不增加特异度,同一层里仍是源序决胜,于是「更窄条件」反而被基础值原样压掉。
            这一类最阴:写的人以为「更具体所以会赢」,实际一条都没落地,且没有任何反馈。 */
    const conds = (at) => (at ? at.split(' && ').filter(Boolean) : []);
    /* 把 media 条件解析成每个尺寸特征的数值区间:(max-width:860px) → width ∈ [0,860]。
       只有这样才认得出「正交但相交」——(max-height:520) 与 (max-width:860) 互不为超集,
       而横屏手机同时满足两者,先写的那条在交集里必输(旧判据在这里直接跳过,漏了整族)。 */
    const ranges = (at) => {
      const r = new Map();
      for (const m of at.matchAll(/\((max|min)-(width|height)\s*:\s*([\d.]+)px\)/g)) {
        const [, mm, dim, v] = m;
        const n = +v;
        const cur = r.get(dim) ?? [0, Infinity];
        if (mm === 'max') cur[1] = Math.min(cur[1], n);
        else cur[0] = Math.max(cur[0], n);
        r.set(dim, cur);
      }
      return r;
    };
    /* 非尺寸条件(print / prefers-reduced-motion / @supports …)不同时一律不报:保守漏报,不误报 */
    const others = (at) =>
      conds(at)
        .map((c) => c.replace(/\((max|min)-(width|height)\s*:\s*[\d.]+px\)/g, '').replace(/^@\w+/, '').trim())
        .filter(Boolean)
        .sort()
        .join('|');
    const dims = (A, B) => new Set([...A.keys(), ...B.keys()]);
    const intersects = (A, B) => {
      for (const d of dims(A, B)) {
        const [alo, ahi] = A.get(d) ?? [0, Infinity];
        const [blo, bhi] = B.get(d) ?? [0, Infinity];
        if (Math.max(alo, blo) > Math.min(ahi, bhi)) return false; // 互斥分支,各管各的
      }
      return true;
    };
    const superset = (A, B) => {
      for (const d of dims(A, B)) {
        const [alo, ahi] = A.get(d) ?? [0, Infinity];
        const [blo, bhi] = B.get(d) ?? [0, Infinity];
        if (blo < alo || bhi > ahi) return false;
      }
      return true; // A ⊇ B:先写的比后写的宽 = 正常的「基础值 + 更窄断点覆盖」
    };
    const bySel = new Map();
    for (const r of rules) {
      if (!bySel.has(r.sel)) bySel.set(r.sel, []);
      bySel.get(r.sel).push({ ...r, decls: declsOf(r.body) });
    }
    for (const [sel, rs] of bySel) {
      if (rs.length < 2) continue;
      for (let x = 0; x < rs.length; x++) {
        for (let y = x + 1; y < rs.length; y++) {
          const a = rs[x], b = rs[y]; // a 在源码里更早
          const same = a.at === b.at;
          let aNarrower = false;
          if (!same) {
            if (others(a.at) !== others(b.at)) continue; // 非尺寸条件不同 → 保守不报
            const A = ranges(a.at), B = ranges(b.at);
            if (!intersects(A, B)) continue; // 两个分支互斥,各管各的
            if (superset(A, B)) continue; // 先写的更宽 = 正常的「基础值 + 更窄断点覆盖」
            aNarrower = true; // 先写的更窄、或与后写的正交相交 —— 在交集里它必输
          }
          for (const da of a.decls) {
            if (/shadow-ok/.test(da.raw)) continue;
            const db = b.decls.find((d) => d.prop === da.prop && !/shadow-ok/.test(d.raw));
            if (!db || db.value === da.value) continue;
            hits.push(
              `${rel}:${a.line}  选择器 \`${sel}\` 的 \`${da.prop}: ${da.value}\` 被 :${b.line} 的 \`${db.value}\` 压掉` +
                (same
                  ? `(同一上下文${a.at ? ` @ ${a.at}` : ''}重复声明,源序决胜)`
                  : `(此处条件更窄 @ ${a.at},但嵌套 media 不加特异度,仍由后写的 ${b.at || '基础规则'} 决胜)`),
            );
          }
        }
      }
    }
  }
}

/* ── 判据 C:伪元素挂在替换元素上 ──
   <img> / <input> / <br> / <hr> / <video> / <canvas> / <embed> / <iframe> 没有伪元素盒,
   「::before」/「::after」 写在它们身上不渲染 —— 声明在、用值宽高恒 auto、屏上什么都没有,
   而计算样式读起来「有这条规则」,肉眼与静态检查都发现不了(实录:页脚记号的护字层)。 */
{
  const REPLACED = /<(img|input|br|hr|video|canvas|embed|iframe)\b([^>]*)>/gi;
  for (const file of walk(SRC)) {
    if (!file.endsWith('.astro')) continue;
    const text = readFileSync(file, 'utf8').split('\r\n').join('\n');
    const rel = file.slice(file.indexOf('/src/') + 1);
    // 收集替换元素上的 class
    const replacedClasses = new Set();
    for (const m of text.matchAll(REPLACED)) {
      const cls = m[2].match(/\bclass\s*=\s*["']([^"']+)["']/);
      if (cls) for (const c of cls[1].trim().split(/\s+/)) replacedClasses.add(c);
    }
    if (!replacedClasses.size) continue;
    // 在同文件的 <style> 里找 .那个class::before/::after { … content: … }
    for (const st of text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
      const css = st[1];
      const base = text.slice(0, st.index).split('\n').length;
      for (const r of parseRules(css, base)) {
        const m = r.sel.match(/\.([A-Za-z0-9_-]+)::?(before|after)\b/);
        if (!m || !replacedClasses.has(m[1])) continue;
        if (!/\bcontent\s*:/.test(r.body)) continue;
        if (/shadow-ok/.test(r.body)) continue;
        hits.push(
          `${rel}:${r.line}  \`${r.sel}\` 挂在替换元素(<img> 一类)上 —— 伪元素不会渲染,这条规则是空操作;` +
            ` 把它套一层非替换元素的壳,或改用真实子元素`,
        );
      }
    }
  }
}

if (hits.length) {
  console.log(`[css-shadowed] ✘ ${hits.length} 条被层叠压掉的声明:`);
  for (const h of hits) console.log(`  - ${h}`);
  console.log('  要覆盖请用更窄的选择器或更后的位置;确系有意,在该行加 /* shadow-ok */ 留痕。');
  process.exit(1);
}
console.log('[css-shadowed] ✓ 无被压掉的死声明');
process.exit(0);
