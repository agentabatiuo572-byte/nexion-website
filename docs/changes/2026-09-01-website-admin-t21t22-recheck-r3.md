# T21/T22 发布流水线 第三轮验收报告(黑盒 · 独立验收方 · 2026-09-01)

**判决 = 不可签字。**

- **验收对象**:PRD `NexGrid_官网后台PRD_v1.0.md` [FEAT-CON13] 全部 + [FEAT-CON02]-E2(plan 第 90 行明写移交本包)+ CON16 相关;plan `2026-08-31-website-admin.plan.md` T21 / T22 两节
- **被测版本**:`D:\WORKS\PLAN\.wt\w-console`,分支 `pkg/w-publish`,HEAD `601f22c`。验收期间 `worker/src/**`、`worker/*.mjs`、`worker/wrangler.jsonc`、`worker/migrations/**`、`admin/src/**` 全程零写入(收尾 `git status` 仓内新增 = 本报告一份)。
- **环境**:worker `http://127.0.0.1:8797`(分配端口,未换),隔离持久化目录 `worker/.wrangler-r3`(收尾已 Move 出仓);控制台经 worker 同域 `/admin`;真浏览器 Playwright;门红测跑在 `git archive HEAD` 的隔离副本上。
- **执行量**:3 次真发布(成功 / 门红 / 回滚,gates 各 350 s / 361 s / 343 s,全部真跑满 13 门)、8 个人造版本(伪造 / 印记实验 / 取消 / 强制中止 / 步骤守卫矩阵)、660 条站上实况采样、40 条猜测路由 + 9 个未认证探测、`gate-config-consistency` 新断言 9 组变异红测、worker 单测 89/89 + typecheck 0 错 + 三道 worker 门全绿。

**一句话**:上一轮的 **P0-A 已消除**——纯 HTTP 面再也推不出 live(实测伪造序列在 `swap ok` 被 `live-verification-failed` 挡下),P1-B(并发领单)、P2-1(重复 running)、P2-8(指纹瞎)也真修了;但 **P1-A 只修了 API 没修界面**(README 写的「强制中止」按钮在控制台不存在)、**P1-C 焊的门不在任何自动链里**(只有人手敲 `npm run gate:config` 才跑)、**P1-D 的红条修出了一条会说假话的新缺陷**(实测:一次完全成功的发布之后,壳顶仍常驻「上次发布失败」);另外挖出一条本轮修法本身带来的**线上内容与 live 指针劈叉**(promote 已搬运、`swap ok` 没送到 → 界面说「线上保持旧版」,而站上已经是新内容)。合计 **6 条 P1 + 18 条 P2**,**P0 = 0**。

---

## 〇、环境与偏差(先交底)

- 分配端口 8797 全程可用,未退 8799。静态预览 4403 / 控制台 vite 5183 本轮未起(控制台经 worker 同域伺服)。禁占端口 8787/8788/8791/8793/4321/4401/3002/5173/5174/5175/5181 全程零占用;4399 被别的会话占着,我没碰。
- 起服与上一轮同法:`npx wrangler d1 migrations apply nexgrid_site --local --persist-to .wrangler-r3`(0001–**0006** 全 ✅)+ `npx wrangler dev --port 8797 --persist-to .wrangler-r3`。理由同上一轮:npm 脚本把 `--persist-to` 只挂到 `wrangler dev` 上,迁移会落到另一个库;派单禁直跑 `npx wrangler dev` 的**理由是「会跳过迁移」**,我把迁移显式跑在同一个 persist 目录上,理由已被满足。
- **一次由我造成的服务中断,如实交底**:路由审计里的 `PUT /.publish-stamp.json`(带 body)把 wrangler dev 打死了,当时 v3 的门正跑到一半。我在 ~85 s 内重启了服务,执行器靠自身重试续上,v3 最终正常上线。run1 采样里的 27 条非 200 全部落在这段窗口内,**与流水线无关**。这条崩溃本身是一条独立发现(见 P1-6),复现步骤已附。

---

## 一、逐 AC 结论

### T21 · 发布编排

| # | AC(plan 原文口径) | 结论 | 证据 |
|---|---|---|---|
| T21-1 | 前置校验红 → 不进流水线并逐项列出 | **PASS** | 草稿注入 `Guaranteed 20% monthly returns, risk free investment.` → `GET /api/publish/preflight` `ready:false` + 3 条 `forbidden-word` errors;`POST /api/publish` → **409 `preflight-failed`** 且回带 errors 列表;版本表最新三行仍是 `7:failed 6:failed 5:live`,**零新版本行、零锁** |
| T21-2 | 去修复定位 | **FAIL(P2-1)** | 红项每行有「去修复」按钮,但 `fixLink()` 仍返回裸路径(`/content`),内容页无 hash/query 承接 → PRD ⑥「定位到**红字段**」未实现。**三轮同条** |
| T21-3 | 红项自动排除保留草稿 | **PASS(按 PRD 口径)** | v7 门红后 `GET /api/config` 的 `draft.copy.en['hero.title']` 仍是那条超长标题,`dirty=6`,可直接改回再发 |
| T21-4 | 状态机单向且 server 权威 | **PASS(HTTP 面)** | 守卫矩阵 7 种全挡(下表);上一轮的「按顺序全报一遍」现被 `live-verification-failed` 挡下。**但服务端核实的是「印记文件在不在」,不是「门跑没跑」**——见 P1-4 |
| T21-5 | 并发发布 409 | **PASS(带 P1-1)** | 真发布进行中再发 → `409 {"error":"publish-in-progress","heldBy":3}`。代价:留下垃圾 `failed` 行、无审计行,并**触发一条假红条**(P1-1) |
| T21-6 | 锁 TTL 15 分钟超时自动 failed | **PASS** | 把 `publish_lock.expires_at` 拨到 1 → `GET /api/publish/status` 读时自愈把 v6 标 `failed`(`发布中断(执行器无响应或超时),线上保持旧版`)并清锁 |
| T21-7 | 执行器不在线 → 排队态可取消 | **部分 FAIL(P1-2)** | **API 侧全过**:队列态(0 步骤)`POST /cancel` → 200 `已取消(执行器未上线)`;已开工未失联 → 409 `runner-still-alive`;失联 9 分钟 + 无理由 → 400;失联 + 理由 → 200 `forced:true`,审计 #25 带理由。**界面侧不通**:控制台**没有任何「强制中止」控件**(真浏览器实测 0 个),`cancel()` 从不发 `force`;README:40 描述的按钮不存在 |
| T21-8 | 不存在绕门发布 API(路由审计) | **PASS(HTTP 面)** | 40 条猜测路由(含 `/publish/live`、`/force`、`/promote`、`/stamp`、`/publish/next` 的 POST、版本行 DELETE/PATCH/PUT、`/api/audit` 增删改)**全 404**;7 个发布入口 + `/api/config*` 未认证**全 401**;唯一非 404 的是静态层的 `PUT/POST /.publish-stamp.json`(405/500,写不进去,但会打死服务 → P1-6) |

