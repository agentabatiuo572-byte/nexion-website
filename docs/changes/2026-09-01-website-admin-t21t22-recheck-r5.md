# T21/T22 发布流水线 第五轮验收报告(黑盒 · 独立验收方 · 2026-09-01)

**判决 = 不可签字。**

- **验收对象**:PRD `NexGrid_官网后台PRD_v1.0.md` [FEAT-CON13] 全部(按 2026-09-01 改写后的 ④「不存在该 API」边界段判定)+ [FEAT-CON02]-E2 + CON14 / CON16 相关;plan `2026-08-31-website-admin.plan.md` T21 / T22 两节。
- **被测版本**:`D:\WORKS\PLAN\.wt\w-console`,分支 `pkg/w-publish`,HEAD `9d96cea`,开工时工作树干净。
- **环境**:worker `http://127.0.0.1:8811`(分配端口,未退 8813),隔离持久化目录 `worker/.wrangler-r5`;控制台经 worker 同域 `/admin`;真浏览器 Playwright;门红测跑在 `git archive HEAD` 的隔离副本上。额外占用 **8817**(自建的丢包代理,见实验二;不在禁占清单内)。
- **执行量**:4 次真发布(成功 v3 / 门红 v4 / 成功+丢包 v5 / 回滚 v21;gates 步实测 v3 = **334 s**、v21 = **333 s**,v4 / v5 我只轮询到「仍在跑」的中途值(≥241 s / ≥314 s),**收尾秒数没记到,不作断言**)、24 个版本号、`/step` 守卫矩阵 12 条、15 条猜测路由 × 5 方法 + 版本行/审计各 4 种写方法 + 11 个未认证入口、`gate-config-consistency` 红绿测 22 组、worker 单测 102/102 + tsc 0 错、Playwright 两轮控制台实景。
- **冻结纪律**:`worker/src/**`、`worker/*.mjs`、`worker/wrangler.jsonc`、`worker/migrations/**`、`admin/src/**` **全程零写入**(收尾 `git status --short` 对这些路径为空,见第八节)。

**一句话**:P0 连续第三轮为 0——纯 HTTP 面依旧上不了线,我又穷举了一遍(路由、守卫矩阵、并发、口令、印记四种不符),机器强制的那一半成立。但**交底的八条修法里,有四条没修到根上,而且每一条都能被一个红测当场推翻**:① 幂等重报只覆盖了**非终态**回报,而真正会丢响应的那一步(`swap ok`,promote 写 dist-live 触发 wrangler 重启)恰恰是**唯一没被覆盖**的——实测一次**成功**的发布把执行器打死,下一次发布静默排队;② 上线印记的摘要从「site.json」扩到「四个物化文件」,但它核的仍是**构建输入**不是**被搬运的产物**——实测一道门不跑 + 任意字节塞进 dist(含控制台产物)照样 live,而 `dirty=0 / drift=null / 红条无`;③ `gate-config-consistency` 新增的「规则名认数字」自检**是假绿**:自检通过,真事故形态照样放过(红测两向证);④ `cancelled` 终态有三个消费面没跟上(驾驶舱直出枚举值、cancelled 版本给出永远点不动的回滚按钮、cancelled 占最大号时失败面整块消失而壳顶红条仍指人去看)。合计 **7 条 P1 + 29 条 P2**,**P0 = 0**。

---

## 〇、环境与偏差(先交底)

1. **分配端口 8811 全程可用**,未退 8813;4407 / 5187 本轮未起(控制台经 worker 同域伺服)。禁占端口 8787/8788/8791/8793/8797/8799/8801/8803/8809/4321/4401/4403/4405/5174/5175/5181/5183/5185 **全程零占用**(收尾逐个回读为 0);**4399 / 3002 / 5173 是别的会话在用的,我全程未碰**,收尾回读三者仍各 1 个监听。
2. **额外占用 8817**:实验二需要一个「把回报转发出去、拿到真响应、再把连接掐掉」的透明代理,脚本在 scratchpad(`dropproxy.mjs`),不在仓内。8817 不在禁占清单里,收尾已停。
3. **起服方式**:`npx wrangler d1 migrations apply nexgrid_site --local --persist-to .wrangler-r5`(0001–0006 全 ✅)+ `npx wrangler dev --port 8811 --persist-to .wrangler-r5`。理由同前三轮:npm 脚本把 `--persist-to` 只挂在 `wrangler dev` 上,迁移会落到另一个库;禁直跑 `npx wrangler dev` 的理由是「跳过迁移」,我把迁移显式跑在同一 persist 目录上,理由已被满足。
4. **实验前先证起点**:每次「打一发看它挂没挂」之前都先 `GET /api/health` 回读 200,收尾同样回读。
5. **中文一律走 PowerShell(UTF-8 字节)发**,不用 Git Bash 的 `-d '中文'`——上一轮那条误伤本轮零复现。
6. **我自己造成的一处干扰,如实交底**:v4 那次真发布的 `deck-clearance` 门红,发生在我并行跑探针的时段;同型改动(往 FAQ 第一条答案追加一个标记)另外三次真发布全绿。我**不能排除**是我的负载把这道运行时门压出了假红——这件事本身被我记成 P2-24,并明确标注归因不确定。
7. **实验会污染 `src/i18n/*` 与 `src/config/site.json`**(执行器每次发布都会重写它们),以及 `dist` / `dist-live`。收尾用一次**真回滚到 v1(初始种子)**把两边一起洗回去,见第八节。
8. **收尾之后我又起了第二个隔离实例**(`--persist-to .wrangler-r5b`,同样 8811,全新 D1、live = 初始种子)专门重跑第二节那张 P0 表——因为那五条如果继承上一轮结论就不算验过。跑完同样杀净、把 `.wrangler-r5b` 移出仓、删掉留下的印记文件,状态回到与第一次收尾完全一致(`dist` / `dist-live` 各 112 文件、指纹同为 `aaebf88ce53b17b4`)。

---

## 一、逐 AC 结论

### T21 · 发布编排

| # | AC(plan 原文口径) | 结论 | 证据 |
|---|---|---|---|
| T21-1 | 前置校验红 → 不进流水线并逐项列出 | **PASS** | 草稿注入 `Guaranteed 20% monthly returns, risk free investment.` + 一条空 vi → `GET /preflight` `ready:false` + 4 条 errors(3×`forbidden-word` / 1×`untranslated`);`POST /api/publish` → **409 `preflight-failed`** 并回带 errors;**版本行数 before=9 after=9**(校验在 INSERT 之前)。真浏览器:红项表 4 行 + 发布按钮 `disabled=true` |
| T21-2 | 去修复定位 | **FAIL(P2-1)** | 真浏览器取 href:`["/admin/content/faq","/admin/content/faq","/admin/content/faq","/admin/content/faq"]` —— 裸路径,无 hash/query,PRD ⑥「定位到**红字段**」未实现。**五轮同条** |
| T21-3 | 红项自动排除保留草稿 | **PASS** | v4 门红后 `dirty` 仍为 3、`changedPaths` 原样;界面「你的草稿改动也原样保留」属实 |
| T21-4 | 状态机单向且 server 权威 | **PASS(HTTP 面)** | 守卫矩阵见下表。**边界见 P1-2**:swap 核的是印记里的「构建输入摘要」,不是线上快照的内容 |
| T21-5 | 并发发布 409 | **PASS(带 P2-3)** | 6 路并发 `POST /api/publish` → 1×200 + 5×409 `publish-in-progress heldBy:11`,零 500,**零垃圾版本行**;被拒的 5 路各留一条 `config.publish.rejected` 审计(r4 P2-4 已消除)。代价:**号段永久空洞**(P2-3) |
| T21-6 | 锁 TTL 15 分钟超时自动 failed | **PASS(带 P2-5)** | 把 `publish_lock.expires_at` 拨到 1 → `GET /status` 读时自愈把该版标 `failed`、收口停在 running 的步骤、写 `config.publish.failed` 审计、清锁;旧口令再上报 → `not-current-job`(详见第六节实验七) |
| T21-7 | 执行器不在线 → 排队态可取消 | **PASS(带 P1-6 / P2-15)** | 排队态 `POST /cancel {}` → 200;已开工 → 409 `already-running` + `canForce/silentMs/hint`;失联满 12 分钟 → `canForce:true`、无理由 → 400、带理由 → `{"ok":true,"forced":true}`、审计带理由。**界面 / README / 服务端提示三处已统一为 12 分钟(r4 P1-7 已消除)** |
| T21-8 | 不存在绕门发布 API(路由审计) | **PASS(HTTP 面)** | 15 条猜测路由 × 5 方法(`/publish/live`、`/force`、`/promote`、`/stamp`、`/swap`、`/skip`、`/gates`、`/claim`、`/release`、`/lock`、`/retry`、`/resume`、`/verify`、`/config/live`、`/config/publish`)**全 404**;版本行 PUT/PATCH/DELETE/POST 全 404;`/api/audit` 四种写方法全 404;11 个入口未认证 **全 401** |

**`/step` 守卫矩阵(HTTP 实测)**

| 上报 | 响应 |
|---|---|
| 不带 `stamp` / 带错的 `stamp` | 409 `not-the-claimed-runner(请先领取任务)` |
| `materialize running` ×2 | 200 → **200 `idempotent`**(r4 P1-2 的修法) |
| `materialize ok` ×2 | 200 → **200 `idempotent`** |
| 已 ok 后改报 `failed` | 409 `step-already-done` |
| 已 ok 后回退报 `running` | 409 `step-already-started {at:"ok"}`(r2 P2-1 已消除) |
| 跳步(直接 `swap running`) | 409 `step-out-of-order {missing:["gates","build"],expected:"gates"}` |
| **终态回报重发(`gates failed` 再报一次)** | **409 `not-current-job`** ← **P1-1 本体** |
| 6 路并发 `POST /next` | 只有 1 路拿到 job,其余 `already-claimed` |
| 二次领单 | `{"job":null,"note":"already-claimed"}` |

