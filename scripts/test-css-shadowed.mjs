/* gate-css-shadowed 红测:证明它对两种真实形态会红、对正常写法不红。
 * 反用:HOOK=<旧实现> node 本文件 —— 旧实现(只查「完全相同的 media 上下文」)应当在 ② 上变绿(空过)。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const GATE = new URL('./gate-css-shadowed.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
let pass = 0, fail = 0;

/** 在一个临时工程里放 src/,跑门,返回退出码与输出 */
const run = (name, files, expectExit) => {
  const root = mkdtempSync(`${tmpdir()}/cssshadow-`);
  mkdirSync(`${root}/src/components`, { recursive: true });
  mkdirSync(`${root}/scripts`, { recursive: true });
  for (const [rel, body] of Object.entries(files)) writeFileSync(`${root}/${rel}`, body);
  // 门按 import.meta.url 上溯找 ../src/,所以把门复制进去跑
  writeFileSync(`${root}/scripts/gate.mjs`, execFileSync('node', ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(GATE)},'utf8'))`]));
  let code = 0, out = '';
  try {
    out = execFileSync('node', [`${root}/scripts/gate.mjs`], { encoding: 'utf8' });
  } catch (e) { code = e.status ?? 1; out = `${e.stdout ?? ''}${e.stderr ?? ''}`; }
  const ok = code === expectExit;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}(exit=${code} 期望=${expectExit})`);
  if (!ok) console.log(out.split('\n').slice(0, 6).map((l) => `        ${l}`).join('\n'));
  ok ? pass++ : fail++;
  rmSync(root, { recursive: true, force: true });
  return out;
};

const wrap = (css) => `---\n---\n<div />\n<style>\n${css}\n</style>\n`;

// ① 同一规则块内同属性重复(值不同)—— 实录:.faq > p 的两个 max-width,新值在前旧值在后
run('① 同规则内同属性重复 → 红', {
  'src/components/A.astro': wrap(`.faq > p {\n  max-width: 760px;\n  color: red;\n  max-width: 680px;\n}`),
}, 1);

// ② 嵌套 media(更窄条件)写在基础规则之前 —— 实录:手机菜单矮屏压缩块六条只落地三条
run('② 更窄 media 写在基础规则前 → 红', {
  'src/components/A.astro': wrap(
    `@media (max-width: 860px) {\n` +
      `  @media (max-height: 520px) {\n    .links a { font-size: 28px; }\n  }\n` +
      `  .links a { font-size: 44px; }\n}`,
  ),
}, 1);

// ③ 正常覆盖:更窄 media 写在基础规则**之后** → 绿
run('③ 更窄 media 写在基础规则后 → 绿', {
  'src/components/A.astro': wrap(
    `@media (max-width: 860px) {\n` +
      `  .links a { font-size: 44px; }\n` +
      `  @media (max-height: 520px) {\n    .links a { font-size: 28px; }\n  }\n}`,
  ),
}, 0);

// ④ 正常覆盖:不同选择器 / 不同 media 分支 → 绿(零误报是这道门的设计目标)
run('④ 不同选择器与不同分支 → 绿', {
  'src/components/A.astro': wrap(
    `.a { color: red; }\n.b { color: blue; }\n` +
      `@media (max-width: 860px) { .a { color: green; } }\n` +
      `@media (min-width: 861px) { .a { color: teal; } }`,
  ),
}, 0);

// ⑤ 逃生阀留痕 → 绿
run('⑤ shadow-ok 逃生阀 → 绿', {
  'src/components/A.astro': wrap(`.x {\n  max-width: 760px; /* shadow-ok */\n  max-width: 680px;\n}`),
}, 0);

// ⑥ 注释里的花括号不该骗过扫描(剥注释的正确性)
run('⑥ 注释里的花括号不影响判定 → 红', {
  'src/components/A.astro': wrap(`/* 这里有个假的 { 和 } */\n.y {\n  gap: 4px;\n  gap: 6px;\n}`),
}, 1);

// ⑦ 自定义属性(--x-*)重复不报(变量覆写是常规写法)
run('⑦ 自定义属性重复 → 绿', {
  'src/components/A.astro': wrap(`.z {\n  --x-a: 1;\n  --x-a: 2;\n}`),
}, 0);

// ⑧ 正交条件但交集非空:一条只管宽、一条只管高,互不为超集 —— 旧判据直接跳过(本轮真实漏掉的形态:
//    横屏手机同时满足两者,先写的矮屏分支被后写的基础分支原样压掉,一次都没生效)
run('⑧ 正交 media 相交、先写的必输 → 红', {
  'src/components/A.astro': wrap(
    '@media (max-height: 520px) { .hero { padding-bottom: 120px; } }\n' +
      '@media (max-width: 860px) { .hero { padding-bottom: 39px; } }',
  ),
}, 1);

// ⑨ 正交但**互斥**(宽 ≤860 与 宽 ≥861)→ 各管各的,不报
run('⑨ 互斥分支 → 绿', {
  'src/components/A.astro': wrap(
    '@media (max-width: 860px) { .hero { padding-bottom: 10px; } }\n' +
      '@media (min-width: 861px) { .hero { padding-bottom: 20px; } }',
  ),
}, 0);

// ⑩ 非尺寸条件不同(print vs 屏幕)→ 保守不报
run('⑩ print 与屏幕分支 → 绿', {
  'src/components/A.astro': wrap('@media print { .a { color: red; } }\n.a { color: blue; }'),
}, 0);

// ⑪ 按视口高互斥拆分(R45 采用的写法):竖屏档 min-height:521 与矮视口档 max-height:520 各管一片 → 绿
//    钉住这条是因为「改码让门绿」和「改门让码绿」外观一样,只有把新写法锁成期望绿,
//    以后有人放宽判据时这条不会跟着一起松。
run('⑪ 按高互斥拆分 → 绿', {
  'src/components/A.astro': wrap(
    '@media (max-width: 860px) and (min-height: 521px) { .hero { padding-bottom: 10svh; } }\n' +
      '@media (max-height: 520px) { .hero { padding-bottom: 6svh; } }',
  ),
}, 0);

// ⑫ 判据 C:伪元素挂在替换元素上 —— 实录:页脚记号的护字层写在 <img class="mark"> 的 ::before 上,
//    声明在、计算样式读得到、屏上什么都没有,渲染与修之前逐像素同构
run('⑫ 替换元素上的伪元素 → 红', {
  'src/components/A.astro':
    '---\n---\n<img class="mark" src="/m.png" alt="" />\n<style>\n.mark::before { content: ""; position: absolute; inset: 0; }\n</style>\n',
}, 1);

// ⑬ 同样的样式挂在非替换元素上 → 绿(证明 ⑫ 红的是「替换元素」这一条,不是「有 ::before」)
run('⑬ 非替换元素上的伪元素 → 绿', {
  'src/components/A.astro':
    '---\n---\n<span class="mark"><img src="/m.png" alt="" /></span>\n<style>\n.mark::before { content: ""; position: absolute; inset: 0; }\n</style>\n',
}, 0);

console.log(`test-css-shadowed: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
