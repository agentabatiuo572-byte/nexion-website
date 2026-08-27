# R45 独立评审 · 可读性与可用性(终版构建 · 第三路)

评审对象:`http://localhost:4399/` 构建产物(2026-08-26 采样)。角度:真实访客——看得清、点得到、动效不添堵。
结论先行:**8.5 / 10**。上一轮可用性四大扣点(翻色窗低对比、新块小字压粒子、手机灯箱形同虚设、行内链盖上一行)全部实测已消;导航翻色 18 种进出情形任一帧 ≥4.05:1、CLS 0、四档视口零溢出、慢网零闪现、手机菜单/灯箱/键盘陷阱/旋转收口全部过关。剩余失分是六件访客真会撞到的事:① 404 页导航 4 个入口(How/Devices/Trust/Download)是死链(新增);② 桌面证书灯箱慢网首开先弹出一个只有 CLOSE 键的 106×186 小白框、0.4s 后胀到 752×846(新增,本轮宣称已修);③ 手机端 /nex/ 对比表的 NEX 列整列在屏外且无任何可滑提示(既有);④ How 第 3 步行内链被视差层带着跑,键盘 Tab 到它时焦点落在视口外 300px 处且不回来(既有);⑤ 小字压粒子线的既有族(文章 meta / 学习中心副题 / NEX 引言 / 法务更新行 / 手机首屏说明);⑥ 1440 宽 Windows(经典滚动条)下焦点环被画布 zoom 0.9896 抹成 1px。

## 方法

- Playwright 无头 Chromium(借 `Nexion-uniapp` 依赖),脚本与原始数据全在会话 scratchpad:`rev3c-{desk,mobile,pages,extra,sizes,modes,misc,mlb,mlb2,tab,lbfix,vi}.mjs` 与同名 `.json/.log`,截图 `rev3c-*.png`(路径见文末)。
- 视口:1440×900 · 1366×768 · 1920×1080 · 2560×1440 · 390×844(isMobile+hasTouch)· 844×390 横屏 · 768×1024 / 1024×768(touch)· 861×700 / 900×700(汉堡断点两侧);经典滚动条模式(`ignoreDefaultArgs:['--hide-scrollbars']`)1440 / 1600 / 1920。
- 路由:三语首页、`/learn/`、`/learn/getting-started/`(+vi)、`/nex/`(+zh)、`/legal/privacy/`(+vi)、`/404.html`;无 JS(390);reduced-motion;print;慢网 CDP `emulateNetworkConditions` 1.5 Mbps / 300 ms(en / vi / 手机 / 文章;缓存关闭)。
- 对比度按 WCAG 相对亮度自算。**粒子上的文字**用像素法:隐藏文字元素 → 截暗区 → 逐像素把文字色(含 alpha)合成到该像素 → 统计「<4.5:1 面积占比 / <3:1 面积占比 / 最差 / 均值」,每处取 3 帧。**导航底板**按 `::before` 背景色 × opacity 合成到实际底色(白带 242 / 黑区 12,以文字行中线落在白带内外判底);**翻色过程**用 rAF 逐帧读 `.links a` 的 `color`、`::before` 的背景色与 opacity、白带 rect,18 种进出情形(快滚 / 1px 与 2px 逐帧慢滚 / 1500px 大跳 / 从下方进入 / 向上退出,1440 与 390 各 9 种),每种先 `settle` 到起点再采样(上一情形的 Lenis 惯性会把起点带跑,首轮 2 种情形因此作废重测)。
- 亮区(白带 / 纸面板)一律用 DOM 与计算样式断言,不看像素;暗区截图可信并已回看(hero / 菜单 / 灯箱 / 页脚 / 2560 / 1366 / 手机)。
- 交互:滚动用 `mouse.wheel`(Lenis)与逐帧 `scrollBy`;触屏用 `page.tap` / `touchscreen.tap`;触摸拖拽用 CDP `Input.dispatchTouchEvent`。**哨兵**:原始 CDP 触摸注入之后,同一页面里 Playwright 的 tap 不再产生 click(`rev3c-mlb.json` 里 `ts/te` 有、`click` 无)——这是 harness 伪影,已用无拖拽的独立页面复验(灯箱开 / 平移后点关 / 重开归零 / 菜单点链接均正常,`rev3c-mlb2.json`),报告里没有任何扣分建立在该伪影上。
- 修法均按「参数级」给出;灯箱首开的修法已在产物上注入 CSS 验证(`rev3c-lbfix.mjs`)。

