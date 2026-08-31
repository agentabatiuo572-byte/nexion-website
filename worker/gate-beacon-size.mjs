#!/usr/bin/env node
/* 体积门(plan T4-AC3):埋点脚本 gzip ≤2KB——守「零框架 JS/性能预算」承诺。
   实测形态:metrics.ts 无 import → Astro 将其内联进每页 HTML(更优:零额外请求、DNT 判断更早)。
   门做两件事:①从 dist/index.html 抽出含 'doNotTrack'+'/api/e' 双标记的内联 <script>,gzip ≤2048;
   ②全站每个 index.html 恰含 1 份(缺=没挂上,多=重复注入)。用法:node gate-beacon-size.mjs(先 build)。 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIMIT = 2048;
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
if (!existsSync(DIST)) {
  console.error('✗ 缺 dist —— 先在站仓根 npm run build');
  process.exit(3);
}

function htmlFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...htmlFiles(p));
    else if (name === 'index.html' || name === '404.html') out.push(p);
  }
  return out;
}

const pages = htmlFiles(DIST);
if (pages.length < 10) {
  console.error(`✗ dist 只有 ${pages.length} 页,产物可疑`);
  process.exit(3);
}

let fails = 0;
// ① 体积:从首页抽内联脚本
const home = readFileSync(path.join(DIST, 'index.html'), 'utf8');
const scripts = [...home.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)]
  .map((m) => m[1])
  .filter((s) => s.includes('doNotTrack') && s.includes('/api/e'));
if (scripts.length !== 1) {
  console.error(`✗ 首页期望恰 1 段埋点内联脚本,实际 ${scripts.length}`);
  fails++;
} else {
  const bytes = gzipSync(Buffer.from(scripts[0]), { level: 9 }).length;
  const ok = bytes <= LIMIT;
  console.log(`${ok ? '✓' : '✗'} 埋点内联脚本 gzip=${bytes}B(上限 ${LIMIT}B)`);
  if (!ok) fails++;
}
// ② 覆盖:每页恰 1 份
let missing = 0;
let dup = 0;
for (const p of pages) {
  const n = (readFileSync(p, 'utf8').match(/doNotTrack/g) ?? []).length;
  if (n === 0) missing++;
  else if (n > 1) dup++;
}
if (missing || dup) {
  console.error(`✗ 页面覆盖异常:缺失 ${missing} 页,重复 ${dup} 页(共 ${pages.length} 页)`);
  fails++;
} else {
  console.log(`✓ 全站 ${pages.length} 页每页恰 1 份埋点脚本`);
}
process.exit(fails ? 1 : 0);
