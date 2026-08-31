# R45 · T7 独立黑盒验收 —— 引擎其它 + 打印 + 无 JS + vi 字重

- 日期:2026-08-26 · tester:r45-t7b(独立,只按 AC 实测,未读实现叙述)
- 对象:构建产物 http://localhost:4399/(未起停服务、未 build/dev)
- 工具:Playwright(借 Nexion-uniapp 的 chromium,headless)。脚本与原始 JSON / PDF / PNG 全在
  `C:/Users/jason/AppData/Local/Temp/claude/D--WORKS-PLAN/42e4397e-0bc4-4987-8cc3-a0bc8464e0bd/scratchpad/t7-*.mjs|*-result.json|*.png|*.pdf`
- 判据口径:AC 原文逐字;数字全部来自运行时 `getComputedStyle` / `getImageData` / CDP,不看代码。

## 逐条 AC

| AC | 子项 | 结果 | 证据(原始数字) | 脚本 |
|---|---|---|---|---|
| AC1(a) | reducedMotion:'reduce',1440×900 → 1400×900 → 1440×900,每次 resize 后 `#x-bg` 亮像素 >0 | **pass** | `matchMedia(prefers-reduced-motion)`=true。`#x-bg` 是 CANVAS(2d),canvas 宽 1425→1385→1425(1440 减 15px 经典滚动条)。亮度>60 像素数在 9 个采样点(初始 +1.5s;每次 resize 后 @50/300/1000/2000ms)恒为 **87489**(max-channel>60 为 98346;alpha>0 = 全画布,说明 resize 后整张重绘过)。 | t7-ac1.mjs → t7-ac1-result.json `a` |
| AC1(b) | Ctrl / Shift / Meta 点 `.site-nav a[href="#how"]`:不滚动 + 开出新页 | **pass**(Meta 见备注) | 链接 1 个、可见、box (806.8,30.1,99×43.5)。**Ctrl**:context 页数 1→2,新页 URL `/#how`,scrollY 0→0,`#how` top 8379 不变。**Shift**:同上,1→2,`/#how`,scrollY 0。**Meta**:页数 1→1,scrollY 0→2030(@400ms)→8296(@1600ms),URL 变 `/#how` —— Windows Chromium 里 Meta 不是链接开新页修饰键(仅 macOS Cmd),走的是浏览器原生同页锚点跳转。合成事件探针(t7-ac1b):普通 click `defaultPrevented=true`(站点接管滚动);ctrlKey / shiftKey / **metaKey** / altKey / 中键 全部 `defaultPrevented=false`(交还浏览器)→ macOS Cmd+click 应能开新页。**真 macOS 未能测**(本机 Windows)。 | t7-ac1.mjs `b`;t7-ac1b.mjs |
| AC1(c) | 普通点击锚点、等 1.5s、Tab 后焦点在 `#how` 内或其后、不在导航 | **pass** | 点击后 1.5s:`document.activeElement` = `SECTION#how`(tabindex=-1),scrollY 8295,`#how` top 84。按 Tab:焦点 = `a.vlink`「How earnings are verified →」href=#trust,`compareDocumentPosition`=20(CONTAINED_BY+FOLLOWING),inNav=false,rect top 857(视口内)。再 Tab:`a.xbtn.solid`「Get started free →」href=#download,在 `#how` 之后。 | t7-ac1.mjs `c` |
| AC1(d) | `[data-lr]`/`[data-tw]` 宿主无 aria-label;动画期宿主内有 `.x-sr` 可访问文本 | **pass** | 宿主 50 个(H1/SPAN/H2/P/H3/DIV)。`querySelectorAll('[data-lr][aria-label],[data-tw][aria-label]').length` 在 37 次加载期轮询(t=82…4016ms)+ 22 次滚动轮询 + 终态 **全部为 0**。`.x-sr`:t=82ms 起 50/50 宿主各 1 个,文本非空(如 H1 "NexGrid / Let compute flow"、SPAN[data-tw] "Network scale"),无 aria-hidden,`position:absolute; clip:rect(0,0,0,0); 1×1px`(视觉隐藏但可读);同宿主内动画碎片 2/2 为 `aria-hidden="true"`。动画结束后 `.x-sr` 移除、宿主内 aria-hidden 子元素 0(终态 animatingHosts=0)。 | t7-ac1.mjs `d` |
| AC2 | /vi/:`document.fonts` 有 Be Vietnam Pro 400 loaded;measureText 400 ≠ 500;`#social h2` 字重 400 | **pass** | `document.fonts` 共 16 面,Be Vietnam Pro **400 ×3 面 loaded**、500 ×3 面 loaded(无 600/700 面)。measureText 越南语样串 `400 40px` = **1641.64** vs `500 40px` = **1658.279**(不等;纯拉丁串 1253.24 vs 1270.36,Arial 1124.55 → 确用 BVP)。`#social h2` computed `font-weight: 400`,`font-family: "Be Vietnam Pro", system-ui, sans-serif`,54px。CDP `CSS.getPlatformFontsForNode`:`#social h2` 实际渲染字体 **BeVietnamPro-Regular**(custom,50 glyph),h1 = BeVietnamPro-Medium。 | t7-ac2.mjs;t7-ac2b.mjs |
| AC3 · / | `[data-rv]` 打印态 opacity 1 / transform none | **fail** | `emulateMedia print` 生效(`matchMedia('print')`=true,其它打印规则均已应用)。`[data-rv]` **35/35 仍 opacity "0" 且 transform ≠ none**:27 个 `matrix(1,0,0,1,0,12)`(translateY 12px),8 个 `.rv-fade`(how `.step`×3 / path `.card`×2 / nex `.card`×3)带 JS 写入的**内联** `transform: translate3d(0,-515.2 / -570.9 / -699.4px,0)`。分布:stats `.cell`×5、social `.roles`、mission `.body`+`.cluster`、path `.note`、trust `.certs`+`.card`×5、nex `.more`、learn-entry `a.row`×3+`.more`、faq `details.item`×6、final-cta `.btns`。 | t7-ac3.mjs;t7-ac3b.mjs |
| AC3 · / | `.lr-inner` transform none | pass | 19/19 `none`(屏幕态 19 个非 none → 打印规则确实生效)。 | t7-ac3.mjs |
| AC3 · / | `.site-nav` / `#x-bg` display none | pass | 两者 computed `display: none`。 | t7-ac3.mjs |
| AC3 · / | body 深色字 / 浅色底 | pass | color `rgb(0,0,0)`(亮度 0)/ background `rgb(255,255,255)`(亮度 1);html 同。屏幕态为白字 `rgb(12,12,13)` 底。 | t7-ac3.mjs |
| AC3 · / | `[data-deck]` 高度 auto(非 6400) | pass | `section#devices[data-deck]`:内联 `height:6400px` 被覆盖,打印态 computed **3610.31px** = 子元素高度和 3610,首子 `position: static`(屏幕态 6399.99px / sticky)。 | t7-ac3.mjs |
| AC3 · / | `page.pdf()` 非空 | pass | `t7-ac3_.pdf` **701,008 B**。 | t7-ac3.mjs |
| AC3 · /legal/privacy/ | 全部子项 | pass | `[data-rv]` 0 个(空真);`.lr-inner` 1/1 none;nav / `#x-bg` none;color `rgb(0,0,0)` / bg `rgb(255,255,255)`;无 `[data-deck]`;PDF `t7-ac3_legal_privacy_.pdf` **22,315 B**。 | t7-ac3.mjs |
| AC4 | 无 JS 390×844:How / Devices / Trust / Learn / NEX 可见、rect 在视口内可点(高度>0、不被遮盖) | **fail**(可点但溢出/裁切) | `isMobile` 仿真(无滚动条,clientWidth 390):五链接均找到、`display:flex; visibility:visible; opacity:1`、高 **52.8**、中心 `elementFromPoint` 命中链接自身(不被遮盖)。但五个盒子均为 `[139.8, y, 261.1, 52.8]` → **右缘 400.9 > 390**,`.site-nav` scrollWidth 401 > clientWidth 390;「How it works」字形右缘 400.9,**被裁 10.9px**(截图 `t7-ac4c-nojs-top.png` 可见末字母 s 被切)。其余四个字形在视口内(Devices 296.3 / Trust 244.5 / Learn 255.8 / NEX 227.3)。非仿真视口(15px 经典滚动条,布局宽 375)同形:右缘 396.4 > 375。 | t7-ac4.mjs;t7-ac4b.mjs;t7-ac4c.mjs |
| AC4 | `.cert-open` 是带 href 的链接 | pass | 2 个 `<a class="cert-open" href="/cert-msb@2x.png">` / `href="/cert-colorado@2x.png"`,无 target,`display:block; pointer-events:auto`,312×416.5;直接 GET 两图 200 `image/png`(420,753 B / 507,708 B)。 | t7-ac4.mjs;t7-ac4b.mjs |
| AC4 | 点击后当前页 URL 变成图片地址且 200 | **fail**(自然位置被导航遮挡) | Playwright 默认点击(scrollIntoView 把证书滚到视口中央 → 中心 y≈422)**超时**:命中的是导航里 `SPAN.xbtn-a`(链 `A.xbtn.solid.dl-btn[href=#download]` → `DIV#nav-menu.menu` → `NAV`),`insideCert=false`;同点原生 `mouse.click` → URL 变 **`/#download`**。左上角 (10,10) 点击也被导航 logo `svg` 挡住。把证书用 `scrollTo({behavior:'instant'})` 放到导航带下方(top 439.8)、点 (195,600)(命中 `IMG insideCert=true`)→ URL **`/cert-msb@2x.png`,200,image/png**(mobile 与非 mobile 视口均如此)。结论:链接本身正确,失败源自「额外发现 1」的常开导航带。 | t7-ac4b.mjs;t7-ac4c.mjs;t7-ac4d.mjs |