### T22 · 执行器 + 失败面 + 版本/回滚

| # | AC | 结论 | 证据 |
|---|---|---|---|
| T22-1 | 执行器按 §5.4 领任务 → 物化 → 全门 → build → 上新 → 回报 | **PASS** | 真成功 3 次:v3(materialize 0 s / gates **334 s** / build 3 s / swap 1 s)、v5、v21 回滚(gates **333 s**);印记随 promote 落盘并被服务端回读核实(含扩到四个文件的 `configSha`);门红那次日志里 `[verify] 12/13 gates pass` 佐证 13 门真跑 |
| T22-2 | 任一门红 → failed + 线上保旧版(实测站产物未变) | **PASS** | v4 `deck-clearance` 红:门跑期间 12 次采样**唯一指纹 740D0A85BA**、`R5MARKB` 命中 0;门红后线上仍 `R5MARKA=True / R5MARKB=False`;`promote --check` 报 `dist 109/47a93e179227a4de` vs `dist-live 112/dfc3f757216023f0`(两目录真分离) |
| T22-3 | 失败面 = 门名 + 大白话 + 原始日志折叠 | **PASS(带 P2-18 / P2-24)** | 真浏览器:`上次发布失败(v9):新文案把版面挤破了(…)(门:render-fit)` + 「查看原始日志」按钮 + `<pre>` 展开原文。**但日志窗口仍能吃掉关键行(P2-18),且门的大白话对同一道门的不同判据会说错(P2-24)** |
| T22-4 | 映射表覆盖 13 门,缺项显门名原文 | **PASS(带 P1-3)** | `GATE_REASONS` 14 键 = 站上 13 门 + `config-consistency`;实跑 `deck-clearance` / `render-fit` / `forbidden-words` 三条映射均命中。**守这张表的门有盲区,见 P1-3** |
| T22-5 | 版本列表 append-only | **PASS(带 P2-2 / P2-3)** | 无任何删改版本路由;版本号只增。**缺 PRD ⑤「改动数」列与 ⑥ 行内「查看」→ diff 摘要**(实景表头 `版本 / 时间 / 状态 / 理由·失败原因 / 操作`);**号段空洞**实测 `… v11, v17 …` 与 `… v18, v20 …` |
| T22-6 | 回滚走完整门链生成新版本(实测站产物=旧内容) | **PASS** | `POST /api/publish {fromVersion:1, reason:…}` → **v21**,四步齐全(gates 333 s);内容核验见第六节实验六;`fromVersion` 无理由 / 3 字 → 400 `reason-required`,`9999` → 404,`cancelled`/`failed` 源 → 404 `version-not-rollbackable`(**r4 P2-7 已消除**) |
| T22-7 | 审计 | **部分 PASS(P2-4)** | 49 条审计行逐版本可追:`config.publish` / `config.rollback` / `config.publish.live` / `.failed` / `.cancel`(带理由)/ **`.rejected`(本轮新增,r4 P2-4 已消除)**;自愈标 failed 现在**也写审计**(r4 P2-5 已消除)。**缺口**:`.live` 的 `after_summary` / `reason` 仍恒 NULL |

### 移交进本包的 AC

| # | AC | 结论 | 证据 |
|---|---|---|---|
| CON02-E2 | 上次发布 failed → 任意页红条,点击 → /publish | **部分 PASS(P1-5)** | 真浏览器四页(`/`、`/publish`、`/audit`、`/content`)红条在场:`上次发布失败(v7):文案里有合规禁用词(门:forbidden-words) 线上仍是 v5,未受影响。 去看详情`;**正常取消不再造假红条(r4 P1-5 已消除)**。**但 cancelled 一旦占住最大号,`/publish` 上的失败面整块消失,而红条仍在指人去那儿看详情(P1-5)** |
| CON13 drift 提示 | 劈叉必须让人看见 | **部分 PASS(P2-25)** | `/status` 与 `/api/config` **都**回 drift(r4 P1-6 已消除),壳顶有渲染块,发布页给「重新发布 v{N} 以对齐」按钮且回滚源判据放行 `live`。**但 drift 只比版本号不比内容:手工直改快照文件后 `drift=null`(P2-25)** |
| CON16-AC4 | schema 版本漂移拒绝面 | **未接线(同前三轮)** | 全仓 `SCHEMA_VERSION` 只有 `schema/src/site-config.ts:82` 定义 + `schema/src/materialize.ts:40` 写进产物两处,发布链无一处读它做拒绝。plan 已把它挪到 T23,**本轮无可验之物** |

### 被改动的门(红绿两向)

| 门 / 断言 | 正对照 | 红测(真实事故形态) | 结论 |
|---|---|---|---|
| 伺服目录断言改按 realpath | 真配置 exit 0 | 7 组文本变异(`../dist` · `../dist/` · `./../dist` · `../dist-live/../dist` · `..\dist` · `dist` · `../dist-live/./../dist`)**全 exit 1**;**真建 junction**(`New-Item -ItemType Junction dist-live -> dist`)→ **exit 1** | **r4 P2-11 已消除** |
| JSONC 行尾注释 | — | `wrangler.jsonc` 加合法行尾 `//` → **不再抛栈**,给出 `✗ wrangler.jsonc 读不动(本门的 JSONC 剥注释不处理行尾 // 注释):SyntaxError…` | **诊断已给(如实现方所述);门仍读不懂合法 JSONC,保留 P2-12** |
| 规则名正则「认数字」 | `--self-test` **11/11 全绿**(含这一条) | **真加一条 `rule: 'h1-count'`(不删任何现有规则)→ 门 PASS / exit 0**;对照 `rule: 'brandnewrule'` → FAIL / exit 1 | **🔴 假绿,见 P1-3** |
| 失败面映射双向断言 | 18 条规则 ↔ 18 条映射全绿 | 见上一行(纯字母的新规则守得住) | **半守** |
| worker 单测 / 类型 | `npm test` **102/102(9 files)** · `tsc --noEmit` **0 错** | **`dist-live/.publish-stamp.json` 存在时 = 101/102,1 failed**(`publish.spec.ts:410`) | **r4 P2-13 仍在** |

---

## 二、P0

**本轮未发现 P0。**

按 PRD ④ 2026-09-01 改写后的口径(机器强制 = **任何 HTTP 请求序列都上不了线**;门跑没跑靠执行器环境可信),机器强制那一半我逐条证伪过,成立。

🔴 **这张表里的每一行都是本轮亲手打出来的,没有一行是继承上一轮结论**——上线核验那四种不符,我专门另起了一个全新 D1(`--persist-to .wrangler-r5b`,live = 初始种子 v1)逐条跑,原文如下:

| 尝试 | 结果(本轮实测原文) |
|---|---|
| 不领单直接上报 | 409 `not-the-claimed-runner(请先领取任务)` |
| **A. 领单后按合法顺序把四步各报一遍,不跑 promote** | `swap ok` → **409** `{"error":"live-verification-failed","why":"线上快照里没有本次发布的上线印记(切换步没有真正搬运过产物)"}`;v2 标 failed |
| **B. 印记版本号不符**(写 `versionId:999`) | **409** `why:"线上快照的印记指向 v999,不是本次要上线的 v3"`;v3 标 failed |
| **C. 印记口令不符**(版本号对、`stamp` 写 0) | **409** `why:"线上快照的印记口令与本次发布不符"`;v4 标 failed |
| **D. 版本号 + 口令都对,只有内容摘要不符** | **409** `why:"线上快照不是照这一版的配置构建的(内容摘要对不上:期望 2914497c168b…,实际 000000000000…)"`;v5 标 failed |
| **E. 锁过期后上报** | `materialize ok` → **409** `lock-expired(发布已超时,请重新发起)`;随后 `/status` 自愈把 v6 标 failed |
| 跳步 / 已 ok 改口 / 已 ok 回退报 running / 终态回报重发 | 全 409(见 `/step` 守卫矩阵) |
| 6 路并发 `POST /api/publish` / 6 路并发 `POST /next` | 各只有 1 路成功,零 500,零垃圾行 |
| 15 条猜测绕门路由 × 5 方法 + 11 个未认证入口 | 全 404 / 全 401 |
| 版本行与审计行的 PUT/PATCH/DELETE/POST | 全 404 |

A–E 跑完的收尾状态:`v6/v5/v4/v3/v2 全 failed,v1 仍 live`,线上首页**不含**任何 `R5S*` 标记(即这五次尝试没有一次把内容推上线)。

**判据说明**:这不等于「不跑门就上不了线」。后者在**执行器机器可信**这条前提之外仍然不成立——而且本轮我把它推到了比 r4 更彻底的形态:见 P1-2,线上快照的**内容**至今没有任何一处被核实过。

---

## 三、P1(逐条不合并)

### P1-1 🔴 幂等修法只覆盖了「非终态」回报,而真正会丢响应的那一步(`swap ok`)恰恰是**唯一没被覆盖**的——实测一次**成功**的发布把执行器打死,下一次发布静默排队

这是**派单点名要找的第四次组合故障**。四条各自正确的东西合起来:

