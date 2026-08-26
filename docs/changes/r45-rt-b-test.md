# R45 RT-B 黑盒回归报告(遮罩 / CLS / 灯箱 / 资源 / 字体 / 读屏)

## 环境

- 对象:构建产物 http://localhost:4399/(`/`、`/vi/`、`/zh/` 均 200);仓库只读,未起停任何服务。
- 工具:Playwright 1.61.0(借 Nexion-uniapp 的 node_modules,Chromium headless),视口 1440×900,默认 **非 reduced**(Lenis 生效);滚动一律 `mouse.wheel`,等 scrollY 静止 ≥400ms 再量;截图走 CDP `Page.captureScreenshot`(captureBeyondViewport=false,不扰动布局);像素比对在浏览器 canvas 内逐像素做,无第三方依赖。
- 节流:CDP `Network.emulateNetworkConditions` 1.5 Mbps / 300 ms RTT。
- 脚本与原始数据:`C:/Users/jason/AppData/Local/Temp/claude/D--WORKS-PLAN/42e4397e-0bc4-4987-8cc3-a0bc8464e0bd/scratchpad/rtb-*.mjs`,产物 `ac*.json`、`ac1-vi-8-{A,B,diff,zoom}.png`。
- 已知答案探针:AC2 的 layout-shift 观察器先用「强插 200px 块」阳性对照验证(捕获 CLS 0.1374),AC1 每个标题附带 A/A′ 同态对照(噪声基线)。

## 逐条 AC

