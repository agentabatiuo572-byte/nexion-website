# R45 · T8 独立黑盒验收报告 — 元数据 / 内容契约 / 内页体例 / vi 数字

## 环境

- 对象:构建产物 `http://localhost:4399/`(未起停服务、未 build;4321 未触碰);路由集 = `sitemap-0.xml` 33 条。
- 仓库 `D:/WORKS/PLAN/nexgrid-website` 只读(读了 `dist/`、`src/i18n/*.json`、`astro.config.mjs`、`src/styles/tokens.css`、`src/layouts/Base.astro` 作对照);唯一写入 = 本报告。
- 工具:Node 24 fetch + Playwright(借 Nexion-uniapp 的 chromium,headless);视口 1440×900 为主,几何题另跑 1455×900 作 zoom=1 对照(原因见「额外发现 E4」)。
- 脚本(`C:/Users/jason/AppData/Local/Temp/claude/D--WORKS-PLAN/42e4397e-0bc4-4987-8cc3-a0bc8464e0bd/scratchpad/`):`t8-ac1.mjs` `t8-ac2.mjs` `t8-ac3.mjs` `t8-ac3b.mjs` `t8-ac4.mjs` `t8-ac4b.mjs` `t8-ac4c.mjs` `t8-cta-lines.mjs` `t8-ac5.mjs` `t8-zoom.mjs` `t8-zoom2.mjs` `t8-peek.mjs`。
- 脆性处理:几何/样式读取前 `networkidle` + `document.fonts.ready`;颜色/尺寸全部用 computed style,未用截图;静态几何同时跑 `reducedMotion:'reduce'` 与正常动效两套。

## 逐条 AC

