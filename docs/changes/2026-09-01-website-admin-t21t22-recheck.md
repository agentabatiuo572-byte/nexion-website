# T21/T22 发布流水线 复测验收报告(黑盒 · 独立验收方 · 2026-09-01 第二轮)

**判决 = 不可签字。**

- **验收对象**:PRD `NexGrid_官网后台PRD_v1.0.md` [FEAT-CON13] 全部 + CON02-E2(plan 第 90 行明写移交本包);plan `2026-08-31-website-admin.plan.md` T21 / T22 两节
- **被测版本**:`D:\WORKS\PLAN\.wt\w-console`,分支 `pkg/w-publish`,HEAD `e037c00`。
  ⚠️ 验收期间**别的会话在同一工作树上推进了三个 docs-only 提交**,HEAD 已走到 `3f6dc9b`。已复核:
  `git diff --stat e037c00 3f6dc9b -- worker/src worker/*.mjs worker/wrangler.jsonc admin/src schema/src scripts/` **输出为空**,
  即被测代码逐字节未变,本报告的结论对两个 SHA 同样成立。
- **环境**:worker `http://127.0.0.1:8791`(端口按分配),隔离状态目录 `worker/.wrangler-t21r2`;控制台经 worker 同域 `/admin`;真浏览器用 Playwright
- **执行量**:4 次真发布(每次 gates 都真跑满,单次 336–364 s)、6 组 API 攻击用例共 90 余次请求(路由审计 30 次 / 未认证 7 次 / 步骤序列 40 余次 / 并发·取消·回滚若干)、687 条站上实况探针采样、3 道被改动的门各做红绿两向注入、worker 单测 82/82(隔离副本)
- **一句话**:上一轮 3 条 P0 里 **2 条真消除**(过期锁、门跑期间线上被换),**1 条变形后仍然成立**(零门上线的请求序列从 2 条变成 8 条,而伪造出的痕迹现在与真发布完全同形);另有 4 条 P1 —— P1-A 是这一轮两条修法**合起来新造**的、P1-C 是这一轮修法**没焊门**留下的、P1-B 是上一轮 P1-3 只修了一半、P1-D 是本包 AC 从头就没做 —— 以及 13 条 P2。

---

## 〇、起服与环境偏差(先交底)

- 分配端口 8791 可用,未换端口。静态预览 4401 / 控制台 vite 5181 本轮未起(控制台经 worker 同域伺服,无须另起 vite)。8787 / 8788 / 4321 / 4399 / 3002 / 5173 / 5174 / 5175 全程零占用。
- **一处与派单口径的偏差,如实说明**:起服没有用 `npm run dev`,而是拆成
  `npx wrangler d1 migrations apply nexgrid_site --local --persist-to .wrangler-t21r2` +
  `npx wrangler dev --port 8791 --persist-to .wrangler-t21r2`。
  原因:npm 会把 `-- --port` 追加到整条复合命令**末尾**,`--persist-to` 只能落到 `wrangler dev` 上、落不到前半段的迁移命令上,两边就会用两个不同的本地库。派单禁止直接 `npx wrangler dev` 的**理由是「会跳过 D1 迁移」**,我把迁移显式跑在同一个 persist 目录上,理由已被满足(迁移 0001–0005 全部 ✅,见下)。收益是本轮造出的 41 个版本、上百条审计行全部关在 `.wrangler-t21r2` 里,不污染别的会话共用的 `worker/.wrangler`;收尾时整个目录 Move 出仓即清零。
- 三道门的红测跑在 `git archive HEAD` 出来的隔离副本(scratchpad 内,`node_modules` 用 junction 借用),因为红测必须改被守文件,而被测树在冻结期。`test-static.mjs` 在隔离副本里把内置端口 8788 改成 **8793**(我的备用配额),避免撞别的会话。

---

## 一、逐 AC 结论

### T21 · 发布编排

