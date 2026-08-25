#!/usr/bin/env node
/* NexGrid website verify 门骨架(T1 先立门后写页)。
   门源:官网 PRD §1.4(合规红线)+ §6(验收标准)。
   用法:node scripts/verify.mjs [--prod]
   --prod = 部署门升为阻断(PENDING 标记/Legal 缺失 exit 2);默认仅告警。
   退出码写 .verify-exit.code(外部判定读文件不读管道——PLAN 全局纪律)。 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { canvasUnitGate } from './gate-canvas-unit.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SRC = join(ROOT, 'src');
const PROD = process.argv.includes('--prod');
const results = [];
// 开跑先把退出码文件置红:verify 若中途崩溃或被中止,读文件的人拿到的是红,
// 而不是**上一次的绿**(「中止 ≠ 判红」是本仓踩过的坑——半路崩掉时红门数反而变少)
writeFileSync(join(ROOT, '.verify-exit.code'), '2');

function walk(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}
const rel = (p) => relative(ROOT, p).replaceAll('\\', '/');

/* ── 门 1:禁用词(PRD §1.4-1/3/4)──────────────────────────────
   注意:"not guaranteed" 是免责声明合法用法,模式只抓「保证收益」组合。 */
{
  const PATTERNS = [
    [/guaranteed\s+(returns?|income|profits?|earnings?|yields?)/i, 'guaranteed+收益词'],
    [/risk[-\s]?free/i, 'risk-free'],
    [/\d+(\.\d+)?\s*%\s*(annual\s+|yearly\s+)?(returns?|yields?|APY|APR)/i, '百分比收益承诺'],
    [/(稳赚|保本|包赚|躺赚保证|看涨)/, '中文收益承诺/投机词'],
    [/(lãi\s+suất\s+đảm\s+bảo|không\s+rủi\s+ro)/i, '越南语收益承诺'],
  ];
  const files = walk(SRC, ['.astro', '.ts', '.tsx', '.jsx', '.json', '.md']);
  const hits = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const [re, label] of PATTERNS) {
      const m = text.match(re);
      if (m) hits.push(`${rel(f)}: [${label}] "${m[0]}"`);
    }
  }
  results.push({ gate: 'forbidden-words', pass: hits.length === 0, detail: hits });
}

/* ── 门 2:三语 key parity(PRD §6-2)────────────────────────── */
{
  const keysOf = (obj, prefix = '') =>
    Object.entries(obj).flatMap(([k, v]) =>
      typeof v === 'object' && v !== null ? keysOf(v, `${prefix}${k}.`) : [`${prefix}${k}`],
    );
  const dicts = {};
  for (const l of ['en', 'vi', 'zh']) dicts[l] = new Set(keysOf(JSON.parse(readFileSync(join(SRC, 'i18n', `${l}.json`), 'utf8'))));
  const detail = [];
  for (const l of ['vi', 'zh']) {
    for (const k of dicts.en) if (!dicts[l].has(k)) detail.push(`${l} 缺 key: ${k}`);
    for (const k of dicts[l]) if (!dicts.en.has(k)) detail.push(`${l} 多出 key: ${k}(en 无)`);
  }
  results.push({ gate: 'i18n-parity', pass: detail.length === 0, detail });
}

/* ── 门 3:部署门(PRD §6-4:PENDING 标记 / Legal 缺失禁生产)── */
{
  const detail = [];
  const files = walk(SRC, ['.astro', '.ts', '.tsx', '.json', '.md']);
  for (const f of files) {
    if (readFileSync(f, 'utf8').includes('PENDING-TRUST-ASSETS')) detail.push(`${rel(f)}: 信任资料未填充(PENDING-TRUST-ASSETS)`);
  }
  for (const page of ['legal/privacy', 'legal/terms']) {
    const found = ['.astro', '.md'].some((ext) => existsSync(join(SRC, 'pages', `${page}${ext}`)));
    if (!found) detail.push(`缺 Legal 页: src/pages/${page}.(astro|md)`);
  }
  // 非 --prod 只告警不拦(开发期必然半成品);--prod 阻断
  results.push({ gate: 'deploy-gate' + (PROD ? '' : '(warn-only)'), pass: detail.length === 0 || !PROD, warn: !PROD && detail.length > 0, detail });
}

