/* regex-escape 门的红绿两向自检 —— 由 verify 的 gate-self-tests 套统一跑
 * ────────────────────────────────────────────────────────────
 * 门本体已自带阳性对照(每跑一次先拿坏样本喂自己的判据),那层封的是「判据正则被写坏」。
 * 这份红测封的是另外三样它盖不到的:**走文件树、逃生阀、以及报告本身**。
 * 依据即本轮 main 焊 gate-self-tests 的那条理由:红测不跑 = 那层保护不存在。
 *
 * 🔴 本文件一个反斜杠字面量都不写 —— 全用 String.fromCharCode(92) 现拼。
 *    理由就是这道门要防的东西:反斜杠在「写文件」的路上会被吞掉,
 *    而被吞掉的红测会安静地变成「测了个寂寞」(同日另一会话实证:8 个阳性静默放行)。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { regexEscapeGate } from './gate-regex-escape.mjs';

const BS = String.fromCharCode(92);
const LF = String.fromCharCode(10);

const root = mkdtempSync(join(tmpdir(), 'regex-escape-selftest-'));
mkdirSync(join(root, 'scripts'), { recursive: true });
mkdirSync(join(root, 'src'), { recursive: true });
const rel = (p) => p.split(/[\\/]/).pop();

/* 这三行是"坏写法"的原文,会被门自己命中 —— 逐行挂逃生阀。
   第三次遇到同一件事了(门本体的 BAIT_BAD、另一会话注释里的引用、这里):
   **写这种门,第一个假阳性永远是它自己和它的红测**。 */
const BAD = [
  "a.split(/s+/)", // regex-literal-ok
  "b.replace(/d+/g, '')", // regex-literal-ok
  "c.match(/w+/)", // regex-literal-ok
];
const GOOD = [
  "x.split(/" + BS + "s+/)",             // 正确转义 —— 判据自排除,不该报
  "y.replace(/" + BS + "d+/g, '')",      // 同上
  "z.test(/some/)",                      // 真要匹配 some,首字母后不是量词
  "w.split(/,/)",                        // 普通分隔符
  "v.replace(/[a-z]+/, '')",             // 正常字符类
];
const ESCAPED = ["e.split(/s+/); // regex-literal-ok"]; // 挂了逃生阀,不该报

const write = (lines) => writeFileSync(join(root, 'scripts', 'sample.mjs'), lines.join(LF));
const run = () => regexEscapeGate(root, rel);

const cases = [];
write([...BAD, ...GOOD, ...ESCAPED]);
const mixed = run();
cases.push(['① 三条坏写法全部抓到', mixed.detail.length === 3]);
cases.push(['② 判红(pass=false)', mixed.pass === false]);

write(GOOD);
const good = run();
cases.push(['③ 只有正确写法时零命中', good.detail.length === 0 && good.pass === true]);

write(ESCAPED);
const esc = run();
cases.push(['④ 逃生阀 regex-literal-ok 生效', esc.detail.length === 0]);

write([BAD[0]]);
const one = run();
cases.push(['⑤ 单条坏写法也报(不靠数量阈值)', one.detail.length === 1]);
cases.push(['⑥ 报告带行号与原文', /sample\.mjs:1/.test(one.detail[0] || '')]);

// ⑦ 走文件树:放进 src/ 子目录也要扫到(门声明扫 scripts + src)
mkdirSync(join(root, 'src', 'deep'), { recursive: true });
writeFileSync(join(root, 'src', 'deep', 'nested.ts'), BAD[1]);
write(GOOD);
const deep = run();
cases.push(['⑦ src 深层子目录里的坏写法也抓到', deep.detail.length === 1]);

rmSync(root, { recursive: true, force: true });

let bad = 0;
for (const [name, ok] of cases) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) bad++;
}
console.log(`test-regex-escape 自检: ${cases.length - bad} pass / ${bad} fail`);
process.exit(bad ? 1 : 0);
