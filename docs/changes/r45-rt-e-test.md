# R45 第五/六轮独立黑盒回归(RT-E)

## 环境

| 项 | 值 |
|---|---|
| 被测对象 | 构建产物 `http://localhost:4399/`(未起停任何服务;全程未打 4321) |
| 仓库 | `D:/WORKS/PLAN/nexgrid-website` — 只读(唯一写入 = 本报告) |
| dist 新鲜度 | 开测前 `dist/index.html` 比 `src/`、`scripts/` 全部文件都新,即产物与当前源码一致 |
| 浏览器 | Playwright chromium(借 `Nexion-uniapp/node_modules`),`deviceScaleFactor=1` |
| 画布 zoom 实测 | 1440 视口 → **0.98958**;1455 → **1.00000**;1920 → 1.32292;390/700 → 1.00000。几何量已按「画布 px = 视口 px ÷ zoom」折算并同时给出视口原值 |
| 脚本目录 | `C:/Users/jason/AppData/Local/Temp/claude/D--WORKS-PLAN/42e4397e-0bc4-4987-8cc3-a0bc8464e0bd/scratchpad/rte-*.mjs` |

**方法学声明**:本轮每条像素级 / 监听级判据都先跑**正控**(故意弄坏被测物,看判据是否真报红)。三次正控失灵均被抓出并修正(见「额外发现」E1–E3),**未经正控确认的 0 一律不作结论**。

---

## 逐条 AC

| AC | 结论 | 证据摘要 | 脚本 |
|---|---|---|---|
| AC1 标题行距 | **pass** | 6 组配置 × 15 标题全覆盖,动画期与还原后行距差 **max 0.001px**(阈值 1px) | `rte-ac1c.mjs` |
| AC2 遮罩严实 | **fail** | 后半(终态 = 纯文本)pass;**前半(起滑前不得见墨)fail**:en 2 处、vi 10 处漏墨 | `rte-ac2v3.mjs` |
| AC3 视口重拆 | **pass** | 4 组方向 × 15 标题,行数全对、盒高与纯文本全等、无重叠 | `rte-ac3.mjs` |
| AC4 过渡取消也还原 | **pass** | 切 reduce 后 `.lr-line`=0、textContent=原文、`style.height`='' | `rte-ac4.mjs` |
| AC5 刷新 / 直达不排队 | **pass** | reload 95.7ms、`/#trust` 67.0ms(阈值 ≤200ms);navigate 仍按开场钟 | `rte-ac5.mjs` |
| AC6 翻色底板回落 | **pass** | 峰值 0.95;回落 434.6ms / 429.4ms(阈值 ≤450ms);最低对比度 4.048:1 | `rte-ac6.mjs` |
| AC7 灯箱慢网首开 | **pass** | 0/16/50/100ms 均 760.0 画布 px(阈值 ≥600);全程宽度恒定,图到达跳变 0.00px | `rte-ac7.mjs` |
| AC8 白带上关菜单 | **pass** | 真像素法 36 帧全程 ≥17.9:1;关闭后 0 帧低于 3:1 | `rte-ac8c.mjs` |
| AC9 404 导航 | **pass** | 10 条链接无裸 `#` 锚点;逐个点击 URL 变更且文档真换 | `rte-ac9.mjs` |
| AC10 /nex/ 对比表 | **pass** | 三语 390px 下 scrollWidth=clientWidth=314、越界单元格 0;1440px 表宽 1040.0 画布 px(阈值 ≥520) | `rte-ac10.mjs` |
| AC11 焦点环 | **pass** | 1440 / 1455 / 1920 三档实测环厚均 **2 设备 px**(阈值 ≥2) | `rte-ac11.mjs` |
| AC12 视差层键盘 | **pass** | 第 13 次 Tab 落到 `#how` 第 3 步行内链,等 800ms 后 top=428.2 bottom=472.2(视口 900) | `rte-ac12.mjs` |
| AC13 门自身 | **pass** | verify **8/8**、`.verify-exit.code`=**0**;visual-diff 两次 snap 后 diff = **合计变化 0 个元素** | — |
| AC14 全站 console | **pass** | 34 路由(三语 33 + 404)四类计数全 0,监听灵敏度已正控确认 | `rte-ac14.mjs` |

