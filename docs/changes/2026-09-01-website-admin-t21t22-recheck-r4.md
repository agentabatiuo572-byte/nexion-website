# T21/T22 发布流水线 第四轮验收报告(黑盒 · 独立验收方 · 2026-09-01)

**判决 = 不可签字。**

- **验收对象**:PRD `NexGrid_官网后台PRD_v1.0.md` [FEAT-CON13] 全部(含 2026-09-01 新增的「不存在该 API」边界段)+ [FEAT-CON02]-E2 + CON16 相关;plan `2026-08-31-website-admin.plan.md` T21 / T22 两节。
- **被测版本**:`D:\WORKS\PLAN\.wt\w-console`,分支 `pkg/w-publish`,HEAD `c9c0e14`。
- **环境**:worker `http://127.0.0.1:8807`(分配端口,未退 8809),隔离持久化目录 `worker/.wrangler-r4`(收尾已 Move 出仓);控制台经 worker 同域 `/admin`;真浏览器 Playwright;门红测跑在 `git archive HEAD` 的隔离副本上。
- **执行量**:4 次真发布(成功 / config 门红 / 回滚 / render-fit 门红,gates 各 327 / 328 / 334 / 327 秒,全部真跑满门链)、18 个人造版本、**876 条站上实况采样**、40+ 条猜测路由与 11 个未认证探测、`gate-config-consistency` 变异红测 15 组、worker 单测 99/99 + tsc 0 错。
- **冻结纪律**:`worker/src/**`、`worker/*.mjs`、`worker/wrangler.jsonc`、`worker/migrations/**`、`admin/src/**` **全程零写入**(收尾 `git status --short` 对这些路径为空,见第八节)。

**一句话**:这一轮八条修法**大部分真的成立**——纯 HTTP 面依旧上不了线(再次穷举证伪),P1-1 的假红条产地(并发拒绝留垃圾行)、P1-2 的中止按钮、P1-5 的门接进链、P1-6 的打死进程,四条**实测已消除**;但 **P1-3 的 drift 有一个构造性假阴性**(切换脚本自己会保住旧印记)、**P1-4 的 configSha 对「只改文案」这一主力场景完全是空的**(实测:版本标 live、线上却是别的内容,而 `dirty=0` / `drift=null` / 红条全无);另外挖出**这一轮修法自己造的两条新伤**:静态层重构成裸 GET 顺手把 **If-None-Match / Range 全丢了**(每个文件每次访问都全量重下),以及派单点名要找的**「第三次组合故障」——三条各自正确的修法合起来,让一次「回报丢了重发」直接打死执行器**(实测:5.5 分钟已跑完的门链全部作废,发布挂死 12 分钟,期间服务端还在对运营说「执行器仍在工作」)。合计 **7 条 P1 + 24 条 P2**,**P0 = 0**。

---

## 〇、环境与偏差(先交底)

1. **分配端口 8807 全程可用**,未退 8809;4405 / 5185 本轮未起(控制台经 worker 同域伺服)。禁占端口 8787/8788/8791/8793/8797/8799/8801/8803/4321/4401/4403 **全程零占用**;4399 / 3002 / 5173 是别的会话的,全程未碰(收尾回读三者仍在监听)。
2. **起服方式**:`npx wrangler d1 migrations apply nexgrid_site --local --persist-to .wrangler-r4`(0001–0006 全 ✅)+ `npx wrangler dev --port 8807 --persist-to .wrangler-r4`。理由同前两轮:npm 脚本把 `--persist-to` 只挂在 `wrangler dev` 上,迁移会落到另一个库;禁直跑 `npx wrangler dev` 的理由是「跳过迁移」,我把迁移显式跑在同一 persist 目录上,理由已被满足。
3. **我自己造成的一处偏差,如实交底(不是产品缺陷)**:一条回滚理由我用 Git Bash 的 `-d '中文'` 发出,MSYS 通道把它变成了非法 UTF-8,服务端存成了 `R4 ����:�ع���`。**触发方是我的 shell**。但由此顺出的一条产品事实我另做了受控实验并单列(P2-9):服务端对 `reason` **不做任何编码损坏校验**,非法字节原样落库并永久显示。
4. **开工时的一处「假红」我自己识破了,记此备查**:第一次 Playwright 探针在真发布进行中跑,`中止本次发布` 按钮 count=0。回源发现 `dist-live/admin` 是 **r3 那一轮(HEAD 601f22c)构建的旧控制台**,新字符串根本不在产物里(`grep -c "中止本次发布" dist-live/admin/assets/*.js` = 0)。等本轮第一次真发布跑完 `build:console` + swap 之后再探,按钮就在了。**评审探针必须先核「产物指纹 vs 源码」**,这一条差点让我误报 P1-2 仍在。
5. **红测所需的一处源码注入(已还原)**:为红测「新接进链的那道门」,我往 `schema/src/validators.ts`(**不在冻结清单内**)**追加了一行注释** `// redprobe: rule: 'redprobe-only' …`——纯注释、零运行时影响,只为让门的文本扫描发现一条没有大白话映射的规则。跑完立即 `cp` 还原,`git diff -- schema/src/validators.ts` 为空。

---

## 一、逐 AC 结论

### T21 · 发布编排

| # | AC(plan 原文口径) | 结论 | 证据 |
|---|---|---|---|
| T21-1 | 前置校验红 → 不进流水线并逐项列出 | **PASS** | 草稿注入 `Guaranteed 20% monthly returns, risk free investment.` → `GET /preflight` `ready:false` + 3 条 `forbidden-word`;`POST /api/publish` → **409 `preflight-failed`** 并回带 errors 全表;版本表**零新增行**(校验在 INSERT 之前)。真浏览器:红项表 3 行 + 「先修完上面的红项」+ 发布按钮 `disabled=true` |
| T21-2 | 去修复定位 | **FAIL(P2-1)** | 真浏览器取 href:`["/admin/content","/admin/content","/admin/content"]` —— 裸路径,无 hash/query,PRD ⑥「定位到**红字段**」未实现。**四轮同条** |
| T21-3 | 红项自动排除保留草稿 | **PASS** | 4 次门红/中止后草稿逐次核对:超长 `hero.title`(v21)、`R4MARKD`(v9)全部原样保留,`dirty` 非 0,可直接改回再发 |
| T21-4 | 状态机单向且 server 权威 | **PASS(HTTP 面)** | 守卫矩阵见下表,新增的「上报须来自领单人」实测生效;「按合法顺序全报一遍」仍被 `live-verification-failed` 挡下(v2 实测)。**边界见 P1-3**:核实的是印记,不是门 |
| T21-5 | 并发发布 409 | **PASS(P1-1 已消除)** | 真发布进行中 **6 路并发** `POST /api/publish` → 全 409 `publish-in-progress heldBy:9`,**版本表零垃圾行**(`["9:publishing","8:live","7:archived",…]`),无 500。r3 的假红条产地已堵。代价见 P2-3(版本号出现空洞) |
| T21-6 | 锁 TTL 15 分钟超时自动 failed | **PASS** | 把 `publish_lock.expires_at` 拨到 1 → `GET /status` 读时自愈把 v19 标 `failed`(`发布中断(执行器无响应或超时),线上保持旧版`)、清锁,随后 `POST /api/publish` 成功建 v20;旧口令再上报 → `not-current-job`。**缺口见 P2-5**(无审计行 + 步骤永远停在 running) |
| T21-7 | 执行器不在线 → 排队态可取消 | **PASS(界面已补齐;带 P1-7)** | API 四态全过;**真浏览器实测按钮已存在**:`中止本次发布` count=1(steps>0 时)、`取消本次发布`(steps=0 时)、`确认中止` 输入框、理由校验。失联 14.3 分钟 → `canForce:true` → 带理由 → `{"ok":true,"forced":true}`,审计 #14 带理由,随后可重新发起。**但 8/12 分钟口径不一致(P1-7)** |
| T21-8 | 不存在绕门发布 API(路由审计) | **PASS(HTTP 面)** | 5 方法 × 15 条猜测路由(`/publish/live`、`/force`、`/promote`、`/stamp`、`/swap`、`/skip`、`/gates`、`/claim`、`/release`、`/lock`、版本行 PUT/PATCH/DELETE…)**唯一非 404 = `POST /api/publish/next`**(正规领单口,回 `job:null`);11 个入口未认证 **全 401**;`GET /api/publish/next` 已 **404**(本轮改 POST) |

