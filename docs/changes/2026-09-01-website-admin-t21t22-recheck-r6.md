# 第六轮独立验收 —— 包⑨ 发布流水线(T21 发布编排 / T22 本机执行器)

**判决 = 不可签字**

P0 = 0(连续第四轮)。「不存在绕门发布 API」这条机器承诺本轮再次全面成立:按合法顺序把四步各报一遍上不了线、18 条猜测路由全 404、印记文件 HTTP 面写不进去。
不可签字的原因不在那条承诺,而在**这一轮的结构性改动本身造出了第五次组合故障**(P1-1),以及**这个包的机器门在「跑过一次发布之后」的常态下是红的**(P1-2)——也就是说前几轮所有「机器门全绿」的记录,都只在「从没发布过」这一种状态下成立。

---

## 〇、本轮怎么验的(证据面交底)

| 项 | 值 |
|---|---|
| 仓 / 分支 / HEAD | `D:\WORKS\PLAN\.wt\w-console` · `pkg/w-publish` · `be6e128`(验收期间未变) |
| worker | `npx wrangler dev --port 8815 --persist-to <scratchpad>/r6-persist`,独立 D1,迁移 0001–0006 全部先行应用 |
| 起点自证 | 每轮实验前 `GET /api/health` = 200 `{"ok":true,…}` |
| 真发布 | **跑了一次完整的真执行器**(`npm run publish:runner --once`):v3 领单 → 物化 → `npm run verify` 13 门 → `build:console` → `promote.mjs` → 上线。全绿,耗时约 9 分钟 |
| 冻结 | `worker/src/**`、`worker/*.mjs`、`worker/wrangler.jsonc`、`worker/migrations/**`、`admin/src/**` 全程零写入(收尾 `git status` 干净) |
| 一次受控源码变更 | `schema/src/validators.ts`(**不在冻结清单内**)被临时注入一条规则做门的独立红测,**已逐字节还原**(`git status` 空) |
| 版本足迹 | v1(种子)→ v19,其中 v3–v11 为真/半真上线,v12/v13 为构造实验,v14/v15/v19 为取消实验 |
| 未做 | **没有起控制台 vite,没有真浏览器走查**。所有 UI 结论出自源码文本 + 服务端实际返回的 payload(见第六节「没能验到」) |

---

## 一、逐 AC 判定

### T21 · 发布编排

| AC | 判定 | 证据 |
|---|---|---|
| T21-1 前置校验红 → 不进流水线,逐项列出 | **PASS** | 注入 `risk free` → `preflight ready=false errors=1 {path:"copy.en.hero.title",rule:"forbidden-word",message:"合规拦截 [risk-free / zero-risk]:「risk free」"}`;`POST /api/publish` → **409 `preflight-failed`** 带 errors 数组 |
| T21-1b 红项带「去修复」定位 | **FAIL(P2-15,六轮同条)** | `admin/src/pages/publish.tsx:35-45` 的 `fixLink()` 只回页面路径,无 hash/query;内容页无承接。PRD ⑥ 要求「定位到红字段」 |
| T21-2 红项不丢草稿 | **PASS** | 校验红时不建版本行(版本数不变);草稿 `dirty` 保持 |
| T21-3 状态机单向 + server 权威 | **PASS(带 P1-1)** | `draft→validating→publishing→live/failed/cancelled` 实测均由服务端翻;客户端无任何写状态入口。**但 `publishing` 存在一个不可离开的吸收态**,见 P1-1 |
| T21-4 并发 409 + 锁 TTL 15 分钟 | **PASS** | 先后发:409 `publish-in-progress heldBy:15`;**同时**发两发:两发全 409;版本行数 15→15(不留垃圾行);审计留 `config.publish.rejected`。锁过期后 `/status` 自愈标 failed + 收口步骤 + 写审计,实测成立 |
| T21-5 执行器不在线 → 排队态可取消 | **PASS** | 零步骤时 `POST /cancel` → 200,版本记 `cancelled`(不是 `failed`),壳顶不长红条(实测 `lastPublishFailed` 未指向被取消版本) |
| T21-5b 已开工两档中止 | **PASS** | 未失联:`409 already-running canForce:false hint:"执行器仍在工作…"`;`force:true` 未失联 → `409 runner-still-alive`;失联满 12 分钟 + 无理由 → `400 reason-required`;+ 理由 → 200 `forced:true`。**但理由长度服务端只校验非空**,见 P2-5 |
| T21-6 不存在绕门发布 API | **PASS** | ① 领单后按合法顺序 `materialize/gates/build/swap` 各报 running+ok,不跑 promote → `409 live-verification-failed:线上快照里没有本次发布的上线印记`,版本 failed,live 保持 v1;② 18 条猜测路由(`/api/publish/{live,promote,complete,finish,force,swap,apply,activate,stamp,verify,steps,skip,rollback}`、`/api/config/{publish,live,promote}`、`/api/admin/publish`、`/api/publish/3/live`)POST 全 404;③ `PUT/POST/DELETE/PATCH /.publish-stamp.json` 全 405,连发 6 次 worker 存活;④ 错口令 → `not-the-claimed-runner`,跳步 → `step-out-of-order{missing,expected}`,别的版本号 → `not-current-job` |

### T22 · 执行器 + 失败面 + 版本/回滚

