#!/usr/bin/env node
/* NexGrid website verify 门骨架(T1 先立门后写页)。
   门源:官网 PRD §1.4(合规红线)+ §6(验收标准)。
   用法:node scripts/verify.mjs [--prod]
   --prod = 部署门升为阻断(PENDING 标记/Legal 缺失 exit 2);默认仅告警。
   退出码写 .verify-exit.code(外部判定读文件不读管道——PLAN 全局纪律)。 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { canvasUnitGate } from './gate-canvas-unit.mjs';
import { regexEscapeGate } from './gate-regex-escape.mjs';
import { scanForbidden } from './forbidden-patterns.mjs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SRC = join(ROOT, 'src');
const PROD = process.argv.includes('--prod');
const results = [];
// 置红的正主是 npm script 里先跑的 verify-preamble.mjs(独立进程,门模块语法错也拦得住);
// 这里再写一次,给「直接 node scripts/verify.mjs」的调用方兜底
writeFileSync(join(ROOT, '.verify-exit.code'), '2');

/* 推主线门(2026-09-03 Tier 1-⑧,.githooks/verify-before-push.mjs)读 .verify-cache/last-run.json 判「要推的树有没有 full 绿」:
   本仓 verify 只有一档,全程即 full。开跑时记一次树指纹(HEAD + status + diff --stat),结束再算一次 ——
   跑的过程中树动了(treeMoved)= 结论不锚定任何一棵树,pre-push 会拒;dirty = 跑时有未提交改动,绿的是「HEAD + 私活」不是任何提交。 */
const gitOut = (...a) => { const r = spawnSync('git', ['-C', ROOT, ...a], { encoding: 'utf8' }); return r.status === 0 ? (r.stdout || '').trim() : ''; };
const treeFingerprint = () => createHash('sha1').update([gitOut('rev-parse', 'HEAD'), gitOut('status', '--porcelain'), gitOut('diff', '--stat')].join('\n')).digest('hex');
const startFingerprint = treeFingerprint();

function walk(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}
const rel = (p) => relative(ROOT, p).replaceAll('\\', '/');

/* ── 门 1:禁用词(PRD §1.4-1/3/4)──────────────────────────────
   注意:"not guaranteed" 是免责声明合法用法,模式只抓「保证收益」组合。 */
{
  /* 词表+判定函数 2026-08-31 抽至 scripts/forbidden-patterns.mjs(官网后台校验器同 import 单源;
     T7 验收 P2:判定循环也必须共享——任一面单独加豁免即静默分叉);历史注记随词表迁移 */
  const files = walk(SRC, ['.astro', '.ts', '.tsx', '.jsx', '.json', '.md']);
  const hits = [];
  for (const f of files) {
    for (const h of scanForbidden(readFileSync(f, 'utf8'))) hits.push(`${rel(f)}: [${h.label}] "${h.match}"`);
  }
  results.push({ gate: 'forbidden-words', pass: hits.length === 0, detail: hits });
}

/* ── 门 2:三语 key parity(PRD §6-2)────────────────────────── */
{
  const keysOf = (obj, prefix = '') =>
    Object.entries(obj).flatMap(([k, v]) =>
      typeof v === 'object' && v !== null ? keysOf(v, `${prefix}${k}.`) : [`${prefix}${k}`],
    );
  const dicts = {};
  for (const l of ['en', 'vi', 'zh']) dicts[l] = new Set(keysOf(JSON.parse(readFileSync(join(SRC, 'i18n', `${l}.json`), 'utf8'))));
  const detail = [];
  for (const l of ['vi', 'zh']) {
    for (const k of dicts.en) if (!dicts[l].has(k)) detail.push(`${l} 缺 key: ${k}`);
    for (const k of dicts[l]) if (!dicts.en.has(k)) detail.push(`${l} 多出 key: ${k}(en 无)`);
  }
  results.push({ gate: 'i18n-parity', pass: detail.length === 0, detail });
}

