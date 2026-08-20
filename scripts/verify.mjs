#!/usr/bin/env node
/* NexGrid website verify 门骨架(T1 先立门后写页)。
   门源:官网 PRD §1.4(合规红线)+ §6(验收标准)。
   用法:node scripts/verify.mjs [--prod]
   --prod = 部署门升为阻断(PENDING 标记/Legal 缺失 exit 2);默认仅告警。
   退出码写 .verify-exit.code(外部判定读文件不读管道——PLAN 全局纪律)。 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SRC = join(ROOT, 'src');
const PROD = process.argv.includes('--prod');
const results = [];

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

/* ── 汇总 ── */
let failed = 0;
for (const r of results) {
  const mark = r.pass ? (r.warn ? '⚠' : '✓') : '✗';
  console.log(`[verify] ${mark} ${r.gate}${r.detail.length ? '' : ' — clean'}`);
  for (const d of r.detail.slice(0, 20)) console.log(`         ${d}`);
  if (!r.pass) failed++;
}
const code = failed ? 2 : 0;
console.log(`[verify] ${results.length - failed}/${results.length} gates pass${PROD ? ' (prod mode)' : ''}`);
writeFileSync(join(ROOT, '.verify-exit.code'), String(code));
process.exit(code);
