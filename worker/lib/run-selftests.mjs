#!/usr/bin/env node
/* 门自检汇总器 —— `npm run test:gates` 的实现。

   🔴 为什么不是在 package.json 里串一串 `&&`(2026-09-01 第十轮,同一个坑踩了两次):
   ① 上一版对 `gate-beacon-size` / `test-static` 传了 `--self-test`,而它们**根本没实现该参数**,
      未知参数被忽略、跑的是主门,我却把输出条数当成了自检条数 —— 报出去的「55 条自检全绿」有 5 条是假的;
   ② 改好之后我数条数用的是 `grep '^✓'`,而 `test-css-shadowed` / `gate-render-fit` 输出的是
      `PASS`,于是它们显示 **0 条**,看起来像空跑 —— **判据形状又一次与产出方不匹配**。

   所以汇总器必须自己保证三件事:
   - **每段的入口真实存在**(带参数的,要能从脚本源码里看到它认这个参数);
   - **每段至少产出 1 条断言**(跑起来了但一条没测 = 空跑,判红。这是「先证起点」);
   - 条数统计**认两种输出格式**(`✓/✗` 与 `PASS/FAIL`),不逼各套件统一措辞。 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(here, '..');
const SITE = path.join(WORKER, '..');

/** [显示名, 工作目录, 脚本相对路径, 额外参数] */
const SUITES = [
  ['JSONC 读取器', WORKER, 'lib/test-read-jsonc.mjs', []],
  ['exit 跳过 finally', WORKER, 'lib/test-exit-skips-finally.mjs', []],
  ['配置一致性门', WORKER, 'gate-config-consistency.mjs', ['--self-test']],
  ['控制台文案门', WORKER, 'gate-console-copy.mjs', ['--self-test']],
  ['种子等价门', WORKER, 'gate-equivalence.mjs', ['--self-test']],
  ['死声明门', SITE, 'scripts/test-css-shadowed.mjs', []],
  ['版面自洽门', SITE, 'scripts/gate-render-fit.mjs', ['--self-test']],
];

let bad = 0;
let total = 0;
const rows = [];

for (const [name, cwd, rel, args] of SUITES) {
  const file = path.join(cwd, rel);
  if (!existsSync(file)) {
    rows.push([name, '—', '✗ 脚本不存在:' + rel]);
    bad++;
    continue;
  }
  /* 带参数的入口:确认脚本真的认这个参数。防的正是①那种「参数被忽略、跑的是主门」——
     那时退出码是 0、输出也有内容,肉眼完全看不出跑错了东西。 */
  const src = readFileSync(file, 'utf8');
  const unknown = args.filter((a) => !src.includes(a));
  if (unknown.length) {
    rows.push([name, '—', `✗ 脚本里找不到参数 ${unknown.join(' ')} —— 传了也是被忽略,跑的其实是主门`]);
    bad++;
    continue;
  }

  const needsTsLoader = rel.includes('equivalence'); // 它要读 .ts 源
  const argv = needsTsLoader ? ['--import', './register-ts-ext.mjs', rel, ...args] : [rel, ...args];
  const r = spawnSync('node', argv, { cwd, shell: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  // 两种输出格式都认:✓/✗ 与 PASS/FAIL
  const pass = (out.match(/^\s*(?:✓|PASS\b)/gm) ?? []).length;
  const fail = (out.match(/^\s*(?:✗|FAIL\b)/gm) ?? []).length;
  total += pass;

  if (r.status !== 0) {
    rows.push([name, `${pass}✓ ${fail}✗`, `✗ 退出码 ${r.status}`]);
    console.error(`\n---- ${name} 失败输出 ----\n${out.split('\n').slice(-20).join('\n')}`);
    bad++;
  } else if (pass === 0) {
    // 跑起来了、退出码 0、但一条断言都没产出 —— 空跑比红更危险,它看起来像通过
    rows.push([name, '0', '✗ 退出码 0 但零条断言 —— 空跑(先证起点:它到底测了什么?)']);
    bad++;
  } else {
    rows.push([name, `${pass} 条`, '✓']);
  }
}

const w = Math.max(...rows.map((r) => r[0].length));
for (const [n, c, s] of rows) console.log(`${s.startsWith('✓') ? '✓' : '✗'} ${n.padEnd(w)}  ${String(c).padStart(7)}  ${s.startsWith('✓') ? '' : s}`);
console.log(bad ? `\n✗ ${bad}/${SUITES.length} 套自检不合格` : `\n✓ ${SUITES.length} 套自检全绿,共 ${total} 条断言`);
process.exit(bad ? 1 : 0);
