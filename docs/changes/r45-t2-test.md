# R45 · T2 打字机引擎 · 独立黑盒验收报告

结论先行:**PASS 2/4(按 AC 字面)**。AC3、AC4 全绿;AC1(vi)与 AC2(vi #16)两处不达标,**证据均指向同帧/同区的 `[data-lr]` 行揭示引擎,不是 `[data-tw]` 打字机**——三语 105 个打字目标自身宽高差 0、104/105 父高差 0、无任何 layout-shift 条目的 source 落在 `[data-tw]` 上。是否把这两条按「引擎归属」改判,由 main 拍板。

## 环境

| 项 | 值 |
|---|---|
| 被测对象 | 构建产物 http://localhost:4399/ 三语首页 `/`、`/vi/`、`/zh/`(未起停服务、未 build) |
| 浏览器 | Playwright 1.61.0 Chromium(借 `Nexion-uniapp` 依赖),`reducedMotion:'no-preference'` / `'reduce'` 按 AC 指定,`deviceScaleFactor:1` |
| 视口 | AC1-3:1440×900;AC4:861 / 900 / 960 / 1024 / 1150 × 900 |
| 就绪判据 | `load` → `document.fonts.ready` → `networkidle` → 再等 2.2 s(boot 淡入结束) |
| 滚动驱动 | `mouse.wheel(0,300)` 每 100 ms 直到页底(Lenis 平滑滚动) |
| 采样 | 页面初始化脚本(`addInitScript`)装 MutationObserver(childList/characterData/class)+ rAF 采样器,对每个 `[data-tw]` 记 raw(注册前)/ pre(注册后未触发)/ typing / post 四相的自身 rect、父 rect、`offsetWidth/Height`、Range 墨迹 rect、兄弟 rect;叠卡区卡片在堆叠中被 `scale()`,rect 全部按祖先 transform 矩阵反归一(`offsetHeight` 作无 transform 交叉验证) |
| 几何判读 | 全部用 DOM / computed style,不用截图(本机无头截图有暗色反转) |
| 脚本 | `scratchpad/t2-lib.mjs`、`t2-init-sampler.js`、`t2-init-sampler-lite.js`、`t2-init-cls.js`、`t2-ac1-cls.mjs`、`t2-ac2-geom.mjs`、`t2-ac3-vis.mjs`、`t2-ac4-gutter.mjs`;附加探针 `t2-x-clsattrib.mjs`、`t2-x-failsafe.mjs`、`t2-x-regshift.mjs`、`t2-x-prestate.mjs`;原始 JSON 同目录 `t2-*.json` |
| 原文来源 | 终态文本对照两路:① curl 下来的服务端 HTML 里 35 个 `[data-tw]` 叶子文本;② `src/i18n/{en,vi,zh}.json` 扁平化全部字符串值(只读) |

`[data-tw]` 目标:三语各 35 个(HTML 里 `data-tw` 串出现 54 次 = 35 元素 + 19 个 `data-tw-delay`),文档序 idx 0-34:#social 眉标 1、#mission `ktxt` 1 + `.idx` 6、#devices `h2.lab` 1 + `.serial` 7、#how `p.lab` 1 + 步骤 span 6、#path `p.lab` 1 + span 4、#trust `p.lab` 1、#nex `p.lab` 1 + `p.idx` 3、#learn-entry `p.lab` 1、#faq `p.lab` 1。首页 hero 内没有 `[data-tw]`,全部由 IntersectionObserver 触发(无 `data-tw="load"`)。

## 逐条 AC

| AC | 判定 | 证据(原始数字) | 脚本 |
|---|---|---|---|
| AC1 zh `/zh/` 整页滚动 CLS ≤ 0.05 | **pass** | 2 次:0.01478 / 0.01478;滚动窗口内 0 / 0;条目 2 个,均为加载期 `div.foot@download`(0.00739 ×2);wheel 52 次,scrollH 14806,35/35 打完 | t2-ac1-cls.mjs |
| AC1 en `/` ≤ 0.02 | **pass** | 2 次:0.0054 / 0.0108;滚动窗口内 0 / 0;条目 1-2 个,同上 `div.foot@download`(0.0054 ×1-2);wheel 51 次,scrollH 14785,35/35 | t2-ac1-cls.mjs |
| AC1 vi `/vi/` ≤ 0.02 | **fail**(字面) | 2 次:**0.04218 / 0.04248**(buffered 全程,`hadRecentInput=false`);拆分:加载期 0.0273(`div.foot@download` 0.01365 ×2,t≈130 ms 与 t≈1720 ms),滚动窗口内 0.01488 / 0.01518(`section#path` / `section#trust` 整段位移 4-11 px,t≈8.6-9.3 s,scrollY 9.6k-10.9k)。**6 个条目 source 无一落在 `[data-tw]` 或其后代**;归因见额外发现 1 | t2-ac1-cls.mjs + t2-x-clsattrib.mjs |
| AC2 目标自身宽高差 ≤ 0.5 px(pre / typing / post) | **pass 105/105** | 两轮(全量采样器 + 轻量采样器)全部 `dWTyp/dHTyp/dWPost/dHPost` = 0(最大 0.001 px,浮点噪声);`offsetWidth/Height` 差亦 0 | t2-ac2-geom.mjs |
| AC2 父元素高度差 0 | **fail 1/105**(字面) | 104/105 两轮均 0(rect 归一后 < 0.02 且 offsetHeight 差 0)。**vi idx16 `p.lab.x-mono-lg`「Cách hoạt động」(#how `.headrow`)**:父高 pre 178.094 → typing **186.000**(offsetHeight 180→188)→ post 178.094,两轮均复现 +7.906。同一批样本里该标签自身高 19.0、在父内偏移 19.0 全程不变;父高与兄弟 `.statements`(`h2[data-lr]` 行揭示)高度逐帧完全相等(178.1 → 186.0 → 178.1)——父高被兄弟撑起,与打字无关。en/zh 同位元素两轮均 0 | t2-ac2-geom.mjs(`t2-ac2-vi.json` items[16]) |
| AC2 zh 眉标打字中行数不变 | **pass 12/12** | zh 全部 `.x-mono-lg[data-tw]` / `h2.lab` / `p.lab`:高 24.578 px、line-height 24.6 px → pre/typing/post 行数 1/1/1(两轮);en/vi 同样 1/1/1 | t2-ac2-geom.mjs |
| AC2 `.serial` 章打字中高度不变 | **pass 7/7 ×3 语** | 高 38.766 px,typing 全部样本差 0(宽 68.219 亦差 0);叠卡 scale 归一后 | t2-ac2-geom.mjs |
| AC2 打字中至少采 3 帧 | pass(两轮合并 105/105) | 第 1 轮 102/105 ≥3(vi#4、zh#6、zh#7 只采到 2),第 2 轮(轻量采样器)102/105(en#3、en#4 只采到 2);两位数字「02」-「06」的打字中只有 1 个 DOM 中间态(已打 1 字),持续 1 个 50/90 ms 间隔,采样器自身开销让个别轮次只落 2 帧;每个元素至少在一轮里 ≥3 帧,且所有样本差 0——DOM 态相同,多采几帧不会改变结论 | t2-ac2-geom.mjs |
| AC3 打字前原文不可见 | **pass** | ① 正常加载:注册(全部 35 个换成 `x-sr`+`tw-ghost`+`tw-live`)在 t=100-133 ms,**早于 FCP(en 120 / vi 144 / zh 128 ms)**,原文根本没画过;注册前唯一样本是解析期 MO 采样,当时样式表尚未应用(`--x-bg` 为空),不在任何一帧里。② 把打字机模块延迟 1.5 s(`route`):FCP 116-132 ms,注册 1526-1538 ms,其间 rAF 逐帧采样 en 3045 / vi 3010 / zh 3010 帧 **computed visibility 全部 hidden,0 帧可见**。③ 注册后未触发态(t2-x-prestate):35/35 ghost `visibility:hidden`、live 为空、`.x-sr` 1 px clip 绝对定位、ghost 已占位(宽 >0)。④ 3 s CSS 保险丝见额外发现 3 | t2-ac3-vis.mjs, t2-x-prestate.mjs |
| AC3 终态 `textContent === 原文` | **pass 35/35 ×3** | 与服务端 HTML 叶子文本逐一全等 35/35(en/vi/zh);与 i18n JSON 值对照:14 个文字标签 14/14 命中(如 zh `工作原理`、vi `Cách hoạt động`),其余 21 个是组件字面数字「01」-「06」「NX-01」-「NX-07」,i18n 里本就没有;reduced-motion 渲染文本亦 35/35 全等 | t2-ac3-vis.mjs |
| AC3 打完无残留 | **pass 35/35 ×3** | `children.length===0` 35/35;`style.width`/`style.display` 均为空 35/35;class 只剩 `tw-done`(无 `tw`/`tw-inline`/`tw-block`)35/35;computed visibility visible 35/35;display 回到 block(flex 子项被块化,与注册前一致) | t2-ac3-vis.mjs |
| AC3 `reducedMotion:'reduce'` 原文直显、无子层 | **pass 35/35 ×3** | 加载即 `tw-done` 35/35、子元素 0、visibility visible、文本 = 原文;整页滚完仍 0 子元素,从未进入 pre/typing | t2-ac3-vis.mjs |
| AC4 861 / 900 / 960 / 1024 / 1150 `.gutter .lab` 打字期间右缘 ≤ `.gutter` 右缘 | **pass 5/5** | 五档均 `decked=true`、gutter `position:absolute`;每档 81-85 个 typing 样本,标签盒右缘、ghost/live 右缘、Range 墨迹右缘 全部 ≤ gutter 右缘:861 → 211.781 = 211.781(2 行,宽 187.9)、900 → 222.469(2 行)、960 → 238.906(2 行)、1024 → 256.453(2 行)、1150 → 266.953 < 290.969(1 行,余 24 px);首卡左缘 233.2 / 243.8 / 259.2 / 276.8 / 311.3 均在 gutter 右缘之外 | t2-ac4-gutter.mjs |
| AC4 标签打完时 `.sub`/`.cta` top 不位移 | **pass 5/5** | 相对 gutter 顶的 top:pre = typing(min=max)= post,`.sub`/`.cta` = 52.375/148.375(861、900、960)、52.375/130.375(1024)、33.188/111.188(1150);标签高 38.375(2 行档)/ 19.188(1150)全程不变 | t2-ac4-gutter.mjs |

## 额外发现(与 AC 判定分开)

1. **AC1/AC2 两处不达标的共同根因是 `[data-lr]` 行揭示引擎,不是打字机**(`t2-x-clsattrib.mjs`,把 layout-shift 条目与 `[data-lr]`/`[data-tw]` 的 DOM 事件按时间对齐):
   - 加载期 `div.foot@download` 两次互逆位移(三语都有):hero `h1[data-lr=load]` 在 t≈107 ms 被拆成 `.lr-line`(高 37 → 177.5,en)并在 t≈1636 ms 复原纯文本(→ 157.6),`.foot` 随之下移 / 上移 18 px(vi 38 px,zh 36 px)。位移量:en 0.0054×2、zh 0.00739×2、vi 0.01365×2。
   - vi 滚动期 4 条(0.00254 / 0.0022 / 0.00695 / 0.0034)分别在 `h2@how`(8679.6 → shift 8681.1)、`p@how`(8862 → 8863.7)、`h3@how`(9161.3 → 9163.2)、`h3@path`(9344.6 → 9346.3)行揭示**复原纯文本**后 1.5-1.8 ms 内发生;附近的打字事件早 30-130 ms,且 AC2 已证明这些 `.lab` 父高 post 差 0。只有 vi 有滚动期位移,与 `html[lang=vi] .lr-line{margin-top:-.1em;padding-top:.1em}` 这条 vi 专属规则 / Be Vietnam Pro 字形高度方向一致 `[INFERRED]`。
   - vi #16 父高 +7.906 的兄弟 `.statements` 就是 `h2[data-lr]`,揭示期间 186.0、前后 178.1。
   - 建议 main 转给 `data-lr` 的负责人;打字机侧无需改动。
2. **注册本身对布局中性**(`t2-x-regshift.mjs`,模块延迟 1.5 s、字体已 loaded、样式已应用时,最后一个 raw 样本 vs 第一个 pre 样本):35/35 自身宽高差 0、在父内偏移差 0、兄弟无位移;7 个 `.serial` 的父 `.media` 同帧 +105.7 px(vi NX-07 +120)——`.serial` 自身盒不变,该帧同时是叠卡 `decked` 初始化(同一模块 init 里 `T()` 与 `D()` 相邻执行),归因叠卡布局切换 `[INFERRED]`;正常加载时这一切发生在 FCP 之前,不产生 CLS。
3. **3 s CSS 保险丝(信息)**:把打字机模块延迟 4 s,原文在 3120-3139 ms 起可见(`x-unhide` 3 s 动画),4027 ms 注册后被清空重打——即 JS 延迟 >3 s 时会出现「原文满亮 ≈0.9 s 再清空」。这是有意的兜底(无 JS / 慢网可读),正常与 1.5 s 延迟场景均不触发;要不要把保险丝再拉长或改成不清空,由 main 决定。
4. 21 个数字目标(「01」-「06」「NX-01」-「NX-07」)不在 i18n JSON 里,是组件字面量;三语一致,不算问题,只是 AC3 的「i18n key 对照」只能覆盖 14 个文字标签。
5. 采样器局限:全量 rAF 采样每帧遍历 35 元素+祖先 transform,单帧 20-40 ms,会压低打字期帧样本数;轻量版对 pre/post/raw 限频后仍有 2 个两位数字元素只落 2 帧(见 AC2 帧数行)。不影响几何结论(DOM 态相同)。

## 复现(fail 两条)

- AC1 vi:`node scratchpad/t2-ac1-cls.mjs 2` → 看 `vi run N total`;按 source 归因跑 `node scratchpad/t2-x-clsattrib.mjs`,看 `=== vi` 下每条 shift 的 `near:` 里紧邻的 `lr ... childList kids=0` 事件。
- AC2 vi #16:`T2_SAMPLER=<scratchpad>/t2-init-sampler-lite.js T2_TAG=-lite node scratchpad/t2-ac2-geom.mjs` → vi 表第 16 行 `dParTyp 7.906`;打开 `t2-ac2-vi-lite.json` items[16].typing[*].par.h(186)与 first.pre.par.h(178.094)、sibs[0].h。

**PASS 2/4**(AC3、AC4 通过;AC1 vi、AC2 vi#16 按字面不达标,根因在 `[data-lr]` 行揭示引擎)
