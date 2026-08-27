# R45 第三轮回归 RT-C 黑盒测试报告

- 日期:2026-08-26
- 对象:NexGrid 官网构建产物 `http://localhost:4399/`(preview 已在跑;本轮未起停服务、未 build)
- 工具:Playwright 1.61.0(借 `Nexion-uniapp` 依赖)Chromium headless;脚本在 `C:/Users/jason/AppData/Local/Temp/claude/D--WORKS-PLAN/42e4397e-0bc4-4987-8cc3-a0bc8464e0bd/scratchpad/rtc-*.mjs`,逐帧原始数据在同目录 `rtc-ac1-*.json` / `rtc-ac2-*.json` / `rtc-ac3-*.json` / `rtc-ac8-*.png`
- 方法:只按 AC 逐条实测,不读实现。静态几何用 `reducedMotion:'reduce'`;动态项(AC1/2/3/8)用默认 motion(Lenis 生效,`html.lenis`)。手机用 `isMobile+hasTouch`,DSF 3。
- 单位说明(影响 AC5/7/12 的读数):1440×900 下页面包在 `.x-canvas` 里,computed `zoom: 0.989583`。`getBoundingClientRect()` 给的是屏幕 px(= 画布 px × 0.9896),`offsetHeight` / computed 长度是画布 px。下表凡写「画布 px」的阈值按画布 px 判,同时给出屏幕 px 读数。390 / 1024 视口 zoom = 1,两者相同。

## 逐条 AC