- **α**(本轮 P1-2 修法):同一步同一结果重报 = 幂等 200(`worker/src/publish.ts:281-284`)。
- **β**:每个**终态**回报都先删锁——`failed` 删锁(`:308`)、上线核验失败删锁(`:337`)、`swap ok` 成功删锁(`:345`)。
- **γ**:`/step` 的锁归属校验排在幂等判断**之前**(`:256` `not-current-job`),于是终态回报的重发**根本走不到 α**。
- **δ**:执行器把 409 当明确拒绝、不重试(`worker/runner.mjs:34` `:39`);它的 12 处 `report()` 调用要么完全裸露(如 `:96` 的 `gates failed`),要么就在 `catch` 里(如 `:123` 的 `swap failed`)——**在 catch 里再抛就直接逃逸**,最外层 `loop().catch` 一律 `process.exit(1)`(`:143-146`)。

**而「响应会丢」这件事,在当前配置下恰好只发生在 `swap ok` 这一步**:`runner.mjs:23-24` 的注释说的是「门里的构建重写 dist → wrangler 监视该目录 → 重启 → 掐断连接」,但 P0-3 的修法早已把 `assets.directory` 改成了 `../dist-live`,于是 **wrangler 现在监视的是 dist-live,唯一会写它的是 swap 步的 `promote.mjs`**。实测日志逐字:

```
POST /api/publish/step 200 OK      ← swap running
⎔ Reloading local server...         ← promote 写 dist-live,wrangler 重启
POST /api/publish/step 200 OK (103ms)  ← swap ok
```
(另外单独验证:往 `dist-live` 里放一个文件再删掉,wrangler 各重启一次。)

**复现(照做即可,已端到端实测)**

```
1. 起一个透明代理:node dropproxy.mjs 8817 8811 swap:ok
   （它把 /step 转发给真 worker、拿到真响应后把连接掐掉不回复 —— 精确复现「回报送到了、响应在回程丢了」）
2. POST /api/publish                                   -> v5
3. npm run publish:runner -- --api http://127.0.0.1:8817 --cookie <sid>   （常驻模式,README 的默认用法）
4. 等它跑完门链(本机约 5–6 分钟;这一次的收尾秒数我没记到,只轮询到 ≥314 s)

实测日志原文:
  [proxy] step swap/ok v5
  [proxy] 🔴 已把 swap/ok 转发到服务端(服务端回 200 …),现在掐断连接不回复
  [proxy] step swap/ok v5          ← 执行器的重试
  [proxy] step swap/failed v5      ← 重试拿到 409,catch 里再报 failed
  执行器异常: Error: /api/publish/step → 409 {"error":"not-current-job"}
      at api (runner.mjs:32) / at async runJob (runner.mjs:123) / at async loop (runner.mjs:133)
      { status: 409, rejected: true }
  runnerProcs 1 -> 0
```

**后果(实测,逐条)**

```
v5                 = live      （服务端侧完全正确:线上确实是 v5,R5MARKB 在线上,drift=null)
执行器进程          = 已退出(exit 1),常驻轮询停止,无任何告警
下一次 POST /api/publish -> 200 v6,`/status` 回 activeVersion=6 / steps=0
                          （此时发布页按 steps.length===0 渲染「排队中——发布执行器尚未领取任务」,
                            publish.tsx:146-150;这一刻我只核了 API,没有再开一次浏览器)
                          实际是「上一次发布成功之后执行器自杀了」,运营看不出区别
不处理的话           15 分钟后锁 TTL 到期,v6 被自愈标 failed,理由写「发布中断(执行器无响应或超时)」
                     —— 归因指向 v6,而真凶是 v5 那次**成功**的发布
                     （自愈这一段我没有真等 15 分钟,而是在实验七里用拨快锁到期单独验过同一条路径;
                       此处按 [INFERRED] 记,置信 HIGH)
```

- **为什么这是 P1**:本轮加幂等,就是为了「让一次丢响应的重发不打死执行器」。它挡住的是 `gates ok`(在当前配置下**不会**丢响应),没挡住 `swap ok`(**唯一会**丢响应的)。修法打在了不出血的地方。
- **同族一并报**:任何 `failed` 回报的重发也是 409 `not-current-job`(守卫矩阵实测),即**门红这条最常走的路径**同样会打死常驻执行器。
- **单测也没覆盖**:`worker/test/publish.spec.ts:430-448` 的幂等用例只测 `materialize running/ok`,终态一条没有。
- **修法方向**:把「锁已经不在了、但这一步的结果与你要报的完全一致」也判成幂等(即在 `not-current-job` 之前先查 `publish_steps` 的既有结果),或者让执行器把「终态回报收到 409 且库里那一步已是同一结果」当成成功。
- **根因位置**:`worker/src/publish.ts:256`(锁校验排在幂等之前)`:281-284`(幂等只在锁仍在时可达)`:308` `:337` `:345`(三处终态删锁)· `worker/runner.mjs:34` `:39`(409=拒绝、不重试)`:88` `:96` `:108` `:120` `:123`(终态 report 无兜底)`:143-146`(异常即 exit 1)· `worker/wrangler.jsonc` 的 `assets.directory: "../dist-live"` 与 `runner.mjs:23-24` 那段已经过期的注释(它描述的重启触发点还是旧的 `dist`)。

### P1-2 🔴 上线印记的 `configSha` 核的是**构建输入**,不是**被搬运的产物**——一道门不跑 + 任意字节塞进 `dist`(含控制台产物)照样 live,而 `dirty=0 / drift=null / 红条全无`(r4 P1-3 **仍在**,只是覆盖面变宽)

本轮把摘要从「只哈希 `src/config/site.json`」扩到「三语 i18n + site.json」(`worker/src/publish.ts:89-100`、`worker/promote.mjs:128-146`)。这确实堵掉了 r4 报的那个**特例**(只改文案的版本摘要与上一版逐字节相同)。但两端算的都是**工作树里那四个源文件**,而**没有任何一处**把 `dist/**`(真正被搬上线的东西)与版本绑在一起。

**复现(照做即可;需要合法会话 + 能跑 promote 的机器 —— 按 PRD ④ 修订后的口径,这不属于「机器强制」那一半,故不计 P0)**

```
1. 改草稿(只改 FAQ 文案,标记 R5MARKC)              -> dirty=3
2. POST /api/publish                                  -> v10
3. POST /api/publish/next                             -> stamp
4. 四步全报 running/ok（**一道门都没跑**）
   其中 materialize 那一步我用**与执行器完全相同的物化器**把四个文件写进工作树(所以摘要一定对得上)
5. 往 dist/index.html 塞 R5UNGATEDBYTES
   往 dist/admin/index.html 塞 R5ADMINTAMPER          （控制台产物同样不在摘要里)
6. node promote.mjs --version 10 --stamp <stamp>
7. POST /step swap ok                                 -> **200**

结果(实测):
  versions               10:live  5:archived
  curl / 含 R5UNGATEDBYTES     -> True    （没过门的字节在线上)
  curl / 含 R5MARKC            -> False   （线上**不是** v10 声称的内容)
  curl /admin/ 含 R5ADMINTAMPER -> True   （线上控制台产物被换了,摘要根本没看这一块)
  GET /api/config    -> liveVersion=10, dirty=0, lastPublishFailed=null, drift=null
  GET /publish/status-> drift=null
  （壳状态条就是照这三个字段渲染的:shell.tsx:108-109 会显示「线上 v10 · 与线上一致」、无红条。
    这一刻我只核了 API,没有再开一次浏览器)
```

**附证(纯计算,不需要跑发布;基线 = 收尾时的线上 v21 payload,即初始种子,已在同一次运行里打印 `live = v21` 核实)**:用同一个物化器对同一份配置算两次摘要,一次原样、一次只改 Legal 正文:

```
原版 configSha       : 287778e71c87859295a02fd6057d187cc43cde1546ae546f6a771682d9feb154
只改 Legal 正文后    : 287778e71c87859295a02fd6057d187cc43cde1546ae546f6a771682d9feb154   ← 逐字节相同
对照(改一个文案 key): f1eaabc3fa2974bc21bf794bcc97d09069c70ec3621914c1a30f9a0f87b86100   ← 不同 ✓
```

即**Legal 正文这一整类改动,摘要对它零判别力**(因为它根本不进物化产物,见 P2-26)。

- **要说的不是「攻击者能怎样」**,而是**核验的语义边界没有变**:服务端核的仍然是「有人落了个文件,而且那个文件里的摘要跟这一版**应该物化成的四个源文件**对得上」。它**没有**核实线上快照的内容等于这一版。r4 给了两个修法方向(「整份物化产物的摘要」/「dist 的指纹」),实现取了前者的字面——而 r4 之所以并列两个,是因为**只有后者能封住这条**。
- **一个只覆盖了构建输入的「内容核验」比没有更糟**:代码注释里那句「它让人以为已经验过了」,原样适用于现在这一版。
- **修法方向**:印记里带 `dist` 的指纹(`promote.mjs:36-54` 的 `fingerprint()` 已经在算了,只是没写进印记),服务端标 live 时把它记进版本行;drift 与 `--check` 都能复用同一个数。
- **根因位置**:`worker/promote.mjs:129-146`(`writeStamp` 只读四个源文件)· `worker/src/publish.ts:89-100`(`expectedConfigSha` 同口径)`:324-325`(校验条件)。

### P1-3 🔴 `gate-config-consistency` 的「规则名认数字」是**假绿**:自检断言通过,而真事故形态照样放过

`--self-test` 里新增了一条 `self-test:带数字的规则名(h1-count)也要被双向断言看见`,实测 **11/11 全绿**。但它是这么造的(`worker/gate-config-consistency.mjs:133-134`):