| # | AC(plan 原文口径) | 结论 | 证据 |
|---|---|---|---|
| T21-1 | 前置校验红 → 不进流水线并逐项列出 | **PASS** | 草稿同时注入禁用词 / 缺译 / U+FFFD:`PUT /api/config/draft` 200(可存),`GET /api/publish/preflight` → `ready:false` + 4 条 errors(`forbidden-word`×2 / `encoding-damage` / `untranslated`),`POST /api/publish` → **409 `preflight-failed`**,且**零新版本行、零锁**(最新版本仍是 v12 live) |
| T21-2 | 去修复定位 | **FAIL(P2-5)** | 红项每行有「去修复」按钮 ✅,但 `fixLink()` 只返回裸路径(`/content` 等),内容页无 hash/query 承接 → PRD ⑥「定位到**红字段**」未实现(上一轮同条,仍在) |
| T21-3 | 红项自动排除保留草稿 | **PASS(按 PRD 口径)** | 前置校验红时草稿原样在库(`draftRev` 继续递增,内容不丢);门红后(v11)草稿里的超长标题原样保留,可直接改回再发。口径说明:plan 这句「红项自动排除」字面上可读成「把红项摘出去、其余照发」,与 PRD E1「**不进流水线**」冲突;实现按 PRD 走(整次拦下),我按 PRD 判 PASS,但这句 AC 措辞建议改齐 |
| T21-4 | 状态机单向且 server 权威 | **FAIL(P0-A)** | 畸形序列全被挡:跳步 409 `step-out-of-order`(带 `missing` 列表)、未报 running 就收口 409 `step-not-running`、重复收口 409 `step-already-done`、冒名 versionId 409 `not-current-job`、非法 step / status 400 ✅。**但按顺序把四步各编一遍(8 次请求)即可把版本推成 `live`,一道门没跑** |
| T21-5 | 并发发布 409 | **PASS(带 P2)** | 发布进行中再发 → 409 `publish-in-progress` + `heldBy`;20 轮 `POST /api/publish` 与 3 路 `/status` 并发,零错配。被拒的那一次仍会留下 `failed` 版本行且无审计行(P2-2) |
| T21-6 | 锁 TTL 15 分钟超时自动 failed | **PASS** | 锁拨到过期后 `GET /api/publish/status` 把版本标 `failed`(`发布中断(执行器无响应或超时),线上保持旧版`)并清锁;`/step`、`/next` 同判据 |
| T21-7 | 执行器不在线 → 排队态可取消 | **PASS(执行器真不在线时)** / **FAIL(执行器崩在半路时,P1-A)** | 真浏览器实景(v41,不起执行器):进度卡「正在发布 v41」+ 四步全「等待」+ 排队提示 +「取消本次发布」按钮(count=1),点击后发布被取消、console error 0 ✅;API 侧零步骤时 cancel 200 ✅。但一旦有过任何步骤(执行器开工后崩溃),cancel 409、`/next` 不再派发、再发起 409,**只能干等 15 分钟** |
| T21-8 | 不存在绕门发布 API(路由审计) | **FAIL(P0-A)** | 15 条猜测路由 GET/POST 全 404 ✅;7 个发布入口未认证全 401 ✅;审计 4 种变更方法全 404、版本行 DELETE/PATCH/PUT 全 404 ✅。**但 `/api/publish/step` 本身就是那条 API** |

### T22 · 执行器 + 失败面 + 版本/回滚

| # | AC | 结论 | 证据 |
|---|---|---|---|
| T22-1 | 执行器按 §5.4 领任务 → 物化 → 全门 → build → 上新 → 回报 | **PASS** | v12 实跑:materialize 0.077 s / gates **363.7 s** / build 4.3 s / swap 0.6 s,四步全 ok,版本 live、旧 live 归档 |
| T22-2 | 任一门红 → failed + **线上保旧版(实测站产物未变)** | **PASS** | v11 注入超长标题 → `render-fit` 红。**运行时 A/B(111 次采样,17:11:31–17:19:00)**:`dist/index.html` 指纹从 `740d0a85ba` 变到 `ae7bd4433a`(未过门的产物真的被构建出来了),而**站上首页响应体指纹全程恒为 `740d0a85ba` = `dist-live`**,标记词 `RECHECKR2FAIL` 全程 0 命中;门判红后首页仍是旧内容。**上一轮 P0-3 已消除** |
| T22-3 | 失败面 = 门名 + 大白话 + 原始日志折叠 | **PASS(带 P2-9)** | 真浏览器实景:红条「上次发布失败(v11):新文案把版面挤破了(…)(门:render-fit)」+「查看原始日志」按钮渲染并可展开,`<pre>` 里是 verify 尾部 25 行,含 `[verify] ✗ render-fit(运行时)` 与修法提示;console error = 0。**上一轮 P1-2 已消除**。遗留:只报第一道红门 + 只留 25 行的机制未改(P2-9) |
| T22-4 | 映射表覆盖 13 门,缺项显门名原文 | **PASS** | `GATE_REASONS` 13 个键与 `scripts/verify.mjs` 实际 13 门逐一对齐,零缺项;`explainGate` 兜底显原文 |
| T22-5 | 版本列表 append-only | **PASS(带 P2-2/P2-6)** | 无任何删改版本的路由(3 种方法全 404);版本号只增。噪声:11 行里 9 行是被拒/被中断留下的 failed 行;列表缺 PRD ⑤ 要求的「改动数」列与 ⑥ 的「查看」入口(P2-6) |
| T22-6 | 回滚走完整门链生成新版本(实测站产物=旧内容) | **PASS** | `POST /api/publish {fromVersion:1}` → 新版本 **v39**(v1 仍 `archived`,未被复活),四步齐全(gates 336.2 s),swap 那一拍站上响应体从 `a08d39747c` 变回 `740d0a85ba`,`RECHECKR2OK` 从站上消失(0 命中),旧文案回归;理由 <8 字 / 无理由均 400 `reason-required`;不存在的版本号 404 |
| T22-7 | 审计 | **PASS(带 P2-3/P2-11)** | `config.publish` / `.live` / `.failed` / `.cancel` / `config.rollback` 各有行,理由挂在发起行。缺口:自愈标 failed 不写审计(P2-3)、终止类行不带理由(P2-11) |

