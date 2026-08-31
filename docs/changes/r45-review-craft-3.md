# R45 · 视觉评审 craft-3(排版与工艺:尺子一致性 / 节奏 / 对齐 / 细节收口)

评审对象:`http://localhost:4399/`(构建产物,2026-08-26)。视口 1455×900(画布 zoom 1)为主,另探 1935×1080(zoom 1.333)与 390×844(isMobile)。范围:`/`、`/vi/`、`/zh/`、`/learn/`、`/learn/getting-started/`、`/nex/`、`/legal/privacy/`、`/legal/terms/`(vi)、`/404.html` 及其 vi/zh 版。

## 方法

- 读尺子:`src/styles/tokens.css` + 全部组件 `<style>`(只读),先列出「同角色应同尺」的期望,再拿运行时反证。
- 静态几何:Playwright(借 Nexion-uniapp 依赖)`reducedMotion:'reduce'`,`document.fonts.ready` 后逐页抓 ~130 个选择器的计算样式(字族/字号/字重/字距/行高/颜色/内外距/边线)+ 文档坐标盒子,三档宽各一份(`rev2c-measure.mjs` → `rev2c-m-{1455,1935,390}.json`,`rev2c-print.mjs` 打表)。
- 截图:暗区正常 canvas;亮区一律「废 canvas」配方(`addInitScript` 令 `#x-bg` `getContext` 返回 null)并逐张回看确认为亮底(`rev2c-shots.mjs`,46 张);局部 2x/3x 裁切核边缘与墨迹。
- 补充探针(`rev2c-probe*.mjs` / `rev2c-clamp.mjs`):CDP `CSS.getPlatformFontsForNode` 查实际落字体;learn 卡标题 clamp 有/无 同元素逐像素比对(DPR3);normal vs reduce 终态几何差;导航底板三态计算值;三档宽 ×10 路由横向溢出;列组内插画/按钮 y 对齐;手风琴开态;行遮罩/打字机动画中帧;灯箱与手机菜单几何;390 断点各角色字号地板。
- 脚本与截图:`C:/Users/jason/AppData/Local/Temp/claude/D--WORKS-PLAN/42e4397e-0bc4-4987-8cc3-a0bc8464e0bd/scratchpad/`(`rev2c-*.mjs`、`shots/`)。

## 逐区观察(1455 为准,标注差异处)