| AC | 判定 | 证据 |
|---|---|---|
| T22-1 §5.4 契约全链跑通 | **PASS(实景)** | 真执行器一次跑完 v3:`▶ 领到发布任务 v3` → `✓ v3 已上线(dist-live 已更新)`。四步全 ok,`drift=null`,`promote.mjs --check` 报 `dist 112/d8295ab0 = dist-live 112/d8295ab0`,站上 `/zh/` 实测含本次改的文案 |
| T22-2 门红 → failed + 线上保旧版 | **未验到(见第六节)** | 本轮未构造门红的真发布。相关证据:禁用词在**前置校验**就被拦(根本进不了门链);前几轮已实测门红路径 |
| T22-3 失败面 = 门名 + 大白话 + 原始日志 | **PASS(带 P2-8 / P2-19)** | 服务端 `fail_reason` 实测形如「上线核验未通过:…」「发布中断(执行器无响应或超时)…」;`GATE_REASONS` 覆盖 13 门 + `config-consistency`,缺映射回门名原文(`explainGate`)。折叠 UI 见源码 `publish.tsx:213-222`,**未实景渲染** |
| T22-4 版本列表 append-only | **PASS(带 P2-2 / P2-3)** | `DELETE/PUT/PATCH /api/publish/11` 全 404;版本号只增。**缺 PRD ⑤「改动数」列、缺 ⑥ 行内「查看」→ diff 摘要**(表头实为 `版本/时间/状态/理由·失败原因/操作`,六轮同条);**号段实测空洞 16/17/18** |
| T22-5 回滚走完整门链生成新版本 | **PASS** | `fromVersion` 实测只接受 `live`/`archived`(failed v13、cancelled v14 一律 `404 version-not-rollbackable`);回滚必填理由(空 → `400 reason-required`);回滚生成新版本号并走同一条 `/step` 链(v4 由 v3 内容生成并上线) |
| CON02-E2 上次发布失败红条 | **PASS(判据已对)** | `/api/config` 回 `lastPublishFailed`,判据 = 「失败版本比线上新」;取消一次(v14 cancelled)**没有**造出红条,而真失败 v13 的红条正常在。r5-P1-5「cancelled 占最大号使失败面消失」**已消除** |
| CON13-④ 高敏/回滚理由 ≥8 字 | **PASS(发布口)/ FAIL(中止口)** | `POST /api/publish` 无理由 400、3 字 400、足够 200;`POST /cancel {force}` 2 字 **200 通过**(P2-5) |
| 劈叉(drift)自查 | **部分 PASS** | 版本号不符 ✓;无印记 ✓(`{dbLive:11,snapshot:null}`);**锚点文件内容被改 ✓(r5-P2-25 已消除)**;**锚点外文件被改 ✗**(P1-3) |

---

## 二、P0

**无。** 逐项复核 CON13-④ 改写后的「机器强制的部分」:任何 HTTP 请求序列都上不了线——本轮 4 条独立路径证伪未果(合法序列全报、路由枚举、印记写入、错口令/跳步/过期锁)。
CON13-④「不由机器强制、靠环境可信的部分」我也实测确认它就是那条边界:我手工报了 materialize/gates/build 的 ok(一道门没跑)+ 自己跑 `promote.mjs --version/--stamp`,v4 确实上线了。**这不算 P0**,因为它需要本机文件系统写权限,而 PRD 已明写这一档不覆盖。

---

## 三、P1(逐条不合并)

### P1-1 🔴 **派单点名要找的第五次组合故障**:`swap ok` 的响应一旦丢失,一次**跑完全部门、内容已经上线**的发布会被永久卡死在 `publishing`,而执行器被告知「成功」,15 分钟后运营看到的两条提示**都是假话**

- **现象**:重发 `swap ok` 走第一层幂等,直接回 `200 {ok:true, idempotent:true}` —— 上线核验与翻 live 的整块代码**一次都不会执行**。该版本此后无法完成也无法重来。

- **可照做的复现步骤**(全部实测,worker 8815):
  1. `POST /api/publish {fromVersion:<live>}` → v12;`POST /api/publish/next` 拿 `stamp`。
  2. 逐步上报 `materialize/gates/build` 的 running+ok,再报 `swap running`。
  3. `node worker/promote.mjs --version 12 --stamp <stamp>` —— 真搬运,`dist-live` 已是 v12 的内容 + 印记。
  4. 把「行 353 的 UPDATE 落库了、行 403 的上线 batch 没跑完」这一格落库(与实现方 48 格穷举表构造 `recorded` 的手法相同,它也是直接写 `publish_steps`):
     `UPDATE publish_steps SET status='ok' WHERE version_id=12 AND step='swap'`
  5. 执行器重发:`POST /api/publish/step {versionId:12, step:'swap', status:'ok', stamp}`

     实测 → **`200 {"ok":true,"idempotent":true}`**
  6. `GET /api/publish/status` → v12 仍 `publishing`,`live` 仍是 v11,`steps=[[materialize,ok],[gates,ok],[build,ok],[swap,ok]]`,`drift={"dbLive":11,"snapshot":12}`,站上 `/zh/` 实测已是 v12 的内容。
  7. 想重来:`{step:'swap', status:'running'}` → **`409 step-already-done recorded:ok`**。**没有任何一条路径能让 v12 完成。**
  8. 等锁 TTL 到(实测把 `expires_at` 置 1 后读 `/status` 等效)→ v12 变 `failed`,`fail_reason="发布中断(执行器无响应或超时),线上保持旧版"`;`/api/config` 回 `lastPublishFailed={id:12,…}`。

- **运营那一刻看到的**:壳顶红条「上次发布失败(v12):**发布中断(执行器无响应或超时),线上保持旧版** 线上仍是 v11,**未受影响**。」——**执行器全程有响应**,**线上也不是 v11**。发布页失败面还叠一句「线上仍是上一版,未受影响(线上伺服的是已发布快照,失败的构建产物不会对外)」(`publish.tsx:212`),同时旁边的劈叉红条又说线上其实是 v12。**同一页两条互相矛盾的话。**

- **它为什么是「组合」而不是单点**:三条各自正确的修法叠出来的——
  ① 本轮结构性改动把幂等提到第一层、与锁解耦(对);
  ② r4 修法让执行器把非 4xx 失败重试至多 5 次(对);
  ③ P0-3 修法让 worker 伺服 `dist-live`,于是 `promote` 的写盘会触发开发服务器重载,而**丢响应恰好只发生在 `swap ok` 那一拍**(实现方自己在反思文档 §① 写下的事实)。
  第五轮的故障是「重发被 409 打死执行器」,本轮的修法把它变成了「重发回 200 骗过执行器」——**方向翻了,窟窿还在同一处**:`swap ok` 不是「记一笔事实」,它是**上线事务的触发器**;把触发器做成幂等的「已受理」,等于把事务丢了。

- **反方核对(我先试着证伪自己)**:我用 `AbortController` 在 1/2/4/8/15/25/40 ms 处掐断客户端连接各一次(v5–v11),**七次全部照常上线**——说明**客户端断连不会**留下这一格,workerd 会把 handler 跑完。所以这条的可达面收窄为:**isolate/进程在那个窗口内被销毁**(dev 重载、部署、驱逐、CPU 超限),以及 D1 两次写之间的任何失败。窗口内的工作量不小:`readLiveStamp` 1 次资产读 + 2 次 D1 读 + `expectedConfigSha`(Zod 解析 + 4 份物化 + SHA-256)+ `verifyAnchors`(3 次资产读 + 3 次 SHA-256,`index.html` 就有上百 KB)。**不是理论窗口。**

