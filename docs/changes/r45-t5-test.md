# R45-T5 验收报告:进场动效 × hover 关系 + 对比度

独立黑盒验收,只按 AC 实测,未读实现源码。

## 环境

- 对象:构建产物 http://localhost:4399/(未起停服务、未 build / dev、未触碰 4321)。路由:`/`、`/learn/`、`/learn/getting-started/`、`/vi/`、`/zh/`。
- 视口 1440×900;Chromium headless(Playwright 1.61.0,借 Nexion-uniapp 依赖);`reducedMotion: 'no-preference'`(AC1–AC3、AC4 非 reduced)/ `'reduce'`(AC4 reduced)。
- 滚动一律 `mouse.wheel`(Lenis 在);每页等 `fonts.ready` + networkidle + 300ms;hover / mouse.down 后 ≥300ms 读 computed。
- 进场计时:`addInitScript` 在页面脚本前装 MutationObserver(抓 `.in` 加上的时刻)+ 捕获态 `transitionstart/transitionend`(opacity)+ rAF 逐帧采样 computed opacity。
- 对比度:computed `color` 的 alpha × 祖先链 opacity 乘积 → 合成到底色 → WCAG 相对亮度比;底色同时用 AC 给定值与 DOM 逐层 background-color 实际合成值(两者一致,页脚确认透底到 `body/html rgb(12,12,13)`)。
- 脚本(scratchpad `C:/Users/jason/AppData/Local/Temp/claude/D--WORKS-PLAN/42e4397e-0bc4-4987-8cc3-a0bc8464e0bd/scratchpad/`):`t5-recon.mjs`、`t5-ac1.mjs`、`t5-ac1b.mjs`、`t5-ac2.mjs`、`t5-ac3.mjs`、`t5-ac4.mjs`,原始输出 `t5-ac*.json`,逐帧 `t5-ac1*-frames.json`、`t5-ac2-frames-{300,600}.json`。
- 执行日期 2026-08-26。

## 逐条 AC

| AC | 结果 | 证据摘要 | 脚本 |
|---|---|---|---|
| AC1 hover/active 值 + 进场仍 0.9s | **pass**(lang 链「进场」子项 N/A,见注) | row hover 0.6 / down 0.58;card hover 0.92;lang hover 1;进场 transitionend elapsed 0.9s,`.in`→1 = 0.94–1.08s(rows)/ 0.97–1.12s(cards) | t5-ac1.mjs、t5-ac1b.mjs |
| AC2 视差 style vs computed | **pass** | wheel 300 / 600 各 184 / 185 帧,三卡最大差 0.000px,>1px 帧 0;停止后 +0ms 相等 | t5-ac2.mjs |
| AC3 对比度 | **pass** | 页脚链 / a.back 三态 7.72 / 7.28 / 6.86:1;.vlink active 4.65:1(hover 4.97、idle 17.47) | t5-ac3.mjs |
| AC4 三语 reduced / 非 reduced | **pass** | reduced:3 页各 35/35 opacity 1 + transform none(载入与滚完后均 0 隐藏);非 reduced:3 页滚完各 35/35 `.in` + opacity 1 | t5-ac4.mjs |

### AC1 明细(1440×900,非 reduced)

hover / active(pointer 先移到 (2,898) 取 idle,再 `page.hover` → 读 0 / 300 / 600 / 1000ms → `mouse.down` 读 300 / 1000ms → 移开 400ms 读):

| 元素 | 路由 | idle | hover 0ms | hover 300ms | hover 600/1000ms | down 300ms | down 1000ms | 离开 400ms |
|---|---|---|---|---|---|---|---|---|
| `#learn-entry .row`(a.row.x-dimlink,进场后 `.in.rv-done`) | `/` | 1 | 1 | **0.6** | 0.6 | **0.58** | 0.58 | 1 |
| `.card`(a.card.x-paper) | `/learn/` | 1 | 1 | **0.92** | 0.92 | 0.85 | 0.85 | 1 |
| `.lang a:not(.active)`(a.x-dimlink) | `/` | 0.62 | 0.62 | **1** | 1 | 1 | 1 | 0.62 |
| `.lang a:not(.active)` | `/learn/` | 0.62 | 0.62 | **1** | 1 | 1 | 1 | 0.62 |