**`/step` 守卫矩阵(HTTP 实测)**

| 上报 | 响应 |
|---|---|
| `materialize running` ×2 | 200 → **409 `step-already-started {at:"running"}`** |
| 已 ok 的步骤再报 `running` | **409 `step-already-started {at:"ok"}`**(上一轮 P2-1 已消除) |
| 已 ok 的步骤再报 `ok` | 409 `step-already-done` |
| 冒名 `versionId:9999` | 409 `not-current-job` |
| 非法 step(`deploy`)/ 非法 status(`done`) | 400 `bad-request` |
| 跳步 `build running` | 409 `step-out-of-order {missing:["gates"],expected:"gates"}` |
| 直接 `swap ok` | 409 `step-out-of-order {missing:["gates","build"]}` |
| 合法顺序全报一遍的 `swap ok` | **409 `live-verification-failed`** ← 本轮修法的承载点 |

### T22 · 执行器 + 失败面 + 版本/回滚

| # | AC | 结论 | 证据 |
|---|---|---|---|
| T22-1 | 执行器按 §5.4 领任务 → 物化 → 全门 → build → 上新 → 回报 | **PASS** | 两次真成功:v3(materialize 0 s / gates **350 s** / build 3 s / swap 1 s)、v10(gates **343 s**);印记随 promote 落盘并被服务端回读核实通过 |
| T22-2 | 任一门红 → failed + **线上保旧版(实测站产物未变)** | **PASS** | v7 注入超长 `hero.title` → `render-fit` 红(361 s)。**200 次采样站上首页指纹恒为一个值 `aa37871301`、标记词 `R3GATERED` 命中 0 次、`/admin` 非 200 次数 0**;门红那一刻 `dist` = 109 文件 / `703284247b9fd08c`(astro build 清空过 `dist/admin`),`dist-live` = 112 文件 / `76a21296b2299711` —— 未过门产物真的没被搬过去 |
| T22-3 | 失败面 = 门名 + 大白话 + 原始日志折叠 | **PASS** | 真浏览器:`上次发布失败(v7):新文案把版面挤破了(行压行 / 文字钻到导航底下 / 窄屏字号反向变大)(门:render-fit)` + 「查看原始日志」展开 25 行 `<pre>`,含 `[verify] ✗ render-fit(运行时)` 与两条实测撞行数据;**登录后 console error = 0** |
| T22-4 | 映射表覆盖 13 门,缺项显门名原文 | **PASS** | `GATE_REASONS` 13 键 ↔ `scripts/verify.mjs` 实产 13 门逐一对齐(实跑输出 `[verify] 12/13 gates pass`);`✗ anchor-check(src 近似)` 这类带后缀的门名被 `/✗\s+([a-z0-9-]+)/i` 正确截成 `anchor-check`;`explainGate` 兜底显原文 |
| T22-5 | 版本列表 append-only | **PASS(带 P2-5)** | 无任何删改版本路由(3 种方法全 404);版本号只增(v1→v11)。缺 PRD ⑤ 的「改动数」列与 ⑥ 的行内「查看」→ diff 摘要(实景表头只有 `版本 / 时间 / 状态 / 理由·失败原因 / 操作`) |
| T22-6 | 回滚走完整门链生成新版本(实测站产物=旧内容) | **PASS** | `POST /api/publish {fromVersion:1}` → **v10**,四步齐全(gates 343 s),站上响应体在 `build:ok → swap:ok` 那一拍从 `aa37871301` 变回 **`740d0a85ba` = 我开工时记录的基线指纹**;**v1 仍 `archived`(未被复活)**;理由 <8 字 / 无理由 → 400 `reason-required`,`fromVersion:9999` → 404。**附带印证 CON16-A2**:回滚物化出的 `src/i18n/{en,vi,zh}.json` + `src/config/site.json` 与仓内提交**逐字节一致**(`gate:equivalence` 三个 ✓ 逐字节 + `git diff --stat -- src/` 空) |
| T22-7 | 审计 | **部分 PASS(P2-2 / P2-3 / P2-7)** | 逐版本审计行:`v2 [publish, publish.failed]` `v3 [publish, publish.live]` `v5 [publish, publish.live]` `v7 [publish, publish.failed]` `v8 [rollback, publish.cancel]` `v9 [publish, publish.cancel(带理由)]` `v10 [rollback, publish.live]`。**缺口**:`v4`(被并发拒绝)**一行都没有**;`v6`(自愈标 failed)**只有发起行、没有失败行**;`.live` 行 `reason` 恒 NULL |

### 移交进本包的 AC

| # | AC | 结论 | 证据 |
|---|---|---|---|
| CON02-E2 | 上次发布 failed → 进入任意页状态条红条,点击 → /publish | **FAIL(P1-1)** | **机制已实现**(真浏览器 `/`、`/content`、`/publish`、`/audit` 四页红条全在 + 「去看详情」跳 /publish)。**但内容会说假话**:v3 成功上线后,红条仍常驻显示「上次发布失败(v4):有发布正在进行 线上仍是 v3,未受影响。」——v4 根本没发布过 |
| CON16-AC4 | schema 版本漂移拒绝面 | **未接线(同上轮)** | 见第七节 |

### 被改动的门(红绿两向)