/* ── 门 3:部署门(PRD §6-4:PENDING 标记 / Legal 缺失禁生产)── */
{
  const detail = [];
  const siteConfig = JSON.parse(readFileSync(join(SRC, 'config', 'site.json'), 'utf8'));
  const configuredAppPrivacy = siteConfig.legal?.appPrivacy;
  const configuredAppPrivacyReady = Boolean(configuredAppPrivacy?.md?.en?.trim()) &&
    !Object.values(configuredAppPrivacy.md).some((value) => String(value).includes('PENDING-TRUST-ASSETS'));
  const files = walk(SRC, ['.astro', '.ts', '.tsx', '.json', '.md']);
  for (const f of files) {
    if (!readFileSync(f, 'utf8').includes('PENDING-TRUST-ASSETS')) continue;
    /* App 隐私组件保留空配置时的既有占位正文；后台已提供完整正文后该 fallback 不会进入产物。 */
    if (configuredAppPrivacyReady && rel(f) === 'src/components/legal/LegalAppPrivacy.astro') continue;
    detail.push(`${rel(f)}: 信任资料未填充(PENDING-TRUST-ASSETS)`);
  }
  for (const page of ['legal/privacy', 'legal/terms', 'legal/app-privacy']) {
    const found = ['.astro', '.md'].some((ext) => existsSync(join(SRC, 'pages', `${page}${ext}`)));
    if (!found) detail.push(`缺 Legal 页: src/pages/${page}.(astro|md)`);
  }
  // 非 --prod 只告警不拦(开发期必然半成品);--prod 阻断
  results.push({ gate: 'deploy-gate' + (PROD ? '' : '(warn-only)'), pass: detail.length === 0 || !PROD, warn: !PROD && detail.length > 0, detail });
}

