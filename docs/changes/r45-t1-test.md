# R45 · T1 独立黑盒验收 — 首载编排 + 首屏底空

- 对象:NexGrid 官网**构建产物** http://localhost:4399/(dist 生成于 2026-08-26 00:47,晚于 src 最新改动 00:46;live 页引用的 `Base.WTpekMCF.css` / `Base.astro_astro_type_script_index_0_lang.CYMsxkfn.js` 与 dist 一致)
- 日期:2026-08-26 · 验收方:r45-t1(独立 tester,只按 AC 实测,未读实现叙述)
- 方式:Playwright 黑盒脚本(scratchpad `t1-lib.mjs` 公共采样器 + `t1-ac1..4.mjs` + `t1-extra*.mjs`);采样器用 `page.addInitScript` 在文档创建时装 rAF 逐帧记录器(每帧记 `performance.now()` + 目标元素 computed opacity / visibility / transform / className + `html` class),`MutationObserver` 记 `html` class 变化时刻与每个 `.lr-inner` 得到 `.in` 的时刻,前 120 帧另记 `getAnimations()`;「首帧」= `performance.getEntriesByType('paint')` 的 first-contentful-paint。原始逐帧数据存 scratchpad `t1-*.json`。

## 环境

| 项 | 值 |
|---|---|
| Playwright / Chromium | 1.61.0 / **149.0.7827.55**(headless,借 Nexion-uniapp 的依赖) |
| OS | Windows 11 |
| 滚动条形态 | 两种都跑:① headless 默认 `--hide-scrollbars`:不画滚动条,但站点 `scrollbar-gutter: stable` 仍留 15px 槽 → html 布局宽 1425@1440、`--x-vw=1425px`、100vw=1440、clientWidth=1440;② 经典滚动条(`ignoreDefaultArgs:['--hide-scrollbars']`):html 宽 1425、100vw=1425、clientWidth=1425。两种形态 `--x-zoom` 都是 1425/1440=0.9896@1440;差别只在 ≤1439 自适应段的 vw(1366 宽 `--u`=0.9486 vs 0.9382)。 |
| 时间基准 | 页面 `performance.now()`(navigation start=0);采样器跑在**主线程** rAF 上(合成器线程帧不可观测,见 AC3 备注) |
| 脆性排除 | 网络节流 CDP `Network.emulateNetworkConditions`(300ms RTT / 1.5 Mbps 上下行);CPU `Emulation.setCPUThrottlingRate`;等 `document.fonts.ready` + networkidle;静态几何用 `reducedMotion:'reduce'`,并用 `no-preference` + 等 4.5s(动画终态还原纯文本后)交叉核;行数用 `Range.getClientRects()` 去重 top;亮区全部 DOM / computed style 断言,不用截图 |

## 逐条 AC

