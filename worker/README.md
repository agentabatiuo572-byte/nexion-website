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

## 其它

- `npm run typecheck` —— tsc 0 错;`npm run gate:beacon` / `npm run gate:equivalence` / `node test-static.mjs` 见各文件头注。
- 本地数据全在 `worker/.wrangler/`(缓存目录,删除即重置本地 D1/KV,安全;**dev 进程存活时它被锁着,move/delete 会静默失败——先停净服务**)。
- 🔴 **起服一律走 `npm run dev`**(自动前置 D1 迁移);直接 `npx wrangler dev` 会跳过迁移,新迁移一落库就 500(2026-08-31 实踩:draft_rev 列缺失)。
- 🔴 **停服要杀「监督进程树」不是杀端口叶子**:workerd 被杀会由 wrangler 的 node 父进程复活(实踩两次)。配方:
  `powershell "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ? { $_.CommandLine -match 'wrangler' } | % { taskkill /PID $_.ProcessId /T /F }"`,然后**回读端口为 0** 才算停净。
- 控制台(admin/)构建到 `admin/dist`,起服/部署前 `node assemble-admin.mjs` 拷入站 `dist/admin`——站 13 门必须跑在纯官网 dist 上,组装永远在门之后(门域分离)。
- `wrangler.jsonc` 里 D1/KV 的 id 是本地占位;上线切换(Phase C)才换真值。
