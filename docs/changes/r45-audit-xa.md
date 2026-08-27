## P0

无。33 路由 + 404 全绿:无 console error / pageerror / 失败请求 / 4xx-5xx(404 页自身 404 状态除外),无死链,无白屏,无锁死。

## P1

**XA-1 同页锚点每次点击都 pushState,重复点击堆历史(back 陷阱)**
路由 `/`(vi/zh 同) · 全视口 · 连点导航「Devices」4 次 → `history.length` 2→6,须按 4 次后退才离开本页。
对照组:原生 `location.hash='#devices'` 连设 3 次同值,增量 **0**。`fx.ts` 锚点处理器无条件 `history.pushState`。
期望:hash 未变化时不 push(与原生片段导航同口径)。

**XA-2 下载三键禁用态无原因、无下一步**
路由 `/` `/vi/` `/zh/` hero(`#download`)+ 收尾 CTA · 全视口 · 冷载即见。
`PUBLIC_IOS/ANDROID/H5_URL` 三空 → 渲染为 `aria-disabled` span,**文案与可用态逐字相同**(「Download for iOS →」),无 title / 旁注 /「coming soon」字样。全站唯一转化路径静默失效。
期望:禁用态给出原因与下一步。注:env 驱动,生产配了 URL 则不复现——但当前产物如此。

## P2

**XA-3** `/#download` @844×390 · 落点 y=0,三键在 401–445,视口高 390 → 全部在折叠线下(其余 5 档视口均在首屏内)。期望:落点保证三键可见。

**XA-4** `/` 菜单 @844×390 · 开菜单 → 语言键 bot 448、Download bot 514 均超 390 折叠线;菜单 `sh546/ch390` 可滚(`overflow-y:auto`+`touch-action:auto`+`data-lenis-prevent`,配置正确)但**无任何可滚提示**。期望:加滚动提示或压缩横屏排布。

**XA-5** `/` @1440 · 点 `#trust` 后 200ms 用滚轮打断 → 停在 y=6150,但 URL 仍是 `#trust`(实际距该区 4219px)。pushState 发生在补间开始前。期望:到达后再写 hash,或打断即撤销。

**XA-6** `/` 灯箱 @390×844 · tap 证书 → 图片 `width:1160px; max-width:none`(`@media(max-width:860px)` 覆盖了基础的 `width:100%`),仅见 34% 宽,需双轴平移,无适屏档。关闭键 sticky 双轴常驻、平移后真实 tap 仍可关(已验,无锁死)。可能是刻意的 zoom-to-read,列此备主人裁决。

**XA-7** `/` @1440 慢网 1.5Mbps/300ms · 开灯箱 → 720×961 空盒持续 4.4s 仍 `complete:false`(cert@2x 420–508KB),无加载态/占位。盒子有尺寸故无跳版。期望:补 loading 态。

**XA-8** `/` @1440 慢网 · console warning:`funnel-display-latin-500-normal.woff2 preloaded but not used within a few seconds`。常速六路由(含 vi/zh)复测 0 警告,故仅慢网可见。

**XA-9** `/no-such-page/` 全语 · `<html lang>` 与 `<title>` 恒 EN,正文却三语并列(源码注释载明是刻意的);导航与页脚链接全部指向 EN 路由,vi/zh 访客点「Learn」落到 `/learn/`。正文三语首页键提供了退路。期望:`lang`/`title` 中性化。

**XA-10** `/` @1440 · 白带边界(y≈8176)±20px 来回微滚 12 次,导航 `on-light` **12/12 次次翻转**,而色过渡 250ms → 该位置颜色永不落定。翻转点几何上正确,缺的是迟滞。期望:加 hysteresis 带。

**XA-11** `/` 打印预览 · docH 13033px ≈14 页,含 hero/叠卡等纯装饰区。导航与粒子 canvas 已正确 `display:none`、白底黑字可读。期望:打印时裁掉装饰区。

**XA-12(潜伏,当前真实操作不可达)** 菜单 `setOpen` 与灯箱 `initCertZoom` 共用 `documentElement.style.overflow`,各自 close 时**无条件清空**。真实点击无法叠开(菜单不透明全屏 + `.x-frame` inert + dialog modal 三重互斥,已逐一验证);仅合成事件可叠开,叠开后**单次 Esc 同时关掉两层**。期望:改计数/栈式锁,免后续新增第三个锁主时复活。

## 已走路径

首页冷载 → 滚到底 → 导航锚点(左键/Ctrl/中键)→ 回顶 → 刷新 → 后退/前进 → 三语切换往返
手机 390×844:开菜单 → 转 844×390 → 滚菜单 → 点链接 → 后退 → 再开 → Esc(锁与 Lenis 每步核)
菜单+灯箱叠开(合成)→ 依次关闭 → 复验可滚;真实点击可达性逐视口证伪(390/844/768)
平板 768×1024 开菜单 → 转 1024×768(跨 860 mq 收口)→ 转回 → 再开 → Esc
桌面灯箱:Tab 循环 ×6 → 滚轮 → Esc → 立即重开(scrollTop 归 0)→ 点背景关 → Ctrl+点击(新标签开原件)
灯箱平移到最右+下后真实 tap 关闭键(390/844/768 三档)
文章页:目录锚点 → 后退 → 相关文章 → 回列表(vi 全程保持语言)→ `/#download` 跨页 CTA
分享直达 `/#trust` `/vi/#devices` `/#how` `/zh/#trust` `/#download` × 1440/390 两档,落位与耗时
404 三语路径每条链接逐个取回(15 链接,全 200)
打印预览 × 6 类页;reduced-motion 全程 × 3 页;载入后 120ms / 2s 中途切 reduce(CDP)
resize 风暴 1600→390→2560 + 1439/1441 抖动 ×14(零横向溢出;h1 除以 zoom 后恒 159 画布 px)
慢网 1.5Mbps/300ms 首载 + 中途导航 + 灯箱大图
三语 33 路由 + 404 全量 console/pageerror/requestfailed/4xx-5xx 采集
锚点补间打断(改点他锚 / 滚轮)、连点同锚 ×5、叠卡区内点锚点与 resize、白带边界微滚 ×12
bfcache 深滚位往返(y 13886 精确恢复;离场时 36 个 `[data-rv]` 失显,向上滚全部补显,与基线同为 2)

> 探针脚本 `…/scratchpad/aua2-*.mjs`。两次自证伪已记录:CDP `synthesizeScrollGesture` 与合成 `TouchEvent` 在本机控制组均滚不动页面(探针失效,故未据其断言触摸不可滚);resize 风暴的「标题 2→3 行」是 `getBoundingClientRect`(屏幕单位)与 `fontSize`(画布单位)差一个 zoom 造成的误读,除以 zoom 后三档全等。