- **影响**:一次成功的 15 分钟发布被判死且不可重试;运营被同时告知两件互相矛盾且都不准确的事;真正的补救(重新发起)只能靠人从劈叉红条里自己看出来。方向上是 fail-closed(没有未过门的内容上线),所以是 P1 不是 P0。

- **根因位置**:`worker/src/publish.ts:309-311`(第一层幂等对 `swap` 也直接返回,不区分「这一步的收口还挂着一个事务」)· `:353-357`(先把步骤写成 `ok`,再做上线核验——不可回退的记账排在它守的事情前面)· `:370-409`(上线块只在「本次请求真的走到这里」时执行,没有任何「已记 ok 但没 live 就补做」的路径)。

---

### P1-2 🔴 这个包的机器门**判决取决于一个未纳入版本管理的构建产物**:跑过一次发布之后,`npm test` 就是红的

- **现象**:同一份 HEAD、同一份代码,`worker/npm test` 的结果由 `dist-live/.publish-stamp.json` 存不存在决定。

- **可照做的复现步骤**(本轮同一次会话内实测两向,中间未改任何源码):

  | `dist-live/.publish-stamp.json` | `npm test` | exit |
  |---|---|---|
  | 不存在(全新 checkout / 从没发布过) | **105 passed (105)** | 0 |
  | 存在(**任何一次成功发布之后的正常状态**) | **1 failed / 104 passed (105)** | 1 |

  失败的是 `test/publish.spec.ts:411` —— `🔴 P1-3 线上快照与系统记录劈叉时,状态里必须报出来`:
  `AssertionError: 初始种子 + 无印记 = 全新环境,不报: expected { dbLive: 45, snapshot: 15 } to be null`
  它用真 `env` 断言「无印记」,而真 `env.ASSETS` 读的是**沙箱外的 `../dist-live`**。

- **影响**:三重。
  ① plan 的完成门第一条是「机器门(tsc + verify 全绿)」;这个包的机器门在功能被正常使用一次之后就不绿,**「全绿」这个前提从来没有在真实状态下成立过**。
  ② 我这一轮开场跑到 105/105,只是因为上一位验收方收尾时把印记清掉了——**绿是被环境喂出来的,不是被代码挣来的**。
  ③ 一道守着 P1-3 修法的测试,自己会在功能被使用后变红,于是它必然被当成噪音关掉或忽略,那条修法就此失去看守。
  这已经不是「测试写得不严谨」,是 [[feedback_gate_chain_silently_stopped]] 同族:**报绿之前得先问这条绿是在哪种环境状态下拿到的**。

- **前轮台账**:r4-P2-13 / r5-P2-13 两轮记为 P2「仍在」。我判定它够 P1:它决定的是「机器门全绿」这句话本身的真假。

- **根因位置**:`worker/test/publish.spec.ts:399-421`(该用例用真 `env` 而不是 `envWithStamp` 替身)· `worker/wrangler.jsonc:assets.directory = ../dist-live`(测试环境继承了这条真实绑定)。

---

### P1-3 🔴 锚点抽查覆盖 **112 个文件里的 3 个**、公开站 36 个页面里的 **1 个**;`_astro` 全站样式与脚本完全不在核查面内。而「这是抽查」的告知,**只在核查已经报警时才渲染**

- **现象**:`promote.mjs:152` 的锚点集合是 `['index.html','404.html','admin/index.html']`。实测 `dist-live` 共 **112 个文件 / 38 个 HTML**,其中 36 个是公开站页面(`admin/index.html` 是控制台壳)。所以覆盖面 = **3/112 文件**、**1/36 公开页**。

- **可照做的复现步骤**(实测,全部在一次成功发布之后):

  | 动作 | `/status` 与 `/api/config` 的 `drift` |
  |---|---|
  | ① 什么都不改 | `null` ✓ |
  | ② 改 `dist-live/index.html` | `{"dbLive":11,"snapshot":11,"tampered":["/index.html"]}` ✓ |
  | ③ **只改 `dist-live/zh/index.html`**(三语之一的中文首页) | **`null`** ✗ —— 同时 `GET /zh/` 实测已返回被改的文案 |
  | ④ **再改 `dist-live/_astro/Base.025xgyUh.css`**,追加 `body{display:none!important}` | **`null`** ✗ —— 全站每一页都会被这一行改掉 |

- **代码里给的理由与事实不符**:`publish.ts:98` / `promote.mjs:150` 写「锚点选的是『改了就一定影响访客看到什么』的那几个」。这句话对锚点内的三个文件成立,但它被当成了**充分必要**来用——而 `_astro/*.css`、`_astro/*.js`、`/vi/**`、`/zh/**`、`/learn/**`、`/legal/**` 每一个改了都影响访客看到什么,其中样式与脚本影响的是**全部 36 页**。本仓自己的红线是「三语 parity」,而这道核查只覆盖三语里的一语。

- **告知在错误的一侧**:`publish.tsx:185` 的「(这是抽查:只核对了几个关键文件,其它资产不在核查范围内。)」写在 `st.drift.tampered?.length ? (…)` 的**真分支里**——也就是**只有已经查出问题时才会显示**。而缺口真正咬人的场合是「没查出问题」:那时界面上是壳状态条的「与线上一致」,一个字的保留都没有。**边界声明诚实,但放在了看不见的地方。**

- **影响**:PRD 已把「拿到机器权限的人」划出威胁模型,所以这条不是安全 P0。但劈叉自查的另一半用途是**发现事故**(半截 promote、部分同步、外部工具误覆盖),而这些事故最容易落在 `_astro` 指纹资产与非默认语种页面上——恰恰是核查面之外。运营据此得到的是**假的安心**。

- **根因位置**:`worker/promote.mjs:151-155`(锚点集合硬编码三条)· `worker/src/publish.ts:100-117`(核查面完全由印记里的 `anchors` 决定)· `admin/src/pages/publish.tsx:179-186`(免责声明写在真分支内)。

---

### P1-4 🔴 壳顶的劈叉红条对**内容被改**这一形态渲染出一句自相矛盾的话:「记录里线上是 v11,线上实际伺服的快照来自 v11」

- **现象**:`liveSnapshotDrift` 在 tampered 形态下返回 `snapshot === dbLive`。壳顶的渲染块没有 `tampered` 分支,于是把两个相同的版本号填进「对不上」的句式里。