```js
const numRule = VALIDATOR_TEXT.replace("rule: 'structure'", "rule: 'h1-count'");
say(check(...).some(([ok]) => !ok), 'self-test:带数字的规则名(h1-count)也要被双向断言看见');
```

它把 `structure` **换成**了 `h1-count`。门确实变红了——**但红的原因是 `structure` 从规则集里消失、于是 `RULE_LABEL` 里的 `structure` 变成了死键**(反向断言),跟 `h1-count` 能不能被看见毫无关系。扫规则的正则仍然是 `:78` 的 `/rule:\s*'([a-z-]+)'/g`,**不含数字**。

**红测(隔离副本 `git archive HEAD`,照做即可)**

```
# 事故形态:新增一条带数字的规则,不删任何现有规则,也不加大白话映射
printf "\nexport const __r5probe = { path: 'seo.title', rule: 'h1-count', message: 'r5' };\n" >> ../schema/src/validators.ts
node gate-config-consistency.mjs > /tmp/g1.txt 2>&1 ; echo $?   -> **0**（PASS)   ← 漏
grep -c "h1-count" /tmp/g1.txt                                  -> **0**          ← 门根本没看见它

# 对照:同样的事故形态,规则名不带数字
printf "\nexport const __r5probe2 = { path: 'seo.title', rule: 'brandnewrule', message: 'r5' };\n" >> ../schema/src/validators.ts
node gate-config-consistency.mjs ; echo $?                      -> **1**（FAIL)
   ✗ 校验规则 "brandnewrule" 在失败面有大白话映射
```

- **影响**:①r4 P2-10 **没有被修**,而现在多了一条自检在说它被修了;②这道门是 T22-4「映射表覆盖 13 门」的**唯一机器保障**,而它对整整一类命名(带数字)是瞎的——`:80` 的 labels 正则 `([a-z][a-z-]*)` 同样不认数字,两侧一起瞎;③更要紧的是**方法论**:一条「自检绿」现在是**假证据**,下一个人会信它。
- **修法方向**:两处正则改成 `[a-z0-9-]+`(labels 侧 `[a-z][a-z0-9-]*`);自检那一条改成**新增**而不是**替换**(`VALIDATOR_TEXT + "\nrule: 'h1-count'"`),否则它永远在测别的东西。
- **根因位置**:`worker/gate-config-consistency.mjs:78`(规则正则)`:80`(映射正则)`:133-134`(自检用替换而非新增,导致断言恒真)。

### P1-4 🔴 `cancelled` 终态有两个消费面没跟上:驾驶舱**直出枚举值**,版本列表给 cancelled 版本一个**永远点不动的回滚按钮**

本轮把取消从 `failed` 改成 `cancelled`(`worker/src/publish.ts:457`),同一轮又把回滚源收紧到 `live`/`archived`(`:165`)。两条各自都对,但下游没跟。

**(a) 驾驶舱把枚举值原样印在屏幕上**——真浏览器实测:

```
最近发布 v8:cancelled 发布页 →
```

`admin/src/pages/dashboard.tsx:305` 只映射了 `live`/`failed`,其余落到 `: d.health.lastPublish.status` 兜底,把数据库枚举直接渲染。违反项目不变量「页面文案禁止工程名词 / 字段名 / **枚举值**」。改成 `cancelled` 之前这条兜底永远走不到,所以是本轮新造的。

**(b) cancelled 版本行照样给「回滚到此版」,点了必失败且没有归因**——真浏览器实测:

```
版本历史表:v8 | 已取消 | 已取消(执行器未上线) | [回滚到此版]     ← 按钮在
点它 → 确认弹窗 → 填理由 → 确认
API:POST /api/publish {fromVersion:8,...} -> 404 {"error":"version-not-rollbackable(只能回滚到曾经上线过的版本)"}
界面:「发起失败,请重试」                                        ← 通用错,重试永远不会成功
```

`admin/src/pages/publish.tsx:295` 的判据是 `v.status !== 'live' && v.status !== 'failed'`——**白名单写成了黑名单**,`cancelled` 自然落进去。而 `:90` 的错误映射只认 `reason` / `in-progress` / `preflight` 三种字符串,`version-not-rollbackable` 落到兜底。实测版本历史里有 **4 个**回滚按钮,其中 **2 个**(v6、v8,都是 cancelled)是死控件。违反项目不变量「业务链必须有下一步 / **禁用原因**」。

- **修法方向**:(a) `STATUS_LABEL` 那张表在 `publish.tsx:23` 已经有 `cancelled: '已取消'`,驾驶舱应当共用它而不是自己写一套三元;(b) 回滚按钮的判据改成白名单 `['live','archived'].includes(v.status) && v.status !== 'live'`,与服务端 `:165` 同源;错误映射补 `not-rollbackable`。
- **根因位置**:`admin/src/pages/dashboard.tsx:304-305` · `admin/src/pages/publish.tsx:295` `:90`。

### P1-5 🔴 `cancelled` 一旦占住最大版本号,`/publish` 上的失败面**整块消失**,而壳顶红条还在四个页面上指人去那儿「看详情」

**复现(照做即可)**

```
前提:live = v5
1. 造一次门红:v7 failed（fail_reason 有,红条判据 id>live 满足)
   -> 壳顶红条出现:「上次发布失败(v7):文案里有合规禁用词(门:forbidden-words) … 去看详情」
2. 再发起一次并在排队态取消:v8 cancelled（占住最大号)
3. 真浏览器打开 /admin/publish

实测:
  壳顶红条        在（/ 、/publish、/audit、/content 四页都在)
  发布页失败面     **不在**（没有「上次发布失败(v7)…」块,也没有「查看原始日志」按钮)
  → 红条说「去看详情」,点过去没有详情

对照(把 cancelled 那一版拿掉,让 failed 占最大号):
  v9 failed 且为最大号 -> 发布页失败面在,「查看原始日志」按钮在,<pre> 能展开门的原文
```

- **根因**:`admin/src/pages/publish.tsx:194` 的条件是 `lastFailed.id === Math.max(...st.versions.map(v => v.id))`;而 `:120` 的 `lastFailed` 只找 `status==='failed'`。**在本轮之前,取消会写一行 `failed`,它自己就是最大号,所以这条判据从来不会露馅**;改成 `cancelled` 之后,任何一次取消都会把最大号让给一个非 failed 的行,失败面立刻消失。
- **影响**:CON02-E2 ⑥ 明写「状态条红条 → /publish → **定位到失败详情**」。现在这条链在「失败之后又取消过一次」的场景里断掉,而这个场景一点也不罕见(门红 → 想重发 → 执行器没起 → 取消)。
- **修法方向**:失败面的条件与服务端红条判据同源(`fail.id > live.id`),别用「是不是最大号」这个代理判据。
- **根因位置**:`admin/src/pages/publish.tsx:194` · `:120`。

### P1-6 🔴 强制中止只在数据库里「摘掉」执行器,并不停止它;而 README 又教运营中止后重新发起——V1 赖以成立的「单执行器」前提被这个功能自己打破

`POST /cancel {force:true}` 做的全部事情是:改版本行、收口步骤行、删锁(`worker/src/publish.ts:453-460`)。执行器进程完全不知情——它此刻正阻塞在 `spawnSync('npm run verify')` 里。实测进程树(真发布的 gates 期间):

```
node runner.mjs → npm run verify → node scripts/verify.mjs → chrome-headless-shell ×4
```

而 `worker/README.md:41` 写的是「在发布页点『强制中止』…**中止后重新发起即可**」。中止后立刻重新发起是可以的,实测:

```
cancel{force,reason} -> {"ok":true,"forced":true}     （v18 记 cancelled)
POST /api/publish     -> 200 v20
POST /api/publish/next-> {"job":{"versionId":20,...}}  ← 新单立刻可被领走
```

于是,**只要那个被「摘掉」的执行器其实还活着**(12 分钟阈值判的是「没动静」,不是「已死」;`gates` 恰恰是一步跑几百秒、期间一句话都不说的步骤),就会是:原执行器仍在跑它那一份 `npm run verify`(要写 `dist`),新执行器同时开跑另一份 `npm run verify`(也要写 `dist`),**两个进程在同一个工作树上互相覆盖构建产物**;新执行器的门跑在一个被别人并发重写的 `dist` 上,过了门之后再把它 promote 上线。这正是 P0-3 那一类「未过门字节上线」的形态。

(上面那三行实测是用**伪造的步骤上报**造出「失联 13 分钟」的,当时没有真执行器在跑;进程树那一行是另取的、真发布 gates 期间的快照。两半各自成立,合起来的那一幕见下面的证据边界。)

- **证据边界(如实标注)**:「强制中止不停止进程」「中止后新单立刻可被领走」两条**已实测**;「两份 verify 并发导致门在混合产物上判绿」我**没有真跑两份**(代价高且会污染工作树),按 `[INFERRED]` 记,置信 MED——依据是两个 `npm run verify` 都以 `astro build` 重写同一个 `dist` 开始,门随后从同一个 `dist` 读路由与产物。
- **plan 的挂账 ③ 说**「多执行器场景…V1 单执行器够用,**加执行器前必须先补**」——本轮新增的强制中止**就是**那个「加执行器」的入口,挂账的前提已经不成立。
- **修法方向**:中止时给执行器一个可观测的「你被摘了」信号(下次 `report` 之外还需要主动探测,或让执行器在每步开始前先确认自己仍持有 nonce);或者在锁里记 `claim_generation`,新单的物化步先拿工作树互斥锁。
- **根因位置**:`worker/src/publish.ts:422-463`(cancel 只动数据库)· `worker/runner.mjs:53`(阻塞式 `spawnSync`,期间不与服务端通信)· `worker/README.md:41`(操作指引)。