## fail 复现步骤

**AC3 `[data-rv]` 打印不可见(/)**
1. Playwright chromium,viewport 1440×900,`goto('http://localhost:4399/')`,等 networkidle + fonts.ready。
2. `page.emulateMedia({ media: 'print' })`,等 500ms。
3. `[...document.querySelectorAll('[data-rv]')].map(e => getComputedStyle(e).opacity)` → 35 个全为 `"0"`;transform 27 个 `matrix(1,0,0,1,0,12)`,8 个 `.rv-fade` 为内联 translate3d 负值。
4. 已下发 CSS 里可见原因(黑盒读 `document.styleSheets`,非读仓库):`@media print { html.js [data-rv] { --rv-o:1; --rv-t:none; transition:none } }` 特异性 (0,1,1),被常驻规则 `html.js [data-rv]:not(.in) { --rv-o:0; --rv-t:translateY(12px) }` (0,2,1) 压住 → 变量仍为 0 / 12px;`prefers-reduced-motion` 分支写的是 `html.js [data-rv]:not(.in)` 所以能赢,打印分支没带 `:not(.in)`。另外 `.rv-fade` 的内联 `transform` 是 JS 写的,靠改自定义属性覆盖不到内联,打印需 `transform: none !important`(`.lr-inner` 的打印规则就是这么写的,所以它 19/19 通过)。

