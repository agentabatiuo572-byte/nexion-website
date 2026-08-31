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

- `npm run typecheck` —— tsc 0 错。
- 本地数据全在 `worker/.wrangler/`(缓存目录,删除即重置本地 D1/KV,安全)。
- `wrangler.jsonc` 里 D1/KV 的 id 是本地占位;上线切换(Phase C)才换真值。
