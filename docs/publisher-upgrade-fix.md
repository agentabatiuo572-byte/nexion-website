# 发布升级检查与无内容改动重建

## 行为

发布页提供独立的“重新检查”入口。该入口不依赖旧的可发布判断；主“检查并发布”按钮则重新取得前置检查和任务状态后，才打开确认面。确认携带本次检查的草稿 revision。请求失败会保留旧记录，但在检查恢复前禁止提交。迟到的检查或轮询不能覆盖更新的检查结果。

草稿与线上一致时，普通发布仍然返回“无改动”，不会通过删除校验绕过限制。页面另提供“重新构建 vN（使用当前代码）”。它固定确认时的线上版本，复用现有 `fromVersion` 发布通道，要求发布理由，照常执行配置校验、物化、构建检查、组装、切换及上线核验。`rebuild` 仅是界面字段，不发送给服务端，不增加任何跳过检查的参数。后台审计沿用现有快照发布事件，理由明确记录为重建。

重建使用执行器当次加载的代码，不等于从 GitHub 自动拉取代码，也不会替换正在运行的发布器进程。已有执行器的源码指纹重载逻辑保留。草稿有未发布的改动时，界面要求先走普通发布，不静默忽略这些改动。若确认后又出现新的线上版本，确认仍指向原来核对的版本，不悄悄换源。

## 数据库升级

新增机器身份探针：`GET /api/publish/runner-state?readiness=1`。它在授权成功后、发布路由初始化之前执行，只读取表结构、索引和任务状态，不执行迁移、初始化、恢复任务或删除锁。

协议 1 核对 `0021_publish_checks.sql` 所需检查表列和唯一序号索引。缺失时，新的发布、领取和检查记录写入会被明确拒绝；前置检查和状态请求给出可读的 503 升级提示，而不是让缺表异常成为不明原因的失败。旧任务的心跳、步骤回报、取消和失败收尾不被此结构门禁阻断。结构检查不把数据库 I/O 异常当作“可以重启”。

Windows 启动器复用 API 前读取此探针。只有“结构缺失、全局没有 validating/publishing/unknown 任务、没有未过期锁”才允许继续；立即再次读取后，沿用原有进程身份核验停止本仓 API。`worker` 的现有 `npm run dev` 会在起服前应用本地迁移。起服后再次验证结构，仍不完整就明确停止本轮升级，不循环杀进程。

初次接入本修复时，若运行中的旧 API 不支持协议、认证失败、未能读取状态或无法证明进程归属，启动器不会强行停止它。维护人员需先确认原任务已结束或完成恢复，再受控重启本仓服务。不能删除 `.wrangler`、发布锁、版本记录或密钥文件作为升级手段。存在待核实任务时，先恢复原执行器收尾；不得以新发布覆盖不确定结果。

生产环境不通过本地启动器迁移。生产仍需先按既有发布文档应用全部迁移，再上线匹配的 Worker 与后台静态资产。本修复没有加入自动部署、生产迁移或远程命令接口。

## 回归命令

在完整仓库、依赖已安装的 Node.js 24 环境执行：

```sh
npm --prefix worker run test:publisher
npm --prefix worker run typecheck
npm --prefix worker test
npm --prefix admin run typecheck
npm --prefix admin test
npm --prefix admin run build
```

Windows PowerShell 5.1：

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\test-start-website.ps1
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File .\scripts\test-publish-upgrade.ps1
```

`test-start-website.ps1` 已接入独立升级回归，后者可以单跑，所有进程/API 操作均被替换为测试实现，不启动真实官网或修改真实数据库。

新增 Node 回归使用真实内存 SQLite 测试结构检查和全局任务判断；发布动作、请求体和请求世代使用实际辅助函数测试。这些测试不代替 React 浏览器交互、D1/Worker 集成或 Windows 实机验收。正式上线前仍需在隔离环境验证从旧安装升级、检查失败保留快照、纯代码重建成功和发布记录一致性。
