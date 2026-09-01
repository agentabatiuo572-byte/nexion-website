#!/usr/bin/env node
/* 控制台文案门(2026-09-01 第六轮实景走查抓到后焊入)。

   🔴 事故形态:我在界面提示文案里写了 markdown 的 `**加重**`,而 JSX 里那就是**两个星号**,
   会原样印在页面上。写的时候完全看不出来——源码里它读起来像强调,只有真渲染出来才露馅。
   而前六轮验收全在接口与数据层,没人看界面,于是它一路活到第六轮。

   两条判据:
   ① JSX 文本里不许出现 markdown 强调标记(`**…**`、行首 `- ` 列表、`##` 标题);要加重用 <b>。
   ② 机器枚举值不许直出到界面:形如 `{x.status}` 这样把状态词直接渲染的写法必须先过映射表。
      (实测印过「最近发布 v8:cancelled」。)

   用法:node gate-console-copy.mjs   自检:--self-test */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..', 'admin', 'src');

/** 逐行扫 .tsx;注释行不算(那是写给读代码的人看的) */
function scan(files) {
  const out = [];
  for (const { file, text } of files) {
    let inBlockComment = false;
    text.split('\n').forEach((line, i) => {
      const t = line.trim();
      // 粗粒度地跳过注释:够用,且宁可漏报也不误报到注释上
      /* JSX 注释是 `{/* … *\/}`,起手多一个花括号——第一版只认 `/*`,于是把 JSX 注释里的
         强调也算成缺陷(9 处里有 4 处是这么来的)。判据要能分清「印给用户看的」和「写给读代码的人看的」。 */
      if (inBlockComment) {
        if (t.includes('*/')) inBlockComment = false;
        return;
      }
      if (t.startsWith('/*') || t.startsWith('{/*')) {
        if (!t.includes('*/')) inBlockComment = true;
        return;
      }
      if (t.startsWith('//') || t.startsWith('*')) return;

      if (/\*\*[^*]+\*\*/.test(line)) out.push({ file, line: i + 1, why: 'JSX 文本里的 **加重** 会原样印出来,用 <b> 代替', code: t.slice(0, 110) });

      /* 判据②:机器枚举值直出到界面。
         判据构造性:凡把 `.status` / `.action` / `.state` 这类字段**直接渲染**的地方,
         都得先过一张映射表。项目里已有正确写法(`STATUS_LABEL[v.status] ?? v.status`),
         所以判据只抓「渲染点上没有映射」的形态:`{x.status}` 而不是 `{TABLE[x.status]}`。
         逃生阀 `enum-ok`(写在同一行的注释里),给「这一列就是要显示原始值」的场合。 */
      /* 判据要认得出「这一行有没有过映射表」:
         `{LABEL[x.status] ?? …}` 是正确写法,`{x.status}` 才是缺陷。
         第一版只看有没有出现 `{x.status}` 这个形状,于是把**已经修好的**三处也算成命中——
         一道会对正确写法报红的门,用不了两天就会被人加豁免绕过去,那时它就死了。
         同理 `<select value={x.status}>` 是表单值不是展示文本,天然合法。 */
      if (!/enum-ok/.test(line)) {
        const mapped = /\[\s*[A-Za-z_$][\w.$]*\.(status|action|state|kind|type)\s*\]/.test(line); // 过了映射表
        const asFormValue = /value=\{\s*[A-Za-z_$][\w.$]*\.(status|action|state|kind|type)\s*\}/.test(line);
        if (!mapped && !asFormValue) {
          for (const m of line.matchAll(/\{\s*([A-Za-z_$][\w.$]*)\.(status|action|state|kind|type)\s*\}/g)) {
            out.push({ file, line: i + 1, why: `机器枚举值 {${m[1]}.${m[2]}} 直接渲染给人看;先过映射表(缺映射时也要说「状态未知」而不是吐原词)`, code: t.slice(0, 110) });
          }
        }
      }
    });
  }
  return out;
}

function collect(dir) {
  const files = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith('.tsx')) files.push({ file: path.relative(path.join(here, '..'), p).split(path.sep).join('/'), text: readFileSync(p, 'utf8') });
    }
  };
  walk(dir);
  return files;
}

const files = collect(ROOT);

if (process.argv.includes('--self-test')) {
  let fails = 0;
  const say = (ok, msg) => { console.log(`${ok ? '✓' : '✗'} ${msg}`); if (!ok) fails++; };
  // 注入:一行 JSX 文案带 markdown 强调 → 必须被抓
  const injected = [{ file: 'fake.tsx', text: '<div className="kv">这里是**加重**文字</div>' }];
  say(scan(injected).length === 1, 'self-test:JSX 文案里的 **加重** → 被抓');
  // 注释里的强调 → 不该误报
  const inComment = [{ file: 'fake.tsx', text: '  // 这条说明里的**强调**是给读代码的人看的\n  /* 多行\n     里面的**强调**也不算 */' }];
  say(scan(inComment).length === 0, 'self-test:注释里的 **强调** → 不误报');
  // JSX 注释 `{/* … */}` 也是写给读代码的人看的,同样不该误报(第一版判据把它算成了缺陷)
  const jsxComment = [{ file: 'fake.tsx', text: '      {/* 这里解释为什么**必须**这么写\n           续行里的**强调**也不算 */}' }];
  say(scan(jsxComment).length === 0, 'self-test:JSX 注释里的 **强调** → 不误报');
  // 判据②:裸枚举被抓、过了映射表的不误报、表单 value 不误报
  say(scan([{ file: 'f.tsx', text: '<td>{r.status}</td>' }]).length === 1, 'self-test:裸枚举 {r.status} → 被抓');
  say(scan([{ file: 'f.tsx', text: '<td>{LABEL[r.status] ?? r.status}</td>' }]).length === 0, 'self-test:过了映射表的写法 → 不误报');
  say(scan([{ file: 'f.tsx', text: '<select value={s.status}>' }]).length === 0, 'self-test:表单 value → 不误报');
  say(scan([{ file: 'f.tsx', text: '<td>{r.status}</td> {/* enum-ok:这列就要看原值 */}' }]).length === 0, 'self-test:逃生阀 enum-ok → 放行');
  say(scan(files).length === 0, `self-test:真实代码零命中(实际 ${scan(files).length} 处)`);
  process.exit(fails ? 1 : 0);
}

const hits = scan(files);
if (hits.length) {
  console.error(`✗ 控制台文案门:${hits.length} 处会把 markdown 记号原样印到界面上`);
  for (const h of hits) console.error(`  ${h.file}:${h.line}  ${h.why}\n     ${h.code}`);
  process.exit(1);
}
console.log(`PASS gate-console-copy(扫了 ${files.length} 个页面文件,零命中)`);
process.exit(0);
