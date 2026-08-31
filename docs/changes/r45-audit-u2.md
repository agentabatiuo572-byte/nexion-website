## P0
无

## P1
1. **hash 直达 / 内页导航回首页锚点 = 从页顶「自动滚」1.3–2s。** tokens.css:108 `html{scroll-behavior:smooth}` 让浏览器把首载片段定位做成平滑动画(Lenis 不参与)。复现:/learn/ 点导航「How」(SiteNav.astro:19 `anchor()` 生成 `/#how`)→ 新页 y=0 起 212ms:243 → 1335ms:8296 才停;1920 宽 `/#trust` 要滚 13851px。注入 `scroll-behavior:auto` 后 81ms 即定位(实测)。后果:分享链接 / 内页跳锚先看到 hero 再被拖着掠过整页,途中 reveal / 打字机被批量触发。
2. **手机菜单开着时视口跨过 860(平板旋转 / 拉宽窗口)→ 整页冻结。** SiteNav.astro:426-432 `setOpen` 只在开合时写 `overflow:hidden` + `.x-frame[inert]` + `x:scroll-lock`,无 resize 收口;>860 时 `.menu-toggle` display:none。实测 390 开菜单 → 1200:`lenis-stopped` / overflow hidden / frame inert 全残留,滚轮 dy=0,正文(含证书)全部不可点,汉堡不可见;只能 Esc 或点导航链接(顺带跳转)解锁。

## P2
3. **打印:35 个打字机全部空白。** fx.ts:618-632 `prep` 注册即换成 `.x-sr` + 隐藏 ghost + 空 live;tokens.css:538-539 print 归位只覆盖 `[data-tw]:not(.tw):not(.tw-done)`(注册前态),`.tw` 中间态(tokens.css:371 ghost `visibility:hidden`)未覆盖。实测 emulate print:35/35 `live=''` + ghost hidden;`[data-rv]` / `.lr-inner` 归位正常。
4. **灯箱重开残留上次滚动位。** fx.ts:478 `dlg.scrollTop = 0` 在 `showModal()` 之前执行,关闭态 dialog 无盒,赋值无效。实测桌面:A 证书滚到底(204)关掉再开 B,首帧 scrollTop=204;手机:scrollLeft 500 / scrollTop 600 原样带到第二张。
5. **灯箱首开慢网先弹「小白框」。** TrustSection.astro:42 `<img alt="">` 无 width/height,fx.ts:476 换 src 后 dialog 先以 106×87(只剩关闭键,居中 top 406)打开,图到达才跳成 752×846 / top 27(2x 图 420–508KB;延迟 700ms 实测两态);切第二张首帧仍显示上一张。
6. **Ctrl/Shift+点击证书链接被吞成灯箱。** fx.ts:474-475 无条件 `preventDefault`,与同文件 :446 锚点处理器的修饰键放行不一致;实测 Ctrl+click 无新标签、灯箱打开(中键仍原生)。
7. **点灯箱白框自身的 16px 内衬带即关闭。** fx.ts:488-490 `e.target === dlg` 把 dialog 的 padding 区(TrustSection.astro:150 `padding: 0 16 16`)当背景;实测点左缘内 5px 即关闭。
8. **桌面导航链接上方滚轮退化为原生瞬跳。** SiteNav.astro:50 `#nav-menu` 全宽度带 `data-lenis-prevent`(本意给手机浮层),Lenis 命中 composedPath 即放行;实测指针停在导航链接上滚轮 → `lenis-scrolling` 无 `lenis-smooth`,scrollY 直接 300;内容区同操作平滑到 174。
9. **`showModal` 不存在时证书点不开。** fx.ts:475-479 先 `preventDefault` 再 `dlg.showModal()`,旧 Safari(<15.4)抛 TypeError 后既不开灯箱也不走 `<a href>` 原生打开——:86 注释「无 JS 直接打开图片」在「有 JS 但无 dialog」下失效。代码路径判定,未实测。

## 观察
- `initReveal doneNow`(fx.ts:684-691)实测干净:指针静止、元素滑入 → pointerenter 钉 0.7248 → 下一帧清空 → 0.2s 收到 hover 0.6,逐帧最大 Δ0.112,无内联残留;强制在 `.in` 同帧触发亦无闪烁;reduced / print 由 `opacity:1 !important` 压过内联。
- 打字机几何:6 组视口×语言、35 元素 tw 前后 offsetWidth/Height/父高零差,文本 100% 复原,无首尾空白;`tw-inline` 分支 0 命中(所有宿主计算 display 为 block/grid/flex item),属死路径。
- 叠卡:1440 decked / 860 静态列 / 861 回 decked;resize 往返 height/transform/curtain 全清全建;150% 预取翻 eager 后 2.5s 内 6 图全 complete;reduced / print 静态;scrollWidth=视口无横溢。
- Lenis `stop/start` 为布尔非计数;灯箱与菜单因 modal / inert 互斥不可同开,未见失衡;Esc / 背景点 / 连开关×3 / 双 close 后 `lenis-stopped`、`overflow` 均归零;开着时滚轮 / PageDown / Space 页面 dy=0。
- 锚点:点击落位 = navH+10,hash 直达 = scroll-margin 84uc,1440/1920/2560 差 ≤3px;`tabindex=-1` 永久留在 section(3 处),此后点区内任意文字都让 section 成 activeElement(无 `:focus-within` 规则,无可见后果)。
- 导航「Download」`#download` 即 hero(页顶),点击 = 回首屏。
- Lenis 补间进行中(1.2s)任何原生程序化滚动(scrollIntoView / focus 引起)会被后续帧拉回,Lenis 固有行为。
- console 0 error;唯一 warning 为 funnel-display 500 预载未用(Base.astro,非本单元)。
- 探针:scratchpad `au2-{smoke,type,reveal,pile,mobile,hash,lightbox2}.mjs`,全部打 4399 产物。
