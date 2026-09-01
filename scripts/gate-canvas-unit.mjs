/* 第七门 · 画布危险写法(静态) — R42 立,R43 按评审 8 例注入(放行 6)收口
   ────────────────────────────────────────────────────────────
   整体缩放下,画布内任何 px 都自动是画布像素,「配对值掉队」整族按构造消失。
   剩下三类静态可查的真危险(①② R42/R43 立,③ R50 立):

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
      而当时两道门都看不见。这条判据纯静态、零误报。

   ③ **字身单位(ch / ex / ic / cap 及其 r 前缀)会锁在字体就绪前的兜底度量** — R50 立
      这四个单位的长度来自字体文件里的字形量(ch = '0' 的 advance)。`font-display:swap` 的 block 期
      (面还在下载、还没有可用面)Chromium 按规范用兜底值(ch=0.5em)算;**字体到位后的重算不可靠——
      偶发漏掉,长度就锁死在那个 0.5em 值上,document.fonts.ready 之后重量也不会自我纠正**,刷新才可能复原。
      (对照实验:人为延迟字体请求 1.5s、窗口越过 block 期后它是会重算的——问题不是「从不重算」
       而是「重算不可靠」,这正是非确定性的来源,也是它无法用一次实测证伪的原因。)
      实测(vi 首页,25 轮 × 每路由独立首次导航):约 4~8% 的加载命中,首屏 `50ch` 从 367px 掉到 300px,
      左列 −18%、次句从一行折成两行。三个特征让它躲过了此前全部十三道门与四十多轮人工走查:
        · 两态下 font-family 与实测字身宽**完全相同**,只有长度是陈的 → 常规断言与肉眼都判不出;
        · 失效是**逐条声明**独立的(同页三条 ch 不同时中招)→ 抽查一条不能代表另一条;
        · 非确定性 → 「我这次没复现」不是证据。
      替代写法:`calc(N * var(--x-ch-mono|--x-ch-display|--x-ch-display-vi))`(常数见 tokens.css)。
      逃生阀:同行或上一行标 glyph-unit-ok。 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const LF = String.fromCharCode(10);
/* 视口单位全表:标准 + 逻辑(vi/vb)+ small/large/dynamic 前缀;大小写不敏感 */
const VU = '(?:[sldSLD]?[vV](?:[wWhH]|[iI]|[bB]|min|max|MIN|MAX|Min|Max))';
const VU_TOKEN = new RegExp('(-?\\d[\\d.]*)\\s*(' + VU + ')\\b');
const VU_GLOBAL = new RegExp('(-?\\d[\\d.]*)\\s*(' + VU + ')\\b', 'g');
const EXEMPT = /canvas-exempt/;
const GLYPH_EXEMPT = /glyph-unit-ok/;
/* 字身单位:ch/ex/ic/cap + CSS Values 4 的 root 变体 rch/rex/ric/rcap。大小写不敏感(50CH 同样是长度)。
   两道守卫各管一件事,别合并成一个字符集(合并过,漏了负值——见下):
     `(?<![\w#])`            挡 `flex` / `search` 这类标识符尾巴,以及 `#00cap` 这类十六进制色;
     `(?<!(?<=[\w-])-)`      只挡「属于标识符的那种连字符」(`--card-4ch` / `.col-2ch` 里数字紧跟的 `-`),
                             放行「值位置上的一元负号」(`-2ch`)。
   🔴 曾写成 `(?<![\w#-])` 一把挡掉所有 `-`:`text-indent:-2ch` / `margin:0 -3ch` 这类**负值全部漏判**,
      而 `-0.5ex` 因为小数点不在排除集里侥幸命中——「测了一条负值就以为负值都覆盖了」正是这条的坑。
      CSS 里 `-` 后面直接跟数字不构成合法标识符,所以放行一元负号不会引入误伤。
   数字部分带科学计数法 `(?:[eE][+-]?\d+)?`:`5e1ch` 是合法 CSS 且等于 50ch。
   不覆盖(已知残余,写明免得下次误以为查过了):JS 模板串 `` `${n}ch` ``、CSS 转义 `50\63 h`。 */
