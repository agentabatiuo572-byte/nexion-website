# 官网运营后台 · 发布流水线服务端行为 · 独立验收报告

日期:2026-09-01 · 分支:`pkg/w-publish` · 验收方:独立(非实现方)

## 本次实际跑了什么

- 起进程:复用已在跑的 `wrangler dev`(`http://127.0.0.1:8787`,本地 D1);另起 **3 次真发布执行器**(`npm run publish:runner --once`,每次含完整 6 分钟门链)、约 10 次独立 `node promote.mjs`、以及数十个自建 Node 攻击脚本(scratchpad 下,UTF-8 干净,避开 Windows curl 的 GBK 编码坑)。
- 打请求:> 120 个 HTTP 请求(登录、preflight、publish、next、step、cancel、status、config、audit;含未认证探针、越权探针、并发探针、幂等重放攻击)。
- 单测:`npx vitest run` 跑通 **112/112**。
- 直接读本地 D1(`node:sqlite` 打开 miniflare 的 `.sqlite`)核对版本行、步骤行、payload,并用真 `schema/src/materialize` 逐字节复算 configSha。
- 破坏说明:按授权破坏了本地环境——`dist-live`/上线印记被多次覆盖、若干测试版本(v7–v14)被我的攻击置为 failed、`src/config` 与 `src/i18n` 被执行器物化覆盖。**未改动任何被审源码**;临时脚本写在 scratchpad,曾在 `schema/` 下临时落过 3 个探针脚本、跑完已 `mv` 出仓(`git status schema/` 干净)。

---

## P1-1 · 无口令重放「旧版本的 swap:ok」可删除进行中发布的锁 + 篡改历史版本状态

**文件:行**
- `worker/src/publish.ts:394-407`(`/step` 第一层「幂等」分支:`recorded === b.status` 即调用 `ensureTerminalEffect`,**在第二层锁/口令校验之前、且完全不经过它**)
- `worker/src/publish.ts:225-232`(`ensureTerminalEffect` 的「上线核验未通过」分支:
  - `:226` `UPDATE config_versions SET status='failed' … WHERE id=?1` —— **无状态守卫**,archived 也会被翻成 failed;
  - `:228` `DELETE FROM publish_lock WHERE id = 1` —— **不按 version_id 限定**,删的是单例锁本身)

**复现步骤(可照做,已跑通两次:v5、v4)**
```
# 1) 找一个「已归档(archived)且 swap 步已记为 ok」的旧版本(每次成功发布都会产出一个:
#    新版 live 时前一版被 archived,其 swap 步是 ok)。本次用 v4。
POST /api/auth/login {"password":"walkthrough-pw-2026"}          # 拿 nx_sid
POST /api/publish {"reason":"..."}                              # 发起一次新发布 -> v14,占住锁(activeVersion=14)
# 2) 用一个「从没领过单、口令是垃圾」的请求,重放旧版本 v4 的 swap:ok:
POST /api/publish/step {"versionId":4,"step":"swap","status":"ok","stamp":"GARBAGE-NONCE"}
```

**实际观测到什么(clean_repro.mjs,隔离复现,v14 全程没有执行器参与)**
```
publish -> 200 versionId 14
BEFORE: activeVersion=14 | v4=archived | v14=validating
replay v4 swap:ok (nonce=GARBAGE) -> 409 {"error":"live-verification-failed", ...}
AFTER:  activeVersion=null | v4=failed | v14=failed
```
- 返回是 409,但**破坏性 batch 已经执行**(409 只是事后返回值)。
- `activeVersion` 由 14 变 null —— **v14 的锁被删**;v14 随后被 `/status` 自愈判为 failed(审计写「发布中断(执行器无响应或超时)」——一句假话:执行器根本没参与,是锁被人删了)。
- v4 由 `archived` 变 `failed`,并写下一条**内容不实的审计**:`config.publish.failed v4 "上线核验未通过:线上快照的印记指向 v804,不是本次要上线的 v4"`——v4 从来不是「本次要上线的版本」。

**为什么这是问题(指到契约/不变量)**
- `/step` 的第二层显式设了授权闸(`worker/src/publish.ts:420-425`「not-current-job」「lock-expired」「not-the-claimed-runner」),PRD CON13-④ 也要求「上报须来自领过单的执行器」。**第一层幂等分支整段绕过了这道授权**——一个带垃圾口令、从未领单的请求,驱动了带副作用的 `ensureTerminalEffect`。
- 代码注释(`:391-393`)的前提是「重发一条已经生效的回报**不改变任何状态**,不需要授权」。这个前提对**已被后续版本取代(不再是 live)的旧版本**为假:重放它的 swap:ok 会走进「上线核验未通过」分支,而该分支**改状态**(翻 v4)且**删锁**(误删当前进行中发布的锁)。
- 违反的不变量:①「状态机 server 权威、单向」——archived→failed 是一次非法逆转,且无状态守卫;②「并发发布锁(E3)」的完整性——锁可被一个与该发布无关、无口令的请求删掉,从而中止任意进行中的发布。

