# R45 RT-D2 黑盒回归测试报告 — 文章页 / 404 / 图标 / PoC / 页脚 / 字体 / 触达

- 日期:2026-08-26 · tester:r45-rtd2(独立黑盒,只按 AC 实测,不读实现)
- 对象:构建产物 http://localhost:4399/(未起停服务、未 build;仓库只读)
- 工具:Playwright 1.61 Chromium headless(借用 Nexion-uniapp node_modules),DPR 1;滚动用 `mouse.wheel`(Lenis);静态几何 `reducedMotion:'reduce'`;手机 `hasTouch+isMobile`;慢网 CDP `Network.emulateNetworkConditions`
- 脚本:`scratchpad/rtd2-lib.mjs` + `rtd2-ac1…ac12.mjs`,补充探针 `rtd2-ac1b / ac5b / ac6b / ac7b / ac12b / zoom.mjs`;原始数据同名 `.json`
- 单位说明(影响 4 处数字):站点 `.x-canvas { zoom: var(--x-zoom); width:1440px }`,1440 视口下 computed zoom = **0.989583**(画布实宽 1425,1455 视口才 1.0,与滚动条无关——`--hide-scrollbars` 同值)。下表「画布 px」= 视口测量值 ÷ 0.989583;视口原值同列给出,由 lead 决定以哪个口径判。390 / 1024 / 1280 / 1366 无 zoom。

## 逐条 AC