**`/step` 守卫矩阵(HTTP 实测,全部带/不带口令两向)**

| 上报 | 响应 |
|---|---|
| 不带 `stamp` | **409 `not-the-claimed-runner(请先领取任务)`**(本轮新增,r3 P2-13 已消除) |
| 带错的 `stamp` | 409 `not-the-claimed-runner` |
| 领单后 `materialize running` ×2 | 200 → 409 `step-already-started {at:"running"}` |
| 已 ok 的步骤再报 ok | 409 `step-already-done` |
| 跳步 / 冒名 versionId / 非法 step / 过期锁 | 409 `step-out-of-order` / `not-current-job` / 400 `bad-request` / `not-current-job` |
| 合法顺序全报一遍的 `swap ok`(无印记) | **409 `live-verification-failed`**,`why:线上快照里没有本次发布的上线印记(切换步没有真正搬运过产物)`;v2 标 failed、live 仍 v1、站上指纹不变 |
| 6 路并发 `POST /next` | 只有 1 路拿到 job(其余 `already-claimed`) |

### T22 · 执行器 + 失败面 + 版本/回滚

| # | AC | 结论 | 证据 |
|---|---|---|---|
| T22-1 | 执行器按 §5.4 领任务 → 物化 → 全门 → build → 上新 → 回报 | **PASS** | 真成功 2 次:v3(materialize 0 s / gates **327 s** / build 3 s / swap 1 s)、v17 回滚(gates **334 s**);印记随 promote 落盘、服务端回读核实通过(含新增的 `configSha`);420 + 200 条采样期间 `/` 与 `/admin` **非 200 = 0** |
| T22-2 | 任一门红 → failed + 线上保旧版(实测站产物未变) | **PASS(两种门各验一次)** | ① **站上 13 门**:v21 超长 `hero.title` → `render-fit` 红(327 s),128 条采样期间 home/admin 全 200、**唯一指纹 `08859910d8`、标记词 `R4GATERED` 命中 0 次**;`dist` 109 文件 vs `dist-live` 112 文件(分离)。② **worker 一致性门**:v9 → `config-consistency` 红(328 s),117 条采样**唯一指纹**、`R4MARKD` 0 命中 |
| T22-3 | 失败面 = 门名 + 大白话 + 原始日志折叠 | **PASS(带 P2-18)** | v21:`新文案把版面挤破了(行压行 / 文字钻到导航底下 / 窄屏字号反向变大)(门:render-fit)` + 25 行 `<pre>`,含 `[verify] ✗ render-fit(运行时)`、实测墨隙 −14.2px、`[verify] 12/13 gates pass`。v9:`服务端配置与代码对不上(定时任务 / 伺服目录 / 失败面映射)(门:config-consistency)`。**但日志窗口能吃掉关键行,见 P2-18** |
| T22-4 | 映射表覆盖 13 门,缺项显门名原文 | **PASS** | `GATE_REASONS` 14 键 = 站上 13 门 + 新增 `config-consistency`;`✗ render-fit(运行时)` 被 `/✗\s+([a-z0-9-]+)/i` 正确截成 `render-fit`(实测);实跑输出 `[verify] 12/13 gates pass` 佐证 13 门真跑 |
| T22-5 | 版本列表 append-only | **PASS(带 P2-2 / P2-3)** | 无任何删改版本路由(5 方法全 404);版本号只增。**缺 PRD ⑤「改动数」列与 ⑥ 行内「查看」→ diff 摘要**(实景表头仍为 `版本 / 时间 / 状态 / 理由·失败原因 / 操作`);**新增问题:号段出现大片空洞**(P2-3) |
| T22-6 | 回滚走完整门链生成新版本(实测站产物=旧内容) | **PASS** | `POST /api/publish {fromVersion:7, reason:…}` → **v17**,四步齐全(gates 334 s);站上指纹在 `05:07:04 → 05:07:08` 一拍之内从 `5b9a91c382` 变成 `08859910d8`;内容核验:**`R4MARKB=1`(v7 的内容),而 `R4MARKA=0` / `R4MARKC=0` / `R4UNGATEDBYTES=0` / `R4MANUALSWAP=0`**——即一次真发布把我之前塞进快照的未过门字节**整个洗掉了**;`v7` 仍 `archived`(未被复活);理由 <8 字 / 无理由 → 400 `reason-required`,`fromVersion:9999` → 404 |
| T22-7 | 审计 | **部分 PASS(P2-4 / P2-5 / P2-6)** | 41 条审计行,逐版本可追:`config.publish` / `config.rollback`(带理由)/ `config.publish.live`(带 `before=v8`)/ `config.publish.failed` / `config.publish.cancel`(强制中止带理由)。**缺口**:被拒绝的发起**零痕迹**;自愈标 failed **无审计行**;`.live` / `.failed` 的 `reason` 恒 NULL、`after_summary` 空 |

### 移交进本包的 AC

| # | AC | 结论 | 证据 |
|---|---|---|---|
| CON02-E2 | 上次发布 failed → 任意页红条,点击 → /publish | **部分 PASS(P1-5)** | 机制成立且**真的会被一次成功发布清掉**(r3 P1-1 已消除:v3 成功后 `lastPublishFailed = null`,四页红条全消)。**但语义仍会说假话**:一次**正常的「排队态取消」**(CON13-E4 明写的操作)把版本标成 `failed`,壳顶四页立刻常驻 `上次发布失败(v5):已取消(执行器未上线)`——见 P1-5 |
| CON16-AC4 | schema 版本漂移拒绝面 | **未接线(同前两轮)** | 全仓 `SCHEMA_VERSION` 只有 `schema/src/site-config.ts:82` 定义 + `schema/src/materialize.ts:40` 写进产物两处,发布链无一处读它做拒绝。plan 已按证伪结论把它挪到 T23,**本轮无可验之物** |

### 被改动的门(红绿两向)

| 门 / 断言 | 正对照 | 红测(真实事故形态) | 结论 |
|---|---|---|---|
| `gate-config-consistency` **接进流水线**(P1-5 本体) | 4 次真发布中 3 次跑到它、全绿 | 往 `validators.ts` 追加一条无映射规则 → **真发布在 gates 步变红**,`fail_reason = 服务端配置与代码对不上…(门:config-consistency)`,线上保持旧版(117 条采样唯一指纹) | **真的在链上了。r3 P1-5 已消除** |
| 伺服目录断言(改按 resolve 后真实路径) | exit 0;`--self-test` **8/8** | **11 组变异全部 exit 1**:`../dist` · `../dist/` · `./../dist` · `../DIST` · **`../dist-live/../dist`(r3 的漏网,已堵)** · `../dist-live/./../dist` · `..\dist` · `../dist-published` · `../dist-live-x` · `dist` · `../../w-console/dist` | **r3 P2-9 的文本形态已全堵**。**残留一条**:`dist-live` 做成指向 `dist` 的 junction → **PASS,exit 0**(P2-11) |
| 失败面映射双向断言 | 18 条规则 ↔ 18 条映射全绿 | 真删 `'encoding-damage'` 映射 → `✗ 校验规则 "encoding-damage" 在失败面有大白话映射` / FAIL | **守得住**。**新发现盲点**:规则名正则 `[a-z-]+` **不认数字**,`rule: 'h1-count'` 类命名对本门完全隐形(P2-10) |
| `gate-config-consistency` 整体健壮性 | — | `wrangler.jsonc` 加一条**合法的行尾 `//` 注释** → 仍然抛栈、无诊断行 | **T23 挂账 ② 仍在**(P2-12) |
| worker 单测 / 类型 / 其它门 | — | `npm test` **99/99 passed(9 files)** · `tsc --noEmit` **0 错** · `gate:equivalence` PASS(3 判逐字节) | 与实现方自报一致。**但单测有环境耦合**:同一份代码,`dist-live` 里有印记文件时是 **98/99**(P2-13) |