/* ── 门 3b:上线资产门(R49-F1)——把「带哪些降级态上线」变成显式清单而非默认发生。
   五路总审的共同结构:代码侧降级机制都在(未配置不渲染/禁用),欠的是资产;
   资产是否就绪只有产物说了算,故本门读 dist(上次 build 的产物;无 dist 记 NOT-BUILT 警示)。
   判据:① 统计快照仍=App mock 锚值(逐字面比对 Nexion-uniapp/src/lib/platform-stats.ts,
   ≥4/5 命中判镜像;App 仓缺席 warn 放行,与 brand-parity 同体例)——prod 红:公网虚假规模陈述;
   ② 联系 mailto 缺席——prod 红;下载禁用键/白皮书等空值只列清单不拦
   (R49b 主人令:coming-soon 说明行撤除、后台即将接配,原「禁用必配说明」配对红随之撤)。 */
{
  const detail = [];
  const info = [];
  const distHome = join(ROOT, 'dist', 'index.html');
  if (!existsSync(distHome)) {
    detail.push('NOT-BUILT:dist/index.html 缺席,本门未真正检查(先 npm run build)');
  } else {
    const home = readFileSync(distHome, 'utf8');
    const disabledBtns = (home.match(/aria-disabled="true"/g) || []).length;
    const hasMailto = home.includes('mailto:');
    /* R49b 主人令:coming-soon 说明行撤除(后台即将接配),禁用态只列清单不拦 */
    if (disabledBtns > 0) info.push(`空值清单:下载 URL 未配 ×${disabledBtns}(禁用态,后台接配即消)`);
    if (!hasMailto) (PROD ? detail : info).push('空值清单:联系邮箱未配(PUBLIC_CONTACT_EMAIL)→ 页脚无任何联系渠道');
    const nexHome = join(ROOT, 'dist', 'nex', 'index.html');
    if (existsSync(nexHome) && !readFileSync(nexHome, 'utf8').includes('whitepaper')) info.push('空值清单:白皮书未配(PUBLIC_WHITEPAPER_URL)');
  }
  /* 🔴 「统计数字仍是演示值」这条判据**从 CON16 改版起就不可能触发**
     (2026-09-01 第十轮独立验收 P0)。上一版三重不相交,少一重都还能活:
       ① 它在 `src/lib/stats.ts` 里正则找数字字面量,而改版后那里只剩 `site.stats.activeDevices`
          这样的**引用**,一个字面量都没有 → `nums.length >= 5` 恒假;
       ② App 锚路径写死成同级目录的 `../Nexion-uniapp`,worktree 下解析到不存在的路径
          → 每次都打印「App 仓缺席…warn 放行」;
       ③ 就算前两条都修好,`site.json` 存 `28432` 而 App 源码写 `28_432`,
          字符串 `includes` 五个值全不命中。
     而与此同时后台还在对运营说「生产上线门将拦截」—— 一道自称会拦、实际拦不住的门,
     比没有门更糟。

     换判据:**不抠字符串、不跨仓、不猜**。锚值有单一真理源 `MOCK_STAT_ANCHORS`
     (`schema/src/site-config.ts`,校验器 `validators.ts:114` 用的就是它),
     直接按**值**比对物化产物里的 stats。同源同比法,两边不会再各自演化。 */
  /* 🔴 判据换向(主人 2026-09-01 拍板):平台数字**全部后台模拟、不接真实数据**,
     于是「和内置初值相同」不再是缺陷 —— 原判据的前提(最终会有真数据)已经不存在。
     一道永远报、又永远不会被解决的警告,只会让人习惯性忽略,连带削弱旁边真的警告。
     换成守**这份模拟配置自身站得住**:
       ① 开了自动增长却一个字段都没配增量 = 开关是个摆设;
       ② 起算日在未来 → 数字要等到那天才动,而人会以为开关没生效;
       ③ 增长快到离谱(日增 > 基准值 5%,即约 20 天翻倍)→ 多半是多打了一个零。
     这三条都是**配置错误**,不是产品决定,拦下来对得起人。 */
  const siteCfg = JSON.parse(readFileSync(join(SRC, 'config', 'site.json'), 'utf8'));
  const g = siteCfg.stats?.growth;
  if (g?.enabled) {
    const per = g.daily ?? {};
    const keys = Object.keys(per).filter((k) => per[k] > 0);
    if (!keys.length) detail.push('自动增长开着,但四个字段的每日增量都是 0 —— 开关不起任何作用,要么配增量要么关掉');
    if (Date.parse(`${g.since}T00:00:00Z`) > Date.now()) detail.push(`自动增长的起算日 ${g.since} 在未来 —— 数字要等到那天才开始动`);
    for (const k of keys) {
      const base = Number(siteCfg.stats?.[k]);
      if (Number.isFinite(base) && base > 0 && per[k] > base * 0.05) {
        detail.push(`${k} 每天 +${per[k]},相对基准值 ${base} 约 ${Math.round(base / per[k])} 天翻倍 —— 增长过快,是不是多打了一个零?`);
      }
    }
  }
  results.push({
    gate: 'launch-assets(R49-F1)' + (PROD ? '' : '(空值仅列示)'),
    pass: detail.length === 0,
    warn: detail.length === 0 && info.length > 0,
    detail: [...detail, ...info],
  });
}