**AC4 导航链接盒子溢出 / 「How it works」被裁(无 JS 390×844)**
1. `browser.newContext({ javaScriptEnabled:false, viewport:{width:390,height:844}, isMobile:true })`,`goto('/')`。
2. `document.querySelector('.site-nav a[href="#how"]').getBoundingClientRect().right` → 400.9;`Range.selectNodeContents(文本节点).getBoundingClientRect().right` → 400.9(> 390)。
3. 截图 `t7-ac4c-nojs-top.png`:末字母 s 切边。

**AC4 证书点击落到导航 Download(无 JS 390×844)**
1. 同上 context,`goto('/')`。
2. `page.locator('.cert-open').first().click()` → 8s 超时(intercepts pointer events);或 `scrollIntoViewIfNeeded()` 后 `page.mouse.click(证书中心)` → `location.href` = `/#download`。
3. 对照:`window.scrollTo({top: scrollY + certTop - 440, behavior:'instant'})` 后点 (195,600) → `/cert-msb@2x.png` 200。

## 额外发现(与 AC 分开)

1. **[P1] 无 JS 移动端导航 = 常开、固定、透明底的 426px 高遮挡带。** `.site-nav` `position:fixed; z-index:40`,`#nav-menu` `display:flex`(未 hidden / inert),`.menu-toggle` `display:none`;`::before` 铺 `--x-nav-tint`(#0c0c0da3)+ `backdrop-filter: blur(14px)` 覆盖整带。任意滚动位置下,x=200 处 y=30/100/160/220/280/340 全命中导航链接、y=400 命中 Download 按钮,y≥440 才是内容。首屏 hero `h1`(top 362.7)被 Download 按钮 `SPAN.xbtn-a` 覆盖(截图 `t7-ac4c-nojs-top.png`:「Let compute flow」被压在按钮和模糊带下);滚动后正文「THE FIELDS B…ERE THAT WORK GOES.」同样被带压住(`t7-ac4c-nojs-scrolled2000.png`)。这是 AC4 证书项失败的直接原因,也让上半屏所有内容在无 JS 下不可点。
2. **[P2] 无 JS 导航链接盒子宽 261.1、右缘 400.9 > 390**,「How it works」裁 10.9px(AC4 表内已计;此处提醒它与 1 同源:菜单在无 JS 下以「展开态」大字号渲染却没按 390 宽度收缩)。
3. **[P2] 打印:8 个 `.rv-fade` 元素的内联 `translate3d` 视差偏移(-515 / -571 / -699px)未被打印规则中和**,与 AC3 特异性问题是两条独立机制,需一起修(只补 `:not(.in)` 仍留 8 个位移)。
4. [info] 无 JS 下正文可见:`[data-rv]` 35 个 opacity 均为 1、h1 opacity 1(无 JS 不依赖 `html.js` 才显示,好)。
5. [info] `html { scroll-behavior: smooth }` 在无 JS 下生效:程序化 `scrollTo` 会动画(影响自动化测试;用 `behavior:'instant'`)。
6. [info] AC1(a) 三次采样亮像素数完全相同(87489)—— reduced-motion 下是确定性静帧,resize 后重绘位置不变,非缺陷。
7. [info] `[data-lr]/[data-tw]` 宿主含 SPAN(AC 列的是 div/p/h1-h3),同样无 aria-label、同样带 `.x-sr`。
8. [info] /vi/ 只声明 Be Vietnam Pro 400/500 两档;页面 BVP 元素字重直方图 400×115、500×22,无 ≥600 使用,不存在合成粗体。EN 首页 `/` 上 BVP 6 面均 unloaded(EN 用 Funnel Display,符合预期)。
9. [info] AC1(b) Meta:真 macOS Cmd+click 本机无法实测,仅有合成事件 `defaultPrevented=false` 的间接证据。

## 结论

AC 级:**PASS 2/4**(AC1 ✅ · AC2 ✅ · AC3 ❌ 首页 `[data-rv]` 打印不可见 · AC4 ❌ 无 JS 导航溢出裁切 + 证书点击被常开导航带截走)。
子项级:16 项中 **13 pass / 3 fail**(AC1 4/4,AC2 1/1,AC3 7/8,AC4 1/3)。
