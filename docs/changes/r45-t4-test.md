# R45 · T4 独立黑盒验收报告 — 证书灯箱 + 设备叠卡

- 日期:2026-08-26 · tester:r45-t4(独立黑盒,未读实现叙述,全部结论来自 4399 构建产物的运行时 DOM / 计算样式 / 几何)
- 结论先行:**PASS 15/16** — 唯一 fail 是 AC4 序号章盒宽「≥69 画布 px」压线差 0.06px(实测 68.94;`offsetWidth`=69、文本单行不换行,疑为阈值取整);另有 1 条 AC 外缺陷(灯箱滚到底后滚轮串联滚动底下页面)见「额外发现 E1」。

## 环境

| 项 | 值 |
|---|---|
| 被测对象 | http://localhost:4399/ 构建产物(已在跑,本轮未起/停服务、未 build/dev、未碰 4321);路由 `/`、`/vi/`、`/zh/` |
| 浏览器 | Playwright 1.61.0(借 `D:/WORKS/PLAN/Nexion-uniapp` 的依赖)· HeadlessChrome 149.0.7827.55 · Windows 11 |
| 视口 | 1440×900、1920×1080(桌面);390×844 `hasTouch+isMobile+dsf3`(手机);1455×900(zoom=1 探针) |
| 稳定性处理 | 每页等 `networkidle` + `document.fonts.ready` + 400ms;跨区跳转用 `window.scrollTo` + 1.6s 静置(Lenis 接受原生滚动);灯箱/叠卡内滚动一律 `mouse.wheel`;不用截图,全部 DOM/计算样式/`getBoundingClientRect` 判定 |
| 脚本目录 | `C:/Users/jason/AppData/Local/Temp/claude/D--WORKS-PLAN/42e4397e-0bc4-4987-8cc3-a0bc8464e0bd/scratchpad/` |
| 脚本 | `t4-recon.mjs`(DOM 侦察)· `t4-lib.mjs`(共用)· `t4-ac1-lightbox.mjs` · `t4-ac2-natural.mjs` · `t4-ac3-deck.mjs` · `t4-ac4-serial.mjs` · `t4-ac4b-serialbox.mjs`(序号章盒模型/换行探针)· `t4-extra-chaining.mjs`(E1 复现) |
| 原始输出 | 同目录 `t4-ac1.out.json` / `t4-ac2.out.json` / `t4-ac3.out.json` / `t4-ac4.out.json` / `t4-ac4b.out.json` |
| 仓库 | `D:/WORKS/PLAN/nexgrid-website` 只读,仅新增本报告 |
| 页面错误 | 全部脚本 `pageerror` / `console.error` 均为 0 |

侦察到的实际结构(供对照):证书开启件 `a.cert-open[href="/cert-*@2x.png"]`(内含 `img[src="/cert-*.png"][width=660][height=881]`);灯箱 `dialog.cert-zoom[data-lenis-prevent]` > `form.cert-zoom-close[method=dialog]` > `button.xbtn` + `img`(打开时才填 src);叠卡 `section#devices.devices.decked[style="height:6400px"]`,7 张 `article.card[data-deck-card]`(其中第 2 张 NX-02 无 `img`,用内联 SVG),桌面卡图 `loading="eager"`;序号章 `.serial`(absolute、border-box、padding 10px、Space Mono)。

## 逐条 AC

