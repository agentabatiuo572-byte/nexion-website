#!/usr/bin/env node
/* 等价性基线门(CON16-A2 / §6-4,本包命门):
   ① 种子配置必须自洁(validateConfig 零 error——顺带证明词表对现网文案零误伤)
   ② 物化(种子)≡ 仓内 src/i18n/{en,vi,zh}.json 逐字节一致
   ③ site.json 的 stats/skus 值 ≡ src/lib 现 TS 导出深等
   ④ 已落盘种子(seed/)若存在,须与现仓重算结果深等(内容漂移哨兵)
   --self-test:注入一处变异,断言比较器真会红(防假门)。 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSeed } from './build-seed.mjs';
import { materializeI18n, materializeSiteJson } from '../schema/src/materialize.ts';
import { validateConfig } from '../schema/src/validators.ts';
import { LOCALES } from '../schema/src/locales.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const SITE = path.join(here, '..');
let fails = 0;
const say = (ok, msg) => {
  console.log(`${ok ? '✓' : '✗'} ${msg}`);
  if (!ok) fails++;
};

const { config, manifest } = buildSeed();

// --self-test:变异一处后必须能测出差异(证比较器非摆设)
if (process.argv.includes('--self-test')) {
  const mutated = structuredClone(config);
  mutated.copy.en['hero.subtitle'] = 'MUTATED-FOR-SELF-TEST';
  const out = materializeI18n(mutated, manifest, 'en');
  // CRLF 归一与主门 ② 同式(T9 验收 P2:不归一时 Windows 检出下断言恒真,防假门保护空转)
  const orig = readFileSync(path.join(SITE, 'src/i18n/en.json'), 'utf8').replaceAll('\r\n', '\n');
  const clean = materializeI18n(config, manifest, 'en');
  say(clean === orig, 'self-test:未变异时基线相等(排除检出格式噪声)');
  say(out !== orig, 'self-test:注入变异 → 物化结果确实偏离原文件(比较器活着)');
  const v = validateConfig(mutated, manifest);
  say(v.errors.length === 0, 'self-test:变异值本身合法(不该误报)');
  process.exit(fails ? 1 : 0);
}

// ① 种子自洁
const v = validateConfig(config, manifest);
say(v.errors.length === 0, `种子自洁:validateConfig errors=${v.errors.length}${v.errors.length ? ' 首条:' + JSON.stringify(v.errors[0]) : ''}`);
if (v.warnings.length) console.log(`  (软警告 ${v.warnings.length} 条,预期含统计锚值 5 条)`);

/* ② i18n 三语逐字节。
   ⚠️ 这一条守的是**物化器与清单的稳定性**,不是「仓内 i18n 内容正确」——
   `buildSeed()` 反过来从 `src/i18n/*.json` 读 copy,所以手改那些文件时
   物化的输入也跟着变,这三条不会响(2026-09-01 第十轮独立验收 P2-3)。
   手改由判据①(unknown-key)与判据④(落盘种子漂移)兜住,整套仍然有效;
   但别把这三条当成「仓内 i18n == 线上配置」的证据。 */
// ② i18n 三语逐字节
for (const loc of LOCALES) {
  const out = materializeI18n(config, manifest, loc);
  const orig = readFileSync(path.join(SITE, `src/i18n/${loc}.json`), 'utf8').replaceAll('\r\n', '\n');
  if (out === orig) say(true, `i18n ${loc}.json 逐字节一致(${out.length}B)`);
  else {
    const idx = [...out].findIndex((ch, i) => ch !== orig[i]);
    say(false, `i18n ${loc}.json 首差异于偏移 ${idx}:物化「${out.slice(Math.max(0, idx - 30), idx + 30).replaceAll('\n', '⏎')}」 vs 原文「${(orig.slice(Math.max(0, idx - 30), idx + 30) || '(EOF)').replaceAll('\n', '⏎')}」`);
  }
}

// ③ 已提交 src/config/site.json ≡ 物化(种子)——站消费物与配置的同步哨兵
//   (2026-08-31 CON16 接管后站 lib 只是 site.json 的读者,不再单独对账)
const sitePath = path.join(SITE, 'src/config/site.json');
if (existsSync(sitePath)) {
  const disk = readFileSync(sitePath, 'utf8').replaceAll('\r\n', '\n');
  say(disk === materializeSiteJson(config), 'src/config/site.json ≡ 物化(种子)(不等=改了配置没重跑 npm run seed)');
} else {
  say(false, '缺 src/config/site.json(站消费物;npm run seed 生成)');
}

// ④ 落盘种子漂移哨兵
const seedPath = path.join(here, 'seed/site-config.seed.json');
if (existsSync(seedPath)) {
  const disk = readFileSync(seedPath, 'utf8').replaceAll('\r\n', '\n');
  say(disk === JSON.stringify(config, null, 2) + '\n', '落盘种子与现仓重算深等(站内容改动后须重跑 npm run seed)');
} else {
  console.log('  (seed/ 未落盘——首跑 npm run seed -- --write)');
}

console.log(fails === 0 ? 'PASS gate-equivalence' : `FAIL gate-equivalence(${fails})`);
process.exit(fails ? 1 : 0);