/* ── 门 3c:状态钩子消费方门(R49-F2)——渲染出的状态钩子必须有消费方。
   案由:data-empty 渲染了 12 个月零消费方,「降级态的用户可见面」静默缺位(五路总审同根发现);
   判据:清单内钩子在 src 有 EMIT(data-x= 模板属性)则必须有 CONSUMER([data-x 选择器 或 dataset.x),
   0 消费即红。新状态钩子加进 HOOKS 清单。 */
{
  /* 🔴 清单改成**构造性枚举**(2026-09-01 第十轮独立验收 P1-8)。
     上一版 `HOOKS = ['empty']` 是手写的,而那个钩子早已退役、全 src 零 EMIT,
     于是这道门每次打印 `✓ clean` 却**一条断言都没执行**,还在「13/13」里占一格。
     一道恒绿且什么都没查的门,比没有门更误导人。
     现在从源码里枚举真实在用的 `data-*` 属性,逐个要求有消费方。
     排除面写清楚**为什么排除**,不是随手加白名单:
     - HTML/框架自带属性(data-src/srcset/theme/…)不是本站的状态钩子;
     - 带后缀的参数属性(data-tw-delay 之类)由其主钩子统一读取。 */
  const detail = [];
  const files = walk(SRC, ['.astro', '.ts', '.css']);
  const all = files.map((f) => readFileSync(f, 'utf8')).join('\n');
  const NATIVE = new Set(['src', 'srcset', 'theme', 'alt', 'target', 'locale', 'mode', 'suffix', 'sse-url']);
  const emitted = [...new Set([...all.matchAll(/data-([a-z][a-z0-9-]*)=/g)].map((m) => m[1]))]
    .filter((h) => !NATIVE.has(h))
    .filter((h) => !/-/.test(h) || !emittedBase(h)); // data-tw-delay 归 data-tw 管
  function emittedBase(h) {
    const base = h.split('-')[0];
    return new RegExp(`data-${base}[=\\s>]`).test(all);
  }
  if (!emitted.length) detail.push('从 src 里一个状态钩子都没枚举到 —— 判据失效(属性写法变了?),先修门');
  for (const h of emitted) {
    const emits = (all.match(new RegExp(`data-${h}=`, 'g')) || []).length;
    const consumers =
      (all.match(new RegExp(`\\[data-${h}[\\]='"]`, 'g')) || []).length +
      (all.match(new RegExp(`dataset\\.${h.replace(/-(.)/g, (_, c) => c.toUpperCase())}\\b`, 'g')) || []).length +
      (all.match(new RegExp(`getAttribute\\(['"\`]data-${h}`, 'g')) || []).length;
    if (emits > 0 && consumers === 0) detail.push(`data-${h}:渲染了 ${emits} 处但没有任何地方读它——状态出现在页面上却没有用户可见面`);
  }
  results.push({ gate: `state-hook-consumer(R49-F2)`, pass: detail.length === 0, detail: detail.length ? detail : [`已核 ${emitted.length} 个状态钩子,均有消费方`] });
}

/* ── 门 4:页内锚点存在性(PRD §6-5 近似;T11 升级为 dist 级死链扫描)── */
{
  const detail = [];
  const pages = walk(join(SRC, 'pages'), ['.astro']);
  const compDirs = [join(SRC, 'components'), join(SRC, 'layouts')].filter(existsSync);
  const compText = compDirs.flatMap((d) => walk(d, ['.astro', '.tsx', '.jsx'])).map((f) => readFileSync(f, 'utf8')).join('\n');
  for (const f of pages) {
    const text = readFileSync(f, 'utf8') + '\n' + compText; // 近似:页 + 全部组件拼接
    const anchors = [...text.matchAll(/href="#([\w-]+)"/g)].map((m) => m[1]);
    const ids = new Set([...text.matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1]));
    for (const a of anchors) if (a && !ids.has(a)) detail.push(`${rel(f)}: href="#${a}" 无对应 id`);
  }
  results.push({ gate: 'anchor-check(src 近似)', pass: detail.length === 0, detail });
}

