# 官网下载地址来自生产 A3

2026-10-24：官网 iOS、Android 下载目标以 PC 管理端 A3 的官方平台链接为准。

- 首页、收尾 CTA 的原生下载按钮先进入分发弹窗或 `/download/` 分发页；识别设备后，分别使用 `/api/app-download/ios`、`/api/app-download/android` 获取目标。桌面二维码指向带平台参数的本站分发页。
- 每次 GET/HEAD 都读取生产 A3 的 `data.share.appDownload.iosUrl/androidUrl`。默认从 `https://api.uvel.ai/api/config/platform?officialLinkFragments=true` 读取。AWS 官网启用本机 Java 接口时，Android 下载使用该接口及访客的可信地区，iOS 继续使用公共接口。两种读取方式均要求 `code=0`、`source=official` 和无用户名密码的 HTTPS 地址，通过后返回 302 和 `Cache-Control: no-store`。
- A3 变更后，下次点击直接使用新值，无须重新构建官网。地址可以是 APK/IPA 文件，也可以是已在 A3 配置的 HTTPS 安装落地页。
- Web App（包括导航入口）经过分发入口后，目标统一为 `https://app.uvel.ai/h5/`，对应正式 `h5-lite-main`。
- 首页首屏 Web App 按钮在桌面布局下悬停显示二维码，二维码直接编码正式 H5 地址。点击按钮仍直接打开 Web App，移动端维持点击访问。页尾 Web App 入口维持原交互。
- 原官网后台的 `downloads` 配置和构建环境变量 `PUBLIC_IOS_URL/PUBLIC_ANDROID_URL/PUBLIC_H5_URL` 不再决定这些下载按钮的目标；历史配置字段暂时保留供既有后台兼容。
- 配置缺失、非官方来源、无效 URL、上游错误或 5 秒超时返回 503 `download-unavailable`，不跳旧安装包。POST 等写方法返回 405，未知平台返回 404；访客凭据、请求体和查询参数不转给上游。

## 部署

需要同时发布静态官网与包含新路由的 Worker/AWS API 镜像。纯 Astro 静态预览不包含该 API；线上现有 Nginx `location /` 已把同源请求交给 API 服务。

AWS 安卓下载分别向 Java 提供官网网关按访客 IP 查询的地区及 Cloudflare 的地区，由 Java 选择既有策略所用的来源。缺少可信信息、访客地区受限或本机读取失败时返回 503。A3 下架后仍由公开配置关闭下载。部署配置见[官网自动发布说明](automatic-publishing.md)。

2026-10-24 在 TEST 服务器应用的 `distribution-a3.*.js` 与 `/api/app-download-config` 是旧的临时修补。2026-10-25 合并下载分发及 UVT 改名后，二维码、弹层与分发页已直接使用源码中的 A3 同源入口，无需该临时脚本。此合并不自动改变线上部署或 A3 配置。

## 验证

- `npm --prefix worker test -- app-download.spec.ts`：真实 Worker 路由，覆盖动态更新、平台区分、HEAD、凭据隔离、非法地址、上游失败与恢复、写方法和未知平台。
- `npm run verify`：现有完整门禁；官网行为门同时验证首页/收尾/导航不再使用旧配置或构建环境中的下载地址。
- 实际操作当前构建产物的 iOS、Android、Web App 按钮，检查同源入口及最终跳转。