- **可照做的复现步骤**:
  1. 完成一次发布,改 `dist-live/index.html` 一个字节。
  2. `GET /api/config`(**壳状态条读的就是这个接口**)实测返回:
     `drift = {"dbLive":11,"snapshot":11,"tampered":["/index.html"]}`,`liveVersion=11`。
  3. 把这份 payload 代进 `admin/src/shell.tsx:91-94` 的模板:
     ```
     线上内容与系统记录对不上:记录里线上是 v11,线上实际伺服的快照来自 v11。
     ```
     发布页有专门的 tampered 分支(`publish.tsx:179-186`),壳顶没有——**同一件事,两个面两种说法,其中一个是废话**。

- **它也是两个修法叠出来的**:r4-P1-6 补了壳顶红条(对),r5-P1-4 给 drift 加了 tampered 形态(对),**第二个改了 drift 的形状,第一个的渲染没跟着改**。同族第五次。

- **附带**:`admin/src/api.ts:34` 的 `Overview.drift` 类型是 `{ dbLive: number; snapshot: number | null }` —— **根本没有 `tampered` 字段**,所以壳层即使想渲染也拿不到类型。`publish.tsx:19` 自己另外声明了一份带 `tampered` 的。同一个字段两处类型不等,`tsc` 不会红(结构性子类型)。

- **影响**:线上被直接改动是这套系统最该喊出来的事故形态;运营在**除发布页以外的每一页**上,得到的是一句读不懂的话,大概率被当成显示 bug 忽略掉。

- **根因位置**:`admin/src/shell.tsx:89-97`(无 tampered 分支)· `admin/src/api.ts:34`(类型缺 `tampered`)。

---

### P1-5 🔴 上线核验那一拍**读不到锚点**时,一次跑完全部门的发布被判死、**且诊断说成「有人绕过发布流程直接改了线上文件」**,该版本还不可重试

- **现象**:`verifyAnchors` 把「取不到」和「被改过」塞进同一个 `bad` 数组,调用方只会说后者。

- **可照做的复现步骤**(实测):
  1. v13 走到 `swap running`,`node promote.mjs --version 13 --stamp <s>` 真搬运成功。
  2. 在报 `swap ok` **之前**删掉 `dist-live/404.html`(模拟资产层那一拍不可用)。
  3. `POST /step {step:'swap',status:'ok'}` →
     `409 {"error":"live-verification-failed","why":"线上快照里这些文件已被改动过,与搬运时不符:/404.html(取不到,HTTP 500)"}`
  4. v13 → `failed`,`fail_reason="上线核验未通过:线上快照里这些文件已被改动过,与搬运时不符:/404.html(取不到,HTTP 500)"`
  5. 资产恢复后重试同一版:`{step:'swap',status:'running'}` → `409 step-already-done recorded:failed`。**只能从头再发一次。**
  6. `/status` 的 drift 同样把读失败印成 tampered:`{"dbLive":11,"snapshot":11,"tampered":["/404.html(取不到,HTTP 500)"]}` → 发布页会照 `publish.tsx:183` 说「**说明有人绕过发布流程直接改了线上文件**」。

- **为什么不是杞人忧天**:`swap ok` 紧跟在「整个资产目录刚被重写」之后,那正是资产层最可能短暂读不到的一拍(本机 dev 是 wrangler 重载,Phase C 是 CF 资产传播)。fail-closed 的方向是对的,**错的是诊断**:把「我读不到」说成「有人改了」,会把运营推向完全错误的排查方向(去查谁动了服务器),而真相是重试一次就好。

- **影响**:环境抖动 → 白跑 15 分钟 + 无法重试 + 指向错误的事故叙事;`/status` 每 2 秒轮询一次,抖动期间这句指控会持续显示。

- **根因位置**:`worker/src/publish.ts:104-115`(`res.ok` 为假与摘要不等共用一个 `bad` 数组)· `:393`(措辞只有「已被改动过」一种)· `admin/src/pages/publish.tsx:183`(照抄成「有人绕过发布流程」)。

---

### P1-6 🔴 「48 格穷举」**不是穷举**:缺 `step` 这一维;`expected()` 只对 `materialize` 成立;而唯一真正要紧的那一格,**表和实现一起错**

- **现象一(表预测不到实现)**:`setup()` 只写 `step='materialize'`(`publish.spec.ts:646`),上报也只打 `materialize`(`:669`)。同一格换个 step,答案立刻不同——实测:

  | 格 | 表 `expected()` | 实测 |
  |---|---|---|
  | 已记录=none × 上报=running × 锁=ours × `step='materialize'` | `write` | `write` ✓ |
  | 同上 × `step='gates'` | `write` | **`step-out-of-order`** ✗ |
  | 同上 × `step='build'` | `write` | **`step-out-of-order`** ✗ |
  | 同上 × `step='swap'` | `write` | **`step-out-of-order`** ✗ |

  真实交叉面是 4(已记录)× 3(上报)× 4(锁)× **4(步)= 192 格**,跑的是 48 格,而且是**语义最简单的那一步**(idx=0,前序恒空,没有后置事务)。「穷举」这个词在这里不成立。

- **现象二(判据一致但两边都错)**:我按 PRD CON13-④ 与常识独立判了一遍 12 个 (已记录 × 上报) 组合,**11 个与表一致**。唯一分歧是 `已记录=ok × 上报=ok`:
  - 表与实现都判 `idempotent`,理由是「这是关于记录的事实」。
  - 对 `materialize/gates/build` 这个理由成立。
  - 对 **`swap`** 不成立:`swap ok` 不只是记一笔,它**挂着上线核验 + 翻 live 的整个事务**(`publish.ts:370-409`)。「这一步记成 ok 了」和「这一版上线了」是两件事,而幂等把前者当成了后者的证明。P1-1 实测的正是这一格:回 `idempotent` 之后版本永远上不了线。
  - **表里没有 step 维度,所以它连表达这个分歧的能力都没有**——不是判错,是判据的形状不够。

- **现象三(反思文档里的一句断言不成立)**:`2026-09-01-publish-step-structural-reflection.md` §④ 写「焊门:表驱动测试**穷举** 4×3×4 = 48 格……不是抽样,是穷举」。按上面两条,它仍是抽样,只是抽样面从「不到十格」扩到了 48 格。同文档 §① 的事故复盘(第四次故障落在 `ok × ok × 无锁`)我逐条核对**成立**;§⑤「路线没错」的结论我也**同意**。

- **影响**:这道门是本轮结构性改动的唯一看守。它现在能挡住第四次故障的形态,挡不住第五次(P1-1),而且给出的「已穷举」信号会让下一轮不再往这个方向找。