| 门 | 正对照 | 红测(真实事故形态) | 结论 |
|---|---|---|---|
| `gate-config-consistency`(伺服目录新断言) | exit 0;`--self-test` **7/7** | 真改 `wrangler.jsonc`:`../dist` → **exit 1**(两条断言同时红) · `../dist/` → exit 1 · `./../dist` → exit 1 · `../DIST` → exit 1 · `../dist-published` → exit 1 · **`../dist-live/../dist` → exit 0(漏)** | **基本守得住,有一条构造性漏网**:判据是字符串比较,不是路径解析;`path.resolve('worker','../dist-live/../dist')` = `<root>\dist`,即 P0-3 可原样复活而门全绿(P2-9) |
| `gate-config-consistency`(失败面映射双向断言) | 18 条规则 ↔ 18 条映射全绿 | 真删 `'encoding-damage'` 映射 → **`✗ 校验规则 "encoding-damage" 在失败面有大白话映射` / FAIL** | **守得住**。局限:抓规则用 `/rule:\s*'([a-z-]+)'/`,只认字面量;哪天有人写 `rule: someVar` 就静默漏(P2-16) |
| `gate-config-consistency`(整体) | — | 加一条**合法的行尾 `//` 注释** → 仍然 `JSON.parse` 抛栈、无诊断行 | **T23 挂账 ② 仍在**(P2-10) |
| `promote.mjs --check`(指纹改内容摘要) | dist ≡ dist-live 时 `✓ 一致` | **等长改写** `dist/index.html`(`<!DOCTYPE html>` ↔ `<!doctype html>`,字节数不变)→ `dist 40871840b9e2fb51` vs `dist-live fd895d560fdcc1b7`,报「两者不同」 | **上一轮 P2-8 已消除**。遗留:那句解释文案在事故态下仍是错的(P2-15) |
| worker 单测 / 类型 / 其它门 | — | `npm test` **89/89 passed(9 files)** · `tsc --noEmit` 0 错 · `gate:beacon` exit 0(gzip 1477 B / 37 页各 1 份)· `gate:equivalence` exit 0(6 判全 ✓) | 与实现方自报一致 |

---

## 二、P0

**本轮未发现 P0。**

为让主人能自己判断覆盖面,把我穷举过、结论是「挡住了」的路径列在这里(全部是 HTTP 面实测,不是读码推断):

| 尝试 | 结果 |
|---|---|
| 合法顺序把四步各报一遍(上一轮 P0-A 原样) | `swap ok` → **409 `live-verification-failed`**,v2 标 failed,`live` 仍 v1,站上无变化 |
| 印记指向别的版本(盘上留着 `{versionId:999}`) | 409,`why:线上快照的印记指向 v999,不是本次要上线的 v2` |
| 无印记(把文件删掉) | `readLiveStamp` 拿到 404 → null → fail-closed 拒绝 |
| 先 `GET /next` 领单拿到口令再报四步 | 口令拿得到(它就在响应体里),但**写不进文件系统**,`swap ok` 仍 409 |
| 陈年印记复用(上一次成功发布留下的 `{versionId:N, stamp:nonce_N}`) | 版本号与口令都对不上下一版,409 |
| 版本号张冠李戴(`versionId` 冒名 / 跨版本) | 409 `not-current-job`(锁只认当前版本) |
| 跳步 / 补报 / 重复收口 / 重复 running / 过期锁 | 全 409(矩阵见上) |
| 回滚路径(`fromVersion` 指 live / failed / 不存在) | 都得走完整门链才可能 live,绕不过印记核验 |
| 40 条猜测的绕门路由 + 7 个未认证入口 | 全 404 / 全 401 |
| 并发 `/next` ×4 同时到达 | 只有 1 个拿到 job(原子占位生效) |

**判据说明**:PRD CON13-④「不存在该 API」这条承诺,在**纯 HTTP 面上现在成立**——上线依赖一件 HTTP 调用者做不到的事(往文件系统落一个文件)。它**不**等于「不跑门就上不了线」,后者见 P1-4。

---

## 三、P1(逐条不合并)

### P1-1 🔴 CON02-E2 红条会为「根本没发生过的失败」报警,而且一次成功发布**清不掉它**

**现象**:v3 完整跑完 13 门、成功上线;控制台四个页面全部常驻红条:

```
上次发布失败(v4):有发布正在进行　线上仍是 v3,未受影响。 [去看详情]
```

v4 不是一次失败的发布——它是一次**被锁拒绝的发起请求**(409 `publish-in-progress`),流水线一步都没跑。`/publish` 页的失败面同时也被它顶掉,显示同一句话,真正该看的东西(上一次真失败的日志)被挤掉。

**复现(照做即可)**
```
1. 发起一次真发布            POST /api/publish            -> 200 {versionId: 3}
2. 趁它在跑,再点一次发布      POST /api/publish            -> 409 {"error":"publish-in-progress","heldBy":3}
                                                            ← 服务端已经先 INSERT 了 v4 再抢锁,于是留下一行 status=failed
3. 等第一次发布成功           versions: 4:failed  3:live
4. GET /api/config           -> lastPublishFailed = {"id":4,"reason":"有发布正在进行"}
5. 打开控制台任意页            -> 壳顶红条常驻(实景已在 /、/content、/publish、/audit 四页留证)
```

**为什么清不掉**:判据是 `SELECT ... WHERE status='failed' AND id > <live.id>`。v4(id 4)永远大于 v3(id 3),所以**这次成功发布之后红条不会消失**;要清掉它,得再成功发布一次、拿到 id > 4 的版本号——而运营完全不知道自己需要这么做,界面上也没有任何提示或关闭入口。(我后来发布 v10 时红条确实清了,`lastPublishFailed = null` ——恰好因为那次的 id 比所有垃圾行都大。)

- **影响**:CON02-E2 的语义是「**上次发布失败**」。现在最容易触发它的动作是「运营等得不耐烦多点了一次发布」——一个完全正常的操作,换来一条谁也关不掉的、内容为假的红色告警。告警一旦学会说谎,下次真失败时就没人信了。
- **两条各自正确的东西合起来出的问题**:`worker/src/publish.ts:146-156`(先 INSERT 版本行再抢锁,抢不到就把它标 failed —— 上一轮 P2-5,一直被当琐碎)+ `worker/src/config.ts:71-75`(本轮新增,把「比线上新的 failed 版本」一律当成待处理的失败)。第一条单看是噪声,第二条单看是对的,合起来就成了假告警。
- **根因位置**:`worker/src/config.ts:73-75`(判据)· `worker/src/publish.ts:146-156`(垃圾行的产地)· 呈现面 `admin/src/shell.tsx:88-95` 与 `admin/src/pages/publish.tsx:130`。
- **附带**:红条正文写死了「线上仍是 v{N},**未受影响**」。这句话在 P1-3 那个形态下是假的(线上其实已经被换过了),红条无从知道,却把它当成事实印出来。