| AC | 结论 | 证据(原始数字) | 脚本 |
|---|---|---|---|
| AC1 文章页目录 | **pass** | 3 语 × 2 视口(1440×900 / 390×844)全部:`nav.toc` `aside.related` 均带 `.x-paper`,computed bg `rgb(242,242,242)` alpha 1,bgImage none;目录 4 行 `.n` = 01/02/03/04,后文均不以「数字.」开头(`restStartsDigitDot=false`,无双编号);`ol[role=list]`;每 `li` 顶线 `1px solid`(1440 下 1.0105px = 设备像素吸附),`li` 宽 = `ol` 宽(625.44/625.44;390:310/310);`ol` 底线 `1px solid`;链接盒高 1440:**43.53 视口 px = 44.00 画布 px**(`min-height:44px`),390:44.00;相关文章 2 条、`isCurrent=false`、href 均以 `/` 结尾(en `/learn/phone-compute/` `/learn/buy-device/`,vi/zh 带前缀);zh 标签「相关教程」(vi「Hướng dẫn liên quan」) | rtd2-ac1 / ac1b |
| AC2 404 页 | **pass** | `/404.html`、`/this-route-does-not-exist/`(HTTP 404)、`/vi/nope/` 三次一致:`main .blk` lang = en / vi / zh;导航语言链 href = `/`(aria-current)、`/vi/`、`/zh/`,全页无含 `404` 的链接;vi 块标题 computed 首项 `"Be Vietnam Pro"`(CDP 平台字体实渲 Be Vietnam Pro 20 字形);zh 块 `.x-mono` 12.5px / 20px(en、vi 块 12px/18px);en 块 h1 首项 `"Funnel Display"`;`<meta name="robots" content="noindex">` 在 | rtd2-ac2 / ac6b |
| AC3 图标 | **pass** | `favicon.svg` 391B,颜色只有 `#0C0C0D` `#9EDC1D`,无 `#DA840A`;`favicon.ico` 722B = 1 entry 32×32 **PNG 封装**(签名 89504E47…),画到 canvas:中心像素 rgb(158,220,29),中心区彩色像素主色 158,220,29(85/108);`apple-touch-icon.png` 180×180 中心 rgb(158,220,29),全图彩色像素 89.6% 为 158,220,29;两者 ±12 判定全 true。`og.png` 1200×630 **只记不判**:主色 rgb(12,12,13) 89.2%、白 2.8%,彩色像素中最多的是 **rgb(218,132,10) = #DA840A**(339 px),其余为暗橙 (56–65,43–49,16) 系 | rtd2-ac3 |
| AC4 PoC 手风琴 | **pass** | 1440×900 `/`,reduce 与 no-preference 两种动效模式各一遍:信任区 `.poc summary` `.mark` left 1373.55 > `.q` right 1361.67;展开后 `p` left 39.58 = `.q` left 39.58(Δ0);FAQ `#faq details.item` `.mark` left 1120.84 > `.q` right 1093.14,`p` left 96.97 = `.q` left(Δ0);hover 后两处 `.q` opacity **0.6**(离开回 1),`summary:hover` 为 true | rtd2-ac4 |
| AC5 页脚护字层 | **pass** | 滚到底(scrollY 13886,atBottom),`.info` 579×103 @ (670,480);护字层 = `.info::before` `rgba(12,12,13,.9)` inset -18/-28px blur(14px)。方法:先截「粒子层隐藏」与「隐藏+文字透明」两张 mask,差分得文字像素;再连截 5 帧(400ms)。**字形核心像素(差分 ≥80% 峰值,2382 px)**:四角 + 中心 + 整块,5 帧全部 `<3:1` 占比 **0%**(最小对比 5.13–5.3:1,均值 6.3);按 ≥50% 阈值(含反锯齿边缘 4057 px)TL 16.85% / TR 4.08% / BL 3.9% / 整块 9.6%,但**无粒子基线同为 17.12/5.1/3.9/9.76%**——差异 <0.3pt,粒子造成的文字像素改变 ≤0.13%(5 帧 0–4 px)。BR 与中心 40×40 区无文字像素(n/a)。文字块内非文字像素亮于底+10 仅 0.43–0.69%;护字层外 60px 环带粒子可见 15.5–15.7%,页脚其它区域亮于底+10 的像素 24.5%,帧间变化 0.74–0.79%(粒子在动)。肉眼(frame2 / infocrop 截图):护字层是**软边矩形**,粒子线在文字块四周约 18–28px 处渐隐,无弧形、无硬边 | rtd2-ac5 / ac5b(截图 rtd2-ac5-frame0..4.png、-infocrop.png) |
| AC6 字体岛 | **fail(1 项)** | `/vi/legal/privacy/` 与 `/zh/legal/privacy/`:h1「Privacy Policy」与 4 个 h2 computed 首项 `"Funnel Display"`(实渲 Funnel Display Light/Medium)✓;`/vi/` h1 首项 `"Be Vietnam Pro"`(实渲 Be Vietnam Pro Medium 37 字形)✓;**✗ `/vi/legal/privacy/ .prevails`(lang=vi)computed = `"Space Mono", ui-monospace, "Cascadia Mono", "PingFang SC", "Microsoft YaHei", monospace`,不含 "Be Vietnam Pro";CDP 实渲 Space Mono 84 字形(越南语字形全部由 Space Mono 覆盖,无回退)** | rtd2-ac6 / ac6b |
| AC7 行内链 | **pass** | `#how .vlink` 盒高 1440:**43.94 视口 px = 44.39 画布 px**;1024:44.39;390:44.39(`padding:13.5px 0; margin-top:-6.6px; display:block`);盒顶上方 2px、水平中点 `elementFromPoint` = `P.x-mono.body`(非 vlink)三视口一致;链接文字单独一行(Range rect 单行 17px,位于句子末行之下:1440 句末行 bottom 434.1 < 链接文字 top 441.2)。附:逐像素扫描见「额外发现 #3」 | rtd2-ac7 / ac7b |
| AC8 手机灯箱 | **pass** | 390×844 hasTouch:tap 第一张证书后 `dialog.cert-zoom` open,URL 不变;dialog 宽 390 = 视口;img `/cert-msb@2x.png` 渲染 1160×1548(≥1100);`scrollWidth 1176 > clientWidth 390`(overflow-x auto);横滚 300 后 img left -292,关闭键盒 left 307.3 ≥0 / right 382 ≤390(sticky 容器),`elementFromPoint` 命中该 button;`.cert-hint` opacity 1(开前/开后);Esc 关闭 ✓;重开后 tap 关闭键关闭 ✓;第二张证书同样 1160 宽可开;0 console error | rtd2-ac8 |
| AC9 vi 慢网标题拍 | **pass** | CDP 1.5Mbps/300ms,各 2 次:`h1.lr-ready` − `html.x-boot` = **/vi/ 631ms、/ 551ms、/vi/ 648ms、/ 553ms**(全在 0.5–1.2s;wall load 7.6–8.4s,fonts.ready 1.46–2.2s);首行 `.lr-inner` translateY 从 87.59 开始变化(起滑)于 1457–1526ms,`.hero .sub` opacity 从 0 开始变化(淡入 `x-fade`)于 2220–2292ms,**4/4 起滑早于淡入** | rtd2-ac9 |
| AC10 指针预置 hover | **pass** | 1440×900 `/`,指针预置在学习中心第 2 行终态位置 (712.5,500),wheel 进场,rAF 逐帧记录:首次行在指针下 → opacity ≤0.62 用时 **117ms**(首次进场,opacity 0.84→0.61,`:hover` 同帧为 true);预先 reveal 过再进场:**185ms**(1→0.606);终态 0.6,指针微移 1px 后仍 0.6 | rtd2-ac10 |
| AC11 归一杂项 | **pass** | `/nex/` 三语 `<title>` 各含 "NexGrid" **1 次**(`NEX — the token that powers NexGrid's compute economy.` / vi / zh);`/learn/` 三语 6 张卡 h2 24px / 26.4px = **1.1**;`/legal/privacy/` 三语 h1 底→`.updated` 顶 **13.84 视口 px = 14.0 画布 px**(`h1 margin-bottom:14px`);首页设备卡价格 `.price` 7 项(Free/$19.9/…)`text-transform: none`,vi「Miễn phí」zh「免费」同;`/nex/` FAQ `.idx` computed width 30px / flex `0 0 30px`(视口 29.69 = 30 画布 px),答案 `p` left = `.q` left(Δ0,三语);`[data-tw]` 三语首页各 35 个,wheel 全页 + 2.5s 后文本与静态 HTML 原文 **35/35 全等** | rtd2-ac11 |
| AC12 全站 console | **pass** | sitemap 33 路由 + `/404.html`(+ `/no-such-page/` 文档本身 404,按 AC 排除),每路由新 context 载入 + 滚到底 + networkidle:`console.error` 0、`pageerror` 0、失败请求 0、4xx/5xx 0(除排除项)、**warning 0 条**(无 preload 未使用之类;另对 / /vi/ /zh/ /learn/getting-started/ /404.html 加载后再等 8s 仍 0 条;preload 的 funnel-display-500 / be-vietnam-pro-500 均在 `document.fonts` loaded 列表) | rtd2-ac12 / ac12b |

