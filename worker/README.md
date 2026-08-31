# nexgrid-site-worker

官网后台的服务端(静态伺服 + 区域屏蔽 + 采集 + 配置 API)。规格:`PLAN/PRD/NexGrid_官网后台PRD_v1.0.md`。

## 三条命令(全新 checkout)

```bash
npm --prefix .. run build          # 造出站产物 dist/
npm --prefix .. run build:console  # 把控制台组装进 dist/admin
cd worker
npm install
node promote.mjs  # 把 dist 提升为线上快照 dist-live —— worker 伺服的是它,不先跑这步起服会 404
npm test          # 单测:内置本地 D1/KV,自动应用 migrations/
npm run dev       # 本地起服 http://127.0.0.1:8787(先自动应用 D1 迁移)——GET /api/health 应答 {ok:true}
```

🔴 **worker 伺服 `dist-live`(线上快照),不是 `dist`(待验产物)**。质检门内部会 `npm run build` 重写 dist;
若线上直接伺服 dist,门还在跑、未过门的内容就已经对外了(2026-09-01 验收 P0-3)。两者只由发布流水线的
swap 步搬运一次。`node promote.mjs --check` 比对两者是否一致——**门没通过时「不一致」才是正确状态**。

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
- 🔴 **执行器被掐断后不会自动接管**(2026-09-01 更正:此处原写「重启会自动接管」,已被两条修法一起变成假话——
  任务一旦被领走就不再派发,且已开工的发布不能随手取消)。处理方式:在发布页点「强制中止」——
  执行器**超过 12 分钟没有动静**才允许,且必须写明理由,会记进审计。
  🔴 **中止只在系统里放开这次发布,不会去停掉那个执行器进程**(worker 没有那个能力)。
  所以顺序是:**先确认执行器真的没在跑**(或手工关掉它)→ 再中止 → 再重新发起。
  否则会同时存在两个执行器,而 V1 的设计前提是单执行器。
  不想中止的话也可以直接等锁到期(15 分钟)自动标失败。
- 门红时执行器**不会**回报最后一步,版本标失败、线上保持旧版(线上伺服的是上一份快照,失败的构建产物根本没被搬过去)、草稿改动原样保留。
- **步骤顺序由服务端强制**:必须 `materialize → gates → build → swap` 逐步、每步先报 `running` 再报结果,跳步 / 补报 / 过期锁一律 409。手工用 curl 补一句 `swap ok` 让版本上线是**不成立**的(这条正是 2026-09-01 验收的 P0-1/P0-2)。
- **swap 步 = `node promote.mjs`**:优先换名(强原子),换不动时退回就地同步。Windows 上服务运行时目录被
  wrangler 占着,换名必 EBUSY,所以退路是必需的、不是可选优化。它还会拒绝「dist 里没有控制台却要提升」
  (刚跑完门时 dist 被 astro build 清空过),防手工操作把线上后台抹掉。
- 🔴 **上线要过「核验」这一关,不是执行器说了算**:发起发布时服务端生成一枚一次性口令,只经 `/next` 交给执行器;
  执行器把它随 `promote.mjs --version <id> --stamp <口令>` 写进线上快照的 `.publish-stamp.json`;
  服务端在标 live 之前**回读自己伺服的那份快照**核对版本号与口令,对不上就拒绝上线并把该版标失败。
  为什么:光靠校验上报顺序挡不住「照着合法顺序把四步各报一遍」——那条路径不畸形,却能让版本上线而一道门没跑。
  上线现在依赖一件纯 HTTP 调用者做不到的事(往文件系统落一个文件),「不存在绕门发布 API」才从口号变成机器事实。
  手工跑 `node promote.mjs` 不带 `--version/--stamp` 时**不写印记**,因此不会让任何版本被判成已上线。
- 本地验定时任务:`curl "http://127.0.0.1:8787/__scheduled?cron=0+*/6+*+*+*"`(wrangler dev 的定时触发端点;日汇总那条把 cron 参数换成 `10+0+*+*+*`)。

## 其它

- `npm run typecheck` —— tsc 0 错;`npm run gate:beacon` / `npm run gate:equivalence` / `node test-static.mjs` 见各文件头注。
- 本地数据全在 `worker/.wrangler/`(缓存目录,删除即重置本地 D1/KV,安全;**dev 进程存活时它被锁着,move/delete 会静默失败——先停净服务**)。
- 🔴 **起服一律走 `npm run dev`**(自动前置 D1 迁移);直接 `npx wrangler dev` 会跳过迁移,新迁移一落库就 500(2026-08-31 实踩:draft_rev 列缺失)。
- 🔴 **停服要杀「监督进程树」不是杀端口叶子**:workerd 被杀会由 wrangler 的 node 父进程复活(实踩两次)。配方:
  `powershell "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ? { $_.CommandLine -match 'wrangler' } | % { taskkill /PID $_.ProcessId /T /F }"`,然后**回读端口为 0** 才算停净。
- 控制台(admin/)构建到 `admin/dist`,起服/部署前 `node assemble-admin.mjs` 拷入站 `dist/admin`——站 13 门必须跑在纯官网 dist 上,组装永远在门之后(门域分离)。
- `wrangler.jsonc` 里 D1/KV 的 id 是本地占位;上线切换(Phase C)才换真值。