---

## 二、P0

**本轮未发现 P0。**

PRD ④ 在 2026-09-01 补了「不存在该 API」的准确边界(机器强制 = 任何 HTTP 序列上不了线;门跑没跑靠执行器环境可信)。**按这条被修订后的口径,机器强制那一半我逐条证伪过,成立**。穷举清单(全部 HTTP 面实测):

| 尝试 | 结果 |
|---|---|
| 不领单直接上报四步 | 409 `not-the-claimed-runner`(本轮新增) |
| 领单后按合法顺序把四步各报一遍 | `swap ok` → **409 `live-verification-failed`**,v2 标 failed,live 仍 v1,站上指纹不变 |
| 印记缺失 / 版本号不符 / 口令不符 / 摘要不符 | 四种 `why` 各自命中,一律拒绝并标 failed |
| 跳步 / 补报 / 重复 running / 重复收口 / 过期锁 / 冒名 versionId | 全 409 |
| `GET /api/publish/next`(旧的带副作用 GET) | **404**(已改 POST) |
| 6 路并发 `POST /api/publish` / 6 路并发 `POST /next` / 3 路并发 `cancel` | 全部正确拒绝,零 500,零垃圾行 |
| 15 条猜测的绕门路由 × 5 方法 + 11 个未认证入口 | 全 404 / 全 401 |
| 带 body 的 `PUT/POST/DELETE/PATCH` 打任意静态路径(r3 的打死进程路径) | 全 **405 `Allow: GET, HEAD`**,**worker 全程存活**(每发之后 health 回读 200) |

**判据说明**:这不等于「不跑门就上不了线」。后者在**执行器机器可信**这条前提之外仍然不成立,而且本轮我把它推得比 r3 更远——见 P1-3。

---

## 三、P1(逐条不合并)

### P1-1 🔴 静态层重构成「裸 GET」把 **If-None-Match / If-Modified-Since / Range 全丢了**——站上每个文件、每次访问都全量重下

**这是本轮 P1-6 修法自己造出来的新伤。** 修法把交给资产层的请求重新构造成 `new Request(url, { method: 'GET' })`(`worker/src/index.ts:86`),**这个 Request 一个请求头都没有**,而它是站上**全部**静态请求的唯一通道(`:94` 兜底层、`:75`/`:77` 控制台深链)。

**复现(照做即可)**
```
curl -s -D- -o /dev/null http://127.0.0.1:8807/index.html | grep -iE 'cache-control|etag'
   Cache-Control: public, max-age=0, must-revalidate
   ETag: "bcc564a8484ae0213d611c7944168a7b"
curl -s -o /dev/null -w '%{http_code} %{size_download}\n' \
     -H 'If-None-Match: "bcc564a8484ae0213d611c7944168a7b"' http://127.0.0.1:8807/index.html
   -> 200 57610          ← 应为 304 0
同样对 /art-aisle.webp(42644 B)与 /_astro/Base.025xgyUh.css(29404 B):也是 200 全量
curl -s -o /dev/null -w '%{http_code} %{size_download}\n' -H 'Range: bytes=0-99' \
     http://127.0.0.1:8807/_astro/Base.astro_..._index_0_lang.CEHCZNUo.js
   -> 200 62977          ← 应为 206 100
```

**为什么这条是 P1 而不是性能小事**:实测**站上每一个文件**(HTML、图片、`_astro/` 带指纹的 JS/CSS)都带 `Cache-Control: public, max-age=0, must-revalidate`。这套头的意思就是「每次都来问我一下,没变我给你 304」。现在 304 这条路被封死,于是**回访用户的每一次导航都要把整站重下一遍**——光非指纹静态资产就 74 个文件 / 3.4 MB,还不含 `_astro/`。`run_worker_first: true` 让生产上每个资产请求也走这段代码,行为同构。

- **对比**:`git show 601f22c:worker/src/index.ts:81` 原来是 `ASSETS.fetch(c.req.raw)`,请求头原样转发,304 正常。**是这一轮引入的回归。**
- **修法方向**:405 收口是对的,但交给资产层的请求应当是「原始 Request 去掉 body」而不是「凭空造一个裸 GET」——例如 `new Request(url, { method: c.req.method === 'HEAD' ? 'HEAD' : 'GET', headers: c.req.raw.headers })`。
- **根因位置**:`worker/src/index.ts:86`(构造函数)· `:75` `:77` `:94`(三处调用点)。

### P1-2 🔴 **派单点名要找的第三次组合故障**:三条各自正确的修法合起来,让一次「回报丢了重发」直接打死执行器——5.5 分钟已跑完的门链全部作废,发布挂死 12 分钟

三条修法各自都对:
- **α**(首轮 P0-1):每步必须先报 `running`,同一步不得重复收口 → 重复上报一律 409(`worker/src/publish.ts:257-258`)。
- **β**(包⑨ 自己加的重试,`worker/runner.mjs:23-24` 注释原文):「质检门里的生产构建会重写 dist,而 wrangler dev 监视该目录 → 自动重启 → 正在写的连接被掐断(**实测 ECONNABORTED**)。回报不能因此丢失,否则版本卡在『发布中』。」
- **γ**(首轮 P1):执行器把 409/400/401 当**明确拒绝**,不再重试后自顾自推进(`worker/runner.mjs:34` `:39`)。

合起来:**β 存在的理由那件事(回报送到了、响应没回来)一旦发生,重试就会撞上 α 的 409,被 γ 判成「服务端拒绝」,抛出 → 没有任何 try/catch 接 → `loop().catch → process.exit(1)`。**

**复现(照做即可,已端到端实测)**
```
1. POST /api/publish                       -> v20
2. 启动真执行器 npm run publish:runner -- --once
3. 等 steps 出现 gates:running(约 1 秒后,窗口有 5.5 分钟)
4. 从库里取本次领单口令:SELECT claim_nonce FROM publish_lock WHERE id=1
5. 替执行器把这一步收口(= 模拟「它的回报其实送达了」):
   POST /api/publish/step {versionId:20, step:"gates", status:"ok", stamp:<nonce>}   -> 200
6. 等执行器自己跑完门链(实测 5.5 分钟)后发出同一条回报(= 它的重试)

结果(实测日志原文):
  执行器异常: Error: /api/publish/step → 409 {"error":"step-already-done"}
      at api (runner.mjs:32) / at async runJob (runner.mjs:100) / at async loop (runner.mjs:133)
      { status: 409, rejected: true }
  进程退出,轮询计数 runnerProcs 1 → 0
```

**后果(实测,逐条)**
```
版本 v20            = publishing(界面显示「正在发布 v20」,gates ✔、build 等待中——看起来一切正常)
POST /api/publish   -> 拿不到锁(本例因草稿已清返 no-changes,真实场景是 publish-in-progress)
POST /cancel        -> 409 already-running, canForce:false,
                       hint: "执行器仍在工作(最近有步骤动静),中止会留下没人收口的中间态"   ← 假话,它已经死了
POST /cancel force  -> 409 runner-still-alive
重启执行器          -> {"job":null,"note":"already-claimed"}                              ← 按设计不再派发
唯一出路:干等到 12 分钟失联阈值(或 15 分钟锁 TTL)
```

