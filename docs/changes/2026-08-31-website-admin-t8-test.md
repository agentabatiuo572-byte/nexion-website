# T8 独立黑盒验收报告 — 配置草稿 API(乐观锁 / 校验 / 审计)

- **日期**:2026-08-31(实测 10:31–10:45 UTC 一个时段内完成)
- **验收人**:独立 tester agent(未参与实现;全部判定以 curl 真打 + `wrangler d1 execute` 查库为准;读 `src/config.ts`/`src/auth.ts`/迁移 SQL 仅为构造合法请求与正确 SELECT,不作判定依据)
- **被验对象**:`worker/` @ 当前分支工作树(PRD [FEAT-CON04] ②、[FEAT-CON13] ③;plan T8)
- **环境**:隔离实例 port **8793** + 独立 `--persist-to .wrangler-t8`(全新建库,迁移 0001+0002 从零 apply;与他路 8787/8788/默认 `.wrangler` 零接触)
- **结论**:**6/6 AC 全 pass**;补充边界弹 7 发全符合预期;观察项 3 条(均非 T8 缺陷)。**无 P0/P1**。

## 逐 AC 判定(全 curl 真打)

| AC | 判定 | 实测证据 |
|---|---|---|
| A 种子化 | **pass** | 登录后 GET /api/config → `liveVersion=1`(≥1)、`dirty=0`、`draftRev=1`;`copy.en` 叶子键 **177**(≥170;vi/zh 同为 177)、`skus=7`、`faq.items=9`;未登录 GET → **401** `{"error":"unauthorized"}` |
| B 存草稿+审计 | **pass** | 改 `copy.vi.site.name` → `"NexGrid [T8-vi-edit]"`,PUT {payload, baseRevision:1} → **200** `{ok, draftRev:2, changedFromPrev:1}`;GET → `dirty=1`、`changedPaths=["copy.vi.site.name"]`、改值可回读;查库:audit 表行 `action='config.save', target='draft', after_summary='1 处改动:copy.vi.site.name'`(含改动路径);**全审计表逐行四字段总长最大 28 字符** → 无任何 payload 全文入审计 |
| C 乐观锁 | **pass** | 用旧 `baseRevision:1` PUT 不同值(`[T8-STALE-OVERWRITE]`)→ **409** `{"error":"conflict","draftRev":2}`;GET 回读值仍为第一次的 `[T8-vi-edit]`,`draftRev` 未动 → **未被覆盖、未静默 bump** |
| D 校验面 | **pass** | 草稿 en `hero.title` 植入 "guaranteed returns" + `downloads.android={url:https…,enabled:true}`,PUT → **200 可存**(draftRev 2→3);POST /api/config/validate → `errors` 含 `{path:"copy.en.hero.title", rule:"forbidden-word"}`;`sensitiveChanged` 含 `downloads.android.url` 与 `downloads.android.enabled` |
| E key 树封锁 | **pass** | `copy.en` 加自造键 `hacker.x`、`copy.zh` 删 `site.tagline`,PUT → **200 可存**(结构合法,draftRev 3→4);validate → `unknown-key @ copy.en.hacker.x` + `missing-key @ copy.zh.site.tagline`(附带同路径 `untranslated`,合理) |
| F 无直写线上 | **pass** | PUT/POST/DELETE × `/api/config/live` 与 `/api/config/versions/1` **6 发全 404** JSON `{"error":"not-found"}`(带登录 cookie 打,验证「已认证也无此 API」);GET /api/config/versions → 200,首行 `{id:1, status:"live"}`;**库面兜底**:三次成功存稿后 `config_versions` 行数始终 **1**,live payload 内 `T8-vi-edit`/`guaranteed returns`/`hacker.x` 三标记 instr 探针全 0 → 草稿写入从未触碰版本表 |

## 补充边界弹(墨菲前置,全部符合预期)

| 探针 | 结果 |
|---|---|
| 未登录 PUT /api/config/draft | 401(config/* 全保护,不止 GET) |
| `payload:42`(坏结构) | 400 `bad-structure` + zod issues 前 10 条 |
| 缺 `baseRevision` | 400 `bad-request` |
| 审计行数一致性 | `config.save` 恰 **3 行** = 3 次成功 PUT;409/400/401 请求**零审计行** |
| 持久化跨重启 | 测试中 dev 进程一次意外终止(tester 侧管道误伤,非被测缺陷),同 persist 重起后 `draftRev=2`/`dirty=1`/会话 cookie 全部原样 → 状态真落 D1 非内存 |

## 观察项(非 T8 缺陷,上报备案)

- **O1(备案,T7/T21 域)**:种子基线自带 7 条 validate **warnings**(`copy.zh.hero.note`/`hero.subtitle2` 的 `newline-shape` ×2;`stats.*` 的 `mock-anchor` ×5)。均为 warning 非 error,`mock-anchor` 是 R49-F1 预警设计使然;`newline-shape` 的 zh 断行差异大概率合法(CJK 断行),但发布页呈现时会一直挂着 2 条黄条,T21 做发布前置校验 UI 时留意口径。
- **O2(备案,CON14 域)**:`config.save` 审计行 `before_summary=null`。T8 AC 只要求 after 摘要(已满足);CON14-A1 的「before→after 摘要」列表呈现(T22)届时若需 before,得在写审计处补——此处仅备案不定级。
- **O3(环境备忘)**:`wrangler dev` 被 kill 监听子进程(workerd)后会自动重启之,杀端口须杀 **wrangler 主进程树**(本次连杀两轮子进程后定位主进程才净;收尾脚本同型任务照此办理)。

## 收尾核查

- 8793:taskkill 主进程树后 `netstat` LISTEN 计数 **0**(仅剩自然消退的 TIME_WAIT 客户端套接字)。
- `.wrangler-t8` 已整删,`ls` 确认不存在;`git status -- worker/` 干净,仓内除本报告外零写入。
