# T3 · 静态产物伺服 — 独立黑盒验收报告

- **日期**:2026-08-31 · **tester**:独立验收 agent(未参与实现)
- **被验对象**:`worker/`(分支 pkg/w-console-core)+ `dist/` 构建产物(验收时已存在,未重建)
- **结论**:**AC 3/3 PASS**(另附 2 条 P2 观察项与 1 条执行偏离,见文末)

## AC1 · `node test-static.mjs` 退出码 0,≥10 条路由字节一致 — PASS

- 执行:`worker/` 内 `node test-static.mjs > log 2>&1; echo $?` → **EXIT=0**
- 输出关键行:
  - `✓ API 直通:/api/health 200`
  - `✓ 字节级一致:36/36 条路由(含三语)` ← **36 ≥ 10**
  - `✓ 未知路径 404(实测 404)`
  - `PASS test-static(36 路由)`
- 脚本自带收尾:taskkill /T + 8788 端口回读补杀;本 tester 跑完后实测 8788 无监听残留。

## AC2 · 独立抽验(不依赖被验脚本,自写探针) — PASS

自起 `npm run dev -- --port 8790`(8787 被并行 T2 验收的 workerd 占用,见偏离 D1),wrangler Ready 后用自写 node 探针(内存内取体对比,零仓内写入):

| 探针 | 实测 | 判定 |
|---|---|---|
| `GET /`(en) | 200,body 54866B == `dist/index.html` 字节全等 | PASS |
| `GET /vi/`(vi) | 200,body 58510B == `dist/vi/index.html` 字节全等 | PASS |
| `GET /zh/learn/`(zh) | 200,body 15060B == `dist/zh/learn/index.html` 字节全等 | PASS |
| `GET /api/health` | **200**,`content-type: application/json`,body `{"ok":true,"service":"nexgrid-site-worker","environment":"dev"}` — API 不被静态吞 | PASS |
| `GET /api/no-such-x` | **404**,`content-type: application/json`,body `{"error":"not-found"}`,**非 HTML** | PASS |
| `GET /definitely-missing-t3-xyz` | **404**;附加证据:响应体 == `dist/404.html` 字节全等(满足 plan T3「回站点 404 页」) | PASS |
| 附加:`GET /_astro/Base.025xgyUh.css`、`GET /robots.txt` | 均与 dist 对应文件字节全等 | PASS(加固项,非 AC 要求) |

机制核对(源码回源):`src/index.ts` 中 `app.all('/api/*') → JSON 404` 排在 `app.all('*') → ASSETS.fetch` 之前;`wrangler.jsonc` `run_worker_first: true` + `not_found_handling: "404-page"` — 行为与实测一致。

## AC3 · 路由清单构造性(从 dist 枚举,非手写) — PASS

- `test-static.mjs` 第 21-34 行:`collectRoutes(DIST)` 递归 `readdirSync` 收集全部 `index.html` → 路由,**无手写数组**;`/api/health` 与 404 探针是单点端点,不属路由清单。
- 防御性守卫在位:dist 缺失 → exit 3(「先造环境」);枚举 <10 条 → exit 3(产物可疑自杀),不会静默降覆盖。
- 独立交叉验证:tester 自行 `find dist -name index.html` 枚举得 **36 条**,与脚本报告的 36/36 精确吻合(12 页 × en/vi/zh;`dist/mission/` 只含 webp 资源、无 index.html,不入清单为正确行为)。

## 观察项(不构成 AC fail,全部上报)

- **P2-1**:`test-static.mjs` 用 `spawn(..., { shell: true })` 传参触发 Node DEP0190 弃用警告(输出首两行)。测试脚本自身的工程卫生问题,不影响判定;将来 Node 升级可能转硬错。
- **P2-2**:脚本字节扫描面 = 全部 `index.html` 路由;非 HTML 资产(css/js/图片/robots)不在其扫描面。plan T3 AC 只要求「≥10 路由抽样」故不扣;本 tester 抽验 2 个资产文件均字节全等作补充证据。若后续 T15 屏蔽中间件改写响应,建议扫描面加资产抽样。

## 执行偏离(D1)

- 派单指令「8787 端口被占先清」:验收开始时 8787/8788 基线皆空;AC2 开跑前 8787 被**同 worktree 并行 T2 验收的 workerd(PID 9120)**占用——是活跃的兄弟验收进程,非孤儿。按「收尾禁杀被测依赖服务」纪律未清,改用 8790 起我方实例。AC 实质不受影响(同一 worker 代码与配置,端口仅 CLI 参数)。
- 收尾实测:我方全进程树(12 进程)已杀净;**8788=0 监听、8790=0 监听**;8787 仍为 PID 9120(t2 方,非本 tester 所起,未动)。

## 证据落点

- AC1 日志 / AC2 探针脚本与输出:会话 scratchpad(`t3-ac1.log` / `t3-ac2-verify.mjs` / `t3-dev8790.log`),临时产物不入仓。
