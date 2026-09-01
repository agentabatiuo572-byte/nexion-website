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
      /* 🔴 判据②的盲区,以及我补盲区时**第二次**造出的同一种废门(2026-09-01)。
         盲区是真的:第八轮走查抓到的枚举泄漏,`{x.status}` 一个都没覆盖到——
         ① `const winState = !a.enabled ? 'disabled' : 'live'` 然后 `{winState}`;
         ② `{c.enabled ? '已上线' : 'coming-soon'}`。
         但我补的第一版判据是「源码里出现形如 'kebab-word' 的字符串就报」,当场 26 处全是误报:
         `import … from 'react-router-dom'` · `justifyContent: 'flex-end'` ·
         **以及映射表的键 `'forbidden-word': '合规禁用词'`——那正是这道门想要的、修好之后的样子**。

         四问(第二次同型,按铁律落盘):
         ① 最小成因:字符串字面量在 TSX 里的**位置**决定它给谁看(import 说明符 / CSS 值 /
            对象键 / JSX 文本),而我在**词法层**判一个**位置层**的问题——光看字符串本身,
            构造上就分不出「印给人看的」和「给机器的」。
         ② 上次修法为什么没挡住:上次(判据② 第一版对正确写法报红)我加的是 `mapped` 检查,
            **仍然在词法层**。同层再修一次 = 没反思。
         ③ 同族:判据① 靠「注释已排除 + 星号几乎只在文案里」侥幸没事;判据③ 是生产者-消费者
            配对,本就是结构性的,没这毛病。所以同族只有判据②。
         ④ 根治:换层——只认**结构上不可能误报**的形状,即「同一个三元表达式里,
            人话和机器词并列」。中文旁边的 ASCII kebab 词,只可能是漏翻的那一半:
            import 里没有中文、CSS 值旁没有中文、映射表键值是 `:` 不是 `?:`。
         代价说清楚:形态① 只在「两分支都是机器词且变量被直接渲染」时抓得到,更绕的写法
         (机器词来自函数返回、来自数组)这道门看不见——那部分仍归实景走查,不假装覆盖。 */
      if (!/enum-ok/.test(line)) {
        const mapped = /\[\s*[A-Za-z_$][\w.$]*\.(status|action|state|kind|type)\s*\]/.test(line); // 过了映射表
        const asFormValue = /value=\{\s*[A-Za-z_$][\w.$]*\.(status|action|state|kind|type)\s*\}/.test(line);
        if (!mapped && !asFormValue) {
          for (const m of line.matchAll(/\{\s*([A-Za-z_$][\w.$]*)\.(status|action|state|kind|type)\s*\}/g)) {
            out.push({ file, line: i + 1, why: `机器枚举值 {${m[1]}.${m[2]}} 直接渲染给人看;先过映射表(缺映射时也要说「状态未知」而不是吐原词)`, code: t.slice(0, 110) });
          }
        }
        // 形态②:三元的两个分支,一边人话一边机器词 —— 作者在写文案,漏翻了一半
        for (const m of line.matchAll(/\?\s*'([^']+)'\s*:\s*'([^']+)'/g)) {
          const human = (s) => /[一-鿿]/.test(s);
          const machine = (s) => /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+$/.test(s);
          const bad = (human(m[1]) && machine(m[2])) || (human(m[2]) && machine(m[1]));
          if (bad) out.push({ file, line: i + 1, why: `三元里一边是人话一边是机器词('${human(m[1]) ? m[2] : m[1]}');两边都要写人话`, code: t.slice(0, 110) });
        }
      }
      // 形态①:`const x = … ? '机器词' : '机器词'`,而 x 后来被直接渲染成 `{x}`
      const decl = line.match(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=[^;]*\?\s*'([a-z][a-z0-9-]*)'\s*:\s*'([a-z][a-z0-9-]*)'/);
      if (decl && !/enum-ok/.test(line) && new RegExp(`\\{\\s*${decl[1]}\\s*\\}`).test(text)) {
        out.push({ file, line: i + 1, why: `变量 ${decl[1]} 存的是机器词('${decl[2]}'/'${decl[3]}'),却被直接渲染成 {${decl[1]}};存人话或过映射表`, code: t.slice(0, 110) });
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

/** 全部前端源码(判据③ 的「有没有人读」是全局问题,扫描面不能只有页面组件) */
function allSources() {
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p2 = path.join(d, n);
      if (statSync(p2).isDirectory()) walk(p2);
      else if (/.(ts|tsx)$/.test(n)) out.push({ file: path.relative(path.join(here, '..'), p2).split(path.sep).join('/'), text: readFileSync(p2, 'utf8') });
    }
  };
  walk(ROOT);
  return out;
}

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
  /* 判据② 换层后的红绿两向。绿测这三条最要紧——它们是**上一版 26 处误报的原样标本**,
     少一条,同一种废门就能再回来一次。 */
  say(scan([{ file: 'f.tsx', text: "<b>{c.enabled ? '已上线' : 'coming-soon'}</b>" }]).length === 1, 'self-test:三元一边人话一边机器词 → 被抓');
  say(scan([{ file: 'f.tsx', text: "import { Link } from 'react-router-dom';" }]).length === 0, 'self-test:import 说明符 → 不误报');
  say(scan([{ file: 'f.tsx', text: "<div style={{ justifyContent: 'flex-end' }}>" }]).length === 0, 'self-test:CSS 属性值 → 不误报');
  say(scan([{ file: 'f.tsx', text: "const L = { 'forbidden-word': '合规禁用词', 'dup-id': 'FAQ id 重复' };" }]).length === 0, 'self-test:映射表的键(正确写法本身)→ 不误报');
  say(scan([{ file: 'f.tsx', text: "const win = a.enabled ? 'live' : 'disabled';\n<span>{win}</span>" }]).length === 1, 'self-test:变量存机器词又被直接渲染 → 被抓');
  say(scan([{ file: 'f.tsx', text: "const win = a.enabled ? 'live' : 'disabled';\napi(win);" }]).length === 0, 'self-test:同样的变量只传给接口、不渲染 → 不误报');
  // 判据③:带了参数没人读 → 被抓;有人读 → 不误报
  const orphan = [{ file: 'a.tsx', text: 'to={`/x?focus=${p}`}' }];
  say(checkQueryConsumers(orphan).some((h) => h.why.includes('focus')), 'self-test:链接带了参数但没人读 → 被抓');
  say(checkQueryConsumers(files, allSources()).length === 0, 'self-test:真实代码里每个链接参数都有消费者(不误报)');
  // 判据④ 红绿两向 + 「读不到就报错」那一支(门的沉默是最坏的绿)
  const E = (...a) => `export const AUDIT_ACTIONS = [${a.map((x) => `'${x}'`).join(',')}] as const`;
  const L = (...a) => `const ACTION_LABEL: Record<string, string> = {${a.map((x) => `'${x}': '人话'`).join(',')}};`;
  say(checkAuditLabels(E('a.x', 'a.y'), L('a.x', 'a.y')).length === 0, 'self-test:动作码与人话表一一对上 → 不误报');
  say(checkAuditLabels(E('a.x', 'a.y'), L('a.x')).some((h) => h.why.includes("'a.y'")), 'self-test:枚举加了动作码而人话表没跟上 → 被抓');
  say(checkAuditLabels(E('a.x'), L('a.x', 'a.z')).some((h) => h.why.includes('死键')), 'self-test:人话表留着已删的动作码 → 被抓');
  say(checkAuditLabels('（改名了）', L('a.x')).some((h) => h.why.includes('门已失效')), 'self-test:抽不出枚举 → 报门失效,不静默放行');
  say(checkAuditLabels().length === 0, 'self-test:真实的动作码与人话表全对得上');
  for (const [ok, msg] of checkPublishHelpers()) say(ok, msg);
  say(scan(files).length === 0, `self-test:真实代码零命中(实际 ${scan(files).length} 处)`);
  process.exit(fails ? 1 : 0);
}

