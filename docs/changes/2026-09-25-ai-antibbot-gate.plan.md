# AI 反爬闸实施计划(官网 P0–P2)

> 规格:`PLAN/PRD/specs/FEAT-ANTIBOT01-ai-crawler-edge-gate.md`(Signed 2026-09-25)
> 分支:`codex/ai-antibbot-gate-20260925` · worktree:`.wt/website-antibbot-20260925`
> 范围:官网 P0(观测)/ P1(声明 + 名单)/ P2(挑战闸);P3 观测台另立任务,H5 暂缓。

## 不变量

- 现有 15 门 verify 全绿;发布链(`gx_bypass` 直通 / 探活 / promote)不受影响。
- dev/preview 默认 `monitor`(只记不拦);`enforce` 必须显式配置,不在代码里默认开。
- 豁免路径:`/admin*`、`/api/*`、`/robots.txt`、`/sitemap*`、`/.well-known/*`、静态资产(HTML 除外)。
- 事件不落原始 IP;UA 只截断到名单家族;挑战壳不含任何站点正文。
- 不编造厂商 IP 段数据:IP/CIDR 维度只接受策略配置输入,缺数据时不做假定。

## 步骤与验收

| # | 步骤 | 产物 | 验收要点 | 检查 |
|---|---|---|---|---|
| 1 | 分类器 | `worker/src/aibot.ts` · `worker/test/aibot.spec.ts` | AI 训练/索引/浏览、搜索引擎、社交预览、普通流量分类正确;大小写不敏感;同族先具体后泛化 | `npm --prefix worker test -- test/aibot.spec.ts` |
| 2 | 闸核心 | `worker/src/gate.ts` · `worker/test/gate.spec.ts` | cookie 签名/校验/篡改拒绝/过期/UA 绑定/子网绑定;判定表;`returnTo` 消毒;挑战壳无正文 + noscript;Turnstile 校验成功/失败/超时 | `npm --prefix worker test -- test/gate.spec.ts` |
| 3 | 中间件接线 | `worker/src/index.ts` · `worker/src/geo.ts`(导出 bypass)· `worker/src/env.ts` · `worker/wrangler.jsonc` · `worker/test/gate-middleware.spec.ts` | 无 cookie → 挑战壳;AI/搜索名单 → 403(enforce);monitor 只记不拦;豁免直通;`/__gate/verify` 签发 cookie;`gx_bypass` 直通 | `npm --prefix worker test -- test/gate-middleware.spec.ts` |
| 4 | 声明层 | `public/robots.txt` · `scripts/gate-robots.mjs` · `scripts/verify.mjs` 接线 | 默认全禁 + 社交 unfurler `Allow`;robots.txt 不被闸拦;门自带红绿两向自测 | `node scripts/gate-robots.mjs --self-test` + `npm run verify` |
| 5 | 事件与汇总 | `schema/src/event-contract.ts` · `worker/migrations/0024_daily_gate.sql` · `worker/src/rollup.ts` · `worker/test/gate-events.spec.ts` | `gate` 事件入库;`daily_gate` 按日 × 判定 × 原因汇总;坏 payload 拒绝 | `npm --prefix worker test -- test/gate-events.spec.ts` |
| 6 | 集成 | 运行时验收脚本 + 独立审查 | 规格 §5.2 GWT 全过;真人浏览器无感通过;curl/默认无头拿不到正文;发布链直通 | `npm run typecheck` + 全量 worker 测试 + `npm run verify` + 运行时脚本 |

## 依赖

- 1 → 2 → 3 → 6;5 依赖 3(事件字段与写入点);4 独立,但集成门依赖其产物。
- 步骤 3 触碰 `index.ts` 中间件链与 `geo.ts` 导出,是本次唯一的横向改动点。

## 已知边界

- 厂商 IP 段名单与后台观测台(P3)不在本次范围;monitor 数据先落 `raw_events`。
- Turnstile 本地/测试用官方测试密钥;生产密钥按 Q6 决策在部署期配置。
- 官网尚未上生产(Phase C 待切换),本次交付「代码 + 本机验证」,monitor 观察期在上线后跑。

## 独立审查闭环(2026-09-25)

独立 agent 审查结论:**pass-with-findings(无 P0)**。修补记录:

