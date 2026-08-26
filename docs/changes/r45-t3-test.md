# R45 · T3 黑盒验收:导航磨砂底板 / 翻色同步 / 手机菜单 / 触达

独立 tester(r45-t3),只按 AC 实测构建产物,未读实现。

## 环境

- 对象:`http://localhost:4399/` 构建产物(未起停服务、未 build);路由 `/`、`/vi/`、`/zh/`、`/learn/` 均 200。
- 工具:Playwright 1.61.0 / Chromium 149.0.7827.55(借 `Nexion-uniapp` 依赖),headless;rAF 实测 16.67 ms/帧(60 fps)。
- 脚本(`C:/Users/jason/AppData/Local/Temp/claude/D--WORKS-PLAN/42e4397e-0bc4-4987-8cc3-a0bc8464e0bd/scratchpad/`):`t3-probe.mjs`(结构探针)、`t3-ac1-frost.mjs`、`t3-ac2-flip.mjs`、`t3-ac3-menu.mjs`、`t3-ac4-touch.mjs`、`t3-diag.mjs`(横屏菜单滚动诊断 + 其它路由);各自 `.log` 同目录。
- 脆性处理:滚动全用 `mouse.wheel` + ≥1.8 s 等待再量;等 `fonts.ready` + `networkidle`;对比度全部由计算样式算 WCAG 比,不用截图;手机菜单用 `isMobile:true, hasTouch:true` context,点按用 `page.tap` / `touchscreen.tap`。
- Chromium 149 标准化 zoom:`getBoundingClientRect` 出视觉(屏幕)px,`getComputedStyle` 出画布 px。`.x-canvas` zoom:1440 → 0.989583;1024 / 390 → 1。导航 `header.site-nav` 也在 zoom 内(链接盒高 44 画布 px = 43.53 屏幕 px)。

### 对比度算法

- 底板色 `plate = α·before_bg + (1-α)·behind`(sRGB 逐通道,非预乘)。
- `behind`:取 `document.elementsFromPoint(文字中心)` 栈里第一个**不在 `.site-nav` 内且 background-color alpha>0** 的元素的背景色。实测黑区命中 fixed 背景 `canvas#x-bg` = rgb(12,12,13),白带命中 `div.band-light.x-invert.curtain` = rgb(242,242,242),与 AC 假定值一致(表里同时给「假定值」算出的 CR 作对照)。
- `CR = (L_hi+0.05)/(L_lo+0.05)`,L 为 sRGB 相对亮度。
- AC2 逐帧 `behind`:该帧白带 `getBoundingClientRect().top ≤ 链接文字中心 y(51.8)` 取 #f2f2f2,否则 #0c0c0d;另给「恒黑 / 恒白」两种假定下的最小 CR 做敏感性。

## AC 表

| AC | 结论 | 证据摘要 | 脚本 |
|---|---|---|---|
| AC1 导航底板半透明磨砂 | **pass** | `::before` `blur(14px) saturate(1.15)`;bg alpha 0.64(黑区)/ 0.72(`.on-light`);黑区 3 位 × 7 文字 CR 19.55,白带 3 位 × 7 文字 CR 17.47;`::after content:none`;全页无幕布 | `t3-ac1-frost.mjs` |
| AC2 翻色同步 | **fail**(同步 + 时长达标;过渡中段对比度 <3:1) | 4 次(进 / 出 × 快 / 慢)起点差均 0 帧,时长 233–234 ms(14 帧);过渡最低 CR 1.18(进)/ 1.25(出),每向连续 3 帧 <3 | `t3-ac2-flip.mjs` |
| AC3 手机菜单 | **fail**(横屏 844×390 en/vi 菜单滚不到下载键;其余 14 项 × 7 组全过) | 见下 | `t3-ac3-menu.mjs` + `t3-diag.mjs` |
| AC4 触达 | **fail**(`.vlink` 命中高 43.39 画布 px < 44) | 链接 1024:+12.00 ✓;1440:+11.88 屏幕 px(= 12.00 画布 px);`.vlink` 三视口均 43.39 画布 px;段落未被撑高 | `t3-ac4-touch.mjs` |