## 访客路径观察

| 步骤 | 实测 | 判定 |
|---|---|---|
| 首屏(1440×900 快网) | 画布 750ms 淡入完成;导航 519→1017ms;标题两行 618ms 滑入,遮罩建好前 0 帧可见(`h1VisibleBeforeReady=false`);副题 1517ms、下载键 1934ms;35 个打字机 0 帧漏显。刷新到 y=5200 / 从 /learn/ 后退:第 0 帧导航 opacity 1、无 `x-boot`,不重放 | 通过 |
| 首屏(慢网 1.5Mbps/300ms) | en:样式 787ms 到达前无一帧无样式(`unstyledFrames=0`),导航 1227→1727ms,标题 1411ms(Funnel 已就绪),副题 2226ms,下载键 2643ms;vi 同形(标题 1478ms 用 Be Vietnam Pro);手机同形;文章页导航第 0 帧即显 | 通过 |
| 直达 / 跨页锚点 | 新开 `/#trust`:第一个采样(100ms)scrollY 已 10360、`#trust` 顶距 83,无长滚、无 `x-boot`、导航第 0 帧已 `on-light`;`/vi/#download` 同;从 /learn/ 点导航「How」→ `/#how` 落点 83,无长滚。站内点击「How」→ 目标顶距导航 10px、焦点落 `#how`、hash 更新;Ctrl+click 锚点与证书均不拦(`defaultPrevented=false`) | 通过 |
| 滚读 | 整页滚轮读完 CLS **0.000**;导航上方滚轮 40 帧 20 个不同 scrollY(平滑,链接上方 19 个);静态底板对比:黑区白字 19.6:1、白带黑字 17.5:1 | 通过 |
| 导航过白带 | 18 种情形任一帧最低 **4.05:1**(交叉帧,底板 114 上黑字),0 帧 <3:1,每种 ≤1 帧 <4.5:1;`flipping` 类均出现(底板 0.95);手机汉堡在白带上为 `rgb(12,12,13)`;白带上开菜单 60ms 内墨色已白(延迟归零生效) | 通过;交叉帧 4.05 略低于交底的「≈4.6」,单帧不可察 |
| hover / 按下 | 11 处探针:导航链 1→0.6、语言链 0.62→1、下载键滑层、FAQ / PoC 摘要 `.q` 1→0.6、证书提示 0→1、行内链 1→0.6、页脚法务链 0.62 白→全白、学习中心行 1→0.6、`/learn/` 卡 1→0.92、文章目录行 1→0.6、相关文章行 1→0.6、返回链提亮;禁用键与滚动提示无反馈(既定) | 通过 |
| 证书灯箱(桌面 1440) | 点开:对话框 752×846、焦点落 74×44 关闭键、`html.overflow=hidden`;滚轮 500 → `scrollTop` 204(到底)且页面 scrollY 不变,再滚 3000 仍不串联;关闭行 sticky 常驻;Esc 关 → 焦点回缩略图、页面滚轮恢复(+199);重开 `scrollTop=0`;内衬带点击不关、背景点击关;Enter 可开;1366 / 1920 / 2560 对话框 760×722 / 1005×1015 / 1013×1354,证书正文可读 | 通过(慢网首开见扣分 #2) |
| 证书灯箱(手机 390) | `(hover:none)` 下提示常显;点开全出血 390×844,图 1160×1548 可双向滚(`scrollWidth 1176 / scrollHeight 1616`);平移到 (285,435) 后关闭行仍在 (8,0)、关闭键 75×44 可命中;点关 → `overflow` 清空、焦点回缩略图、页面拖动恢复;重开 `scrollLeft/Top=0`;第二张证书 src/alt 正确;慢网首开盒 390×844 全程不变 | 通过 |
| 手机菜单(390×844) | 汉堡 44×44,开态两杠成 ×;菜单全屏实底,五链 261×53(vi 最长「Cách hoạt động」339 ≤ 390 单行),语言链 35×44,下载键 120×48;空白四点命中全在菜单内、点空白不关不穿;菜单内拖拽页面位移 0;点链接 → 关闭并落到 `#how`(顶距 64 = 条高 54+10),焦点落 `#how`;Esc 关且焦点回汉堡;Tab 9 项后回汉堡循环,汉堡上 Shift+Tab 回「Download」;LOGO 开态隐藏;`inert` 开合正确 | 通过 |
| 平板 / 旋转 | 768×1024:汉堡、证书两列、五卡 2+2+1;开菜单后转 844×390:菜单 `overflow-y:auto`、滚轮与触摸都能把下载键拉进视口(scrollTop 156)且页面不动;再拉到 1024×768:菜单自动收口、`overflow`/`inert` 清空、页面可滚(+498);1024×768 导航单行(时钟隐藏)最小间距 6px;861×700 单行最小间距 4px、900×700 4px | 通过 |
| 学习中心 / 文章 | `/learn/` 卡纸面 5.33:1、hover 0.92;文章 TOC 入纸面板:标签 5.33:1、行文 17.5:1、4 行各 44px、无「01 1.」双编号;点目录 → 目标 H2 顶距导航 10px、焦点落 H2、下一 Tab 落相关文章;相关文章 2 条 60px、hover 0.6;正文 12px/1.85 纸面 5.33:1、68 字/行;手机 390:TOC 行 44、相关文章话题列隐去、正文 310px 宽 | 通过(头部 meta 行压粒子见 #5) |
| /nex/ · /legal/ · 404 | /nex/ FAQ 与首页同规格、hover 0.6、答案左缘=问题左缘;表格 1440 下 1029px 三列全显;法务 H1 88 档单行、英文岛 `lang=en`、vi 顶部「英文版为准」提示;404 三语块各吃各的字体、语言链回 `/`、`/vi/`、`/zh/`、`noindex`、无 canonical | 通过(404 导航锚点见 #1;手机表格见 #3) |
| 页脚(透底 + 护字层) | 1440:免责声明最差 6.5:1(0% <4.5)、法务链 ≥6.38、字标 OK;版权行(护字层外)2.4% 面积 <4.5:1(最差 1.34);390:全部 0% <4.5 | 通过;版权行归入 #5 族 |
| 键盘 | Tab 序:LOGO → 5 链 → 3 语言 → 下载 → 滚动提示 → 内容;全部 `:focus-visible` 命中、焦点环深柠檬 / 柠檬随语境;Tab 到 How 第 3 步行内链焦点落屏外(见 #4) | 见 #4 / #6 |
| 无 JS / reduced / print | 无 JS 390:导航随流(相对定位、高 186)、9 个链接可见可点、标题 / 打字机 / 进场 0 处隐藏、证书 `href=/cert-msb@2x.png`;reduced:第 0 帧全显、Lenis 不起(滚轮 2 帧到位)、导航翻色 `transition-delay 0s`、叠卡静态、灯箱可用;print(/、法务、文章):白底黑字、导航与粒子 `display:none`、35 个打字机影子层可见、进场 / 遮罩 0 处隐藏、叠卡 static、zoom 1 | 通过 |
| 视口 / 三语 | 1366×768 下载键底 645 ≤ 768;1920 / 2560 画布 1920 居中(313–2233)、白带全出血 0–2545;经典滚动条 1440 / 1600 / 1920 画布左右空档 0 / 0、白带右缘 = clientWidth、无横向滚动;三语手机首屏 / 菜单 / 溢出全 0;vi 数字 28.432 / 99,7%,zh 与 en 28,432 / 99.7%;时钟「UTC 09:42 PM」带空格;导航下载键 12px / 44 高 | 通过 |

## 扣分清单

| # | 严重度 | 类型 | 已拍板? | 问题 | 证据 | 参数级修法 | 扣分 |
|---|---|---|---|---|---|---|---|
| 1 | P1 | **新增缺陷**(本轮 A11 新建 404 页) | 否 | 404 页导航里「How it works / Devices / Trust」与「Download」四个入口是死链:`SiteNav` 收到 `path='/'`(为了让语言链回各语首页)→ `isHome=true` → 锚点渲染成 `#how` / `#download`,而 404 页没有这些 id;点击后 fx 找不到目标放行原生,URL 变成 `/404.html#how`,页面纹丝不动。任意缺失路径(`/no-such-page/` 实测 404 且同一页面)同症 | `rev3c-modes.json › nf`:`hrefs=["/","#how","#devices","#trust","/learn/","/nex/","/","/vi/","/zh/","#download"]`,点击后 `url=…/404.html#how, y=0, exists=false`,下载键同 | `SiteNav` 增一个 prop `inPageAnchors?: boolean`(默认 `path === '/'`),`anchor()` 改为「inPageAnchors 为真才输出 `#id`,否则输出 `${prefix}/#id`」;`Base.astro` 对 `noindex` 传 `inPageAnchors={false}`(语言链仍用 `path='/'` 回首页)。两行改动,404 页四个入口变 `/#how` … `/#download` | −0.4 |
| 2 | P2 | **新增缺陷**(本轮 A4「慢网首开盒稳」未达成) | 否 | 桌面灯箱慢网首开:`img.removeAttribute('src')` 后 `<dialog>` 默认 `width: fit-content`,`img{width:100%}` 对 shrink-to-fit 容器无解 → 对话框收成关闭键那么宽:先弹出 **106×186 只有 CLOSE 键的小白框**,PNG 头到达后跳成 752×846;1.5Mbps 下小框持续 **403ms**(开 219ms → 满 622ms),更慢的网更久;vi 同症(98×176)。首次打开必现(每张证书各一次),重开走缓存不现。手机端因 `img{width:1160px}` 全程稳定 | `rev3c-tab.json › lbSlow`:`smallSize 106x186, fullAt 622, smallDurationMs 403`;`rev3c-modes.json › slow.en.lb / slow.vi.lb` 同;`rev3c-lbfix.mjs` 验证:当前 CSS 复现 106×186,加定宽后首帧即 752×846 | `.cert-zoom { width: min(calc(96vw / var(--x-zoom)), calc(760 * var(--uc))); }`(与现有 `max-width` 同式;≤860 已是 `width:100vw` 不动)——图的 `width/height` 属性提供纵横比,盒子首帧即终态。`img` 上写定宽无效(`max-width:100%` 仍绕回 fit-content,已实测) | −0.3 |
| 3 | P1 | 既有值(表格本轮未动) | 否 | 手机 `/nex/`「NEX vs USDT」对比表:`table{min-width:520uc}` 在 314px 宽的纸面里横向溢出,三列位置 Property 38–134 / USDT 134–356 / **NEX 356–558**——NEX 列整列在屏外;`.table-wrap` 只有 `overflow-x:auto`,无渐隐、无阴影、无提示,手机滚动条不显示。访客在「NEX 页」看到的是一张只有 USDT 的对比表 | `rev3c-modes.json › nexTable`:`tds[2].vis=false`,`wrapMask/wrapBgImg/wrapBoxShadow=none, scrollbarW=0`;截图 `rev3c-m-nex-table.png`(zh 同症,`rev3c-pages.json › m./zh/nex/`) | `@media (max-width: 640px) { table { min-width: 0 } th, td { padding-right: calc(8 * var(--uc)) } }` —— 三列各约 100px、单元格自然折行(最长「Stablecoin (pegged to USD)」3 行),不再需要横滚;若坚持横滚则至少给 `.table-wrap` 右缘一道 `mask-image: linear-gradient(to right, #000 calc(100% - 32px), transparent)` 作可滑提示 | −0.3 |
| 4 | P2 | 既有值(视差 + 行内链早于本轮) | 否 | How 第 3 步「How earnings are verified」行内链住在 `[data-plx=0.16]` 视差层里。键盘从上一个可聚焦件(Mission CTA)Tab 过来时,浏览器按**旧位移**(步块 transform −745.9px)算滚动位,滚完视差重算成 +41.5px → 焦点元素落在 **视口下方 300px**(y=1207 / vh 900)并停在那里 8s 不动;reduced-motion(无视差)下 100ms 内进视口。键盘用户按下 Enter 会跳到 #trust,但看不见自己聚焦了什么 | `rev3c-tab.json › tab-normal`:`pre.stepTf=-745.9`,之后 30 个采样 `y=1207 b=1251 sy=8024 inView=false`;`tab-reduced`:`firstInViewAfterMs=100` | `initParallax` 里加一个 `focusin` 监听:`addEventListener('focusin', (e) => { const p = e.target.closest('[data-plx]'); if (!p) return; apply(); requestAnimationFrame(() => (lenisInst ? lenisInst.scrollTo(e.target, { offset: -innerHeight / 2 }) : e.target.scrollIntoView({ block: 'center' }))); })`——先按当前滚动位重算位移再把焦点件送到视口中线。(只影响键盘;`.nex-teaser .card` 同为视差层但内无链接,不受影响) | −0.2 |
| 5 | P3 | 既有值(内页头部行与首屏说明为主人看过的值) | 否(不在拍板清单) | 12px `--x-ink-dim` 小字直压粒子线的既有族:文章 `.meta` 13.6% 面积 <4.5:1(最差 1.23);`/learn/` 副题 11.4%(2.8% <3:1);`/nex/` `.lead` 9.9%;`/legal/` `.updated` 11.6%(3.3% <3:1);404 英文正文 5.0%;页脚版权行 2.4%;**手机首屏说明** `.hero .note` 17.1%(4.4% <3:1,最差 2.13——390 下吸引子居中放大,说明行正压在密线带上;1440 下为 0%)。均值 6.6–7.4 整体可读,但流光与密线经过时会有整词发虚 | `rev3c-pages.json › learn.head / article.top / nex.top / legal.top / nf.bodyScan`;`rev3c-mobile.json › particles.hero`;`rev3c-desk.json › footer` | 内页头部块(`.back/.meta`、`/learn/ .head p`、`/nex/ .lead`、`/legal/ .updated`)与首屏 `.note` 复用页脚已有的护字层配方:`position:relative` + `::before{inset:-12px -16px; background:rgba(12,12,13,.9); filter:blur(12px); z-index:-1}`,不动透底、不动粒子姿态;版权行同法 | −0.2 |
| 6 | P3 | 既有值(画布 zoom 机制 R42) | 机制已拍板,缺陷本身未拍板 | 焦点环 `outline: 2px` 写在画布内,1440 宽 + 经典滚动条(Windows 主流)时画布 zoom = 1425/1440 = 0.9896 → 2px 变 1.979 设备像素,Chrome 描边取整**抹成 1px**(`outline-offset` 同样 2→1);实测像素:环上下左右各 1px。1440–1454 这一段宽度都中招;1366(zoom 1)与 ≥1600 正常 2px | `rev3c-sizes.json › outline`:`vRuns [1,1], hRuns [1,1], computed.ow=1.01053px`;截图 `rev3c-focus-navlink.png` | `a:focus-visible, button:focus-visible, summary:focus-visible { outline-width: calc(2.05 * var(--uc)); outline-offset: calc(2.05 * var(--uc)); }`——0.9896 下 2.03 → 2px,zoom 1 下 2px,1.333 下 2.73 → 2px;不动 zoom 机制 | −0.1 |

合计 −1.5 → **8.5**。

不扣分的观察(供工艺侧参考,访客不可察):翻色交叉帧最低 4.05:1(交底写「≈4.6」,差在按 sRGB 分量插值到 117 时 0.95 底板合成为 114);行遮罩终态已还原纯文本(`.lr-line` 0 个),余量只在 0.9s 动画期起作用,本轮未逐帧量;首页每次加载控制台一条「funnel-display-latin-500 preloaded but not used」警告(字体实际在用,疑似预载与 CSS 字体请求未合并成同一次下载,属性能而非可用性,未深究)。

## 已排除(主人已拍板 / 既定,不扣分)

- 首屏标题字号与文案;窄屏不做第二套画布;信任五卡 4+1;FAQ 右缘;正文行长与全大写;页脚空档;自定义光标;手机汉堡;reduced-motion 保留;排印档位数;导航小字 12px 下限与条高;画布 zoom 机制;编号强调色;卡片淡入;桌面灯箱原尺寸;粒子性能;跳到内容链(待主人文案);桌面语言链 EN/VI 命中宽 15px(1366 / 1024 / 861 实测均 15×44)。
- **导航底板半透明磨砂(本轮拍板)**:静态黑区 19.6:1、白带 17.5:1;翻色窗底板 0.95 后 18 种情形任一帧 ≥4.05:1、0 帧 <3:1——上一轮 #1 已消。页脚截图里可见收尾大标题透过底板隐约显形,是磨砂本性,不扣。
- **页脚透底 + 护字层(本轮拍板)**:免责声明 / 法务链 1440 与 390 均 0% <4.5:1,护字层起效;版权行在层外,归入 #5 族不单扣。
- **首屏底空 220**:1366×768 下载键底 645、1440×900 673、1920×1080 900 均在首屏。
- **下载键禁用占位(既定)**:文字 7.7:1,描边 `--x-line-soft` 对底 1.19:1 几乎无边界——既定不扣。
- **数字条标签压粒子(既有值)**:1440「Network nodes」56.5% 面积 <4.5:1(最差 1.43),390「AI jobs running」52% / 10.5% <3:1——按交底列为既有值不扣;若日后处理,与 #5 同一护字层配方。
- **首载四拍时序**:快网下载键 1.93s、慢网 2.64s 才出现,既定编排。
- 手机 12px 等宽正文:排印档位 / 12px 下限拍板。
- 滚动提示 hover 零反馈:既有,上一轮已列 P3,本轮不重复计。

## 复核要点(供回源)

- #1:`rev3c-modes.mjs` 段 D,或直接开 `/404.html` 点导航「How it works」——URL 加 `#how`、页面不动;`dist/404.html` 里 `href="#how"` 可 grep。
- #2:`rev3c-tab.mjs` 末段(CDP 1.5Mbps/300ms + 缓存关闭,rAF 逐帧读 `.cert-zoom` rect);`rev3c-lbfix.mjs` 三组 A/B/C 注入 CSS 对照(A 当前 106×186、B 定宽 752×846、C 图定宽无效)。
- #3:`rev3c-modes.mjs` 段 D 读 `th/td` rect;截图 `rev3c-m-nex-table.png`。
- #4:`rev3c-tab.mjs` 段 `tabProbe`(normal vs reducedMotion 各 3s 采样,含 `.step` transform)。
- #5:`rev3c-pages.mjs` / `rev3c-mobile.mjs` 段 6 / `rev3c-misc.mjs` 段 2 的 `scanText`(隐藏文字→截图→逐像素合成),数值随流光每帧略变,取 3 帧最差 / 最大占比。
- #6:`rev3c-sizes.mjs` 段 0(聚焦导航链后截 1× 图、沿中列 / 中行数柠檬色连续像素)。
- 翻色 18 情形:`rev3c-extra.log` 段 2(`flip1440` / `flip390`,每种含 `settled` 标记与低于 4.5 的帧明细)。
- 证据文件:`C:/Users/jason/AppData/Local/Temp/claude/D--WORKS-PLAN/42e4397e-0bc4-4987-8cc3-a0bc8464e0bd/scratchpad/rev3c-{desk,mobile,pages,extra,sizes,modes,misc,mlb,mlb2,tab,lbfix,vi}.mjs`、`rev3c-{desk,mobile,pages,sizes,modes,misc,mlb,mlb2,tab,gest}.json`、`rev3c-{desk,mobile,pages,extra,sizes,modes,misc}.log`;截图 `rev3c-nav-light.png` `rev3c-footer-1440.png` `rev3c-lightbox-1440.png` `rev3c-lb-slow-1440.png` `rev3c-focus-navlink.png` `rev3c-m-{hero,menu,menu-onlight,landscape-menu,lightbox-panned,footer,nojs,nex-table,vi-menu,zh-menu}.png` `rev3c-{1366x768,1920x1080,2560x1440,768x1024,1024x768,861x700,900x700}-hero.png` `rev3c-768x1024-menu.png` `rev3c-classic-{1440,1600,1920}-{hero,band}.png` `rev3c-{learn,nex,legal,404}-1440.png` `rev3c-article-{top,related}-1440.png` `rev3c-slow_*.png` `rev3c-m_*.png`(内页 390)。

## 总分

**8.5 / 10** —— 上一轮四个真实访客痛点已全部实测消失,磨砂导航、灯箱、手机菜单、键盘陷阱、慢网首屏、多视口与三语都过关;失分在 404 页导航死链与桌面灯箱慢网首开小白框两处本轮新伤,加上手机 NEX 对比表整列不可见、视差层吞掉键盘焦点、小字压粒子既有族与 1440 焦点环抹薄四处既有问题,全部可参数级修。