### P1-7 🔴 强制中止(= 执行器半路死掉,是**故障**)现在什么信号都不留:壳顶无红条、驾驶舱只有一行枚举值;而中止弹窗还写着「这一版记为失败」

本轮为了消掉「正常取消换来假红条」,把**两档取消**都写成了 `cancelled`。第二档(`force:true`)的语义完全不同——它是「执行器失联 12 分钟,我把这一版强杀了」,是一次真事故。实测:

```
cancel{force:true,reason:"太慢"} -> {"ok":true,"forced":true}
版本 v18 = **cancelled** :: 强制中止(执行器失联 14 分钟):太慢      （实测)
红条判据 = worker/src/config.ts:76  "WHERE status='failed' AND id > live.id"
  -> cancelled 永远不匹配,即强制中止**在构造上**不可能点亮壳顶红条
  （实测当时 lastPublishFailed 确实为 null;但那一刻 live=v10、既有 failed 版本 id 都 < 10,
    所以这条观测本身不能单独证明因果——因果由上面那行判据与「force 写 cancelled」两个实测事实给出)
驾驶舱          -> 「最近发布 v18:cancelled」（枚举值直出,见 P1-4a)
发布页          -> 无失败面(lastFailed 只找 status==='failed',publish.tsx:120)
```

而运营在点确认之前看到的原文是(`admin/src/pages/publish.tsx:162`):**「中止后这一版记为失败、线上保持不变,可以重新发起。」**——版本列表随后显示的是「已取消」。说的和做的不是一件事。

- **影响**:CON02-E2 的目的是「有一次失败还没被人处理掉,就一直提醒」。执行器崩在半路、被强杀,恰恰是最该留提醒的一种;现在它比一次普通门红还安静。
- **修法方向**:两档分开——排队态取消 = `cancelled`(不报警,当前行为对);强制中止 = 仍然是失败态(或新增 `aborted` 并让红条判据认它),并把弹窗文案与实际状态对齐。
- **根因位置**:`worker/src/publish.ts:452`(两档共用一个 `why`)`:457`(两档共用 `cancelled`)· `worker/src/config.ts:76`(红条只认 `failed`)· `admin/src/pages/publish.tsx:162`(文案)。

---

## 四、P2(逐条不合并)

1. **「去修复」只跳页面不定位字段**(**五轮同条**)。真浏览器取 href = `/admin/content/faq` ×4,内容页无 hash/query 承接。PRD ⑥ 要求「定位到红字段」。根因 `admin/src/pages/publish.tsx:35-45`。
2. **版本列表缺 PRD ⑤ 的「改动数」列,也缺 ⑥ 的行内「查看」→ 展开该版 diff 摘要**(**五轮同条**)。实景表头 `版本 / 时间 / 状态 / 理由 · 失败原因 / 操作`;`/api/config/versions` 只回列表字段,无 payload/diff 接口。
3. **版本号出现永久空洞,而列表标题写着「只增不删」**(r4 P2-3,**仍在**)。`config_versions.id` 是 `INTEGER PRIMARY KEY AUTOINCREMENT`(`migrations/0001_init.sql:6`),被并发拒绝的发起先 INSERT 再 DELETE(`publish.ts:187` / `:200`),号被永久消耗。实测:6 路并发后下一个版本号是 **v17**(v12–v16 消失);另一次 v18 → v20。运营看到 `v11 → v17` 只能理解成「有人删了历史版本」,而那恰恰是 PRD ④ 明令禁止的动作。建议:拿不到锁时先探锁再建行。
4. **`config.publish.live` 审计行的 `after_summary` / `reason` 仍恒 NULL**(r3 P2-7 → r4 P2-6,部分修)。实测 `#7 config.publish.live target=v3 before=v1 after=(空) reason=(空)`;`.failed` 现在有 after(大白话原因),`.cancel` 有理由。
5. **强制中止的理由只有前端在校验长度**(r4 P2-8,**仍在**)。实测 `POST /cancel {force:true, reason:"太慢"}`(**2 个字**)→ `{"ok":true,"forced":true}`,审计写「强制中止(执行器失联 14 分钟):太慢」。控制台要求 ≥4 字(`publish.tsx:107`),PRD CON14-③ 要求高敏动作 reason **≥8 字**,而 `POST /api/publish` 对回滚/高敏确实是服务端 ≥8。同一个仓三套口径,最松的在服务端。根因 `worker/src/publish.ts:449`。
6. **`GET /api/publish/status` 仍是带副作用的 GET,而且副作用比挂账里那几条重**(r4 P2-14,仍在)。它会 `UPDATE config_versions SET status='failed'`、`UPDATE publish_steps`、`DELETE FROM publish_lock`、写审计。本轮自愈实测确认这些副作用全在 GET 上。`/preflight`、`GET /api/config` 也在 GET 上写库(`ensureInit`)。
7. **UI 仍分不清「排队中」和「已被领取」**(r3 P2-14 → r4 P2-15,仍在)。`/status` 返回键实测为 `activeVersion, stepsOfVersion, steps, versions, stepNames, drift` —— **没有 `claimed_at`**(0006 迁移加的列),发布页仍靠 `st.steps.length === 0` 判队列态。实际窗口很小(执行器领单后毫秒级就报第一步),但「已领取」与「没人接」在界面上确实是同一句话。
8. **单步仍无心跳**(r3 P2-8 → r4 P2-16,机制未改)。锁只在 `running` 上报那一刻续期(`publish.ts:292`),`gates` 是不可分的一步,本轮实测 **334 s / 333 s**(另两次只轮询到 ≥241 s / ≥314 s 的中途值)。12 分钟阈值下余量约 6.5 分钟。
9. **`promote.mjs --check` 的解释文案在事故态下仍是错的**(r3 P2-15 → r4 P2-17,代码未动)。`worker/promote.mjs:67`:两者不同时一律打印「构建产物尚未提升上线,**这在门未通过时是正确状态**」,而 README:19 恰恰推荐用 `--check` 排查「线上快照对不对」。**本轮我只观测到它说对的那次**(v4 门红后 `dist 109` vs `dist-live 112`,那句话当时是正确的),没有单独构造事故态复现说错的那次;判据出自代码,该行没有任何分支。
   顺带一条本轮观察:`runner.mjs:119` 用 `stdio:'pipe'` 跑 promote,**它的输出全被吞掉**——包括「目录被占用,已改用就地同步(少了换名那一瞬的原子性)」这句降级说明。运营和步骤日志里都看不到这次切换到底是不是原子的。