### P1-2 🔴 强制中止只做了 API,控制台没有这个按钮;README 写的操作步骤在界面上不存在

上一轮 P1-A 是「执行器崩在半路 → 领不到、取消不了、重发也 409,只能干等 15 分钟」。本轮加了 `force` 档,**服务端这一层我逐条验过、全对**(见 T21-7)。但**运营碰不到它**:

- 真浏览器实测 `/publish` 页:`button:has-text("强制中止")` **count = 0**;唯一的取消按钮是 `admin/src/pages/publish.tsx:126`,渲染条件 `st.steps.length === 0` ——**执行器一开工它就消失**,正是需要出口的那一刻。
- `admin/src/pages/publish.tsx:88-91` 的 `cancel()` 是 `api('/api/publish/cancel', { method: 'POST' })`,**不带 body**,因此永远走不到 `force` 分支;catch 里给的提示是「无法取消:已有步骤开始执行」——把死路当成正常反馈。
- `worker/README.md:40-41` 现在写着「处理方式:**在发布页点「强制中止」**——执行器超过 8 分钟没有动静才允许,且必须写明理由」。上一轮 README 里那句「重启会自动接管」被判为假话并改掉了,这一轮换了一句**同样不成立**的话:那个按钮不存在。

- **影响**:P1-A 描述的运营困境**原样保留**——本机开发下执行器被掐断是常态(README:38 自己写的),掐断之后运营在界面上仍然只有「等 15 分钟」。修法存在,但存在于运营够不着的地方。
- **根因位置**:`admin/src/pages/publish.tsx:88-91`(不发 force)、`:122-127`(按钮渲染条件)· `worker/README.md:40-41`(文档描述了不存在的界面)。

### P1-3 🔴 promote 已经把新内容搬上线、`swap ok` 没送到 → 界面说「线上保持旧版」,而站上已经是新内容;系统没有任何一处能发现这件事

**现象**:`promote.mjs` 是**先动文件系统、后拿服务端批准**。这两件事之间只要断一下(执行器被掐、进程崩、网络断),就得到一个**数据库说失败、站上已经换了**的状态,而失败文案恰好在说反话。

**复现(照做即可;需要一个合法会话 + 能跑 promote 的机器,但**触发者不必是攻击者——正常执行器死在这一拍就是这个形态**)**
```
POST /api/publish                                  -> 200 {versionId: 6}
GET  /api/publish/next                             -> 拿到 stamp
POST /api/publish/step  materialize running/ok
POST /api/publish/step  gates       running/ok
POST /api/publish/step  build       running/ok
POST /api/publish/step  swap        running        -> 200
node promote.mjs --version 6 --stamp <stamp>       -> ✓ 已上线(dist-live ← dist)
                                                      此刻 curl / 已经能看到新内容
（不发 swap ok —— 模拟执行器死在这一拍）
UPDATE publish_lock SET expires_at = 1             -> 模拟锁到期
GET  /api/publish/status                           -> 读时自愈

结果:
  v6            = failed,fail_reason「发布中断(执行器无响应或超时),**线上保持旧版**」
  GET /api/config -> liveVersion = 5
  curl /          -> 新内容(标记 R3ORPHANBYTES 命中)          ← 站上其实是 v6
  curl /.publish-stamp.json -> {"versionId":6,...}            ← 印记也说是 v6
  控制台          -> 红条「上次发布失败(v6)… 线上仍是 v5,未受影响。」
```

- **影响**:①「线上保持旧版」这句给运营的话是假的;② 数据库的 `live` 指针与实际伺服的快照劈叉,**没有任何一处会发现或修复**——`/status` 的自愈只改版本状态,不回滚 `dist-live`,也不比对印记;③ 之后所有「线上 vN」「与线上一致」「dirty=0」的判断都建立在错的指针上。
- **我为什么没定 P0**:honest 流程下被 promote 搬上去的那份内容**是过了门的**(执行器只在 gates+build 之后才跑 promote),所以这不是「未过门内容上线」;它是「原子性与诚实性」的破口。若主人按 CON13-④「**永不部分上线(原子切换)**」的绝对措辞读,这条就是那条被打破的承诺。
- **窗口有多大**:promote 到 `swap ok` 之间,本机实测约 1 s。但这正是 `runner.mjs` 里唯一会长时间阻塞后再回报的位置,而 README:38 自己写着「工具类超时会掐断执行器」。
- **根因位置**:`worker/promote.mjs:125-142`(先落盘)与 `worker/src/publish.ts:249-278`(后核验、后翻 live)之间没有补偿动作;`worker/src/publish.ts:291-299` 的自愈只改状态、不管快照。

### P1-4 🔴 上线核验证明的是「有人往文件系统落了一个文件」,不是「门跑过了」;版本内容与线上内容之间**至今没有任何绑定**

**复现(需要合法会话 + 构建机 shell;不是纯 HTTP,故按派单口径不计 P0)**
```
1. 改草稿:trust.card5 = "...checked on R3STAMPCONFIG site."   （这段文案只进配置)
2. POST /api/publish                          -> v5
3. GET  /api/publish/next                     -> stamp
4. 四步全报 running/ok（**一道门都没跑**）
5. 在 swap running 之后,往 dist/index.html 里塞一段任何门都没见过的字节 R3UNGATEDBYTES
6. node promote.mjs --version 5 --stamp <stamp>
7. POST /step swap ok                         -> **200**

结果:
  versions            5:live 4:failed 3:archived        ← 一道门没跑,版本上线
  publish_steps       四步齐全,与真发布同形
  curl / 含 R3UNGATEDBYTES ?   -> true    ← 线上是没过门的字节
  curl / 含 R3STAMPCONFIG  ?   -> false   ← 线上**不是** v5 声称的内容
  GET /api/config     -> liveVersion=5, dirty=0, changedPaths=[]
  控制台状态条        -> 「与线上一致」;发布页 -> 「没有待发布的改动」
```