- **影响**:①**一次完整的 5.5 分钟门链白跑**——门是过了的,结果被丢掉;②发布挂死 12–15 分钟,期间界面显示「正在发布」而实际没有任何进程在跑(**正是 r3 修掉的那个「看起来在跑、其实早死」的形态换了个入口回来**);③这段时间里服务端主动告诉运营「执行器仍在工作」。
- **触发概率不低**:β 的注释自己写着这个掐断「实测两次」,而门链里的 `astro build` 每次都会重写 dist。
- **修法方向**:让重复收口**幂等**(同 `status` 的重复收口回 200 而不是 409),或让执行器把 `step-already-done` / `step-already-started {at:同状态}` 当成「我上一次其实成功了」而继续,而不是当成拒绝。α 的语义目标是「凭空落一步」不许发生,不是「同一条回报送两次」不许发生。
- **根因位置**:`worker/src/publish.ts:257`(重复 running 409)`:258`(重复收口 409)· `worker/runner.mjs:34`(409 归入 rejected)`:39`(rejected 不重试)`:93/96/100/103/108/117/120`(七处 `report()` 全部无 try/catch)`:143-146`(异常即 exit 1)。

### P1-3 🔴 `configSha` 只覆盖 `src/config/site.json`,**对「只改文案」这一主力场景完全是空的**——版本标 live、线上却是别的内容,而 `dirty=0` / `drift=null` / 红条全无

本轮给印记加了 `configSha`,服务端用同一物化器自算后比对(`worker/src/publish.ts:296-297`)。但 `materializeSiteJson()`(`schema/src/materialize.ts:38-49`)只吐 `schemaVersion/stats/skus/downloads/announcement/seo/footer` —— **不含 `copy`(177 个文案 key)、不含 `faq`、不含 `legal`,更不含构建出来的 HTML**。于是**任何只改文案的版本,它的 configSha 与上一版逐字节相同**,这道校验对它等于不存在。

**复现(照做即可;需要合法会话 + 能跑 promote 的机器 —— 按 PRD ④ 修订后的口径,这不属于「机器强制」那一半,故不计 P0)**
```
前提:v3 已正常上线,工作树里 src/config/site.json 是 v3 物化出来的那份
1. 改草稿:只动 faq.items[0].a.{en,vi,zh}(追加标记 R4MARKC)
2. POST /api/publish                        -> v8
3. POST /api/publish/next                   -> 拿到 stamp
4. 四步全报 running/ok（**一道门都没跑**）
5. 往 dist/index.html 里塞一段任何门都没见过的字节 R4UNGATEDBYTES
6. node promote.mjs --version 8 --stamp <stamp>
   （它照旧读 src/config/site.json 算 configSha —— 因为 v8 只改了文案,这份文件跟 v3 的一模一样,摘要天然对得上)
7. POST /step swap ok                       -> **200**

结果:
  versions            8:live  7:archived                       ← 一道门没跑,版本上线
  curl / 含 R4UNGATEDBYTES ?  -> 1    （线上是没过门的字节)
  curl / 含 R4MARKC        ?  -> 0    （线上**不是** v8 声称的内容)
  curl / 含 R4MARKA        ?  -> 1    （线上还是两版之前的内容)
  GET /api/config     -> liveVersion=8, dirty=0, lastPublishFailed=null
  GET /api/publish/status -> drift=null
  控制台状态条        -> 「线上 v8 · 与线上一致」
```

- **这条要说的不是「攻击者能怎样」**,而是**核验的语义边界**:服务端核的是「有人落了个文件,而且那个文件里的一个摘要跟这一版的 `site.json` 对得上」。它**没有**核实线上快照的内容等于这一版。于是任何让快照与版本脱节的原因(执行器 bug、门与 build 之间有人碰了 dist、手工操作顺序错、P1-4 的孤儿快照)都会得到「数据库说上线成功、站上是别的东西」,**而系统一律判绿**:`dirty=0`、`drift=null`、发布按钮因 `ready:false` 变灰、`POST /api/publish` 回 `no-changes`——**运营被锁进假状态,界面上零异常信号**。
- **r3 的 P1-4 判定不变,configSha 只封住了「改了 stats/skus/downloads/seo/footer 的版本」那一小半**。
- **修法方向**:印记里带的应当是**整份物化产物的摘要**(三份 i18n + site.json 一起),或者干脆是 `dist` 的指纹(`promote.mjs` 自己已经在算 `fingerprint()`,`:36-54`),服务端拿版本 payload 重算 i18n 后比对。
- **根因位置**:`worker/src/publish.ts:84-88`(`expectedConfigSha` 只喂 `materializeSiteJson`)`:296-297`(校验条件)· `worker/promote.mjs:124`(只哈希 `src/config/site.json`)· `schema/src/materialize.ts:38-49`(该函数的字段范围)。

### P1-4 🔴 新加的 drift 有一个**构造性假阴性**:切换脚本自己会把旧印记留下,于是「内容换了、印记没换」这一族永远报不出来;而且它报不报**取决于 promote 走了哪个分支**

`promote.mjs` 的就地同步分支明写 `want.add(STAMP)`(`worker/promote.mjs:103`),目的是「印记是搬运的产物,别当成已不存在的旧文件删掉」——单看是对的。但 `liveSnapshotDrift()`(`worker/src/publish.ts:91-104`)**只比印记里的 `versionId` 和数据库的 live**,不比内容。两条合起来:**在就地同步分支下换掉快照内容,印记原样留着,drift 判 null。**

**复现(照做即可)**
```
前提:v8 已 live,dist-live/.publish-stamp.json = {versionId:8,...}(本机开着服务 → promote 必走就地同步)
1. 往 dist/index.html 塞标记 R4MANUALSWAP
2. node promote.mjs            （不带 --version/--stamp,即「手工提升」）
   -> · 目录被占用(EBUSY),已改用就地同步
   -> ✓ 已上线:dist-live ← dist
3. cat dist-live/.publish-stamp.json   -> 仍是 {"versionId":8,...}   ← 旧印记被保住了
4. curl / | grep -c R4MANUALSWAP       -> 1                          ← 线上内容已经换了
5. GET /api/publish/status             -> "drift": null              ← 一声不吭
```

**对照实验(证明覆盖面依赖分支)**:把服务停掉再跑同样的 `node promote.mjs`,走**换名分支** → `writeStamp(TMP)` 无参返回 null → 新目录**没有印记** → 此时 drift **会**报 `{dbLive:17, snapshot:null}`。也就是说**同一个事故,报不报取决于当时 wrangler 有没有占着目录句柄**。

- **影响**:P1-3 那一族(内容与版本脱节)里,**最容易发生的手工形态恰好落在 drift 的盲区**;而 drift 正是本轮为「让人能看见劈叉」而加的唯一一处探测。
- **另一半(印记丢失)是好的**:我把 `dist-live/.publish-stamp.json` 删掉后,drift 正确报 `{"dbLive":8,"snapshot":null}`。**「全新环境豁免」也没有被滥用的形态**——我逐条试过:豁免要求 `live.created_by='system'`,而**只有种子行是 system**,任何回滚都会建一个 `created_by='admin'` 的新版本(实测 `fromVersion:1` → v10 是 admin),`swap ok` 也只会把当前锁持有的版本标 live,**没有任何 HTTP 路径能把 live 指针挪回种子行**。豁免的真实局限只有一条:**首次流水线发布之前**,快照可以被换成任何东西而 drift 不报——那正是新部署的初始状态。
- **根因位置**:`worker/promote.mjs:103`(保住旧印记)· `worker/src/publish.ts:94-103`(只比 versionId,不比内容/摘要)。

### P1-5 🔴 一次**正常的「排队态取消」**(CON13-E4 明写的操作)会换来一条全站常驻、只能靠一次成功发布才能清掉的假红条「上次发布失败」

r3 的 P1-1 是「被锁拒绝的发起留垃圾 failed 行 → 假红条」,**这一轮把产地堵掉了(实测:6 路并发拒绝零垃圾行)**。但**同一个假红条还有第二个产地没堵**:`/cancel` 无论哪一档,都把版本写成 `status='failed'`(`worker/src/publish.ts:408`),而红条判据是「有比线上更新的 failed 版本」(`worker/src/config.ts:74-77`)。