| AC | 结论 | 证据(原始数字) | 脚本 |
|---|---|---|---|
| AC1 遮罩终态像素差 = 0 | **pass**(附注) | `/`:15/15 全部 0(含「47 countries」「computes」「What it is / does」「NexGridBox」右缘),噪声 A/A′ 全 0。`/vi/` run1:14/15 为 0,#8 H3「Bắt đầu miễn phí với điện thoại」6 px(1 行×6 px,通道差 ≤2/255,位于元素顶缘上方 7px);放大逐行比对:笔画本体(下三行 126/97/12…)两态完全相同,差异行是锐音符顶端的淡 AA 行,且**遮罩态墨更多**(233 vs 235)→ 不是被切掉的墨,是亚像素光栅差。run2(元素落在视口 y=192 而非 173):15/15 全 0。两轮 30 次量测遮罩均在位(`.lr-line` overflow hidden、display block;`.lr-inner` transitionDuration 0s 冻结有效,无超时还原)。 | rtb-ac1-mask.mjs vi/root;ac1-vi-run1.json、ac1-vi.json、ac1-root.json;ac1-vi-8-zoom.png |
| AC2 CLS ≤0.02 + 几何全程不变 | **pass** | CLS(hadRecentInput=false 累计):`/vi/` 0、`/` 0、`/zh/` 0(0 条目;带 input 标记的也为 0);整页 wheel 到底 finalY=H(14032 / 13885 / 13906)。h1 offsetHeight 从出现 `.lr-line` 到复原纯文本:vi 239 恒定(97 帧,t 113→1716ms)、root 159(92 帧)、zh 242(92 帧);`.hero .sub` 文档 top:543.92 / 543.92 / 557.31 恒定;`#how .headrow` 高度在其 h2 揭示全程:180 / 140 / 112 恒定(462 / 455 / 450 帧)。 | rtb-ac2-cls.mjs ×3;rtb-ac2-control.mjs(阳性对照) |
| AC3 慢网:标题早于副题;标题在 x-boot 后 0.5–1.2s 内开始 | **fail**(`/vi/` 第二项) | `/`:x-boot 338.5ms,h1 首行 `.lr-inner` 开始位移 1424.2ms(transform 87.59→77.81),`.hero .sub` 开始淡入 2207.7ms(opacity 0→0.019);标题先于副题 ✓;标题−boot = **1085.7ms** ✓。`/vi/`:boot 344.2,标题 1751.6,副题 2301.4,顺序 ✓;标题−boot = **1407.4ms**(复跑 1426.3 / 1403.1)✗ 超上限 207ms+。 | rtb-ac3-slownet.mjs vi/root(vi 跑 3 次);ac3-*.json |
| AC4 灯箱不串联滚动;关闭后恢复 | **pass** | 打开第一张证书前 scrollY 10446;dialog 可滚量 max=204,第 1 次 wheel 即 scrollTop 204.13(到底),后 3 次不变;4 次期间 window.scrollY 恒 10446;打开期间 html class 含 `lenis-stopped`、`html.style.overflow="hidden"`;Esc 关闭后 `html.style.overflow=""`(computed visible),再 wheel(0,300) → scrollY 10746。URL 未变(未触发 href 跳转)。reduced 变体同样通过(8496 恒定 → 关闭后 8796)。 | rtb-ac4-lightbox.mjs / reduce;ac4.json、ac4-reduce.json |
| AC5 冷载顶部 3s 不请求证书图与设备图;滚到 ≈1200 后设备图已发;滚到证书区后证书图已发 | **fail**(第一项) | 冷载停顶部 3s:证书图 0 请求 ✓;但 **`/devices/phone.png` 在导航后 86ms 就被请求**(`/vi/` 113ms;两次探针 85ms,四次全复现)✗;s1/pro/rack 未请求 ✓。wheel 到 y=1136(vi 1150)+1s:s1.jpg / pro.jpg / rack.jpg 已请求(t≈4151ms,滚动一开始就发)✓。滚到证书区(y≈10312)+1s:cert-msb.png、cert-colorado.png 已请求(t≈11493ms)✓。 | rtb-ac5-resources.mjs root/vi;rtb-ac5b-initiator.mjs;rtb-ac5c-deck.mjs [4g] |
| AC6 慢网 `/vi/`:h1 得到 `.lr-ready` ≤ fonts.ready | **pass** | h1 `.lr-ready` 1697.5ms;init 时取得的 `document.fonts.ready` 在 2202.4ms resolve(loadingdone 12 面同刻);此刻 fonts.status 仍为 loading,Be Vietnam Pro 500 三子集 loaded、400 与 Space Mono 700 部分 loading、Funnel Display unloaded。1697.5 ≤ 2202.4 ✓。 | rtb-ac6-fonts.mjs vi;ac6-vi.json |
| AC7 宿主无 aria-label;页脚 `.wordmark` 动画期有 `.x-sr` | **pass** | `/`、`/vi/`、`/zh/` 各 50 个 `[data-lr]/[data-tw]` 宿主,终态无 aria-label,全程 MutationObserver 记到 0 次 aria-label 写入。`.wordmark`:t≈85–110ms 起已拆成 `.lr-line[aria-hidden=true]` + `.x-sr`「NexGrid」,直到 ≈9300–9453ms 复原为纯文本「NexGrid」;拆行期每一帧都有 `.x-sr`。附带:15 个 `[data-lr]` 拆行期 `.x-sr` 覆盖率 100%(69–477 帧/个,无缺帧)。 | rtb-ac7-sr.mjs ×3;ac7-*.json |

### AC3 fail 复现与根因(黑盒因果实验)

复现:`node rtb-ac3-slownet.mjs vi`(CDP 1.5Mbps/300ms,1440×900,非 reduced),看 `titleMinusBoot`,三次 1403–1426ms。

根因(**不是**读码,是延迟单个字体文件做的对照实验,快网):

| 单独延迟 3s 的文件 | h1 `.lr-ready` 时刻 | 结论 |
|---|---|---|
| 无 | 110ms | 基线 |
| be-vietnam-pro-**latin-400** | **2602ms** | 被等(封顶 ≈2.5s) |
| be-vietnam-pro-**latin-500** | **2595ms** | 被等(封顶 ≈2.5s) |
| be-vietnam-pro-latin-ext-500 | 119ms | 不等 |
| be-vietnam-pro-vietnamese-500 | 116ms | 不等 |
| be-vietnam-pro-latin-ext-400 | 134ms | 不等 |
| space-mono-latin-400 | 124ms | 不等 |
| funnel-display-**latin-400**(`/`) | **2594ms** | 被等 |
| funnel-display-**latin-500**(`/`) | **2594ms** | 被等 |