| 区 | 观察 |
|---|---|
| 导航 | 条高 74.8(30 顶衬 + 44 行;logo 28/1.6 继承 body 行高得 44.8,非整数,肉眼不见)。底板三态实测:暗 rgb(12,12,13)@.64 / 白带 rgb(242,242,242)@.72 且文字翻黑 / 内页 .9;blur(14px) saturate(1.15)。暗区底板下缘在亮流光处是一条硬切边(待拍板项)。内页 .9 下纸面板区仍呈 ~#222 灰带、板缘处软边(已拍板值,只记不扣)。链接 12/400/0/1.2,`.links a` 命中 ±6 内衬;右缘 1400 与画布对齐;1935 下 nav 与画布左缘 0/0、宽 1920/1920。 |
| 首屏 | h1 100.8/500/-0.04em/0.79 两行;副题 16 mono 439 宽;下载键 44;左列 hint 44 + note 50ch;簇底 680 = 900-220 ✓ 左右两列底线齐。行遮罩终态与 reduce 零位移;650ms 中帧遮罩窗在行盒下方 .24em,降部不切。vi 三行 0.79 叠音符擦行(待拍板)。 |
| 数字条 | 5 列 24 间距、左线 0.08、idx→num→label 8/8 阶梯,tabular 54/500。zh 的 idx 走 12.5/1.6 → 数字比 en 低 5.6px(见扣分 #5)。 |
| 网络规模 | 725 列右缘 1400;刻度 2×20.16 + 16 mono 眉;54 档两行;roles 16/1.5 dim。 |
| 使命 | 538 列;54 档单行越列(拍板);正文 16/1.2 两句 gap 8.8;`[` 竖标 5px 三边 1px 渐变,与 6 行 245.6 高等高 ✓;24/500/-0.01em/1.15 名词(待拍板字距)。 |
| 设备卡 | 520×427.2 = 650/534 ✓;序号章 5ch+20 内衬 = 68.95 ✓;h3 40/400/-0.03em/1.0;price 20/500/0(20 档与 nex list b 的 -0.01em 不同尺,#12);zh 价格行盒 32 vs en 24(#5)。 |
| How | 眉 16 与 40 档陈述基线对齐 ✓;三列 413 宽、左线 0.23、pl20、metarow→stack 82、stack 内 24;h3 54 两行、art 393/237、body 12/1.45;行内链独立成行:上借 6.6 → 链行比正常行距多 6.9px,读作一行动作句,可接受。vi/zh 第三列标题行数不同 → 插画错行(#2)。 |
| 参与路径 | 双列 650、同尺同阶梯;desc 420 两行;note 48 上距。vi 卡 1 标题两行 → 插画/按钮错 54(#2)。 |
| 信任 + PoC | 证书对 330 居中(拍板);五卡 4+1(拍板);卡文 12/1.45 八行全大写(拍板)。PoC 细线行式:问 24/400/-0.02em/1.25、min-h 60、`+/−` 右置、答案左缘 = 问题左缘 ✓、答案 760 宽 = FAQ ✓;答案底距 16 vs FAQ 20(#7)。 |
| NEX 三卡 / 学习入口 / FAQ | 三卡 idx→stack 82 与 How 同阶梯 ✓;学习入口行 28/0 内衬、基线对齐(idx 12 / topic 12 / name 32 / → 12)✓;FAQ 六条 61 行、Q 列 30 + gap 28 = 答案缩进 58 ✓;开态 `−` 走 ::after 且答案与问句左缘同为 98 ✓。FAQ 右缘 1140 vs PoC 1400(拍板)。 |
| 收尾 / 页脚 | 收尾 140 内衬 40 档单行(24ch 上限已去)✓;页脚 660 高、字标 120/0.79、信息列 584.6、版权钉底 30 ✓;护字层矩形边界在亮流光上可辨(#3)。 |
| /learn | 88 档 H1、副题 520 宽;4 列 322 网格 6 卡 = 4+2(#11);卡 22 内衬、row1→h2→p 12/12;h2 24/500/-0.02em/1.1 **clamp 2 行裁墨迹**(#1);vi 网格标题行数不一 → 说明错行(#2)。 |
| /learn 文章 | back 44 → h1 54 两行 → meta(h1 下距 12,法务/nex 为 14,#7)→ 目录纸面板(24/34 内衬、标签→列表 10、行 44 + 行线 0.23 全宽、底线收口 ✓、编号去双序 ✓)→ 正文纸面板(34 内衬、h2 24/500/1.1、p 12/1.85、引用 2px 柠檬左线)→ 相关文章纸面板(行 60.6、topic 150 + gap 20、name 24/400/1.15,基线对齐 ✓、`→` 右置 ✓)→ CTA 40。板间距 24/24 一致 ✓。新块与首页学习入口同一家(细线行式、0.23 线、编号/主题/箭头语法),仅行高 1.15 与内衬 10/12 未取齐(#7)。 |
| /nex | tag 12 柠檬 → h1 54 三行(22ch)→ lead 560;五块纸面板 30 内衬(learn/legal 为 34,#7)、块题 32/500/1.1 上有 0.23 规则线;表头 x-label 柠檬、行线 0.1;列表 36/220/1fr 基线对齐 ✓(标题列 220 折行,#8);mcard 0.1 边框;FAQ 与首页同尺(桌面)✓、答案 680 宽、行线 0.1(首页 0.23,#7)。390 下对比表第三列整列出框(#6)。 |
| 法务 | 88 档 H1 → meta 14 → 纸面板 34;h2 24/500/1.1 间距 30/10(文章 34/12,#7);p 12/1.85;vi/zh 页 `.prevails` 提示框 + `<main lang=en>` 英文岛正确落 Funnel/Space Mono ✓。 |
| 404 | 三语块 gap 56、块内 16 阶梯、54 档标题 + 12/1.5 正文 + 44 键,与 /nex 头部同体例 ✓;en 实心键、vi/zh 描边键;vi 块落 Be Vietnam Pro ✓;zh 块标题落 **Microsoft YaHei UI**(站内 zh 标题为 Microsoft YaHei,#9)。 |
| 灯箱 / 手机菜单 | 灯箱 760 宽居中、关闭行 sticky 72 高、按钮 44 走纸面描边样式、图 728 宽可读、内滚 1060/846 ✓;390 菜单 44/500 展示体、语言行、48 高下载键 ✓。零横向溢出(3 档 × 10 路由)。 |

## 扣分清单

| # | 严重度 | 类型 | 扣分点 | 证据 | 修法(参数级) |
|---|---|---|---|---|---|
| 1 | P1 | **新增缺陷** | `/learn` 卡标题 `-webkit-line-clamp:2`(自带 overflow:hidden)叠加本轮改的 1.1 行高,**裁掉墨迹**:en 六卡中五卡第二行降部(compute 的 p、activating / withdrawing / earnings / converting 的 g)被削 ~1px;vi 单行卡「Bắt đầu trong 90 giây」「Staking và quy đổi NEX」的叠音符顶部(ắ / ổ)被削、「Bật năng lực điện thoại」的下点(ậ ự ệ ạ)被削;zh 0 处 | `scrollHeight` 28 vs `clientHeight` 26.4(单行)/ 54 vs 52.8(双行);同元素 clamp 有/无 逐像素比对(DPR3,`rev2c-clamp.mjs`):en 卡 2–6 差异集中在盒底外 0–1.3px(行 188–191/216),vi 卡 1 差异在盒顶(行 26–28)+ 盒底(110),卡 6 行 28–30 + 109–112;zh 全 0 | `.learn .card h2{padding-block:.15em;margin-block:-.15em}`(裁切窗留墨迹余量、版面零变化;同 `.lr-line` 手法),或直接去掉 clamp(六个标题人工可控 ≤2 行) |
| 2 | P2 | 既有缺陷(不对齐) | 三列 / 双列卡组内,插画、说明、按钮随标题行数漂移,同一行的插画不在一条线上。en 恰好各列同行数所以齐,vi/zh 全露 | @1455 文档 y:vi How 第三列 h3 3 行(162)→ art 7375 vs 其它两列 7321(+54);vi Path 卡 1 h3 两行 → art 8235.8 vs 8181.8、按钮 8715 vs 8661;zh How 第三列 h3 两行 → art 7257.7 vs 7195.6(+62);zh Path 按钮 8539 vs 8519(说明 2 行 vs 1 行);vi `/learn` 第一行卡 1–2 标题 1 行、卡 3–4 两行 → 说明 y 403.6 vs 430,第二行 632 vs 606(`rev2c-probe2.json` align/learnAlign) | 卡内改 grid 并让父栅格跨卡对齐:`.step/.card{display:grid;grid-template-rows:subgrid;grid-row:span 4}`(Chromium 117+ / Safari 16+ 可用);兜底:标题 `min-height:2lh`(vi How 第三列需允许 3lh 或缩短 vi 文案,后者归主人) |
| 3 | P2 | **新增缺陷**(参数) | 页脚护字层读作一块贴上去的暗板:`.info::before` inset -18/-28、`rgba(12,12,13,.9)`、`filter:blur(14px)`——0.9 实底只有 14px 羽化,在亮流光上边界清晰;板按 584 列宽铺满而不随文字(zh 披露只一行,板仍满宽) | `shots/dark-2x-footer-info.png`:左缘 x≈662 处流光被齐齐切断,上缘紧贴字标下方一条切线;`dark-1935-footer.png` 同现(x≈880–1720);`dark-1455-zh-footer.png` 文字右侧 90px 空板仍压暗粒子 | `filter:blur(36px)`(或 `mask-image:linear-gradient` 四向 48px 羽化)+ α .9→.78;`.info{width:fit-content}`;若仍见板,改为文字自身光晕(`text-shadow:0 0 22px var(--x-bg),0 0 8px var(--x-bg)`,无矩形) |
| 4 | P2 | 既有 + 本轮归一未收干净 | 断点以下显示档位坍缩:桌面 4 档(88/54/40/24)在 390 变成 12 个数——54 档→30(文章 H1)/32(首页)/34(/nex、404);40 档→24(设备卡 h3)/28(陈述、NEX 三卡、收尾);24 档→16(nex list b、**/nex FAQ 问句**)/17(mcard h3)/18(**首页 FAQ**、PoC、related、法务 h2)/19(learn 卡、prose h2)/20(学习入口)/21(使命名词);32 档 nex 块题→22。「/nex FAQ 与首页 FAQ 同规格」只在 ≥~1060px 成立(`clamp(16px,1.7vw,24)` vs `max(18px,24u)`) | 390 isMobile 实测(`rev2c-probe3.mjs`):`nex faq q 16px` vs `faq q 18px`;`article h1 30` / `mission state 32` / `nex h1 34`;`devices h3 24` / `statements 28` | `tokens.css` 立每档地板单源:`--x-fs-88:max(40px,88u)`、`--x-fs-54:max(32px,54u)`、`--x-fs-40:max(28px,40u)`、`--x-fs-32:max(22px,32u)`、`--x-fs-24:max(18px,24u)`、`--x-fs-20:max(17px,20u)`,组件只消费不得私写 clamp 下限;与 canvas-hazard 同门加「组件内禁写 clamp(…px,…vw,…)」哨兵 |
| 5 | P2 | 既有缺陷(本轮修一处漏同族) | zh 12 档小字两把尺 + ASCII 记号反向吃 CJK 豁免:`.x-label` 无 zh 覆写(12/1.2)、`.x-mono` 有(12.5/1.6)→ 同块并置两尺;而纯 ASCII 的编号/记号在 zh 全走 12.5/1.6——本轮只给 `.serial` 解了绑 | zh 并置:数字条标签「在线设备」12 vs「数据截至」12.5;目录标签「本文目录」12 vs 目录行 12.5;nex th 12 vs td 12.5。ASCII 吃豁免:`.stats .idx`「01」、FAQ「Q1」、`+/−`、`→`、`.toc .n`、`.chip`、learn-entry / trust / nex-teaser `.idx`、`.devices .price`(继承 1.6:行盒 32 vs en 24,卡文块 132 vs 118.4 → 图区少 13.6px)。可见后果:zh 数字条数字比 en 低 5.6px、信任卡编号→正文距 +5.6 | `tokens.css`:`.x-mono.x-num:lang(zh):not(html){font-size:calc(12*var(--uc));line-height:1.2}` 并把 `.x-num` 挂到上述记号(或 `.x-mono:lang(zh):not(html):not(.x-num)` 反向排除);`.x-label:lang(zh):not(html){font-size:calc(12.5*var(--uc))}`(单行标签行高保 1.2);`.devices .price{line-height:1.2}` |
| 6 | P2 | 既有(手机) | `/nex` 对比表在 390 被裁:`table{min-width:520}` 在 314 宽面板内溢出 206px,第三列「NEX」(x 356–558)整列落在面板右缘(352)之外,无滚动提示 | `rev2c-probe3.mjs` nexTable:wrapClientW 314 / tableW 520 / overflow 206;`shots/light-390-nex-top.png` 只见 PROPERTY / USDT 两列 | ≤640:去 `min-width` 让 12px 等宽自然折行(三列各 ~100px 可容),或改「属性行 + 两值堆叠」;至少 `.table-wrap` 右缘加 24px 渐隐提示 |
| 7 | P3 | 既有值口味(内页体例残差,B7 归一未收干净) | 同角色不同尺:文章 H1→meta 12 vs 法务 / nex 14;法务 h2 间距 30/10 vs 文章 34/12;纸面板内衬 nex 30 vs learn / legal 34;纸面板内行线 nex `--x-line-soft`(0.1)vs 目录 / 相关 / 首页白带 0.23;nex 列表编号列 36 vs 全站 30;相关文章 `.name` 行高 1.15(其模板学习入口 1.1、同尺 learn 卡 1.1);目录标签→列表 10 vs 相关 12;PoC 答案底距 16 vs FAQ 20 | 计算样式表 `rev2c-m-1455.json`(`.article h1` m10/0/12、`.legal h1` m0/0/14;`.sheet h2` m30/0/10、`.prose h2` m34/0/12;`.nex-page .block` p30、`.prose` p34;`.nex-page .faq` bb 0.1 vs `.faq-sec .item` bt 0.23;`.list li` 36px 列;`.related .name` 1.15;`.toc` gap 10、`.related` gap 12;`.poc p` mb16、`.faq-sec .item p` mb20) | 逐项取齐:14 / 34-12 / 34 / 0.23 / 30 / 1.1 / 12 / 20 |
| 8 | P3 | 既有 | nex 列表标题列 `minmax(140,220)`:4 条里 2 条折两行(Device compute / output、Check-ins & welcome / gift),右侧说明列 756px 只用一行 → 行高 73/51 交替 | `shots/light-1455-nex-list.png`;`.list b` h 44 vs 22 | 220→300 |
| 9 | P3 | **新增**(语言尺迁移副作用) | 404 页 zh 块标题落到 **Microsoft YaHei UI**,zh 站所有 CJK 标题是 **Microsoft YaHei**;同块正文(mono 栈显式含 YaHei)仍是 YaHei → 一块两张 CJK 脸。根因:`:lang(en)` 规则把 html 的 `--x-font-display` 换成不含 CJK 回退的短栈,zh 子块继承后靠系统按语种回退 | CDP `CSS.getPlatformFontsForNode`:`404 zh title → Microsoft YaHei UI:5`;`404 zh body → Microsoft YaHei:14`;`zh hero h1 → Funnel Display* + Microsoft YaHei` | `tokens.css` 加 `:lang(zh){--x-font-display:'Funnel Display','PingFang SC','Hiragino Sans GB','Microsoft YaHei',system-ui,sans-serif}`(或 `:lang(en)` 栈补回 CJK 回退) |
| 10 | P3 | 既有(手机) | 首屏 `.note`(0.62 墨 12px 脚注)在 ≤860 排到 H1 之上成了「眉标」;桌面焊定的 `\n` 在手机产生两词孤行(en「COMPUTING SERVICES」、vi「NĂNG CAO」) | `shots/dark-390-hero.png`、`light-390-vi-hero.png`;390 `.hero .note` y276 < h1 y362 | `.left{order:1}`;≤860 `.note{white-space:normal}` |
| 11 | P3 | 既有口味 | `/learn` 六卡在 4 列栅格里 4+2,第二行半空(1440–1920 同) | `grid-template-columns: 322px ×4`;`shots/light-1455-learn-top.png` | `minmax(340px,1fr)` → 3+3 |
| 12 | P3 | 既有 | 20 档两把字距:设备卡 `.price` 20/500/**0** vs nex `.list b` 20/500/**-0.01em** | 计算样式表 | 统一 -0.01em(可与 24 档待拍板项一并定) |

合计扣 2.2:#1 0.4 · #2 0.4 · #3 0.3 · #4 0.3 · #5 0.3 · #6 0.15 · #7 0.15 · #8–#12 各 0.05。

## 已排除(拍板 / 待拍板 / 非页面)

- 首屏标题字号与文案;右簇三条左缘不齐(h1 507 / 副题 961 / 键 828,右对齐 1400)= 参考站构图,保持。
- 窄屏不做第二套画布(390 汉堡菜单、竖排静态列、堆叠键实测正常)。
- 信任五卡 4+1;FAQ 右缘 1100(FAQ「+」x 1133 vs PoC「+」x 1388 两条右缘);正文行长全大写;页脚空档。
- 排印档位数 9 display / 2 mono;导航小字 12px 下限与条高;画布 zoom(1935 实测导航与画布左缘 0/0、宽 1920/1920,三档 × 10 路由零横向溢出;1px 线在 zoom 1.333 下被 Chromium 钉到 1 设备像素,反而更利)。
- 导航底板半透明磨砂:暗 .64 / 白带 .72 + 文字瞬切 / 内页 .9 全部实测符合;内页 .9 下纸面板在底板里仍呈一段 ~#222 灰带、板缘软边(`shots/light-2x-nav-inner.png`)——已拍板值,只记不扣;主人若在意可 .95。
- 页脚透底 + 护字层机制本身(仅参数执行扣分,见 #3)。
- 首屏底空 220;编号强调色(含白带内 How / Path / NEX 卡编号深柠檬 vs 信任卡 / 学习行 / FAQ 编号 0.8 墨的分法);卡片淡入 / 视差(terminal 几何差全部是视差位移,非缺陷);陈述区结构;灯箱原尺寸(实测 760 / 728 / sticky 72 / 键 44,纸面描边样式与白带一致)。
- mono 段落四把行高(1.2 / 1.45 / 1.5 / 1.85);mono 负字距(时钟 / 滚动提示 / 版权 -0.03em、序号章 -0.022em);证书对居中 vs 四列栅格;learn 卡 hover 0.92。
- 待拍板既有值:导航文字内衬 30/0 与底板下缘加线(磨砂下缘在亮流光处为硬切边,`shots/dark-2x-nav-hero.png`);当前语言下划线位置(命中盒底边,距字 ~16px);vi Mega 0.79(390 / 1440 实测叠音符擦上一行);首屏标题拍 500ms;zh display 尺只覆盖 `.x-display`;24 档 -0.01em 两处(mission `.name` / nex `.mcard h3`)。
- 资产级:MSB 证书扫描件左缘自带 ~12px 黑边(缩略与灯箱皆见),属素材非页面。
- zh 卡文全角括号行首不挤压(信任卡 01/05「（COLORADOSOS.GOV）」「（WWW.FINCEN.GOV/…」行首悬空)——CJK 标点细节,`text-spacing-trim` 支持面未稳,只记不扣。
- 本轮改动核对为 OK 的项:行遮罩终态零位移(首屏 / 陈述 / 使命 reduce vs normal 盒子 delta 0)、中帧无降部裁切;打字机终态还原纯文本;首屏簇底线对齐;法务 88 档 + meta 14;子页小标题 1.1;目录去双编号 / 行 44 / 行线全宽收口;PoC 记号在右且答案左缘 = 问题左缘;/nex FAQ 桌面与首页同尺同列几何;下载键 12px;时钟无多余空格;vi 千分位 28.432 / 99,7% / 1.250×;语言链 / 学习行 hover 可用。

## 总分

**7.8 / 10** —— 1440 英文桌面已是 9 分级的尺子与节奏,但同一角色在 vi / zh 与手机上被拆成多把尺(档位地板、CJK 豁免、列组错行),加上本轮自己加的两处执行没收干净(learn 卡标题裁切窗、页脚护字层边界),工艺离「一把尺量到底」还差一轮。
