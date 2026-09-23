#!/usr/bin/env node
/* 配置一致性门(2026-09-01 驾驶舱复测 R2-P1 焊入)。
   代码里分流用到的 cron 字面量必须都在 wrangler.jsonc 声明——没声明的 cron 永远不会被派发,
   对应分支即死代码,而单测与黑盒都看不出来(实录:6h 探活巡检的配置漏进 commit,
   「已修」在干净 checkout 上等于没修,只有 git 层能发现)。
   ⚠️ 必须是独立 node 脚本:worker 测试跑在 workerd 沙箱里读不到仓内任意文件。
   用法:node gate-config-consistency.mjs   自检:--self-test(注入不一致必须变红) */
import { readFileSync, readdirSync, realpathSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(here, p), 'utf8');
/* JSONC 解析改用 lib/read-jsonc.mjs(2026-09-01 收账):
   此前是两条正则,读不懂行尾 `//`,而那是 wrangler 完全接受的写法。
   正则判不出「这个斜杠在不在字符串里」,所以补排除表补不完;换成字符串感知的扫描器。
   同一个读取器 `test-static.mjs` 也在用——同一份配置只能有一种「什么算合法」的理解。 */
import { parseJsonc } from './lib/read-jsonc.mjs';

const ASTRO_TEXT = read('../astro.config.mjs');
const VALIDATOR_TEXT = read('../schema/src/validators.ts');
const DRAFT_FIELDS_TEXT = read('../schema/src/draft-fields.ts');
const TRANSLATION_STATE_TEXT = read('src/translation-state.ts');
const LABEL_TEXT = read('../admin/src/pages/publish.tsx');

let fails = 0;
const say = (ok, msg) => {
  console.log(`${ok ? '✓' : '✗'} ${msg}`);
  if (!ok) fails++;
};