### 移交进本包的 AC

| # | AC | 结论 | 证据 |
|---|---|---|---|
| CON02-E2 | 上次发布 failed → **进入任意页**状态条红条「上次发布失败:{大白话}」,点击 → /publish | **FAIL(P1-D)** | v11 门红后进控制台,状态条只有「线上 v2 · 草稿 2 处未发布改动 · 屏蔽 未启用 · 去发布」,**无红条**;`/api/config` 不返回 `lastPublish`;`shell.tsx` 里唯一的 `note bad` 是 E1 的「状态获取失败」 |
| CON16-AC4 | schema 版本漂移拒绝面 | **未验(挂账)** | 见第五节 |

### 门本身(三道被改动的门,红绿两向)

| 门 | 正对照 | 红测(真实事故形态) | 结论 |
|---|---|---|---|
| `gate-beacon-size` | exit 0,37 页 | ① 真官网页(`dist/nex/index.html`)去掉埋点 → **exit 1「缺失 1 页」** ② 顶层 `dist/admin/**` 再加一页无埋点 → exit 0(符合豁免意图) ③ **嵌套** `dist/learn/admin/index.html` 无埋点 → **exit 1** | **守得住**。豁免面是构造性的最小面(只跳 `rel===''` 的 `admin`),没有扩大 |
| `gate-config-consistency` | exit 0;`--self-test` 4/4 | ① 真改 `src/index.ts` 加一条未声明的 cron → **exit 1** ② 真改 `wrangler.jsonc` 多声明一条无人处理 → **exit 1** | **守得住**;但合法的**行尾** `//` 注释仍让它抛栈崩溃(P2-10,T23 已挂账) |
| `test-static` | exit 0,37 路由 | 在静态兜底层给 HTML 响应体追加一段字节(真实事故形态:注入类中间件写错) → **exit 1,36/37 路由字节不符** | **守得住自己那条**;但**再也发现不了「伺服目录被改错」**(P1-C) |

---

## 二、P0

### P0-A 🔴 零门上线仍然成立:8 次 HTTP 请求把版本推成 `live`,一道门没跑,且伪造出的痕迹与真发布**完全同形**

上一轮的 P0-1 是「2 次请求」。修法封的是三种**畸形序列**(跳步 / 不先报 running / 过期锁),没有封「把每一步按顺序编一遍」。服务端对 `gates ok` 这句话没有任何可核验依据——它只检查这句话来得**是不是时候**,不检查它**是不是真的**。

**前置条件(便于定级)**:需要一个合法管理员会话(`/api/publish/step` 未认证是 401,已复验)。威胁面 = 「拿到后台会话的人」或「被改坏/被替换的执行器」。PRD 的措辞是绝对的(「**不存在该 API**」),派单给的判据也是绝对的(「任何能让 `config_versions.status` 变成 `live` 而没有真跑过站上 13 门的路径都是 P0」),所以按 P0 记;若主人认为「信任持有会话的执行器」是可接受的设计前提,这条应当在 PRD/README 里把承诺改成「执行器可信」,而不是留着「不存在该 API」的写法。

**复现(照做即可,需一个合法管理员会话)**

```
POST /api/publish                                          -> 200 {"versionId":2}
POST /api/publish/step {versionId:2,step:"materialize",status:"running"} -> 200
POST /api/publish/step {versionId:2,step:"materialize",status:"ok"}      -> 200
POST /api/publish/step {versionId:2,step:"gates",status:"running"}       -> 200
POST /api/publish/step {versionId:2,step:"gates",status:"ok"}            -> 200
POST /api/publish/step {versionId:2,step:"build",status:"running"}       -> 200
POST /api/publish/step {versionId:2,step:"build",status:"ok"}            -> 200
POST /api/publish/step {versionId:2,step:"swap",status:"running"}        -> 200
POST /api/publish/step {versionId:2,step:"swap",status:"ok"}             -> 200

结果:versions = v2:live  v1:archived
      publish_steps = materialize:ok  gates:ok  build:ok  swap:ok   ← 四步齐全
      audit        = #4 config.publish v2 / #5 config.publish.live v2
```

**与上一轮相比,危害面怎么变了(如实分档)**

- **变好的一半**:P0-3 修完之后,DB 翻 `live` 不再改站上内容(promote 只有执行器会跑)。所以这**不再是「坏内容上线」**。
- **变坏的一半 ①(取证)**:上一轮伪造后 `publish_steps` 是**空表**,一眼可辨;现在四行齐全,与真发布唯一的差别是 `gates` 耗时 **28 ms**(真发布 336–364 s),而**系统里没有任何东西看这个数**。审计行 `config.publish.live` 与真上线逐字同形。
- **变坏的一半 ②(实测后果,不是推论)**:伪造 live 之后
  ```
  GET /api/config  ->  liveVersion=2, dirty=0, changedPaths=[]
  控制台状态条    ->「与线上一致」;发布页 ->「没有待发布的改动(草稿与线上一致)」
  站上首页        ->  仍是旧文案(标记词 AAA1 命中 0 次)
  POST /api/publish -> 409 {"error":"no-changes"}     ← 真正的改动再也发不出去
  ```
  运营被锁在一个假的「已发布」状态里:界面说一切同步,站上是旧的,而「发布」按钮因为 `pre.ready=false` 是禁用的。
  **准确说不是永久发不出去**——只要再随便改一处别的字段,diff 就不为空、可以发,那一次会把原来那处改动一并带上;
  但运营**不会知道自己需要这么做**,因为界面上没有任何异常信号(状态条绿、发布页说没有待发布改动、站上看着也正常,只是内容是旧的)。
  真正无解的是**取证**:事后没有任何数据能区分「这一版过了门」和「这一版是编出来的」。