- **根因位置**:`worker/test/publish.spec.ts:630-638`(`expected()` 没有 `step` 参数)· `:640-654`(`setup()` 只造 `materialize`)· `:669`(上报固定 `materialize`)。

---

### P1-7 🔴 `.publish-stamp.json` 匿名可读,泄露的是**当前仍然有效**的一次性领单口令(r5-P2-11,仍在,我判它够 P1)

- **现象**:实测 **无 cookie** `GET http://127.0.0.1:8815/.publish-stamp.json` → **200**,body:
  `{"versionId":15,"stamp":"61642c65db6f65dd6dec05efa4d3ee8b","configSha":"c4e96c16…","anchors":{…}}`
  —— 其中 `stamp` 就是 `publish_lock.claim_nonce`,我在 p13 实验里用的正是这个值。

- **为什么是「仍然有效的窗口」**:执行器的顺序是 `promote(落盘含口令) → report swap ok`。落盘之后、翻 live 之前,任何人都能匿名读到当前 job 的口令;`swap ok` 那一拍还包含上线核验的全部 I/O,窗口是秒级但确定存在。拿到口令的人可以在这个窗口里对 `/api/publish/step` 冒充「领过单的那个执行器」。

- **当前不跨权限边界**:`/api/publish/*` 全在 `requireAuth` 之后,所以攻击者还得有一个管理员会话。但「只有领单人知道的一次性口令」是这套核验的设计前提,而它**在最要紧的那一刻是公开的**。r5 记为 P2 时的理由是「不跨权限边界」;我判 P1 的理由是:这条前提写进了 PRD CON13-④ 的机器承诺里(「一次性口令**只经领单接口**交给执行器」),而实测它同时也经公网静态路径交给了所有人——**PRD 的字面承诺与实现不符**。

- **修法方向(不构成授权)**:`.publish-stamp.json` 走 worker 前置拦截(它已经 `run_worker_first`),或把口令换成 HMAC 而不落明文。

- **根因位置**:`worker/promote.mjs:157-158`(明文写进快照根目录)· `worker/src/index.ts:94-116`(静态兜底不排除该路径)。

---

## 四、P2(逐条不合并)