## AC1 明细(1440×900,`/`)

白带 `.x-invert` 文档坐标 8260.2 – 13729.4;抽样 scrollY:黑区 0 / 2500 / 6000,白带 8560 / 10995 / 12829(wheel 到位后实测 scrollY 与目标一致)。

| 态 | navClass | `::before` backdrop | `::before` bg | 文字色 | behind(elementsFromPoint) | plate | CR(7 元素同值) |
|---|---|---|---|---|---|---|---|
| 黑区 ×3 | `site-nav` | blur(14px) saturate(1.15) | rgba(12,12,13,0.64) | rgb(255,255,255) | `canvas#x-bg` rgb(12,12,13) | rgb(12,12,13) | 19.55 |
| 白带 ×3 | `site-nav on-light` | blur(14px) saturate(1.15) | rgba(242,242,242,0.72) | rgb(12,12,13) | `div.band-light.x-invert.curtain` rgb(242,242,242) | rgb(242,242,242) | 17.47 |

7 元素 = `.links a` ×5(How it works / Devices / Trust / Learn / NEX)+ `.clock` + `.logo span`。

幕布扫描(黑区与白带各一次):`.site-nav::after` content none、bg 透明;`.site-nav` 自身 bg 透明;nav 子孙(含各自 `::before/::after`)无 ≥90% 宽的不透明底;nav 之外与导航带重叠的 fixed/sticky 不透明元素只有 `canvas#x-bg`(z-index 0、全屏 900 高的页面背景画布,不是导航幕布)。

其它路由顶部(`t3-diag.mjs`):`/vi/`、`/zh/`、`/learn/` 的 `::before`/`::after`、`transition`(nav `color 0.25s`,`::before` `background-color 0.25s`)与首页一致;`/learn/` 无 `.x-invert`,不存在翻色路径。

## AC2 明细(1440×900,`/`,rAF 逐帧)

| 跑 | 起点 scrollY | wheel | class 翻转帧(bandTop) | color 起点 / 终点 | bg 起点 / 终点 | 起点差 | 时长 | 最低 CR(帧) |
|---|---|---|---|---|---|---|---|---|
| 进(快) | 8026 | +420 | f21(49.2) | f22 / f36 | f22 / f36 | 0 帧 | 233.9 ms(14 帧) | **1.18**(f25) |
| 出(快) | 8446 | −420 | f26(102.2) | f27 / f41 | f27 / f41 | 0 帧 | 234.2 ms | **1.25**(f30) |
| 进(慢) | 8146 | +120 | f20(68.2) | f20 / f34 | f20 / f34 | 0 帧 | 233.4 ms | **1.18**(f23) |
| 出(慢) | 8266 | −120 | f30(88.2) | f30 / f44 | f30 / f44 | 0 帧 | 232.6 ms | **1.26**(f33) |

进白带(快)中段原始帧:

```
f23 text=rgb(218,218,218) bg=rgba(51,51,52,.65)    behind=light plate=118,118,119 CR=3.25
f24 text=rgb(183,183,184) bg=rgba(86,86,87,.663)   behind=light plate=139,139,139 CR=1.71
f25 text=rgb(147,147,147) bg=rgba(121,121,122,.675) behind=light plate=160,160,161 CR=1.18
f26 text=rgb(115,115,116) bg=rgba(151,151,152,.686) behind=light plate=180,180,180 CR=2.27
f27 text=rgb(89,89,90)    bg=rgba(175,175,175,.694) behind=light plate=196,196,196 CR=3.99
```