| AC | 结论 | 证据(原始数字) | 脚本 |
|---|---|---|---|
| AC1 翻色对比度 | **fail** | 1440×900 `/`,白带 doc y 8260–13730,nav 高 74。每帧 `scrollTo({behavior:'instant'})` 精确按 33 / 5 / 2 px/帧驱动(实测 meanStep 32.8 / 4.99 / 2.0),rAF 逐帧记 `.site-nav` color、`::before` bg×opacity、白带顶底、链接文字中心 y(51.84)。**6 次录制最低对比度**:进白带 33px→**2.48**(f9)、5px→**2.07**(f34)、2px→**2.07**(f80);出白带 33px→3.28(f6,过)、5px→3.89(f32,过)、2px→**2.48**(f78)。4/6 次出现 <3:1 帧(每次 1–2 帧,≈17–33ms)。机制(逐帧可见):翻色时 `::before` 先跳到 opacity 0.95 并做 250ms 线性色变(12→242 或反向),而文字色在进白带 +50–67ms 就切黑——此时底板才 rgb(73–89)×0.95 合成白底≈81–96 灰,黑字在灰上 2.07–2.63;出白带则文字迟到 +167–233ms 才切白,底板已暗到 73 时仍是黑字→2.48。真滚轮(Lenis)交叉验证 `rtc-ac1-wheel.mjs`:出白带 420px 一次 wheel 同样 2 帧 <3:1(2.63 / 2.07),进白带那次最低 3.14(相位不同)。**opacity 回落**:峰值 0.95(≥0.9 ✓),但从翻色起到回到 0.72/0.64 用时 **567 / 567 / 567 / 767 / 567 / 750 ms**(>350);`.flipping` 持续 317–433ms 后再用 250–333ms 缓出——若「≤350ms」从 `.flipping` 移除起算则 250–333ms 满足,按翻色起算不满足。 | `rtc-ac1.mjs`(主)、`rtc-ac1-wheel.mjs`(交叉) |
| AC2 指针预置 hover | pass | 1440×900 `/`,第 2 行 `#learn-entry .row`(`/learn/phone-compute/`,reveal 动画 opacity 0→1 + translateY 12,0.9s)。终态位置按 rect−transform 反推(zoom 校正),鼠标先停 (713,450),再一次 `mouse.wheel` 12204px。run1:行滑到指针下 t=3436.2 → `:hover` 匹配 +16.6ms → opacity ≤0.62 **+116.6ms**(到 0.6 并保持,终态 hovered=true op=0.6);run2:**+116.7ms**。对照(先进场 4s 后再 `mouse.move`):**151–167ms** 到 0.6(2 次)。均 ≤300ms。 | `rtc-ac2.mjs` |
| AC3 vi 慢网标题拍 | pass | CDP 1.5Mbps / 300ms RTT,每次全新 context(冷缓存)。`lr-ready` − `x-boot`:`/vi/` **656.5 / 650.0 ms**,`/` **552.6 / 567.3 ms**(均在 0.5–1.2s)。标题第一行 `.lr-inner` 开始位移(translateY 87.59→77.8)abs 1513.7 / 1530.6 / 1451.8 / 1466.1 ms,`.hero .sub` 淡入开始(opacity 0→0.019)abs 2297 / 2280.6 / 2218.4 / 2216 ms → 标题先于副标 ~770ms,4/4 成立。备注:`lr-ready` 与 DOMContentLoaded 同帧出现(957–986 / 890–912ms),`fonts.ready` 在 vi 下 2206–2231ms(晚于标题起动,标题未等字体)。 | `rtc-ac3.mjs` |
| AC4 /nex/ 三语 title | pass | en `NEX — the token that powers NexGrid's compute economy.`;vi `NEX — token vận hành nền kinh tế tính toán của NexGrid.`;zh `NEX——驱动 NexGrid 算力经济的代币。` — "NexGrid" 各恰 1 次(大小写不敏感也 1 次)。 | `rtc-ac4.mjs` |
| AC5 文章页 | pass(画布 px) | 1440×900 与 390×844 × en/vi/zh 共 6 组:`nav.toc` / `aside.related` 都有 `.x-paper`,computed background `rgb(242,242,242)`(alpha 1,不透明),display grid。每个 `li` 宽 = `ol` 宽(1440:625.44=625.44;390:310=310),`li` border-top 1px solid rgba(12,12,13,.23)(1440 屏幕读数 1.01053px = 1 画布 px),`ol` border-bottom 同规格。链接 `a` display flex,min-height 36px:**画布 36px**(offsetHeight 36;1440 屏幕 35.625,390 屏幕 36)。相关文章 2 条(`/learn/phone-compute/`、`/learn/buy-device/` 及 vi/zh 前缀版),均非当前文,href 以 `/` 结尾。 | `rtc-ac5.mjs`、`rtc-probe3.mjs` |
| AC6 手机灯箱 | pass | 390×844 hasTouch,reduce 与 no-preference 各测一遍:`.cert-hint` 无 hover computed opacity **1**(2 张证书都是)。tap 第一张 → `dialog.cert-zoom[open]` rect 0,0,**390×844**(= 视口);img 渲染 **1160×1548**(`/cert-msb@2x.png` natural 1160×1548);`dialog.scrollWidth 1176 > clientWidth 390`(overflow-x auto)。`scrollLeft=300` 后关闭键(`form.cert-zoom-close` sticky)仍在 x=307,y=8,74.7×44,在视口内,`elementFromPoint` 命中 `BUTTON.xbtn`;tap 关闭键 → closed;重开后 Esc → closed。 | `rtc-ac6.mjs` |
| AC7 行内链 | pass(画布 px) | `#how .vlink` display block,padding 13.5px×2,line-height 17.4 → 命中盒 **44.4 画布 px**(1440 屏幕 43.94;1024 与 390 均 44.39)。命中盒顶边上 2px、水平中点处 `elementFromPoint` = `P.x-mono.body`(非 vlink),三视口一致。独立成行:vlink top 427.80 ≥ 前一文本行 bottom 434.11−7=427.11(1440);362.16 ≥ 361.36(1024);399.75 ≥ 398.95(390)。注意 margin-top −6.6px 使命中盒与前一行盒重叠 6.3px(在 AC 的 7px 容差内),文字本身在 441.16 起,不压行。 | `rtc-ac7.mjs`、`rtc-probe3.mjs` |
| AC8 页脚护字层 | pass(见指标定义) | 1440×900 `/` 非 reduced,滚到底(scrollY 13886=max),`footer .info` 595×119 裁剪区(含 8px 边)。文字掩膜:另开 context 隐藏 canvas,截「有字 / 字透明」两张差分得 5315 文字像素;因 12px 字的抗锯齿边缘像素在**无粒子**基线下就有 30.7% <3:1(min 1.38),该定义不可判,改用**实心笔画像素**(每区域亮度 ≥0.8×最大值,共 958 px:免责声明 801 + 法务链接 209)——基线 0% <3:1,min 6.36。粒子运行下连续 5 帧(间隔 400ms):**<3:1 占比 0% / 0% / 0% / 0% / 0%**,每帧最低对比度 4.61 / 4.61 / 3.44 / 3.90 / 4.35。对照:裁剪区外页脚像素 max 通道 > 底色+8 的占比 **29.5%**(5 帧均 29.5–29.52%,>5%),粒子未被盖掉;`.info` 内非文字像素 14.2% 也有粒子透出(护字层是 `::before` radial-gradient closest-side rgba(12,12,13,.92)→0)。边际观察:按「周围最亮单像素」算,0.52–1.25% 实心像素有一个邻近背景像素 <3:1。 | `rtc-ac8.mjs` |
| AC9 404 语言尺 | pass(字面偏差已标) | `/404.html` 200、随机路径 404,title `Page not found — NexGrid`。三块 `section.blk[lang]`:**vi** `.title`(是 `p` 不是 `h1`)首项 `"Be Vietnam Pro"` 54px ✓;vi `.body.x-mono` 首项 **`"Space Mono"`** 12/18px — 字面不含 Be Vietnam Pro,但与 `/vi/` 全站 body 一致(`/vi/` 的 `.hero .sub`、`#how p.body`、footer `.disclaimer` 首项全是 Space Mono,非 mono 段落才是 Be Vietnam Pro),判为设计口径而非回归;**zh** `.x-mono` **12.5px / 20px** ✓(1.6);**en** `h1` 首项 `"Funnel Display"` ✓。`/zh/legal/privacy/`:`h1` "Privacy Policy"(lang=en)首项 Funnel Display ✓,`.updated` 12px(lang=en)✓,`.prevails`(lang=zh)12.5px ✓。`document.fonts.check` 三字体均已加载。 | `rtc-ac9.mjs`、`rtc-probe4.mjs` |
| AC10 导航 | pass | 861 / 880 / 900 / 1039 × 900 `/`:`.dl-btn` font-size **12px**(4 档);`.site-nav` 高 **74**;5 个链接 top 全为 30(单行);`.logo-cell`(x 24–142)与 `.right`(x 313/331/349/468 起)不重叠;`.links`(右缘 612/630/649/779)与 `.dl-btn`(左缘 718/737/756/891)不重叠;`.menu-toggle` display none。**注**:`.links` 是 `.right > .menu` 的后代,AC 字面「`.links` 与 `.right` 不重叠」不可成立,改测上述兄弟盒。`::before` opacity:首页黑区 **0.64**;滚入白带后 `.on-light` **0.72**(bg 242);`/learn/` **0.9**(≥0.88)。 | `rtc-ac10.mjs` |
| AC11 FAQ 反馈 | pass | 1440×900:`/` 7 个 `summary`(信任区 PoC 1 + FAQ 6)hover 后 `.q` opacity 1 → **0.6**,`:hover` true;`/nex/` 4 个 FAQ 同 0.6。 | `rtc-ac11.mjs` |
| AC12 其它归一 | pass(画布 px) | `/learn/` 6 张卡 `h2` 24px / 26.4px = **1.10**;`/legal/privacy/` `h1` margin-bottom **14px**(画布),box 间距屏幕 13.84px(=14×0.9896,同一父级无中间元素);首页 `#devices` "Free" `b.price` text-transform **none**、innerText `Free`(其余价格 $19.9…$7,499 正常);`/nex/` 4 条 FAQ `.idx` flex `0 0 30px`(画布 30,屏幕 29.69),答案 `p` 左缘 126.66 = 问题 `.q` 左缘 126.66。 | `rtc-ac12.mjs`、`rtc-probe3.mjs` |

