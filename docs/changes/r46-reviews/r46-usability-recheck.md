# R46 多端可用性 —— 声称已修项复核

**版本锚已核对上**:`dist/index.html` = 13:46:17 · `dist/_astro/Base.DjTe9L54.css`(线上 `curl` 拉到的也是这个 hash)· 提交 `bd02dc5`。服务 `http://localhost:4399`,只打产物。

---

## 逐条结论

| # | 原编号 | 结论 |
|---|---|---|
| 1 | P0-2 `[data-rv]` 无兜底 | **已修**(两个方向都验过) |
| 2 | P1-3 三键不在 Tab 序 | **半修** —— 可达性修好了,但引出两个新缺陷(N1 / N2) |
| 3 | P1-4 H1 空白 3s | **已修**(实测 1.2s 档) |
| 4 | P2-7 跳至正文 39px | **已修**(三语全 44) |
| 5 | P2-9 语言键缺 lang/hreflang | **已修**(34/34 页全覆盖) |
| 6 | P2-16 `#download` 被导航压住 | **未修** —— 落点数值一分没变;但实测对用户无影响,建议直接结掉或改 id 位置 |

---

### 1. P0-2 `[data-rv]` 兜底 —— 已修

**改动确认(产物级)**
`Base.DjTe9L54.css`:`html.js:not(.fx) [data-rv]:not(.in){animation:0s linear 3s forwards x-rv-unhide}`,`@keyframes x-rv-unhide{to{opacity:1;transform:none}}`。
关键点对了:`[data-rv]` 是靠 `--rv-o:0`(opacity)藏的,兜底动画打的也是 `opacity`——不是照抄 `x-unhide` 的 `visibility`(那样会是空操作)。
`src/scripts/fx.ts:22` 模块最顶上 `document.documentElement.classList.add('fx')`;`fx.ts:759 initReveal()` 里 `if (performance.now() - BEAT_T0 > 3000) { 全部加 'in','rv-done'; return; }`,`BEAT_T0 = Math.min(BOOT_T0, PAINT_T0)`(锚在首绘,和 CSS 动画起点同钟)。

**方向 A —— 阻断 bundle,内容必须出来**(390×844,abort `**/_astro/*.js`)

| 时刻 | 结果 |
|---|---|
| t=1.5s | `hidden=35/35`(还在 3s 窗口内,符合预期) |
| t=3.7s | `hidden=0/35`,`belowFold=33` 全部 `belowFoldFullyShown=33` |
| t=7.7s | `hidden=0/35`(不回退) |
| `/nex/` t=4.2s | `hidden=0/14`,**`h1 opacity=1`**(上一轮这里是整页空白) |

**方向 B —— 引擎正常,折叠线以下不许被提前放掉**(390×844,正常加载,停在 `scrollY=0`)

| 时刻 | 结果 |
|---|---|
| t=1.5s | `htmlClass="js x-boot fx lenis"` · `hidden=35/35` · `belowFoldFullyShown=0` |
| t=4.0s | `hidden=35/35` · `belowFoldFullyShown=0`(**兜底没漏,`:not(.fx)` 生效**) |
| t=7.0s | 同上 |
| 全页滚一遍 | `fullyInViewButHidden_samples=0` —— 正常进场没被破坏 |

**方向 C(我加的,派单没点名)—— 引擎比兜底还晚到,不许闪回隐藏**(JS 延迟 5s)

| 时刻 | 结果 |
|---|---|
| t=4.0s(兜底已放,引擎没到) | `hidden=0/35` · `cls="js x-boot"` |
| t=6.0s(引擎刚落地) | `hidden=0/35` · `cls="js x-boot fx lenis"` —— **没有闪回** |
| t=7.5s / t=10s | `hidden=0/35` |

`.fx` 一挂上,那条兜底规则连同它的 `forwards` 填充值一起失效,理论上会掉回 `--rv-o:0`;`initReveal` 的 `>3000` 早返回在同一拍把 `in`/`rv-done` 补上,接住了。这条路径是对的,但两个 3000 是**两处硬编码**(`tokens.css` 的动画延迟 + `fx.ts:764` 的阈值),源码注释也写了「改一处必须改另一处」——目前靠注释约束,没有机器门。建议后续把 3000 提成一个共享常量或加一条静态门,否则改一处漏一处就会重新出现闪烁。

---

### 2. P1-3 三颗下载键不在 Tab 序 —— 半修

**可达性:修好了。** `dist/index.html` / `vi` / `zh` 各 6 个 `aria-disabled="true" tabindex="0"`,6/6 覆盖。

实测 Tab 序:

- 390×844:`0 a.x-skip` → `1 a.logo` → `2 button.menu-toggle` → **`3/4/5` 三颗 span(223×44)** → `6 a.xbtn "GET THE APP TO START"`
- 1440×900:`…10 a.xbtn "DOWNLOAD"` → `11 a.scroll-hint` → **`12/13/14` 三颗 span(191/221/130 × 44)** → `15 a.xbtn`