const GLYPH_UNIT = /(?<![\w#])(?<!(?<=[\w-])-)(-?\d[\d.]*(?:[eE][+-]?\d+)?)(r?(?:ch|ex|ic|cap|lh))\b/i;

/* 导出成纯函数,好让 --self-test 用表驱动红绿两向验它(判据是正则,正则必须有红测) */
export const glyphUnitHit = (decl) => {
  const m = decl.match(GLYPH_UNIT);
  return m ? m[0] : null;
};
const SAFE_CLAMP = /clamp\(\s*([\d.]+)px\s*,\s*([\d.]+)vw\s*,\s*(?:calc\(\s*([\d.]+)\s*\*\s*var\(--uc?\)\s*\)|([\d.]+)px)\s*\)/gi;
const CANVAS = 1440;

/* 判据①②的取材面(原样保留:它们查的是本站样式层的写法)。 */
const EXT_STYLE = /\.(astro|css|ts|tsx)$/;
/* 判据③的取材面更宽:`ch` 是「全站禁用」,凡是能把 CSS 送进页面的文件都得查。
   🔴 `.md` 不是假想通路 —— Astro 的 markdown 允许裸 HTML,`src/content/learn/**` 有 18 个 .md,
      任何一个写 `<div style="max-width:50ch">` 都会原样进产物,而旧取材面看不见它。
   `.mjs/.js/.jsx` 目前仓里没有,一并纳入是零成本的封口(没有文件就没有开销)。 */
const EXT_GLYPH = /\.(astro|css|ts|tsx|md|mdx|mjs|js|jsx)$/;

const walk = (d, re, out = []) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p, re, out);
    else if (re.test(n)) out.push(p);
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
  const glyph = [];
  const files = walk(srcDir, EXT_STYLE);

  /* ── 判据③ 单独走一遍(取材面更宽,且与画布 zoom / @media 层级都无关)── */
  for (const f of walk(srcDir, EXT_GLYPH)) {
    const lines = stripComments(readFileSync(f, 'utf8'));
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].raw;
      const prev = lines[i - 1] ? lines[i - 1].raw : '';
      if (GLYPH_EXEMPT.test(raw) || GLYPH_EXEMPT.test(prev)) continue;
      for (const d of declsOf(lines[i].code)) {
        const hit = glyphUnitHit(d);
        if (!hit) continue;
        glyph.push(
          `${rel(f)}:${i + 1} 出现字身单位 ${hit} —— 长度取自字体字形量,字体就绪前按兜底值算、` +
            `到位后的重算不可靠,会非确定性地锁死在错值(缘由与实测见本文件头注 ③);` +
            `改 calc(N * var(--x-ch-mono|--x-ch-display)) 之类的实测常数(见 tokens.css),或加 glyph-unit-ok 豁免` +
            `${LF}         ${d.trim().slice(0, 74)}`,
        );
      }
    }
  }

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
  const all = [...refs, ...glyph, ...detail];
  return { gate: 'canvas-hazard(静态·视口单位 + 死引用 + 字身单位)', pass: all.length === 0, detail: all };
}

/* ── 红绿自检:node scripts/gate-canvas-unit.mjs --self-test ──
   判据③是一条正则,而正则的失败模式是**静默漏判**(写法一变就绕过)与**误伤**(把变量名当单位)。
   两向都得钉住:漏判样本来自本仓真实写法,误伤样本来自本仓真实标识符。
   🔴 分两层,缺一层都会留下「表全绿但门不干活」的缝:
     A 纯函数层 —— 判据本身的字符级行为;
     B 接线层(fixture)—— 注释剥离 / 按 `;` 切声明 / 逃生阀查找 这条真实链路。
       表驱动的 A 层**原理上测不到 B 层**:它喂的是完整声明字符串,不经过「整行切碎再判定」那一步。 */