/* ── 门 4:页内锚点存在性(PRD §6-5 近似;T11 升级为 dist 级死链扫描)── */
{
  const detail = [];
  const pages = walk(join(SRC, 'pages'), ['.astro']);
  const compDirs = [join(SRC, 'components'), join(SRC, 'layouts')].filter(existsSync);
  const compText = compDirs.flatMap((d) => walk(d, ['.astro', '.tsx', '.jsx'])).map((f) => readFileSync(f, 'utf8')).join('\n');
  for (const f of pages) {
    const text = readFileSync(f, 'utf8') + '\n' + compText; // 近似:页 + 全部组件拼接
    const anchors = [...text.matchAll(/href="#([\w-]+)"/g)].map((m) => m[1]);
    const ids = new Set([...text.matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1]));
    for (const a of anchors) if (a && !ids.has(a)) detail.push(`${rel(f)}: href="#${a}" 无对应 id`);
  }
  results.push({ gate: 'anchor-check(src 近似)', pass: detail.length === 0, detail });
}

/* ── 门 5:品牌同值哨兵(R37,R38 收紧)──────────────────────
   官网 --x-accent/--x-on-accent 必须来自 App tokens 的**同一主题块**(官网锚定暗主题柠檬)。
   why:跨仓「单源」此前只活在注释里,App 改品牌值官网会静默漂移;
        R38 再收:只校验「值域命中」时,跨主题错配(电蓝底+黑字 ≈2.4:1)也会绿灯。
   App 仓不存在(独立部署环境)时 warn-only 放行。 */
{
  const APP_TOKENS = 'D:/WORKS/PLAN/Nexion-uniapp/src/styles/tokens.css';
  const detail = [];
  let warn = false;
  if (!existsSync(APP_TOKENS)) {
    warn = true;
    detail.push('App tokens 不在本机(独立环境),跳过比对');
  } else {
    const site = readFileSync(join(SRC, 'styles/tokens.css'), 'utf8');
    const app = readFileSync(APP_TOKENS, 'utf8');
    const hex = (text, name) => {
      const m = text.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})`));
      return m ? m[1].toLowerCase() : null;
    };
    // 取所有最内层 `{...}` 块(选择器写法不限:root/属性选择器/媒体查询内层皆可),
    // 再筛「同块内同时声明 brand 与 on-brand」的配对集
    const blocks = [...app.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]);
    const appPairs = blocks
      .map((b) => ({ brand: hex(b, '--v5-brand'), on: hex(b, '--v5-on-brand') }))
      .filter((p) => p.brand && p.on);
    const sBrand = hex(site, '--x-accent');
    const sOn = hex(site, '--x-on-accent');
    if (!sBrand || !sOn) detail.push('官网缺 --x-accent / --x-on-accent 声明');
    else if (!appPairs.length) detail.push('App 未找到「同块声明 brand+on-brand」的主题块');
    else if (!appPairs.some((p) => p.brand === sBrand && p.on === sOn))
      detail.push(
        `官网 (${sBrand} / ${sOn}) 不是 App 任一主题块的完整配对 [${appPairs.map((p) => `${p.brand}/${p.on}`).join(', ')}] — 品牌漂移或跨主题错配`,
      );
    // 强调文字档必须引用主档,不得另写字面量(封漂移旁路)
    if (!/--x-accent-ink:\s*var\(--x-accent\)/.test(site))
      detail.push('--x-accent-ink 未以 var(--x-accent) 引用主档 — 品牌值第二字面量,门锁不住');
  }
  results.push({ gate: 'brand-parity(App V5)', pass: detail.length === 0 || warn, warn, detail });
}

/* ── 门 6:粒子色相同族哨兵(R38)────────────────────────────
   fx.ts 的粒子三端(暗端/亮端/流光)与品牌主档必须同色相带(±6°)。
   why:三端是 JS 字面量,改一个数就能悄悄漂出柠檬族,评审只能事后靠像素采样发现。 */
{
  const detail = [];
  const fx = readFileSync(join(SRC, 'scripts/fx.ts'), 'utf8');
  const site = readFileSync(join(SRC, 'styles/tokens.css'), 'utf8');
  const bm = site.match(/--x-accent:\s*#([0-9a-fA-F]{6})/);
  const hue = (r, g, b) => {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (!d) return 0;
    let h;
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return ((h * 60) % 360 + 360) % 360;
  };
  if (!bm) detail.push('tokens 缺 --x-accent,无法取品牌色相');
  else {
    const bh = hue(parseInt(bm[1].slice(0, 2), 16), parseInt(bm[1].slice(2, 4), 16), parseInt(bm[1].slice(4, 6), 16));
    // fx 注释里以 `HUE-GUARD:<名> (r, g, b)` 标注三端,门只认标注点(零运行时代码)
    const marks = [...fx.matchAll(/HUE-GUARD:(\w[\w-]*)\s*\((\d+),\s*(\d+),\s*(\d+)\)/g)];
    if (marks.length < 3) detail.push(`fx.ts 粒子色相标注点不足(找到 ${marks.length},应 ≥3:暗端/亮端/流光)`);
    for (const m of marks) {
      const h = hue(+m[2], +m[3], +m[4]);
      const diff = Math.abs(((h - bh + 540) % 360) - 180);
      if (diff > 6) detail.push(`粒子 ${m[1]} 色相 ${h.toFixed(1)}° 偏离品牌 ${bh.toFixed(1)}° 达 ${diff.toFixed(1)}°(>6°)`);
    }
  }
  results.push({ gate: 'particle-hue(同族 ±6°)', pass: detail.length === 0, detail });
}

results.push(canvasUnitGate(SRC, rel));

/* ── 第七门:画布几何(运行时,自建自起产物) ──
   前六门全是静态文本/token 检查,没有一门看渲染盒子——R39 的「正文被挤成 33px」
   在六门全绿的情况下溜进产物,靠人肉才发现。判据与红测见 gate-canvas-geometry.mjs。
   代价:本门要构建+起预览+真渲染,verify 因此从「秒级」变成「分钟级」。 */
{
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'gate-canvas-geometry.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const out = (r.stdout || '').trim().split('\n').filter(Boolean);
  const detail = out.filter((l) => !/^\[geo\] ✓/.test(l)).map((l) => l.replace(/^\s*/, ''));
  if (r.status === 3) {
    // 跑不起来 ≠ 放行:非 prod 走可见 warn(与 brand-parity 的跨仓缺席同体例),prod 硬红
    results.push({ gate: 'canvas-geometry(运行时)', pass: !PROD, warn: !PROD, detail: [...detail, 'NOT-RUN:本门未实际执行,不构成任何背书'] });
  } else {
    results.push({ gate: 'canvas-geometry(运行时)', pass: r.status === 0, detail: r.status === 0 ? [] : detail });
  }
}

/* ── 汇总 ── */
let failed = 0;
for (const r of results) {
  const mark = r.pass ? (r.warn ? '⚠' : '✓') : '✗';
  console.log(`[verify] ${mark} ${r.gate}${r.detail.length ? '' : ' — clean'}`);
  for (const d of r.detail.slice(0, 20)) console.log(`         ${d}`);
  if (!r.pass) failed++;
}
const code = failed ? 2 : 0;
// NOT-RUN 不许混进 pass 计数——「跳过 ≠ 放宽」,报绿必须说清跑了几道
const notRun = results.filter((r) => r.detail.some((d) => d.startsWith('NOT-RUN'))).length;
console.log(
  `[verify] ${results.length - failed - notRun}/${results.length} gates pass${notRun ? ` · ${notRun} NOT-RUN(未执行,不算过)` : ''}${PROD ? ' (prod mode)' : ''}`,
);
writeFileSync(join(ROOT, '.verify-exit.code'), String(code));
process.exit(code);
