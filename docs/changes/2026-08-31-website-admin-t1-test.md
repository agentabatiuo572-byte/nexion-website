# T1 独立验收报告 — worker 骨架(2026-08-31)

- 验收对象:`D:\WORKS\PLAN\.wt\w-console\worker`(分支 pkg/w-console-core,HEAD 3cc3a57)
- 验收方式:黑盒,按 `worker/README.md` 命令序列实测;未读实现过程叙述;除本报告外零写入(git status 前后均 clean)
- 环境:Windows 11,node v24.15.0,npm 11.12.1,wrangler 4.127.1(实际解析版本)

## 结论

**4/4 全部 PASS(AC1/AC2/AC3/typecheck)。** 另报 3 条不影响判定的观察项(见文末)。

## AC1 — README 命令序列可跑通:PASS

| 步骤 | 结果 | 证据 |
|---|---|---|
| `npm install` | EXIT=0 | `found 0 vulnerabilities`,postinstall(wrangler types)未报错 |
| `npm run dev` 起服 | 起服成功 | dev 日志:先 `d1 migrations apply`(`0001_init.sql … 21 commands executed successfully ✅`),后 `Ready on http://127.0.0.1:8787` |
| `GET /api/health` | HTTP=200 | body:`{"ok":true,"service":"nexgrid-site-worker","environment":"dev"}` — 含 `"ok":true` |
| 本地 D1 16 表 | 16/16 齐 | `npx wrangler d1 execute nexgrid_site --local --command "SELECT name FROM sqlite_master WHERE type='table'"` EXIT=0 |

表清单核对(查询结果 vs 要求 16 表):config_versions ✓ config_draft ✓ audit ✓ auth_account ✓ sessions ✓ login_throttle ✓ raw_events ✓ daily_traffic ✓ daily_cta ✓ daily_section ✓ daily_faq ✓ daily_learn ✓ daily_vitals ✓ daily_errors ✓ daily_blocked ✓ daily_bot ✓。另有 `_cf_METADATA` / `d1_migrations` / `sqlite_sequence` 三张系统表,属 D1/SQLite 框架自带,正常。

注:本次 dev 启动时迁移是**现场新应用**的(日志明示"Migrations to be applied: 0001_init.sql"而非"已应用跳过"),即 16 表由本次验收自己的运行创建——从 checkout 到建表的链路是运行时证明,不是查旧状态。

## AC2 — `npm test` 绿且真用 D1/KV 绑定:PASS

- EXIT=0;**1 个测试文件,3 用例,3 通过**(vitest 4.1.11,Duration 734ms)。
- 用例内容核对(`worker/test/smoke.spec.ts`):
  1. health 端点 200 + `ok:true` + environment 字段(经 `app.request` 走真 env);
  2. **D1 实测**:`env.DB.prepare` 查 sqlite_master 断言 16 表逐一在列,再 INSERT 一行 audit 并 COUNT 断言 >0(读+写都走真绑定);
  3. **KV 实测**:`env.KV.put` / `get` 回读断言。
- 迁移经 `test/apply-migrations.ts` 的 `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)` 在测试 worker 内应用(与 dev 的 .wrangler 状态相互独立,不依赖前置状态)。

## AC3 — 红测方向验证:PASS

- `npm run test:red-d1` **EXIT=1(非零)**,符合"去掉 D1 绑定必红"。
- 失败点:setup 阶段 `TypeError: Failed to execute 'applyD1Migrations': parameter 1 is not of type 'D1Database'`(wrangler.red.jsonc 无 D1 绑定 → env.DB 为 undefined)。
- 判读:测试链路真依赖 D1,不是摆设;红测方向成立。

## 附加核查 — `npm run typecheck`:PASS

- EXIT=0(tsc --noEmit 零错;worker/tsconfig.json 自包含,不 extends 站点根配置)。

## 环境排除记录(报 fail 前已排除的假阴因素)

1. **端口 8787 被占**:验收开始时被前次会话遗留的孤儿 `wrangler dev --port 8787`(node pid 20944)及其多个 workerd 子进程占用;按任务给的清理步骤逐层清掉(先杀父进程再清 workerd)后端口干净,才开始起服实测。
2. **退出码读法**:所有命令用 `cmd > log 2>&1; echo $?` 直读,无管道尾巴污染。
3. **npm 网络**:install 一次成功,无需重试;日志有 proxy 环境变量 WARNING(wrangler 提示走代理 fetch),不影响任何 AC。
4. **收尾**:验收自起的 dev 进程已全部杀净——复核 `port 8787 released` / `no workerd leftovers` / `no wrangler leftovers`,不留孤儿。

## 观察项(不影响 AC 判定,全量上报不自我审查)

- **O1(轻)**:红测在 setup 阶段整体炸掉,3 个用例实际 0 个执行(套件级红,非"仅 D1 用例红、KV/health 用例仍绿"的用例级红)。按 AC3 文本("必须非零退出")判 PASS;若未来想要更细粒度的方向证明(证明"具体是 D1 用例在依赖 D1"),需把迁移 setup 改成容错再看单测逐个红,现阶段无此要求。
- **O2(轻)**:`wrangler dev` 输出一条 WARNING:`Cannot find base config file "astro/tsconfigs/strict"`——wrangler 的 esbuild 扫到父目录(站点根)`../tsconfig.json`,其 extends 的 astro 配置从 worker 上下文解析不到。纯提示噪音,typecheck/test/dev 均不受影响;介意可留待后续包顺手消音,不构成 T1 缺陷。
- **O3(流程)**:验收开始时发现实现侧遗留了一个还在跑的 `wrangler dev` 孤儿进程占着 8787(见环境排除 1)。代码无缺陷,属进程收尾卫生问题,提请实现侧注意收尾杀进程。

## 一句话结论

主人,T1 骨架四项验收全绿:从当前 checkout 三条命令能装、能测(3/3,真用 D1+KV)、能起服(health 200 + `"ok":true`),16 张表由本次运行现场建齐,红测证明测试真依赖 D1,typecheck 零错;仅 3 条轻量观察项,无阻塞项。
