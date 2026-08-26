## P0
无(34 路由 × 1440/390:console error / pageerror / 请求失败 = 0;导航、菜单、锚点主路径全通)。

## P1
1. **reduced-motion 下导航文字每次过白带边界隐形 ≈190ms** — `tokens.css:493-500` 只清 `transition-duration`,`SiteNav.astro:97/118` 的 `transition-delay` .196s/.054s 仍生效:底板瞬切、文字延迟切。实测 1440+reduce:出白带 11 帧黑字压黑板 1.0:1(t=11–177ms),进白带 3 帧 1.24:1。修:reduce 块加 `transition-delay:0s !important`。
2. **iPad 竖屏开菜单→横屏:整页锁死** — `SiteNav.astro:426-433` `setOpen` 无 resize 收口。768×1024 开菜单后转 1024×768 实测:`.menu.open` 残留、`.x-frame[inert]`、`html{overflow:hidden}`、Lenis stop,汉堡 `display:none` → 不可滚不可点,仅 Esc / 点导航链可解。修:`matchMedia('(max-width:860px)')` change 且 `!matches && isOpen()` → `setOpen(false)`。
3. **打印首页:35 个打字机元素全空白** — `tokens.css:538-542` 只归位 `:not(.tw):not(.tw-done)`;fx `initType` 在 boot 就把全部元素置 `.tw`(ghost hidden、live 空,IO 到达才打字)。实测 load 后 0.4s / 4.5s 切 print:35/35 `.tw`、live 长 0 → kicker / 编号 / serial 全空(三语首页同;内页无 data-tw)。修:print 内 `.tw>.tw-ghost{visibility:visible!important}` + `.tw>.tw-live{display:none}`。

## P2
4. 翻色瞬切点算错:`SiteNav.astro:94-97` 按线性光算 .216/.784;Chrome 对 rgb() 过渡按 gamma sRGB 插值,交叉实为 .457/.543(114/136ms)。实测进白带 t=106–124ms 黑字压 rgb(73,73,74)@.95 → 2.07:1(2 帧),出白带 t=224–238ms 2.5:1;「全程 ≥4.6:1」不成立。修:延迟改 .114s/.136s。
5. 白带上开/关手机菜单闪烁:`.site-nav.menu-open` 颜色变化同吃 `transition-delay`。390 实测:开后 ~75ms 汉堡黑压黑菜单不可见;关后 ~50ms 白字压亮板 1.2:1。修:`.menu-open{transition:none}`。
6. 焦点陷阱单向漏:汉堡上 Shift+Tab 逃到 body / 浏览器 chrome(`SiteNav.astro:445-455` 只管菜单内首尾)。修:汉堡 keydown Shift+Tab → 聚焦末项。
7. 1440–1454 宽焦点环减半:`--x-vw` 扣滚动条 15px → zoom .9896,Chrome 把 zoom 后 outline/border 向下取整到整设备像素;实测 1440 处 `outline 2px` → 1 设备像素(1439/1455 均 2px);`.xbtn` 1px 边在 1600/1920 亦不随画布放大(.909/.756 CSS px)。[INFERRED] zoom 机制固有。
8. vi 法务页 `<main lang=en>` 岛未吃 en 尺:`tokens.css:98` 以 `:lang(vi)` 定义 `--x-font-display`,变量从 body 继承进岛。实测 `/vi/legal/terms/` h1/h2 = Be Vietnam Pro(en 路由 Funnel),与 96-97 行「各吃各的尺」注释相悖。属意 BVP 一致则改注释,否则补 `:lang(en){--x-font-display:…}`。
9. 标题体例(33 路由逐查,无品牌重复 / 缺失):① `/`、`/nex/` 三语标题为整句带句号;② zh nex 用「——」无空格,其余 32 路由「 — 」;③ learn 索引 en/vi「Learn NexGrid」「Học NexGrid」无后缀、zh「学习中心 — NexGrid」,同页三语品牌位置不一。`Base.astro:37` 规则本身正确。

## 观察
- 三态特异度(产物 CSS):`.site-nav[cid]`(0,2,0)=.64 < `.on-light`(0,3,0)=.72 < `html.x-inner .site-nav[cid]`(0,3,1)=.9;`.flipping::before` 直写 .95 压过变量;x-inner 与 on-light 不共存。`.menu-open` 与 `.on-light` 同特异度靠源序赢——正确但脆。
- 手机菜单其余全绿:inert / overflow / Lenis 锁、横屏 844×390 菜单内可滚(页不动)、Esc 回焦汉堡、点链接关菜单 + 目标获焦(净空 10px)、灯箱与菜单互斥(dialog top-layer)。
- x-boot 正则:`/vi`、`/vi/`、`/?utm` 命中;`/#how`、reload、back_forward 不命中(符合);`/index.html` 不命中(托管多 301);`getEntriesByType` 缺失 → boot 且 0 报错。
- `--x-vw`:1440→1425(headless 经典滚动条)、2560→2545,bleed −234px、白带全出血、无横向溢出。iOS 缩放 / 旋转 / 打印未实测(本机仅 Chromium);打印时 `--x-vw` 仍为屏宽,`.x-canvas{zoom:1}` 覆盖、`--x-bleed` 残留由 `.x-frame` clip 吃掉。
- 无 JS:390 导航随流(h=186)、9 链全显、汉堡隐、tw/lr/rv 0 隐藏;锚点净空 390/1440 = 84/9px;白带上白字压 .64 暗板 ≈6.4:1。
- [GUESS] `--x-zoom: calc(px/px)` 无单位除法与 `zoom` 的 Safari/Firefox 支持未验(失败态 = 画布定宽 1440 不缩放);`inert` <Safari 15.5 无效只剩 Tab 陷阱兜底;iOS <16 `overflow:hidden` 不锁触摸滚动,靠 `overscroll-behavior` 兜。
- print 下 `--x-white→#000` 令 `DevicesSection .media{background}` 变黑(图片盖住);`theme-color` 硬编码 `#0c0c0d` 是 `--x-bg` 第二字面量;内页 `.x-invert`=0 仍每帧量 nav rect(开销可忽略)。