function check(cfgText, srcText, migFiles, astroText = ASTRO_TEXT, validatorText = VALIDATOR_TEXT, labelText = LABEL_TEXT, draftFieldsText = DRAFT_FIELDS_TEXT, translationStateText = TRANSLATION_STATE_TEXT) {
  // 读不动就明说读不动在哪一处,别只抛一段栈(第四轮 P2-12);parseJsonc 会带出出错位置附近的原文
  let cfg;
  try {
    cfg = parseJsonc(cfgText, 'wrangler.jsonc');
  } catch (e) {
    return [[false, String(e).slice(0, 220)]];
  }
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
  /* 🔴 还要解开**目录链接**(junction / symlink):把 dist-live 做成指向 dist 的 junction,
     resolve 后的字符串仍然不同,而它实际指向的就是构建产物目录——实测门照样判绿(第四轮 P2)。
     路径不存在时退回 resolve(全新 checkout 还没造出 dist-live,不该因此崩)。 */
  const norm = (p) => {
    const abs = path.resolve(here, p);
    return (existsSync(abs) ? realpathSync(abs) : abs).replace(/\\/g, '/');
  };
  out.push([!!served, 'wrangler.jsonc 声明了 assets.directory']);
  const outAbs = norm(path.join('..', outDir));
  out.push([norm(served) !== outAbs, `伺服目录(${served} → ${norm(served)})≠ 构建输出目录(${outAbs})——门重建产物碰不到线上`]);
  out.push([norm(served).endsWith('/dist-live'), `伺服目录是已发布快照(${norm(served)})`]);

  /* 🔴 失败面的规则名映射必须与校验器的规则集**双向**相等。
     缺映射 → 用户看到机器规则名;多映射 → 死键(曾凭空多出一个校验器从不产出的 'all-hidden-sku')。 */
  /* 规则名允许数字:此前 [a-z-]+ 让 'h1-count' / 'seo-length2' 这类命名对本门**完全隐形**——
     不是判错,是根本没看见,而没看见的东西不会让任何断言变红(第四轮 P2-10 提出、第五轮 P1-3 证明未落地)。 */
  const sharedBlock = /export function validateTranslationValue[\s\S]*?^}/m.exec(draftFieldsText)?.[0] ?? '';
  const sharedRules = [...sharedBlock.matchAll(/return\s+'([a-z0-9-]+)'/g)].map((m) => m[1]).filter((r) => r !== 'empty');
  const literalRules = [validatorText, translationStateText].flatMap((source) => [...source.matchAll(/rule:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]));
  const rules = [...new Set(literalRules.concat(sharedRules))];
  const labelBlock = /const RULE_LABEL[\s\S]*?\n};/.exec(labelText)?.[0] ?? '';
  const labels = [...new Set([...labelBlock.matchAll(/(?:^|[{,]\s*)'?([a-z][a-z0-9-]*)'?\s*:/gm)].map((m) => m[1]))].filter((k) => k !== 'RULE_LABEL');
  out.push([rules.length > 5, `校验器里解析到 ${rules.length} 条规则`]);
  out.push([sharedBlock.length > 0, '共用译文校验规则可解析']);
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
  /* 目录链接绕过:把伺服目录做成指向构建产物的 junction。
     用临时链接实测,不是拿字符串假装——realpath 解不开链接的话这条会漏(第四轮 P2 实录)。 */
  {
    const linkPath = path.join(here, '..', '.gate-selftest-link');
    let made = false;
    try {
      symlinkSync(path.join(here, '..', 'dist'), linkPath, 'junction');
      made = true;
    } catch { /* 无权限建链接的环境(如受限 CI)跳过,但要说明,不静默 */ }
    if (made) {
      const linked = cfgText.replace(/"directory":\s*"[^"]*"/, '"directory": "../.gate-selftest-link"');
      say(check(linked, srcText, migFiles).some(([ok]) => !ok), 'self-test:伺服目录做成指向构建产物的链接 → 变红');
      rmSync(linkPath, { recursive: false, force: true });
    } else {
      console.log('· self-test:本环境建不了目录链接,该形态未验(不是通过)');
    }
  }
  // 失败面多一个校验器从不产出的死键
  const deadKey = LABEL_TEXT.replace(/const RULE_LABEL: Record<string, string> = \{/, "const RULE_LABEL: Record<string, string> = {\n  'no-such-rule': '不存在的规则',");
  say(check(cfgText, srcText, migFiles, ASTRO_TEXT, VALIDATOR_TEXT, deadKey).some(([ok]) => !ok), 'self-test:失败面多一个死键 → 变红');
  // 校验器新增规则但失败面没跟上
  const newRule = VALIDATOR_TEXT.replace(/rule: 'structure'/, "rule: 'brand-new-rule'");
  say(check(cfgText, srcText, migFiles, ASTRO_TEXT, newRule).some(([ok]) => !ok), 'self-test:校验器新增规则而失败面缺映射 → 变红');
  const newSharedRule = DRAFT_FIELDS_TEXT.replace("return 'stale-brand'", "return 'stale-brand'; if (false) return 'h1-shared-rule'");
  say(
    check(cfgText, srcText, migFiles, ASTRO_TEXT, VALIDATOR_TEXT, LABEL_TEXT, newSharedRule)
      .some(([ok, msg]) => !ok && String(msg).includes('h1-shared-rule')),
    'self-test:共用译文校验新增规则而失败面缺映射 → 点名变红',
  );
  /* 🔴 这条自检 2026-09-01 换了判据。上一版断言的是**缺陷行为本身**:
     「配置里有行尾注释 → 门要给人话诊断」——那是在门读不懂行尾注释的前提下的将就。
     换成字符串感知的读取器后行尾注释根本读得动,于是这条自检开始为**正确行为**报红。
     判据要跟着能力走:能读的就断言读得动,读不动的(真坏了的配置)才断言给人话诊断。 */
  const trailing = cfgText.replace('"directory":', '"directory": /* 说明 */');
  say(check(trailing, srcText, migFiles).every(([ok]) => ok), 'self-test:配置含注释 → 照常读得动(不再当成读不动)');
  const broken = cfgText.replace('"assets"', '"assets" MALFORMED');
  say(
    check(broken, srcText, migFiles).some(([ok, m]) => !ok && String(m).includes('wrangler.jsonc 解析失败')),
    'self-test:配置真的坏了 → 给人话诊断(点名来源)而不是抛栈',
  );
  /* 规则名含数字必须被本门看见。
     🔴 这条自检上一版是**假绿**(第五轮 P1-3):它用「把 structure 换成 h1-count」来注入,
     于是门变红的真实原因是「structure 的映射突然多余了」,与「认不认数字」毫无关系——
     换成 `brandnewrule`(纯字母)同样会红。**替换式变异会把别的断言的红算到自己头上。**
     正确形态是**新增**一条:只有当门真的看见 h1-count、发现它没有映射时才会红。
     这正是「自选变异 = 假信心」的实例:变异要能把「修法在场」与「修法不在场」区分开,
     否则它测的是别的东西。 */
  const numRule = VALIDATOR_TEXT.replace("rule: 'structure'", "rule: 'structure' }); void ({ rule: 'h1-count'");
  const numRes = check(cfgText, srcText, migFiles, ASTRO_TEXT, numRule);
  say(
    numRes.some(([ok, m]) => !ok && String(m).includes('h1-count')),
    'self-test:**新增**一条带数字的规则名(h1-count)→ 门必须点名它缺映射',
  );
  say(check(cfgText, srcText, migFiles).every(([ok]) => ok), 'self-test:真实配置全绿(不误报)');
  process.exit(fails ? 1 : 0);
}

for (const [ok, msg] of check(cfgText, srcText, migFiles)) say(ok, msg);
console.log(fails === 0 ? 'PASS gate-config-consistency' : `FAIL gate-config-consistency(${fails})`);
process.exit(fails ? 1 : 0);