进场后 `.row` / `.card` 的 computed transition 已变为 `opacity 0.2s, transform 0.2s`(进场前为 0.9s),hover 在 300ms 内到位。

进场 0.9s(`.in` 加上后 opacity 0→1):

| 元素 | `.in` 时 opacity | 首次变化(=stagger 延迟) | 到 ≥0.999 | 到 =1 | transitionend elapsedTime |
|---|---|---|---|---|---|
| row #1(pointer 停在行外) | 0 | 60.7ms | 775.0ms | **942.5ms** | 0.9s |
| row #2 | 0 | 123.0ms | 856.4ms | **1000.9ms** | 0.9s |
| row #3 | 0 | 223.0ms | 945.7ms | **1084.0ms** | 0.9s |
| /learn/ card #1(载入即进场) | 0 | 82.9ms | 799.2ms | **966.0ms** | 0.9s |
| /learn/ card #2 | 0 | 148.7ms | 881.9ms | **1032.0ms** | 0.9s |
| /learn/ card #3 | 0 | 233.0ms | 965.9ms | **1115.1ms** | 0.9s(ts→te 898.9ms) |

row #2 逐 100ms 采样:`0:0.000 100:0.023 200:0.545 300:0.765 400:0.892 500:0.958 600:0.980 700:0.994 800:0.998 900:1.000`。

- 动画本身 0.9s(6/6 transitionend elapsedTime = 0.9s)✓;从 `.in` 起算含 stagger 为 0.94–1.12s。card #3 含 233ms stagger 后为 1.115s,超出 0.7–1.1s 观察窗 15ms——按「动画本身 0.9s」判 pass,数字如实列出供裁决。
- lang 链:本身与任何祖先都没有 `[data-rv]`,不存在 `.in` 进场,无法按本 AC 定义测(**N/A**)。替代证据:`/` 上其进场 = `header#site-nav` 的 CSS 动画 `x-fade` 0.6s + delay 0.4s(逐帧:0–300ms 0,500ms 0.221,700ms 0.802,900ms 0.989,1005ms 1.000);`/learn/` 上 header 首帧即 1,无进场。

### AC2 明细(`/`,1440×900)

起点:`#how` 顶边置于 vh 80%(scrollY 7659,`#how` top 720),三步卡 `article.step.rv-fade[data-plx=.06/.11/.16]` 的 `style.transform` = translate3d(0,-48.3/-84.6/-117.8px,0),computed 同值;transition 仅 `opacity 0.9s`(transform 无过渡)。

| 阶段 | 帧数 / 录制时长 | Lenis 滚动时长(scrollY 变化) | 三卡 max \|style ty − computed ty\| | >1px 帧 | 停止后相等 | 末值 style / computed |
|---|---|---|---|---|---|---|
| wheel 300(7659→7959) | 184 / 3067ms(≈60fps) | 1099.8ms | 0.000 / 0.000 / 0.000 px | 0 | **+0ms**(style 最后一次写入在停止后 16.6ms 那帧,computed 同帧一致) | -31.2 / -54.6 / -76.0 = 同值;`.in` 已加,opacity 1 |
| wheel 600(7959→8559) | 185 / 3066ms | 1166.8ms | 0.000 / 0.000 / 0.000 px | 0 | **+0ms** | 3.1 / 5.4 / 7.6 = 同值 |

### AC3 明细(12px / 400,底色按 AC 给定;DOM 实测底色一致)