**根因定位**
- 直接根因:`worker/src/publish.ts:405` 在幂等分支里调用 `ensureTerminalEffect`,没有先验证「这条回报是不是当前锁持有者/领单者发的」。
- 放大根因:`ensureTerminalEffect` 的失败分支 `:228` 用 `DELETE … WHERE id = 1`(不带 `version_id`);在**正常路径**下它删的恰是当前版本自己的锁(正确),但经幂等分支为**非当前版本**触发时,删的是别人的锁。`:226` 的 `UPDATE … status='failed' WHERE id=?1` 同样缺 `status IN (...)` 守卫,才会把 archived 翻成 failed。

**影响范围与严重度定性(供裁决)**
- **不能**让未过门内容上线(门在 swap 之前已跑;本攻击不触发上线)。这条 P0 判据未命中。
- 命中的是「安全弱点 + 功能性错误」:**绕过了 `/step` 自设的领单口令授权**,可用一个 HTTP 请求**中止任意进行中的发布**并**篡改历史版本状态 + 写不实审计**。
- 每个「archived + swap=ok」的版本是一次性弹药(攻击会把该版本的 swap 步翻成 failed,自我失效);但正常运营每成功发布一次就新产一枚(前一版被 archived,其 swap=ok),故「用一个请求打掉下一次发布」可持续供应。据此可对发布能力形成**持续骚扰式 DoS**(每次有人发起发布就打掉其锁)。
- 单管理员模型下无跨主体越权,故定 **P1**;但请注意它有两条 P0 邻近面(绕过领单口令这道授权闸 + 可经 HTTP-only 持续阻断发布),裁决时可据此上抬。
- **非攻击也会中招**:幂等分支正是为「回报送到了、响应在回程丢了、执行器重发」设计的。若某次 swap:ok 的重发,**迟到到了该版本已被后续版本取代之后**,同样会走进这条分支,误删当时进行中发布的锁、并把旧版翻成 failed。

**建议方向(不属验收职责,仅供参考)**:幂等分支对「swap + 终态 ok」在调用 `ensureTerminalEffect` 前,应先确认该版本仍是 live 或仍是当前锁持有者;非当前版本的 swap:ok 重放应收敛为无副作用的 no-op。并把 `:226/:228` 的写操作按 `version_id` / `status` 收紧。

---

## P2-1 · swap 核验失败会留下「盘上已换、库记未换」的劈叉,而失败文案称「线上保持旧版」

> 低置信度观察 · 一次实测复现(v11)· 大概率与共享工作树上的并发 agent 干扰有关 · **产品的 fail-closed 行为本身是对的**

**文件:行**
- `worker/src/promote.mjs:111-195`(swap 的真正副作用:先把 `dist`→`dist-live` 并写上线印记)
- `worker/src/publish.ts:212-232`(服务端在 swap:ok 后回核 configSha/锚点;不通过则判 failed,但**盘上内容已被 promote 换过,无法回退**)
- `worker/runner.mjs:150-158` + `worker/src/index.ts` 静态伺服 `dist-live`

**实际观测到什么(第一次执行器跑 v11)**
- v11 走完 materialize/gates/build 全绿,到 swap 被服务端判 `上线核验未通过:内容摘要对不上(期望 4a34ea… 实际 80e1f4…)`。
- 我用真 `materialize` 逐字节复算:`materialize(v11.payload)` = **4a34ea**(server 侧与 runner 侧**完全一致**,不是 schema-parse/物化不确定性的问题)。但 promote 记录的盘上文件摘要是 **80e1f4**,而 80e1f4 **不对应任何一个版本的 payload**(逐版复算 v1–v12 均无此值)——即 promote 读盘那一刻,`src/i18n`+`src/config/site.json` 处在一个不属于任何版本的瞬时状态。
- 结果:`dist-live` 已被 promote 换过、上线印记已写 versionId=11,但 DB 仍记 live=v5、v11 判 failed;`drift` 正确报出 `{dbLive:5, snapshot:11}`。
- 第二次执行器(v12)在同样代码上**干净跑通并上线**;第三次(v13)因 `render-fit` 门真红而正常失败。3 次里只有这 1 次 swap 摘要异常。

**为什么仍值得记(指到契约)**
- PRD CON13 行为边界写「**永不部分上线(原子切换)**」「失败保旧版」;E2/失败面对外话术是「线上保持旧版」。但 swap 的副作用(`promote` 换 `dist-live`)发生在服务端核验之前,一旦核验判失败,**盘上已经是新内容、访客已经看到新内容**,而系统对外说「线上保持旧版」——这句在此路径下不成立。
- 缓解控制在位:`liveSnapshotDrift` 把劈叉报了出来(壳顶 + 发布页),运营能看见并重发对齐。所以是「被检测 + 可恢复」,不是静默事故。