- **违反**:PRD CON13-④「禁止:跳过任何门直接上新(**不存在该 API**)」;plan T21-AC「**不存在绕门发布 API**」;`worker/README.md:41`「手工用 curl 补一句 `swap ok` 让版本上线是**不成立**的」——单说 `swap ok` 这一句确实不成立了,但整句承诺(不能手工上线)仍不成立。
- **根因位置**:`worker/src/publish.ts:160-219`(`/step` 全部校验都是序列合法性,没有一条是产物凭据);`worker/src/publish.ts:208-217`(`swap ok` 直接翻 `live`,不校验任何产物)。
- **既有测试为什么还是没抓到**:`worker/test/publish.spec.ts` 新增的三条 P0 用例断言的是**修法**(out-of-order / not-running / lock-expired 各回什么错),没有一条断言那条**不变量**——「不曾跑过门的版本不得成为 live」。所以合法顺序的纯伪造序列在 82/82 全绿的情况下畅通。
- **可选修复方向**(仅供参考,不是验收要求):让 `gates ok` / `build ok` 携带产物指纹,`swap ok` 时服务端比对 promote 之后 `dist-live` 的指纹与该版本物化产物的指纹;或把 `live` 的判定从「执行器说 ok」改成服务端自己读一次快照指纹。任何方案都要配一条断言不变量(而不是断言错误码)的回归测试。

---

## 三、P1

### P1-A 🔴 执行器崩在半路 = 最长 15 分钟完全无法发布,且没有任何操作出口;README 写的「重启自动接管」已不成立

**复现**

```
POST /api/publish                                       -> 200 {"versionId":7}
POST /api/publish/step {versionId:7,step:"materialize",status:"running"}   -> 200   （模拟执行器刚开工）
（此处掐掉执行器）
GET  /api/publish/next    -> 200 {"job":null,"note":"already-claimed"}     ← 重启的执行器领不到
POST /api/publish/cancel  -> 409 {"error":"already-running(已有步骤开始,不可取消)"}
POST /api/publish         -> 409 {"error":"publish-in-progress","heldBy":7}  ← 且每试一次多一行垃圾 failed 版本
SELECT ttl FROM publish_lock  -> 872 194 ms 剩余
```

- **影响**:本机开发下执行器被掐断是**常态**(README 自己写「工具类超时会掐断执行器」)。掐断之后:UI 的「排队中…取消本次发布」按钮**恰好不显示**(它的条件是 `steps.length === 0`),cancel 被服务端拒,重发被锁拒,运营只剩「等 15 分钟」。PRD E4 要的是「不静默吊死」,现在是「明示地吊死 15 分钟」。
- **两条各自合理的规则合起来没有出口**:`worker/src/publish.ts:148-149`(`/next` 对已有 steps 的任务一律不派发,P1-3 的修法)+ `worker/src/publish.ts:258-259`(cancel 对已有 steps 一律拒,P1-4 的修法)。上一轮这两条各自是对的,合起来把恢复路径堵死了。
- **文档同步失效**:`worker/README.md:39`「执行器被掐断后重启会**自动接管仍持锁的那一版**并从头重跑,不用手工清理」——实测 `/next` 回 `already-claimed`,不成立。

### P1-B 🔴 两个执行器**同时**轮询仍会领到同一单;「已被领取即不再派发」只覆盖了「先后」,没覆盖「同时」

**复现**:发起发布后立刻并发两次 `GET /api/publish/next` →

```
#1 -> 200 {"job":{"versionId":5, ...}}
#2 -> 200 {"job":{"versionId":5, ...}}      ← 同一单
```

- **影响**:两个执行器会在**同一棵工作树**上并行跑 `npm run verify`(内含 `astro build` 重写 `dist/`)与 `build:console`,产物互相覆盖;先报 `materialize ok` 的赢,另一个的 `ok` 收 409 后抛错退出——但它退出之前已经往 `dist/` 写过东西了。最后被 promote 的那份 `dist` 是两次构建交错的结果,而它已经过了门(门跑的是别人的中间态)。
- **`/next` 是纯读**:claim 靠的是「有没有 steps」这个副作用,读与写之间没有原子占位(`worker/src/publish.ts:143-151`)。两个执行器一起启动就是同一个 3 s 节拍,这条路径不是边角。
- **与挂账的关系**:plan T23 挂账 ③ 承认「没有真正的租约续期/抢占语义」,但同一句话说「多执行器场景**只靠「已被领取即不再派发」挡住**」——**这半句不成立**。挂账的前提描述错了,处置结论(V1 单执行器够用)是否还成立需要重估。
- 新增的回归测试 `P1 执行器租约:已被领取的任务不再派发给第二个执行器` 只覆盖了「先后」这一支,标题里的「租约」名不副实。