| AC | 结论 | 证据(原始数字) | 脚本 |
|---|---|---|---|
| AC1-a canonical / hreflang / og:url 全部 `/` 结尾,canonical ∈ sitemap | **pass** | 33/33 路由:`link[rel=canonical]` 恰 1 条且 == sitemap `<loc>`(33/33 命中);每页 4 条 `hreflang`(en / vi / zh / x-default)共 132 条全部 `/` 结尾;`og:url` 恰 1 条、33/33 `/` 结尾;HTTP 全 200 | t8-ac1.mjs |
| AC1-b 4 条 vi/zh legal 的 `<title>` 以本语言名开头且 `<main lang="en">` | **pass** | `/vi/legal/privacy/` = "Chính sách bảo mật — NexGrid"(vi.json footer.privacy ✓)· `/vi/legal/terms/` = "Điều khoản dịch vụ — NexGrid" ✓ · `/zh/legal/privacy/` = "隐私政策 — NexGrid" ✓ · `/zh/legal/terms/` = "使用条款 — NexGrid" ✓;4 页 `<main class="legal" lang="en">`(en 两页同样 lang="en") | t8-ac1.mjs |
| AC1-c `/nex/` 三语 `<title>` 以 ` — NexGrid` 结尾 | **pass** | en "NEX — the token that powers NexGrid's compute economy. — NexGrid" · vi "NEX — token vận hành nền kinh tế tính toán của NexGrid. — NexGrid" · zh "NEX——驱动 NexGrid 算力经济的代币。 — NexGrid";3/3 `endsWith(' — NexGrid')` = true(体例瑕疵见 E3) | t8-ac1.mjs |
| AC1-d `/learn/` 三语 `<title>` 中 "NexGrid" 只出现一次 | **fail(1/3)** | `/learn/` = "Learn NexGrid" → 1 ✓;`/vi/learn/` = "Học NexGrid" → 1 ✓;**`/zh/learn/` = "学习中心" → 0 ≠ 1**。它也是 33 条路由里唯一 `<title>` 不含品牌词的一条(其余 32 条全含 "NexGrid")。复现:`curl -s http://localhost:4399/zh/learn/ \| grep -o "<title>[^<]*"` → `<title>学习中心` | t8-ac1.mjs |
| AC2 favicon / apple-touch-icon / 404 | **pass** | `GET /favicon.ico` → 200 `image/x-icon` 702 B(魔数 `00 00 01 00` ICO);`GET /apple-touch-icon.png` → 200 `image/png` 3700 B(魔数 `89 50 4E 47`);`GET /nonexistent-page-xyz/` → HTTP **404** `text/html`,正文含 "Page not found" / "Không tìm thấy trang" / "页面不存在"(= en/vi/zh `notfound.title`)三者皆 true,含 `<meta name="robots" content="noindex">`,`<title>` = "Page not found — NexGrid";`dist/404.html` 存在(10770 B)且与服务端 404 正文逐字相同 | t8-ac2.mjs |
| AC3-a 18 篇文章「相关文章」区 | **pass** | 18/18:`aside.related` 各恰 2 条 `a[href]`,全部指向同语言前缀(`/learn/…`、`/vi/learn/…`、`/zh/learn/…`)的**其它** slug(0 条自指、0 条跨语言、slug 全在 6 篇集合内),36 条链接 fetch 全 200(`redirect:'manual'` 下直接 200,无跳转)。注:href 无尾斜杠(`/learn/phone-compute`),与 AC1 的 canonical 体例不一致 → 见 E1 | t8-ac3.mjs / t8-ac3b.mjs |
| AC3-b 目录 `nav.toc` 锚点全部有对应 id | **pass** | 18/18 存在 `nav.toc`,每页 3–4 条(合计 66 条),`document.getElementById(decodeURIComponent(hash))` 全部命中(含 vi/zh 非 ASCII id 如 `#1-chọn-mẫu`、`#看懂主界面`) | t8-ac3.mjs |
| AC3-c `/learn/` 三语 `main` 内 `.xbtn` 下载 CTA | **pass** | `main .xbtn` 各 1 个:`/learn/` href `/#download` "Get the app →";`/vi/learn/` href `/vi/#download` "Tải ứng dụng →";`/zh/learn/` href `/zh/#download` "下载 App →"(可及名重复问题见 E2) | t8-ac3.mjs |
| AC4-a `#x-bg` 关键帧起点 `scale(1.05)` | **pass** | 产物 CSS(`Base.WTpekMCF.css`):`@keyframes x-zoom-fade{0%{opacity:0;transform:scale(1.05)}}`,`html.js #x-bg{animation:1s cubic-bezier(.22,1,.36,1) both x-zoom-fade}`;运行时 `getAnimations()`:name `x-zoom-fade`,playState running,keyframes `[offset 0: transform scale(1.05), opacity 0] → [offset 1: transform none, opacity 1]` | t8-ac4.mjs / t8-ac4b.mjs |
| AC4-b `/vi/` `#final-cta h2` 单行、无 24ch 上限 | **pass** | reducedMotion 下(纯文本):Range `getClientRects()` = 1 个、行 top 1 个;正常动效下 h2 被拆为 `.x-sr`(1×1 sr 副本)+ `.lr-line[aria-hidden]` 可见副本,对可见副本 Range 38 个 rect 按纵向重叠聚类 = **1 行**,inline-block 词 span 的 top 只有 1 个,h2 盒高 39.58px = 1 × line-height 40px(1455 视口下 40.00);computed `max-width: none`;dist 三份 CSS 中 "24ch" 0 处。(/ 与 /zh/ 同法亦 1 行) | t8-ac4.mjs / t8-cta-lines.mjs |
| AC4-c legal h1 / `.updated` / `.prevails` / 标题行高比 | **pass** | `/legal/privacy/` h1 class `x-display`,font-size **88px**,font-weight **400**,line-height 88px(盒高 87.08 @1440 = 88×0.98958 画布 zoom;88.00 @1455);`.updated` class "updated x-mono",font-size 12px,line-height **14.4px**;`/vi/legal/privacy/` `.prevails` class "prevails x-mono" line-height **14.4px**(`.updated` 同 14.4px)。行高/字号比:`/nex/ .block h2` 5 个 32/35.2 = 1.10;`.mcard h3` 2 个 24/26.4 = 1.10;`.list b` 9 个 20/22 = 1.10;`/learn/getting-started/ .prose h2` 4 个 24/26.4 = 1.10;`/legal/privacy/ h2` 7 个 24/26.4 = 1.10 → 全部 ≤ 1.15 | t8-ac4.mjs / t8-ac4c.mjs |
| AC4-d `/nex/` FAQ 与首页 FAQ 逐项相同;`#trust .poc` 边框 | **pass** | `/nex/ .faq .q`:font-weight 400,letter-spacing −0.48px @ 24px = **−0.02em**,line-height 30px;`.faq .idx` color **rgba(12, 12, 13, 0.8)**;`.faq .mark` color **rgb(72, 100, 5)**;summary computed min-height **60px**(盒高 59.375 @1440 = 60×0.98958;**60.000 @1455**,4/4)。首页 `#faq .item .q` 400 / −0.48px@24px / 30px,`.idx` rgba(12, 12, 13, 0.8),`.mark` rgb(72, 100, 5),summary min-height 60px(59.375 @1440 / 60.000 @1455,6/6)→ 逐项相同。`#trust .poc`(`<details>`,1 个):border-top / border-bottom 计算值 1.01053px solid @1440(= zoom 0.98958 下 1px 吸附到 1 设备像素后回算;**@1455 恰 1px / 1px**),border-left / border-right 0px none;summary min-height 60px | t8-ac4.mjs / t8-ac4b.mjs / t8-ac4c.mjs |
| AC5-a `/vi/` 数字千分位 `.`、小数 `,` | **pass** | 计数动画收敛后 `#stats .num`:`28.432` · `4.812` · `156` · `47` · `99,7%`;`#social h2` = "28.432+ thiết bị đang tạo thu nhập tại 47 quốc gia";`.mult b` 7 值 = 1× 3× 117× 217× 233× 750× **1.250×** | t8-ac5.mjs |
| AC5-b `/` 与 `/zh/` 仍是 `,` | **pass** | `/`:28,432 · 4,812 · 99.7% · "28,432+ devices earning across 47 countries" · 1,250×;`/zh/`:28,432 · 4,812 · 99.7% · "28,432+ 台设备 正在 47 个国家产生收益" · 1,250× | t8-ac5.mjs |
| AC5-c `.price` 三语 `$1,199` | **pass** | 三语 `.price` 7 值完全一致:Free/Miễn phí/免费 · $19.9 · $649 · **$1,199** · $1,319 · $4,499 · $7,499 | t8-ac5.mjs |
| AC5-d en/vi/zh json key 树全等 | **pass** | 递归展开(叶子含类型、数组含长度)各 **185** 条;en↔vi、en↔zh、vi↔zh 三对差集全部为空 | t8-ac5.mjs |

