# T7 独立验收报告 — 配置校验器与禁用词单源(2026-08-31)

- 验收人:独立 tester agent(未参与实现);对象:包③ T7(词表单源 + validateConfig 十族校验 + 等价性门)
- 规格:`PRD/NexGrid_官网后台PRD_v1.0.md` [FEAT-CON04]②③ + §1.4;plan T7 节
- 环境:worktree `D:\WORKS\PLAN\.wt\w-console` @ `pkg/w-config`(HEAD d04d484),node v24.15.0;全程只跑 node 脚本,未起任何服务(verify 运行时门内部用 OS 随机空闲端口自起自收,非固定端口,不碰并行验收资源)

## 结论:4/4 AC 全 PASS;另报 1 条 P2(不阻断)

| AC | 判定 | 一句话证据 |
|---|---|---|
| A 单源结构 | PASS | 词表指纹全仓(git grep 全 tracked 文件)只在 `scripts/forbidden-patterns.mjs`;两消费面均 import |
| B 变异双红 | PASS | 追加探针正则后:verify exit-file=2 且 forbidden-words 门列出命中;schema 直调报 forbidden-word error;还原后 13/13 复绿 |
| C 校验器行为 | PASS | 6 项抽测全中:5 类 error 各恰好 1 条、锚值=warning×5 / error×0 |
| D 等价性门 | PASS | `gate:equivalence` exit 0(6 判全 ✓);`--self-test` exit 0(2 判全 ✓) |

## AC-A 单源结构 — PASS

- `git grep -l -E "稳赚|躺赚|risk\["`(词表独有指纹,覆盖全部 tracked 文件)→ 唯一命中 `scripts/forbidden-patterns.mjs`。
- `git grep -c FORBIDDEN_PATTERNS` → 恰 3 文件:定义处 + `scripts/verify.mjs:11`(`import { FORBIDDEN_PATTERNS } from './forbidden-patterns.mjs'`)+ `schema/src/validators.ts:2`(`import { FORBIDDEN_PATTERNS } from '../../scripts/forbidden-patterns.mjs'`)。两面皆 import 引用,零内联副本。
- 消费链闭合:`worker/src/config.ts:92` 经 schema barrel 调 `validateConfig` → validators.ts → 同一词表;站上门 1 直接遍历同一数组。

## AC-B 变异双红(§6-7 核心)— PASS

变异(本验收唯一授权仓内临时写,git diff 留痕:`scripts/forbidden-patterns.mjs` +1 行):

```
+  [/NXTESTWORD/i, '变异探针'], // T7 验收临时追加,测毕 git checkout 还原
```

外加临时探针文件 `src/nxtest-probe.md`(含 NXTESTWORD,untracked)。

- 面① 站上门:`node scripts/verify.mjs` → stdout `VERIFY_EXIT=2`,`.verify-exit.code` 内容=`2`;门输出:
  `[verify] ✗ forbidden-words` / `src/nxtest-probe.md: [变异探针] "NXTESTWORD"`;12/13 过——**唯一红门即 forbidden-words**(含 3 道运行时门在内其余全绿,归因干净,非他因连坐)。
- 面② schema 校验器:`cd worker && node --import ./register-ts-ext.mjs <探针脚本>`,把 NXTESTWORD 注入 `copy.en.hero.subtitle` 调 `validateConfig` → errors 恰 1 条:
  `{path:'copy.en.hero.subtitle', rule:'forbidden-word', message:'合规拦截 [变异探针]:「NXTESTWORD」'}`。
- 两面在**同一份变异词表**下同时变红;且面②未做任何构建即传导,证明 schema 面是运行时活 import 而非烘焙副本。

### 还原证明

1. `git checkout -- scripts/forbidden-patterns.mjs` + 删除 `src/nxtest-probe.md`;
2. 复跑 `node scripts/verify.mjs` → `VERIFY_EXIT=0`,`.verify-exit.code`=`0`,`[verify] ✓ forbidden-words — clean`,**13/13 gates pass**(deploy-gate 与 launch-assets 两处 ⚠ 为既有 warn-only 项,变异前后一致,与本验收无关);
3. 终态 `git diff --stat` 为空(tracked 零改动);untracked 仅剩并行验收产物 `docs/changes/2026-08-31-website-admin-t8-test.md`、`...t9-test.md` 与本报告(过程中一度出现的 `worker/.wrangler-t8/` 亦属并行会话,后被其主清走)——本验收足迹已清零。

## AC-C 校验器行为抽测 — PASS(node 直调,种子副本变异,每项断言「恰好该条 error、无串扰」)

基线:种子 `validateConfig` errors=0 / warnings=13(顺带证词表对现网三语文案零误伤)。

| 探针 | 结果 |
|---|---|
| {devices} 从 vi `social.scaleLine` 删除 | error `placeholder@copy.vi.social.scaleLine`,恰 1 条 |
| zh `hero.subtitle` 置空 | error `untranslated@copy.zh.hero.subtitle`,恰 1 条 |
| downloads.ios enabled=true + url='' | error `enabled-empty-url@downloads.ios`,恰 1 条 |
| FAQ 仅留 2 条 visible | error `min-visible@faq`,恰 1 条 |
| 公告 enabled + endsAt < startsAt | error `window@announcement.endsAt`,恰 1 条 |
| 统计锚值(种子原值) | warning×5(stats.activeDevices/activeJobs/nodes/countries/uptime),error×0;反向改非锚值后该键 warning 消失且 errors=0 |

## AC-D 等价性门 — PASS

- `cd worker && npm run gate:equivalence` → exit 0;6 判全 ✓:种子自洁 errors=0(软警告 13 条,含锚值 5 条)、i18n 三语逐字节一致(en 12696B / vi 13049B / zh 7282B)、`src/config/site.json` ≡ 物化(种子)、落盘种子深等。
- `node --import ./register-ts-ext.mjs gate-equivalence.mjs --self-test` → exit 0;变异确被比较器捕获 + 变异值本身不误报。

## 发现项(全部上报)

- **P2 — 判定循环三份并存,`scanForbidden` 是死导出**:`scripts/forbidden-patterns.mjs:30` 导出 `scanForbidden` 并注释「两面共用的判定函数,连判定循环都不许各写各的」,但全仓无任何外部调用——`scripts/verify.mjs:42-45` 内联循环、`schema/src/validators.ts:21-28` 自写 `scan()`。三份循环今日语义等价(逐 pattern 取首命中),词表本体单源不受影响(AC-A 判据满足),但「判定语义」这一层未锁消费面:未来任一面单独加豁免/白名单即静默分叉,且文件自述契约与现实不符。修法建议:两面改调 `scanForbidden`,或删死导出并改注释为「仅词表单源」。
- 备忘(非问题):变异面①运行中,gate-equivalence 不受探针正则影响(种子无 NXTESTWORD),两门正交符合预期。

## 过程写入清单(除本报告外零仓内遗留)

| 动作 | 状态 |
|---|---|
| `scripts/forbidden-patterns.mjs` +1 探针行(授权临时) | 已 `git checkout --` 还原,diff 空 |
| `src/nxtest-probe.md`(授权临时) | 已删除 |
| harness/探针脚本、verify 日志 | 全在会话 scratchpad(仓外) |
| 本报告 | `docs/changes/2026-08-31-website-admin-t7-test.md`(授权) |
