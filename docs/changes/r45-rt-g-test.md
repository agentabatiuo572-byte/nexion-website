# R45 收线轮 RT-G3 — 独立黑盒回归报告

**结论:PASS 17/19**(1 条 FAIL:AC8;1 条 未能测:AC18 的 `npm run verify` 子项,已给替代证据)

---

## 环境

| 项 | 值 |
|---|---|
| 被测对象 | NexGrid 官网**构建产物**,`http://localhost:4399/`(既有服务,全程未起停、未 build/dev、未触碰 4321) |
| 仓库 | `D:/WORKS/PLAN/nexgrid-website`(只读;唯一写入 = 本报告) |
| 浏览器 | Playwright 1.61.0 chromium(借 `D:/WORKS/PLAN/Nexion-uniapp` 的依赖) |
| 脚本目录 | `C:/Users/jason/AppData/Local/Temp/claude/D--WORKS-PLAN/42e4397e-0bc4-4987-8cc3-a0bc8464e0bd/scratchpad/rtg3-*.mjs` |
| 路由总数 | 33 路由(11 页 × 3 语)+ `/404.html` = 34,全部 HTTP 200 |

### 画布缩放实测(几何折算依据)

页面用 CSS `zoom: calc(min(var(--x-vw,100vw), 1920px) / 1440px)`,画布固定 1440px 宽。**画布 px = 实测 px ÷ zoom**。

| 视口 | 实测 zoom | 换算后导航条高 |
|---|---|---|
| 1455 | **1.000000** | 74.0000 |
| 1440 | **0.989583** | 73.9895 |
| 1366 | 1.000000(≤1439 走 `--u` 缩放,zoom 关闭) | 74.0000 |
| 1920 | 1.322920 | 73.9959 |

与派单给的「1440≈0.9896 / 1455=1」吻合。

### 本轮踩到并绕开的量法陷阱

1. **CSSOM 遍历会漏掉全部样式规则** — 新版 Chrome 里每条 `CSSStyleRule` 都带一个「空但 truthy」的 `.cssRules`(CSS 嵌套),`if (rule.cssRules) { recurse; continue }` 会跳过所有样式规则。首次跑 AC3 时正控(`body`/`.copy`)也返回 0 才暴露。已改为先判 `selectorText !== undefined`,并**每次都带活性正控**。
2. **DOM 读取与截图之间的竞态** — AC8 首轮出现 6 帧「对比度 1.0」,复现后确认是我先读 class、再截图,而 250ms 去抖 OFF 恰好落在两者之间,拿旧文字色比新底板。已加「截图前后各读一次状态,不一致就沉降后重测」。
3. **把背景装饰当成漏墨** — AC17 首轮报 5~14 处漏墨,裁图回看发现是 `#x-bg` 粒子线场;第二轮残留的 2 处是 `position:fixed` 导航条压在行盒上。已用「废 canvas」配方 + 隐藏导航条后重测。
4. **忽略 alpha / opacity 会虚报对比度** — `.lang a{opacity:.62}`、`--x-ink-dim:#ffffff9e` 都会稀释字色。改用「显示文字截图 − 藏文字截图」求差,取差值前 10% 像素(字形芯)的**实渲染色**再算对比度。**AC8 的 FAIL 正是靠这一步才暴露**。
5. **rAF 录制起步晚于事件** — AC19 自然加载时 logo 在首帧绘制前就到了,0 帧可观测;改用 `page.route` 强制延迟 3s 才造出 152 帧的观测窗。

---

## 逐条 AC

