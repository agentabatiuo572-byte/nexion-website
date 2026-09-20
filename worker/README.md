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

## 自动发布(CON13)

后台确认发布后，系统自动执行配置生成、全部检查、构建和切换核验。无需复制浏览器 Cookie 或手动运行执行器。

- 本机：根目录的一键启动器同时托管发布服务，生成独立服务密钥，异常退出后自动重启。入口与日志见 [启动说明](../README-启动.md)。
- 生产：后台自动调用固定 GitHub Actions workflow；按版本领取任务，在隔离目录构建，经 `verify:prod` 和全部后台检查后部署、核验。一次性配置见 [自动发布部署说明](../docs/automatic-publishing.md)。
- 服务密钥只授权领取、心跳、步骤回报与恢复；不能编辑草稿、发起发布或管理账号。浏览器登录态也不能调用执行接口。
- 发布服务未就绪时，后台说明原因并禁止创建空等任务；生产调度结果保存在 D1，网络中断会自动重试。重复调度不重复领取。
- 每单使用隔离源码和产物，构建不修改当前工作树。只有检查通过后才更新 `dist-live` 或生产部署；不能手工补报步骤绕过核验。
- 心跳在构建期间持续续租；失去任务权限则停止子进程，禁止继续切换。服务重启会核对持久记录，已中断的检查明确记失败，草稿保留，可在后台重新发布。
- 切换期间响应丢失时，系统回读发布印记与页面摘要。不能确认的结果显示“切换结果待核实”，暂停后续发布；不会把未知状态说成“旧版未变”。
- 回滚同样创建新版本并走完整发布链。检查失败不会改变已发布内容。

本机发布后的官网地址为 `http://127.0.0.1:8787/`。`4321` 是源码开发预览，不用于判断发布结果。

## AI 翻译(CON17)

入口为 `/admin/ai`。支持 **OpenAI、Anthropic Claude、Google Gemini、DeepSeek、Groq、OpenRouter、OpenCode Zen、NVIDIA NIM**；选择服务商和对应模型，填入该服务商的 API Key，测试并保存。模型选项由服务端 `AI_PROVIDERS` 返回，并受 `AI_ALLOWED_MODELS` 限制。切换服务商会清空尚未提交的 Key，测试失败保留原连接。编辑页在语言与缺译状态旁提供“AI 翻译”：按当前英语生成建议，填入输入框，可继续人工修改，点击本页保存后才写草稿。已有默认译文直接显示在输入框内。

自动补译缺项默认关闭，关闭不影响逐项按钮。开启后，自动任务只补缺译和过期的机器译文，人工内容受保护。批量操作与任务查看属于高级操作。

- API Key 经服务端加密存入 D1，密文绑定服务商，后台只返回连接状态。各服务商仅使用注册表中的固定官方 HTTPS 地址，不接收代理地址。迁移 `0019_ai_providers.sql`、`0020_ai_mainstream_providers.sql`、`0022_ai_nvidia_provider.sql` 扩展服务商约束，保留已有密文、用量、租约和修订。
- 默认每日上限为 50,000 个原文加上下文字符；每次最多 20 项、3,000 字符。网络中断可能已产生费用，消耗未知会保留记录；任务重试不会承诺上游只收费一次。
- 本机一键启动器保留一个 API 监督进程，每分钟执行一次有界任务。`.local-start` 下保存 Windows 账号绑定的 DPAPI 恢复文件；`.dev.vars` 仅供 Worker 加载。首次安装或更新旧监督进程后，需要正常重启 API，后台加密状态就绪后才能录入 Key。
- 生产需应用 D1 迁移，并用 Cloudflare Worker Secret 配置 `AI_CREDENTIAL_ENCRYPTION_KEY`：内容为随机 32 字节的 Base64。使用现有分钟 cron，不设置本机 `AI_TICK_TOKEN`。AI Key 仍从后台录入，不进入 GitHub、构建环境或静态站文件。
- 已存密文但根密钥丢失时，恢复原根密钥；不能直接生成替代密钥。确需重配时先在后台移除旧连接，再测试保存新 Key；移除不会重置修订和当日用量。
- 自动任务的结果先保存，再按最新草稿和人工修改状态写入。关闭自动补译、删除字段、取消任务或更换连接后，过时结果不能覆盖新稿。逐项按钮不创建任务、不自动写草稿；请求期间修改原文或输入框、切换语言后，旧结果不能覆盖当前输入。必填译文缺失或机器译文过期会阻止新发布，已受理版本和历史回滚继续使用各自固定快照。
- Zen 的 `CreditsError` 表示付款或额度尚未就绪，即使返回 HTTP 401 也不提示密钥无效。修复账户付款设置后可重新测试；不回显服务商的私人账单地址。
- Gemini 可使用 Google AI Studio 创建的 API Key；免费模型不代表每个项目都已获 API 权限。以所属项目的实际额度、权限和连接测试结果为准，不自动开通账单或更换项目。

## 其它

- `npm run typecheck` —— tsc 0 错;`npm run gate:beacon` / `npm run gate:equivalence` / `node test-static.mjs` 见各文件头注。
- 本地数据全在 `worker/.wrangler/`(缓存目录,删除即重置本地 D1/KV,安全;**dev 进程存活时它被锁着,move/delete 会静默失败——先停净服务**)。
- 🔴 **起服一律走 `npm run dev`**(自动前置 D1 迁移);直接 `npx wrangler dev` 会跳过迁移,新迁移一落库就 500(2026-08-31 实踩:draft_rev 列缺失)。
- 🔴 **停服要杀「监督进程树」不是杀端口叶子**:workerd 被杀会由 wrangler 的 node 父进程复活(实踩两次)。配方:
  `powershell "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ? { $_.CommandLine -match 'wrangler' } | % { taskkill /PID $_.ProcessId /T /F }"`,然后**回读端口为 0** 才算停净。
- 控制台(admin/)构建到 `admin/dist`,起服/部署前 `node assemble-admin.mjs` 拷入站 `dist/admin`——站 13 门必须跑在纯官网 dist 上,组装永远在门之后(门域分离)。
- `wrangler.jsonc` 里 D1/KV 的 id 是本地占位;上线切换(Phase C)才换真值。