10. **门红只报第一道门 + 原始日志只留最后 25 行**(**五轮同条,机制未改**),且 `config-consistency` 那个必踩实例仍在。实测该门一次输出 **49 行**,两条伺服目录断言固定落在第 **10–11** 行;`runner.mjs:71` 的 `slice(-25)` 之后 `grep -c 伺服目录` = **0**。也就是说:如果哪天有人把伺服目录改回 `dist`(P0-3 复活),运营在失败面「查看原始日志」里看到的 25 行里,那两条 `✗` 一条都不在。
11. **`.publish-stamp.json` 对公网匿名可读**(r3 P2-12 → r4 P2-19,仍在)。实测无 cookie `GET /.publish-stamp.json` → 200,回 `{"versionId":5,"stamp":"bd6bf673…","configSha":"44a42fc0…","at":…}`。**而且这枚口令是在它仍然有效的窗口里被公开的**:promote 先落盘、执行器才报 `swap ok`,这中间任何人都能读到当前 job 的 `claim_nonce`。当前所有 `/api/publish/*` 都在 `requireAuth` 之后,所以不跨权限边界;但「只有领单人知道的一次性口令」这个设计前提,在它最要紧的那一刻是不成立的。
12. **`gate-config-consistency` 仍读不懂合法 JSONC 的行尾 `//` 注释**(T23 挂账 ②,**五轮同条**;本轮已从「抛栈」改成「人话诊断」)。实测加 `"ENVIRONMENT": "dev",   // 上线改 production` → `✗ wrangler.jsonc 读不动(本门的 JSONC 剥注释不处理行尾 // 注释):SyntaxError…`,exit 1。失败关闭不算放过,诊断也到位了,但对改配置的人仍是一次「合法写法却红」。
13. **worker 单测的 verdict 随未纳入版本管理的构建产物而变**(r4 P2-13,**仍在**)。同一份 HEAD:`dist-live/.publish-stamp.json` **不存在**时 `npm test` = **102/102 passed**;**存在**时(即任何一次真发布之后的正常状态)= **101/102,1 failed**,失败的正是 `🔴 P1-3 线上快照与系统记录劈叉时,状态里必须报出来`(`test/publish.spec.ts:410`,用真 `env` 断言「初始种子 + 无印记 = 不报」,而真 `env` 读的是仓外的 `dist-live`)。
14. **版本列表硬截断且无分页/提示**(r4 P2-20,仍在)。`/status` `LIMIT 30`、`/api/config/versions` `LIMIT 50`,UI 无「更多」入口也无「已截断」标注。根因 `worker/src/publish.ts:397`、`worker/src/config.ts:221`。
15. **控制台登录前有 3 条 401 console error**(r3 P2-18 → r4 P2-22,仍在)。真浏览器实测:未登录访问 `/admin/` → 3 条 401;登录后四页 console error = **0**。
16. **`test-static.mjs` 的三处副作用型问题**(r4 P2-21,未动)。端口硬编码 `8788`;`spawn` 不带 `--persist-to`(用共享本地 D1);`killTree()` 在回读端口非 0 时 `Get-NetTCPConnection -LocalPort 8788 | Stop-Process -Force`,**无差别杀掉 8788 上任何进程**。本轮同样未跑(见第七节)。
17. **`reason` 从不做编码损坏校验**(r4 P2-9,仍在)。同一个仓为**配置文本**焊了 `encoding-damage` 校验器,实测它在**发布前置校验**这一关确实拦得住(草稿可存、发布不让过:`preflight ready=false / errors=1`,`POST /api/publish` → 409 `preflight-failed`);而运营手打的 `reason` 走的是另一条通道,**没有任何一关看它**——实测含 U+FFFD 的理由 200 落库并永久显示在版本列表与审计里。见第六节实验八。
18. **`ensureInit` 的半初始化恢复是静默的**(r4 P2-23,代码未动)。`worker/src/config.ts:36-45`:草稿行丢了就用线上内容重建、`draft_rev` 归 1,未发布的草稿改动就此消失,无审计无提示。
19. **正常发布过程中存在一个约 1 秒的 drift 误报窗口**(r4 P2-24,结构性)。`promote` 先落新印记、`swap ok` 后才翻 live,两者之间 `/status` 会算出 `drift ≠ null`;发布页 2 秒轮询一次。本轮 swap 步实测 1–2 秒,未命中。按 `[INFERRED]` 记。
20. **`syncInPlace()` 里有一个「新内容已就位、印记还没写」的窗口**(本轮修法的副作用)。`worker/promote.mjs:117` 先 `dropStamp` 再由 `:166` 补写新印记,窗口内 `/status` 会报 `drift={dbLive:N, snapshot:null}`。与第 19 条同族、同为秒级,但方向相反(这一条是**正确**地报出了一个瞬时不一致)。
21. **就地同步分支放弃了换名那一瞬的原子性**(plan 挂账 ①,仍在)。我**手工**跑 promote 的两次都打印「目录被占用(EBUSY),已改用就地同步」——服务运行时 wrangler 持有 `dist-live` 句柄,换名必失败,而那正是它唯一被用到的场合。执行器内部那四次的输出被 `stdio:'pipe'` 吞掉(见第 9 条),**未观测**,按同因推断走的也是就地同步分支,`[INFERRED]` 置信 HIGH。
22. **发布锁仍是单行 `publish_lock`,没有租约续期/抢占语义**(plan 挂账 ③,仍在),且本轮的强制中止把「多执行器」变成了可达状态(见 P1-6)。
23. **抢锁三段无事务**(r2 P2-13,本机仍无法复现)。`acquireLock`(`publish.ts:56-69`)是 SELECT → `batch(UPDATE+DELETE)` → INSERT 三段,段间无事务。6 路并发实测干净(1×200 + 5×409,零 500),但本机 D1 模拟器串行化,不等于生产 D1 上没有窗口。
24. **门链在本机会假红,而大白话映射会把原因说成另一回事**(本轮新发现)。v4 真发布在 `deck-clearance` 判红,门的原文是 `[deck] ✗ 1920/en:编舞未挂(decked 缺失)——桌面 fine-pointer 下不该缺`(一次**挂载失败**),而运营看到的大白话是「**设备叠卡的编舞几何侵入了左栏文字**」——描述的是另一条判据。同型改动另外三次真发布全绿。**归因不确定**(见〇-6:我并行跑了探针,不能排除是负载),但两件事都成立:①一道运行时门会因环境因素让一次 6 分钟的发布白跑,而失败面上没有任何「这可能是环境问题,重试一次」的线索;②`GATE_REASONS` 一门一句,对多判据的门必然会说错其中几种。
25. **drift 只比版本号不比内容**(r4 P1-4 的根因,**仍在**;它的 promote 那半已修)。实测:手工把 `dist-live/index.html` 改一个字节、印记原样不动 → 线上确实变了(`R5SNAPSHOTTAMPER=True`),而 `/status` 与 `/api/config` 的 `drift` **都是 null**。对照:删掉印记 → `{"dbLive":5,"snapshot":null}` ✓;印记指向 v99 → `{"dbLive":5,"snapshot":99}` ✓;手工 `node promote.mjs`(无参)→ 印记被抹掉 → 报 `snapshot:null` ✓(**r4 P1-4 的那个具体形态已消除**)。
26. **Legal 正文完全不进物化产物**(plan 已作为 T14 / 包⑫ 挂账,但**发布链对它零提示**)。`schema/src/materialize.ts` 不含 `legal`,`copy-manifest.json` 里只有一个 `legal.enPrevails`;而校验器 `validators.ts:43` 会遍历它、`diffPaths` 会把它计进 `dirty`、`:164` 还把它算作高敏。后果落在 T21/T22 的 AC 上:改一段 Legal 正文 → `dirty>0` → 走完整条 6 分钟门链 → 版本 live → `dirty=0` → 状态条说「与线上一致」,而公开页**字节不变**。CON13-A1 的「把全部草稿改动一次发布」对这一类是假的。**证据边界**:我实测的是「只改 Legal 的配置,物化产物摘要与原版逐字节相同」(实验三附证);由此可推站上产物不可能变。**我没有为 Legal 单独跑一次 6 分钟真发布**,该推断按 `[INFERRED]` 记,置信 HIGH。
27. **静态层转发的头里包含会话 Cookie**(本轮 P1-1 修法的副作用观察)。`assetRequest`(`worker/src/index.ts:90`)把原始 `Headers` 整个交给资产层,其中含 `nx_sid`。资产层是内部绑定,当前无实际危害;但「把会话 cookie 交给一个不需要它的下游」属于该滤没滤的问题。同理 `Host`、`Authorization` 若存在也会一并转。
28. **`HEAD` 被改写成 `GET` 交给资产层**(同上)。`assetRequest` 硬写 `method: 'GET'`,HEAD 请求因此在资产层被完整取一遍;响应体由运行时剥掉(实测 `curl -I` 返回 `200`、`size_download=0`、头齐全),**行为正确**,只是每个 HEAD 都做了一次全量读。
29. **`gate-canvas-geometry` 会复用「别的工作副本已经在跑的」astro preview**。`scripts/gate-canvas-geometry.mjs:82-95` 会嗅探 astro 的 `already running at http://…` 并把 `base` 换成那个地址,而 astro preview 是单例守护进程。若另一份 checkout 的 preview 正在跑(实测本机同时存在 `astro preview --port 4399` 与门自己起的 `--port 59941`),这道门可能对着**另一个仓的 dist** 做判定。属站侧门线、非本包改动,但它决定 T22-1「门跑在物化产物上」是否成立。**未复现跨 checkout 复用,按 `[INFERRED]` 记,置信 LOW-MED。**

---

## 五、前四轮报告逐条回归

### 第四轮(`...-recheck-r4.md`)的 7×P1

| r4 条目 | 本轮结论 | 证据 |
|---|---|---|
| **P1-1** 静态层裸 GET 丢 If-None-Match / Range | **304 已恢复;Range 的判断需要更正** | `If-None-Match` → **304 / 0 字节**(`/index.html` 与 `/admin/*` 深链回退都对)。**Range 仍是 200 全量**,但响应里**根本没有 `Accept-Ranges`** —— 即本机资产绑定不实现 Range,与转不转发请求头无关。r4 那条里「Range 应为 206」的部分**判据不成立**(它当时也未验证改动前是 206);「304 被封死」的部分**已消除**。新增观察见 P2-27 / P2-28 |
| **P1-2** 重发的回报打死执行器(第三次组合故障) | **只修了一半 → 变形为本轮 P1-1** | `materialize/gates/build` 的 `ok` 与重复 `running` 现在幂等 200(实测);**终态回报(任何 `failed`、`swap ok`)的重发仍是 409 `not-current-job`,仍然打死执行器**,而 wrangler 重启窗口恰好只落在 `swap ok` 上(实测日志) |
| **P1-3** configSha 只覆盖 site.json | **覆盖面已扩,根因未动 → 本轮 P1-2** | 摘要现覆盖三语 i18n + site.json(实测「只改文案」会改变摘要);**但仍只核构建输入**:零门 + 塞字节进 dist 与 dist/admin,照样 live 且全绿 |
| **P1-4** drift 的构造性假阴性(promote 保住旧印记) | **该形态已消除;根因(只比版本号)仍在 → 本轮 P2-25** | 手工 `node promote.mjs` 现在抹掉印记 → drift 正确报 `snapshot:null`;**但直接改快照内容、印记不动 → drift 仍为 null** |
| **P1-5** 排队态取消造假红条 | **已消除,但换来三条新伤** | 实测取消后 `lastPublishFailed=null`、四页无红条 ✓。新伤:驾驶舱直出 `cancelled`(P1-4a)、cancelled 版本给死回滚按钮(P1-4b)、cancelled 占最大号使失败面消失(P1-5)、强制中止不再留任何信号(P1-7) |
| **P1-6** drift 只在 /publish 页 + 红条教人做做不到的事 | **已消除** | `/api/config` 现在也回 `drift`(实测两处一致),`admin/src/shell.tsx:89-97` 有壳顶渲染块;发布页给「重新发布 v{N} 以对齐」按钮,回滚源判据放行 `live`,该按钮可用 |
| **P1-7** 失联阈值 8/12 分钟三处不一致 | **已消除** | 全仓 `8 分钟` 只剩 `publish.ts:409` 的历史注释;服务端 hint、`admin/src/pages/publish.tsx:156`、`README.md:41` 一律 12 分钟;实测 hint 原文「执行器已超过 12 分钟没有动静…」 |

