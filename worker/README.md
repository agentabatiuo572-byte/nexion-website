# nexgrid-site-worker

官网后台的服务端(静态伺服 + 区域屏蔽 + 采集 + 配置 API)。规格:`PLAN/PRD/NexGrid_官网后台PRD_v1.0.md`。

## 三条命令(全新 checkout)

```bash
cd worker
npm install
npm test          # 单测:内置本地 D1/KV,自动应用 migrations/
npm run dev       # 本地起服 http://127.0.0.1:8787(先自动应用 D1 迁移)——GET /api/health 应答 {ok:true}
```

## 红测(预期失败,别修它)

```bash
npm run test:red-d1   # 故意去掉 D1 binding 跑同一套测试:必须非零退出,证明测试真依赖 D1
```

## 发布流水线(CON13)

控制台点「发布」只是**发起**;真正执行(物化 → 站上 13 门 → 构建 → 切换)由执行器完成。本机开发要另开一个终端:

```bash
cd worker
npm run publish:runner -- --api http://127.0.0.1:8787 --cookie "nx_sid=<你的会话 cookie>"
```

- 不带 `--once` 时常驻轮询;带 `--once` 处理完一单退出。
- 🔴 **必须走 npm 脚本**(它带 TS 解析钩子);直接 `node runner.mjs` 会在物化步就崩。
- 🔴 **一次完整发布约 15 分钟**(13 门里三道要真渲染)。别用会超时的方式跑它——工具类超时会掐断执行器,让版本卡在「发布中」直到 15 分钟锁超时才自动标失败。脱离式启动:`(npm run publish:runner -- … &)`。
- 执行器被掐断后重启会**自动接管仍持锁的那一版**并从头重跑,不用手工清理。
- 门红时执行器**不会**回报最后一步,版本标失败、线上保持旧版、草稿改动原样保留。
- 本地验定时任务:`curl "http://127.0.0.1:8787/__scheduled?cron=0+*/6+*+*+*"`(wrangler dev 的定时触发端点;日汇总那条把 cron 参数换成 `10+0+*+*+*`)。

## 其它

- `npm run typecheck` —— tsc 0 错;`npm run gate:beacon` / `npm run gate:equivalence` / `node test-static.mjs` 见各文件头注。
- 本地数据全在 `worker/.wrangler/`(缓存目录,删除即重置本地 D1/KV,安全;**dev 进程存活时它被锁着,move/delete 会静默失败——先停净服务**)。
- 🔴 **起服一律走 `npm run dev`**(自动前置 D1 迁移);直接 `npx wrangler dev` 会跳过迁移,新迁移一落库就 500(2026-08-31 实踩:draft_rev 列缺失)。
- 🔴 **停服要杀「监督进程树」不是杀端口叶子**:workerd 被杀会由 wrangler 的 node 父进程复活(实踩两次)。配方:
  `powershell "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ? { $_.CommandLine -match 'wrangler' } | % { taskkill /PID $_.ProcessId /T /F }"`,然后**回读端口为 0** 才算停净。
- 控制台(admin/)构建到 `admin/dist`,起服/部署前 `node assemble-admin.mjs` 拷入站 `dist/admin`——站 13 门必须跑在纯官网 dist 上,组装永远在门之后(门域分离)。
- `wrangler.jsonc` 里 D1/KV 的 id 是本地占位;上线切换(Phase C)才换真值。