| AC | 判定 | 证据(原始数字) | 脚本 · 视口 · 路由 |
|---|---|---|---|
| **AC1-a** 300ms RTT / 1.5 Mbps 下 `html.x-boot` 落地前首屏零帧满亮 | **pass** | `/`:`html` 元素出现 325.3ms → `x-boot` 落地 **337.4ms**;首个 rAF 帧 790.4ms、FCP 804ms → x-boot 落地前帧数 **0**。首个绘制帧六元素:`.site-nav` o=0 · `.hero .sub` o=0 · `.hero .dl-wrap` o=0 · `.scroll-hint` o=0 · `.note` o=0 · `h1` visibility=hidden;全程 741 帧无任何元素出现「o=1 后又 <1」的闪现。首次 o>0:nav/hint/note 1183ms(FCP+379)、sub/dl-wrap 2200ms(FCP+1396)、h1 1592ms。`/vi/`:x-boot 331.2ms,首帧 872.3ms,FCP 880,778 帧同样 0 闪现。 | t1-ac1.mjs · 1440×900 · `/` `/vi/` |
| **AC1-b** 标题在遮罩建好前不可见(`h1` 无 `.lr-ready` 时 visibility=hidden) | **pass** | `/`:CSS 已载且 h1 存在且无 lr-ready 的帧全为 hidden,违例 **0/741**;`.lr-ready` 1592.4ms,首行 `.in` 1618.2ms(两行 --lrd 0/90ms)。`/vi/`:违例 **0/778**;lr-ready 2920.4ms,三行 `.in` 2937.8ms。 | 同上 |
| **AC1-c** 无 JS(`javaScriptEnabled:false`)标题与副题 3s 内可见 | **pass** | 不节流:两张样式表已载后 **121ms**(FCP 68)h1 visible/o=1/高 159px/24 字,sub visible/o=1/高 38px/77 字;节流(同 AC1 条件):**938ms**(FCP 904)。`html` class 为空(无 `js`),隐藏规则不生效;`window.__t1` 为 undefined 证实页内脚本确未执行。 | t1-ac1.mjs · 1440×900 · `/` |
| **AC2-a** 刷新到 y=5200:t=100ms 时 `.site-nav` opacity=1,`html` 无 `x-boot` | **pass** | reload 前 scrollY 5200;reload 后 navType=`reload`,scrollY **5200** 已恢复;`html`=`js lenis lenis-scrolling`(**无 x-boot**);首帧 47.9ms nav o=**1**;t≥100 的首帧 106.7ms nav o=**1**、visibility visible;FCP 64 之后 nav<1 的帧 **0**,六个淡入元素 <1 的帧 **0**。 | t1-ac2.mjs · 1440×900 · `/` |
| **AC2-b** 从 /learn/ `page.goBack()` 回首页 | **pass** | navType=`back_forward`(`pageshow.persisted=false`);`html`=`js lenis` **无 x-boot**;首帧 28.7ms nav o=**1**;110.7ms o=**1**;暗帧 0。经真实导航链接点击进 /learn/ 再 goBack 同结果(27.5ms / 116.2ms o=1)。**未能测**:bfcache 恢复路径(Playwright 默认禁 bfcache);源码无移除 `x-boot` 的逻辑,bfcache 恢复时 html 仍带类但动画已终态——推断,未实测。 | t1-ac2.mjs · 1440×900 · `/` ⇄ `/learn/` |
| **AC2-c** 首页 navigate 直接打开:`x-boot` 存在、四拍顺序 | **pass** | `x-boot` 11ms 落地;FCP 96;`#x-bg` 与 `.site-nav` 两条 CSS 动画同 startTime 80.5ms。① canvas 首个 o>0 帧 **105.4ms**(最先);② nav 首个 o>0 帧 **499ms**(FCP+403 ≈ 0.4s);③ 标题首行 `.in` 类 599.1ms(FCP+**503**)、transform 首次变化 631.1ms(FCP+535;JS 启动代理 86.7ms → +544);④ 副题首个 o>0 **1497.7ms**(FCP+1402)。顺序 canvas < nav < 标题 < 副题,标题 ≥ 开场+500 且早于副题。`/vi/` `/zh/` `/?utm=1` 同样挂 x-boot;`/#stats` `/learn/` `/nex/` 直接打开不挂(nav 首帧 o=1)。 | t1-ac2.mjs / t1-extra.mjs · 1440×900 |
| **AC3-a** canvas 淡入由 CSS 动画驱动 | **pass** | JS 尚未启动时(t=66.7ms,`jsBooted=false`)`#x-bg.getAnimations()` = 1 条 `{constructor: CSSAnimation, animationName: x-zoom-fade, duration 1000, fill both}`,无 WAAPI `Animation`;opacity 逐帧 0(84ms)→0.0746(92.5)→0.146(109)→0.280(156)→0.401(176)→0.507(209)→…,transform 1.05→1.0 同步。 | t1-ac3.mjs · 1440×900 · `/` |
| **AC3-b** 4× CPU 节流下 canvas 仍先于导航 | **pass** | 4×:动画 startTime 285.9(bg/nav 同锚,nav 延迟 400);bg 首个 o>0 帧 **460.2ms** < nav 首个 o>0 帧 **790.9ms**;补测 6×:730.4 < 806.3 仍先。备注:主线程 rAF 采样,JS 启动阻塞主线程(4× 最大帧间隔 297ms、6× 470ms)期间合成器帧看不到,bg 首可见帧数字是上界。 | t1-ac3.mjs · 1440×900 · `/` |
| **AC3-c** 2560×1440 `#stats` 不早于副题拍(1.4s 前 o=0) | **pass** | `#stats` top=1200(hero 底 1200,视口 1440 → 在首屏);zoom 1.3333,`--x-vw` 2545px。`/`:FCP 80,`#stats` 与 `.sub` 在 500/1000/1300ms 采样均 o=0,首个 o>0 为**同一帧** 1478.3ms(1400ms 采样两者同为 0.050);`/vi/` 1523.1ms 同帧;`/zh/` 1517.9ms 同帧。注:`/` 上该帧比 FCP+1400 早 2ms(CSS 动画锚 61.2ms 早于 FCP 19ms),与副题同帧,不构成提前。 | t1-ac3.mjs · 2560×1440 · `/` `/vi/` `/zh/` |
| **AC4-a** 1440×900 `.hero` 高 900、computed padding-bottom=220 | **pass** | computed `padding-bottom` **220px**、padding-top 96px;`.hero` 高 **900 画布 px**(屏幕 890.6px = 900×0.9896:15px 滚动条槽使 `--x-vw`=1425 → zoom 0.9896);两种滚动条形态、三语相同。 | t1-ac4.mjs · 1440×900 · `/` `/vi/` `/zh/` |
| **AC4-b** 1366×673 / 1440×700 / 1536×774 `.hero .dl-wrap` 底边 ≤ 视口高 | **pass** | 1366×673:**645.0**(经典滚动条形态 638.0)≤ 673;1440×700:**672.9** ≤ 700;1536×774:**718.3** ≤ 774;三语一致;三颗键底边 = wrap 底边(键高 44.00 / 43.53 / 46.47)。注:本构建下载键是 `data-empty="true"` 占位(`<span class="xbtn disabled">`),行高与真键同。 | t1-ac4.mjs / t1-extra3.mjs · 三档 · `/` `/vi/` `/zh/` |
| **AC4-c** /vi/ 三行簇 `.cluster` 顶边距导航条底边 ≥150(1440×900) | **pass** | h1 **3 行**(Range 去重 top);`.cluster` top 260.0,`.site-nav` bottom 74.0 → gap **186.0**;动画结束后(no-preference 等 4.5s)同值;两种滚动条形态同值。顺带:1366×673 gap 171.0(经典 167.4)、1440×700 186.0、1536×774 198.5。 | t1-ac4.mjs · 1440×900 · `/vi/` |