### 第四轮的 24×P2

| r4 条目 | 本轮结论 |
|---|---|
| P2-1 「去修复」只跳页面 | **仍在**(本轮 P2-1,五轮同条) |
| P2-2 版本列表缺改动数 / 缺「查看」 | **仍在**(本轮 P2-2,五轮同条) |
| P2-3 版本号空洞 | **仍在**(本轮 P2-3,已定位为 `AUTOINCREMENT` + INSERT/DELETE) |
| P2-4 被拒的发起零痕迹 | **已消除**:每次被拒都写 `config.publish.rejected`(实测 5 条) |
| P2-5 自愈标 failed 不写审计 + 步骤停 running | **已消除**:实测自愈写 `config.publish.failed` 审计,并把 running 步骤收口为 failed |
| P2-6 终止类审计行缺理由 / 摘要 | **仍是部分修**(本轮 P2-4:`.live` 的 after/reason 仍空) |
| P2-7 回滚源不限状态 | **已消除**:`failed` / `cancelled` 源一律 404 `version-not-rollbackable`(实测两向) |
| P2-8 强制中止理由只有前端校验 | **仍在**(本轮 P2-5,实测 2 字通过) |
| P2-9 reason 不做编码损坏校验 | **仍在**(本轮 P2-17) |
| P2-10 规则名正则不认数字 | **仍在,且新增一条假绿自检 → 升为本轮 P1-3** |
| P2-11 junction 绕过伺服目录断言 | **已消除**:真建 junction → exit 1 |
| P2-12 JSONC 行尾注释让门崩 | **崩已消除(改人话诊断);读不懂仍在**(本轮 P2-12) |
| P2-13 单测随 dist-live 残留翻红 | **仍在**(102/102 vs 101/102) |
| P2-14 `/status` 是带副作用的 GET | **仍在**(本轮 P2-6,且自愈副作用本轮实测) |
| P2-15 UI 分不清排队/已领取 | **仍在**(本轮 P2-7,`/status` 仍无 `claimed_at`) |
| P2-16 单步无心跳 | **仍在**(本轮 P2-8) |
| P2-17 `promote --check` 事故态文案 | **仍在**(本轮 P2-9) |
| P2-18 门红只报第一道门 + 25 行日志 | **仍在**(本轮 P2-10,`config-consistency` 必踩实例已量化:49 行 / ✗ 在第 10–11 行 / 尾 25 行命中 0) |
| P2-19 `.publish-stamp.json` 匿名可读 | **仍在**(本轮 P2-11) |
| P2-20 版本列表硬截断无分页 | **仍在**(本轮 P2-14) |
| P2-21 `test-static.mjs` 三处副作用 | **仍在**(本轮 P2-16,未跑) |
| P2-22 登录前 3 条 401 | **仍在**(本轮 P2-15,实测 3 条) |
| P2-23 `ensureInit` 静默重建草稿 | **仍在**(本轮 P2-18,代码未动) |
| P2-24 drift 1 秒误报窗口 | **仍在**(本轮 P2-19),并发现同族的第二个窗口(本轮 P2-20) |

### 第三轮 / 第二轮 / 第一轮里已判「已消除」的各条(本轮抽验)

- **r3-P1-1**(假红条清不掉):**仍消除**,并发拒绝零版本行 + 取消不写 failed。
- **r3-P1-2**(强制中止只有 API 没按钮):**仍消除**,真浏览器全流程走通。
- **r3-P1-5**(焊的门不在链上):**判定沿用 r4,本轮未重跑那条真发布红测**。代码上它挂在 13 门之后(`runner.mjs:63-70`,`code===0` 才跑);r4 已用一次真发布证明注入无映射规则会让 gates 步变红。本轮我只在隔离副本上验了这道门本身的红绿两向(实验九),**成功路径不留日志,所以「它这四次真发布里确实被执行了」我没有独立证据**;重跑一次红测需要一次 6 分钟真发布,未做。
- **r3-P1-6**(带 body 的非 GET 打死 worker):**仍消除**,405 收口在 `index.ts:95-97`;本轮 40+ 条路由探测里含 PUT/PATCH/DELETE,worker 全程存活。
- **r2-P0-A**(合法顺序 8 次请求即可 live):**仍消除**,重跑同序列 → `live-verification-failed`。
- **r2-P1-B**(两个执行器领到同一单):**仍消除**,6 路并发 `/next` 只有 1 路拿到 job。
- **r2-P2-1**(`running` 可对已 ok 的步骤重复上报并续锁):**已消除**,实测 409 `step-already-started {at:"ok"}`。
- **r1-P0-2**(过期锁照收):**仍消除**,过期后上报 → `not-current-job`。
- **r1-P0-3**(线上直伺服 `dist`):**仍消除**,门红期间 `dist`(109 文件)与 `dist-live`(112 文件)指纹分离、线上采样唯一指纹;并且有一道**真跑且红测过**的门守着(伺服目录断言 7+1 组变异全红)。
- **r1-P1-1**(门红后控制台 404):**仍消除**,门红期间 `/admin/` 200。
- **r1-P1-2**(失败态取不回日志):**仍消除**,真浏览器展开 `<pre>` 见门原文。

---

## 六、关键实验留档

### 实验一 · 真成功发布(v3)
```
materialize 0s / gates 334s / build 3s / swap 1s
门跑期间 12 次采样:唯一指纹 740D0A85BA,R5MARKA 命中 0（线上未被提前污染)
完成后:线上 R5MARKA=True;versions 3:live 1:archived;drift=null;lastPublishFailed=null
/.publish-stamp.json 匿名 200 {"versionId":3,"stamp":"6a31b313…","configSha":"62b117a6…"}
promote --check:dist 112 / dfc3f757216023f0 ≡ dist-live
```

### 实验二 · 第四次组合故障:一次**成功**的发布打死执行器(P1-1 本体)
```
代理:node dropproxy.mjs 8817 8811 swap:ok（转发→拿到真响应→掐断连接)
执行器:常驻模式(无 --once),--api 指向 8817
[proxy] step swap/ok v5
[proxy] 🔴 已把 swap/ok 转发到服务端(服务端回 200 …),现在掐断连接不回复
[proxy] step swap/ok v5            ← 重试
[proxy] step swap/failed v5        ← catch 里再报
执行器异常: Error: /api/publish/step → 409 {"error":"not-current-job"}
    at api (runner.mjs:32) / runJob (runner.mjs:123) / loop (runner.mjs:133) {status:409, rejected:true}
runnerProcs 1 -> 0
善后:v5 live（线上 R5MARKB=True,drift=null,一切正常);下一次发布 v6 永远「排队中」
另证(wrangler 日志):swap running 与 swap ok 之间必有一次 ⎔ Reloading local server...
```

### 实验三 · 零门上线 + 未过门字节 + 未过门的控制台产物(P1-2 本体)
```
v10:四步全报 running/ok（零门) + 用同一物化器写好四个源文件 + 往 dist 塞 R5UNGATEDBYTES、
     往 dist/admin 塞 R5ADMINTAMPER + node promote.mjs --version 10 --stamp <nonce>
-> swap ok **200**,v10 live
curl /          含 R5UNGATEDBYTES = True    （没过门的字节在线上)
curl /          含 R5MARKC        = False   （v10 声称的内容不在线上)
curl /admin/    含 R5ADMINTAMPER  = True    （线上控制台被换了)
GET /api/config -> liveVersion=10 dirty=0 lastPublishFailed=null drift=null
```

### 实验四 · 门红(deck-clearance,315 s)
```
v4 gates failed -> 设备叠卡的编舞几何侵入了左栏文字(门:deck-clearance)
门原文:[deck] ✗ 1920/en:编舞未挂(decked 缺失)——桌面 fine-pointer 下不该缺 / [verify] 12/13 gates pass
线上:R5MARKA=True R5MARKB=False（旧版原样);印记仍是 v3
promote --check:dist 109 / 47a93e179227a4de  vs  dist-live 112 / dfc3f757216023f0（两目录分离)
草稿:dirty 仍为 3,改动原样保留
```

### 实验五 · drift 四种形态
```
A 印记缺失            -> /status 与 /api/config 均报 {"dbLive":5,"snapshot":null}   ✓
B 印记指向 v99        -> 均报 {"dbLive":5,"snapshot":99}                            ✓
C 内容被改、印记原样   -> 线上 R5SNAPSHOTTAMPER=True,而 drift **null**              ✗（P2-25)
D 手工 node promote.mjs -> 印记被抹掉,drift 报 snapshot:null                        ✓（r4 P1-4 该形态已消除)
```

### 实验六 · 回滚(v21 ← v1 初始种子)
```
参数校验:无理由 / 3 字理由 -> 400 reason-required ; fromVersion 9999 -> 404 ;
         fromVersion=cancelled(v8) / failed(v7) -> 404 version-not-rollbackable
四步:materialize 0s / gates **333s** / build 3s / swap 1s
内容核验:线上标记 R5MARKA / R5MARKB / R5MARKC / R5MARKE / R5MARKF / R5MARKH /
         R5UNGATEDBYTES / R5SNAPSHOTTAMPER 与控制台里的 R5ADMINTAMPER **全部 False**
         —— 一次真发布把我塞进快照的未过门字节整个洗掉了
versions 21:live ; drift=null ; 印记 {"versionId":21,"configSha":"287778e7…"}
收尾复跑:gate:equivalence **5 判全绿** / gate:beacon ✓ / gate:config PASS
```