- 同步性、时长:**达标**(4 次全 0 帧差、14 帧 ≈ 0.233 s,在 0.2–0.3 s 内);`.links a` / `.logo span` 每帧颜色与 `.site-nav` 完全一致(0 帧不同)。
- 每帧 ≥3:1:**不达标**。每个方向都有连续 3 帧(≈50 ms)CR 在 1.2–2.7 之间;敏感性:无论 behind 恒黑还是恒白,最小 CR 都在 1.06–1.26,不是 behind 估算造成的。
- 结构性说明(供判断,不是修法):文字 L 从 1.0 → 0.005、底板 L 从 0.008 → 0.8 在同一 0.25 s 内单调对穿,按连续性必有一帧两者相交(CR→1)。「起点同帧 + 各 0.25 s 线性渐变」与「任一帧 ≥3:1」在物理上不能同时成立;要保 3:1 只能让翻色接近瞬时(step)或错开两者的曲线。这是 AC 之间的冲突,需要主人定取舍。

复现:1440×900 打开 `/`,wheel 到 scrollY≈8026,再 wheel +420;rAF 记录 `.site-nav` color 与 `::before` background-color,合成到 #f2f2f2 后算 CR,f24–f26 <3。

## AC3 明细(`isMobile + hasTouch`;390×844、768×1024、844×390 × `/` `/vi/`,另加 390×844 `/zh/`,共 7 组)