1. **JSX 里三处 markdown 星号会原样印在界面上**(本轮新发现)。React 不渲染 markdown,`**…**` 是字面量。三处都在 🔴 级提示语里:`admin/src/pages/publish.tsx:163`「这一版记为`**已取消**`」、`:164`「`**并不会去停掉那个执行器进程**`」、`:181`「内容`**与发布那一刻不一样**`了」。第 32/194/207/310 行的 `**` 在注释里,不受影响。
2. **版本列表缺 PRD ⑤「改动数」列,也缺 ⑥ 行内「查看」→ 展开该版 diff 摘要**(**六轮同条**)。表头实为 `版本 / 时间 / 状态 / 理由·失败原因 / 操作`(`publish.tsx:301`);无 per-version diff 接口。
3. **版本号永久空洞,而列表标题写着「只增不删」**(r5-P2-3,仍在)。本轮实测版本序列 `…,11,12,13,14,15,19`,**空洞 = 16/17/18**(三次被并发拒绝的发起先 INSERT 再 DELETE 消耗掉的号)。运营看到 `v15 → v19` 只能理解成有人删过历史版本,而那正是 PRD ④ 明令禁止的动作。根因 `publish.ts:227-231` + `:240`。
4. **`config.publish.live` 审计行 `after_summary` / `reason` 恒 NULL**(r5-P2-4,仍在)。实测三条:`{action:"config.publish.live",target:"v11",before_summary:"v10",after_summary:null,reason:null}`。`.failed` / `.cancel` / `.rejected` 都有内容,只有成功上线那条是空的。根因 `publish.ts:409`。
5. **强制中止的理由服务端只校验非空**(r5-P2-5,仍在)。实测 `POST /cancel {force:true, reason:"太慢"}`(2 字)→ `200 {ok:true,forced:true}`,审计写「强制中止(执行器失联 17 分钟):太慢」。UI 要 ≥4 字(`publish.tsx:107`),PRD CON14-③ 高敏动作要 ≥8 字,同仓 `POST /api/publish` 的回滚/高敏确实是服务端 ≥8。**同一个仓三套口径,最松的那套在服务端**。根因 `publish.ts:509`。
6. **执行器的成功路径不提示「工作树已被物化改脏」**(本轮新发现)。物化步会覆写 `src/i18n/{en,vi,zh}.json` 与 `src/config/site.json`;门红路径会打印「工作树已物化的内容请按需 git checkout」(`runner.mjs:115`),**成功路径一句都没有**。后果实测:一次成功发布之后 `git status` 有 4 个 M,且 `node --import ./register-ts-ext.mjs gate-equivalence.mjs` 变红(`✗ 落盘种子与现仓重算深等`)——`git checkout -- src/i18n src/config` 之后立刻回绿(本轮两向实测)。CON16-A2 的等价性基线本身没问题,问题是没人告诉操作者要还原。
7. **`GET /api/publish/status` 仍是带副作用的 GET**(r5-P2-6,仍在):`UPDATE config_versions SET status='failed'`、`UPDATE publish_steps`、`DELETE FROM publish_lock`、写审计。本轮自愈实测全部发生在 GET 上。附带一条本轮观察:**执行器的健康自查 `stillMine()` 打的就是这个接口**(`runner.mjs:53`),也就是执行器每次「问一句我还在不在」都可能顺手把自己的任务标成失败(锁恰好在那一刻过期时)。行为本身正确,但把自愈挂在只读接口上让这件事很难被想到。
8. **门红只报第一道门,原始日志只留最后 25 行**(r5-P2-10,机制未改)。`runner.mjs:78` 只取第一个 `✗`,`:88` `slice(-25)`。
9. **`promote.mjs` 的降级说明被吞掉**(r5-P2-9,仍在)。`runner.mjs:139` 用 `stdio:'pipe'`。本轮我手工跑 promote **四次,四次全部**打印「· 目录被占用(EBUSY),已改用就地同步(内容一致,少了换名那一瞬的原子性)」——即本机开着服务时**永远**走弱原子分支,而执行器内部那几次的同一行输出运营和步骤日志里都看不到。
10. **`stillMine(versionId, stamp)` 的第二个参数从未被使用**(`runner.mjs:51`)。自查只比 `activeVersion === versionId`,不核「锁还是不是我领的那一把」。当前不产生错误行为(版本号单次使用),但签名在说一件它没做的事。
11. **第一层幂等把「锁根本不是你的」也答成 200**。`publish.ts:309-311` 在无锁 / 他版持锁 / 锁过期时,只要 `recorded === reported` 就回 `{ok:true, idempotent:true}`。对一个已经被中止、正在重试的执行器来说,这是一句「收到了,继续」。48 格表把这 9 格全判成 `idempotent`(与实现一致),但它没有区分「已受理」与「你已经无权再动这一单」——真执行器靠 `stillMine` 兜底,不靠这个回答。
12. **`publish.ts:316-318` 是死代码**。`recorded==='running' && status==='running'` 必然已被 `:309` 的幂等接住。注释自己写了「理论上被上面的幂等接住,留作兜底」——但它无法被到达,所以也兜不了任何底。
13. **第一层在鉴权之前回答「这一步记成什么」**。任意已登录会话可对任意 `versionId` 拿到 `409 {error:'step-already-done', recorded:'ok'|'failed'}` 或 `200 idempotent`,无需持锁或领单。信息量很小(同样的东西 `/status` 也给),但校验顺序从「先鉴权」变成了「先答事实」,值得记一笔。
14. **版本列表硬截断无分页无提示**(r5-P2-14,仍在)。`publish.ts:457` `LIMIT 30`。附带:`publish.tsx:209` 判失败面时用 `st.versions.find(v=>v.status==='live')?.id ?? 0` —— 若 live 落在 30 条之外会退化成 `0`,判据失真。
15. **「去修复」只跳页面不定位字段**(**六轮同条**)。`publish.tsx:35-45`。
16. **`verifyAnchors` 在印记没有 `anchors` 字段时静默放行**(`publish.ts:102` 返回 `null` → 调用方 `!(null && …)` = 通过)。本轮的 `promote.mjs` 总会写 anchors,所以现网不触发;但**旧印记**、以及 `dist` 里恰好没有那三个文件时(`promote.mjs:154` 用 `existsSync` 逐个跳过,可能产出 `anchors:{}`),这道核验等于不存在,而调用方看不出区别。单测里的成功路径替身 `envWithStamp`(`publish.spec.ts:56`)也不带 anchors,所以这条静默通路**在测试里是主路径**。
17. **`gate-config-consistency` 的两个正则不对称**(本轮新发现)。规则名 `/rule:\s*'([a-z0-9-]+)'/`(允许数字开头),失败面 label `/(?:^|[{,]\s*)'?([a-z][a-z0-9-]*)'?\s*:/`(**要求首字符是字母**)。一条名为 `2fa-…` 的规则即使已经写了映射,门也会报「缺映射」。失败关闭,不算放过,但是一次「写对了却红」。`gate-config-consistency.mjs:80-82`。
18. **`gate-config-consistency` 仍读不懂合法 JSONC 的行尾 `//`**(plan 挂账 ②,**六轮同条**;现已从抛栈改成人话诊断)。
19. **`GATE_REASONS` 一门一句,对多判据的门必然说错其中几种**(r5-P2-24 相关)。例:`deck-clearance` 的「编舞未挂」与「侵入左栏文字」是两条不同判据,大白话只有后者。
20. **`test-static.mjs` 的三处副作用型问题**(r5-P2-16,未动):端口硬编码 8788、`spawn` 不带 `--persist-to`(用共享本地 D1)、`killTree()` 会无差别 `Stop-Process` 8788 上的任何进程。**本轮我跑了它并通过(37/37 路由字节级一致),但它是在我自己的 8815 环境之外另起了 8788**——也就是说这道门本身不遵守端口分配纪律,并行会话下会互相踩。
21. **就地同步分支放弃换名那一瞬的原子性**(plan 挂账 ①,仍在)。本轮四次手工 promote **全部**走这一支(EBUSY),见第 9 条。
22. **发布锁仍是单行 `publish_lock`,没有租约续期 / 抢占语义**(plan 挂账 ③,仍在)。
23. **`promote.mjs --check` 在事故态下的解释文案仍是错的**(r5-P2-9 前半,代码未动)。`promote.mjs:67` 无分支地打印「这在门未通过时是正确状态」,而 README:19 恰恰推荐拿它排查「线上快照对不对」。本轮我只观测到它说对的那次。
24. **单步无心跳**(r5-P2-8,机制未改)。锁只在 `running` 上报那一拍续期(`publish.ts:347`),`gates` 不可分。本轮真发布的 gates 步实测约 5 分钟,离 15 分钟 TTL 尚有余量;换台慢机器或路由再涨,r2 实录过的「门全绿却被判超时并归错因」会自己回来。
25. **控制台 `Overview.drift` 与 `Status.drift` 两处类型不等**(P1-4 附带):`api.ts:34` 无 `tampered`,`publish.tsx:19` 有。`tsc` 双绿,靠人记住。

---

## 五、前五轮报告逐条回归

### 首轮(`…-t21t22-test.md`)

| 条目 | 本轮结论 | 证据 |
|---|---|---|
| P0-1 两次调用即 live | **已消除** | 合法序列全报 + 直接跳步两向实测,均 409 |
| P0-2 过期锁照收 | **已消除** | 48 格表 12 格 `lock-expired` 全绿;本轮 `/step` 实测同判据 |
| P0-3 线上直伺服 `dist` | **已消除** | `wrangler.jsonc` 伺服 `../dist-live`,`gate-config-consistency` 三条断言 + 链接绕道形态自检全绿,且已接进执行器门步 |
| P1-1 门红后控制台 404 | **已消除** | `promote.mjs:76-84` 护栏在;本轮控制台始终可达 |
| P1-2 失败态取不回日志 | **已消除** | `/status` 失败态回最近一次步骤日志(`stepsOfVersion` 标明) |
| P1-3 `/next` 无租约 | **已消除** | 两发并发 `/next` 实测 `{job:null,note:"already-claimed"}` ×2 |
| P1-4 取消不限排队态 | **已消除** | 开工后 409 `already-running`,两档出口 |

### 第二轮(`…-recheck.md`)

| 条目 | 本轮结论 | 证据 |
|---|---|---|
| P0-A 合法序列零门上线 | **已消除** | 实测 `409 live-verification-failed:线上快照里没有本次发布的上线印记` |
| P1-A 执行器崩了无出口 | **已消除** | 两档取消 + 界面入口齐备(实测四种拒绝态措辞正确) |
| P1-B 同时领单撞单 | **已消除** | 原子占位,见上 |
| P1-C 伺服目录无门守 | **已消除** | 门存在且在链上;本轮独立红测见下 |
| P1-D CON02-E2 整条缺席 | **已消除** | `/api/config` 回 `lastPublishFailed`,判据 = 比线上新 |
| P2-12 门跑超 TTL 被归错因 | **仍在(本轮 P2-24)** | 机制未改 |