/* 判据③:界面给出的**跳转参数必须有人消费**(2026-09-01 第八轮 P1)。
   实录:「去修复」链接带了 `?focus=<字段>`,而目标页一个消费者都没有——
   参数带了、没人读,点过去仍停在页顶。**带参数是一句承诺,承诺要有兑现方。**
   判据构造性:从代码里找出「被拼进链接的查询键」,再看全仓有没有地方去读同名键。 */
function checkQueryConsumers(files, sources) {
  /* 🔴 两处都栽过,写在一起记牢:
     ① **扫描面要盖住全部前端源码**,不只是页面组件——第一版只扫 pages/*.tsx,
        于是把住在 lib/ 里的消费者当成「没人读」,当场误报。
        「有没有人读」是个全局问题,扫描面缩小一寸,结论就假一分。
     ② **传进来的 files 必须真被用上**——第二版签名收了 files 却总去读真实源码,
        于是自检的注入用例永远抓不到(注入的假文件根本没参与判断)。
        **这和它要抓的毛病是同一种:参数带了、没人读。** */
  const pool = sources ?? files;
  const all = pool.map((f) => f.text).join('\n');
  /* 只看**路由链接**里的参数(to=/ href=),不看发给接口的查询串——
     `api(\`/api/dash?range=${r}\`)` 里的 range 是给服务端的,前端当然不会去读它。
     第一版没分这两者,把接口参数也报成了摆设。 */
  const produced = [
    ...new Set(
      [...all.matchAll(/(?:to|href)=\{?[`'"][^`'"]*[?&]([a-z][a-zA-Z0-9_]*)=\$\{/g)].map((m) => m[1]),
    ),
  ];
  const out = [];
  for (const key of produced) {
    const reader = new RegExp(`(useSearchParams|URLSearchParams)[\\s\\S]{0,400}?['"\`]${key}['"\`]`);
    if (reader.test(all)) continue;
    const where = files.find((f) => new RegExp(`[?&]${key}=\\$\\{`).test(f.text));
    out.push({
      file: where ? where.file : '(未知)',
      line: 0,
      why: `链接里带了 ?${key}=… 但全仓没有任何地方读它 —— 这个参数是个摆设`,
      code: '',
    });
  }
  return out;
}

/* 发布页那两个把机器串翻成人话的纯函数,检查焊在这里而不是另起一个测试文件——
   admin 没有测试运行器,单独新建的测试**没有任何一条链会跑它**(天然孤儿)。
   这道门已在链里、已在读 publish.tsx 的源码,顺手把函数抽出来跑断言,成本几乎为零。
   抽法:从源码里截出函数体,剥掉 TS 标注后 new Function 求值。源码改名/挪走时抽不出来 → 报门失效。 */
function checkPublishHelpers() {
  const src = readFileSync(path.join(ROOT, 'pages', 'publish.tsx'), 'utf8');
  const grab = (head, end) => {
    const i = src.indexOf(head);
    if (i < 0) return null;
    const j = src.indexOf(end, i);
    return j < 0 ? null : src.slice(i, j + end.length);
  };
  const failSrc = readFileSync(path.join(ROOT, 'lib', 'fail-reason.ts'), 'utf8');
  const grabIn = (text, head, end) => {
    const i = text.indexOf(head);
    if (i < 0) return null;
    const j = text.indexOf(end, i);
    return j < 0 ? null : text.slice(i, j + end.length);
  };
  const pieces = [
    grab('const AREA: Array<[RegExp, string]> = [', '];'),
    grab('const LOCALE_NAME: Record<string, string> = {', '};'),
    grab('const FIELD_NAME: Record<string, string> = {', '};'),
    grab('export function humanPath(path: string): string {', '\n}'),
    grabIn(failSrc, 'export function splitFailReason(raw: string): FailReason {', '\n}'),
  ];
  if (pieces.some((p) => !p)) return [[false, 'self-test:抽不出 humanPath/splitFailReason(改名或挪走了?)——检查已失效,先修门']];
  const js = pieces
    .join('\n')
    .replace(/: Array<\[RegExp, string\]>/g, '')
    .replace(/: Record<string, string>/g, '')
    .replace(/export function humanPath\(path: string\): string/, 'function humanPath(path)')
    .replace(/export function splitFailReason\(raw: string\): FailReason/, 'function splitFailReason(raw)')
    .replace(/ as string\[\]/g, '');
  let humanPath, splitFailReason;
  try {
    ({ humanPath, splitFailReason } = new Function(`${js}; return { humanPath, splitFailReason };`)());
  } catch (e) {
    return [[false, `self-test:抽出的函数跑不起来(${String(e).slice(0, 60)})`]];
  }
  const out = [];
  /* 🔴 humanPath 的判据必须是**构造性**的,路径从真种子枚举,不手写样例。
     第一版我手写了六条样例,而它抓不到 `平台数字 · nodes` 这种**半翻**
     ——恰恰是第八轮走查点名的「不均匀」。手写样例天然照着实现的形状写,
     两边一起漏掉同一个字段(同 [[feedback_predicate_shape_must_match_producer]])。
     判据:除 copy 树(自由文案 key,本就不该强求映射)外,配置的字段集是封闭的,
     种子里出现的每一个字段名都必须在 FIELD_NAME 里有人话。 */
  const seed = JSON.parse(readFileSync(path.join(here, 'seed', 'site-config.seed.json'), 'utf8'));
  /* 判据看的是**映射表有没有盖住封闭字段集**,不是输出字符串长什么样。
     试过后者:`下载入口 · iOS 版` 里的 iOS 是品牌名却被当成机器名报红 ——
     一旦开始为它加排除表,就退回了词法层那条死路(见本文件判据② 的四问)。
     这里与判据④ 同形:一侧是产出方(种子里真实存在的字段),一侧是消费方(人话表)。
     copy 树是自由文案 key,不在封闭集里;域名由 AREA 自己消费,从 AREA 源码里抽,不另写一份。 */
  const areaKeys = new Set([...(grab('const AREA: Array<[RegExp, string]> = [', '];') ?? '').matchAll(/\/\^([a-zA-Z]+)/g)].map((m) => m[1]));
  if (!areaKeys.size) return [[false, 'self-test:从 AREA 抽不出域名 —— 判据失效,先修门']];
  const fieldKeys = new Set(
    [...(grab('const FIELD_NAME: Record<string, string> = {', '};') ?? '').matchAll(/(?:^|[{,\s])'?([a-zA-Z_$][\w$-]*)'?\s*:/gm)].map((m) => m[1]),
  );
  const LOCALES = new Set(['en', 'vi', 'zh']);
  const segs = new Map(); // 字段名 → 它第一次出现的位置(报错时能直接说清是哪儿的字段)
  const walkCfg = (v, prefix) => {
    if (v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach((x) => walkCfg(x, `${prefix}[]`)); return; }
    for (const [k, x] of Object.entries(v)) {
      if (prefix && !prefix.startsWith('copy') && !segs.has(k)) segs.set(k, `${prefix}.${k}`);
      walkCfg(x, prefix ? `${prefix}.${k}` : k);
    }
  };
  walkCfg(seed, '');
  if (segs.size < 20) return [[false, `self-test:从种子只枚举出 ${segs.size} 个字段 —— 判据失效(种子改形状了?)`]];
  const missing = [...segs].filter(([k]) => !fieldKeys.has(k) && !areaKeys.has(k) && !LOCALES.has(k));
  out.push([
    missing.length === 0,
    `self-test:种子里 ${segs.size} 个配置字段在人话表里都有译名(缺:${JSON.stringify(missing.map(([k, p]) => `${k} @ ${p}`).slice(0, 8))})`,
  ]);
  out.push([humanPath('skus[0].priceUSD') === '产品卡 · 第 1 项 · 价格', 'self-test:humanPath 数组路径 → 「产品卡 · 第 1 项 · 价格」']);
  // splitFailReason:门红把门名剥进小字;原始 Node 报错折叠;正常中文人话原样
  const a = splitFailReason('文案里有合规禁用词(门:forbidden-words)');
  out.push([a.human === '文案里有合规禁用词' && a.tech === 'forbidden-words', 'self-test:门红原因 → 人话与门名分开']);
  const b2 = splitFailReason("Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'D:\\WORKS\\x\\y.js'");
  out.push([b2.raw === true && b2.tech !== null && !/[A-Za-z]:\\/.test(b2.human), 'self-test:原始 Node 报错 → 主视线不含本机路径']);
  const c2 = splitFailReason('发布中断(执行器无响应或超时),线上保持旧版');
  out.push([c2.human === '发布中断(执行器无响应或超时),线上保持旧版' && c2.tech === null, 'self-test:本就是人话的原因 → 原样保留']);
  /* 🔴 每个读 fail_reason 的地方都必须过这两个函数之一。
     实录:我先只改了发布页那两处,壳顶红条当场还印着 `(门:forbidden-words)` ——
     修一处不等于修全部,而「还有几处」只有穷举才知道。判据构造性:
     全仓找出 `fail_reason` / `lastPublishFailed.reason` 的**渲染点**,逐个要求同一行(或紧邻)出现译名函数。 */
  const consumers = [];
  for (const { file, text } of allSources()) {
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('{/*')) return;
      if (!/fail_reason|lastPublishFailed\.reason/.test(line)) return;
      if (/interface |: string \| null|type /.test(line)) return; // 类型声明不是渲染点
      /* 窗口 ±3 行:`{v.fail_reason ? (() => {` 这种条件判断会把取值与译名调用分到两行,
         判据卡在同一行就会对**正确写法**报红(本文件判据② 栽过两次的同一个坑)。 */
      const near = lines.slice(Math.max(0, i - 3), i + 4).join('\n');
      if (!/splitFailReason|failReasonLine/.test(near)) consumers.push(`${file}:${i + 1}`);
    });
  }
  out.push([consumers.length === 0, `self-test:每个 fail_reason 渲染点都过了译名函数(直出的:${JSON.stringify(consumers)})`]);
  return out;
}

/* 判据④:审计动作码的**人话表必须盖住封闭枚举**(2026-09-01 第八轮 P2)。
   `worker/src/audit.ts` 的 `AUDIT_ACTIONS` 是单一真理源,TS 的 `AuditAction` 类型已经守住了
   「服务端写的动作码必须在枚举里」——那是**生产面**。消费面没人守:
   加一个动作码而界面标签表没跟上,审计页就当场吐机器码给追责的人看,且不会有任何报错。
   ⚠️ audit.tsx 的注释原本就写着「gate-console-copy 守这张表不许有死键」——
   **而那道门当时并不存在**。这条判据是去把那句注释变成真的,不是新想出来的洁癖。
   双向:枚举有表没有 = 会吐机器码;表有枚举没有 = 死键(动作码删了标签还留着)。 */
function checkAuditLabels(enumOverride, labelOverride) {
  // 注入参数必须真被读(不读 = 自检永远测不到东西,正是判据③ 抓的那种「带了没人读」)
  const enumSrc = enumOverride ?? readFileSync(path.join(here, 'src', 'audit.ts'), 'utf8');
  const labelSrc = labelOverride ?? readFileSync(path.join(ROOT, 'pages', 'audit.tsx'), 'utf8');
  const block = (src, head) => {
    const i = src.indexOf(head);
    if (i < 0) return null;
    const j = src.indexOf(head.includes('[') ? '] as const' : '};', i);
    return j < 0 ? null : src.slice(i, j);
  };
  const eb = block(enumSrc, 'export const AUDIT_ACTIONS = [');
  const lb = block(labelSrc, 'const ACTION_LABEL: Record<string, string> = {');
  /* 抽不出来必须报错,不能当成「零差异」放行——**门读不到东西时的沉默是最坏的绿**。 */
  if (!eb || !lb) return [{ file: 'worker/src/audit.ts', line: 0, why: '判据④ 读不到 AUDIT_ACTIONS 或 ACTION_LABEL(改名/挪走了?)——门已失效,先修门', code: '' }];
  const pick = (s) => new Set([...s.matchAll(/'([a-z][a-z0-9.]*)'/g)].map((m) => m[1]));
  const actions = pick(eb);
  const labels = pick(lb);
  const out = [];
  for (const a of actions) if (!labels.has(a)) out.push({ file: 'admin/src/pages/audit.tsx', line: 0, why: `动作码 '${a}' 在封闭枚举里,但界面没有对应人话 —— 审计页会把机器码原样吐给追责的人`, code: '' });
  for (const l of labels) if (!actions.has(l)) out.push({ file: 'admin/src/pages/audit.tsx', line: 0, why: `标签表里的 '${l}' 已不在 AUDIT_ACTIONS 里 —— 死键,删掉`, code: '' });
  return out;
}

const hits = [...scan(files), ...checkQueryConsumers(files, allSources()), ...checkAuditLabels()];
if (hits.length) {
  console.error(`✗ 控制台文案门:${hits.length} 处会把 markdown 记号原样印到界面上`);
  for (const h of hits) console.error(`  ${h.file}:${h.line}  ${h.why}\n     ${h.code}`);
  process.exit(1);
}
console.log(`PASS gate-console-copy(扫了 ${files.length} 个页面文件,零命中)`);
process.exit(0);
