# R45 第七/八轮 RT-F 独立黑盒回归实测报告

独立黑盒 tester,只按 AC 逐条实测,不看实现叙述。**PASS 14/17**(AC4 / AC6 / AC10 判 fail)。

## 环境

| 项 | 值 |
|---|---|
| 被测对象 | 构建产物 `http://localhost:4399/`(`astro preview --port 4399` 服务 `dist/`,PID 3612,全程未起停) |
| 浏览器 | 借用 `D:/WORKS/PLAN/Nexion-uniapp` 的 playwright 1.61.0(chromium,headless,deviceScaleFactor 1) |
| 脚本目录 | `C:/Users/jason/AppData/Local/Temp/claude/D--WORKS-PLAN/42e4397e-0bc4-4987-8cc3-a0bc8464e0bd/scratchpad/rtf-*.mjs` |
| 画布 zoom | 1440 视口实测 0.98958;1366 视口 1.0(几何一律同时给屏幕 px 与画布 px) |
| 仓库改动 | 无。`git status` 与开测前一致(列出的 M/?? 全是既有 R45 工作);`.verify-exit.code` 未被我改写 |

### 三条方法学前置(先证工具,再信结论)

1. **截图色彩保真已标定**(`rtf-calib.mjs`):白带 computed `rgb(242,242,242)` → 截图像素 `rgb(242,242,242)`;暗底 computed `rgb(12,12,13)` → 截图像素 `rgb(12,12,13)`。**本机本次未出现「无头强制暗色」**,故亮区像素测量可信;即便如此,AC4 仍按 AC 指定的 computed 口径算,像素只作交叉验证。
2. **「冻结标题」必须用 `page.clock.pauseAt`,不是 `clock.install`**。首轮 AC1 用 `install()` 跑出 44/84 漏墨——复核发现 `install()` 单独并不停表,`play` 照常执行,我量到的是**动画中间帧**。改 `pauseAt` 后 `performance.now()` 恒定、15 个宿主全部停在起滑前,漏墨归 0。**该轮 44 条全部作废,未写进结论。**
3. **每个像素判据都带空控**:同一状态连拍两张先比对,差 ≠ 0 即判该样本无效。AC1 全部 90 个样本空控均为 0。

---

## 逐条 AC

| AC | 结论 | 关键数字 | 脚本 |
|---|---|---|---|
| AC1 起滑前不漏墨 | **pass** | 90/90 宿主漏墨 0 px,maxΔ 0;空控 0/90;正控 437–8013 px | `rtf-ac1.mjs` |
| AC2 播完终态=纯文本 | **pass** | 30/30 像素差 0,rect 全等,终态无 `.lr-line`/`.x-sr` | `rtf-ac2.mjs` |
| AC3 标题行距 | **pass** | 45/45;行距 Δ max **0.00 px**;还原窗 21 帧 offsetHeight/nextTop 恒定 | `rtf-ac3.mjs` / `rtf-ac3b.mjs` |
| AC4 翻色 | **fail(③)** | ①最低 **6.401:1**、0 帧 <4.5 ②六次全部同帧换态 ③opacity 回落 **445.3–595.1 ms**,≤450ms 仅 2/18 | `rtf-ac4.mjs` / `rtf-ac4c.mjs` |
| AC5 迟滞 | **pass** | ±20×12 → 翻转 **1** 次(≤4);±60×6 跨窗停位 → 12/12 正常翻转 | `rtf-ac5.mjs` / `rtf-ac5b.mjs` |
| AC6 灯箱整张可见 | **fail(宽度)** | 无盒内滚 ✓、图完整在视口 ✓、到图跳变 Δ=0.00 ✓、加载态 ✓;但盒宽 **559.83 / 466.06 px < 600** | `rtf-ac6.mjs` / `rtf-ac6b.mjs` |
| AC7 页脚版权行 | **pass** | 40 帧最低 **7.087:1**(/)、**7.527:1**(/zh/),0 帧 <4.5;护字层超宽 48.3 画布px ≤60 | `rtf-ac7.mjs` |
| AC8 404 页 | **pass** | 标题 18.8–19.6:1、说明 7.0–7.7:1,0/30 帧 <4.5;title/lang/字体/字号全中 | `rtf-ac8.mjs` |
| AC9 打印 | **pass** | 对比度 5.425–21:1(10 个目标全过);`[data-tw]` 35/35 文本相符;`[data-rv]` 35/35 opacity 1 | `rtf-ac9.mjs` |
| AC10 FAQ 同规格 | **fail(1 项)** | 27 项里 26 项全等;**答案 `max-width` 首页 760px vs /nex 680px**;PoC 记号 0.42/0.00 px 对齐 | `rtf-ac10.mjs` / `rtf-ac10b.mjs` |
| AC11 文章页转化键 | **pass** | 18/18 页箭头 `rgb(10,10,10)`=按钮字色,对底色 **11.98:1**;相关行箭头 = `--x-ink-dim` | `rtf-ac1112.mjs` / `rtf-ac111314.mjs` |
| AC12 相关文章尺子 | **pass** | 五项尺子全等;标签→首线 9.89 px 两处相同(Δ0.00);h1→meta **13.99 画布px** | `rtf-ac1112.mjs` |
| AC13 文档滚动锁 | **pass** | 灯箱/菜单/计数式/收尾可滚 四条在两视口全过 | `rtf-ac111314.mjs` |
| AC14 锚点历史 | **pass** | 连点 4 次 Δ=**1**;三个不同锚点各 +1 且 hash 正确;Ctrl+点击当前页 URL 不变、Δ=0 | `rtf-ac111314.mjs` |
| AC15 视差焦点 | **pass** | ①Tab 后 top=534.2/bottom=578.1(视口 900)完全在内 ②鼠标点击 Δ=**0 px**,`:focus-visible`=false | `rtf-ac15.mjs` / `rtf-ac15b.mjs` |
| AC16 门自身 | **pass** | verify **8/8**、`.verify-exit.code`=**0**;同产物两次 snap → **合计变化 0**;变异点名 169 键并计入总数 | `rtf-ac16mut.mjs` + 直跑 |
| AC17 全站 console | **pass** | 34 路由(sitemap 33 + 404.html):error 0 / pageerror 0 / 失败请求 0 / HTTP≥400 0 / **warning 0** | `rtf-ac17.mjs` |

