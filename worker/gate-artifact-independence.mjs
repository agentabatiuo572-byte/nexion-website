#!/usr/bin/env node
/* 产物无关性门(2026-09-01 第六轮 P1-2 焊入)。

   🔴 事故形态:单测里有一条断言直接用了真实资产层,于是它的成败取决于**仓外的构建产物
   `dist-live` 里有没有 `.publish-stamp.json`**——没有印记时 105/105 绿,有印记(任何一次
   成功发布之后的常态)时 104/105 红。历次汇报的「机器门全绿」因此在真实状态下从没成立过,
   而绿的那几次只是因为上一位验收方收尾时恰好把印记清掉了。
   **一个依赖仓外产物的测试,它的绿不是关于代码的结论。**

   判据:同一份代码,在「有印记」与「无印记」两种产物状态下跑同一套单测,结果必须一致。
   不一致 = 有测试在读仓外的东西,点名两次结果的差异。

   ⚠️ 本门要跑两遍完整单测,比较慢;它属于收包/发布前的门,不进每次编辑的快循环。
   用法:node gate-artifact-independence.mjs */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const LIVE = path.join(here, '..', 'dist-live');
const STAMP = path.join(LIVE, '.publish-stamp.json');

if (!existsSync(LIVE)) {
  console.error('✗ 缺 dist-live —— 先 npm run build && npm run build:console && node promote.mjs');
  process.exit(3);
}

const had = existsSync(STAMP);
const saved = had ? readFileSync(STAMP) : null;

/* 跑一遍单测,回 {code, summary, failed}。
   🔴 取不到计数一律当**门自己坏了**处理,直接退出(2026-09-01 焊本门时当场踩到):
   第一版给 vitest 传了 `--reporter=basic`,而 vitest 4 已经移除该选项 → 两次运行都因为
   同一个参数错误而崩,门于是欢快地宣布「两种状态下结论一致」并打印 PASS。
   **「两边一样」在两边都没真正跑起来时毫无意义**——所以先证起点:计数必须抓得到。 */
/** 门自己坏了 —— 与「门判被守物有问题」区分开,前者必须让人先去修门 */
class GateBroken extends Error {}

function runTests(label) {
  const r = spawnSync('npx', ['vitest', 'run'], { cwd: here, shell: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const m = /Tests\s{2,}(.+)/.exec(out);
  if (!m) {
    console.error(`✗ ${label}:抓不到测试计数 —— 单测根本没跑起来,本门无法给出结论`);
    console.error(out.split('\n').slice(-15).join('\n'));
    throw new GateBroken('抓不到测试计数');
  }
  const failed = [...out.matchAll(/[×✗]\s+(.+?)\s+\d+ms/g)].map((x) => x[1].trim());
  console.log(`· ${label}:退出码 ${r.status} · ${m[1].trim()}`);
  return { code: r.status ?? 1, summary: m[1].trim(), failed };
}

/* 🔴 退出码**必须外置**(2026-09-01 第十轮独立验收 P0-2)。
   上一版每条出口都是 `try` 块里的 `process.exit(n)` —— 而 `process.exit()` 立即终止进程、
   **不执行 finally**。于是下面那段「还原磁盘原状」从来没有跑过哪怕一次:
   每跑一次本门,线上快照的上线印记就被永久替换成 `{versionId: 999999, stamp: 'gate-probe'}`。
   被覆盖的正是 `publish.ts` STAMP_WHY 那道「标 live 前回读实物」的控制凭证 ——
   **一道用来保证「门不骗人」的门,自己把另一道门的凭证毁了。**
   (我自己也被它骗过:走查时看到那个 999999,判断成「早前测试的残留值,不是代码问题」。)
   现在:算出退出码 → finally 还原 → 在 try/finally **之外**退出。 */
let exitCode = 0;
try {
  // ① 无印记
  if (existsSync(STAMP)) rmSync(STAMP, { force: true });
  const a = runTests('无印记');

  // ② 有印记(内容取真实形态;版本号故意与库里对不上,这正是发布后的常态之一)
  writeFileSync(STAMP, `${JSON.stringify({ versionId: 999999, stamp: 'gate-probe', configSha: 'probe', anchors: {} })}\n`);
  const b = runTests('有印记');

  /* 🔴 汇总行相同 ≠ 结论相同(2026-09-01 第十轮独立验收 P2-9):
     两种状态下各红**一条不同的**用例时,汇总行同为「111 passed | 1 failed」,
     上一版据此判「一致」,再走到下面因为「都红」而报「先修单测」——
     方向没错但诊断指错了地方:真因恰恰是产物依赖。
     `diff` 早就算好了,只是没参与判断。现在把它算进去。 */
  const failedDiff = [...new Set([...a.failed, ...b.failed])].filter((t) => a.failed.includes(t) !== b.failed.includes(t));
  const same = a.code === b.code && a.summary === b.summary && failedDiff.length === 0;
  if (!same) {
    console.error('✗ 单测结果依赖仓外构建产物 —— 有/无印记两种状态下结论不同');
    console.error(`  无印记:退出码 ${a.code} · ${a.summary}`);
    console.error(`  有印记:退出码 ${b.code} · ${b.summary}`);
    if (failedDiff.length) console.error(`  只在其中一种状态下红的用例:\n    ${failedDiff.join('\n    ')}`);
    console.error('  修法:那些用例要用资产层替身,把「有没有印记」这个前提显式写进测试,而不是继承磁盘现状。');
    exitCode = 1;
  } else if (a.code !== 0) {
    // 两边一致但都红:产物无关性成立,但单测本身是红的——别用「一致」把红盖过去
    console.error(`✗ 两种产物状态下结论一致,但单测本身是红的(${a.summary});先修单测`);
    exitCode = 1;
  } else {
    console.log(`PASS gate-artifact-independence(两种产物状态下同为:${a.summary})`);
  }
} catch (e) {
  exitCode = e instanceof GateBroken ? 3 : 1;
  if (!(e instanceof GateBroken)) console.error(`✗ 本门自身出错:${String(e).slice(0, 200)}`);
} finally {
  // 还原磁盘原状:门不该改变它检查的环境
  rmSync(STAMP, { force: true });
  if (had && saved) writeFileSync(STAMP, saved);
  /* 还原完当场**回读核实**,不只是「执行了还原语句」。
     写不回去(权限/占用)时必须喊出来 —— 悄悄留下伪造凭证正是上一版的事故形态。 */
  const nowHas = existsSync(STAMP);
  const ok = had ? nowHas && readFileSync(STAMP).equals(saved) : !nowHas;
  console.log(ok ? `· 印记已还原(${had ? '与跑前逐字节一致' : '跑前本就没有,已确认未留下'})` : '');
  if (!ok) {
    console.error('✗ 印记还原失败 —— 本门刚刚破坏了线上快照的上线凭证,请手工核对 dist-live/.publish-stamp.json');
    exitCode = 3;
  }
}
process.exit(exitCode);