| AC | 结论 | 证据摘要 | 脚本 |
|---|---|---|---|
| AC1 品牌标全站一致 | **pass** | 全 dist(HTML/JS/CSS)`<rect>` 计数 = **0**,退役线框标不存在;12 处 `viewBox="0 0 24 24"` 全在商店按钮 | `rtg3-ac1.mjs` |
| AC2 导航 logo 两态 | **pass** | 白带态球体 100% 落 hue 80°,蓝青区 0 px;1x/2x 均 **118.00** 画布 px;0 帧双显 | `rtg3-ac2b.mjs` `rtg3-lockmap.mjs` |
| AC3 页脚记号 | **pass** | PNG,90.00×89.00 画布 px,`aria-hidden="true"`,2x 取 @2x,**0 条 color 声明**(带活性正控) | `rtg3-ac3d.mjs` |
| AC4 读屏只念一次品牌 | **pass** | 导航 logo 链接可及名 = `"NexGrid"`(一次);页脚记号不在 AX 树 | `rtg3-ac3.mjs` |
| AC5 图标全套 | **pass** | 6 个图标全 200 且尺寸正确;`/favicon.svg` 404 且全站 0 引用;JSON-LD → `/icon-512.png` | `rtg3-ac5.mjs` |
| AC6 磨砂真的生效 | **pass** | 11 组 current/control 比值 **0.040–0.069**(≤0.30);`getAnimations()`=0;alpha 0.64/0.72/0.9 | `rtg3-ac6.mjs` |
| AC7 拖滚动条不频闪 | **pass** | ±1 抖 4s → **0 次**;±2 抖 4s → **1 次**;±60 往复 6 次 → **12/12** | `rtg3-ac7b/c.mjs` |
| **AC8 翻色** | **FAIL** | ②③④ 通过;**① 语言链在「亮态 + 底仍是暗页」窗口实测 3.679:1** | `rtg3-ac8a/d/e/fail.mjs` |
| AC9 灯箱 | **pass** | 桌面 `currentSrc`=660w、渲染 527.05 画布 px、首开 **7.7ms**、溢出 **0**;手机落 @2x | `rtg3-ac9.mjs` |
| AC10 404 语言前缀 | **pass** | vi/zh 六条内链全带前缀,语言链恒为 `/` `/vi/` `/zh/`,英文无前缀 | `rtg3-ac10.mjs` |
| AC11 焦点环 | **pass** | 四视口**实测环宽均 2 设备 px**,偏移 ≈2,二者相等 | `rtg3-ac11b.mjs` |
| AC12 行高与对齐 | **pass** | `.idx` 14.3906(=12×1.2);zh `.price` 24.00,卡高差 **0.0000**;导航 74.0000;基线差 **0.0000**(21 卡) | `rtg3-ac12b.mjs` |
| AC13 文章 meta 不拆日期 | **pass** | 36 页 × 2 个 `.nw` = **72/72** `getClientRects().length === 1` | `rtg3-ac13.mjs` |
| AC14 /nex FAQ 与首页全等 | **pass** | 27 项 × 6 组合 = **0 差异**;PoC 字形右缘差 −0.359/−0.656 px | `rtg3-ac14.mjs` |
| AC15 护字层 + 打印 | **pass** | 三处 inset/blur 全等;打印三者 background 透明;打印文字 7.50–21.0 | `rtg3-ac1516/fix1/eff.mjs` |
| AC16 压粒子对比度 | **pass** | 粒子活性已证;9 目标 × 30 帧,**0 帧 <4.5**(有效色最低 7.302) | `rtg3-ac1516/fix1/eff.mjs` |
| AC17 行遮罩 | **pass** | 143 行盒漏墨 **0**;终态 DOM 解包为纯文本节点;行盒 top 差 **0.000** | `rtg3-ac17e/g/j.mjs` |
| AC18 门与 console | **未能测(部分)** | snap diff「合计变化 0」✔;34 路由 error/pageerror/失败请求 **0**(带正控)✔;**`npm run verify` 未跑**(见下) | `rtg3-ac18console.mjs` |
| AC19 慢网 logo | **pass** | 强制延迟造出 **152 帧未到达窗口**,盒子 118×44 全程不变,位移 **0.000 px** | `rtg3-ac19b.mjs` |

---

## FAIL 详情:AC8 ①(每帧文字 vs 底板合成色 ≥4.5:1)

### 现象

导航条处于**亮态(`on-light`)但身后仍是暗色页面**时,底板合成为中灰(≈174–178)而非近白(≈243)。此时非当前语言链(`VI` / `中文`,带 `opacity:.62`)压在该中灰上,对比度跌破 4.5:1。

### 直接实测(状态稳定保持 >1.5s,非瞬态)