| 元素 | 路由 | idle | hover(400ms) | active(400ms) |
|---|---|---|---|---|
| `.site-footer nav a` #0 "Privacy Policy" | `/` | rgba(255,255,255,.62) op 1 → #a3a3a3 on #0c0c0d = **7.72:1** | #fff op .6 → #9e9e9e = **7.28:1** | #fff op .58 → #999999 = **6.86:1** |
| `.site-footer nav a` #1 "Terms of Service" | `/` | 7.72:1 | 7.28:1 | 6.86:1 |
| `.site-footer nav a` #0 / #1 | `/learn/getting-started/` | 7.72:1 | 7.28:1 | 6.86:1 |
| `a.back` "← All guides"(a.back.x-mono.x-dimlink) | `/learn/getting-started/` | rgba(255,255,255,.62) → **7.72:1** | #fff op .6 → **7.28:1** | #fff op .58 → **6.86:1** |
| `#how .vlink` "How earnings are verified →" | `/` | rgb(12,12,13) op 1 on #f2f2f2 = 17.47:1 | op .6 → #686869 = 4.97:1 | op .58 → #6d6d6d = **4.65:1** |

页脚 DOM 逐层背景:仅 `body rgb(12,12,13)` / `html rgb(12,12,13)`(footer 无背景 = 透底);`.vlink` 所在 `div.band-light.x-invert.curtain rgb(242,242,242)`。

### AC4 明细(三语首页 `[data-rv]` 各 35 个)

| 路由 | reduced 载入:opacity≠1 或 transform≠none | reduced 滚完全页(到底,yEnd+900=docH) | 非 reduced 滚完全页:未 `.in` 或 opacity≠1 |
|---|---|---|---|
| `/` | **0**/35(translate 也全 none;`[data-plx]` 内联 transform 0/8 写入) | 0/35 | **0**/35(载入时 35 个全隐藏、0 个 `.in`;滚完 35/35 `.in.rv-done`) |
| `/vi/` | **0**/35 | 0/35 | **0**/35 |
| `/zh/` | **0**/35 | 0/35 | **0**/35 |

reduced 下 `matchMedia('(prefers-reduced-motion: reduce)')` = true 已核;非 reduced 下 8 个 `[data-plx]` 元素带视差 transform(预期,AC 只要求 `.in` + opacity 1)。

## 额外发现(不计入 AC 判定,分开列)

1. **P2 · pointer 已停在元素上时进场,hover 响应走 0.9s 而非 0.2s**(t5-ac1b 场景 B):`/` 上光标停在视口中心、wheel 到 `#learn-entry` 使 row #1 落在光标下。`.in` 后 opacity 0→0.903(峰值 @327ms),Chrome 滚动停止后更新 hover(@344ms 第二次 transitionstart),reveal 过渡被重定向到 0.6,沿 0.9s 曲线慢慢降:400ms 0.761 / 600ms 0.633 / 800ms 0.606 / 1100ms 0.600,transitionend @1226ms。原因(computed 观察):0.2s 的 transition 只在 `rv-done` 加上后生效,而 `rv-done` 要等 reveal 结束。视觉:元素先亮到 0.9 再用近 1s 缓缓变暗。同机制应覆盖 `.card` 等所有 `[data-rv]` 可 hover 元素(未逐一复测)。复现:1440×900 打开 `/`,鼠标放 (720,450) 不动,滚到学习中心区让一行落在光标下。
2. **P2 · 页脚法务链与 a.back 的 hover / active 反馈肉眼不可辨**:idle 是 color alpha .62(合成 #a3a3a3),hover 变成纯白 + opacity .6(#9e9e9e),active .58(#999999),三态亮度差约 2%。同为 `.x-dimlink` 的 lang 链却是 0.62→1 提亮。非 AC 项,提请确认是否有意(若「dim on hover」是意图,起点已是 .62 使其失效)。
3. 信息 · `.vlink` active 4.65:1 只高于 4.5 阈值 0.15(hover 4.97);纸面色或 active opacity 再动一点即破线。
4. 信息 · reduced 下 `html` 无 `lenis` class(Lenis 关闭)、`[data-plx]` 不写内联 transform;三语首页 docH 13051 / 13215 / 13062 vs 非 reduced 14785 / 14932 / 14806(短约 1.7k px),未查原因,不在本 AC 范围。
5. 信息 · stagger 延迟:rows 61 / 123 / 223ms,cards 83 / 149 / 233ms;`/` 上 header boot 动画 `x-fade` 0.6s + delay 0.4s。

## 结论

PASS 4/4