if (process.argv[1] && process.argv[1].endsWith('gate-canvas-unit.mjs') && process.argv.includes('--self-test')) {
  let bad = 0;

  /* A 层:纯函数 */
  const RED = [ // 必须命中
    'max-width: 50ch', 'min-width: calc(5ch + 20 * var(--uc))', 'max-width: min(46ch, 100%)',
    'max-width: 22ch', 'width: 1.5ex', 'height: 3cap', 'inline-size: 10ic',
    'max-width: 50rch', 'width: 2rex', 'padding: 0.5ch 1ch', 'max-width:50CH',
    'width: calc(100% - 2ch)', 'padding: .5ch',
    // 负值族:整数负值曾整族漏判,而 -0.5ex 因小数点侥幸命中 —— 两种形态都要钉
    'text-indent: -2ch', 'margin-left: -1ch', 'margin: 0 -3ch',
    'transform: translateX(-4cap)', '--foo: -10ic', 'letter-spacing: -0.5ex',
    'max-width: 5e1ch', 'max-width: 5E1ch', 'width: 1.2e+2ch', // 科学计数法也是合法长度
    // lh/rlh 同族:line-height:normal 时行高由字体度量算,与 ch 同一个失效面。
    // 本仓 html/body 都没设 line-height,没挂型类的元素继承的就是 normal;当前零使用,
    // 但这道门的立意是「按单位整族封,不按元素点名」—— 族缺一个就是留门。
    'height: 3lh', 'margin-block: 1.5lh', 'padding-top: -2lh', 'height: 2rlh',
  ];
  const GREEN = [ // 必须放过
    'max-width: calc(50 * var(--x-ch-mono))', 'max-width: calc(22 * var(--x-ch-display-vi))',
    '--x-ch-mono: 0.612em', 'display: flex', 'flex: 0 1 auto', 'color: #00ccaa',
    'width: 50px', 'font-size: 1.5rem', 'gap: 2em', 'transition: 0.3s ease',
    'grid-template-columns: repeat(2, 1fr)', 'background: url(art-a1ch.png)', 'font-family: var(--x-font-mono)',
    // 标识符里「数字紧跟连字符」的边界:放行一元负号不能把这两种也放进来
    '--card-4ch: 1px', 'font-size: var(--step-2ex)',
  ];
  for (const d of RED) if (!glyphUnitHit(d)) { console.log(`❌ A 层漏判: ${d}`); bad++; }
  for (const d of GREEN) { const h = glyphUnitHit(d); if (h) { console.log(`❌ A 层误伤: ${d}  →  ${h}`); bad++; } }

  /* B 层:真走一遍文件。断言「命中了哪几行」,而不只是「命中了几条」——
     数量对而行号错(比如注释被当成代码、豁免落在邻行)照样是坏门。 */
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'glyph-gate-'));
  const FIXTURE = [
    '/* 注释里的 50ch 与 -2ch 必须放过(本仓 TrustSection/WhySection 真有这种注释) */', // 1
    '.a { max-width: 50ch; }',                                    // 2  命中
    '.b { text-indent: -2ch; }',                                  // 3  命中(负值)
    '.c { max-width: 50ch; /* glyph-unit-ok */ }',                // 4  同行豁免
    '/* glyph-unit-ok */',                                        // 5
    '.d { max-width: 50ch; }',                                    // 6  上一行豁免
    '@media (max-width: 860px) { .e { max-width: 30ch; } }',      // 7  命中(断点以下不豁免本判据)
    '.f { --x-ch-mono: 0.612em; max-width: calc(50 * var(--x-ch-mono)); }', // 8
    '.g { width: 10px; height: 2ch; }',                           // 9  命中(同行第二条声明)
  ].join(LF);
  writeFileSync(join(dir, 'fixture.css'), FIXTURE);
  // markdown 取材面:Astro 允许 .md 里写裸 HTML,内联 style 会原样进产物
  writeFileSync(join(dir, 'fixture.md'), ['# 标题', '', '<div style="max-width:50ch">正文</div>'].join(LF));
  const hits = canvasUnitGate(dir, (p) => p.split(/[\\/]/).pop()).detail.filter((d) => d.includes('字身单位'));
  const got = hits.filter((d) => d.startsWith('fixture.css'))
    .map((d) => +d.match(/:(\d+) /)[1]).sort((a, b) => a - b);
  const mdHit = hits.some((d) => d.startsWith('fixture.md'));
  rmSync(dir, { recursive: true, force: true });
  const want = [2, 3, 7, 9];
  if (String(got) !== String(want)) { console.log(`❌ B 层接线: css 命中行 [${got}],应为 [${want}]`); bad++; }
  if (!mdHit) { console.log('❌ B 层取材面: .md 里的内联 style 没被查到'); bad++; }

  console.log(bad ? `\n自检失败:${bad} 条` : `\n自检通过:A 层 ${RED.length} 红 + ${GREEN.length} 绿,B 层 css 接线 4 行 + md 取材面`);
  process.exit(bad ? 1 : 0);
}