量法:同一位置拍两张 —— 显示文字 / `color:transparent` 藏文字;两图求差,取差值前 10% 像素(字形芯)的**实渲染色**,与藏字图的底板均色算对比度。

| 视口 | scrollY | 底板实渲染色 | 字形实渲染色 | 对比度 |
|---|---|---|---|---|
| 1440×900 | 8184 | `[174.2, 174.2, 174.3]` | `[79.3, 79.3, 80.2]` | **3.679** ✗ |
| 1455×900 | 8255 | `[178, 178, 178]` | `[80.6, 80.6, 81.0]` | **3.767** ✗ |

同帧其它导航文字正常:`How it works`(opacity 1)7.717 / 8.296;当前语言 `EN`(opacity 1)8.429 / 8.211。
证据图:`scratchpad/rtg3-ac8fail-1440-text.png`(肉眼可见 VI / 中文 明显发虚,EN 清晰)、`rtg3-ac8fail-1440-plate.png`。

### 逐帧扫描(1440×900,有效合成色,504 有效帧)

| 方向 | 每帧步长 | <4.5 帧数 | 最低对比度 |
|---|---|---|---|
| 进白带 | 33 px | 0 | 5.289 |
| 进白带 | 5 px | 0 | 4.817 |
| 进白带 | 2 px | **2** | 4.453 |
| 出白带 | 33 px | **4** | 4.106 |
| 出白带 | 5 px | **10** | 4.106 |
| 出白带 | 2 px | **21** | 4.106 |

合计 **37 / 504 帧 < 4.5**。即使完全沉降到纯白带(底板 243),该元素仍只有 **4.881** —— 全站最紧的余量。

### 成因(读页面内联翻色逻辑)

```js
n = nav.classList.contains('on-light') ? 24 : 0;      // 已亮 → 触发带外扩 ±24px
r ? f(true)                                            // 变亮:立即
  : d ||= setTimeout(() => f(false), 250);             // 变暗:去抖 250ms
```

「立即开、延迟关 + 24px 迟滞」制造出一个**稳定**窗口:`on-light` 已锁存,而白带尚未移到导航条身后。此时 `::before` 是 `rgba(242,242,242,0.72)` 压在暗页上 → `0.72×242 + 0.28×12 ≈ 177`。暗字 × 0.62 不透明度 ≈ 79,对 177 只有 3.68:1。

> 注:AC7 的抗抖动(0/1 次翻转)正是靠同一套迟滞拿到的 —— **两条 AC 指向同一机制的两面**,修 AC8 时需同时回归 AC7。

### 复现步骤

1. 1440×900 打开 `http://localhost:4399/`
2. 向下滚过 y≈8500,让导航条锁存 `on-light`
3. 回滚到 scrollY ≈ **8175–8186**(白带顶缘落在导航条下缘再往下约 12px)
4. 导航条保持亮态,身后仍是暗页,底板呈中灰
5. 量 `#nav-menu .lang a:not(.active)`(VI / 中文)对底板 → **3.68:1**

---

## 未能测详情:AC18 的 `npm run verify`

`npm run verify` → `scripts/verify.mjs` 第 8 门 `gate-canvas-geometry.mjs` **不带参数** spawn,而该脚本在没有 `--reuse` 时会执行 `npm run build` 并另起 `astro preview`(其自带注释:「本门要构建+起预览+真渲染」)。这与派单硬约束「禁止起/停服务、禁止 build/dev」直接冲突,且重建会覆盖我正在回归的 `dist/`,使 AC1–AC17 的全部测量作废。**我没有跑它**,也没有自行放宽约束。

替代证据(均不触发 build):

* 单独对**在跑的产物**执行第 8 门:
  `node scripts/gate-canvas-geometry.mjs --reuse 4399 --no-build` → **exit 0**
  `[geo] ✓ 画布几何:33 路由 × {390,1024,1440,1920,2560} + 断点两侧 {768,860,900,1080,1439} 七判据全过(A画布/B溢出/C等比/D冻结/E可读/F触达/G连续;最小字号样本 36;滚动条:经典(占位);实测服务 http://localhost:4399)`