## 额外发现(与 AC 分列,未合并)

**X1 [P2] vi 首页慢网下标题拍晚于副题拍——四拍顺序被打破。** AC1 同款节流(1.5 Mbps / 300ms)下 `/vi/`:副题 2287ms 起淡入,标题首行 2938ms 才滑入(晚 **650ms**);1 Mbps 下 2347 vs 3723(晚 1.4s)。根因(回源 `src/scripts/fx.ts` initLineReveal):建遮罩仍在 `document.fonts.ready` 之后,而 vi 页要等 **12 个 woff2**(Be Vietnam Pro 400/500 × latin/latin-ext/vietnamese + Space Mono 400/700 × latin/latin-ext/vietnamese,含标题根本不用的 mono 字体;1.5 Mbps 下最后一个 2907ms 到)——R45「标题拍锚在开场钟」只抬了下限,没解掉字体门。`/`(en,4 个字体)1.5 Mbps 守住(1618 vs 2200)、1 Mbps 守住(1947 vs 2262),0.75 Mbps 余量只剩 67ms(2295 vs 2362)。连带:`x-unhide` 3s 兜底在 vi ≤ ~0.9 Mbps 时会先于遮罩建成触发(1 Mbps 实测 lr-ready 3704 vs 兜底 ≈3948),即 CSS 注释里防的「先以回退字体画出、建遮罩时消失、再滑入」。复现:`t1-ac1.mjs`(`/vi/` 段)/ `t1-extra2.mjs`。

**X2 [P2·性能] 证书 PNG 非懒加载 + phone.png 首载抢关键路径带宽。** `/cert-msb.png` 323KB、`/cert-colorado.png` 342KB 的 `<img>` 无 `loading="lazy"`,节流下 475ms 就开始下载;`/devices/phone.png` 417KB HTML 里是 lazy,但脚本启动时被翻成 eager(fx ⑥)~800ms 起下。首页首载 13 个资源共 **1.39MB**(`/vi/` 21 个 1.51MB),`load` 8.2s 才触发;1.5 Mbps 下 JS 模块 10.5KB 花了 497ms 才到、16KB 的 mono 字体 ~840ms,直接推迟标题拍。复现:`t1-ac1-throttled_.json` 的 `res` 字段。

**X3 [P3·设计意图] canvas 淡入与首绘解耦。** CSS 淡入从首帧起跑,但粒子要等 JS 启动 + idle 回调后首绘:1× CPU 首绘落在淡入开始后 71ms(此时 opacity 0.28,淡入基本可见);4× CPU 首绘落在 472ms 后(opacity **0.94**)——粒子几乎无淡入地「弹」出来。非 AC 失败,是 R45「首帧即起、不等空闲回调」的代价,请设计侧确认是否接受。复现:`t1-extra3.mjs`(读 canvas 中心 300×300 像素判首绘)。

**X4 [P3·注释] `Base.astro` 头部注释「必须在样式之后、正文之前」与产物矛盾。** `dist/index.html` 顺序是 JSON-LD → 内联脚本 → `Base.css` → `FinalCta.css`(Astro 把样式表挂到 head 尾);内联脚本自己的注释已承认「本脚本在样式表之前执行」,`--x-vw` / `x-boot` 行为实测正确,仅注释自相矛盾。

**X5 [P3·触达] 1440–1935 宽下 44px 触达变 43.5 屏幕 px。** 15px 滚动条槽使 zoom=(vw−15)/1440<1,`calc(44*var(--uc))` 的键在 1440×700 实测高 **43.53px**(1366 宽 zoom=1 为 44.00,1536 为 46.47);比 44pt 纪律差 0.5px,与 R42 的「画布 px」口径有关,非本任务范围。

## 结论

`PASS 4/4`(AC1 3/3 子项、AC2 3/3、AC3 3/3、AC4 3/3 全 pass;AC2-b 的 bfcache 恢复路径因 Playwright 禁 bfcache 未能测,已注明)
