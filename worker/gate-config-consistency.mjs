#!/usr/bin/env node
/* 配置一致性门(2026-09-01 驾驶舱复测 R2-P1 焊入)。
   代码里分流用到的 cron 字面量必须都在 wrangler.jsonc 声明——没声明的 cron 永远不会被派发,
   对应分支即死代码,而单测与黑盒都看不出来(实录:6h 探活巡检的配置漏进 commit,
   「已修」在干净 checkout 上等于没修,只有 git 层能发现)。
   ⚠️ 必须是独立 node 脚本:worker 测试跑在 workerd 沙箱里读不到仓内任意文件。
   用法:node gate-config-consistency.mjs   自检:--self-test(注入不一致必须变红) */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(here, p), 'utf8');
const stripJsonc = (s) => s.replace(/^\s*\/\/.*$/gm, '');

let fails = 0;
const say = (ok, msg) => {
  console.log(`${ok ? '✓' : '✗'} ${msg}`);
  if (!ok) fails++;
};

function check(cfgText, srcText, migFiles) {
  const cfg = JSON.parse(stripJsonc(cfgText));
  const declared = cfg.triggers?.crons ?? [];
  const used = [...srcText.matchAll(/event\.cron\s*===\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const out = [];
  out.push([used.length > 0, `index.ts 按 cron 分流(找到 ${used.length} 处比较)`]);
  for (const u of used) out.push([declared.includes(u), `代码比较的 cron "${u}" 已在 wrangler.jsonc 声明`]);
  out.push([declared.includes('10 0 * * *'), '声明了日汇总 cron(10 0 * * *)']);
  out.push([declared.some((c) => /^0 \*\/6 \* \* \*$/.test(c)), '声明了 6 小时探活巡检 cron(0 */6 * * *)']);
  out.push([declared.length >= used.length, `声明数(${declared.length})≥ 代码分流数(${used.length})`]);
  out.push([cfg.d1_databases?.[0]?.migrations_dir === 'migrations', 'D1 迁移目录声明正确']);
  const seqOk = migFiles.every((f, i) => f.startsWith(String(i + 1).padStart(4, '0')));
  out.push([seqOk, `迁移序号连续(${migFiles.length} 个:${migFiles.join(', ')})`]);
  return out;
}

const cfgText = read('wrangler.jsonc');
const srcText = read('src/index.ts');
const migFiles = readdirSync(path.join(here, 'migrations')).filter((f) => f.endsWith('.sql')).sort();

if (process.argv.includes('--self-test')) {
  // 注入「代码用了但没声明」的不一致,门必须变红(防假门)
  const brokenCfg = cfgText.replace(/"crons":\s*\[[^\]]*\]/, '"crons": ["10 0 * * *"]');
  const res = check(brokenCfg, srcText, migFiles);
  const reds = res.filter(([ok]) => !ok).length;
  say(reds > 0, `self-test:抽掉 6h cron 后确实变红(${reds} 条)`);
  const clean = check(cfgText, srcText, migFiles).filter(([ok]) => !ok).length;
  say(clean === 0, 'self-test:真实配置无红(不误报)');
  process.exit(fails ? 1 : 0);
}

for (const [ok, msg] of check(cfgText, srcText, migFiles)) say(ok, msg);
console.log(fails === 0 ? 'PASS gate-config-consistency' : `FAIL gate-config-consistency(${fails})`);
process.exit(fails ? 1 : 0);
