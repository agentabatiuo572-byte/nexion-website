# T5/T6 独立黑盒验收报告 — 采集接口 + 日汇总口径

- **日期**:2026-08-31(全部实测发生在 2026-08-31 08:20–08:30 UTC,无跨日界风险)
- **验收人**:独立 tester agent(未参与实现;逐 AC 实测,单测仅作旁证另跑)
- **被验对象**:`worker/` @ 当前分支工作树(黑盒:仅读 §5.2 线上契约 `src/events.ts` 与迁移 SQL 以构造合法请求/正确 SELECT;两处例外见 O1/O3,均为**定性发现根因**的回源读码,先有黑盒观测后有读码)
- **环境**:隔离实例 port 8791 + 独立 `--persist-to .wrangler-t5t6`(与并行验收的 8787/默认 `.wrangler` 完全隔离);T5 与 T6 之间删目录清库重起
- **结论**:**T5 5/5 pass、T6 3/3 pass**(AC-A 内「country=VN」单断言在本地不成立,定性为 dev 环境仿真遮蔽,非实现缺陷,详 O1);观察项 5 条全部上报,无 P0/P1

## AC-T5 · 采集接口(curl 真打 /api/e)

| AC | 判定 | 实测证据 |
|---|---|---|
| A 合法批次 | **pass**(4/5 断言;country 断言见 O1) | HTTP 200 `{"ok":true}`;库中 1 行:`uid=da081f86e48cf3ad`(16 位小写 hex)、payload `bot:0`、payload 含 `country`(值=JP 非 VN,O1);**整行无 203.0.113.10、无 UA 原文** |
| B 畸形四连 | **pass** | 空对象 / 未知 `t:"zzz"` / 11 条事件 / path 201 字 → **4×400** `{"error":"bad-payload"}`;raw_events 行数前后均为 2,**零入库** |
| C 爬虫 UA | **pass** | Googlebot UA → 200,库行 payload `bot:1`,uid 仍为哈希 16hex |
| D 限速 | **pass** | node 脚本同 IP(198.18.0.99)连发 121 请求(1.54s 内,无令牌回填干扰):**前 120 个全 200,第 121 个 429**(429 首现于第 121 个);换 IP 198.18.0.100 **立即 200** |
| E 隐私 | **pass** | 全表 124 行(=1+1+1+120+1,恰合发送数)dump 后 grep 全部 6 个 IP + 5 个 UA 原文:**0 命中**;加强扫:对整个 `.wrangler-t5t6` 持久化目录(D1 sqlite + KV)二进制 grep 同样 0 命中 → **限速状态也未把 IP 落盘**(纯内存);`length(uid)!=16 OR uid GLOB '*[^0-9a-f]*'` 计数 = 0 |

补充:124 行只有 5 个 distinct uid,与 5 个 distinct(IP,UA)组合一一对应 → 同源同 uid、异源异 uid,哈希稳定性成立。

## AC-T6 · 汇总口径(curl 造数 → 登录 → 手动汇总 → 对账,清库后全新实例)

- 初始化:`POST /api/auth/setup`(dev-setup-token + 20 字口令)→ 200;`POST /api/auth/login` → 200,得 `nx_sid` HttpOnly cookie(过期 = 签发 + 7 天整,与 T2 契约一致)。

### F · 注入设计与预注册手算期望(注入前写定)

| 访客 | IP / UA | 事件 |
|---|---|---|
| A | 203.0.113.10 / TesterBrowserA(en·m·direct) | pv `/`、pv `/pricing`、pv `/learn/what-is-nexgrid`、sec `hero`、cta `ios`(共 5) |
| B | 198.51.100.20 / TesterBrowserB(vi·d·search) | pv `/`×2(其一带 utm 三参)、sec `hero`(共 3) |
| Bot | 192.0.2.30 / Googlebot UA(en·d·direct) | pv `/`(共 1) |

3 批全 200;raw_events 恰 9 行、全落 2026-08-31 UTC、3 个 distinct uid(A×5 / B×3 / Bot×1 且 bot=1)。country 全为 JP(O1,手算表已按此预登记)。

**手算期望 vs 实测**(`POST /api/admin/rollup {"date":"2026-08-31"}` 带 cookie → 200):