| # | AC | 视口 / 路由 | 结果 | 证据(原始数字) | 脚本 |
|---|---|---|---|---|---|
| 1a | 灯箱内 `mouse.wheel(0,300)`:`dialog.scrollTop` 增、`window.scrollY` 不变 | 1440×900 `/` | **pass** | 打开:`scrollY`=10363,`dialog.scrollTop`=0(scrollHeight 1059 / clientHeight 855,`overflow-y:auto`,`:modal` true)→ wheel 后 `scrollTop`=204.13(=上限 204),`scrollY`=10363 不变;灯箱内无其它滚动容器 | t4-ac1-lightbox |
| 1b | 同上 | 1920×1080 `/` | **pass** | `scrollY`=13881,`scrollTop` 0 → 226.77(上限 292 = 1059−767),`scrollY`=13881 不变 | t4-ac1-lightbox |
| 1c | 灯箱滚到底后关闭键仍在灯箱可视区内 | 1440×900 | **pass** | 到底:`scrollTop`=204.13=上限;关闭键 rect (x998.75, y42.83, 73.95×43.53) ⊂ 灯箱 rect (x336.45, y27, 752.08×846) ⊂ 视口;`elementFromPoint(键中心)`=`button.xbtn`(未被遮挡);`form.cert-zoom-close` 计算 `position: sticky` | t4-ac1-lightbox |
| 1d | 同上 | 1920×1080 | **pass** | `scrollTop`=291.78=上限;键 rect (x1335.86, y53.56, 98.19×58.2) ⊂ 灯箱 rect (x449.8, y32.41, 1005.41×1015.19);hit = `button.xbtn` | t4-ac1-lightbox |
| 1e | Esc 关闭,`activeElement` 回到开启件 | 1440 + 1920 | **pass** | 两视口 Esc 后 `dialog.open`=false;`document.activeElement` = 第一个 `a.cert-open[href=/cert-msb@2x.png]`(`isFirstOpener` true) | t4-ac1-lightbox |
| 1f | 点背景关闭,焦点回开启件 | 1440 + 1920 | **pass** | 点灯箱盒外的点 (168.2,450) / (224.9,540),`elementFromPoint` = `dialog.cert-zoom` 自身(backdrop 命中)→ `open`=false,`activeElement` = 第一个开启件 | t4-ac1-lightbox |
| 1g | 点关闭键关闭,焦点回开启件 | 1440 + 1920 | **pass** | click `.cert-zoom-close button` → `open`=false,`activeElement` = 第一个开启件。附加:开启件 focus + Enter 也能打开,Esc 后焦点同样回位 | t4-ac1-lightbox |
| 1h | `javaScriptEnabled:false` 下点击证书导航到图片 URL,200 + image/png | 1440×900 `/` | **pass** | 无 JS:`html` 无 `js` 类、`.cert-open` 2 个可见(第一张 box x385 y8948.7 312×416.5)、`dialog.open`=false;点击 → 导航响应 `http://localhost:4399/cert-msb@2x.png`,status **200**,content-type **image/png**,`page.url()` 同 | t4-ac1-lightbox |
| 2a | 灯箱图 `dialog img` naturalWidth ≥1160 | 1440×900 `/` `/vi/` `/zh/` | **pass** | 两张证书 × 三语均:`/cert-msb@2x.png` **1160**×1548、`/cert-colorado@2x.png` **1160**×1548(显示 720.4×961.4);alt 三语各自本地化 | t4-ac2-natural |
| 2b | 缩略图 `.certs img` naturalWidth = 660 | 同上 | **pass** | `/cert-msb.png` **660**×881、`/cert-colorado.png` **660**×881,三语一致,`complete` true(渲染宽 308.75) | t4-ac2-natural |
| 3a | 桌面编舞:设备图路由 +150ms 延时,自叠卡区上方每步 100px wheel 推进全程,任一卡 `rect.left<视口宽` 的首帧 `img.complete` 为 true | 1440×900 `/`(非 reduced) | **pass** | 环境:`.decked` true,`prefers-reduced-motion` false,`pointer:coarse` false;6 张卡图 `loading="eager"`,4 个图片请求在导航后 84ms 全部发出(phone.png / s1.jpg / pro.jpg / rack.jpg,各 +150ms);从 y=2419 起 62 步 ×100px 推到 y=8619(叠卡区 2718.5–9051.9,钉住行程终点 8151),rAF 记录 460 帧 / 7979ms。各卡「首次 left<1440」帧:卡1 left 390.9 @y2419 complete=1 nw720;卡3 1433.1 @3082;卡4 1426.0 @3890;卡5 1434.8 @4666;卡6 1429.0 @5463;卡7 1439.2 @6248 —— **全部 complete=1 且 naturalWidth=960**;整个行程内「在视口中但未完成」帧数 = 0(卡2 无 img,不适用) | t4-ac3-deck |
| 3b | 390×844 手机静态列:卡图 `loading="lazy"` | 390×844 hasTouch+isMobile `/` | **pass** | `pointer:coarse` true / `hover:hover` false;`#devices` class 仅 `devices`(无 `decked`、无内联 height),卡 transform 均 none;6 张卡图 `loading` 属性值均为 **"lazy"**(后 3 张离屏未加载 `complete`=false,与 lazy 相符) | t4-ac3-deck |
| 4a | zh `/zh/` 序号章 `.serial` computed font-size 16px、line-height 19.2px | 1440×900 `/zh/` | **pass** | 7 个 `.serial` 全部 `font-size: 16px`、`line-height: 19.2px`;字体 `"Space Mono"`(fonts 已 loaded:Space Mono 400/700),letter-spacing −0.36px;与 en/vi 完全同值 | t4-ac4-serial |
| 4b | en 序号章盒宽 ≥69 画布 px(屏幕 px ÷ zoom) | 1440×900 `/`(另 1920、1455 佐证) | **fail(边缘,差 0.06px)** | 1440:rect 宽 **68.219**(卡 2–7)÷ `currentCSSZoom` **0.98958**(`div.x-canvas zoom=0.989583`)= **68.937** 画布 px;卡 1 因 active 卡另带 `transform: scale(0.9972)` 为 68.028 ÷ 0.98958 = 68.744。1920:91.203 ÷ 1.32292 = 68.941。zoom=1 探针(视口 1455 → clientWidth 1440):rect **68.953**;计算 `width: 68.9531px`(border-box = padding 10+10 + 文本 48.953);`offsetWidth`/`clientWidth`/`scrollWidth` 均 **69**;文本 **单行**(`Range.getClientRects()` 1 个行盒,ghost span 宽 48.95)。三语同值。→ 按字面公式 < 69,判 fail;视觉上无换行/无裁切,阈值疑为取整值(见 E5) | t4-ac4-serial / t4-ac4b-serialbox |
| 4c | phone 卡(第一张)img `object-fit: contain` 且整机可见(不被 `.media` 裁) | 1440×900 `/`(zh/vi/1920 同) | **pass** | `img.contain` computed `object-fit: contain`、`object-position: 50% 50%`,natural 720×720;img rect = `.media` rect (x401.64, y196.40, 621.71×360.82),`.media` overflow hidden;contain 内容盒 360.82×360.82 位于 x532.08–892.90 / y196.40–557.21,**完全落在 `.media` 内**(未裁);zh 下 media 高 347.38 同样内含;1920 下 833.30×483.61 同样内含 | t4-ac4-serial |
| 4d | 其余卡 img `object-fit: cover` | 同上 | **pass** | 卡 3–7(S1 960×640、Pro 960×960、Pro v2 960×960、Rack P1 960×960、Rack P2 960×960)computed `object-fit: cover`;卡 2(NX-02)无 img(内联 SVG),不适用 | t4-ac4-serial |