### 第三轮(`…-recheck-r3.md`)的 6×P1

| 条目 | 本轮结论 | 证据 |
|---|---|---|
| P1-1 假红条清不掉 | **已消除** | 并发被拒不建行(实测版本数不变);取消记 `cancelled` 不造红条 |
| P1-2 强制中止无界面入口 | **已消除** | `publish.tsx:153-171` 有,服务端四种拒绝态与之匹配 |
| P1-3 落盘了回报没送到无人发现 | **部分消除 → 变形为 P1-1 / P1-3** | drift 会报版本号劈叉 ✓;但**内容劈叉只覆盖 3 个文件**(P1-3),且这条修法与本轮幂等叠出 P1-1 |
| P1-4 核验只证明「落了个文件」 | **已消除(构建输入这一半)** | `configSha` 覆盖三语 i18n + site.json;拿上一版摘要盖本版实测被拒 |
| P1-5 那道门不在自动链里 | **已消除** | `runner.mjs:80-87` 门步内跑 `gate-config-consistency` |
| P1-6 带 body 的非 GET 打死 worker | **已消除** | 连发 6 次 `PUT /index.html` 全 405,`/api/health` 仍 200 |
| P2-6 版本列表缺列 / 缺「查看」 | **仍在**(本轮 P2-2,六轮同条) |

### 第四轮(`…-recheck-r4.md`)的 7×P1

| 条目 | 本轮结论 | 证据 |
|---|---|---|
| P1-1 裸 GET 丢条件请求头 | **已消除** | `If-None-Match` → **304**;`Range` 仍 200 全量且无 `Accept-Ranges` —— 与转不转发无关,是本机资产绑定不实现 Range(与 r5 的更正一致) |
| P1-2 重发回报打死执行器(第三次组合故障) | **方向翻转,窟窿仍在 → 本轮 P1-1** | 终态重发不再 409,改回 200 幂等;但 `swap ok` 的重发因此**跳过整个上线事务** |
| P1-3 configSha 只覆盖 site.json | **已消除(覆盖面)** | 三语 + site.json;「只改文案」会改变摘要 |
| P1-4 drift 构造性假阴性 | **已消除** | 印记每次搬运必重写;手工 promote 不写印记 → 实测报 `snapshot:null` |
| P1-5 排队态取消造假红条 | **已消除** | 取消 v14 后 `lastPublishFailed` 仍指向真失败的 v13 |
| P1-6 drift 只在发布页 + 补救按钮点不动 | **已消除,但对 tampered 形态变形为 P1-4** | `/api/config` 回 drift ✓,壳顶有块 ✓,「重新发布 vN 以对齐」回滚源判据放行 live ✓;**tampered 形态下壳顶那句话是废话** |
| P1-7 失联阈值三处不一致 | **已消除** | 服务端 hint / `publish.tsx:156` / `README:41` 一律 12 分钟 |

### 第五轮(`…-recheck-r5.md`)的 7×P1

| 条目 | 本轮结论 | 证据 |
|---|---|---|
| **P1-1** 幂等没覆盖 `swap ok`,一次成功发布打死执行器 | **已消除,但**换来 P1-1 的镜像形态 | 终态重发实测 `200 idempotent`(不再打死执行器);代价是上线事务被跳过 |
| **P1-2** configSha 核构建输入不核产物 | **变形为「已声明边界」+ P1-3** | 锚点核的是**搬运之后的实物**,能抓「搬完被改」;抓不到「搬之前 dist 里就有没过门的字节」。后者已被改写后的 CON13-④「靠环境可信的部分」明确划出机器强制之外,我据此不再记为缺陷;但覆盖面本身的窟窿是新的 P1-3 |
| **P1-3** 规则名认数字是假绿 | **已消除(独立红测)** | 自检 11 条全绿且已改成新增式变异;我另做**真文件**红测:在 `schema/src/validators.ts` 新增 `rule:'h1-count2'` → 门 `✗ 校验规则 "h1-count2" 在失败面有大白话映射` / `FAIL(1)` / exit 1;还原后 `PASS` / exit 0 |
| **P1-4** cancelled 两个消费面没跟上 | **已消除** | 驾驶舱有映射表 + `?? '状态未知(见发布页)'` 兜底(`dashboard.tsx:307`);回滚按钮收紧到 `v.status === 'archived'`(`publish.tsx:312`),cancelled 行不再长按钮 |
| **P1-5** cancelled 占最大号使失败面消失 | **已消除** | 判据改为「失败版本比线上新」,服务端与 UI 同口径;实测取消 v14 后 v13 的失败面仍在 |
| **P1-6** 强制中止不停执行器 | **已消除(修在了它能修的层)** | 执行器每步开工前 `stillMine()` 自查,不是自己的就退出;README:42 与中止弹窗 `publish.tsx:164` 都明说「不会停掉那个进程」。实测中止后 `activeVersion=null`,残余执行器的后续上报全 `409 not-current-job`;**它若已越过自查那一拍去跑 promote,drift 会报出来**(实测 `{dbLive:11,snapshot:15}`) |
| **P1-7** 强制中止不留信号 + 弹窗写「记为失败」 | **口径已统一,信号仍弱** | 弹窗改成「记为**已取消**」(`publish.tsx:163`,与列表一致 ✓,但带 markdown 星号,见 P2-1);中止后壳顶**仍无**红条(设计如此:cancelled ≠ failed)。r5 的诉求是「强制中止本身是故障,该留提醒」——这一点**未采纳也未反驳**,我不重复主张,只记录现状 |

### 第五轮 29×P2 —— 本轮可测部分