**复现(照做即可)**
```
1. POST /api/publish                       -> v5        （执行器没起,正是 E4 的场景)
2. 界面「排队中——发布执行器尚未领取任务…若长时间无响应可取消」→ 点「取消本次发布」
   POST /api/publish/cancel {}             -> {"ok":true,"forced":false}
3. 打开控制台任意页
   -> 壳顶红条:「上次发布失败(v5):已取消(执行器未上线)　线上仍是 v3,未受影响。」
   （真浏览器实测,/、/content、/publish、/audit 四页均在)
4. 这条红条要一次 **成功发布** 才会消失(判据 id > live.id);运营没被告知这一点,也没有关闭入口
```

- **影响**:CON02-E2 的语义是「**上次发布失败**」。现在运营做了 CON13-E4 白纸黑字写好的事(执行器没上线 → 取消),换来一条红色告警说他失败了。r3 的结论原样适用:**告警一旦学会说谎,下次真失败时就没人信了**。
- **顺带**:红条正文写死「线上仍是 v{N},**未受影响**」,这句话在 P1-3 / P1-4 那两个形态下是假的,而红条无从知道。
- **修法方向**:`cancel` 与 `failed` 是两件事。要么给版本一个 `cancelled` 终态(PRD ④ 状态机里目前没有,需先改 PRD),要么红条判据排掉 `fail_reason LIKE '已取消%'` / 强制中止那一类。
- **根因位置**:`worker/src/publish.ts:406-412`(取消写 failed)· `worker/src/config.ts:74-77`(红条判据)· 呈现面 `admin/src/shell.tsx` 红条块 与 `admin/src/pages/publish.tsx:186`。

### P1-6 🔴 drift 只出现在 /publish 页,壳状态条在劈叉时仍然说「与线上一致」;而红条给出的补救办法在它出现的那一刻**恰好是做不到的**

**复现(照做即可)**
```
1. 正常发布一次(live = v8)
2. 删掉 dist-live/.publish-stamp.json（模拟快照被换过 / 印记丢了)
3. GET /api/publish/status      -> "drift": {"dbLive":8,"snapshot":null}      ✔ 报出来了
   GET /api/config              -> 返回体里**没有任何 drift 字段**(实测 keys:
                                   liveVersion, livePublishedAt, lastPublishFailed, geo, live, draft,
                                   dirty, changedPaths, sensitiveChanged)
4. 真浏览器:
   /admin/(首页)状态条      -> 「线上 v8 · **与线上一致** · 屏蔽 未启用」  ← 一切正常的样子
   /admin/publish              -> 红条「线上内容与系统记录对不上 …
                                  **重新发起一次发布即可让两边对齐**」
   同一页发布按钮              -> disabled=true,旁注「无改动可发布」
   POST /api/publish           -> 409 {"error":"no-changes"}
```

- **影响**:①CON02 ⑤ 明写状态条「**始终**展示真实状态」;劈叉时它反而是最肯定的那一个,而运营 90% 的时间待在别的页;②红条教运营做一件界面禁止他做的事——`dirty=0` 时按钮灰着、API 409。剩下的出路(回滚到某个 archived 版本)红条没提,而且要填 ≥8 字理由、产出一个内容与 live 相同的新版本。
- **修法方向**:`/api/config` 一并回 drift(壳已有渲染红条的位置);红条的行动指引按 `dirty` 分叉(有改动 → 发布;无改动 → 指向「回滚到当前 live 同内容的版本」或给一个显式的「重新同步快照」动作)。
- **根因位置**:`worker/src/config.ts:78-88`(概览返回体无 drift)· `admin/src/pages/publish.tsx:174-183`(文案写死「重新发起一次发布」)`:246`(按钮 disabled 判据)。

### P1-7 🔴 失联阈值从 8 分钟改成了 12 分钟,但**界面、README 和服务端自己的提示语三处仍然说 8 分钟**;在 8–12 分钟这段真空里,服务端对着一个已经死了的执行器告诉运营「执行器仍在工作」

**复现(照做即可)**
```
1. POST /api/publish → POST /next → POST /step {materialize, running}      （之后再无任何动静)
2. 把这一步的时间戳往前拨 9 分钟:
   UPDATE publish_steps SET started_at = started_at - 540000 WHERE version_id=6
3. POST /api/publish/cancel {}
   -> 409 {"error":"already-running","canForce":false,"silentMs":619020,
           "hint":"执行器仍在工作(最近有步骤动静),中止会留下没人收口的中间态"}
              ↑ silentMs = 10.3 分钟。它一句话都没说过,而服务端说它在工作。
   POST /api/publish/cancel {force:true, reason:"…"} -> 409 runner-still-alive
4. 再往前拨到 14.3 分钟:
   -> canForce:true,hint:"执行器已超过 **8 分钟** 没有动静,可带 force 与理由强制中止"
              ↑ 阈值早就是 12 分钟了(RUNNER_SILENT_MS = 12 * 60_000)
```

真浏览器同时留证,发布页那行灰字原文:**「执行器超过 8 分钟没有动静才允许中止;门链本身要跑约 6 分钟,属正常。」**

- **影响**:这是**紧急出口**上的说明。运营按界面说的等满 8 分钟去点中止,拿到的是一句「执行器仍在工作」——他会合理地推断「那就再等等」,而真相是它已经死了 10 分钟。r3 把「README 描述了一个不存在的按钮」判为 P1;这一条是同一族(**告诉运营的数字不是代码执行的数字**),我按同族定级。若主人认为「多等 4 分钟」不值 P1,可降 P2——但请连同 P1-2 一起看:P1-2 的挂死时间正是由这个阈值决定的。
- **根因位置**:`worker/src/publish.ts:365`(常量 12 分钟)`:396`(提示语仍写 8)· `admin/src/pages/publish.tsx:156`(界面文案)`:94` `:152`(注释)· `worker/README.md:41`。

---

## 四、P2(逐条不合并)

