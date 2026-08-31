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
  /* 从 CRON_JOBS 登记表取「代码处理的 cron」——通用判据,不再硬编码具体表达式(复测 O11)。
     取块内的字符串键;块以 `const CRON_JOBS` 起、到首个单独 `};` 止。 */
  const block = /const CRON_JOBS[\s\S]*?\n};/.exec(srcText)?.[0] ?? '';
  const handled = [...block.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]);
  const out = [];
  out.push([block.length > 0, 'index.ts 有 CRON_JOBS 登记表(定时任务的单一真源)']);
  out.push([handled.length > 0, `登记表里有 ${handled.length} 条定时任务`]);
  // 双向:代码处理的必须声明,声明的必须有人处理(否则要么死代码、要么白跑一趟)
  for (const h of handled) out.push([declared.includes(h), `代码处理的 cron "${h}" 已在 wrangler.jsonc 声明`]);
  for (const dcl of declared) out.push([handled.includes(dcl), `声明的 cron "${dcl}" 在 CRON_JOBS 里有处理函数`]);
  out.push([cfg.d1_databases?.[0]?.migrations_dir === 'migrations', 'D1 迁移目录声明正确']);
  const seqOk = migFiles.every((f, i) => f.startsWith(String(i + 1).padStart(4, '0')));
  out.push([seqOk, `迁移序号连续(${migFiles.length} 个:${migFiles.join(', ')})`]);
  return out;
}

const cfgText = read('wrangler.jsonc');
const srcText = read('src/index.ts');
const migFiles = readdirSync(path.join(here, 'migrations')).filter((f) => f.endsWith('.sql')).sort();

if (process.argv.includes('--self-test')) {
  // 双向注入,证明两个方向都真会红(防假门)
  const missingDecl = cfgText.replace(/"crons":\s*\[[^\]]*\]/, '"crons": ["10 0 * * *"]'); // 声明少一条
  say(check(missingDecl, srcText, migFiles).some(([ok]) => !ok), 'self-test:代码处理了但配置没声明 → 变红');
  const extraDecl = cfgText.replace(/"crons":\s*\[([^\]]*)\]/, '"crons": [$1, "5 5 * * *"]'); // 声明多一条无人处理
  say(check(extraDecl, srcText, migFiles).some(([ok]) => !ok), 'self-test:配置声明了但没人处理 → 变红');
  const noTable = srcText.replace(/const CRON_JOBS[\s\S]*?\n};/, 'const CRON_JOBS = {};');
  say(check(cfgText, noTable, migFiles).some(([ok]) => !ok), 'self-test:登记表被清空 → 变红');
  say(check(cfgText, srcText, migFiles).every(([ok]) => ok), 'self-test:真实配置全绿(不误报)');
  process.exit(fails ? 1 : 0);
}

for (const [ok, msg] of check(cfgText, srcText, migFiles)) say(ok, msg);
console.log(fails === 0 ? 'PASS gate-config-consistency' : `FAIL gate-config-consistency(${fails})`);
process.exit(fails ? 1 : 0);