### AC6 fail 复现

1. 打开 http://localhost:4399/vi/legal/privacy/(1440×900,任意动效设置)。
2. DevTools 选中 `p.prevails.x-mono[lang="vi"]`(「Bản tiếng Anh của tài liệu này có giá trị pháp lý…」)。
3. Computed → `font-family` = `"Space Mono", ui-monospace, "Cascadia Mono", "PingFang SC", "Microsoft YaHei", monospace`;Rendered Fonts = Space Mono(84 glyphs)。期望:含 "Be Vietnam Pro"。
   附:同页 `.updated`、`/vi/` 的 `.hero .sub`(lang=vi)同样实渲 Space Mono;zh 页 `.prevails` 实渲 Microsoft YaHei(system)。

## 额外发现(不计入 AC)

1. **[P2] 1440 视口下全站按 0.989583 缩放**:`--x-zoom` 在 1440 宽 = (1440−15)/1440,画布实宽 1425。后果:所有「44px 触达」在 1440 视口实测 43.53–43.94 px,`14px` 间距 13.84,`30px` idx 29.69(见 AC1/AC7/AC11)。若 lead 的门以视口 px 计,这 4 处应改判 fail;若以画布 px 计则如上 pass。1455+ 视口 zoom ≥1。headless 无滚动条时也扣 15px(`clientWidth = innerWidth = 1440`),即 mac 覆盖式滚动条用户在 1440 宽下也被缩小。
2. **[P2] `favicon.svg` 公开资产内含中文开发注释**:`<!-- favicon 独立资产:无页面 CSS 上下文,var() 不解析,hex 与 tokens.css --x-bg/--x-accent 同源(verify 门只扫 src/,此处豁免;正式品牌 favicon 由 T11 web-asset-generator 产出替换) -->` 随构建产物对外发布(391B 里 250B 是注释)。
3. **[P2] `#how .vlink` 有效命中高 < 盒高(桌面)**:沿水平中点逐像素 `elementFromPoint`:1440 命中 y 435–471 = **37px**(盒 427.8–471.7),1024 = **38px**,390 = 46px(全盒)。原因:`margin-top:-6.6px` 把链接的 padding 顶部拉进上一行行盒,而句子末行(1440 右端 1374.9)覆盖了链接中点 x,行盒优先命中 `P`;390 句末行短(右端 108)所以全盒可点。AC7 的「盒顶上方 2px 非 vlink」正是靠这 7px 让位达成,但代价是盒内顶部 7px 也不可点。
4. **[记录] `og.png` 彩色主色为 #DA840A**(339px,旧橙色 accent),而 favicon/apple-touch 已换 #9EDC1D;AC3 明示只记不判,列此供 lead 核对是否为遗留。
5. [info] AC5 中心 40×40 与右下 40×40 区域无文字像素(文字块两行免责声明 + 左对齐的两条法务链接,中心落在行间空隙、右下为空),该两区判定为 n/a 而非 pass。
6. [info] 404 页 `<html lang="en">` 对 `/vi/nope/` 亦为 en(静态单页 404,三语块各自 `lang`),符合 AC2,不算问题。

## 结论

**PASS 11/12**(AC6 的 `.prevails` 越南语字体 1 项 fail;其余 11 条含子项全过)。4 处 zoom 相关数字按画布 px 判 pass,视口原值已并列给出,待 lead 定口径。