1. **「去修复」只跳页面不定位字段**(**四轮同条**)。真浏览器取 href = `/admin/content` ×3,内容页无 hash/query 承接。PRD ⑥ 要求「定位到红字段」。根因 `admin/src/pages/publish.tsx:35-45`。
2. **版本列表缺 PRD ⑤ 的「改动数」列,也缺 ⑥ 的行内「查看」→ 展开该版 diff 摘要**(**四轮同条**)。实景表头 `版本 / 时间 / 状态 / 理由 · 失败原因 / 操作`;`/api/config/versions` 只回列表字段,无 payload/diff 接口。
3. **版本号出现大片空洞,而列表标题写着「只增不删」**(**本轮新增,是 P1-1 修法的副作用**)。被锁拒绝的发起会先 INSERT 再 DELETE(`worker/src/publish.ts:170-184`),自增号已被消耗。实测最终列表:`v1 v2 v3 v5 v6 v7 v8 v9 v16 v17 v19 v20 v21 v22` —— **22 个号里缺了 8 个(4、10–15、18)**,其中 6 个是我一次 6 路并发试出来的。运营看到 `v9 → v16` 只能理解成「有人删了历史版本」,而那恰恰是 PRD ④ 明令禁止的动作。建议:拿不到锁时**先探锁再建行**,或建行前用一个不占号的预检。
4. **被拒绝的发起现在是零痕迹**(r3 P2-2 的另一面)。既没有版本行,也**没有审计行**。「谁在什么时候试图发布过、被并发挡了」在系统里查不到。
5. **自愈把版本标 failed 时不写审计,且把步骤永远留在 `running`**(r3 P2-3,**仍在 + 新观察**)。实测 v19:审计只有 `config.publish v19`,没有 `.failed`;`publish_steps` 里 `materialize` 永远是 `running`,与版本的 `failed` 自相矛盾(`/cancel` 那条路径是会收口步骤的,自愈这条不会)。根因 `worker/src/publish.ts:334-342`。
6. **终止类审计行仍缺理由 / 摘要**(r3 P2-7,部分修)。`config.publish.live` 实测 `after_summary=null, reason=null`;强制中止那条有理由(#14)。
7. **回滚源仍不限状态**(r3 P2-4,**四轮同条**)。实测 `fromVersion: 9`(一个 `config-consistency` 门红过、从未上线的版本)→ 200,建出 v16。UI 只给 `archived` 行按钮,API 不拦。仍走完整门链,故非绕门。根因 `worker/src/publish.ts:150`(SELECT 无 status 过滤)。
8. **强制中止的理由只有前端在校验**。实测 `POST /cancel {force:true, reason:"x"}` → **`{"ok":true,"forced":true}`**,审计行写着「强制中止(执行器失联 14 分钟):x」。控制台自己要求 ≥4 字(`publish.tsx:107`),PRD §CON14 要求高敏动作 reason **≥8 字**,而 `POST /api/publish` 对回滚/高敏确实是服务端 ≥8。同一个仓里三套口径,且最松的那套在服务端。根因 `worker/src/publish.ts:403`。
9. **`reason` 从不做编码损坏校验**。受控实验:用 node 写一段**故意非法**的 UTF-8(截断的多字节序列)放进 `reason` → `POST /api/publish` **200**,库里存成 `"R4 控� bad-utf8 probe"`(含 U+FFFD),此后永久出现在版本列表与审计里。同一个仓为配置文本专门焊了 `encoding-damage` 校验器(起因正是一段中文经不当通道传入后上了公开页),而运营手打的理由这条通道没有任何防护。
10. **`gate-config-consistency` 的规则名正则认不出数字**。`/rule:\s*'([a-z-]+)'/g` 对 `rule: 'h1-count'` / `rule: 'seo-length2'` 完全隐形(实测:三条候选里只匹配到 `seo-length`)。与 r3 P2-16 的「只认字面量」同族,是同一道双向断言的第二个盲点。根因 `worker/gate-config-consistency.mjs:64`。
11. **把 `dist-live` 做成指向 `dist` 的 junction/符号链接,伺服目录断言仍然判绿**。隔离副本实测:`New-Item -ItemType Junction -Path dist-live -Target dist` 之后 `node gate-config-consistency.mjs` → **PASS / exit 0**,而线上伺服的就是构建产物(P0-3 原样复活)。`path.resolve` 不解析链接,`fs.realpathSync` 才会。r3 的文本形态漏洞已堵,这是剩下的那一种。根因 `worker/gate-config-consistency.mjs:56-60`。
12. **`gate-config-consistency` 遇到合法的行尾 `//` 注释仍直接抛栈崩溃**(T23 挂账 ②,**四轮同条**)。隔离副本实测:给 `wrangler.jsonc` 加 `"ENVIRONMENT": "dev",   // 上线改 production` → SyntaxError 抛栈、无诊断行。失败关闭不算放过,但对改配置的人是一次无法归因的红。根因 `worker/gate-config-consistency.mjs:18`。
13. **worker 单测里的 drift 回归测试对着真实的 `dist-live` 目录断言,verdict 随未纳入版本管理的构建产物而变**。同一份 HEAD 代码:`dist-live/.publish-stamp.json` **不存在**时 `npm test` = **99/99 passed**;**存在**时(即任何一次真发布之后的正常状态)= **98/99,1 failed**,失败的正是 `🔴 P1-3 线上快照与系统记录劈叉时,状态里必须报出来`。原因:该用例第 405-406 行用真 `env` 断言「初始种子 + 无印记 = 不报」,而真 `env` 读的是仓外的 `dist-live`。一道会被残留产物翻红的门,下次没人会信它。
14. **`GET /api/publish/status` 是带副作用的 GET,而且副作用比挂账里那几条重**。它会 `UPDATE config_versions SET status='failed' …`(自愈)并 `DELETE FROM publish_lock`。本轮把 `/next` 改成了 POST(好),但 `/status`、`/preflight`、`GET /api/config` 仍在 GET 上写库;前者不是 `ensureInit` 那种幂等播种,是真的改状态。T23 的「带副作用的 GET」清单请按此更新。
15. **UI 仍分不清「排队中」和「已被领取」**(r3 P2-14,仍在)。`/status` 不回 `claimed_at`(0006 迁移新加的列),发布页仍靠 `st.steps.length === 0` 判队列态;在「已领取、正在物化但还没报第一步」这段时间里界面写着「执行器**尚未领取任务**」并给出取消按钮,此刻取消会删锁,执行器下一句 `materialize running` 收 409 退出。
16. **单步仍无心跳**(r3 P2-8,机制未改)。锁只在 `running` 上报那一刻续期,`gates` 是不可分的一步;实测健康发布中途 `silentMs` 一路涨到 **348 秒**。阈值改 12 分钟后余量从 2 分钟变成约 6.5 分钟,**比上一轮好**,但「用最后一次步骤动静当心跳」这件事本身没变,门链一旦变慢(更多路由/视口档)就会重演。根因 `worker/src/publish.ts:264`(只在 running 续锁)`:365`(阈值)。
17. **`promote.mjs --check` 的解释文案在事故态下仍是错的**(r3 P2-15,仍在)。两者不同时一律打印「构建产物尚未提升上线,**这在门未通过时是正确状态**」,而 README:19 恰恰推荐用 `--check` 排查「线上快照对不对」。根因 `worker/promote.mjs:67`。
18. **门红只报第一道门 + 原始日志只留最后 25 行**(**四轮同条,机制未改**),而本轮把 `config-consistency` 接进链之后,这条限制**新出现了一个必然踩中的实例**:该门一次输出 49 行,伺服目录那两条 `✗` 固定落在第 **10–11** 行,`slice(-25)` **一定**把它们切掉。隔离副本实测:把 `assets.directory` 改回 `../dist`,运营在失败面「查看原始日志」里看到的 25 行**全是 ✓**,`✗` 一条不剩 —— 而那正是这道门存在的唯一理由(守 P0-3)。根因 `worker/runner.mjs:61`(只抓第一条 ✗)`:71`(`slice(-25)`)。
19. **`.publish-stamp.json` 对公网匿名可读**(r3 P2-12,仍在)。实测无 cookie `GET /.publish-stamp.json` → 200,回 `{"versionId":17,"stamp":"c559a0d2…","configSha":"d6167afd…","at":…}`。口令写进去时已用掉,直接危害低;但它同时向公众泄露内部版本号与配置摘要,且 `configSha` 现在是上线核验的一半判据。
20. **版本列表硬截断且无分页/提示**。`/status` `LIMIT 30`、`/api/config/versions` `LIMIT 50`,UI 无「更多」入口也无「已截断」标注。本轮已积到 22 个版本号,一个正常运营的站几周就会越过 30。根因 `worker/src/publish.ts:351`、`worker/src/config.ts:220`。
21. **`test-static.mjs` 有三处副作用型问题(T3 挂账未动,但它是 T22 字节级验收的唯一手段)**:①端口硬编码 `8788`;②`spawn('npx',['wrangler','dev','--port',8788])` **不带 `--persist-to`**,直接用共享的本地 D1;③`killTree()` 在回读端口非 0 时 `Get-NetTCPConnection -LocalPort 8788 | Stop-Process -Force` —— **无差别杀掉 8788 上的任何进程,不只是它自己那个子进程**。多会话共享机器时这是一发误伤。根因 `worker/test-static.mjs:22`、`:47`、`:59-67`。
22. **控制台登录前有 3 条 401 console error**(r3 P2-18,仍在)。登录后 console error = 0(四页实测)。
23. **`ensureInit` 的半初始化恢复是静默的**(本轮修法 #8 的副作用观察)。实测删掉 `config_draft` 行后 `GET /api/config` 从 500 变成 200(**修法成立**),但它用线上内容重建草稿、`draft_rev` 归 1,**未发布的草稿改动就此消失**,没有审计行也没有任何提示。恢复本身是对的,「悄无声息」这一半值得补一条痕迹。
24. **正常发布过程中存在一个约 1 秒的 drift 误报窗口**(结构性,**本轮 876 条采样未捕获**,按 [INFERRED] 记)。`promote` 先落印记(新版本号)、`swap ok` 后翻 live,两者之间 `/status` 会算出 `drift ≠ null`;发布页 2 秒轮询一次,理论上可能闪一下红条。实测 swap 步耗时 1 秒,未命中。

---

## 五、前三轮报告逐条回归

### 第三轮(`...-recheck-r3.md`)的 6×P1

| r3 条目 | 本轮结论 | 证据 |
|---|---|---|
| **P1-1** CON02-E2 红条为「没发生过的失败」报警,成功发布也清不掉 | **已消除(产地已堵),但同族第二个产地仍在 → 变形为 P1-5** | 6 路并发拒绝后版本表零垃圾行;v3 成功后 `lastPublishFailed=null`、四页红条全消。**但「排队态取消」照样写 failed,红条照样常驻** |
| **P1-2** 强制中止只做了 API,控制台没有按钮 | **已消除** | 真浏览器:`中止本次发布` count=1(steps>0)、`确认中止` + 理由输入框、`取消本次发布`(steps=0);全流程实测走通(失联判定 → 理由 → 中止 → 重新发起)。**残留 P1-7:界面写 8 分钟、代码是 12 分钟** |
| **P1-3** promote 已落盘、`swap ok` 没送到 → 界面说「线上保持旧版」,而站上已换;系统无一处能发现 | **部分消除 → 变形为 P1-4** | 新增 `drift` 字段 + /publish 红条,**印记缺失/版本号不符这一半真能报出来**(实测 `{"dbLive":8,"snapshot":null}`)。**但「内容换了、印记还在」报不出来**(就地同步分支保住旧印记),且**壳状态条完全看不到 drift**(P1-6) |
| **P1-4** 上线核验证明的是「有人落了个文件」,不是「门跑过了」 | **仍在(configSha 只封住一小半)** | 见 P1-3:只改文案的版本 configSha 与上一版逐字节相同,实测零门上线 + 线上内容 ≠ 该版内容 + 全部指标判绿 |
| **P1-5** 焊的门不在任何自动链里 | **已消除** | `runner.mjs:52-72` 把它接在 13 门之后;**真发布红测通过**:注入一条无映射规则 → v9 在 gates 步变红、`fail_reason` 指名 `config-consistency`、线上保持旧版(117 条采样唯一指纹) |
| **P1-6** 带 body 的非 GET 打静态路径把 worker 打死 | **已消除,但换来一条新伤(P1-1)** | `PUT/POST/DELETE/PATCH` + 1 MB body × 6 种路径全部 405,**每发之后 health 回读 200**,进程零退出;单测 4 条 405 用例通过。**代价:请求头被整个丢掉,304/Range 全废** |

### 第三轮的 18×P2

| r3 条目 | 本轮结论 |
|---|---|
| P2-1 「去修复」只跳页面 | **仍在**(本轮 P2-1,四轮同条) |
| P2-2 被拒发起留 failed 行 + 无审计行 | **一半消除**:failed 行没了;**审计行仍然没有**(本轮 P2-4),且换来号段空洞(本轮 P2-3) |
| P2-3 自愈标 failed 不写审计 | **仍在**(本轮 P2-5),另发现步骤永远停在 running |
| P2-4 回滚源不限状态 | **仍在**(本轮 P2-7),实测 `fromVersion:9` → 200 |
| P2-5 版本列表缺改动数 / 缺「查看」 | **仍在**(本轮 P2-2) |
| P2-6 门红只报第一道门 + 25 行日志 | **仍在,且新增一个必踩实例**(本轮 P2-18) |
| P2-7 终止类审计行不带理由 | **仍是部分修**(本轮 P2-6) |
| P2-8 单步无心跳 + 8 分钟阈值余量只剩 2 分钟 | **机制未改,余量变好**(12 分钟 → 约 6.5 分钟余量);**但阈值改了文案没改**(本轮 P1-7) |
| P2-9 伺服目录断言比字符串不比路径 | **已消除(文本形态全堵,11 组变异全红)**;**残留链接形态**(本轮 P2-11) |
| P2-10 JSONC 行尾 `//` 让门崩 | **仍在**(本轮 P2-12) |
| P2-11 `GET /api/publish/next` 是带副作用的 GET | **已消除**(改 POST,GET → 404);**但 `/status` 的副作用更重且仍是 GET**(本轮 P2-14) |
| P2-12 `.publish-stamp.json` 匿名可读 | **仍在**(本轮 P2-19),且现在还多泄露一个 `configSha` |
| P2-13 `/step` 与领单完全不绑定 | **已消除**:不带/带错 `stamp` 一律 409 `not-the-claimed-runner`(实测两向) |
| P2-14 UI 分不清「排队中」和「已被领取」 | **仍在**(本轮 P2-15),`/status` 仍不回 `claimed_at` |
| P2-15 `promote.mjs --check` 事故态文案错 | **仍在**(本轮 P2-17) |
| P2-16 失败面映射断言只认字面量 | **仍在**,并发现第二个盲点:正则不认数字(本轮 P2-10) |
| P2-17 `syncInPlace()` 保留上一版印记 | **仍在,且后果升级**:它现在是新 drift 探测的主要假阴性来源(本轮 P1-4) |
| P2-18 登录前 3 条 401 console error | **仍在**(本轮 P2-22) |

### 第二轮 / 第一轮里已判「已消除」的各条(本轮抽验)

- **r2-P0-A**(合法顺序 8 次请求即可 live):**仍消除**,本轮重跑同一序列 → 409 `live-verification-failed`。
- **r2-P1-B**(两个执行器领到同一单):**仍消除**,6 路并发 `/next` 只有 1 路拿到 job。
- **r1-P0-2**(过期锁照收):**仍消除**,过期后上报 → `not-current-job`。
- **r1-P0-3**(线上直伺服 `dist`):**仍消除**,两次门红全程站上指纹恒定、`dist`(109 文件)与 `dist-live`(112 文件)分离;并且这一轮它**多了一道真跑的门守着**(P1-5 已消除)。
- **r1-P1-1**(门红后控制台 404):**仍消除**,876 条采样 `/admin` 非 200 = 0。
- **r1-P1-2 / r1-P2-2**(失败态取不回日志 / runner 把 409 当成功):**日志仍消除**(v21 失败面展开 25 行);**409 的处置仍是「当拒绝」**,而这一轮它变成了 P1-2 的一环。

---

## 六、关键实验留档

### 实验一 · 真成功发布(v3)
```
materialize 0s / gates 327s / build 3s / swap 1s
420 条采样:home 非 200 = 0,/admin 非 200 = 0
指纹在 swap:ok 那一拍 0c761e8c68 → 2ee400bda2,标记 R4MARKA 同拍出现
/.publish-stamp.json 404 → 200 {"versionId":3,"stamp":"5c4026fd…","configSha":"d6167afd…"}
versions 3:live 1:archived ;  drift null ;  lastPublishFailed **null**（r3 P1-1 假红条已消)
promote --check:dist 112 / 34dcb96965ee4965 ≡ dist-live
```

### 实验二 · 零门上线 + 未过门字节(P1-3 本体)
```
v8:四步全报 ok(零门) + 往 dist/index.html 塞 R4UNGATEDBYTES + promote --version 8 --stamp <nonce>
-> swap ok **200**,v8 live
curl / 含 R4UNGATEDBYTES = 1     （没过门的字节在线上）
curl / 含 R4MARKC        = 0     （v8 声称的内容不在线上）
curl / 含 R4MARKA        = 1     （线上还是两版之前的）
GET /api/config -> liveVersion=8 dirty=0 lastPublishFailed=null
GET /status     -> drift=null
```

### 实验三 · drift 假阴性(P1-4 本体)
```
node promote.mjs（无参,就地同步分支)  after 往 dist 塞 R4MANUALSWAP
-> dist-live/.publish-stamp.json 仍是 {"versionId":8,…}
-> curl / 含 R4MANUALSWAP = 1
-> GET /status -> drift **null**
对照:删掉印记文件 -> drift {"dbLive":8,"snapshot":null}  ✔ 这一半是好的
```

### 实验四 · 组合故障:重发的回报打死执行器(P1-2 本体)
```
v20,真执行器在跑;gates:running 期间替它收口 gates:ok(用库里的 claim_nonce)
5.5 分钟后执行器发出自己的 gates:ok:
  执行器异常: Error: /api/publish/step → 409 {"error":"step-already-done"}
      at api (runner.mjs:32) / runJob (runner.mjs:100) / loop (runner.mjs:133)  {status:409, rejected:true}
  runnerProcs 1 -> 0
善后:v20 publishing;cancel -> canForce:false「执行器仍在工作」;force -> runner-still-alive;
      重启执行器 -> already-claimed;唯一出路 = 干等 12 分钟
```

### 实验五 · 门红两种(config-consistency / render-fit)
```
v9  gates failed 328s -> 服务端配置与代码对不上(…)(门:config-consistency)
    117 条采样唯一指纹 5b9a91c382,R4MARKD 0 命中;dist 109/8693565053e7e1a9 vs dist-live 112/e5d5abb935815a75
v21 gates failed 327s -> 新文案把版面挤破了(…)(门:render-fit)
    128 条采样唯一指纹 08859910d8,R4GATERED 0 命中
    日志含 [verify] ✗ render-fit(运行时) / ✘ A 行间:1 处相邻行的墨会相接 / 墨隙 -14.2 / [verify] 12/13 gates pass
```

### 实验六 · 回滚(v17 ← v7)
```
理由 <8 字 / 无理由 -> 400 reason-required ;  fromVersion:9999 -> 404
四步:materialize 0s / gates 334s / build 3s / swap 1s
05:07:04 采样 fp=5b9a91c382 mark=0  ->  05:07:08 采样 fp=08859910d8 mark=1   （一拍切换）
内容核验:R4MARKB=1  R4MARKA=0 R4MARKC=0 R4UNGATEDBYTES=0 R4MANUALSWAP=0
          ← 一次真发布把我塞进快照的未过门字节整个洗掉了
versions 17:live 8:archived 7:archived（v7 未被复活)
```

### 实验七 · 门红测(隔离副本 `git archive HEAD`)
```
gate-config-consistency --self-test                     8/8 ✓
assets.directory 变异 11 组                              全部 exit 1 ✓（含 r3 漏网的 ../dist-live/../dist)
dist-live 做成指向 dist 的 junction                       **exit 0 ✗ 漏**(P2-11)
真删 RULE_LABEL 的 'encoding-damage'                     exit 1 ✓
wrangler.jsonc 加合法行尾 // 注释                         抛栈崩溃(T23 挂账 ②,仍在)
rule 名带数字(h1-count / r4-red-probe)                   本门完全看不见(P2-10)
npm test:  dist-live 无印记 = 99/99 ✓ ;  有印记 = 98/99 ✗（P2-13)
tsc --noEmit 0 错
```

---

## 七、没能验到的 AC(不静默略过)

1. **CON16-AC4 schema 版本漂移拒绝面**。全仓 `SCHEMA_VERSION` 仍只有定义处与写产物处两个消费点,发布链无一处读它做拒绝。plan 已按证伪结论把它挪进 T23 并改了口径(比两份代码的版本,不比存量数据)。**本轮无可验之物,不作 PASS/FAIL,记为未接线。**
2. **Phase C(CI 执行器)同契约**。只验了 V1-dev 本机 runner;CI 版不存在。
3. **真实 Cloudflare 环境下的原子切换与印记可达性**。四次真发布中 promote 每次都打印「目录被占用(EBUSY),已改用就地同步」;收尾我把服务停掉后再跑一次,**换名分支这次真的走通了**(`✓ 已上线:dist-live ← dist(112 文件)`,且新目录不带印记)——即两条分支本机都验过,但**云端原子性仍依赖平台,未验**。
4. **`test-static.mjs`(37 路由字节级)**。端口硬编码 8788 在我的禁占清单里,且它会用共享 D1 并可能杀掉 8788 上任何进程(见 P2-21)。文件在冻结区不能改。**本轮未跑。**
5. **P1-1(丢 304/Range)在真 Cloudflare 上的表现**。本机 wrangler dev 实测确凿;生产因 `run_worker_first: true`,同一段代码在链路上,我判断行为同构,但**未在云端实测**——标 [INFERRED]。
6. **多执行器真并跑**(两个 runner 同时跑完整门链)未做:本机跑一次门要 5.5 分钟且两个执行器会互相覆盖 `dist`,代价过高。`/next` 的原子占位已用 6 路并发验过,`/step` 现在也绑定了领单口令,**两半都有单向证明,合起来的真并跑仍未做**。
7. **版本历史 >30 条的截断表现**、**窄窗(<1024px)导航折叠**未测(前者机制已从代码确认,见 P2-20;后者不在 T21/T22 AC 文字内)。
8. **抢锁三段无事务**(r2 P2-13)在本机 D1 模拟器上仍无法复现;6 路并发 `POST /api/publish` 未撞出 500,但那不等于生产 D1 上没有窗口。

---

## 八、收尾状态

- **冻结纪律**:`git status --short -- worker/src worker/migrations admin/src worker/*.mjs worker/wrangler.jsonc` **输出为空** —— 全程零写入。唯一一次源码改动是 `schema/src/validators.ts`(不在冻结清单)追加的一行注释,已还原,`git diff` 为空。所有门红测都发生在 scratchpad 里 `git archive HEAD` 出来的隔离副本上(其 `node_modules` / `dist-live` 用 junction 挂载,收尾已先拆链接再清理)。
- **工作树**:`git status --short` **完全干净**(零改动、零未跟踪文件)。执行器物化写过的 `src/i18n/{en,vi,zh}.json` 与 `src/config/site.json` 已 `git checkout` 还原,还原后 `gate-equivalence` 三判全 ✓。**本报告是仓内唯一新增文件。**
- **`dist` / `dist-live` 的最终状态**:两者都是**从干净 HEAD 重新构建的产物**(`npm run build` + `npm run build:console` + `node promote.mjs`),**各 112 文件,指纹同为 `f30c402d3d07f5e5`**,`promote --check` 报「✓ 线上快照与构建产物一致」。**`dist-live/.publish-stamp.json` 不存在**(收尾这次 promote 走的是换名分支,无参不写印记)—— 与我开工时看到的状态一致,也让下一位跑 `npm test` 时是 99/99 而不是 98/99(见 P2-13)。我实验期间塞进快照的 `R4UNGATEDBYTES` / `R4MANUALSWAP` / `R4MARK*` 标记**全部不在**产物里。
- **数据**:本轮造出的 22 个版本号、41 条审计行、发布锁全部关在自建的 `worker/.wrangler-r4`,该目录已 **Move 出仓**(到 scratchpad `wrangler-r4-moved`,未硬删),`worker/` 下不留残留;共享的 `worker/.wrangler` 全程未被触碰(收尾回读仍在)。
- **进程与端口**:wrangler 监督进程树按 PowerShell `Stop-Process` 杀净,`node.exe` 中含 `wrangler|runner.mjs` 的 **0 个**、`workerd` **0 个**;回读 8807 / 8809 / 4405 / 5185 及全部禁占端口(8787/8788/8791/8793/8797/8799/8801/8803/4321/4401/4403)监听数**全部为 0**。别的会话的 4399 / 3002 / 5173 全程未碰,收尾回读三者仍各 1 个监听。
