# 一键启动官网和控制后台

双击本目录的 **启动官网和后台.cmd**。首次启动可能需要安装依赖或构建，等待窗口显示所有服务就绪后即可使用。

| 入口 | 地址 |
|---|---|
| 官网开发页面 | http://localhost:4321/ |
| 官网控制后台 | http://localhost:5175/admin/ |
| 本地 API 与已发布快照 | http://127.0.0.1:8787/ |

启动器会自动应用本地数据库迁移。没有管理员时，生成随机强口令、加密保存，再通过正式初始化 API 设置管理员；已有管理员时，保留原口令并验证登录。启动窗口会显示可复制的口令，并自动打开官网与后台。

口令文件是 `.local-start/admin-password.dpapi`，由 Windows 当前账户加密；不进入 Git，也不写入服务日志。再次双击可重新查看口令。不要删除该文件或 `worker/.wrangler/`：后者保存本地数据库。换电脑或 Windows 账户后，原加密文件不能直接解密。

若管理员已存在但没有口令文件，首次运行需要输入已有口令一次；验证后加密保存，后续无需再输入。启动器不会重置已有管理员。`worker/.dev.vars` 中已有的 `SETUP_TOKEN` 和其他配置会保留；启动器自动添加发布配置不会妨碍首次初始化。若另有 `.env`、环境专用 `.dev.vars.*` 或 `SETUP_TOKEN` 环境变量，应先用对应令牌在 `/admin/setup` 初始化。

若提示保存的口令不匹配，保留原文件并将它改名，再运行启动器输入当前有效口令。若提示无法解密，应优先使用原 Windows 账户；也可保留旧文件改名后重新录入口令。两种情况均不会重置数据库或管理员。

官网、API、控制后台和发布执行器在隐藏进程中运行，关闭启动窗口后继续工作；再次启动会复用本仓服务。执行器退出后会自动重启。端口被其他程序占用时会显示失败，不会停止其他程序或悄悄换端口。已有本仓 API 尚未加载发布配置时，启动器会核对进程及其启动时间后重载。开机后重新双击即可启动，本工具不安装开机自启任务。

后台显示执行器就绪后，直接点击**发布**即可自动构建、检查并更新本地已发布快照，不需要复制 cookie 或再运行 PowerShell。没有待发布任务时，执行器只保持在线；发布失败会显示在后台，原快照继续保留。官网开发页面 `4321` 用于开发预览，检查本地发布结果请访问 `http://127.0.0.1:8787/`。

发布使用独立的随机密钥，与管理员口令和登录会话分开。恢复文件 `.local-start/publish-runner-token.dpapi` 由 Windows 当前账户加密；供本机 API 读取的 `worker/.dev.vars` 会限制为当前账户、管理员与系统可访问，并在确认 Git 忽略后才写入。启动器保留已有配置和密钥，不自动轮换。两个文件的密钥不一致时会停止并保留现场。

后台显示执行器离线时，重新双击启动器；若仍失败，先看后台原因，再查看 `.local-start/runner-*.out.log`、`.local-start/runner-*.err.log`，API 启动问题查看同目录 `api-*.log`。日志不包含发布密钥或管理员口令。

自动化检查可运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start-website.ps1 -NoBrowser -NoPause -HidePassword -NonInteractive
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-start-website.ps1
```

需要 Windows PowerShell 5.1、Git 和 Node.js 24 或更新版本，与生产执行环境一致，并支持发布脚本直接加载 TypeScript。默认沿用现有 `dist-live`；仅在完全不存在时构建首份本地快照。启动后自动处理后台授权的本地发布队列；不执行远端部署。