| 表 | 手算期望 | 实测 | 判定 |
|---|---|---|---|
| daily_traffic | 恰 2 行:(en,JP,m,direct) pv=3/uv=1/sessions=1;(vi,JP,d,search) pv=2/uv=1/sessions=1;**无 Bot 行**(Σpv=5 非 6,Σuv=2 非 3) | 逐字段全等,无第三行 | ✅ |
| daily_cta | 恰 1 行 (ios,en) clicks=1/uniq=1 | 全等 | ✅ |
| daily_section | 恰 1 行 (hero) uniq=2(A+B 去重) | 全等 | ✅ |
| daily_learn | (what-is-nexgrid) reads=1(由 pv path 派生,O3) | 全等 | ✅ |
| daily_bot | 两候选公式:按事件 1/9≈0.111;按 pv 1/6≈0.167 | **0.167 → 命中「Bot pv ÷ 全部 pv」口径**(O5) | ✅ |
| daily_vitals / faq / errors / blocked | 空(无对应事件;缺即缺,不写 0 假行) | 全空 | ✅ |

### G · 幂等

同日期重跑 rollup → 200;复查四表:pv 仍 3/2、clicks 1、uniq 2、bot_share 0.167 —— **数值零翻倍**(delete-then-insert 语义,黑盒复验成立)。

### H · 审计与鉴权

- audit 表:`admin.rollup ×2`(两次调用各一行)+ `auth.setup ×1` + `login.success ×1` ✅
- 未带 cookie `POST /api/admin/rollup` → **401** `{"error":"unauthorized"}` ✅

## 附加(旁证,非顶账)

- `npm test`:**exit 0**,5 文件 27 用例全绿 —— 其中 rollup.spec 覆盖黑盒无法注入的时序口径(30 分钟会话切分、跨日盐轮换、90 天滚动清理、p75 nearest-rank、blocked 分桶),作为对本报告未覆盖时序维度的旁证
- `npm run typecheck`:**exit 0**

## 观察项(全部上报,无遗漏)

| # | 级 | 内容 |
|---|---|---|
| O1 | P3(dev 环境) | **AC-A「country=VN」断言在本地不成立**:实测 country=JP 且换发 `cf-ipcountry: US` 仍 JP。回源定性:`src/ingest.ts:49` 取 `request.cf.country ?? header('cf-ipcountry') ?? 'XX'`,而 wrangler dev 会按本机真实出口仿真 `request.cf`(本机出口=JP),把 header 遮蔽死。**生产行为正确**(cf.country 为 Cloudflare 权威值,优先它更稳);代价是本地无法用 header 模拟国家维度 → T19/T24 若需分国家造数,需另想注入面(如 vitest 内直调或 dev-only 旁路),建议实现方知悉 |
| O2 | P3(表面) | rollup 日期只做形状校验:`31-08-2026`/`{}` → 400 `bad-date` ✅,但 `2026-13-99`(形合历不合)→ 200 `{"ok":true}`。已验证**零数据影响**(全部 daily_* 无该日期行,真实日期数据未动),仅多一行 admin.rollup 审计 + 误导性 ok 响应 |
| O3 | 记录 | PRD §5.2 列 `learn` 为七类事件之一,但线上契约 `events.ts` 无 learn 变体 —— rollup.ts 头注已写明设计:learn 由 pv path `/learn/<slug>`(三语前缀通吃)派生。黑盒实测派生正确(reads=1)。属文档-实现措辞差,不是缺陷;PRD §5.2 该行本就写「文章页 pv 附加」,口径自洽 |
| O4 | 记录 | uid 同日跨清库稳定(A 在两个全新库中 uid 相同):盐 = 秘密 env(dev 固定值)+ 日期派生,同日同源必同 uid、符合「当日轮换盐」公式意图;**跨日轮换不可黑盒验**(无法拨快 worker 时钟),由绿的单测(盐轮换用例)旁证 |
| O5 | 记录 | daily_bot 分母口径实测 = **Bot pv ÷ 全部 pv**(0.167=1/6),非按请求数(1/3)也非按全事件(1/9)。与 CON03-③「UA 命中已知爬虫表的请求占比」的「请求」字面有一格解释距离,但以 pv 为分母与流量口径同基,自洽;驾驶舱(T19/T20)展示该值时沿用同一分母即可,不必改 |

## 收尾清理

- 8791 进程树已杀净,`netstat` 回读 **无 LISTEN**;8787/默认 `.wrangler`(另一路)全程未触碰
- `.wrangler-t5t6` 目录已整目录删除;临时脚本/日志全在 session scratchpad,仓内除本报告外零写入
