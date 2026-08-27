# R45 · RT-A 独立黑盒回归 — 导航翻色 / 横屏菜单 / 行内链 / hover / 读屏名 / 打印 / 无 JS / 尾斜杠

- 对象:NexGrid 官网**构建产物** http://localhost:4399/(dist 生成于 2026-08-26 02:17:30,晚于 src 最新改动 02:17:20;live 页引用 `Base.Ck-2iRzd.css` / `FinalCta.t1kiUD_x.css` / `Base.astro_astro_type_script_index_0_lang.mLcliFm3.js`,与 dist/_astro 一致)
- 日期:2026-08-26 · 验收方:RT-A(独立 tester,只按 AC 实测,未读实现叙述;仅读了产物 HTML/CSS 取选择器)
- 方式:Playwright 黑盒脚本(scratchpad `rta-lib.mjs` 公共库 + `rta-ac1..8.mjs` + `rta-ac4b.mjs`);逐帧数据用 rAF 采样器(每帧记 `performance.now()` + computed style + 几何),原始帧数据存 scratchpad `rta-ac1-*.json` / `rta-ac4-row-frames.json` / `rta-ac4b.json`。

## 环境

| 项 | 值 |
|---|---|
| Playwright / Chromium | 1.61.0 / HeadlessChrome **149.0.7827.55**(借 Nexion-uniapp 依赖) |
| OS / Node | Windows 11 / Node 24.15.0 |
| 滚动条形态 | headless 默认(`--hide-scrollbars`,站点 `scrollbar-gutter:stable` 仍留 15px 槽):1440 宽下 `.x-canvas` 计算 zoom = 1425/1440 = **0.989583**;≤1439 为 1 |
| 脆性排除 | 滚动一律 `mouse.wheel`(Lenis),等 ≥1.5s;进页等 `networkidle` + `document.fonts.ready` + 2.5–3.5s 开场;对比度全部按 computed style 计算(WCAG 相对亮度,alpha 合成到指定底色),不用截图;手机菜单 `hasTouch:true,isMobile:true`;无 JS `javaScriptEnabled:false`;打印 `emulateMedia({media:'print'})` |
| 帧率 | 全部录制平均帧间隔 16.66–16.67ms,最大 19–22ms(无掉帧) |

## 逐条 AC