无焦点陷阱(继续 Tab 正常流向 `GET THE APP TO START` → `HOW EARNINGS ARE VERIFIED`)。ARIA 树仍是 `button "Download for iOS →" [disabled]`,加 tabindex 没破坏禁用态朗读。

**剩下两个新缺陷,见下面 N1 / N2。**

---

### 3. P1-4 H1 空白 3s → 1.2s —— 已修

`Base.DjTe9L54.css`:`html.js [data-lr=load]:not(.lr-ready){visibility:hidden;animation:0s linear 1.2s forwards x-unhide}`,`[data-tw]` 同档。

实测(390×844,JS 延迟 9s):

| 时刻 | h1 |
|---|---|
| 400ms / 800ms / 1100ms | `visibility:hidden`(未画) |
| **1350ms** | `visibility:visible`(已画) |
| 1600ms / 2200ms | visible |

上一轮同一测法是 2800ms 仍 hidden、3200ms 才 visible。**空白窗口从 ~3.0s 压到 ~1.2s,确认生效。**

---

### 4. P2-7 跳至正文链接 39px → 44px —— 已修

`.x-skip{…min-height:44px…}` 已进产物。Tab 聚焦后实测:

| 语言 | 上一轮 | 本轮 |
|---|---|---|
| en `/` | 142×**39** | 142×**44** |
| vi `/vi/` | 172×**39** | 172×**44** |
| zh `/zh/` | 80×**39** | 80×**44** |

回归扫描(6 路由 × 320/390/1440/1920 共 24 组合)里 `a.x-skip` 已不再出现在 `<44` 名单中。宽度 80(zh)未变,但我原报打的是高度,不算欠账。

---

### 5. P2-9 语言键缺 lang / hreflang —— 已修

34/34 页每页 3 个语言链接都带齐 `lang` + `hreflang`,静态全量核过(脚本判据:每页 `<div class="lang">` 段内 `hreflang="…"` 计数 == 3 且 ` lang="…"` 计数 == 3,零例外)。

样本:`<a href="/vi/" data-scr lang="vi" hreflang="vi" class="x-dimlink">VI</a>`;zh 页 `aria-label="语言"`,当前项 `class="x-dimlink active" aria-current="true"`。

一句附带观察(不是本次改动引入,原报也没打):`aria-current="true"` 用在标记当前页的链接上,规范里更贴的取值是 `aria-current="page"`。`true` 合法、会被朗读成通用「当前项」,不算缺陷,顺手可以收。

---

### 6. P2-16 `#download` 被固定导航压住 —— 未修(但无实际影响)

**派生改动是真的**:`scroll-margin-top: calc(var(--x-nav-h) + 10 * var(--uc))`,实测 1440 档解析为 `84px`(`--x-nav-h: 74px`)、390 档 `64px`(`--x-nav-h: 54px`)——跟着导航实高走,对 `#how / #devices / #trust` 有效。

**但 `#download` 的落点一分没变**:

| 视口 | 点导航 DOWNLOAD 后 |
|---|---|
| 1440×900 | `scrollY=0` · `targetTop=0` · `headerBottom=74` · **`targetOccluded=true`** |
| 390×844 | `scrollY=0` · `targetTop=0` · `headerBottom=54` · **`targetOccluded=true`** |

原因是结构性的,不是参数没调对:`id="download"` 挂在 `section.hero` 上,而 hero 顶边就是文档顶边——上方没有可滚动的余量,`scroll-margin-top` 在这个锚点上根本没有作用面。

**不过被压住的只是 hero 自己的顶边(那里只有装饰 spacer)**,用户真正要看的三颗键完全在视口内且不被压:

| 视口 | `.dl` |
|---|---|
| 1440×900 | `top=629 bottom=673` · `dlUnderHeader=false` · `dlInViewport=true` · 首键 `top=629` 不被遮 |
| 390×844 | `top=536 bottom=692` · `dlUnderHeader=false` · `dlInViewport=true` · 首键 `top=536` 不被遮 |

建议:要么把 `id="download"` 从 hero 外壳移到 `.dl-wrap`(一行,顺带让锚点名副其实),要么直接标 won't-fix 结掉——按实测它不产生用户可见症状。

---

## 连带发现(本轮新增)

