#!/usr/bin/env node
/* 红测:`process.exit()` 会跳过 finally —— 凡「跑完要还原环境」的脚本都栽在这一条上。

   事故原文(2026-09-01 第十轮独立验收 P0-2):`gate-artifact-independence.mjs` 把
   `process.exit(0)` 写在 try 块里、还原写在 finally 里,于是**还原一次都没执行过**,
   每跑一次门就把线上快照的上线凭证永久替换成伪造值。而那枚凭证正是另一道 P0 控制的依据。

   这条红测钉两件事:
   ① 语言行为本身(exit 确实跳过 finally)—— 让后来人一眼看懂为什么不能那么写;
   ② 仓里**所有**「try/finally 还原」型脚本,都不在 try 里 exit。
      ②是构造性的:扫的是文件,不是一张手写清单;新加的脚本自动被覆盖。 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(here, '..');
let fails = 0;
const say = (ok, msg) => { console.log(`${ok ? '✓' : '✗'} ${msg}`); if (!ok) fails++; };

// ── ① 证明语言行为:先证起点,否则下面的判据是在防一个不存在的问题
{
  const dir = mkdtempSync(path.join(tmpdir(), 'exitfin-'));
  const f = path.join(dir, 'probe.mjs');
  writeFileSync(f, 'try { process.exit(0); } finally { console.log("FINALLY-RAN"); }\n');
  const bad = spawnSync(process.execPath, [f], { encoding: 'utf8' });
  writeFileSync(f, 'let c = 0;\ntry { c = 0; } finally { console.log("FINALLY-RAN"); }\nprocess.exit(c);\n');
  const good = spawnSync(process.execPath, [f], { encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  say(!/FINALLY-RAN/.test(bad.stdout ?? ''), 'try 里 process.exit → finally **不执行**(事故的语言成因)');
  say(/FINALLY-RAN/.test(good.stdout ?? ''), '退出码外置后 → finally 正常执行(修法有效)');
}

// ── ② 扫全仓:有 try/finally 的脚本,不许在 try 块内 exit
{
  const files = readdirSync(WORKER)
    .filter((n) => n.endsWith('.mjs'))
    .concat(readdirSync(here).filter((n) => n.endsWith('.mjs')).map((n) => path.join('lib', n)))
    .map((n) => ({ rel: `worker/${n.split(path.sep).join('/')}`, text: readFileSync(path.join(WORKER, n), 'utf8') }));
  say(files.length >= 5, `扫描面:${files.length} 个脚本(少于 5 个说明扫描面塌了)`);

  const offenders = [];
  for (const { rel, text } of files) {
    const fin = text.indexOf('\n} finally {');
    if (fin < 0) continue; // 没有 finally 就没有这个问题
    const tryAt = text.lastIndexOf('\ntry {', fin);
    if (tryAt < 0) continue;
    const body = text.slice(tryAt, fin);
    // 注释掉的不算;逐行看
    for (const [i, line] of body.split('\n').entries()) {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
      if (/process\.exit\s*\(/.test(line)) offenders.push(`${rel}(try 块内第 ${i} 行):${t.slice(0, 70)}`);
    }
  }
  say(offenders.length === 0, `没有脚本在 try 块里 exit(违规:${JSON.stringify(offenders)})`);
}

process.exit(fails ? 1 : 0);