**PASS 13/14**

---

## AC1 标题行距(pass)

判据:同一标题「动画期每一行 `getBoundingClientRect().top` 之差」与「还原成纯文本后同一位置的行距」相比 ≤1px;还原瞬间宿主高度与下一元素位置不变。

- 覆盖:`/`、`/vi/`、`/zh/` × 1440×900、390×844 = 6 组,每组 **15/15** 个 `[data-lr]` 宿主。
- 每宿主采样:动画期 88–400 帧、还原后 30 帧(远超「≥20 帧」要求)。
- **行距差最大 0.001px**(视口)/ 0.001px(画布)——出现在 vi 1440 的 #5/#6,anim=53.437 vs plain=53.438。其余全部为 0.000。
- 行数:拆行行数与还原后纯文本行数**逐个相等**(如 vi 首屏 h1 3/3、vi #7 3/3)。
- 还原瞬间:宿主 `offsetHeight` 区间宽度 0;`nextEl.offsetTop − (host.offsetTop+offsetHeight)` 区间宽度 0;`document.body.scrollHeight`、footer `offsetTop` 全程恒定;还原后 `style.height` 为空串。
- 此前记录的 en 第 2 行差 23px、vi 差 23/47px **已不复现**。

> 排查留痕:首版脚本用 `getBoundingClientRect` 算「与下一元素的间隙」,报出 vi #2/#13 差 11.875px。回源逐帧核查发现那是**下一元素自身的 reveal 位移**(`.btns.in` 的 matrix ty 由 0.15→0)与跨滚动位置取样所致,**布局量(offsetTop / offsetHeight)在跃迁前后完全恒定**,非站点缺陷(`rte-ac1b.mjs`)。

## AC2 遮罩严实(**fail**)

### 后半:播完终态 == 纯文本渲染 —— pass

- 对照组构造:同一页面用 `Document.prototype.querySelectorAll` 拦 `'[data-lr]'` 返回空数组,`initLineReveal` 直接 return,标题保持纯文本,**其余动画(reveal / 视差 / 叠卡)一律照常**,是干净的同构对照。
- en / vi 各 15 个标题,宿主矩形逐像素比对:**diffPx = 0,rectΔ = 0.00**。
- 灵敏度正控:把参照图真下移 1px 再比 → diffPx = 48941(en)/ 58573(vi),**判据灵敏**。
- 空转基线:plain vs plain2 两次独立运行 → 0。

### 前半:起滑前行盒内不得见墨 —— **fail**

冻结手法(不改仓库,全在浏览器侧):① `#x-bg` 的 `getContext` 返回 null(废 canvas);② 注入 `.lr-inner{transition-delay:9999s !important}` 冻死过渡,`transitionend` / `transitioncancel` 永不到达;③ 精确跳过还原兜底定时器(回调源含 `textContent` 且延时 = 90k+1100)。结果:15/15 宿主**恒停在「`.in` 已加、transform 仍是 translateY(110%)」的起滑前状态**,而周边 reveal / 视差全部正常播完 —— 这正是 AC 要求的取景。

参照组 = 同一冻结态再加 `.lr-inner{visibility:hidden}`(保留布局、只抽掉墨迹)。两组逐像素相减,**差异 = 起滑前肉眼可见的文字墨迹**。

噪声处理:frozen↔frozen2、noink↔noink2 两对独立重跑,**任一有差的像素一律剔除**后再计数。

正控:另跑一版 `.lr-line{clip-path:none !important}`(拆掉遮罩窗),同一判据报出 2099–60784px 的差异 —— **判据确实灵敏**。

| 语言 | 行盒**矩形内**有墨的标题 | 裁切窗内可见墨迹的标题 |
|---|---|---|
| en (`/`) | **#0**(首屏 h1) | #0、#14(页脚字标) |
| vi (`/vi/`) | **#0、#1、#3、#4、#5、#7、#8、#12、#13** | 上列 + #14 |

关键数字(1440×900,双侧噪声掩膜后的净漏墨像素):

| 标题 | en 盒内 / 窗内 | vi 盒内 / 窗内 | 最深探出盒底 |
|---|---|---|---|
| #0 首屏 h1 | **780** / 2143 | **3625** / 8532 | 24.8px 画布 |
| #1 social h2 | 0 / 0 | 34 / 107 | 8.2px |
| #3 how h2 | 0 / 0 | 106 / 212 | 6.5px |
| #4 how p | 0 / 0 | 50 / 127 | 41.0px |
| #5 how h3 | 0 / 0 | 14 / 52 | 8.1px |
| #7 how h3 | 0 / 0 | 17 / 34 | 7.6px |
| #8 path h3 | 0 / 0 | 55 / 110 | 7.4px |
| #12 nex h3 | 0 / 0 | 4 / 10 | 5.6px |
| #13 final-cta h2 | 0 / 0 | 8 / 175 | 6.5px |
| #14 页脚字标 | 0 / **1024** | 0 / **1999** | 28.6 / 29.0px |

目视复核(截图三联:上 = 冻结初始位、中 = 无墨参照、下 = 拆遮罩正控):
`rte-crop-en-t0.png`、`rte-crop-en-t14.png`、`rte-crop-vi-t0.png` —— 冻结帧里 **“NexGrid” 的字腹与 “Let compute flow” 的字头清晰可见**,无墨参照帧为纯净底色。vi 首屏三行的叠音符与字身同样成片透出。

机理(与 `src/styles/tokens.css` 的遮罩定义一致):`.lr-line` 用 `clip-path` 的**负 inset 向外扩**裁切窗 —— Mega 档 `inset(-0.26em -0.05em -0.24em)`、vi 档 `inset(-0.16em -0.05em -0.14em)`、默认档 `inset(0 -0.05em -0.1em)`。`.lr-inner` 起始位只下移 **110%** 行高;当「0.1 × 行高」小于「下缘外扩量」时,字形顶部就落进了裁切窗的可见区。Mega 档最严重:行高 79.6px,下移余量仅约 8px,而下缘外扩 0.24em ≈ 24px,**净可见约 16px**,与实测「最深探出盒底 24.8px 画布」同量级。

复现步骤:

1. 1440×900 打开 `http://localhost:4399/`(或 `/vi/`);
2. 注入 `.lr-inner{transition-delay:9999s !important}`(冻住起滑),并跳过还原兜底定时器;
3. 滚过全页让各标题触发 play;
4. 截图任一标题的行盒区域 ±40px,可见字形墨迹;与 `.lr-inner{visibility:hidden}` 版逐像素相减即得上表。

> 口径说明:AC 原文写「**行盒区域内**不得看见文字墨迹」。en #14 与 vi #14 的墨迹落在行盒矩形之外、但在**向外扩的裁切窗之内**,屏幕上照样看得见;因此上表把两种口径分列。**按 AC 字面(仅行盒矩形内)判定:en fail 1 处、vi fail 9 处**,AC2 前半仍是 fail。

## AC3 视口变化重拆(pass)

四组:en / vi × (1440→700)、(390→1440)。载入后不滚动、立即改视口、等 500ms 再读。

- **行数**:每个已拆行标题的 `.lr-line` 数与「该宽度下同页纯文本」的行数**逐个相等**(含 vi 390→1440 的 #7 拆 3 行 / 纯文本 3 行)。
- **盒子**:拆行态 `offsetHeight` 与纯文本参照**完全相等**(如 vi #7 162=162、en #14 72=72)。
- **重叠**:滚过全页播完后,`host.bottom − next.top` 全部为负(即有正间隙),最小间隙 20px。
- 反向 390→1440 同样全对。

> 判据修正留痕:AC 字面写「宿主 `scrollHeight ≤ offsetHeight + 1`」。实测该式对**纯文本参照**同样不成立(如 en #0:纯文本 139/122;vi #7:纯文本 169/162)—— 因为遮罩改用 `clip-path`(只裁绘制、不裁布局溢出),且 display 档行高小于 1(Mega 0.79)本身就让行内内容溢出内容盒。**该式在本设计下恒不成立、无区分力**,故改用「拆行盒高 == 纯文本盒高」作实质判据,两种数字均列在日志 `rte-ac3-*.log` 中。

## AC4 过渡被取消也还原(pass)

载入 800ms 时 h1 处于拆行态(`.lr-line`=2,transform=translateY(11.05px) 正在滑);经 CDP `Emulation.setEmulatedMedia` 切 `prefers-reduced-motion: reduce`,等 2.5s 后:

- `h1 .lr-line` 数 = **0**
- `textContent` = `"NexGrid\nLet compute flow"`,与 reduced 直载页面**全等**
- `style.height` = `""`(空)
- 残留 class `x-display-mega lr-ready`(`lr-ready` 仅带 `display:flow-root`,AC2 后半已证终态渲染与纯文本逐像素相同)

## AC5 刷新 / 直达不排队(pass)

以 `transitionrun` / `transitionstart`(propertyName=transform)捕获 h1 第一行 `.lr-inner` 的起滑时刻,与 `load` 事件时刻相减:

| 场景 | x-boot | load | 起滑绝对时刻 | **相对 load** | 判定 |
|---|---|---|---|---|---|
| ② `page.reload()` | false | 27.3ms | 123.0ms | **95.7ms** | pass(≤200ms) |
| ③ 直达 `/#trust` | false | 83.6ms | 150.6ms | **67.0ms** | pass(≤200ms) |
| ① 正常 navigate `/` | true | 86.7ms | 629.5ms | 542.8ms | 按开场钟,见下 |

开场钟顺序(navigate):**导航 496.9ms ≤ 标题 629.5ms ≤ 副题 1496.6ms**,与 `tokens.css` 的四拍(导航 0.4s / 标题 boot+0.5s / 副题 1.4s)一致。此前记录的「刷新时 565ms 才起滑」已不复现。

## AC6 翻色底板回落(pass)

rAF 逐帧读 `getComputedStyle(nav,'::before')`,共 996 帧,捕获到 2 个 `flipping` 窗口(进白带 1 次、出白带 1 次)。

| 窗口 | 起点 | 峰值 opacity | 回落到 | 用时 | 判定 |
|---|---|---|---|---|---|
| ① 进白带 | t=5397.3 sy=8266 | **0.95** | 0.7291(目标 0.72±0.01) | **434.6ms** | pass(≤450ms) |
| ② 出白带 | t=8952.1 sy=13728 | **0.95** | 0.6451(目标 0.64±0.01) | **429.4ms** | pass |

全过程文字对比度最低 **4.048:1**(≥3:1),最差点出现在 flipping 峰值处:文字 [12,12,13] 对合成底 [113.6,113.6,114.7]。

> 余量提示:两次回落分别只比 450ms 阈值快 15.4ms / 20.6ms,**余量约 3–5%**,机器慢一档就可能压线。

## AC7 灯箱慢网首开(pass)

CDP `Network.emulateNetworkConditions`(1.5Mbps / 300ms RTT)在页面加载完成后才施加,确保大图确实是「首开时才拉」。

| 采样点 | 实测时刻 | dialog 宽(视口) | dialog 宽(画布) | 图已解码 |
|---|---|---|---|---|
| t≈0ms | 4.3ms | 752.08px | **760.0px** | 否 |
| t≈16ms | 20.8ms | 752.08px | **760.0px** | 否 |
| t≈50ms | 53.5ms | 752.08px | **760.0px** | 否 |
| t≈100ms | 103.6ms | 752.08px | **760.0px** | 否 |

阈值 ≥600 画布 px,全部通过(此前记录的 105px 不复现)。图到达时刻 en 6232.1ms / vi 6226.1ms,**前后宽度 752.08 → 752.08,跳变 0.00px**;全程 841 / 842 帧宽度区间 min = max = 752.08,即**自始至终零跳变**。vi 同结论。

## AC8 白带上关菜单(pass)

390×844 hasTouch,滚到白带中段(sy=8400,nav 处于 `on-light`)后开菜单再关。

**真像素法**(截图取汉堡按钮 44×44 盒内的最亮 / 最暗像素,直接算实际对比,绕开任何合成模型):

| 阶段 | 帧数 | nav class | 盒内实际对比 |
|---|---|---|---|
| before(白带上,菜单关) | 1 | `on-light` | 17.934:1 |
| opening / open-steady | 13 | `on-light menu-open` | 19.552:1 |
| closing | 16 | `on-light menu-switch` → `on-light` | 17.934–18.046:1 |
| closed-steady / closed | 6 | `on-light` | 17.934:1 |

**36 帧全部 ≥17.9:1**,无一帧低于 3:1。目视复核 `rte-crop2.png`:白带上是**黑条压浅底**,菜单开时是**白 X 压深色面板**,两态都高对比。此前记录的「关闭后 8 帧 2.13:1」不复现。

> 取样粒度说明:真像素法受截图速率限制(约 40–80ms / 帧),非 rAF 粒度。作为补充,rAF 粒度的计算法在**关闭之后 139 帧中 0 帧**低于 3:1,与真像素法同向。

## AC9 404 导航(pass)

`http://localhost:4399/404.html` 导航共 10 条链接,`href` 全部为站点绝对路径,**无一条是裸页内锚点**:

`/`(logo)、`/#how`、`/#devices`、`/#trust`、`/learn/`、`/nex/`、`/`(EN)、`/vi/`(VI)、`/zh/`(中文)、`/#download`(Download)。

逐条点击(每条新开一页从 404 出发):10/10 **URL 变更且 document 真被替换**(用页内自置标记 `document.__m` 在跳转后消失来判定,排除只改 hash 不换文档的假跳转)。语言链 `/`、`/vi/`、`/zh/` 正确。

## AC10 /nex/ 对比表(pass)

| 语言 | 390×844:table scrollWidth / clientWidth | 越界单元格(right>390) | 1440×900:表宽 |
|---|---|---|---|
| en | 314 / 314 | 0 | 1029.16px 视口 = **1040.0px 画布** |
| vi | 314 / 314 | 0 | 1029.16px 视口 = **1040.0px 画布** |
| zh | 314 / 314 | 0 | 1029.16px 视口 = **1040.0px 画布** |

390px 下 `scrollWidth ≤ clientWidth + 1` 成立(相等),三列 9 个 th/td 的 `right` 全部 ≤ 390(表右缘 352),文档 `scrollWidth`=390 无横向溢出;外层 `.table-wrap` 的 `overflow-x:auto` 也未产生滚动条(wrapSW = wrapCW = 314)。1440px 表宽 1040.0 画布 px ≥ 520。

## AC11 焦点环(pass)

`chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] })` 经典滚动条模式,`deviceScaleFactor=1`,截图 1px = 1 设备像素。Tab 到导航第一个链接(`<a class="logo x-dimlink">`),对聚焦前后两张截图逐像素求差,差异区即焦点环,再横扫 / 竖扫量环厚:

| 视口 | zoom | 计算样式 outline-width | 差异像素 | **实测环厚(设备 px)** |
|---|---|---|---|---|
| 1440 | 0.98958 | 2.02105px | 812 | 横 **2** / 竖 **2** |
| 1455 | 1.00000 | 2px | 840 | 横 **2** / 竖 **2** |
| 1920 | 1.32292 | 1.51181px | 1092 | 横 **2** / 竖 **2** |

三档均 ≥2 设备 px;此前 1440 处为 1 的问题不复现。

## AC12 视差层键盘(pass)

`#how` 三步中只有第 3 步含行内链(`a.vlink` → `#trust`)。连续 Tab,第 13 次落到该链接:

`A.logo` → `A.x-dimlink` × 8 → `A.xbtn solid dl-btn` → `A.scroll-hint` → `A.xbtn solid on-dark cta` → **`A.vlink`**

等 800ms 后 `getBoundingClientRect()`:**top=428.2、bottom=472.2**,视口高 900,即 `top ≥ 0` 且 `bottom ≤ 900`,**完全在视口内**。

## AC13 门自身(pass)

```
[verify] ✓ forbidden-words / i18n-parity / deploy-gate(warn-only) / anchor-check(src 近似)
[verify] ✓ brand-parity(App V5) / particle-hue(同族 ±6°) / canvas-hazard(静态) / canvas-geometry(运行时)
[verify] 8/8 gates pass
```

`.verify-exit.code` = **0**,无 NOT-RUN。

visual-diff:`snap … 1455` 两次(33 路由)后 `diff`:

```
1455px:配对 4843 个元素,超出 2% 容差的 0 个
合计变化 0 个元素(含消失/新增)
```

> **副作用交底**:`verify.mjs` 第七门 `gate-canvas-geometry.mjs` 无参调用时会自行 `npm run build` 并在随机空闲端口起一个 `astro preview`。这与派单的「禁止 build」相抵触,故本门**放在全部浏览器类 AC 之后才跑**,不影响前面任何测量。跑完后 `dist/` 被重建;`dist/` 在 `.gitignore` 内,工作树未受污染。

## AC14 全站 console(pass)

三语 33 路由 + `/404.html` 共 **34 条**,每条:load → networkidle → fonts.ready → 滚完全页 → 静置。

**`console.error` = 0、`pageerror` = 0、请求失败 = 0、HTTP ≥400 = 0(404 文档自身已豁免)、warning = 0** —— 34/34 全清。

监听灵敏度正控:同一套监听在注入 `console.error` / `console.warn` / `throw` / `fetch('/__rte_missing_probe__')` 后,四类**全部捕获**(error 2、warn 1、pageerror 1、http≥400 1),故上面的 0 是真 0。

---

## 额外发现(与 AC 无关,单列)

- **E1(测试工装,非站点缺陷)**:Playwright `addInitScript` 在本站执行时 `document.documentElement` 尚为 null,导致「MutationObserver.observe 抛错,其后同一脚本内的语句全部不执行」。任何用 `addInitScript` 注入 `<style>` 的探针都会**静默失效并给出全 0 假绿**。本轮 AC2 前三版即栽在此处,已改为「原生 setTimeout 自重试注入 + `window.__styled` 断言,未注入即抛错终止」。
- **E2(测试工装)**:JS 模板字面量里的 `\d` 会被吞成 `d`,使颜色解析正则失效、rAF 采样器整条静默死掉(AC6 首版 0 帧)。已全部改用 `[0-9.]`。
- **E3(测试工装)**:`page.screenshot({fullPage:true})` 对「未滚动到过、reveal 尚未触发」的区域拍到的是**未揭示态**,拿它做遮罩比对会得到「正控也是 0」的假绿。已改为逐标题定点滚动 + 视口截图。
- **E4**:`.site-nav` 在合成计算上不可靠 —— 它未出现在 `document.elementsFromPoint` 的返回栈中(疑与 `pointer-events` 有关),用「元素栈 + ::before」建模会漏掉磨砂底板层,产出虚低的对比度(AC8 首版误报 75 帧 <3:1)。**结论:导航区对比度只能用真像素量,不能用合成模型算**。
- **E5**:vi 首页在 1440 视口下,#5 / #7 / #8 / #9 / #10 / #11 / #12 等标题区域存在**跨运行不确定的少量像素抖动**(同一冻结配置两次独立运行 diff 735px,bbox 稳定复现在同几处)。en 同配置两次运行 diff 为 0。本轮已用双侧噪声掩膜剔除,不影响 AC2 结论(vi 的 9 处漏墨均在掩膜之外),但**vi 侧渲染存在非确定性**这件事本身值得单独查。
- **E6**:`h1` 在拆行态下 `textContent` 是**双份**(视觉隐藏的 `.x-sr` 原文 + 各 `.lr-line` 内的同一段文字),如 `"NexGrid\nLet compute flowNexGrid\nLet compute flow"`。`.lr-line` 带 `aria-hidden="true"` 且 `user-select:none`,故读屏与复制不受影响;仅提示任何按 `textContent` 取值的外部脚本 / 测试会拿到双份。
- **E7**:AC6 两次回落用时 434.6ms / 429.4ms,距 450ms 阈值仅 15–21ms 余量(3–5%)。

---

## 结论

**PASS 13/14** —— 唯一 fail 是 **AC2 前半(起滑前遮罩不严实)**:首屏 h1 在 en 与 vi 均于行盒矩形内漏出字形墨迹(en 780px、vi 3625px),vi 另有 8 个标题同型漏墨,页脚字标两语均在裁切窗内漏墨。AC2 后半(播完终态 == 纯文本)以及其余 13 条 AC 全部通过。