### P1-C 🔴「线上伺服 `dist-live`」这条 P0-3 的修法**没有任何机器门守着**,一个 token 的编辑就能把 P0-3 原样放回来,而全门链依旧全绿

**复现(隔离副本)**:把 `worker/wrangler.jsonc` 的 `assets.directory` 从 `../dist-live` 改回 `../dist`,并让 `dist` 带上未过门内容 →

```
gate-config-consistency   exit 0
gate-beacon-size          exit 0
test-static               PASS(38/38 路由)     ← 它现在跟着配置走,于是跟着错到同一个目录去比对
promote.mjs --check       「· 两者不同(构建产物尚未提升上线,这在门未通过时是正确状态)」
                          ← 只是一行信息,不是门,不在任何链里,而且这句话在事故态下是错的
worker 单测               82/82 绿(沙箱里没有 assets)
```

- **全仓 grep**:`dist-live` 只出现在 `wrangler.jsonc` / `promote.mjs` / `runner.mjs` / `test-static.mjs` 的**注释**里,没有任何一处断言。
- `test-static.mjs` 改成「从配置读目录」这个方向本身是对的(单一真源),但它顺带把**「伺服目录是不是那个该伺服的目录」**这个判据一起交出去了,而没有第二道门接手。结果是:上一轮那场真实事故(线上直伺服 dist)可以原样复活,十几道门全绿。
- 这正是本仓 CLAUDE.md 记着的那条:「门被换个写法即绕过 / 门守的不是被守物」。P0-3 的修法目前只是**一行配置**,不是一道门。

### P1-D 🔴 CON02-E2「上次发布失败 → 状态条红条」整条缺席(plan 第 90 行明写移交 T21-AC)

- **实测**:v11 门红之后进控制台,状态条只有三个 chip +「去发布」,**没有红条**(真浏览器文本已留证)。
- **API 侧**:`/api/config`(状态条唯一数据源)返回 `liveVersion / livePublishedAt / geo / live / draft / dirty / changedPaths / sensitiveChanged`,**没有 `lastPublish`**,而 PRD CON02-③ 把 `lastPublish {status, at, failReason?}` 列在这张表里。
- **UI 侧**:`admin/src/shell.tsx` 里唯一的 `note bad` 是 `:99` 的「状态获取失败 · 重试」,那是 E1,不是 E2。
- **声明≠实现**:`admin/src/shell.tsx:1` 的文件头注写着「导航五组 + 状态条三 chip + **失败红条** + 重试」。
- **不能拿驾驶舱顶账**:`admin/src/pages/dashboard.tsx:303` 的「最近发布 vN:失败(…)」是 CON03 运营健康卡,一个页面、另一条 AC;CON02-E2 要的是「进入**任意页**」都看得见,并且「点击 → /publish 定位到失败详情」。

---

## 四、P2(逐条不合并)

