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
/* JSONC 注释清理:块注释 + 行首行注释。
   块注释这一半是 2026-09-01 补的——wrangler.jsonc 里加一段 `/* … *\/` 说明(合法 JSONC,wrangler 自己读得动)
   就让本门整个崩掉。崩了是失败关闭、不算放过,但一道读不懂被守文件半数合法语法的门,迟早会以别的形式咬人。
   行注释仍只吃行首那种:URL 里的 `//` 不能误伤。 */
const stripJsonc = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const ASTRO_TEXT = read('../astro.config.mjs');
const VALIDATOR_TEXT = read('../schema/src/validators.ts');
const LABEL_TEXT = read('../admin/src/pages/publish.tsx');

let fails = 0;
const say = (ok, msg) => {
  console.log(`${ok ? '✓' : '✗'} ${msg}`);
  if (!ok) fails++;
};

function check(cfgText, srcText, migFiles, astroText = ASTRO_TEXT, validatorText = VALIDATOR_TEXT, labelText = LABEL_TEXT) {
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

  /* 🔴 线上伺服目录必须是**已发布快照**,不是构建产物(2026-09-01 复验 P1-C)。
     P0-3 的整条修法就靠 wrangler.jsonc 里这一个 token,而全仓没有一处断言它——
     把它改回 ../dist,门链依旧全绿、单测全绿,那条已修的 P0 就原样复活了。
     判据构造性:伺服目录必须 ≠ astro 的构建输出目录(astro.config 无 outDir 时默认 dist)。 */
  const served = cfg.assets?.directory ?? '';
  const outDir = /outDir\s*:\s*['"]([^'"]+)['"]/.exec(astroText)?.[1] ?? 'dist';
  /* 🔴 按**解析后的真实路径**比,不按字符串比(2026-09-01 复验 P2):
     `"../dist-live/../dist"` 字面上既不等于 `dist` 也含有 `dist-live`,字符串判据会放行,
     而它 resolve 出来就是构建产物目录 —— P0-3 可原样复活且门全绿。 */
  const norm = (p) => path.resolve(here, p).replace(/\\/g, '/');
  out.push([!!served, 'wrangler.jsonc 声明了 assets.directory']);
  const outAbs = path.resolve(here, '..', outDir).replace(/\\/g, '/');
  out.push([norm(served) !== outAbs, `伺服目录(${served} → ${norm(served)})≠ 构建输出目录(${outAbs})——门重建产物碰不到线上`]);
  out.push([norm(served).endsWith('/dist-live'), `伺服目录是已发布快照(${norm(served)})`]);

  /* 🔴 失败面的规则名映射必须与校验器的规则集**双向**相等。
     缺映射 → 用户看到机器规则名;多映射 → 死键(曾凭空多出一个校验器从不产出的 'all-hidden-sku')。 */
  const rules = [...new Set([...validatorText.matchAll(/rule:\s*'([a-z-]+)'/g)].map((m) => m[1]))];
  const labelBlock = /const RULE_LABEL[\s\S]*?\n};/.exec(labelText)?.[0] ?? '';
  const labels = [...new Set([...labelBlock.matchAll(/(?:^|[{,]\s*)'?([a-z][a-z-]*)'?\s*:/gm)].map((m) => m[1]))].filter((k) => k !== 'RULE_LABEL');
  out.push([rules.length > 5, `校验器里解析到 ${rules.length} 条规则`]);
  for (const r of rules) out.push([labels.includes(r), `校验规则 "${r}" 在失败面有大白话映射`]);
  for (const l of labels) out.push([rules.includes(l), `失败面映射的 "${l}" 是校验器真会产出的规则(非死键)`]);
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
  // 伺服目录被改回构建产物 —— 这正是 P0-3 复活的形态
  const servedDist = cfgText.replace(/"directory":\s*"[^"]*"/, '"directory": "../dist"');
  say(check(servedDist, srcText, migFiles).some(([ok]) => !ok), 'self-test:伺服目录改回构建产物 → 变红');
  // 绕过写法:字面上既不等于 dist、又含有 dist-live,但 resolve 出来就是构建产物
  const sneaky = cfgText.replace(/"directory":\s*"[^"]*"/, '"directory": "../dist-live/../dist"');
  say(check(sneaky, srcText, migFiles).some(([ok]) => !ok), 'self-test:伺服目录用 ../dist-live/../dist 绕 → 变红');
  // 失败面多一个校验器从不产出的死键
  const deadKey = LABEL_TEXT.replace(/const RULE_LABEL: Record<string, string> = \{/, "const RULE_LABEL: Record<string, string> = {\n  'no-such-rule': '不存在的规则',");
  say(check(cfgText, srcText, migFiles, ASTRO_TEXT, VALIDATOR_TEXT, deadKey).some(([ok]) => !ok), 'self-test:失败面多一个死键 → 变红');
  // 校验器新增规则但失败面没跟上
  const newRule = VALIDATOR_TEXT.replace(/rule: 'structure'/, "rule: 'brand-new-rule'");
  say(check(cfgText, srcText, migFiles, ASTRO_TEXT, newRule).some(([ok]) => !ok), 'self-test:校验器新增规则而失败面缺映射 → 变红');
  say(check(cfgText, srcText, migFiles).every(([ok]) => ok), 'self-test:真实配置全绿(不误报)');
  process.exit(fails ? 1 : 0);
}

for (const [ok, msg] of check(cfgText, srcText, migFiles)) say(ok, msg);
console.log(fails === 0 ? 'PASS gate-config-consistency' : `FAIL gate-config-consistency(${fails})`);
process.exit(fails ? 1 : 0);