* 门总数确认为 **8**(`canvasUnitGate` + 7 处 `results.push`):forbidden-words / i18n-parity / deploy-gate / anchor-check / brand-parity / particle-hue / canvas-unit / canvas-geometry。
* `.verify-exit.code` 当前为 **0**,但这是**我未参与的历史运行留下的文件**,不构成本轮背书,按「跳过 ≠ 放宽」记为未测。

AC18 另外两个子项均已实测通过:

* **同产物两次 snap 后 diff**:`visual-diff.mjs snap http://localhost:4399` 跑两次(各 6 宽 × 33 路由 = 198 快照;两文件均 1,704,904 字节),diff 结果 390px 3802 配对/0 超差、768px 3847/0、1024px 4384/0、1440px 4549/0、1920px 4549/0、2560px 4549/0 → **「合计变化 0 个元素(含消失/新增)」**
* **console**:34 路由全 200,`console.error` **0**、`pageerror` **0**、`requestfailed` **0**、HTTP≥400 **0**、warning **0**(warning 一条未出现,故无全文可录)。监听器活性已用正控验证:故意制造的 4 类信号(console.error / console.warn / throw / 坏请求)全部被捕获。

---

## 各 AC 关键原始数

**AC2** 白带态圆盘取样(显示位图的 x∈[0,41) 区域):dsf1 强饱和 386 px 全落 hue 桶 80°,均色 `[130,173,31]`;dsf2 1597 px 全落 80°,均色 `[126,170,22]`;hue 180–200° 计数 **0**。两图 `filter:none` `mix-blend-mode:normal`。翻转录制 dsf1 511 帧 / dsf2 505 帧,各 2 次 class 翻转,双显帧 **0**。

**AC6** 详表(current / control / 比值):

| 场景 | current | control | 比值 |
|---|---|---|---|
| 首页 en 黑区 @1455 | 0.0959 | 1.4105 | 0.068 |
| 首页 vi 黑区 @1455 | 0.0752 | 1.3830 | 0.054 |
| 首页 zh 黑区 @1455 | 0.0573 | 1.2916 | 0.044 |
| /learn/ @1455 | 0.0852 | 1.3689 | 0.062 |
| /nex/ @1455 | 0.0472 | 0.7416 | 0.064 |
| 首页 en 黑区 @1440 | 0.0803 | 1.5143 | 0.053 |
| 首页 vi 黑区 @1440 | 0.0880 | 2.1513 | 0.041 |
| 首页 zh 黑区 @1440 | 0.0581 | 1.4499 | 0.040 |
| /learn/ @1440 | 0.0901 | 1.2986 | 0.069 |
| /nex/ @1440 | 0.0404 | 0.7178 | 0.056 |
| 白带位 @1455 | 0.0244 | 0.4214 | 0.058 |

无一组两边同为 0,故「不适用」判定未触发。指标为导航条带内相邻像素亮度差均值(高频能量),模糊正是削高频。

**AC8 ②③④**:6 组(3 速 × 2 向)实际步长精确命中 33/5/2 px、帧间 16.7ms。② 每次翻转底板/文字/logo **同帧**换态且落位正确,**0 例外**。③ alpha 回到 0.64/0.72 用时 398.9 / 400.3 / 400.4 / 399.0 / 399.9 / 416.3 ms,全 ≤450。④ 翻亮帧沿导航下缘往下 30 行全为 242,**暗夹层 0 行**。

**AC10 逐条 href**:

| 路由 | 六条内链 | 语言链 |
|---|---|---|
| `/vi/no-such/` | `/vi/#how` `/vi/#devices` `/vi/#trust` `/vi/learn/` `/vi/nex/` `/vi/#download` | `/` `/vi/` `/zh/` |
| `/zh/nope/` | `/zh/#how` `/zh/#devices` `/zh/#trust` `/zh/learn/` `/zh/nex/` `/zh/#download` | `/` `/vi/` `/zh/` |
| `/404.html` | `/#how` `/#devices` `/#trust` `/learn/` `/nex/` `/#download` | `/` `/vi/` `/zh/` |
| `/no-such-en/` | 同上,无前缀 | `/` `/vi/` `/zh/` |