## AC1 复现步骤

1. 1440×900,非 reduced motion,打开 `/`,等 fonts.ready + networkidle。
2. `window.scrollTo({top: 8260-74-160, behavior:'instant'})`(白带顶 ≈ doc y 8260),等 1.5s。
3. rAF 每帧 `scrollTo` +2px 并记录 `getComputedStyle(nav).color`、`getComputedStyle(nav,'::before').backgroundColor/opacity`。
4. 观察 `.on-light.flipping` 加上后 +50–67ms:color 已是 rgb(12,12,13),`::before` 为 rgb(73,73,74)×0.95 → 合成白底后黑字对比 2.07–2.48。出白带(doc y ≈ 13730)对称:文字 +167–233ms 才切白,期间底板已暗到 73–89。
5. 同时观察 `::before` opacity 0.95 要到 +567–767ms 才回到 0.72/0.64。
6. 脚本一键复现:`node rtc-ac1.mjs`(帧级 JSON 落盘)/ `node rtc-ac1-wheel.mjs`(真滚轮)。

## 额外发现(不计入 AC)

1. **`.x-canvas` zoom 0.989583(1440×900)**:所有「画布 px」阈值在屏幕上缩 1.05%。恰好卡阈值的四处:TOC 链接 36→35.63、vlink 44.4→43.94、`.idx` 30→29.69、隐私页 h1 间距 14→13.84。若 AC 意图是屏幕 px,这四处按字面为 fail;本报告按画布 px 判 pass。
2. **AC9 vi 正文**:404 vi 块 `.body` 是 Space Mono(与 `/vi/` 全站 mono 正文一致)。若期望 vi 正文用 Be Vietnam Pro,则是全站口径问题而非 404 页问题。
3. **AC8 护字层边际**:radial closest-side 渐变在免责声明第一行处只剩约 0.2 alpha,粒子在 `.info` 内非文字区 14% 像素可见;均值口径 0% 失败,但「最亮邻像素」口径 0.5–1.25% 实心像素邻近有 <3:1 背景点。目前不构成失败,粒子变亮/变密时会先从这里破。
4. **`html` computed `scroll-behavior: smooth` 与 Lenis 同时生效**(`html.lenis`):`window.scrollTo(0,y)` 被浏览器再平滑一次(测试里逐帧 scrollTo 实测被拉成 20–30px/帧的浏览器缓动,改 `behavior:'instant'` 才精确)。未验证是否影响真实用户(锚点跳转 `#trust` 等),仅记录。
5. **AC10 字面条件不可测**:`.links` 位于 `.right > .menu` 内,已改测兄弟盒(见表)。
6. **AC1 文字切换时刻不稳定**:同一 `color 0s linear 0.196s` 声明下,进白带实测 +50–67ms、出白带 +167–233ms 切换(相对 `.on-light` 翻转帧),说明切换不只由该 transition 决定;这也是 6 次录制里 2 次「恰好」≥3:1 的原因——通过与否取决于相位,不是稳定通过。

## 结论

**PASS 11/12**(AC1 fail:翻色期间 4/6 次录制出现 1–2 帧文字对比度 2.07–2.63 <3:1;`::before` opacity 峰值 0.95 合格但回落到静息值用时 567–767ms >350ms)。
