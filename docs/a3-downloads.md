# 官网下载地址来自生产 A3

2026-10-24：官网 iOS、Android 下载目标以 PC 管理端 A3 的官方平台链接为准。

- 首页、收尾 CTA 的原生下载按钮分别使用 `/api/app-download/ios`、`/api/app-download/android`。
- Worker 在每次 GET/HEAD 请求时，从固定公共接口 `https://api.uvel.ai/api/config/platform?officialLinkFragments=true` 读取 `data.share.appDownload.iosUrl/androidUrl`，仅接受 `code=0`、`source=official` 与无用户名密码的 HTTPS URL，返回 302 和 `Cache-Control: no-store`。
- A3 变更后，下次点击直接使用新值，无须重新构建官网。地址可以是 APK/IPA 文件，也可以是已在 A3 配置的 HTTPS 安装落地页。
- Web App（包括导航入口）统一为 `https://app.uvel.ai/h5/`，对应正式 `h5-lite-main`。
- 原官网后台的 `downloads` 配置和构建环境变量 `PUBLIC_IOS_URL/PUBLIC_ANDROID_URL/PUBLIC_H5_URL` 不再决定这些下载按钮的目标；历史配置字段暂时保留供既有后台兼容。
- 配置缺失、非官方来源、无效 URL、上游错误或 5 秒超时返回 503 `download-unavailable`，不跳旧安装包。POST 等写方法返回 405，未知平台返回 404；访客凭据、请求体和查询参数不转给上游。

## 部署

需要同时发布静态官网与包含新路由的 Worker/AWS API 镜像。纯 Astro 静态预览不包含该 API；线上现有 Nginx `location /` 已把同源请求交给 API 服务。

下午在 TEST 服务器应用的 `distribution-a3.*.js` 与 `/api/app-download-config` 是针对另一条下载分发分支产物的临时修补。当前 main 使用原有下载按钮，本次把同等的 A3 动态取址能力落入源码，不合并该分支的二维码、弹层与视觉变更。临时 Nginx 配置入口可与新路由并存；此提交不自动改变线上部署或 A3 配置。

## 验证

- `npm --prefix worker test -- app-download.spec.ts`：真实 Worker 路由，覆盖动态更新、平台区分、HEAD、凭据隔离、非法地址、上游失败与恢复、写方法和未知平台。
- `npm run verify`：现有完整门禁；官网行为门同时验证首页/收尾/导航不再使用旧配置或构建环境中的下载地址。
- 实际操作当前构建产物的 iOS、Android、Web App 按钮，检查同源入口及最终跳转。