**根因定位(诚实交代:未完全钉死)**
- **确定排除**:不是 schema-parse 差异,也不是 materialize 不确定性——两侧逐字节一致(已实证)。不是系统性 CRLF/编码(v12 同路径 round-trip 正常)。
- **最可能**:本机是 ~30 个 agent 共享的同一工作树 + 同一 `127.0.0.1:8787`。v11 那 6 分钟门窗内,某并发 agent 对 `src/config`/`src/i18n` 的写(build / 物化 / 改配置)会让 promote 读盘时拿到非 v11 内容。属**共享环境并发干扰**,非本流水线代码缺陷的强证据。
- **产品侧正面结论**:configSha + 锚点核验在此**正确地 fail-closed**——盘上内容对不上就拒绝标 live,没让「非该版本的内容」被记成正式上线。这正是该机制该有的行为。
- 唯一可指为设计取舍的点:swap 的文件副作用不可由服务端回滚,故核验失败时「线上保持旧版」文案不准;这一取舍由 drift 检测兜底(见上)。生产路径按 PRD 用 Cloudflare 随 Worker 原子部署,不走 `promote.mjs` 这套换目录逻辑。

---

## 我核验为「成立」的部分(签字面的正面结论)

以下均经**主动构造攻击序列 + 实测**(非读码推断),核心安全属性成立:

1. **不存在绕门上线的 HTTP 序列(核心不变量)**:
   - 「照合法顺序把四步各报一遍」→ 到 swap 被上线印记核验挡下(`live-verification-failed`,印记版本号/口令/configSha 三重绑定)。实测 v7、v11 均无法 live。
   - 跳步(直接 swap / 直接 gates)→ `step-out-of-order`;未先 running 就收口 → `step-not-running`;这些是「不存在绕门」的真实承载点。
   - 全仓仅 `publish.ts:236` 一处写 `status='live'`,且被 `ensureTerminalEffect` 的 `good` 核验(印记 versionId+口令+configSha+锚点)守死;上线印记仅 `promote.mjs:169` 写(HTTP 面写不进文件系统)。结构上闭合。
2. **认证**:全部 `/api/publish/*` 未登录 → 401。`requireAuth` 用 session-hash 校验;登录 PBKDF2 600k + timingSafeEqual + 原子先占名额限速(15 分钟 5 次锁),无明显弱点(CON01 域,附带核过)。
3. **口令/领单授权(正常路径)**:不领单上报 → `not-the-claimed-runner`;错口令 → 同拒;两执行器并发领单只有一个拿到(原子 `WHERE claimed_at IS NULL`)。(注:此授权被 P1-1 的幂等分支绕过——见上。)
4. **并发发布(E3)**:第二次 → 409 `publish-in-progress`,且**不建垃圾版本行**(实测 max id 不增),只留一条 `config.publish.rejected` 审计。
5. **回滚(A2)**:只能回滚到 live/archived;回滚到 failed/不存在版本 → 404;回滚须 ≥8 字理由;回滚内容照走完整门链。
6. **取消(E4)**:排队态可直接取消(记 `cancelled` 非 `failed`);已开工未失联不许取消;失联 12 分钟 + 理由才可强制中止。
7. **自愈**:执行器死后「发布中」不会永挂——`/status`/`acquireLock` 把过期锁的版本判 failed 并收口步骤,不误伤当前活跃版本(`id <> active`)。
8. **上线印记不对公网开放**:`/.publish-stamp.json` → 404 不泄露;大小写变体、`?query`、`..` 变体均未泄露(资产清单大小写敏感,实测不命中)。
9. **地理模拟头**:`x-geo-sim` 仅在 `ENVIRONMENT ∈ {dev,preview}` 白名单生效,生产 fail-closed(非本线核心,附带核过)。
10. **192 格转移表**穷举测试在位;`vitest` 112/112 全绿。
11. **编码**:中文经 Node(UTF-8)读写完全干净(`已取消(执行器未上线)` 等 round-trip 无损)。此前在 status 里看到的 v6 乱码 reason 是 **curl/PowerShell 的 GBK 写入残留**,非产品缺陷。

---

## 一句话给主人

发布流水线的**核心安全承诺(HTTP 面绕不过机器门上线)成立且相当扎实**——印记机制在各种攻击序列下都 fail-closed。但挖到**一条 P1**:`/step` 的「幂等重放」分支绕过了它自己的领单口令授权,导致**一个带垃圾口令、从未领单的请求,重放某个旧版本的 swap:ok,就能删掉正在进行的发布的锁、把那次发布打断,并把一个历史 archived 版本翻成 failed(还写下不实审计)**;已在 v5、v4 两次隔离复现。另有一条 P2 观察(swap 核验失败会留下「盘上已换、库记未换」的劈叉,大概率是共享环境并发干扰,产品的拒绝上线本身是对的)。