- **这条要说的不是「攻击者能怎样」**(那需要机器权限,已按派单降级),而是**核验的语义边界**:服务端核的是印记里的 `versionId` + 一次性口令,**从不核实 `dist-live` 的内容是否等于该版本的配置**。于是:
  - 任何让 `dist` 与「该版本物化产物」脱节的原因(执行器 bug、门与 build 之间有人碰了 `dist`、手工操作顺序错、P1-3 的孤儿快照)都会得到「DB 说上线成功、站上是别的东西」,而**系统一律判绿**;
  - 运营被锁进假状态:`dirty=0`、发布按钮因 `ready:false` 禁用、`POST /api/publish` 回 `no-changes`(`worker/src/publish.ts:140`),**界面上没有任何异常信号**,只有内容是错的。
- **可核的替代判据**(仅供参考,不是验收要求):印记里带上该版本物化产物的内容摘要,服务端标 live 前比对;或服务端自己回读 `dist-live` 里一两个由该版配置决定的 key。
- **根因位置**:`worker/src/publish.ts:254-256`(核验条件只有 versionId + nonce)· `worker/promote.mjs:111-118`(印记内容里没有产物摘要)。

### P1-5 🔴 P1-C 焊的那道门**不在任何自动链里**——只有人手敲 `npm run gate:config` 才会跑

上一轮 P1-C 是「伺服目录这条修法没有门守着」。本轮确实加了断言,而且**红测过得去**(七组变异里六组正确变红)。但全仓 grep 之后:

```
"gate:config" 只出现在 worker/package.json:18(脚本定义)与 docs/ 里的历史报告。
- worker `npm test`（vitest）不跑它
- 站仓 `npm run verify`(发布流水线里执行器跑的那条 13 门链)不跑它
- 没有 CI / hook / 任何 npm 复合脚本调它
```

- **影响**:被守的东西(`assets.directory`)一旦被改错,**发布流水线自己不会红**——执行器跑的是站仓 13 门,里面没有这道门。也就是说 P0-3 的复活形态仍然能一路走到 live,只要没人恰好手敲了那条命令。上一轮的结论「P0-3 的修法只是一行配置,不是一道门」现在变成「是一道门,但没接电」。
- 这正是本仓 memory 里那条 [新门链架空旧门链 + 新建测试天然成孤儿] 的形态:门写对了,链没接。
- **根因位置**:`worker/package.json:18`(只有脚本定义,无调用方)。

### P1-6 🔴 未认证的、带 body 的 `PUT`/`POST` 打任意静态路径 → workerd 抛未捕获异常,两次即把本机 worker 打死(实测中真的弄断过一次进行中的发布)

**复现(100% 稳定,两轮各复现一次)**
```
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8797/api/health     -> 200
curl -X PUT  -H 'content-type: application/json' -d '{"a":1}' http://127.0.0.1:8797/index.html   -> 405   （health 变 500）
curl -X PUT  -H 'content-type: application/json' -d '{"a":1}' http://127.0.0.1:8797/             -> 405   （health 变 000）
curl -X POST -H 'content-type: application/json' -d '{"a":1}' http://127.0.0.1:8797/             -> 000   （进程已退出）

wrangler 日志:
  X [ERROR] Uncaught TypeError: Can't read from request stream after response has been sent.
  ▲ [WARNING] NOSENTRY reporting trace with exceptions, but no exception outcome; ... FetchEventInfo: PUT, /
  X [ERROR]
  If you think this is a bug then please create an issue at https://github.com/cloudflare/workers-sdk/issues
  🪵 Logs were written to ...   ← 进程退出
```

- **不需要任何认证**(静态兜底层在 `requireAuth` 之外)。
- **实测后果**:我在做路由审计时无意触发,当场把正在跑 v3 门链的 worker 打死;执行器随后的回报全部落空,靠它自己的重试才在我重启服务后续上。若发生在无人值守的时刻,就是一次发布白跑 + 版本挂在 `publishing` 直到锁超时。
- **这条不是本轮改动引入的**(静态兜底是 T3 的面,`app.all('*') → ASSETS.fetch(c.req.raw)`),但它直接影响 T21/T22 的可用性承诺(CON13-E4「不静默吊死」),所以在这里报。生产 Workers 的语义与本机 dev 不同(单请求异常不会拖垮 isolate),但那条 `Can't read from request stream` 会让所有带 body 的非 GET 静态请求变成 5xx,仍需处置。
- **根因位置**:`worker/src/index.ts:81-83`(把带 body 的原始 Request 直接交给 ASSETS,没有先按方法收口)。

---

## 四、P2(逐条不合并)