---

## 三条 fail 的细节与复现

### AC4 ③ — 翻色后 opacity 回不到 450ms 以内

**判据**:翻色后 ≤450ms 内 `.site-nav::before` opacity 回到 0.64/0.72。
**实测**(`rtf-ac4c.mjs`,进/出白带 × 三档滚速 × 各 3 轮 = 18 次):

| 穿越 | 步长 | `.flipping` 摘除 | 到达 \|Δ\|<0.02 | <0.005 |
|---|---|---|---|---|
| enter | 33px | 267.6–267.7 | 450.1–450.9 | 467.5–467.8 |
| enter | 5px | 265.7–266.8 | 449.4–450.1 | 465.5–467.0 |
| enter | 2px | 266.2–267.3 | 433.0–450.5 | 448.9–467.2 |
| exit | 33px | 246.2–256.5 | 410.6–423.4 | 445.3–457.7 |
| exit | 5px | 325.4–345.0 | 517.7–556.5 | 533.4–595.1 |
| exit | 2px | 325.7–353.0 | 522.0–561.7 | 561.7–594.3 |

**≤450ms 达标 2/18(严口径)、6/18(宽口径 0.02)。**
机制是结构性的,不是抖动:`.flipping` 由 `setTimeout(…, 270)` 摘除(SiteNav.astro:508),摘除后 `::before` 才开始 `opacity 0.2s ease`(SiteNav.astro:115),下限即 270+200=**470ms**;出白带一侧因翻色帧上滚动工作更重,定时器实测漂到 325–353ms,总时长升到 520–630ms。
**复现**:1440×900 打开 `/` → 把 `.x-invert` 顶(或底)对到 `导航高+10` 的线 → 以 33/5/2 px/帧 `window.scrollTo` 穿过 → rAF 逐帧读 `getComputedStyle(nav,'::before').opacity`,记翻色帧到首次抵达目标值的毫秒差。
**注**:①②两条通过 —— 六次录制逐帧最低对比度 **6.401:1**(enter @33px 第 41 帧,白字压 0.64 暗磨砂、其下已是白带),0 帧 <4.5;`color` 与 `tint` 的变化帧号在六次录制中**完全一致**(各自只有 1 个变化帧且同号),不存在半态帧。稳态真实像素交叉验证:暗区 17.56:1、on-light 7.42:1,20 帧全过(`rtf-supp.mjs`)。