1. **`running` 可以对已经 `ok` 的步骤重复上报,每报一次续 15 分钟锁**。实测 `materialize ok` 之后再报 `materialize running` → **200**,`publish_steps` 里多一条永不收尾的 `running` 行(`ended_at` NULL)。两个后果:① 给了「不推进却无限占锁」的路径;② 上一轮 P2-7「running 行永不收尾 → UI『已耗时 Ns』算出荒唐值」多了一条新的产生路径。根因 `worker/src/publish.ts:179`(重复收口只挡 `ok`/`failed`,不挡 `running`)。
2. **被并发/锁拒绝的发起仍留下 `failed` 版本行,且没有对应审计行**(上一轮 P2-5,仍在)。本轮实测 v4 / v6 / v8 三行 `有发布正在进行`;`SELECT * FROM audit WHERE target='v4'` → 空(`writeAudit` 在 `acquireLock` 之后)。版本号跳号,实景版本历史 11 行里 9 行是这类噪声。根因 `worker/src/publish.ts:119-129`(先 INSERT 版本再抢锁)。
3. **自愈把版本标 `failed` 时不写审计**(新发现)。v3 / v7 的 `发布中断(执行器无响应或超时)` 在 `audit` 表里查不到任何行;`acquireLock` 里的过期清理(`publish.ts:45-48`)同理。CON14-⑦ 要求动作字典覆盖全部变更点——T23 的审计覆盖测试如果只遍历「动作字典」而不遍历「状态迁移」,这一类会整片漏掉。根因 `worker/src/publish.ts:229-237`。
4. **回滚源不限状态**(上一轮 P2-6,仍在)。`fromVersion` 可以是 `failed` 版本(实测 v8 → 建出 v9,200),也可以是当前 `live` 版本(实测 v2 → 建出 v10,200,顺带绕开 `no-changes` 判据)。UI 不给按钮,API 不拦。仍走完整门链,故非绕门。根因 `worker/src/publish.ts:99`(SELECT 无 status 过滤)。
5. **「去修复」只跳页面不定位字段**(上一轮 P2-4,仍在)。PRD ⑥ 要求「对应内容页 → 定位到红字段」;`admin/src/pages/publish.tsx:29-39` 的 `fixLink()` 返回裸路径,内容页无 hash/query 承接。
6. **版本列表缺 PRD ⑤ 的「改动数」列,也缺 PRD ⑥ 的版本行「查看」→ 展开该版 diff 摘要**(新发现,上一轮未记)。实景表头只有 `版本 / 时间 / 状态 / 理由·失败原因 / 操作`,操作列里只有「回滚到此版」一个按钮;`publish.tsx` 里没有任何按版本取 diff 的调用,服务端也没有对应接口(`/api/config/versions` 只回列表字段,不回 payload/diff)。PRD ⑤ 原文:「下半版本列表(号/时间/**改动数**/状态/操作)」;⑥ 原文:「版本行「查看」| 当前页 | 展开该版 diff 摘要」。(「本次发布 · N 处改动」那处的计数是**当前草稿 vs live**,不是每一版自己的改动数,不能顶这一格。)
7. **`RULE_LABEL` 新增的 `all-hidden-sku` 是死键**。全量比对:`schema/src/validators.ts` 产出 18 种 rule,`RULE_LABEL` **18 种全部有映射,不缺**;多出来的 `all-hidden-sku` 校验器从不产出(skus 全隐藏走的是已有的 `all-hidden`)。也就是说本轮「补的两条」里有一条补在了不存在的 rule 上,没有回源核对产出方。根因 `admin/src/pages/publish.tsx:26`。
8. **`promote.mjs` 的指纹是「相对路径 + 字节数」,对内容变化是瞎的**。实测:等长改写 `dist/index.html` 后 `node promote.mjs --check` 仍报「✓ 线上快照与构建产物一致」。README 把 `--check` 当作「比对两者是否一致」的手段(`worker/README.md:19`),同一个函数还被用作 promote 收尾的自校验(`worker/promote.mjs:108-113`)——它能发现文件数/大小变化,发现不了内容变化。根因 `worker/promote.mjs:17-31`。
9. **门红只报第一道门 + 原始日志只留最后 25 行**(上一轮 P2-1,机制未改)。`worker/runner.mjs:57` 用 `/✗\s+([a-z0-9-]+)/i` 抓第一条,`:58` 取 `slice(-25)`。本轮样本恰好只有一道门红且落在 tail 内,**没有触发**;代码路径与上一轮逐字相同,多门同红或红门靠前时会原样重演。
10. **`gate-config-consistency` 遇到合法的行尾 `//` 注释直接抛栈崩溃**(T23 已挂账 ②,仍在)。实测给 `wrangler.jsonc` 加 `"ENVIRONMENT": "dev",   // 上线改 production`:`npx wrangler deploy --dry-run` 读得动(合法 JSONC),门却 `JSON.parse` 抛 SyntaxError、exit 1、无任何诊断行。失败关闭不算放过,但对改配置的人是一次无法归因的红。根因 `worker/gate-config-consistency.mjs:18`。
11. **终止类审计行不带理由**(上一轮 P2-8,仍在)。`config.publish.live` / `.failed` / `.cancel` 的 `reason` 恒 NULL,理由只挂在 `config.publish` / `config.rollback` 发起行。按动作过滤时看不到理由。
12. **单步无心跳:任何一步超过 15 分钟必被判超时,而且归错因**。锁只在 `running` 上报那一刻续期(`worker/src/publish.ts:185`),`gates` 又是不可分的一步。**实验四把这个形态真实演出来了**:gates 全绿的一次发布被判 `failed`,给运营的原因是「发布中断(执行器无响应或超时)」——执行器全程有响应、门全部通过,而界面上没有任何线索能区分「门红了」和「门全绿但锁掉了」。本轮 gates 实测 336.2 / 344.2 / 363.7 s,离 900 s 余量约 9 分钟;路由/视口档位再涨或换台慢机器就会自己发生。另外这一次的 `gates` 行永远停在 `running`(`ended_at` NULL),又落进第 1 条那个坑。
13. **并发抢锁不是原子的(理论,本机未复现)**。`acquireLock`(`worker/src/publish.ts:40-52`)是 SELECT → `batch(UPDATE+DELETE)` → INSERT 三段,段间无事务:两个请求同时看到过期锁时,后到者的 DELETE 会删掉先到者刚插入的锁,两边都拿到 200。本机 D1 模拟器串行化,20 轮普通并发 + 1 轮过期锁并发都没复现(A 200 / B 409 干净),故只记为观察项,不作断言。

---

## 五、上一轮报告逐条回归