### N1【P2】焦点环回落到浏览器默认样式,不是站点的 lime 环
场景:`/`、`/vi/`、`/zh/` 三颗下载键,390×844 与 1440×900,键盘 Tab 聚焦(`:focus-visible` = true)。
依据:像素级比对(关掉背景 canvas 消除粒子噪声)——禁用键 聚焦前/后 `changedPx=1064/14340 (7.42%) maxChannelDelta=243`,**确实画出了环**,截图看是**白色 1px、贴边无 offset**;同页启用件(`button.menu-toggle`)对照组是 `changedPx=400/3600 (11.11%) maxChannelDelta=208`,截图是**lime `#9EDC1D` 2px + 2px offset**。计算样式 `outline: 1px auto rgb(16,16,16)`(`auto` 由 Chrome 自绘,所以 `rgb(16,16,16)` 这个值不代表实际画出的颜色——我一开始按计算值算出 1.03:1 差点报成 P0,像素复核后推翻)。
根因:站点唯一的焦点规则是 `a:focus-visible, button:focus-visible, summary:focus-visible`(**标签选择器**),`<span role="button" tabindex="0">` 不命中,于是落到 UA 默认环。这次加 tabindex 才把这个洞暴露出来,以后任何 `[role=button]` / `[tabindex]` 元素都会踩。
影响:WCAG 2.4.7(AA,有可见指示)**过**;2.4.13 Focus Appearance(AAA,≥2px)不过;视觉与全站不一致。仅 Chromium 实测,其它内核的默认环长什么样我没有覆盖面,不做断言。
建议:焦点规则里补一档 `[tabindex]:focus-visible`(或 `[role=button]:focus-visible`),一处收口所有后来者。

### N2【P2】Space 键在这三颗键上没被 preventDefault,直接把页面滚走
场景:`/` 390×844,Tab 聚焦第一颗「Download for iOS」后按空格。
依据:`scrollY 0 → 738`(隔离测试,单独按 Space)。Enter 则完全无反应(`url` 不变 · `dlg=false` · `live=0`)。
说明:空格是 `role="button"` 的标准激活键;现在按下去既没有反馈、又把用户甩下去大半屏,比原来「够不着」更容易让人以为页面出错。这是加 tabindex 引入的新副作用。
建议:`keydown` 里对 `' '` / `'Enter'` 一律 `preventDefault()`(等 P0-1 接上真实文案后,顺手在这里播报「暂不可用」)。

### N3【信息】三语「即将上线」文案已经写好了,只是没接线
依据:`src/i18n/en.json:71 "comingBadge": "Coming soon"`,zh `"即将上线"`,vi `"Sắp ra mắt"`——但在 dist 里渲染次数 **0 / 0 / 0**。`data-empty="true"` 仍然挂着且全仓零消费(P2-15 未变)。
说明:这证实 P0-1 确实未修,同时也说明它离修好只差一步——文案素材、状态钩子都在,缺的只是把 `comingBadge` 渲染进 `[data-empty]` 分支。等主人拍板文案时可以直接用。

### N4【订正我自己的报告】P2-6 我列漏了同类导航项
上一轮 P2-6 我只写了语言键 24×44。本轮回归扫描把 1440×900 档的完整名单打出来了,同样窄于 44 的还有:`NEX`=34×44(全部页面)、zh 的 `设备`=36×44 / `信任`=36×44、vi 的 `Học`=34×44。
全部 ≥24,WCAG 2.5.8 AA 仍然合规,严重度不变,但 P2-6 的范围应从「语言键」扩成「桌面导航里所有短标签项」。这条是我原报不完整,不是新缺陷。

---

## 顺带回归(确认改动没有碰坏别处)

6 路由(`/` `/vi/` `/zh/` `/nex/` `/learn/` `/legal/terms/`)× 4 视口(320×568 / 390×844 / 1440×900 / 1920×360)= 24 组合全跑:

- 横向溢出:0(每档 `scrollW` 均 = 视口宽 − 15 的滚动条留白,无一超出)
- 对比度:0 条不达标,最差仍是 `p.note.x-mono` **5.33 : 4.5**(与上一轮同值,未劣化)
- `h1` 每页 1 个 · 标题层级零跳级 · `img` 缺 alt 0 · 空可访问名链接 0 · 未隐藏装饰 svg 0
- 控制台:0 error(报告里出现过的 `ERR_FAILED` 全部是我自己 abort 测试造出来的)

---

## 未修项(与你交底一致,本轮只核事实是否变化,不重复报)

- **P0-1** 下载键是死控件 —— 未变。Enter 无任何反应、`live` region 仍为 0、`data-empty` 仍无消费。等主人拍 URL 与文案。
- **P1-5** 法务页承诺了不存在的译文 —— 未变。`dist/{,vi/,zh/}legal/terms/index.html` 均为 `<main class="legal" lang="en">`,正文全英文。
- **P2-6 / 8 / 10 / 11 / 12 / 13 / 14 / 15** —— 事实描述均无变化(P2-6 的范围订正见 N4)。

---

COUNT: 已修=4(P0-2 / P1-4 / P2-7 / P2-9) 半修=1(P1-3,可达性已修,连带 N1/N2 待收) 未修=1(P2-16,无实际影响) 新增连带=2 个缺陷(N1 P2 / N2 P2)+ 2 条信息(N3 / N4)