| 检查项 | 390 en | 390 vi | 390 zh | 768 en | 768 vi | 844×390 en | 844×390 vi |
|---|---|---|---|---|---|---|---|
| tap 汉堡 → `aria-expanded=true`(`#nav-menu` fixed 全屏 z 55) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 菜单矩形 13×13 网格 169 点 `elementFromPoint` 全在 `.site-nav` 内(0 点落到外面) | ✓ 111 空白 | ✓ 101 | ✓ 133 | ✓ 145 | ✓ 141 | ✓ 128 | ✓ 108 |
| 空白处真实 tap 不导航(marker 存活、href 不变、0 次 framenavigated、菜单仍开) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| LOGO 位置 tap 不导航(该点顶层 = `#nav-menu`,logo `visibility:hidden`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 汉堡两杠 transform:`matrix(.707,.707,-.707,.707,0,4)` = 45°、`matrix(.707,-.707,.707,.707,0,-4)` = −45° | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 菜单开着 `mouse.wheel(600)` 后 scrollY 0→0 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| (加测)CDP 真触摸上滑 scrollY 0→0 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `.dl-btn` 可进入视口 | ✓ 已在视口(top 466 / 844) | ✓ | ✓ | ✓(466 / 1024) | ✓ | **✗** | **✗** |
| Tab:末项 → 汉堡 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Shift+Tab:首项 → 汉堡 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 从汉堡连按 12 次 Tab 不落到菜单外,且 9 个可聚焦项全访问到 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Esc → `aria-expanded=false`、`activeElement` = `.menu-toggle`、菜单 display none | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 关闭后 wheel(400) 页面恢复滚动(scrollY=400) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 白带上 `.on-light`:`.menu-toggle` color = `.site-nav` color = rgb(12,12,13),两杠 bg 亦同 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

Tab 轨迹样例(390 en):How it works > Devices > Trust > Learn > NEX > EN > VI > 中文 > Download > **menu-toggle** > How it works > Devices。

**fail:横屏 844×390(en、vi 同)菜单无法用滚轮 / 触摸滚到下载键。**

- 现象:菜单打开后 `#nav-menu` 是滚动容器(`overflow-y:auto`、scrollHeight 546 / clientHeight 390、`overscroll-behavior:contain`),`.dl-btn` rect top 466 > innerHeight 390。在菜单上 `mouse.wheel(800)` → `#nav-menu.scrollTop` 仍 0;CDP 真触摸从 y=320 上滑到 80 → 仍 0;只有程序 `scrollIntoView` 能把它推进视口(top 342)。
- 诊断(`t3-diag.mjs`):在 `#nav-menu` 上派发可取消的合成 `wheel` 与 `touchmove`,`defaultPrevented` 都为 **true**;`html` 带 `lenis-stopped`、`overflow:hidden`。即锁页逻辑把菜单容器自己的滚动也一并取消了。触屏 context 与桌面 context 结果相同。键盘 Tab ×9 能聚焦到 `.dl-btn` 并把菜单滚到 scrollTop 156(浏览器聚焦自动滚),所以只有键盘用户能到。
- 复现:844×390 `isMobile+hasTouch` 打开 `/` → tap `.menu-toggle` → 在菜单区域手指上滑或滚轮 → 下载键始终在视口外。

## AC4 明细

链接命中盒(`.links a` 5 个,`getBoundingClientRect().width` − `Range.getBoundingClientRect().width`,计算样式 `padding:0 6px; margin:0 -6px`):

| 视口 | zoom | 盒宽 − 文字宽 | 结论 |
|---|---|---|---|
| 1024×900 | 1 | 5 个全 +12.00(盒高 44) | ✓ |
| 1440×900 | 0.989583 | 5 个全 +11.88 屏幕 px(= 12.00 画布 px;盒高 43.53 屏幕 = 44 画布) | 按 AC 字面差 0.12 屏幕 px,实为 zoom 缩放,CSS 侧 6px×2 足额;记边缘通过 |
| 390×844 | 1 | 链接 display 有但宽 0(汉堡态隐藏) | 不适用 |

`.vlink`(How 第 3 步「How earnings are verified →」,`display:inline-block; padding:13px 0; margin:-13px 0; line-height:17.4px; font-size:12px`):

| 视口 | rect 高(屏幕) | offsetHeight | 画布高 = 屏幕 ÷ zoom | ≥44? |
|---|---|---|---|---|
| 1440 | 42.94 | 43 | **43.39** | ✗ |
| 1024 | 43.39 | 43 | **43.39** | ✗ |
| 390 | 43.39 | 43 | **43.39** | ✗ |

13 + 17.4 + 13 = 43.4 画布 px,差 0.6 px。

段落未撑高:所在 `p.x-mono.body` 高 34.44(1440,2 行)/ 52.17(1024,3 行)/ 34.78(390,2 行);把 `.vlink` 的 padding/margin 临时置 0 后段落高度**不变**(撑高 0);同节相邻 `.body` 高度按行数一致(1024 下第 2、3 段都是 3 行 52.17,第 1 段 2 行 34.78)。这半条 ✓。

复现:任意视口打开 `/`,`document.querySelector('#how .vlink').getBoundingClientRect().height / zoom` = 43.39。

## 额外发现(不计入 AC)

1. **下载键无障碍名 = 标签 ×3**:`#nav-menu .dl-btn` 直接子 span 3 个(`.xbtn-ghost/.xbtn-a/.xbtn-b`)都没有 `aria-hidden`,按钮也无 `aria-label`,textContent 为「Download →Download →Download →」(vi / zh 同),读屏会读三遍。三语均如此。
2. **翻色触发点随滚速漂移、进出不对称**:进白带时 class 在白带 top ≈ 49–68 px(导航下半)翻,出白带时在 ≈ 88–102 px(已低于导航底 74)翻;慢推与快推差 19 px。不违反 AC,但意味着触发边不是固定几何边。快进时翻色的头 1–3 帧 behind 仍是黑区(CR 5.4–16.5,无害)。
3. 在白带上打开菜单:nav 得到 `menu-open`,菜单底 rgb(12,12,13),链接与汉堡转白——与黑菜单一致,正常。
4. 锁页释放正常:7 组 Esc 之后 wheel(400) 都回到 scrollY 400。
5. 1440 下链接 +11.88 屏幕 px 是 zoom 造成的量纲差(见 AC4),若 AC 想按屏幕 px 卡 12,需把 6px 侧 padding 提到 6.1px 或改用画布 px 判据。

## 结论

**PASS 1/4**(AC1 pass;AC2 / AC3 / AC4 fail)。

- AC2 fail 是「同步 0.25 s 渐变」与「每帧 ≥3:1」两条 AC 之间的物理冲突(同步与时长本身达标),需要主人在「接受 ≈50 ms 低对比」和「改成瞬时翻色 / 错开曲线」之间拍板。
- AC3 fail 是真缺陷:横屏手机打开菜单摸不到下载键(触摸与滚轮都被锁页取消)。
- AC4 fail 是 0.6 px 的数值差(43.39 < 44),段落未撑高这半条已过。