| 上一轮条目 | 本轮结论 | 证据 |
|---|---|---|
| **P0-1** 状态机零顺序校验,2 次请求即可 live | **变形为新问题(P0-A)** | 畸形序列全被挡(409×5 种);合法顺序的 8 次请求仍可 live,且痕迹与真发布同形 |
| **P0-2** `/step` 不看锁过期时间 | **已消除** | 锁拨到 60 s 前后,`gates running` / `swap ok` / `materialize running` 三种上报全部 409 `lock-expired`;`/next` 回 `job:null`;`/status` 自愈标 failed |
| **P0-3** 门还在跑,未过门内容已在线上 | **已消除** | 111 次采样:gates 期间 `dist` 指纹变 `ae7bd4433a`、站上响应体恒 `740d0a85ba`(= `dist-live`)、标记词 0 命中;门红后线上仍是旧内容。成功发布时切换发生在 `build:ok → swap:ok` 之间那一拍(17:26:39 旧 → 17:26:43 新) |
| **P1-1** 门红后控制台永久 404 | **已消除** | 四轮实验共 687 次 `/admin/` 探测,**全部 200**(含 gates 期间与门红之后);无须手工 `build:console` 即可打开失败面 |
| **P1-2** 失败态取不回原始日志 | **已消除** | `/status` 回 `stepsOfVersion=11` + 该版 steps;真浏览器里「查看原始日志」渲染并展开出 25 行 verify 尾部 |
| **P1-3** `/next` 无租约,两个执行器领同一单 | **部分消除 / 变形(P1-B)** | 「先后」挡住了(`already-claimed`);「同时」没挡住,两次并发 `/next` 仍返回同一 `versionId` |
| **P1-4** 取消不限排队态 | **已消除**,但引出 P1-A | `materialize running` 时 cancel → 409;代价是执行器崩溃后无任何恢复出口 |
| **P2-1** 只报第一道红门 + 日志与门名对不齐 | **仍在(机制未改)** | `runner.mjs:57/58` 逐字未变;本轮样本单门红,未触发 |
| **P2-2** runner 把 409 当成功 | **已消除** | 实验四实跑:执行器在 `report(gates,'ok')` 上吃到 409 后打印「执行器异常 … rejected:true」并 exit 1,不重试、不推进、不打印「✓ 已上线」 |
| **P2-3** `RULE_LABEL` 缺 `encoding-damage` | **已消除**,但新增死键 | 18 种 rule 全有映射;多出 `all-hidden-sku`(P2-7) |
| **P2-4** 「去修复」只跳页面不定位字段 | **仍在** | `fixLink()` 返回裸路径 |
| **P2-5** 被拒发起留 failed 行 + 无审计行 | **仍在** | v4/v6/v8 三行;`audit WHERE target='v4'` 为空 |
| **P2-6** 回滚源可以是 failed 版本 | **仍在** | v8 → v9 返回 200;另发现 live 版本也可作源(v2 → v10) |
| **P2-7** running 行永不收尾 | **仍在**,且多一条新产生路径 | 对已 ok 的步骤重复报 running → 200,又留一行 |
| **P2-8** 终止类审计行不带理由 | **仍在** | `.live` / `.failed` / `.cancel` 的 reason 全 NULL |

---

## 六、关键实验留档

### 实验一 · 门红(v11,注入超长 `hero.title`)

| 时刻 | 步骤 | 站上首页指纹 | `dist/index.html` | `dist-live/index.html` | 标记词 | `/admin` |
|---|---|---|---|---|---|---|
| 17:11:31 | 发起 | `740d0a85ba` | `740d0a85ba` | `740d0a85ba` | no | 200 |
| 17:11:39 | gates running | `740d0a85ba` | **`ae7bd4433a`** | `740d0a85ba` | no | 200 |
| 17:17:20 | **gates failed** | `740d0a85ba` | `ae7bd4433a` | `740d0a85ba` | no | 200 |
| 17:19:00 | 收尾 | `740d0a85ba` | `ae7bd4433a` | `740d0a85ba` | no | 200 |

111 次采样,首页非 200 = 0,`/admin` 非 200 = 0,`servedHash` 只有一个取值。
失败原因:`新文案把版面挤破了(行压行 / 文字钻到导航底下 / 窄屏字号反向变大)(门:render-fit)`;steps:`materialize:ok(0.1s) | gates:failed(344.2s)`。

### 实验二 · 成功发布(v12,改 `trust.card5` 埋入 `RECHECKR2OK`)

```
17:26:39  build:running                served=740d0a85ba  mark=no
17:26:43  swap:ok                      served=a08d39747c  mark=YES     ← 切换发生在最后一步
站上实测:curl / | grep "The MSB registration record" -> "...checked on RECHECKR2OK site."
         旧文案 "looked up on FinCEN's website" -> 0 命中
步骤耗时:materialize 0.077s / gates 363.662s / build 4.348s / swap 0.579s
版本:v12 live,v2 archived
```

### 实验三 · 回滚(v39,`fromVersion:1`)

