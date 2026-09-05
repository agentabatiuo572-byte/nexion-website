# 官网自动发布

运营在后台保存草稿、检查改动并点击发布后，服务端自动调度执行器。界面显示发布步骤、失败原因和版本记录；刷新或关闭后台不会取消任务。日常操作不需要 PowerShell、cookie 或手动启动 CI。

本机由启动器托管独立执行器，使用单独服务凭证。生产使用 `.github/workflows/publish-website.yml`，只接收整数 `versionId`，从受保护的 `main` 触发并检出当次不可变 commit。每个任务在隔离目录物化配置，执行全部质量门和 `verify:prod`，构建后部署，服务端回读本次上线印记后才确认 live。站点固定为 `nexgrid-site-worker`，生产任务串行执行；服务端持久保存调度记录并处理重试与超时。

## 一次性生产配置

由维护人员完成账号、资源和密钥接入；运营日常无需介入。

1. 在 `jasonukkd/nexgrid-website` 创建 GitHub `production` environment，仅允许受保护的 `main` 发布。该环境不要设置每次运行必须人工批准，否则后台点击后会停在等待审批。保护 workflow、执行器、门脚本和依赖锁文件的修改权限。
2. 创建真实 Cloudflare D1、KV，并对 D1 应用仓内迁移。将现有 Worker、域名和初始已验证站点部署到固定的 `nexgrid-site-worker`；初次接入由维护人员完成，不能用尚未上线的后台自行引导首次部署。
3. 在 GitHub `production` environment 设置下表变量与 Secrets；在 Worker 中设置发布模式和两枚服务 Secrets。生成器拒绝空值、占位资源和非公网 HTTPS API 地址，开发用变量不会被带入生产文件。

| 位置 | 名称 | 内容 |
|---|---|---|
| GitHub environment variable | `CLOUDFLARE_ACCOUNT_ID` | 目标 Cloudflare 账号的真实 ID |
| GitHub environment variable | `PUBLISH_D1_DATABASE_ID` | `DB` 绑定对应的真实 D1 ID；名称沿用 `nexgrid_site` |
| GitHub environment variable | `PUBLISH_KV_NAMESPACE_ID` | `KV` 绑定对应的真实 namespace ID |
| GitHub environment variable | `PUBLISH_API_URL` | 固定 Worker 的公网 HTTPS origin，不含路径、参数或凭证 |
| GitHub environment secret | `PUBLISH_RUNNER_TOKEN` | 独立随机服务密钥，与 Worker 中同名 Secret 一致 |
| GitHub environment secret | `CLOUDFLARE_API_TOKEN` | 仅授目标账号发布所需权限的部署令牌；不使用全局 API key |
| Worker secret | `PUBLISH_GITHUB_TOKEN` | 仅目标仓库的 Actions 写权限，用于自动触发 workflow；不交给 runner |
| Worker secret | `PUBLISH_RUNNER_TOKEN` | 仅允许执行器领取、心跳、状态和步骤回报，不是管理员登录凭证 |
| Worker secrets | `SETUP_TOKEN`、`BEACON_SALT`、`BYPASS_SECRET` | 生产独立密钥，禁止沿用开发值 |

生成配置固定写入 `ENVIRONMENT=production`、`PUBLISH_EXECUTION_MODE=github`、`PUBLISH_GITHUB_REPOSITORY=jasonukkd/nexgrid-website`、`PUBLISH_GITHUB_WORKFLOW=publish-website.yml`、`PUBLISH_GITHUB_REF=main`。Wrangler 生产配置位于 CI 临时目录，保留仓内绑定与 cron，资产目录必须是本次已验收的 `dist-live`。隔离执行器使用同一个生成器重新定位源码、资产和迁移路径。密钥只经 Secrets/进程环境传递，不写入配置、公开资产、workflow 输入或日志。

## 故障与验收

升级已有安装时，应先应用全部 D1 迁移（本次包含 `0008` 和 `0009`），再部署新版 Worker。旧草稿按旧默认、当前默认和已有修改三方合并，原草稿与修订号会在同一事务备份，已有标题等修改保留；历史版本的原始内容不会被重写。被移除的字段若已有定制修改，会明确报兼容冲突并保留原内容，交维护人员处理。重复访问不会再次升级或覆盖后续编辑。回滚旧版只转换本次待发布副本，仍须通过完整发布检查。

生产调度未配置时应在发布前明确拒绝。调度或 CI 初始化失败不能伪造步骤成功；后台通过调度重试、任务租约和超时记录给出失败原因。门红时保留草稿与上一版；若部署已发生但确认中断，必须核对实际印记再收口，不能直接声称线上未变。回滚仍从后台选择历史版本并走完整发布链。

正式开放前，维护人员须实际验证：后台点击一次自动上线、刷新后版本一致；重复触发只执行一次；门红不换线上；执行器重启和回报丢失有明确结果；本次部署内容与版本印记一致。当前仓库的 Cloudflare 资源仍是占位，代码与本地测试不代表已经部署或通过真实生产验收。

接口依据：[GitHub workflow dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)、[Cloudflare 版本与部署](https://developers.cloudflare.com/workers/versions-and-deployments/)。