## 额外发现(不计入 AC 判分,分开列)

- **E1 · P2 · 全站内链无尾斜杠,与 canonical 体例相反。** 33 条路由的 `<a href>` 里 30 个不同站内地址(`/learn` `/nex` `/legal/privacy` `/legal/terms` `/learn/<slug>` 及 vi/zh 前缀版)合计 312 处全部不带 `/`,而 canonical / hreflang / og:url / sitemap 全带 `/`。`astro.config.mjs` 未设 `trailingSlash`(默认 ignore),所以 4399 两种写法都直接 200、无跳转;上线到会规范化尾斜杠的托管(Cloudflare Pages / Netlify 等)时每次内链点击多一跳 301/308,并向用户/爬虫暴露非 canonical URL。复现:`curl -s http://localhost:4399/ \| grep -o 'href="/[^"]*"' \| sort -u`。建议:链接生成处统一补 `/`,或 `trailingSlash:'always'` 让构建期报错兜底。
- **E2 · P2(a11y)· `.xbtn` 可及名重复。** `/learn/` 的 `main .xbtn` 由 `xbtn-ghost` / `xbtn-a` / `xbtn-b` 三个同文案 span 组成,均无 `aria-hidden`;Playwright aria snapshot 得到 `link "Get the app → Get the app →"`(ghost 因不可见被排除,a/b 两份都进可及名),读屏会念两遍。该结构是 `.xbtn` 组件级(导航 `dl-btn` 同构),非单页问题。
- **E3 · P3 · `/nex/` 标题是「句子。 — NexGrid」体例。** en "NEX — the token that powers NexGrid's compute economy. — NexGrid"(两个破折号 + 句号后接后缀),zh "NEX——驱动 NexGrid 算力经济的代币。 — NexGrid"。满足 AC1-c 的后缀判据,但作为 `<title>` 读感偏描述句。
- **E4 · 信息 · 1440 视口下画布 zoom = 0.98958,不是 1。** `html{scrollbar-gutter:stable}` 预留 15px 经典滚动条槽,`--x-vw` 取 html 布局宽 = 1425px,`--x-zoom = 1425/1440`(`.x-canvas` computed zoom 0.989583;`--hide-scrollbars` 也一样,因为槽仍预留)。因此 1440 宽下「画布 px = 屏幕 px」的前提只在 1455 视口(或 overlay 滚动条系统)成立。这是 R45 注释里写明的设计(`tokens.css:73-77`、`Base.astro:79-88`),不是缺陷;本报告 AC4 的 88 / 60 / 1px 均按画布 px(computed style)判定,并附 1455 视口实测原值。
- **E5 · 信息(给后续 tester)· 正常动效下 `#final-cta h2` 不能直接对 h2 做 Range 数行。** h2 内含 1×1 的 `.x-sr` 读屏副本 + `aria-hidden` 的逐词 inline-block 动画副本,朴素 `Range(h2).getClientRects()` 得 22 个 rect / 4 个 top,是两份副本 + 行内空格 span 的假象;应对可见副本 `.lr-inner` 聚类或在 reducedMotion 下测(两法均得 1 行)。

## 结论

AC1 因 `/zh/learn/` 标题 "学习中心" 不含 "NexGrid"(0 次 ≠ 1 次)判 fail;其余四条全部 pass。

**PASS 4/5**