### AC6 — 灯箱盒宽达不到 600

**判据**:慢网首开时 0/16/50/100ms 的 dialog 宽度 ≥600。
**实测**(`rtf-ac6.mjs`,CDP 1.5Mbps/300ms):

| 视口 | zoom | dialog rect | cssWidth | 早期最小宽 | 到图跳变 |
|---|---|---|---|---|---|
| 1440×900 | 0.98958 | 559.8 × 791.9 | 565.72px(画布) | **559.83** | Δw 0.00 / Δh 0.00 |
| 1366×768 | 1.0 | 466.1 × 667.2 | 466.06px | **466.06** | Δw 0.00 / Δh 0.00 |

宽度在四个采样点上恒定(开盒即终宽,不弹小框、到图零跳变),但**始终低于 600**,屏幕 px 与画布 px 两种口径都不达标。起作用的是宽度公式第三项 `(94vh/zoom − 100uc) × 0.7494`(TrustSection.astro:119-123):1440×900 下算得 565.7 画布px、1366×768 下 466.1 —— 高度约束先于 760 上限生效,视口越矮盒子越窄。
**其余子条全过**:`scrollHeight == clientHeight`(800/800、667/667,无需盒内滚,横向亦然);图完整在视口内;加载期带 `is-loading`,图片区中心真实像素 t=400ms `rgb(225,225,225)`、t=1100ms `rgb(220,220,220)`(脉冲在动,非纯白);关闭键始终在视口内。
**复现**:1440×900 或 1366×768 打开 `/` → 滚到证书 → CDP `Network.emulateNetworkConditions{1.5Mbps,300ms}` → 点 `.cert-open` → 读 `dialog.getBoundingClientRect().width`。

### AC10 — /nex FAQ 答案段 max-width 与首页不同

**判据**:两处 FAQ「全部相同」。27 个比对项里 **26 项全等**,唯一差异:

| 项 | 首页 FAQ | /nex FAQ |
|---|---|---|
| 答案段 `max-width` | **760px** | **680px** |

两个视口(1440×900、390×844)均复现。源头:`FaqSection.astro:109` `max-width: calc(760 * var(--uc))` vs `NexContent.astro:299` `max-width: calc(680 * var(--uc))`。
**全等的 26 项**(供回归):`summary` min-height 60px / gap 28px(390 上 14px)/ padding 12px / align center / 实测行高 60;`.idx` flex-basis 30px、实测宽 29.69(390 上 30)、色 `rgba(12,12,13,0.8)`、400、12px;`.q` 24px(390 上 18px)/400/-0.48px(390 上 -0.36px)/30px(390 上 22.5px)/Funnel Display/`rgb(12,12,13)`/`1 1 0%`;答案 margin-bottom 20px、margin-left 58px(390 上 44px)、line-height 17.4px、色 `rgba(12,12,13,0.8)`、12px;行线 `rgba(12,12,13,0.23)` 1.01053px(390 上 1px),**逐条上线 + 仅末条下线**两边都成立;记号色 `rgb(72,100,5)`、12px。
**信任区 PoC 全过**:`summary` gap 与首页 FAQ 相同(28px / 14px);答案 `margin-bottom` 20px 相同;记号**盒**右缘与行右缘差 **0.00 px**,**字形**右缘差 1440 上 **0.42 px**、390 上 **0.00 px**(阈值 225/235/240 三档扫描均如此,`rtf-supp.mjs`)——此前「短 4.64px」已消失。

---

## 额外发现(与 AC 判据分开列)

1. **AC5 的迟滞是单侧 12px 窗,抗抖能力依赖停位**(P2,数据 `rtf-ac5.mjs`/`rtf-ac5b.mjs`)。停位扫描(offset = `band.top − 翻色线`,±20px 来回 4 次):

   | offset | −10 | −5 | 0 | +5 | +10 | **+15** | +20 |
   |---|---|---|---|---|---|---|---|
   | 翻转次数 | 0 | 0 | 1 | 1 | 1 | **8** | 0 |

   offset=+15 时把来回次数拉到 12 次 → **翻转 24 次(每条腿都翻)**。即:AC 指定的「停在翻色线」上表现极好(1/12),但把静止点挪到线下 13–19px(仍属「附近」),±20px 微滚会 100% 逐帧翻色,与修复前同型。判据 `if r.top < band + hys`(SiteNav.astro:494-498)只在**已亮态**放宽 12px,窗外的抖动不受保护。是否要把窗做成对称/加宽,请主人拍板。

