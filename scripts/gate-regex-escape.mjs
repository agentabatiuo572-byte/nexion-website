/* 门:正则里的反斜杠不能在「写文件」的路上被吞掉(静态)
 * ────────────────────────────────────────────────────────────
 * 出处:2026-09-01,**同一天两个互不相干的会话独立中招**,所以这是工具面的环境危害,不是手误。
 * 用 shell heredoc 往文件里写 JS 时,模板串里的 \s 落盘会变成 s ——
 * `split(/\s+/)` 悄悄变成 `split(/s+/)`,按字母 s 切,而不是按空白切。
 *
 * 🔴 为什么值得单独焊一道门:**它不报错,而且经常不改变可观测行为**。
 *   · 本仓这次:class 签名不再按空格切,但同类元素仍得到相同签名,分组照常工作、
 *     门自检 22 条全过 —— 是回源读代码时肉眼看出来的(输出里 class 名带空格而不是点)。
 *   · 另一会话那次:同型问题落在它新焊的门的正则里,**8 个阳性用例全部静默放行,门照旧报绿**。
 *     那才是这个坑的典型形态 —— 尺子被写坏了,而被测对象看起来很健康。
 *
 * 判据:方法调用的正则字面量,紧跟 `/`(可带 `^` / `[`)的第一个字符是裸的类字母
 * (s d w S D W b n)且后面跟着量词或收尾符 —— 正确写法 `\s` 在 `/` 后面是反斜杠,天然不命中,
 * 所以判据是自排除的,不需要额外的白名单。
 *
 * 🔴 自带阳性对照:门每次跑都先拿已知坏样本喂自己的判据,报不出来就判自己坏(NOT-RUN)。
 *    理由写在 memory 里:「0 命中」可能只是尺子没在工作 —— 这道门要防的恰恰就是「尺子被写坏」,
 *    它自己更没有资格豁免这一条。
 *
 * 豁免:同行写 regex-literal-ok(确实要匹配那个字母本身时才加)。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const METHODS = 'split|replace|replaceAll|match|matchAll|search|test|exec';
/* 裸类字母紧跟在 / 或 /^ 或 /[ 之后,且后面是量词/收尾符。
   `\s` 那种正确写法在 / 后面是反斜杠,不会命中 —— 判据自排除。 */
const SUSPECT = new RegExp(
  '\\.(?:' + METHODS + ')\\(\\s*/\\^?\\[?([sdwSDWbn])(?=[+*?{|)\\]/])',
);
const SUSPECT_G = new RegExp(SUSPECT.source, 'g');
const EXEMPT = /regex-literal-ok/;

const walk = (d, out = []) => {
  if (!existsSync(d)) return out;
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) {
      if (n === 'node_modules' || n === 'dist' || n === '.trash') continue;
      walk(p, out);
    } else if (/\.(mjs|js|cjs|ts|tsx|astro)$/.test(n)) out.push(p);
  }
  return out;
};

/* 阳性/阴性对照样本 —— 判据必须对前者全报、对后者全不报。
   这四行本身就是"坏写法"的原文,所以会被自己的判据命中 —— 逐行挂逃生阀。
   (同型:另一会话的门也命中了它注释里引用的坏正则原文。写这种门,第一个假阳性一定是自己。) */
const BAIT_BAD = [
  "a.split(/s+/)", // regex-literal-ok
  "b.replace(/d+/g, '')", // regex-literal-ok
  "c.match(/w+/)", // regex-literal-ok
  "d.test(/^s*/)", // regex-literal-ok
];
const BAIT_GOOD = [
  "a.split(/\\s+/)",
  "b.replace(/\\d+/g, '')",
  "c.test(/some/)",
  "d.split(/,/)",
  "e.replace(/[a-z]+/, '')",
];

export function regexEscapeGate(ROOT, rel) {
  // ① 先验尺子:报不出已知坏样本(或误报好样本)→ 判自己坏,不许拿「0 命中」冒充干净
  const missed = BAIT_BAD.filter((s) => !SUSPECT.test(s));
  const falsePos = BAIT_GOOD.filter((s) => SUSPECT.test(s));
  if (missed.length || falsePos.length) {
    return {
      gate: 'regex-escape(静态·反斜杠被吞)',
      pass: false,
      detail: [
        'NOT-RUN:判据自检未过,本门没有真正检查任何文件(这正是它要防的那种假绿)',
        ...missed.map((s) => `  漏报已知坏样本:${s}`),
        ...falsePos.map((s) => `  误报正确写法:${s}`),
      ],
    };
  }

  // ② 扫源码(dist 是压缩产物,里面的 base64 长串会制造大批假阳性 —— 实测扫出 83KB 噪声)
  const detail = [];
  for (const d of ['scripts', 'src']) {
    for (const f of walk(join(ROOT, d))) {
      const lines = readFileSync(f, 'utf8').split(String.fromCharCode(10));
      lines.forEach((line, i) => {
        if (EXEMPT.test(line)) return;
        const m = line.match(SUSPECT_G);
        if (m) {
          detail.push(
            `${rel(f)}:${i + 1} 正则里的反斜杠疑似被吞:${m.join(' , ')}` +
              `${String.fromCharCode(10)}         ${line.trim().slice(0, 78)}`,
          );
        }
      });
    }
  }
  return { gate: 'regex-escape(静态·反斜杠被吞)', pass: detail.length === 0, detail };
}