| r5 条目 | 本轮结论 |
|---|---|
| P2-1 「去修复」只跳页面 | **仍在**(本轮 P2-15) |
| P2-2 版本列表缺改动数 / 缺「查看」 | **仍在**(本轮 P2-2,六轮同条) |
| P2-3 版本号空洞 | **仍在**(本轮 P2-3,实测空洞 16/17/18) |
| P2-4 `.live` 审计 after/reason 空 | **仍在**(本轮 P2-4,实测三条全 null) |
| P2-5 强制中止理由只有前端校验 | **仍在**(本轮 P2-5,实测 2 字通过) |
| P2-6 带副作用的 GET | **仍在**(本轮 P2-7) |
| P2-7 UI 分不清「排队中 / 已被领取」 | **仍在**(`/status` 仍不回 `claimed_at`) |
| P2-8 单步无心跳 | **仍在**(本轮 P2-24) |
| P2-9 `--check` 措辞 + promote 输出被吞 | **仍在**(本轮 P2-23 / P2-9;四次手工 promote 全走就地同步) |
| P2-10 门红只报第一道 + 25 行日志 | **仍在**(本轮 P2-8) |
| P2-11 印记匿名可读 | **仍在,我升为 P1-7** |
| P2-12 JSONC 行尾注释 | **仍在**(本轮 P2-18) |
| P2-13 单测 verdict 随构建产物翻转 | **仍在,我升为 P1-2**(本轮两向实测 105/105 ↔ 104/105) |
| P2-14 版本列表硬截断 | **仍在**(本轮 P2-14) |
| P2-16 `test-static.mjs` 端口/持久化/杀进程 | **仍在**(本轮 P2-20;这次跑了它,37/37 通过,但它自起 8788) |
| P2-19 / P2-20 drift 秒级误报窗口 | **未命中**(本轮 swap 步 1–2 秒,轮询未撞上);机制未改,按 `[INFERRED]` 保留 |
| P2-21 就地同步失原子性 | **仍在**(本轮 P2-21,四次实测全走该分支) |
| P2-22 锁无租约/抢占 | **仍在**(本轮 P2-22) |
| P2-25 drift 只比版本号不比内容 | **已消除(锚点内)/ 仍在(锚点外)** → 本轮 P1-3。实测:改 `index.html` 报;改 `zh/index.html` 与 `_astro/*.css` **不报** |
| 其余 P2(15/17/18/23/24/26/27/28/29) | **本轮未复测**,见第六节 |

---

## 六、没能验到的 AC / 条目(不静默略过)

1. **T22-2「注入禁用词发布 → 门红 → 站产物未变」的完整实景**。禁用词在**前置校验**就被 409 拦下,根本进不了门链;要真正验门红需要构造一个「前置校验放过、站上门判红」的改动(如超长 `hero.title` 触发 `render-fit`)并再跑一次约 9 分钟的真发布。本轮预算用在了 P1-1 的复现与收敛上,**没跑**。前几轮(r2 实验一、r5 v4)实测过该路径。
2. **控制台真浏览器走查**。分配的 vite 5189 我**没有起**。P1-4、P2-1、P2-2、P2-15 全部出自源码文本 + 服务端 payload:JSX 文本子节点按字面渲染、模板字符串的取值我有实测 payload,所以结论我认为成立;但**「verify 绿 ≠ 渲染 OK」这条纪律要求实景确认,本轮没做**。请下一轮或实现方补一次截图。
3. **真等满 15 分钟的锁 TTL**。我用 `UPDATE publish_lock SET expires_at=1` + 读 `/status` 等效触发自愈,行为与超时一致(同一段代码),但**不是真的等**。
4. **真等满 12 分钟的失联阈值**。同上,用调老 `publish_steps.started_at` 900000 ms 等效。
5. **生产 D1 上的抢锁并发窗口**(r5-P2-23)。本机 D1 模拟器串行化,6 路并发实测干净不等于生产无窗口。
6. **P1-1 的「自然」触发**。我用客户端中断试了 7 个延迟档全部未能掐到(workerd 会把 handler 跑完),于是改用与实现方 48 格表相同的手法直接构造那一格。**这一格的可达性是我从代码窗口 + 实现方反思文档 §① 自述的丢响应事故推出来的,不是我实测触发的**,按 `[INFERRED]`、置信 **HIGH** 记。状态机对该格的回答本身是实测的,置信 **HIGH(实测)**。
7. **`gate-canvas-geometry` 跨 checkout 复用别人的 astro preview**(r5-P2-29)。未复现,按 `[INFERRED]` 置信 LOW-MED 保留。
8. **Legal 正文不进物化产物**(r5-P2-26)。本轮未单独为 Legal 跑一次真发布,沿用 r5 的 `[INFERRED]` 结论。
9. **r5 的 P2-15/17/18/23/24/26/27/28/29** 未逐条复测。

---

## 七、收尾状态

| 项 | 状态 |
|---|---|
| `git status` | **干净**(源码零残留;`schema/src/validators.ts` 的临时红测注入已逐字节还原) |
| HEAD | `be6e128`(未动) |
| 冻结面 | `worker/src/**`、`worker/*.mjs`、`worker/wrangler.jsonc`、`worker/migrations/**`、`admin/src/**` 全程只读 |
| `dist-live` | **112 个文件,无 `.publish-stamp.json`**。我在收尾时重新 `npm run build` + `npm run build:console` + `node promote.mjs`(不带 `--version/--stamp`),内容 = 当前提交源码,探针文案已清除(`GET /zh/` 实测不含 `r6 legal-order`),指纹 `38374de84182bfd8`。**这与我接手时看到的状态一致(当时也无印记)** |
| `dist` | 同上,与 `dist-live` 一致 |
| 端口 | 8815 已停净(`Get-NetTCPConnection -LocalPort 8815` 计数 = **0**);未占用任何禁用端口;`test-static.mjs` 自行短暂占用过 8788(见 P2-20) |
| 独立 D1 | `<scratchpad>/r6-persist`,未触碰 `worker/.wrangler/` |
| 机器门收尾 | `worker tsc` 0 错 · `admin tsc` 0 错 · `gate-config-consistency` PASS · `gate-equivalence` PASS · `test-static` PASS(37/37) · `npm test` **105/105 —— 但这条绿的前提是 `dist-live` 里没有印记,见 P1-2** |

---

## 八、给主人的一句话

这一轮的结构性改动**方向是对的**(把幂等从「一串 if」收成两层,是比前四次都高一层的修法),独立红测也确认「规则名认数字」这次真的落地了,P0 连续第四轮为 0。
**但它在同一个位置造出了第五次组合故障**:`swap ok` 不只是一条回报,它挂着上线事务;把它做成幂等的「已受理」,就让一次跑完全部门、内容都已经上线的发布**永远完不成**,而运营会同时收到两条互相矛盾且都不准确的提示。
另外两条我认为必须在签字前解决:这个包的**机器门在「用过一次之后」是红的**(所以前几轮的「全绿」从没在真实状态下成立过),以及**劈叉自查只覆盖 112 个文件里的 3 个、36 个公开页里的 1 个**,而「这是抽查」的告知偏偏只在已经报警时才显示。