### 4b fail 复现步骤

1. 1440×900 打开 `http://localhost:4399/`,`window.scrollTo(0, #devices.top + 10)` 静置 1.6s。
2. 取任一非 active 卡的 `.serial`:`getBoundingClientRect().width` = 68.219,`el.currentCSSZoom` = 0.98958 → 68.219 ÷ 0.98958 = 68.937 < 69。
3. 佐证:视口 1455×900(zoom 恰为 1)直接读 rect 宽 68.953;`getComputedStyle(el).width` = `68.9531px`;`offsetWidth` = 69。

## 额外发现(AC 之外,分开列)

### E1 · 灯箱滚到端点后,滚轮串联滚动底下页面(建议 P2,lead 可按站点标准升级)

- 现象:灯箱是模态(`:modal` true),但 `dialog.cert-zoom` 计算 `overscroll-behavior-y: auto`,打开期间 `html`/`body` `overflow` 仍为 visible;灯箱滚到底(或顶)后,后续 wheel 全部落到页面。`data-lenis-prevent` 只让 Lenis 忽略灯箱内滚轮,不阻止原生串联。
- 复现(`t4-extra-chaining.mjs`,1440×900):到 `#trust` → 点第一张证书 → 鼠标停在灯箱上 → wheel +300:`scrollTop` 0→204.1(=上限),页面 10363 不动 ✔ → 再 wheel +300:页面 **10363→10663** → +300:**10963** → +300:**11263**(灯箱 scrollTop 钉在 204.1);反向在 `scrollTop`=0 时 wheel −300 ×3:页面 10963→10663→10363。
- 后果:AC1 主跑里「滚到底」循环多滚了 2×1200 + 600 → Esc 关闭时 `scrollY`=13363,而开启件绝对位置 ≈10590(在视口上方 ~2770px):焦点虽回到开启件,但主人已被带离原位。1920 同型(13881→15081→15681)。
- 判据提示(非修法指令):`dialog.cert-zoom { overscroll-behavior: contain }` 或打开期间锁定页面滚动,任一可挡;修后请回归本报告 1a–1d 与本条。