```
POST /api/publish {fromVersion:1, reason:"..."}   -> 200 {"versionId":39,"rollbackFrom":1}
四步:materialize 0.077s / gates 336.216s / build 3.281s / swap 0.174s
17:37:08 -> 17:37:12  站上响应体 a08d39747c -> 740d0a85ba
站上实测:RECHECKR2OK 0 命中;"looked up on FinCEN's website" 回归
版本:v39 live · v12 archived · **v1 仍是 archived(未被复活)**
审计:#113 config.rollback v39「内容取自 v1」+ 理由;#114 config.publish.live v39
理由 <8 字 / 缺理由 -> 400 reason-required;fromVersion:9999 -> 404 version-not-found
```

### 实验四 · 门跑到一半锁失效(v40)—— 同时证伪两件事

发起 v40 → 执行器领走并进入 gates → **在 gates 跑到一半时把锁拨到过期**(模拟「单步超过 15 分钟 TTL」),然后什么都不做,看执行器最后怎么收场。

```
17:39:42  gates running,dist 指纹变 8fde2c767d(未过门产物),站上恒 740d0a85ba
17:40:03  锁被 /status 判过期 → v40 标 failed、锁清除(此时执行器还活着、门还在跑)
17:45 前后  gates 真的跑完并且**全绿**(执行器走到了 runner.mjs:87 那一行 = report(gates,'ok'))
          → 服务端回 409 not-current-job
          → 执行器打印「执行器异常: … 409 … rejected:true」并 exit 1,**没有重试、没有继续推进、没有打印「✓ 已上线」**
最终:v40 failed,fail_reason「发布中断(执行器无响应或超时),线上保持旧版」
      publish_steps: materialize:ok(0.077s) / gates:**running(ended_at 恒 NULL)**
      站上标记词 LOCKLOSS4 命中 0 次;142 次采样,首页与 /admin 非 200 各 0 次
```

两条结论:

- **上一轮 P2-2 已消除** —— `runner.mjs:31-42` 把 409 当拒绝,抛错退出,不再「吞掉红门继续跑」。
- **P2-12 的失败形态被真实演出来了** —— 一次**门全绿**的发布被判成 `failed`,而给运营看的原因是「执行器无响应或超时」(执行器全程有响应)。锁只在 `running` 上报那一刻续期,`gates` 又是不可分的一步,所以「一步超过 TTL」= 白跑一次并且**归错因**。本轮 gates 实测 336–364 s,离 900 s 还有约 9 分钟余量;路由/视口档位再涨或换台慢机器,这条就会自己发生。

---

## 七、没能验到的 AC(不静默略过)

1. **CON16-AC4 schema 版本漂移拒绝面**。全仓 `SCHEMA_VERSION` 只有两处:`schema/src/site-config.ts:82` 定义、`schema/src/materialize.ts:40` 写进 `site.json`。**发布链上没有任何一处读它做拒绝**,站侧也不校验(`src/config/site.json` 里只是个数值)。plan 把它列为「T22 前置,物化端点接线时联测」并挂到 T23——本轮无可验之物,不作 PASS/FAIL,记为**未接线**。
2. **Phase C(CI 执行器)同契约**。只验了 V1-dev 本机 runner;CI 版不存在,无法验。
3. **真实 Cloudflare 环境下的原子切换**。`promote.mjs` 的换名分支在本机服务运行时必走 EBUSY 降级(就地同步),生产的原子性依赖平台。plan 挂账 ① 已记「上云前确认前提仍成立」,本轮无云端环境可验。
4. **P2-13 的并发抢锁**在本机 D1 模拟器上串行化,21 次尝试未复现;只能作观察项,无法判定真实 D1 上的行为。
5. **窄窗(<1024px)导航折叠为抽屉**(CON02-⑤ 极限态)与**版本历史 >30 条的分页/滚动**未测——不在 T21/T22 AC 文字内,本轮按边界排除,列此备查。

---

## 八、收尾状态

- 本轮造出的 41 个版本、上百条审计行、发布锁全部关在自建的隔离持久化目录里;该目录已 **Move 出仓**(到 scratchpad,未硬删),`worker/` 下不留残留。
- 执行器物化写过的 `src/i18n/{en,vi,zh}.json` 与 `src/config/site.json` 已 `git checkout` 还原。
- `dist/` `dist-live/` 已按仓内提交内容重建并 promote 到一致:指纹 `112 文件 / 42a72a91`,与开工前记录的基线**逐字相同**(两者均为 `.gitignore` 忽略项)。
- 隔离副本(`git archive` 出来的红测树)全在 scratchpad,未写回仓内。
- 进程与端口:wrangler 监督进程树已按 README 配方杀净,`node.exe` 中含 `wrangler` 的 0 个、`workerd` 0 个;回读 8791 / 8793 / 4401 / 5181 / 8787 / 8788 监听数**全部为 0**。
- **冻结纪律**:`worker/src/**`、`worker/*.mjs`、`worker/wrangler.jsonc`、`admin/src/**` 全程零写入;所有红测注入都发生在 scratchpad 的隔离副本里。收尾 `git status` 仓内新增 = **本报告一份**(另有 `docs/changes/2026-09-01-legal-seed-draft/` 与三个 docs 提交,是并行会话的产物,不是我写的)。