即揭示门 = 「显示字体 latin-400 与 latin-500 两面就绪(封顶 ≈2.5s)」。而 HTML 里 `<link rel=preload as=font>` 只预取了 **500**(`/vi/`:vietnamese-500 + latin-500;`/`:funnel-display-latin-500),**400 子集没预取**:慢网下 `/vi/` 的 be-vietnam-pro-latin-400 在 842ms(CSS 解析后)才发请求、1695ms 落地,`.lr-ready` 紧跟在 1706ms;`/` 的 funnel-display-latin-400 1353ms 落地、`.lr-ready` 1363ms(勉强落在 1.2s 内)。x-boot 由 head 内联脚本在 HTML 流到时即打(≈340ms),模块 JS 另起请求 969ms 才到——「距 x-boot 0.5–1.2s」这条 AC 在慢网下本就把 JS 下载时间也算进去了。

### AC5 fail 复现与根因

复现:`node rtb-ac5-resources.mjs root`(冷 context,1440×900,非 reduced,不节流),看 `s0.devices`。

事实:① HTML / CSS / JS 里对 phone.png 的唯一引用是叠卡第 0 张的 `<img src="/devices/phone.png" loading="lazy">`,无 preload、无 CSS background、无脚本 `new Image`;② CDP initiator type = `other`(无脚本栈)= 浏览器原生 lazy-load 引擎;③ 首帧(t=80.8ms)布局已是终态:该图文档 top 2860px、视口 900px → 距折叠线 1960px;其余 5 张卡被 translateX 1420–4260px 推到叠卡容器裁剪区外,故不触发。④ 用 CDP 仿真 4G(`connectionType: cellular4g`,20Mbps/20ms)时 phone.png **3s 内不请求**——headless 默认网络桶(NQE 未知)的原生 lazy 预取余量更大。即:按 AC 字面(冷载不节流)必现;在真实 4G 用户端多半不会;要 100% 保证「不请求」需要站点自己控 src(如 IO 触发再赋 src),`loading=lazy` 做不到。

## 额外发现(不计入 AC)

1. **[P2] 揭示门 2.5s 封顶会带出字体中途替换**:显示字体 latin-400/500 超过 ≈2.5s 才到时,标题用回退字体开始揭示,字体落地后 `font-display: swap` 再换脸(实验里 2595ms 揭示、3098ms 字体到)。极慢网可见一次揭示中途变字形。
2. **[观察]** 所有 15 个 `[data-lr]` 标题(含页脚 `.wordmark`)在 boot 后 ≈85ms 就被预拆成 `.lr-line`,而非进入视口才拆;页脚的拆行态持续到滚到底(≈9.3s)才复原。功能上无碍(读屏有 `.x-sr`),只是长期持有 15 组包装节点。
3. **[观察]** 拆行期宿主 `textContent` 为「x-sr 文本 + 视觉文本」双份(如「NexGridNexGrid」),`.lr-line` 已 `aria-hidden=true`,AT 读到一份,符合设计;若有人用 `textContent` 做选择器 / 快照测试要注意。
4. **[观察]** AC4:灯箱打开期间 `html` 上有 `lenis-stopped`,关闭后移除——Lenis 与 dialog 的停启配对正确;reduced 模式下无 Lenis 亦通过。
5. **[观察]** AC5:`/vi/` 与 `/` 的设备图 s1/pro/rack 在第一个 wheel 事件后立刻请求(scrollY 尚 <300),早于 AC 设想的「≈1200」——比预期更早,不违反 AC。

## 结论

PASS 5/7(AC3 `/vi/` 标题距 x-boot 1.40–1.43s 超出 1.2s;AC5 `/devices/phone.png` 冷载顶部 86–113ms 即被浏览器原生 lazy 引擎请求)。