/* ── 门 5:品牌同值哨兵(R37,R38 收紧)──────────────────────
   官网 --x-accent/--x-on-accent 必须来自 App tokens 的**同一主题块**(官网锚定暗主题柠檬)。
   why:跨仓「单源」此前只活在注释里,App 改品牌值官网会静默漂移;
        R38 再收:只校验「值域命中」时,跨主题错配(电蓝底+黑字 ≈2.4:1)也会绿灯。
   App 仓不存在(独立部署环境)时 warn-only 放行。 */
{
  /* 🔴 跨仓路径按**候选列表**找,不写死一条(2026-09-01 第十轮独立验收 P2-5)。
     此前两条跨仓判据口径不一:这条写死本机绝对路径(恰好命中),另一条写
     `../Nexion-uniapp` 在 worktree 下必然落空、每次都打印「App 仓缺席」——
     而那正是 P0-1 那道死判据的第二重成因。
     找不到时说清**找过哪些位置**,而不是只说一句「不在本机」:
     一句看不出找哪儿的跳过提示,和没有提示一样没法排查。 */
  const APP_CANDIDATES = [
    join(ROOT, '..', 'Nexion-uniapp', 'src', 'styles', 'tokens.css'), // 同级(独立 checkout)
    join(ROOT, '..', '..', 'Nexion-uniapp', 'src', 'styles', 'tokens.css'), // worktree 在 .wt/ 下时
    'D:/WORKS/PLAN/Nexion-uniapp/src/styles/tokens.css', // 本机固定位置(最后兜底)
  ];
  const APP_TOKENS = APP_CANDIDATES.find(existsSync);
  const detail = [];
  let warn = false;
  if (!APP_TOKENS) {
    warn = true;
    detail.push(`App tokens 不在本机(独立环境),跳过比对。找过:${APP_CANDIDATES.map((p) => relative(ROOT, p) || p).join(' · ')}`);
  } else {
    const site = readFileSync(join(SRC, 'styles/tokens.css'), 'utf8');
    const app = readFileSync(APP_TOKENS, 'utf8');
    const hex = (text, name) => {
      const m = text.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})`));
      return m ? m[1].toLowerCase() : null;
    };
    // 取所有最内层 `{...}` 块(选择器写法不限:root/属性选择器/媒体查询内层皆可),
    // 再筛「同块内同时声明 brand 与 on-brand」的配对集
    const blocks = [...app.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]);
    const appPairs = blocks
      .map((b) => ({ brand: hex(b, '--v5-brand'), on: hex(b, '--v5-on-brand') }))
      .filter((p) => p.brand && p.on);
    const sBrand = hex(site, '--x-accent');
    const sOn = hex(site, '--x-on-accent');
    if (!sBrand || !sOn) detail.push('官网缺 --x-accent / --x-on-accent 声明');
    else if (!appPairs.length) detail.push('App 未找到「同块声明 brand+on-brand」的主题块');
    else if (!appPairs.some((p) => p.brand === sBrand && p.on === sOn))
      detail.push(
        `官网 (${sBrand} / ${sOn}) 不是 App 任一主题块的完整配对 [${appPairs.map((p) => `${p.brand}/${p.on}`).join(', ')}] — 品牌漂移或跨主题错配`,
      );
    // 强调文字档必须引用主档,不得另写字面量(封漂移旁路)
    if (!/--x-accent-ink:\s*var\(--x-accent\)/.test(site))
      detail.push('--x-accent-ink 未以 var(--x-accent) 引用主档 — 品牌值第二字面量,门锁不住');
  }
  results.push({ gate: 'brand-parity(App V5)', pass: detail.length === 0 || warn, warn, detail });
}

/* ── 门 6:粒子色相同族哨兵(R38)────────────────────────────
   fx.ts 的粒子三端(暗端/亮端/流光)与品牌主档必须同色相带(±6°)。
   why:三端是 JS 字面量,改一个数就能悄悄漂出柠檬族,评审只能事后靠像素采样发现。 */
{
  const detail = [];
  const fx = readFileSync(join(SRC, 'scripts/fx.ts'), 'utf8');
  const site = readFileSync(join(SRC, 'styles/tokens.css'), 'utf8');
  const bm = site.match(/--x-accent:\s*#([0-9a-fA-F]{6})/);
  const hue = (r, g, b) => {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (!d) return 0;
    let h;
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return ((h * 60) % 360 + 360) % 360;
  };
  if (!bm) detail.push('tokens 缺 --x-accent,无法取品牌色相');
  else {
    const bh = hue(parseInt(bm[1].slice(0, 2), 16), parseInt(bm[1].slice(2, 4), 16), parseInt(bm[1].slice(4, 6), 16));
    // fx 注释里以 `HUE-GUARD:<名> (r, g, b)` 标注三端,门只认标注点(零运行时代码)
    const marks = [...fx.matchAll(/HUE-GUARD:(\w[\w-]*)\s*\((\d+),\s*(\d+),\s*(\d+)\)/g)];
    if (marks.length < 3) detail.push(`fx.ts 粒子色相标注点不足(找到 ${marks.length},应 ≥3:暗端/亮端/流光)`);
    for (const m of marks) {
      const h = hue(+m[2], +m[3], +m[4]);
      const diff = Math.abs(((h - bh + 540) % 360) - 180);
      if (diff > 6) detail.push(`粒子 ${m[1]} 色相 ${h.toFixed(1)}° 偏离品牌 ${bh.toFixed(1)}° 达 ${diff.toFixed(1)}°(>6°)`);
    }
  }
  results.push({ gate: 'particle-hue(同族 ±6°)', pass: detail.length === 0, detail });
}

results.push(canvasUnitGate(SRC, rel));
results.push(regexEscapeGate(ROOT, rel));

/* 后台配置消费与前台边界行为：真实物化变体 → 隔离 Astro 产物 → Chromium。
   这里覆盖静态文本门看不见的公告/SEO/footer/Legal/FAQ 与跨日、动态偏好、焦点、history。 */
{
  const r = spawnSync(
    process.execPath,
    [
      '--import',
      pathToFileURL(join(ROOT, 'worker', 'register-ts-ext.mjs')).href,
      join(ROOT, 'scripts', 'gate-site-behavior.mjs'),
    ],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
  );
  const out = `${r.stdout || ''}\n${r.stderr || ''}`.trim().split('\n').filter(Boolean);
  results.push({
    gate: 'site-behavior(配置消费/运行时)',
    pass: r.status === 0,
    detail: r.status === 0 ? [] : out.slice(-30).map((line) => line.trim()),
  });
}

/* ── 第八门:被层叠悄悄压掉的 CSS 声明 ──
   同型两次都是「写进去了但从未生效,而且没有任何反馈」:
   ① 同一条规则里写了两个 max-width(新值在前旧值在后),「已修」从未生效;
   ② 手机菜单的矮屏压缩块写在它要压的基础规则**前面**,嵌套 media 不加特异度 → 六条只落地三条。
   两次都是独立评审逐像素量出来的,肉眼与「我改了」的记忆都发现不了。
   判据与红测见 gate-css-shadowed.mjs / test-css-shadowed.mjs(红绿两向;条数以实跑为准,由 npm run test:gates 汇总)。 */
{
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'gate-css-shadowed.mjs')], { cwd: ROOT, encoding: 'utf8' });
  const out = (r.stdout || '').trim().split('\n').filter(Boolean);
  results.push({
    gate: 'css-shadowed(死声明)',
    pass: r.status === 0,
    detail: r.status === 0 ? [] : out.filter((l) => !/^\[css-shadowed\] ✓/.test(l)).map((l) => l.replace(/^\s*/, '')),
  });
}

/* ── 第七门:画布几何(运行时,自建自起产物) ──
   前六门全是静态文本/token 检查,没有一门看渲染盒子——R39 的「正文被挤成 33px」
   在六门全绿的情况下溜进产物,靠人肉才发现。判据与红测见 gate-canvas-geometry.mjs。
   代价:本门要构建+起预览+真渲染,verify 因此从「秒级」变成「分钟级」。 */
{
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'gate-canvas-geometry.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const out = (r.stdout || '').trim().split('\n').filter(Boolean);
  const detail = out.filter((l) => !/^\[geo\] ✓/.test(l)).map((l) => l.replace(/^\s*/, ''));
  if (r.status === 3) {
    // 跑不起来 ≠ 放行:非 prod 走可见 warn(与 brand-parity 的跨仓缺席同体例),prod 硬红
    // R43:NOT-RUN 一律判红。此前 pass:!PROD ⇒ 人读的那行说「未执行不算过」,
    //      而机器读的 .verify-exit.code 写的是 0 —— 两条结论相反,且仓规指定读文件。
    //      要放行须显式 --allow-not-run。
    const allow = process.argv.includes('--allow-not-run');
    results.push({ gate: 'canvas-geometry(运行时)', pass: allow, warn: allow, detail: [...detail, 'NOT-RUN:本门未实际执行,不构成任何背书'] });
  } else {
    results.push({ gate: 'canvas-geometry(运行时)', pass: r.status === 0, detail: r.status === 0 ? [] : detail });
  }
}

/* ── 第八门:墨迹不能相撞(运行时) ──
   前七门里没有一门看得见「字挤在一起」:行高有值(只是值不够)、版面不溢出、逐元素回归也对得上,
   坏的只是相邻两行的墨互相压、或首屏文字钻进导航的磨砂蒙版底下。
   这一族在 R44、R45 连续两轮由独立评审逐字量出来,两轮都是「治了几处、漏了同族其余处」。
   本门的三条判据全部**构造性**,不依赖任何手写清单——路由从产物枚举、视口从产物 CSS 的断点推导、
   墨高用 canvas 逐行实测(上一版三张手写清单各漏一块:漏 9 条路由、漏窄屏、漏了 Be Vietnam Pro 的字身)。
   放在 canvas-geometry 之后:那一门已经把 dist 构建好,本门自带静态服务直接伺服 dist,不再重复构建。
   判据、豁免与自检见 gate-render-fit.mjs(`--self-test`,红绿两向;条数以实跑为准,由 npm run test:gates 汇总)。 */
{
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'gate-render-fit.mjs')], { cwd: ROOT, encoding: 'utf8' });
  const out = (r.stdout || '').trim().split('\n').filter(Boolean);
  const detail = out.filter((l) => !/^\[render-fit\] ✓/.test(l)).map((l) => l.replace(/^\s*/, ''));
  if (r.status === 3) {
    // 与 canvas-geometry 同体例:跑不起来 ≠ 放行,NOT-RUN 一律算红,要放行须显式 --allow-not-run
    const allow = process.argv.includes('--allow-not-run');
    results.push({ gate: 'render-fit(运行时)', pass: allow, warn: allow, detail: [...detail, 'NOT-RUN:本门未实际执行,不构成任何背书'] });
  } else {
    results.push({ gate: 'render-fit(运行时)', pass: r.status === 0, detail: r.status === 0 ? [] : detail });
  }
}

/* ── 第十一门:叠卡编舞几何(运行时) ──
   9e24b27 的兜底栅格 max-width 漏进编舞档:包含块 1440→1120,卡锚 27.43%→21.3%、
   卡宽 45.14%→35.1%、侵入左栏文字 29-89px —— 当时十门全绿,主人肉眼抓到。
   本门守两层:任一滚动相位零侵入 + 卡宽/卡锚相对钉屏区必须是规格百分比(直接钉包含块缩水这个根)。
   复用 canvas-geometry 已构建的 dist;红测:对 R46 坏产物 60 条全响(2026-08-27 实录)。 */
{
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'gate-deck-clearance.mjs')], { cwd: ROOT, encoding: 'utf8' });
  const out = (r.stdout || '').trim().split('\n').filter(Boolean);
  const detail = out.filter((l) => !/^\[deck\] ✓/.test(l)).map((l) => l.replace(/^\s*/, ''));
  if (r.status === 3) {
    const allow = process.argv.includes('--allow-not-run');
    results.push({ gate: 'deck-clearance(运行时)', pass: allow, warn: allow, detail: [...detail, 'NOT-RUN:本门未实际执行,不构成任何背书'] });
  } else {
    results.push({ gate: 'deck-clearance(运行时)', pass: r.status === 0, detail: r.status === 0 ? [] : detail });
  }
}

/* ── 门自检:各门自带的红绿表必须真在跑 ──
   三道门(canvas-hazard / render-fit / css-shadowed)各自写了红测,头注里也写着「判据必须有红测」,
   但此前**没有任何东西保证那些红测还过得了**——它们只在人想起来手跑时才执行,等于文档不是门。
   一道判据被悄悄改松(如 canvas-hazard 的字身正则曾漏判全部负值)时,门本体照样报绿,
   只有红测会响;红测不跑 = 那层保护不存在。放在汇总前统一跑,任一失败即整体判红。 */
{
  const SUITES = [
    ['canvas-hazard', ['scripts/gate-canvas-unit.mjs', '--self-test']],
    ['render-fit', ['scripts/gate-render-fit.mjs', '--self-test']],
    ['css-shadowed', ['scripts/test-css-shadowed.mjs']],
    ['regex-escape', ['scripts/test-regex-escape.mjs']],
    ['site-behavior', ['--import', './worker/register-ts-ext.mjs', 'scripts/gate-site-behavior.mjs', '--self-test']],
    // git 层两道门的红测(2026-09-03 Tier 1-⑧,node --test 体例,成功行是「# pass N」):pre-push full 门 / pre-commit S 级门
    ['githooks-pre-push', ['.githooks/verify-before-push.test.mjs']],
    ['githooks-pre-commit', ['.githooks/guard-mainline-commit.test.mjs']],
  ];
  const detail = [];
  for (const [name, argv] of SUITES) {
    const command = argv[0].startsWith('--') ? argv : [join(ROOT, ...argv[0].split('/')), ...argv.slice(1)];
    const r = spawnSync(process.execPath, command, { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) {
      const tail = (r.stdout || '').trim().split('\n').filter((l) => /❌|FAIL|失败/.test(l)).slice(0, 4);
      detail.push(`${name} 的红测没过(exit ${r.status})——该门的判据已失去红测保护`, ...tail.map((l) => '  ' + l.trim()));
      continue;
    }
    /* 🔴 exit 0 不等于「跑过了」——三层都能让一套红测**一条没跑却报成功**:
         ① 自检守卫失配(gate-canvas-unit 曾用文件名匹配,复制/改名后静默 exit 0、零输出);
         ② 红测本体用例集为空(表被清空 / 过滤条件写错);
         ③ 本门自己只看退出码,于是①②都看不见。
       所以再要一条正数用例计数:三套的成功行都自带(「26 红 + 15 绿」/「22 pass」/「13 pass」),
       读不到就判红。这一条同时封住上面三层——无论哪层坏,表现都是「输出里没有正数用例数」。 */
    // 两种成功行都认:「22 pass」(自研红测)与 node --test 的汇总行「# pass 13」(tap)/「ℹ pass 13」(spec,非终端下实测就是它)—— 数在后
    const ran = [...(r.stdout || '').matchAll(/(\d+)\s*(?:pass|红|绿|通过)|[#ℹ]\s*pass\s+(\d+)/g)].reduce((s, m) => s + +(m[1] ?? m[2]), 0);
    if (ran === 0) {
      detail.push(
        `${name} 的红测 exit 0 但读不到用例数——「没跑」不算「通过」,不许静默降级成绿`,
        `  实际输出:${((r.stdout || '').trim().split('\n')[0] || '(空)').slice(0, 90)}`,
      );
    }
  }
  results.push({ gate: `gate-self-tests(${SUITES.length} 套红测)`, pass: detail.length === 0, detail });
}

/* ── 汇总 ── */
let failed = 0;
for (const r of results) {
  const mark = r.pass ? (r.warn ? '⚠' : '✓') : '✗';
  console.log(`[verify] ${mark} ${r.gate}${r.detail.length ? '' : ' — clean'}`);
  for (const d of r.detail.slice(0, 20)) console.log(`         ${d}`);
  if (!r.pass) failed++;
}
const code = failed ? 2 : 0;
// NOT-RUN 不许混进 pass 计数——「跳过 ≠ 放宽」,报绿必须说清跑了几道
const notRun = results.filter((r) => r.detail.some((d) => d.startsWith('NOT-RUN'))).length;
console.log(
  `[verify] ${results.length - failed - notRun}/${results.length} gates pass${notRun ? ` · ${notRun} NOT-RUN(未执行,不算过)` : ''}${PROD ? ' (prod mode)' : ''}`,
);
writeFileSync(join(ROOT, '.verify-exit.code'), String(code));
// pre-push 门读这份:NOT-RUN 不算过(--allow-not-run 放行的绿不背书任何一棵树),要推得走 ALLOW_UNVERIFIED_PUSH 留痕
try {
  mkdirSync(join(ROOT, '.verify-cache'), { recursive: true });
  writeFileSync(join(ROOT, '.verify-cache', 'last-run.json'), JSON.stringify({
    mode: 'full', verdict: code === 0 && notRun === 0 ? 'pass' : 'fail', at: new Date().toISOString(),
    headTree: gitOut('rev-parse', 'HEAD^{tree}'), dirty: gitOut('status', '--porcelain') !== '', treeMoved: treeFingerprint() !== startFingerprint,
    gates: results.length, failed, notRun,
  }, null, 2) + '\n');
} catch { /* 写不了缓存不影响门结论,只是推主线时要重跑 */ }
process.exit(code);