1. **「去修复」只跳页面不定位字段**(**三轮同条**)。PRD ⑥ 要求「对应内容页 → 定位到红字段」;`admin/src/pages/publish.tsx:29-39` 的 `fixLink()` 返回裸路径,内容页无 hash/query 承接。
2. **被并发/锁拒绝的发起仍留下 `failed` 版本行,且没有对应审计行**(**三轮同条**,现已升格为 P1-1 的产地)。实测 `v4` 在 `audit` 表里一行都没有。根因 `worker/src/publish.ts:146-156`(先 INSERT 版本再抢锁)。
3. **自愈把版本标 `failed` 时不写审计**(上一轮新发现,仍在)。实测 v6 只有 `config.publish` 发起行,没有 `.failed` 行。T23 的审计覆盖测试若只遍历「动作字典」而不遍历「状态迁移」,这一类会整片漏掉。根因 `worker/src/publish.ts:291-299`、`:58-63`。
4. **回滚源不限状态,且比上一轮更宽**(上一轮 P2-6,仍在)。实测 `fromVersion: 7`(一个**门红过、从未上线**的版本)→ 200,建出 v8。UI 只给 `archived` 行按钮(实景:只有 v1、v3 有「回滚到此版」),API 不拦。仍走完整门链,故非绕门。根因 `worker/src/publish.ts:126`(SELECT 无 status 过滤)。
5. **版本列表缺 PRD ⑤ 的「改动数」列,也缺 PRD ⑥ 的行内「查看」→ 展开该版 diff 摘要**(上一轮新发现,仍在)。实景表头 `版本 / 时间 / 状态 / 理由 · 失败原因 / 操作`;`/api/config/versions` 只回列表字段,无 payload/diff 接口。
6. **门红只报第一道门 + 原始日志只留最后 25 行**(**三轮同条,机制未改**)。`worker/runner.mjs:57` 抓第一条 `✗`,`:58` 取 `slice(-25)`。本轮样本恰好单门红且详情落在尾部 25 行内,**又一次没触发**;多门同红或红门靠前时会原样重演。
7. **终止类审计行不带理由**(上一轮 P2-8,**部分修**)。强制中止那条现在带理由了(审计 #25);`config.publish.live` / `.failed` 的 `reason` 仍恒 NULL。
8. **单步无心跳,而 8 分钟「失联」阈值离实测门耗时只剩 2 分钟余量**。锁只在 `running` 上报那一刻续期(`worker/src/publish.ts:226`),`gates` 是不可分的一步,本轮实测 **343 / 350 / 361 s**。`RUNNER_SILENT_MS = 480 s`:门耗时一旦过 8 分钟(换台慢机器、路由或视口档位再涨),`POST /cancel` 就会在**执行器完全健康**的时候回「执行器已超过 8 分钟没有动静,可带 force 与理由强制中止」——把运营往「掐掉一次正在正常跑的发布」上引。上一轮 P2-12 的另一半(15 分钟 TTL 判超时并归错因)机制同样未改。
9. **新的伺服目录断言比的是字符串不是路径**:实测 `"directory": "../dist-live/../dist"` → 门 **exit 0**,而 `path.resolve('worker','../dist-live/../dist')` = `<root>\dist`,即上一轮那场 P0-3 事故可原样复活、门全绿。`/dist-live/` 这个字面量也让门自带了一份路径知识(改名快照目录即误红)。根因 `worker/gate-config-consistency.mjs:52-58`。
10. **`gate-config-consistency` 遇到合法的行尾 `//` 注释仍直接抛栈崩溃**(T23 挂账 ②,仍在)。实测给 `wrangler.jsonc` 加 `"ENVIRONMENT": "dev",   // 上线改 production` → 抛 SyntaxError、无诊断行。失败关闭不算放过,但对改配置的人是一次无法归因的红。根因 `worker/gate-config-consistency.mjs:18`。
11. **`GET /api/publish/next` 本轮变成了带副作用的 GET**(原子占位写 `claimed_at`),而会话 cookie 是 `SameSite=Lax`——一次顶层导航(点一个链接)就会带上 cookie 把当前排队的任务领走,真执行器随后只能拿到 `already-claimed`。后果可恢复(此时 `steps.length===0`,取消按钮还在),但 T23 挂账里「带副作用的 GET」清单要 **+1**,且这一条不是 `ensureInit` 那种幂等播种,是**一次性、不可逆**的占位。根因 `worker/src/publish.ts:170-183`。
12. **`.publish-stamp.json` 对公网匿名可读**。实测 `curl http://127.0.0.1:8797/.publish-stamp.json`(无 cookie)→ 200,回 `{"versionId":10,"stamp":"2805322566ad86d41359ee296d284a02","at":...}`。口令在被写进去时已经用掉,直接危害低;但把一次性凭证写进对外伺服目录、且不加 `.assetsignore` 之类的排除,是个会随环境变化翻车的设计(它同时也向公众泄露内部版本号)。
13. **`/api/publish/step` 与「领单」完全不绑定**。实验 A 全程**没有调用过 `/next`**,8 次 `/step` 全部 200 —— `claimed_by` 记了但从不校验,`claim_nonce` 也只在 swap 那一步用。于是原子占位保护的只有 `/next`,任何持会话的第二方(或一次 CSRF)都能替正在跑的执行器把步骤收口,真执行器随后吃到 `step-already-done` 而退出。根因 `worker/src/publish.ts:197-236`(校验里没有任何一条是「你是不是领单人」)。
14. **UI 分不清「排队中」和「已被领取」**。`/status` 不回 `claimed_at`(本轮新加的列),发布页仍靠 `st.steps.length === 0` 判队列态,于是「已领取、正在物化但还没报第一步」这一小段时间里,界面写着「执行器**尚未领取任务**」并给出取消按钮;此刻取消会把锁删掉,执行器下一句 `materialize running` 收 409 退出。窗口小、可恢复,但新加的数据恰好能解决这个诚实性问题却没被用上。
15. **`promote.mjs --check` 的解释文案在事故态下仍是错的**(上一轮同条)。两者不同时一律打印「构建产物尚未提升上线,**这在门未通过时是正确状态**」——`--check` 恰恰也是 README:19 推荐用来排查「线上快照对不对」的手段,而事故态下这句话是安慰剂。根因 `worker/promote.mjs:67`。
16. **失败面映射的双向断言只认字面量规则名**。`/rule:\s*'([a-z-]+)'/` 扫 `validators.ts`;当前 18 条规则全是字面量(已逐条核对),断言成立;但哪天有人写成 `rule: someVar` 或模板串,门会静默少数几条而依旧全绿——「只扫定义面」的老形态。根因 `worker/gate-config-consistency.mjs:64`。
17. **`syncInPlace()` 会保留上一版的印记文件**。`worker/promote.mjs:103` 的 `want.add(STAMP)` 让就地同步分支不删旧印记(换名分支会删),于是「手工 `node promote.mjs` 换内容 + 旧印记留着」是可达状态。当前判据下不构成绕门(旧口令对不上新锁),但印记与内容可以不同源这件事本身,和 P1-4 是同一族。
18. **控制台登录前有 3 条 401 console error**(`/api/config` 等在未登录时被拉了一次)。登录后 console error = 0。观察项,不影响功能。

---

## 五、前两轮报告逐条回归

### 第二轮(`...-t21t22-recheck.md`)

| 上一轮条目 | 本轮结论 | 证据 |
|---|---|---|
| **P0-A** 合法顺序 8 次请求即可 live,痕迹与真发布同形 | **已消除** | 同一序列现在在 `swap ok` 被 409 `live-verification-failed` 挡下,v2 标 failed、`live` 仍 v1、站上无变化;印记版本号/口令两种伪造形态也各自被拒。**注意语义边界**:挡住的是「HTTP 面上不了线」,不是「不跑门上不了线」(P1-4) |
| **P1-A** 执行器崩在半路 = 15 分钟无出口,README 那句已成假话 | **变形为新问题(P1-2)** | API 出口做全了(实测四态全对、审计带理由);**界面上没有这个按钮**,`cancel()` 从不发 `force`;README 换了一句同样不成立的话(「在发布页点强制中止」) |
| **P1-B** 两个执行器同时轮询领到同一单 | **已消除** | 4 路并发 `GET /next` 同时到达,只有 1 路拿到 job,其余 `already-claimed`;条件更新 `claimed_at IS NULL` 生效。**但 `/step` 没跟着绑定领单人**(P2-13) |
| **P1-C** 伺服目录无门守,一个 token 就能放回 P0-3 | **部分消除 / 变形(P1-5、P2-9)** | 门写了、红测六向正确;但**门不在任何自动链里**,发布流水线跑的 13 门里没有它;且 `../dist-live/../dist` 这种写法判绿 |
| **P1-D** CON02-E2 整条缺席 | **变形为新问题(P1-1)** | 红条真渲染了(四页留证)+ 「去看详情」跳 /publish;**但会为「被拒绝的发起」报假警,且一次成功发布清不掉** |
| **P2-1** 已 ok 的步骤可重复报 running、每报一次续锁 | **已消除** | 409 `step-already-started {at:"ok"}` / `{at:"running"}` 两态实测 |
| **P2-2** 被拒发起留 failed 行 + 无审计行 | **仍在**(且后果变重) | v4 无任何审计行;现在还会触发 P1-1 的假红条 |
| **P2-3** 自愈标 failed 不写审计 | **仍在** | v6 只有发起行 |
| **P2-4** 回滚源不限状态 | **仍在**(更宽) | `fromVersion:7`(门红版本)→ 200 |
| **P2-5** 「去修复」只跳页面 | **仍在** | `fixLink()` 逐字未变 |
| **P2-6** 版本列表缺改动数列 / 缺「查看」 | **仍在** | 实景表头留证 |
| **P2-7** `RULE_LABEL` 死键 `all-hidden-sku` | **已消除,且焊了门** | 死键已删;新增双向断言,真删一条映射会红(实测) |
| **P2-8** promote 指纹对等长改写是瞎的 | **已消除** | 等长改写后 `--check` 报两者不同(实测) |
| **P2-9** 只报第一道红门 + 25 行日志 | **仍在(机制未改)** | `runner.mjs:57/58` 逐字未变;本轮样本又一次恰好没触发 |
| **P2-10** JSONC 行尾 `//` 让门崩 | **仍在** | 隔离副本实测抛栈 |
| **P2-11** 终止类审计行不带理由 | **部分修** | 强制中止带上了;`.live` / `.failed` 仍 NULL |
| **P2-12** 单步无心跳 → 门全绿也可能被判超时并归错因 | **仍在,且多一条新后果** | 机制未改;新增的 8 分钟失联阈值离实测门耗时(343–361 s)只剩约 2 分钟余量(P2-8 条) |
| **P2-13** 抢锁三段无事务(理论) | **仍是观察项** | 本机 D1 模拟器串行化,未复现;本轮未新增此路径的实验 |

### 第一轮(`...-t21t22-test.md`)里第二轮已判「已消除」的各条

第二轮已逐条回归并留证(P0-2 过期锁、P0-3 门跑期间线上被换、P1-1 门红后控制台 404、P1-2 失败态取不回日志、P2-2 runner 把 409 当成功)。本轮抽验了其中三条,**结论不变**:
- **P0-3**:v7 门红全程 200 次采样站上指纹恒定、标记词 0 命中,`dist`(109 文件)与 `dist-live`(112 文件)确实分离 —— 仍消除。
- **P1-1**:三次真发布共 660 次采样,`/admin` 非 200 = 0(除我自己打死服务的那 27 条) —— 仍消除。
- **P1-2 / P2-2**:失败态 `/status` 回 `stepsOfVersion=7` + 该版 steps,真浏览器展开出 25 行日志;执行器对 409 的处置逻辑逐字未变 —— 仍消除。

---

## 六、关键实验留档

### 实验一 · 纯 HTTP 伪造(上一轮 P0-A 原样序列)
```
POST /api/publish                                            -> 200 {"versionId":2}
POST /api/publish/step {2,materialize,running|ok}            -> 200 / 200
POST /api/publish/step {2,gates,      running|ok}            -> 200 / 200
POST /api/publish/step {2,build,      running|ok}            -> 200 / 200
POST /api/publish/step {2,swap,       running}               -> 200
POST /api/publish/step {2,swap,       ok}                    -> **409 {"error":"live-verification-failed",
                                                                 "why":"线上快照的印记指向 v999,不是本次要上线的 v2"}**
versions  2:failed(上线核验未通过…)  1:live
steps     materialize:ok gates:ok build:ok swap:failed
curl /    标记词 R3FORGE1 命中 0 次
```

### 实验二 · 真成功发布(v3)
```
18:25:5x  gates running    home=740d0a85ba  mark=no  stamp=404
18:31:18  build:ok/swap:running  home=740d0a85ba  mark=no
18:31:21  swap:ok          home=e683c1ed62  mark=YES stamp={"versionId":3,"stamp":"a34505ff…"}
步骤:materialize 0s / gates 350s / build 3s / swap 1s;versions 3:live 1:archived
promote --check:dist 112 / 25bacf6a971c611a ≡ dist-live
（期间我自己把服务打死过一次,85 s 后重启,执行器靠重试续上 —— 见〇节交底)
```

### 实验三 · 门红(v7,注入超长 `hero.title`)
```
200 次采样(18:37:49–18:47:xx):home 非 200 = 0,/admin 非 200 = 0,唯一指纹 aa37871301,mark=YES 0 次
gates failed 361 s;fail_reason「新文案把版面挤破了(…)(门:render-fit)」
原始日志(25 行)含:[verify] ✗ render-fit(运行时) / ✘ A 行间:2 处相邻行的墨会相接
                    - / @1440×900 h1.x-display-mega 墨隙 -14.2 ;  - /vi/ 墨隙 -3.3
                    [verify] 12/13 gates pass
门红那一刻:dist 109 文件 / 703284247b9fd08c   vs   dist-live 112 文件 / 76a21296b2299711
草稿:超长标题原样保留,dirty=6
```

### 实验四 · 回滚(v10 ← v1)
```
理由 <8 字 / 无理由 -> 400 reason-required ;  fromVersion:9999 -> 404 version-not-found
POST /api/publish {fromVersion:1, reason:"…"}   -> 200 {"versionId":10,"rollbackFrom":1}
四步:materialize 0s / gates 343s / build 3s / swap 1s
18:53:20 build:running  home=aa37871301 mark=YES
18:53:23 swap:ok        home=740d0a85ba mark=no        ← 回到开工基线指纹
versions 10:live 5:archived **1:archived(未被复活)**
审计 #26 config.rollback v10「内容取自 v1」+ 理由 ; #27 config.publish.live v10
CON16-A2 附带印证:gate:equivalence 三个「逐字节一致」+ git diff --stat -- src/ 为空
```

### 实验五 · 上线核验的语义边界(v5,见 P1-4)
```
四步全报 ok（零门）+ 往 dist 塞 R3UNGATEDBYTES + promote --version 5 --stamp <nonce>
-> swap ok 200,v5 live
curl / 含 R3UNGATEDBYTES = true      （没过门的字节在线上）
curl / 含 R3STAMPCONFIG  = false     （v5 声称的内容不在线上）
GET /api/config -> liveVersion=5 dirty=0 changedPaths=[]   （界面说「与线上一致」)
```

### 实验六 · 孤儿快照(v6,见 P1-3)
```
promote 已跑、swap ok 未送到、锁到期自愈
v6 = failed「发布中断(执行器无响应或超时),线上保持旧版」
liveVersion = 5 ;  curl / 含 R3ORPHANBYTES = true ;  /.publish-stamp.json -> {"versionId":6,…}
```

### 实验七 · 门红测(隔离副本)
```
gate-config-consistency --self-test                 7/7 ✓
assets.directory 变异 7 组:
  ../dist                 exit 1 ✓     ../dist/            exit 1 ✓
  ./../dist               exit 1 ✓     ../DIST             exit 1 ✓
  ../dist-published       exit 1 ✓     ../dist-live-x      exit 0（改名快照,可接受）
  ../dist-live/../dist    **exit 0 ✗ 漏**（path.resolve 出来就是 dist）
真删 RULE_LABEL 的 'encoding-damage'                exit 1 ✓（✗ 校验规则 … 有大白话映射)
wrangler.jsonc 加合法行尾 // 注释                    抛栈崩溃(T23 挂账 ②,仍在)
```

---

## 七、没能验到的 AC(不静默略过)

1. **CON16-AC4 schema 版本漂移拒绝面**。全仓 `SCHEMA_VERSION` 仍只有 `schema/src/site-config.ts` 定义 + `schema/src/materialize.ts` 写进 `site.json` 两处,发布链上没有任何一处读它做拒绝。plan 已把它挪到 T23 并按证伪结论改了口径(比两份代码的版本,不比存量数据)。**本轮无可验之物,不作 PASS/FAIL,记为未接线。**
2. **Phase C(CI 执行器)同契约**。只验了 V1-dev 本机 runner;CI 版不存在。
3. **真实 Cloudflare 环境下的原子切换与印记可达性**。`promote.mjs` 的换名分支在本机服务运行时必走 EBUSY 降级(本轮两次真发布都打印了「目录被占用(EBUSY),已改用就地同步」),生产的原子性依赖平台。**关于「点开头的印记文件在云端还能不能被伺服」我做了力所能及的探针**:本机 wrangler dev 直接 `GET /.publish-stamp.json` 得 200;另造最小配置跑 `wrangler deploy --dry-run` → 「**Read 2 files from the assets directory**」(`a.txt` + `.publish-stamp.json`),即 wrangler 4.127 的资产清单**收**点开头文件。**真云端未验**,但没有发现该机制在生产会失灵的证据。
4. **`test-static.mjs`(37 路由字节级)**。它把端口写死 8788,而 8788 在我的禁占清单里;文件在冻结区不能改端口。本轮**未重跑**(本轮也未改动该文件)。
5. **P2-13 抢锁三段无事务**在本机 D1 模拟器上仍无法复现,未作断言。
6. **窄窗(<1024px)导航折叠、版本历史 >30 条的分页**未测——不在 T21/T22 AC 文字内,列此备查。
7. **多执行器真并跑**(两个 runner 同时跑完整门链)未做:本机跑一次门要 6 分钟且两个执行器会互相覆盖 `dist`,代价过高;`/next` 的原子占位已用 4 路并发请求验过,但「两个执行器都通过其它途径拿到 job 之后 `/step` 不设防」这一半只做了单方证明(实验 A 全程未领单即可报步骤)。

---

## 八、收尾状态

- **冻结纪律**:`worker/src/**`、`worker/*.mjs`、`worker/wrangler.jsonc`、`worker/migrations/**`、`admin/src/**` **全程零写入**;所有门红测都发生在 scratchpad 里 `git archive HEAD` 出来的隔离副本上。收尾 `git status` 仓内新增 = **本报告一份**。
- **数据**:本轮造出的 11 个版本、27 条审计行、发布锁全部关在自建的 `worker/.wrangler-r3`,该目录已 **Move 出仓**(到 scratchpad,未硬删),`worker/` 下不留残留;共享的 `worker/.wrangler` 全程未被触碰。
- **`dist` / `dist-live`**:最后一次真发布是回滚到 v1(= 仓内种子内容),二者现在**一致**:`112 文件 / fd895d560fdcc1b7`,`promote --check` 报「✓ 线上快照与构建产物一致」;站上首页指纹 `740d0a85ba` = 我开工时记录的基线。`dist-live/.publish-stamp.json`(内容 `{"versionId":10,…}`)已 Move 到 scratchpad,不留在仓内——与我开工时看到的状态(无印记文件)一致。
- **工作树**:执行器物化写过的 `src/i18n/{en,vi,zh}.json` 与 `src/config/site.json` 已 `git checkout` 还原(还原前 `gate:equivalence` 已确认它们与仓内提交逐字节一致)。
- **进程与端口**:wrangler 监督进程树已杀净,`node.exe` 中含 `wrangler` 的 **0 个**、`workerd` **0 个**;回读 8797 / 8799 / 4403 / 5183 / 8788 / 8793 监听数**全部为 0**。4399(别的会话的 astro preview)全程未碰。
