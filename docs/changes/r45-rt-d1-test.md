# R45 · RT-D1 黑盒回归报告(导航 / 翻色 / 菜单 / 打印 / 灯箱 / 滚动)

- 日期:2026-08-26 · 角色:独立黑盒 tester(只按 AC 实测,不看实现)
- 结论:**PASS 9/12** — fail:AC1(底板 opacity 回落 >400ms)、AC5(慢网首开小白框)、AC10(关菜单后汉堡白条压亮底板 2.13:1)

## 环境

- 对象:构建产物 http://localhost:4399/(未起停服务、未 build);路由 `/`、`/vi/`、`/zh/`、`/learn/`、`/legal/privacy/`
- 工具:Playwright 1.61.0(借 Nexion-uniapp 的 node_modules)无头 Chromium;脚本目录 `C:/Users/jason/AppData/Local/Temp/claude/D--WORKS-PLAN/42e4397e-0bc4-4987-8cc3-a0bc8464e0bd/scratchpad/rtd1-*.mjs`;每页等 `fonts.ready` + networkidle
- 运行时结构(探针 rtd1-probe.mjs / rtd1-probe2.mjs):`header.site-nav`(fixed,高 74,`::before` 底板 #0c0c0d×0.64)、白带 `.band-light.x-invert.curtain`(1440 视口下 doc y 8260–13730,#f2f2f2,无 clip-path/transform,可见边=盒边)、`window.lenis` 存在、翻色时导航加 `on-light`/`flipping`、灯箱 `dialog.cert-zoom`(单实例,换 `img.src`)、触发器 `a.cert-open`×2、菜单 `#nav-menu.menu(.open)` + `button.menu-toggle`(打开时 `header` 加 `menu-open`、`.x-frame[inert]`、`html.lenis-stopped`、`html.style.overflow=hidden`)
- 对比度算法:WCAG 2.x 相对亮度;底板 = `::before` background-color × opacity 合成到该点内容底色(白带覆盖文字中心 → #f2f2f2,否则 #0c0c0d);逐帧 = `requestAnimationFrame`,时间戳用 rAF 帧时间(非 `performance.now()`)
- 滚动驱动:AC1 在 rAF 内逐帧 `window.scrollTo`(每帧 33/5/2 px),探针证实该路径 1 帧内触发翻色,与真实 wheel 路径(第 7 次录制)行为一致;AC2 reduced-motion 下 `html` 无 `lenis` 类(原生滚动)

## 逐条 AC

| AC | 结果 | 证据(原始数字) | 脚本 |
|---|---|---|---|
| AC1 翻色对比度(1440×900,/) | **fail**(仅第 ④ 项;①②③ 过) | ① 6 次录制每帧最低对比度(链接文字 vs 合成底板):enter-33 **4.76**@f12 · enter-5 **4.76**@f29 · enter-2 **4.05**@f64 · exit-33 **4.05**@f8 · exit-5 **4.76**@f24 · exit-2 **5.84**@f58(另:自然 wheel 进白带 4.76);0 帧 <3:1;第一次录制(rtd1-ac1-ac2)六个最低值完全相同。最低点都出现在瞬切帧:文字已换色而底板灰度 119/135 × 0.95。② 文字瞬切相对底板开始变化(帧分辨率 16.7ms,真值落在区间内):进白带 (117,133] / (83,100] / (117,133];出白带 33px (133,150];5px/2px 两档页面底部掉帧(帧距 33–50ms)只能定到 (83,117] / (117,167] → 用单次跳转 60fps 精测(rtd1-ac1c,各 3 次):进 (117,133]·(83,100]·(83,100],出 (100,117]×3,且出白带首个变化帧底板已走到 rgb 211(≈34ms 进程),折算真实起点约 134–150ms。瞬切点固定在底板灰度 104↔119 处;MutationObserver 显示瞬切时刻无 DOM 变更(纯 CSS 定时)。判:进 90–140 / 出 110–160 均在窗内。③ `::before` opacity 峰值 **0.95** ≥0.9。④ 回落:`.flipping` 在 317–367ms 才移除,随后 opacity 0.95→0.72/0.64 ease-out 约 330ms:**400ms 时 opacity 仍 0.84–0.95**;到 ±0.02 内 550–667ms;到精确 0.64/0.72 **650–750ms**(六次:667/650/650/650/750/733) → 不满足「≤400ms 内回到 0.64/0.72」 | rtd1-ac1b.mjs(主)、rtd1-ac1-ac2.mjs(首录)、rtd1-ac1c.mjs(瞬切精测) |
| AC2 reduced-motion(1440×900,/) | pass | `reducedMotion:'reduce'` 下 `html.className="js x-boot"`(Lenis 未启);进/出各 20 步×6.5px、每步 2 帧共 41 帧:进白带最低 **15.74**(s3/f2:黑字压 #0c0c0d 内容,底板 242×0.95→230)、出白带最低 **17.47**;0 帧 <3:1;底板色只有 12/242 两值(瞬切无渐变),opacity 0.64/0.72→0.95→回落 | rtd1-ac1-ac2.mjs |
| AC3 平板旋转(768×1024 touch/mobile,/) | pass | 开菜单:`.menu.open` ✓ inert ✓ overflow=hidden ✓ `lenis-stopped` ✓ → `setViewportSize(1024×768)` 后:`.menu.open` 无、`.x-frame` 无 inert、`html.style.overflow=""`、无 `lenis-stopped`、`aria-expanded=false`、汉堡 display none;wheel 600 → scrollY **600**;点第一张证书 → `dialog[open]` ✓(scrollY 7504);转回 768×1024 后点汉堡 → `.menu.open`/inert/overflow hidden/lenis-stopped 全部恢复 | rtd1-ac3-ac9-ac10.mjs |
| AC4 打印(print,1440×900,/ /vi/ /zh/) | pass(带说明) | 三语各 **35/35** `[data-tw]` 宿主:`.tw-ghost` visibility visible + display block、`.tw-live` display none 且为空、可见文本(排除 1×1px 绝对定位的 `.x-sr`)= 原文 35/35;`[data-rv]` opacity **1** 35/35(transform none);`.site-nav` display **none**、`#x-bg` display **none**。说明:宿主 `innerText` 字面为「NETWORK SCALE NETWORK SCALE」(`.x-sr` 副本 1×1px 仍被 innerText 计入 + text-transform 大写),非空但不与原文字面相等;打印可见文本无重复 | rtd1-ac4-ac7-ac11-ac12.mjs |
| AC5 桌面灯箱(1440×900,/) | **fail**(仅 ④ 首开尺寸;①②③、④ 换图 过) | ① A 开(scrollH 1059 / clientH 855)滚到底 scrollTop 204 → 关 → 开 B:mutation/raf1/raf2/100ms 四个时刻 `dialog.scrollTop` 均 **0**。② Ctrl+点击:`dialog` 无 open ✓,`context` 收到新 page ✓,window 捕获/冒泡两阶段 `defaultPrevented=false` ✓。③ 盒子 rect {l 336.5, t 27, w 752.1, h 846},padding `0 16px 16px`;点 (341.5, 450)(左缘内 5px,`elementFromPoint`=dialog 自身)→ 仍 open ✓;点 (306.5, 450)(盒外 backdrop)→ 关闭 ✓。④ CDP 300ms/1.5Mbps 首开:open 瞬间 / rAF / 50ms / 100ms 四个采样 **dialog 105.6×185.8**(关闭键 43.5px + img 占位 98.7px,`currentSrc=""`),300ms 拿到图片尺寸后才 752.1×846 → 不满足「0–100ms 内 ≥600×600」;A 完全加载(2619ms)后关→开 B:open 瞬间 `img.src` 已是 B、`currentSrc=""`、complete=false、naturalWidth 0,300/1000/1300ms 为 B 的 URL,从未出现 A → 「不显示上一张」✓(但切换时同样先 105.6×185.8 约 300ms) | rtd1-ac5.mjs |
| AC6 导航上方滚轮(1440×900,/) | pass | 指针停在「Devices」(elementFromPoint=该 a,wheel target=`A.x-dimlink`,未 preventDefault)wheel(0,300):scrollY 0→53(50ms)→115→161→**186(200ms)**→214→236→271→282→293→299→300(1.5s);内容区同操作:0→76→132→132→**174(200ms)**→214→236→268→282→295→299→300;两条曲线同为 Lenis 补间且终点一致 | rtd1-ac6-ac8.mjs |
| AC7 时钟(1455×900,/) | pass(带说明) | `--x-vw`=1440px;`#x-clock.textContent`=「UTC 09:47 PM」(U+00A0 ×2,`/^UTC \d{2}:\d{2} (AM\|PM)$/` 归一后匹配);4 个子 span 顶部 y 全等(单行渲染),`.clock` 宽 **83.81px**(80–90 内),高 44。说明:`.clock` 为 `display:flex`,子 span 被块化,`innerText` 字面为 `"UTC \n09\n:\n47\n \nPM"`(含换行)——按 innerText 字面正则不匹配,视觉/文本内容满足 | rtd1-ac4-ac7-ac11-ac12.mjs |
| AC8 锚点直达(1440×900 / 1920×1080;/learn/→How) | pass | `/#trust` 1440×900:DCL 时 scrollY 0(`#trust` 顶 10443),**load 时 scrollY 已 10360、`#trust` 顶 83px**,0–1500ms 每 100ms 与逐帧(96 帧)均恒为 10360(distinctPositions 1,无补间);1920×1080:load 时 13851、`#trust` 顶 **111px**,恒定;/learn/ 点「How it works」(href `/#how`)→ 落地 load 时 scrollY 8296、`#how` 顶 83 / 底 918(在视口内),300ms 内不变 | rtd1-ac6-ac8.mjs |
| AC9 焦点陷阱(390×844 touch,/) | pass | 菜单内可见可聚焦 9 项(How/Devices/Trust/Learn/NEX/EN/VI/中文/DOWNLOAD);汉堡聚焦 → Shift+Tab → `activeElement`=`.dl-btn`(末项)✓;末项 Tab → 汉堡 ✓;Tab 遍历:How→…→DOWNLOAD→Menu→How(闭环);Esc → `.menu.open` 无、inert 无、overflow 空、焦点在 `.menu-toggle` ✓ | rtd1-ac3-ac9-ac10.mjs |
| AC10 白带上开关菜单(390×844,/) | **fail**(关闭期) | 白带中段 scrollY 8337(该处汉堡正下方内容为证书 `.cert-hint` 深色标签 #0c0c0d;底板 `on-light` 242×0.72 → 合成 **178**);汉堡条 `.menu-toggle span` 22×2px,`background-color` 即条色。开:点击后 50ms 面板 `#nav-menu.menu.open`(fixed,#0c0c0d)出现同帧条色变白 → 19.55,0 帧 <3。**关:33ms 面板已 `display:none`、`header` 去掉 `menu-open`,但条色保持 rgb(255,255,255) 直到 167ms 才回 rgb(12,12,13) → 8 帧(33→150ms)白条压 178 灰底板 = 2.13:1**;几何枚举(rtd1-ac10c,不依赖 hit-test)证实此期间覆盖该点的仅 canvas/`header::before`/白带/figure/`.cert-hint`,无其它遮罩;3 次运行一致 | rtd1-ac10b.mjs、rtd1-ac10c.mjs(rtd1-ac3-ac9-ac10.mjs 首版合成算法漏掉 `pointer-events:none` 的 header,已废弃) |
| AC11 内页底板(1440×900) | pass | `/learn/` 顶部与滚 552px 后 `::before` opacity **0.9**(bg #0c0c0d);`/legal/privacy/` 顶部与滚 800px 后 **0.9**;首页黑区 **0.64**(顶部/滚 800);白带静止态 **0.72**(AC1 六次录制末帧 finalOp) | rtd1-ac4-ac7-ac11-ac12.mjs |
| AC12 导航单行(861/880/900/1039×900,/) | pass(带说明) | 四档:`.dl-btn` font-size **12px**;`.site-nav` 高 **74**;汉堡 display none、`.menu` static/flex;`.links` 5 链接 top 全等(单行,`.links` 高 44);盒子无重叠:logo↔links / links↔row2 / links↔lang / links↔dl / lang↔dl 全 false(861 档 links 右缘 612.2 < row2 左缘 631.1)。说明:`.links` 是 `.right` 的后代(`.right > .menu > .links`),两者「盒子」按字面必然相交(含关系),故用 links↔row2(lang+download)作为有效判据 | rtd1-ac4-ac7-ac11-ac12.mjs |

## fail 复现步骤

- **AC1-④**:1440×900 打开 `/`,让白带上边(doc y≈8260)以任意速度穿过导航;逐 rAF 读 `getComputedStyle(document.querySelector('.site-nav'),'::before').opacity` → 翻色起 0.95;约 320ms `.flipping` 移除;opacity 到 0.72 需 ≈650ms(出白带回 0.64 需 650–750ms);400ms 时仍 0.84–0.95。脚本 rtd1-ac1b.mjs 输出 `flippingRemovedMs / opAt400 / within002Ms / backToRestMs`。
- **AC5-④**:新 context 1440×900,`Network.emulateNetworkConditions{latency:300, downloadThroughput:1.5e6/8}`,滚到 `#trust`,点第一张 `a.cert-open`;在 `open` 属性 mutation、下一 rAF、50ms、100ms 读 `dialog.cert-zoom.getBoundingClientRect()` → 105.6×185.8;300ms 后 752.1×846。脚本 rtd1-ac5.mjs `s4_slowNet.firstOpenLog`。
- **AC10**:390×844 hasTouch/isMobile,`window.scrollTo(0, 白带中点)`(实测 8337)等 1.5s(导航 `on-light`),点 `.menu-toggle` 开,再点关;逐 rAF 读 `.menu-toggle span` 的 background-color 与 `#nav-menu` display:关闭后第 2 帧起面板已 none 而条色仍 #fff,持续到约 167ms;条色 #fff 对 `header::before`(#f2f2f2×0.72)合成到下方内容(白带 #f2f2f2 → 1.1:1;本例 `.cert-hint` #0c0c0d → 178 → 2.13:1)。脚本 rtd1-ac10b.mjs(`close.bad` / `close.transitions`)。

## 额外发现(非 AC,分开列)

1. **[测量条件/性能]** 无头 Chromium 在白带下边附近(doc y≈13.5k,`#nex`/`#learn-entry`/`#faq` 一带)逐帧滚动时帧距 33–50ms(白带上边同法为 16.7ms);单次跳转录制则 16.5–33ms。无法据此断言真机掉帧(软件渲染),但该区域绘制成本明显高于上半页。
2. **[文本复制]** `[data-tw]` 宿主同时含 `.x-sr`(1×1px)与 `.tw-ghost` 两份文本,`innerText`/选中复制得到「Network scale Network scale」式重复(屏幕与打印同),低严重度。
3. **[灯箱切换]** AC5-④ 的 ~300ms 小白框(105.6×185.8)在「A 已加载 → 关 → 开 B」时同样出现,不只首开。
4. **[测量说明]** `header.site-nav` 与其 `nav` 为 `pointer-events:none`(仅 `.menu-toggle` 等为 auto),`elementsFromPoint` 不返回 header;做合成计算须按几何层序加回 `header::before`。首版 AC10 脚本因此误报 66 帧,已用几何枚举版复核,报告以复核版为准。
5. **[Ctrl+点击]** 新标签 URL 在 `page` 事件时为 `about:blank`(随后导航到 `/cert-msb@2x.png`),主页面 URL 不变;符合预期,仅记录。

---
**PASS 9/12**(fail:AC1-④ 底板回落 650–750ms;AC5-④ 慢网首开 105.6×185.8;AC10 关菜单后汉堡白条 2.13:1 持续 ~133ms)