2. **AC15② 必须先证「点确实落在链接上」**。首测我按 `scrollIntoView` 后的坐标点击,拿到 Δ=0px 的「通过」——回查 `document.elementFromPoint` 返回 `null`(视差把链接推到 y=1938,视口只有 900,点击被夹到视口内打在 `<html>` 上)。**那次 Δ=0 是空点击,不是通过**。改成「迭代纠正到视口中带 + 断言 `elementFromPoint` 命中 `A.vlink`」后:原样点击 Δ=1543px 跳到 `#trust`(锚点导航,属预期),隔离锚点导航后 Δ=**0 px**、`focused=true`、`:focus-visible=false` —— 视差居中逻辑正确地没有对鼠标路径生效。

3. **AC9 的两条子判据在两条路由上是空集**:`/learn/getting-started/` 与 `/404.html` 上 `[data-tw]` 与 `[data-rv]` 各为 **0 个**,该处「文本=原文 / opacity=1」为真空成立;实质样本全部来自 `/`(各 35 个)。若期望文章页也有这两类元素,是另一个问题。

4. **AC16 的 `npm run verify` 我没有在仓库里跑**。链条第 8 门 `gate-canvas-geometry.mjs` 在无参数时**无条件执行 `npm run build` 并 spawn 一个 `astro preview`**(gate-canvas-geometry.mjs:76-83),而 4399 正是 `astro preview` 服务的同一个 `dist/`,本轮还有多个 agent 在同时打这个端口 —— 与派单「禁止 build/dev、禁止起停服务」直接冲突。实际做法:① `node scripts/gate-canvas-geometry.mjs --reuse 4399` 直接对**被测产物**跑第 8 门 → 通过(33 路由 × 5 采样宽 + 5 个断点两侧,七判据 A–G 全过,最小字号样本 37);② 把 `src/scripts/public/package.json/astro.config.mjs/tsconfig.json` 原样复制到 scratchpad、junction 借用 `node_modules`,在副本里跑完整 `npm run verify` → **8/8 gates pass**、副本 `.verify-exit.code`=**0**(前 7 门纯读 `src/`,与仓库逐字节相同)。测完已 `rmdir` 摘掉 junction,仓库 `node_modules` 完好。若要求「必须在仓库原地跑」,需先安排一个允许 build 的窗口。

5. **AC16 变异测试的点名是「页名 + 前 6 条 + 计数」**,不是逐条全列。删掉 `1440|/nex/` 整页 169 个键后输出 `⚠ 只在旧快照(消失)169 个:` + 6 条样例(`- /nex/ HTML|x-inner js|NEX — the token…`)+ `…另有 163 个`,`合计变化 169 个元素(含消失/新增)`,退出码 1。清空键与删整页条目两种变异结果一致,均未静默跳过。同产物两次 snap 的基线:6 个宽度共配对 **27,444** 个元素,超差 0 个。

---

## 未能测 / 口径说明

- **AC4 ① 的「该处内容底色」按 AC 给的合成口径算**:`tint × opacity` 合成到内容底色,内容底色取 `#0c0c0d` 与 `#f2f2f2` 两个候选(导航带被白带部分覆盖时两者并存,取更差者)。真实渲染还叠了 `backdrop-filter: blur(14px)` 下的粒子,故另做了稳态真实像素交叉验证(17.56 / 7.42,0/40 帧 <4.5);**翻色进行中的逐帧真实像素未测**(截图速率跟不上 rAF)。
- **AC5「≤4」的判定停位取 offset=0(band.top 恰在翻色线)**,这是「停在翻色线」的字面读法;停位敏感性另列为额外发现 1。
- **AC5 的 ±60 子条**在 offset=0/6 上不翻回(返程落点 84.2/90.2 仍在迟滞窗 [84,96] 内),这是迟滞的**正确**行为而非吞掉正常翻转;判 pass 用的是 offset=12/30(返程真正出窗)的结果 12/12。
- **AC10 的记号对齐**同时给了盒右缘(0.00 px,几何硬证据)与字形右缘(受抗锯齿阈值影响 0–2 px)。首页 FAQ 在 390 上字形右缘短 1–2px(阈值 225→2px、235/240→1px),属抗锯齿取样,非几何偏移。

---

**PASS 14/17**(fail:AC4、AC6、AC10)