### 实验七 · 读时自愈(T21-6)
```
v22 报到 gates running -> 把 publish_lock.expires_at 拨到 1 -> GET /status
-> v22 status=failed,fail_reason=「发布中断(执行器无响应或超时),线上保持旧版」
-> publish_steps: materialize=ok, gates=**failed**（收口了,r4 P2-5 已消除)
-> audit 多一行 config.publish.failed v22（r4 P2-5 已消除)
-> 旧口令再上报 -> 409 not-current-job ; 随后可正常重新发起
```

### 实验八 · reason 的编码与长度
```
POST /cancel {force:true, reason:"太慢"}（2 个字)            -> {"ok":true,"forced":true}   （服务端无长度校验)
POST /api/publish {fromVersion:1, reason:"R5 <U+FFFD> 损坏字符理由测试"} -> 200
  版本列表里存下来的理由 = 「R5 � 损坏字符理由测试」                （原样落库并永久显示)

对照(同一个 U+FFFD 放进**草稿文案**):
  PUT /api/config/draft   -> **200**（草稿层不拦,与占位符那条不同档)
  GET /preflight          -> ready=false, errors=1
     [encoding-damage] faq.q1.a.en :: 文本含编码损坏字符(位置 3 附近:「R5 � damage」)…
  POST /api/publish       -> 409 preflight-failed                 （配置文本这条通道守得住)
=> 结论:配置文本有 encoding-damage 在**发布前置校验**这一关守着;运营手打的 reason 一关都没有。
```

### 实验九 · 门红测(隔离副本 `git archive HEAD`)
```
gate-config-consistency --self-test                       11/11 ✓
assets.directory 文本变异 7 组                             全部 exit 1 ✓
dist-live 做成指向 dist 的 junction(真建链接)              exit 1 ✓（r4 P2-11 已消除)
wrangler.jsonc 加合法行尾 // 注释                          exit 1 + 人话诊断 ✓（不再抛栈)
新增 rule: 'brandnewrule'(不删任何规则,无映射)             exit 1 ✓
新增 rule: 'h1-count'(不删任何规则,无映射)                 **exit 0 ✗ 漏**（P1-3)
config-consistency 输出 49 行,伺服目录两条断言固定在第 10–11 行;tail -25 里命中 0（P2-10)
npm test:  dist-live 无印记 = **102/102 passed(9 files)** ✓ ;  有印记 = **101/102,1 failed**
           （失败的是 test/publish.spec.ts:410「初始种子 + 无印记 = 不报」)（P2-13)
tsc --noEmit 0 错 ; gate:equivalence 5 判 ✓ ; gate:beacon ✓ ; gate:config PASS ;
npm run test:red-d1 -> **exit 1**（红测按预期非零退出;它的输出是「no tests」而非「测试因缺 D1 而红」,属 T3 范畴)
```

---

## 七、没能验到的 AC(不静默略过)

1. **CON16-AC4 schema 版本漂移拒绝面**。全仓 `SCHEMA_VERSION` 仍只有定义处与写产物处两个消费点,发布链无一处读它做拒绝。plan 已按证伪结论把它挪进 T23。**本轮无可验之物,不作 PASS/FAIL,记为未接线。**
2. **Phase C(CI 执行器)同契约**。只验了 V1-dev 本机 runner;CI 版不存在。
3. **真实 Cloudflare 环境下的原子切换与印记可达性**。四次真发布中 promote **每次**都走了「就地同步」降级分支(EBUSY);换名分支本轮只在收尾停服后验过一次。云端原子性仍依赖平台,未验。
4. **`test-static.mjs`(37 路由字节级)**。端口硬编码 8788 在禁占清单里,且它会用共享 D1 并可能杀掉 8788 上任何进程(P2-16)。文件在冻结区不能改。**本轮未跑。**
5. **P1-6 的后半段(两份 `npm run verify` 并发在同一工作树上,门在混合产物上判绿)**。「强制中止不停止进程」与「中止后新单立刻可被领走」已实测;真跑两份 verify 会污染工作树且代价约 12 分钟,**未做**,该半按 `[INFERRED]` 记。
6. **多执行器真并跑**(两个 runner 各跑完整门链)未做,原因同上。
7. **P2-29(canvas-geometry 复用别的 checkout 的 preview)未复现**。只从代码路径与进程快照推断,`[INFERRED]`,置信 LOW-MED。
8. **抢锁三段无事务**(r2 P2-13)在本机 D1 模拟器上仍无法复现。
9. **版本历史 >30 条的截断表现**未实测(机制已从代码确认,见 P2-14);**窄窗(<1024px)导航折叠**不在 T21/T22 AC 文字内,未测。
10. **P2-24 的归因**:`deck-clearance` 那次门红我不能证明与我的并行负载无关,只能证明「同型改动三绿一红」与「门原文说的是挂载失败、大白话说的是几何侵入」。
11. **`gate-config-consistency` 在真发布链上的红测本轮未重跑**(需要一次 6 分钟真发布 + 一次源码注入)。我只在隔离副本上验了这道门本身的红绿两向;它「在链上」这一条沿用 r4 的实测结论,本轮无独立证据(成功路径不留日志)。
12. **P1-2 那条路径在真 Cloudflare 上的形态**未验。云端 `promote.mjs` 不参与部署(资产随 Worker 部署),印记怎么落、谁来落,Phase C 才定;本轮结论只覆盖 V1-dev 本机形态。
13. **v4 / v5 两次真发布 gates 步的收尾秒数**没记到(只轮询到中途值)。这不影响任何结论,但第八节以外凡引用「门耗时」的地方,我只用 v3 = 334 s 与 v21 = 333 s 两个实测值。

---

## 八、收尾状态

- **冻结纪律**:`git status --short` 收尾输出 **只有 `?? docs/changes/2026-09-01-website-admin-t21t22-recheck-r5.md` 一行** —— `worker/src`、`worker/*.mjs`、`worker/wrangler.jsonc`、`worker/migrations`、`admin/src` 全程零写入。门红测全部发生在 scratchpad 里 `git archive HEAD` 出来的隔离副本上(那份副本里对 `schema/src/validators.ts` / `wrangler.jsonc` 的注入均已还原并复跑基线绿)。
- **工作树**:执行器物化写过的 `src/i18n/{en,vi,zh}.json` 与 `src/config/site.json`,在最后那次**真回滚到 v1(初始种子)**之后 `git diff` 为空(`git status` 一度显示 M,是 **CRLF/LF 行尾**造成的,内容逐字节相同),我随后 `git checkout -- src/` 把行尾也还原。`gate:equivalence` **5 判全绿**(三份 i18n 逐字节 + site.json ≡ 物化 + 落盘种子深等),即 CON16-A2 等价性基线成立。**本报告是仓内唯一新增文件。**
- **`dist` / `dist-live` 的最终状态**:两者都是**回滚到初始种子那次真发布的产物**,各 **112 文件、指纹同为 `aaebf88ce53b17b4`** —— 与我**开工时回读到的指纹逐字相同**;`promote --check` 报「✓ 线上快照与构建产物一致」。我实验期间塞进去的 `R5UNGATEDBYTES` / `R5ADMINTAMPER` / `R5SNAPSHOTTAMPER` / `R5MARK*` 在两个目录里**逐个 grep 命中 0**。
- 🔴 **`dist-live/.publish-stamp.json` 我留成了「不存在」**(移到了 scratchpad,未硬删),与开工时看到的状态一致。两条理由:① P2-13 那条环境耦合仍在,留着印记会让下一位跑 `npm test` 得到 **101/102** 而不是 **102/102**;② 下一位起服时是一个全新 D1(live = 初始种子、`created_by='system'`),此时**没有印记**正好命中 drift 的全新环境豁免、不报警,而**留着一个 `versionId:21` 的印记**反而会让他一开机就看到 `drift={dbLive:1,snapshot:21}` 的红条。**这条状态是我人为选的,不是产品行为,特此写明。**
- **数据**:本轮造出的 24 个版本号、49 条审计行、发布锁全部关在自建的 `worker/.wrangler-r5`;第二个实例(P0 表复测)的 6 个版本关在 `worker/.wrangler-r5b`。**两个目录都已 Move 出仓**(到 scratchpad `wrangler-r5-moved` / `wrangler-r5b-moved`,未硬删),`worker/` 下不留残留(`Test-Path` 两者均 False)。
- 🔴 **一处如实交底(与上一轮的说法不同)**:`--persist-to` **只改 D1/KV 的落盘位置,不改 wrangler 自己的构建临时目录**。收尾回读 `worker/.wrangler/` 时,`tmp/dev-*` 与 `tmp/bundle-*` 的时间戳是 **06:01**、`state/v3/{cache,d1,kv,observability}` 是 **05:53**,都落在我起服的时间窗内。我没有对共享库做过任何写入意图(所有 D1 命令都带 `--persist-to .wrangler-r5`),`npm test` 走的是 vitest-pool-workers 自己的存储(时间戳早于我三次跑测试的 06:35–06:50),**但我无法证明 `worker/.wrangler` 内容零变化,所以不声称「全程未触碰」**。它本来就是可删即重置的缓存目录。
- **进程与端口**:wrangler / runner / 代理进程按 PowerShell `Stop-Process` 杀净并回读:`node.exe` 中含 `wrangler|runner.mjs|dropproxy` 的 **0 个**、`workerd` **0 个**;8811 / 8813 / 8817 / 4407 / 5187 与全部禁占端口(8787/8788/8791/8793/8797/8799/8801/8803/8809/4321/4401/4403/4405/5174/5175/5181/5183/5185)监听数**全部为 0**。别的会话的 **4399 / 3002 / 5173** 全程未碰,收尾回读三者仍各 1 个监听。
