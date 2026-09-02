# 官网后台 worker T2 独立验收报告 — 登录/会话/审计底座

- 日期:2026-08-31 · 验收人:独立 tester(t2,未参与实现)
- 被验对象:`.wt/w-console/worker`(分支 pkg/w-console-core)· wrangler dev @ 127.0.0.1:8787 · 全新本地 D1(0001_init.sql 应用成功)
- 方法:黑盒 curl 真请求逐 AC 实测;单测/typecheck 仅作旁证;另用 `wrangler d1 execute --local` 直查库、grep dev 全量日志作敏感值三层核验。

## 总判

| AC | 判定 | 一句话 |
|---|---|---|
| AC1 setup→login→cookie→/api/me | **PASS** | Set-Cookie 五要素全中,带 cookie /api/me 200 |
| AC2 限速锁定 | **PASS** | 5×401 通用文案 → 第 6 次正确口令 429 → 换 IP 不连坐 |
| AC3 401/410/403 | **PASS** | 三态各归其位 |
| AC4 审计列出/只读/敏感值 | **PASS** | 行齐全 · PUT/PATCH/DELETE 全 404 · 三层 0 泄漏 |
| 附加 npm test / typecheck | **PASS** | 退出码 0 / 0(14/14 测试,3 文件;非空套件) |

发现 0 个阻断问题;4 条 P2 级观察(§观察项),全部上报。

## AC1 — PASS

1. `POST /api/auth/setup {token:"dev-setup-token", password:"T2-Probe-Pass-2026!x"}`(20 位)→ `200 {"ok":true}`。
2. `POST /api/auth/login {password}` → `200`,响应头逐字:
   ```
   Set-Cookie: nx_sid=87e0630047fd85e4c279f52e5c5607f9968c3bd4568547972b03df9ea701c30e; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax
   ```
   核对:含 nx_sid ✓(64 hex = 256-bit)· HttpOnly ✓ · Secure ✓ · SameSite=Lax ✓ · Max-Age=604800 ✓。
3. `GET /api/me`(带 cookie)→ `200 {"ok":true,"actor":"admin"}`。

## AC2 — PASS

固定来源 `cf-connecting-ip: 203.0.113.50`:

| 次 | 口令 | 结果 |
|---|---|---|
| 1–5 | 错(`Wrong-Password-99999`) | 每次 `401 {"error":"invalid-credentials"}` |
| 6 | **正确** | `429 {"error":"too-many-attempts"}` |

- 错误文案 `invalid-credentials` 不区分用户名/口令哪个错 ✓(PRD E1)。
- 锁定窗口内正确口令也不放行 ✓(PRD E2)。
- 旁证:换 `cf-connecting-ip: 203.0.113.51` 打错口令 → `401`(非 429),失败计数按来源隔离、不连坐 ✓。

## AC3 — PASS

| 场景 | 结果 |
|---|---|
| `GET /api/me` 无 cookie | `401 {"error":"unauthorized"}` |
| 未初始化态 + 错 token setup(重置库后第一发) | `403 {"error":"forbidden"}`,且**未**把状态打成已初始化(后续正确 setup 仍 200) |
| 已初始化后再 setup(正确 token) | `410 {"error":"already-initialized"}` |
| 已初始化后再 setup(错 token) | 同样 `410`(先判初始化态,不泄露 token 对错;合 PRD E4) |

## AC4 — PASS