**AC11** 规则 `outline: calc(2.05*var(--uc)) solid var(--x-accent-ink)`,offset 同值。计算值 × zoom:1440 `2.02105×0.989583=2.000`;1455 `2×1=2.000`;1366 `2×1=2.000`;1920 `1.51181×1.32292=2.000`。像素实测环带四视口均 **2 设备 px**,环外缘到元素盒 ≈2 px。

**AC17** 脚手架活性:强制静止态后实测 `translateY ÷ 内层高 = 1.1000`,`.in` 与 `.lr-open` 均不存在,clip 为闭合 `inset(0 -.05em .3em)`;`#x-bg` `getContext` 返回 null 已核(`ctxNull:true`)。143 行盒漏墨 0。终态解包证据(六组一致):

```
揭示中: <span class="x-sr">NexGrid</span><span class="lr-line lr-open" aria-hidden="true"><span class="lr-inner">…
4s 后 : NexGrid          childElems=0  hasLine=false  hasInner=false
行盒   : {x:677, y:351.156, w:723, h:94.797} —— 解包前后完全一致(无回流)
```

**AC19** 自然加载资源计时:`/logo-lockup-dark.png` 346.4ms 发起 → 842.7ms 结束(耗时 496.3ms),`logo-lockup-light.png` 346.4 → 814.8ms;首帧可见 874.9ms。因 logo 早于首帧绘制到达,自然场景 0 帧可观测,故用 `page.route` 强制延迟 3000ms(结束点 3357.4ms)造出 **152 帧未到达窗口**;窗口内外 `.logo` 盒 118×44、图 118×40、导航高 74、位置 x=40 y=30 完全一致,各维度 maxShift **0.000 px**。

---

## 额外发现(与 AC 判定分开)

1. **vi/zh 的 404 页语言身份自相矛盾** — `/vi/no-such/`、`/zh/nope/` 的六条导航内链正确带前缀,但文档是 `<html lang="en">`、标题 `404 — NexGrid`,且语言切换器把 **EN** 标成 `class="active" aria-current="true"`。即导航说「你在 VI」,语言控件说「你在 EN」。AC10 按字面通过,但读屏与视觉都会读到冲突的当前语言。

2. **同页导航 logo 与页脚法务链丢语言前缀** — 上述两页 logo 指向 `/`(英文首页),页脚法务链为 `/legal/privacy/`、`/legal/terms/`,而 `/vi/legal/privacy/`、`/zh/legal/privacy/` 是存在的。不在 AC10 列举范围内。

3. **AC8 ③ 余量偏薄** — alpha 回落 398.9–416.3ms 对 450ms 上限,最坏仅剩 ~34ms。机制是两段 200ms 串联(`.flipping` 持 alpha=1 共 200ms,再走 0.2s 过渡回落),任一常数上调即破线。

4. **设备卡实为 7 张/语(共 21 张),AC12 文案写的是 6 卡** — Phone / Cloud Share / NexGridBox S1 / Pro / Pro v2 / NexGridRack P1 / P2。我按 21 张全量量了基线,全为 0.0000;数量口径请以实现为准更新 AC 文案。

5. **`getAnimations()` 不能用来判粒子是否在跑** — `#x-bg` 在 `/` 上返回 1、在 `/404.html` 上返回 **0**,但逐帧像素差显示两处粒子都在动(`/`:212/883/443/283/687;`404`:70/39/75/241/158)。404 的粒子由 rAF 驱动而非 Web Animations API。任何拿 `getAnimations()` 当活性判据的门会把 404 误判成静止。

6. **AC14「27 项」的口径** — 派单未列举是哪 27 项,我取的是:details 7 项(borderTopWidth/Style/Color、borderBottomWidth、paddingTop/Bottom、backgroundColor)+ summary 7 项(display、alignItems、gap、cursor、paddingTop/Bottom、listStyleType)+ `.idx` 5 项 + `.q` 5 项 + `.mark` 3 项 = 27。若原意的 27 项另有清单,此条需按该清单重跑。

---

**PASS 17/19**