- **P1-1 观测缺口** → 挑战/降级/社交/内部逐条写入;cookie 放行 **1 次/5 分钟/IP 采样**。运行时实测事件 id 6–10:`block e:1` / `challenge_issued e:1` ×3 / `cookie_valid e:0`。
- **P1-2 超时缺失** → siteverify 加 5s `AbortSignal.timeout`;挑战页 verify fetch 加 8s 超时并恢复重试出口;挂起用例已入 gate.spec。
- **P1-3 T4 证据缺口** → 新增**真 Turnstile(官方测试密钥)完整闭环**浏览器 E2E(不拦截任何域):挑战页 → Turnstile 通过 → verify 签发 cookie → 回原页 → 首页渲染,实跑通过。生产真 widget 的 managed 通过率仍属上线实测项。
- **P2 已修**:冷却页 + 重试倒计时;「为什么看到这个页面?」常显展开控件;policy degraded 并入降级判定;`e` 按实际动作判定;`listVersion` 限幅;`ipSubnet` 处理 `::ffff:` 映射与 IPv6 归一;`.pdf` 不再豁免(正文文档);社交名单与分类器同源导入;rollup 注释 29→31;死代码清理。
- **规格同步**:§3.3 文档类不豁免 · §3.5 放行采样口径 · FEAT-ANTIBOT01 ④ 节流下限措辞。

## 部署清单(Phase C 上线切换时)

1. **先** `wrangler d1 migrations apply nexgrid_site`——0024_daily_gate 必须先于代码上线,否则 rollup batch 整体失败、90 天清理停摆。
2. `wrangler secret put GATE_SECRET` / `TURNSTILE_SECRET`(轮换 dev 默认值);`TURNSTILE_SITE_KEY` 换生产 widget 公开密钥。
3. KV `gate:policy` 初始 `{"mode":"monitor"}`,观察 3–7 天后切 `enforce`。

## 进度(2026-09-25)

- [x] 1 分类器 — 56/56;worker typecheck 0 错
- [x] 2 闸核心 — 16/16
- [x] 3 中间件接线 — 11/11;全量 worker 套件 732/732;官网 typecheck 0 错
- [x] 4 声明层 — 自测 6/6;`npm run verify` **21/21 全绿**(含新门 `ai-antibbot-robots`)
- [x] 5 事件与汇总 — 迁移 0024 + rollup 形状校验/聚合;gate-events 3/3;全量 732/732
- [x] 6 集成(运行时) — 真 wrangler dev + curl + Playwright:挑战壳无正文、AI/搜索引擎 403、cookie 放行/换 UA 失效、robots 默认全禁
- [x] 6 集成(monitor 复验)— **干净单实例(全指标)**:探测前 8790 零监听 → 启动后唯一监听 PID 11544(创建时间=本次启动、父 23976)→ GPTBot 探测 200 → 事件 id 4→5 且 `e:0`(would-block 只记不拦)
  - ⚠️ 关停纪律:必须杀 supervisor 父进程树;只杀 workerd 子进程会被自动重启(曾把重启误读成「双实例」)
- [x] 6b 独立审查 — pass-with-findings;P1/P2 已修补并复验(见上「独立审查闭环」)

### 运行时验收命令(可重复)

```bash
# ⚠️ 验收纪律:① 探测前 netstat 确认零监听;② 期间确认唯一监听并记录其 PID/创建时间;
#    ③ 关停杀 supervisor 父进程树(只杀 workerd 子进程会被自动重启,误读为双实例)。
# 1) 本地策略与迁移
cd worker && npx wrangler d1 migrations apply nexgrid_site --local
npx wrangler kv key put --binding KV gate:policy '{"mode":"enforce","bindMode":"ua"}' --local
# 2) 起真实 dev server
npx wrangler dev --port 8790 --local
# 3) curl 探测:无 cookie→挑战壳;GPTBot/Googlebot→403;robots→默认全禁;有效 cookie→正文
# 4) 真浏览器
node --import ./worker/register-ts-ext.mjs worker/test-antibbot-browser.mjs
# 5) monitor 模式:改 KV 后重启,GPTBot 不再 403,raw_events 出现 e:0 的 gate 事件
```