1. **列出**:`GET /api/audit`(带 cookie)→ 200,9 行全量(`nextBefore:1`):`auth.setup`(id1)→ `login.success`(id2)→ 7×`login.fail`(id3–9,含被锁那次 `reason:"locked"`、旁证 IP 那次 target=203.0.113.51)。setup/login 相关行齐全,连锁定拒绝也入审计。
2. **只读面**:带登录 cookie 对 `/api/audit/1` 发 `PUT`→404、`PATCH`→404、`DELETE`→404(落入未知 /api/* 的 JSON 404 封口);无 cookie `DELETE`→401(auth 中间件在前,更严)。不存在修改/删除 API ✓(PRD E2)。
3. **敏感值三层核验,全 0 命中**(grep 目标:`T2-Probe-Pass`/`Wrong-Password`/`Another-Pass`/`short1`/sid 值 `87e0630047fd…`):
   - /api/audit 响应全文:0 命中;
   - D1 `audit` 表 6 字段拼接 LIKE 直查:`leak=0`;
   - wrangler dev 全量 stdout 日志(终态):0 命中。

## AC 外顺带实测(全部通过,记档)

- **口令 ≥12 位有校验**:未初始化态正确 token + 6 位口令 → `400 {"error":"password-too-short(min 12)"}`(PRD §3)。
- **7 天滑动续期真在跑(运行时定量证明)**:sessions 表 `created_at=1788161338585`,首查 `expires_at=1788766184530`(= 上一次带 cookie 请求 +604800000,已比 created+7d 多 46s);再打一次 /api/me(本机时刻 1788161460636)后回查 `expires_at=1788766260682` = 该请求时刻 +604800000(46ms 处理差),每次请求前移 ✓。
- **库内只存哈希**:`auth_account.password_hash` 64-hex + 独立 salt;`sessions.token_hash`(64-hex,头 `a9310f11…`)≠ cookie 明文 sid(头 `87e06300…`),即令牌落库前已哈希 ✓(PRD:sessionToken 仅存哈希)。
- **logout 是服务端真销毁**:`POST /api/auth/logout` → 200 + `Set-Cookie: nx_sid=; Max-Age=0; Path=/`;随后旧 cookie 访问 /api/me → 401。

## 观察项(P2,非阻断,均不在本次 AC 判据内)

1. **429 无等待时长信息**:响应无 `Retry-After` 头、body 无 lockedUntil。前端文案「尝试过多,15 分钟后再试」只能写死 15 分钟,无法显示真实剩余倒计时(PRD ⑤「锁定倒计时显示」将缺数据源)。建议补 `Retry-After` 或 body 字段。
2. **logout 清 cookie 属性不全**:`nx_sid=; Max-Age=0; Path=/` 未带 HttpOnly/Secure/SameSite。功能无害(空值即刻过期),但最佳实践为与设置时属性镜像,避免个别浏览器视作不同 cookie。
3. **无 cf-connecting-ip 时 login.success 的 target="unknown"**:本地 dev 直连无 CF 头所致;生产在 Cloudflare 后该头恒在。仅本地观感问题。
4. **setup 的审计动作名为 `auth.setup`**:PRD CON14 字典列举 `login.success/login.fail/config.*…`(带省略号,实现期封闭枚举)。`auth.setup` 未在 PRD 明文列举,PRD 同步时应把它补进动作字典明文。

## 环境排除记录

- 起测前 8787 端口确认无监听;`.wrangler` 旧状态**移动**(非删)至 scratchpad 备份 `…\scratchpad\wrangler-state-backup-20260831-*`,保证未初始化态;dev 起服日志确认迁移 `0001_init.sql ✅`、绑定 DB/KV/ASSETS/SETUP_TOKEN 齐全,被测服务确为本人所起进程。
- 单测/typecheck 退出码按 `cmd > log 2>&1; echo $?` 直取(无管道尾巴):`npm test` → **0**(Test Files 3 passed, Tests 14 passed);`npm run typecheck` → **0**(无输出)。
- 收尾:taskkill 进程树(wrangler node 父进程 + workerd)后复验 `PORT 8787 EMPTY`。dev 日志尾部两条 "Workers runtime crashed…restarted" 为本人杀 workerd 时 wrangler 的自动重启告警,非产品缺陷;最终父进程树杀净后端口空。
- 冻结遵守:除本报告外未写/未改仓内任何文件(`.wrangler` 为 dev 运行自然生成的本地缓存,gitignored)。