| AC | 判定 | 证据(原始数字) | 脚本 · 视口 · 路由 |
|---|---|---|---|
| **AC1-a** 底板色连续变化 0.2–0.3s | **pass** | `::before` background-color 从 `rgba(12,12,13,.64)` ↔ `rgba(242,242,242,.72)` 线性过渡,6 次录制(进/出 × 快 33px/帧 / 慢 5px/帧 / 极慢 2px/帧)每次 **15 帧连续变化**,首个变化帧→末个变化帧 **232.3–233.7ms**,自最后一个未变帧起算 **249.3–250.9ms**(标称 250ms) | rta-ac1.mjs · 1440×900 · `/` |
| **AC1-b** 文字颜色瞬切、无过渡帧 | **pass** | 6 次录制 `.site-nav` computed color 与 `#nav-menu .links a` color 均**只变化一次**,相邻两帧 `rgb(255,255,255)`→`rgb(12,12,13)`(出白带反向),帧间隔 16.5–18.1ms,中间无任何插值色 | 同上 |
| **AC1-c** 切换时刻:进 30–80ms、出 160–230ms | **pass** | 以「底板第一个变化帧」为 0:进白带 **50.0 / 50.9ms**(快速 67ms 帧内同帧切,详见 c 注);出白带 **184.0 / 182.8 / 183.5ms**。以「class 翻转帧(底板尚在起点值)」为 0:进 **67–68ms**、出 **200ms**(标称 delay 54 / 196ms)。慢/极慢两档进出 4 次全部落在窗内 | 同上 |
| **AC1-d** 全过程每帧 文字 vs 底板合成底色 ≥3:1 | **fail** | 按 AC 模型(链接文字中心 y=51.84;`.x-invert` 顶边 ≤51.84 视为白带底 #f2f2f2,否则黑底 #0c0c0d):**最低 1.68:1**。<br>低于 3:1 的帧数:进-快 **0**;进-慢 **3 帧 32ms**(1.68/1.99/2.36);进-极慢 **4 帧 49ms**(1.68/1.99/2.36/2.82);出-快 **4 帧 51ms**;出-慢 **4 帧 49ms**;出-极慢 **4 帧 51ms**(出向三档均为 2.82→2.36→1.99→1.68)。<br>发生位置:进白带时 `.on-light` 在白带顶边到 **y≈77–80**(导航底 74 下方 3–6px、距文字中心还有 25–28px)就翻转,文字 67ms 后先变黑,白带慢速时还没到文字下方(慢档翻黑帧 bandTop=60.2,极慢档 75.2)→ 黑字压在「深灰底板 `rgba(79,79,80,.663)` 合成到黑」上;出白带时 `.on-light` 在白带顶边到 **y≈86–88**(白带已离开文字 34–36px)才翻转,文字保持黑色 196ms,而底板在 ~117ms 起已暗到黑字 <3:1,直到 200ms 翻白前 4 帧全部不达标(与滚速无关)。<br>若统一假设底色为黑:6 次各 4 帧 <3:1;若统一假设为白:0 帧 | rta-ac1.mjs · 1440×900 · `/`(逐帧表见 `rta-ac1-summary.json` 的 `series`) |
| **AC2** 横屏菜单可滚(844×390,`/` 与 `/vi/`) | **pass** | 两路由数字完全相同:`.menu-toggle` 可见(44×44 @ x=776.6,y=10);打开后 `#nav-menu.open` display flex / position fixed / overflow-y auto,scrollHeight **546** > clientHeight **390**,`.dl-btn` 初始 [466,514](视口外);`mouse.wheel(0,400)` 后 `scrollTop` **0→156**(=546−390 到底),dl-btn **[310,358]** 全在视口内;重置后 CDP 真触摸上滑(y 340→60)`scrollTop` 同样 **156**、dl-btn [310,358];全程 `window.scrollY` **0** 不变(html overflow hidden,`lenis-stopped`)。关闭后 `#nav-menu` display none,页面 `wheel(0,400)` → scrollY **200**,再触摸上滑 → **465**,可正常滚 | rta-ac2.mjs · 844×390 hasTouch+isMobile · `/` `/vi/` |
| **AC3** `#how .vlink` 命中盒 ≥44 画布 px;段落高度与相邻一致 | **pass** | 命中盒高(rect.height ÷ `.x-canvas` zoom):390 **44.39**(zoom 1)、1024 **44.39**(zoom 1)、1440 **43.94/0.989583 = 44.40**(offsetHeight 44);link 为 inline-block,padding 13.5/13.5 + margin −13.5/−13.5,文字行本身 17px 高。`#how` 三段 `p.body` 每行高度一致:390/1024 **17.39px/行**(含链段 2 行 34.78 / 3 行 52.17,与无链段同值),1440 三段均 2 行 **34.44**;链接未撑高所在行 | rta-ac3.mjs · 1440×900 / 1024×768 / 390×844 · `/` |
| **AC4-a** 页脚法务链 + 文章页 `a.back` 三态 | **pass** | `.site-footer nav a`(Privacy Policy / Terms of Service)与 `/learn/getting-started/` 的 `a.back`(← All guides)三者数字相同:idle `rgba(255,255,255,0.62)` opacity **1** → 合成 (163,163,163) 对 #0c0c0d **7.72:1**;hover `rgb(255,255,255)` opacity **1**(提亮)**19.55:1**;active(mouse.down)`rgb(255,255,255)` opacity **0.75** → (194,194,195) **11.01:1**;释放(在元素外抬起,避免点穿导航)后回到 0.62/1 | rta-ac4.mjs · 1440×900 · `/` `/learn/getting-started/` |
| **AC4-b** 学习中心行:鼠标预置在最终位置,wheel 进场后 ≤0.3s 达 0.6 | **fail** | 干跑定位:`wheel(0,12067)` 后首行终态 rect top 449.7/bottom 540.9,鼠标预置 (712.5,495.3);实跑终态位置一致、`matches(':hover')` true、elementFromPoint 命中行内 `.name`。逐帧(3 次重复完全一致,以录制起点为 0):`.in` **597–668ms**(opacity 0→ 沿 900ms 曲线上升,transform 12px→0);**350ms 后**(t≈947–1019)`:hover` 与 `rv-done` 同一帧出现,此时 computed `transition-duration` 已是 **0.2s**,但 opacity 新过渡 `getAnimations()` 时长 = **900ms**(`opacity:900@17`),峰值 **0.915** 起沿 0.9s 曲线下降:≤0.605 用时 **498–499ms**、到 0.6 用时 **765ms**(自 hover/rv-done 起算)。<br>对照组(鼠标放远处让行完整进场,再移入):opacity 过渡 **200ms**,hover→0.605 **170–181ms**、→0.6 **229–256ms**(机制本身有效)。<br>[INFERRED] 产物 JS 里 `rv-done` 由 `transitionend`/取消事件挂上:行在进场中滑到指针下方 → hover 重定向 opacity 过渡(此时仍是 0.9s)→ 原过渡被取消 → 才加 `rv-done`,对已开始的 0.9s 下降无效。<br>若把「进场完成」读作 900ms 过渡自然结束(t≈1497–1568),则此时 opacity 已 ≈0.60,按字面可算 pass——但 AC 括号明确排除「沿 0.9s 曲线慢慢降」,实测正是该曲线,故判 fail,请 main 裁决口径 | rta-ac4.mjs / rta-ac4b.mjs · 1440×900 · `/`(帧表 `rta-ac4-row-frames.json`) |
| **AC5** 读屏名只出现一次 | **pass** | `ariaSnapshot()`:`/` 导航 `.dl-btn` = `link "Download →"`;学习中心 `#learn-entry .more a` = `link "Browse all guides →"`;`/learn/` 导航 `.dl-btn` = `link "Download →"`、页内 CTA `a.xbtn.solid` = `link "Get the app →"`;`/zh/` = `"下载 →"` / `"查看全部教程 →"`。CDP `Accessibility.getPartialAXTree` 名称来源 = contents(ghost/b 两份 `aria-hidden` 已剔除),名称 `DOWNLOAD →` / `BROWSE ALL GUIDES →` / `GET THE APP →`(大写来自 CSS text-transform),各只含文案一次;DOM textContent 三份重复不进入可及名 | rta-ac5.mjs · 1440×900 · `/` `/learn/` `/zh/` |
| **AC6** 打印 | **pass** | `matchMedia('print')` true。`/`:35 个 `[data-rv]` 全部 opacity **1**、transform **none**;8 个 `[data-plx]` 内联 `translate3d(0,-396…-1561px,0)` 仍在,computed transform **none**、opacity 1;`.site-nav` display **none**、`#x-bg` display **none**;body color `rgb(0,0,0)` / background `rgb(255,255,255)`;`page.pdf()` **629,940 B**(`%PDF-1.4`)。`/legal/privacy/`:无 rv/plx 元素,nav/x-bg none,黑字白底,PDF **22,259 B** | rta-ac6.mjs · 1440×900 · `/` `/legal/privacy/` |
| **AC7** 无 JS(390×844,`/`) | **pass** | `html` 无 `js` 类;`.site-nav` position **relative**(高 186,随流);五链 How it works / Devices / Trust / Learn / NEX 均 top 78 / bottom 122,右缘 108.1 / 177.6 / 232.3 / 287.0 / **327.1** ≤390,`elementFromPoint` 中心全部命中自身;首屏 h1(top 548.7)中心命中 `h1.x-display-mega` 本身;`#trust .cert-open` scrollIntoView 后中心命中其 `img`,点击后 URL = `http://localhost:4399/cert-msb@2x.png`,响应 **200 image/png 420,753 B**。加 `isMobile+hasTouch` 变体数字相同 | rta-ac7.mjs · 390×844 无 JS · `/` |
| **AC8** 33 路由内链尾斜杠;`/zh/learn/` title | **pass** | sitemap 33 路由全 200;所有以 `/` 开头的 `<a href>`(每页 12–19 条,`#` 锚 0–9 条、mailto 0)路径部分除 **`/cert-msb@2x.png` / `/cert-colorado@2x.png`**(`/` `/vi/` `/zh/` 各 2 条,证书图文件直链,文件路径不可能带尾斜杠)外全部以 `/` 结尾,**路由型违例 0**;`/zh/learn/` `<title>` = `学习中心 — NexGrid`,"NexGrid" **1** 次 | rta-ac8.mjs · fetch 产物 HTML · 33 路由 |

AC1-c 注:快速档(33px/帧)进白带时 class 翻转、底板首个变化帧与文字翻色发生于 t=0/17/67ms,同样落在 30–80 窗;因白带同帧已越过文字,该档对比度无低于 3:1 的帧。

## 额外发现(与 AC 分列,未合并)

**X1 [P3·SEO/文案] `/nex/` 三语 `<title>` 含两次品牌名且带句号。** `/nex/` = `NEX — the token that powers NexGrid's compute economy. — NexGrid`;`/vi/nex/` = `NEX — token vận hành nền kinh tế tính toán của NexGrid. — NexGrid`;`/zh/nex/` = `NEX——驱动 NexGrid 算力经济的代币。 — NexGrid`。形态像把 description 当 title 再拼后缀。AC8 只查 `/zh/learn/`,故单列。复现:`rta-ac8.mjs` 输出 `titles`。

**X2 [P3·a11y] 可及名被 CSS 大写化。** Chromium AX 树里 `.dl-btn` 名为 `DOWNLOAD →`、页脚/CTA 同理(`text-transform:uppercase` 进入可及名;Playwright `ariaSnapshot` 用自己的算法给出 `Download →`)。[KNOWN, MED] 部分读屏对全大写单词可能逐字母拼读。不构成 AC5 失败。

**X3 [信息] AC2 关闭菜单后页面 wheel 位移偏小。** `mouse.wheel(0,400)` 等 1.8s 后 scrollY 仅 **200**(触摸上滑 280px 得 465);「可正常滚」已满足,只记录 Lenis 在 isMobile 仿真下的 wheel 倍率现象。

**X4 [信息] AC1 内部张力。** 按 AC 自身模型,出白带时 `.on-light` 关闭发生在白带已离开文字之后(实测 bandTop≈86–88),此后文字下方恒为黑底;而底板 250ms 变暗过程中黑字在 ~117ms 起即 <3:1,与「出白带切换时刻 160–230ms」不能同时满足——要么切换点提前到 ~110ms 以内,要么让 class 在白带顶边仍高于文字(y<52)时就关闭并依赖足够慢的滚速。进白带同理:翻转点在 y≈77–80,慢于 ~520px/s 的滚动必然出现黑字压黑底的帧。请 main 拍板以哪条为准。

## fail 复现步骤

- **AC1-d**:1440×900 打开 `/`,等开场结束;`mouse.wheel` 把 `.x-invert` 顶边从导航底 +350px 推到 −350px(单次 700 = 快;14×50 每 120ms = 慢;35×20 每 150ms = 极慢),rAF 逐帧记 `.site-nav` color、`::before` background-color、`.x-invert` rect;按「白带顶边 ≤ 链接文字中心 y 则底 #f2f2f2 否则 #0c0c0d」合成后算对比度;反向同法。脚本 `rta-ac1.mjs`,直接 `node rta-ac1.mjs`。
- **AC4-b**:1440×900 打开 `/`,等开场结束;先干跑 `wheel(0,12067)` 取 `#learn-entry .row` 终态中心;新页把鼠标移到该点不动,rAF 采样器记 opacity / className / `matches(':hover')` / `getAnimations()`,再 `wheel(0,12067)`;观察 hover 出现后 opacity 过渡时长与到 0.6 的耗时。脚本 `rta-ac4.mjs`(含干跑)/ `rta-ac4b.mjs`(3 次重复 + 对照)。

## 结论

`PASS 6/8`(AC2 / AC3 / AC5 / AC6 / AC7 / AC8 pass;AC1 四子项 a/b/c pass、**d 对比度 fail**;AC4 子项 a pass、**b 进场即 hover 的降透明度沿 0.9s 曲线 fail**)