### E2 · 冷启动 + 高延迟下第一张卡短暂无图(信息项,非编舞缺陷)

- 探针:设备图 +1500ms 延时,`domcontentloaded` 后立即开滚(不等 networkidle)。图片请求仍在导航后 74–80ms 全部发出(eager),但 phone 卡在 552ms 就进入视口,`img.complete`=false 持续 36 帧(≈0.6s);其余卡进入时均已完成。
- 这是网络延迟本身的下限,预载策略无法消除;若产品要求,可考虑 `.media` 占位色/骨架(本轮未验证是否已有占位)。

### E3 · 设备卡图片内容复用(信息项,请 lead 确认是否为占位资产)

- NX-04「NexGridBox Pro」与 NX-05「NexGridBox Pro v2」同用 `/devices/pro.jpg`;NX-06「NexGridRack P1」与 NX-07「NexGridRack P2」同用 `/devices/rack.jpg`;NX-02 无照片(内联 SVG)。三语一致。

### E4 · `.serial` 的 `textContent` 在未揭示卡上是双份(信息项,非缺陷)

- 未揭示的卡:`.serial` = `<span class="x-sr">NX-03</span><span class="tw-ghost" aria-hidden visibility:hidden>NX-03</span><span class="tw-live" aria-hidden></span>`,所以 `textContent` 读作「NX-03NX-03」;揭示后折叠为纯文本「NX-01」。可访问名只有一份,几何宽度两态一致(68.219),其它 tester 用 `textContent` 断言时注意。

### E5 · 叠卡画布 zoom 与 active 卡缩放(信息项,解释 4b 的数字)

- `div.x-canvas` 计算 `zoom` = `clientWidth / 1440`:1440 视口因经典滚动条占 15px 得 0.989583,1920 得 1.32292,1455 视口恰好 1。
- active 卡 `article.card` 另带 `transform: scale(0.9972)`(1440)/ 0.9976(1455)/ 0.9998(1920),故卡 1 的序号章屏幕宽(68.03)略小于其它卡(68.22)。
- `.serial` 画布真值 = 68.953px(padding 20 + Space Mono 16px 文本 48.953),`offsetWidth` 取整 69;若 4b 阈值来自取整值,建议改写为「≥68.9」或直接断言 `offsetWidth ≥ 69` 并附「单行不换行」判据。

## 结尾

**PASS 15/16**(fail:4b 序号章盒宽 68.94 < 69,边缘;AC 外缺陷 E1 待 lead 定级)
