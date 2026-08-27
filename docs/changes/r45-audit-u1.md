## P0
无

## P1
1. **Mega 多行标题动画期行缝多 0.24em,收尾整行上跳(首屏 h1 三语全中)**
   触发:`.x-display-mega` ≥2 行(hero h1 en/vi/zh 皆由 `\n` 强制 2–3 行)。
   依据:tokens.css:345-348 padding .26/.24em + margin −.26/−.24em——相邻兄弟负 margin 折叠取最负值(−.26)而非相加(−.50),每缝净 +.24em;fx.ts:570 锁高只藏宿主增高,行内位置仍错。实测 Δ(还原−动画):en@1440 第 2 行 −23px,vi −23/−47,zh −26;@390 vi −10/−20、zh −13;transitionend 时上跳。
   建议:`.lr-line` 改 `clip-path: inset(-.26em -.05em -.24em)` 取代 overflow+padding+负 margin(零布局副作用、无折叠、免锁高)。

2. **vi 档 `.lr-line` 同病:每缝 +0.14em,所有多行越南语标题收尾上跳**
   触发:`/vi/` 任一多行 `[data-lr]`(social h2、how h2/p、三区 h3、final h2;@390 几乎全部)。
   依据:tokens.css:340-343 padding .16/.14 + margin −.16/−.14,折叠后净 +.14em/缝。实测 Δ:54px −6.9(三行 −6.9/−14.3)、40px −5.1、32px −4.5/−8.9、28px −3.9;宿主被锁高,内容压向下一元素;en 档单侧 padding Δ=0(对照)。
   建议:同 1。

3. **build 后视口变化不重拆行:行组过期、锁高宿主溢出压下文、还原整块跳**
   触发:build(≈90ms,15 宿主一次建完)与滚到该标题之间发生 resize / 横竖屏 / 缩放 / 开 DevTools;fx.ts:583-598 无 resize 处理。
   依据:1440→700:h3「Start free…」单个 `.lr-line` 内部折 2 行整块上滑,还原 1→2 行;social h2 2→1 行。390→1440 vi:锁高宿主 scrollH 185 / offH 96,h3「Nhận thanh toán…」内容底压过下一元素 88px,还原 2→3 行。三语两向均复现。
   建议:`resize`/`orientationchange` 去抖后对未播放宿主 `textContent=original; height=''` 重 build;播放中的结束后重排。

## P2
4. **还原只挂 `transitionend`:过渡被取消即永久卡在拆行态(含 P1-1 错行距)**
   触发:播放中切系统「减少动态」/ print / 祖先 display:none(fx.ts:573-581)。
   依据:t=800ms 切 reduce,2.5s 后 h1 仍 lines=2、x-sr=1、height=159px、transform none,切回不恢复——第 2 行永久低 23px。
   建议:加 `transitioncancel` + `setTimeout(delay+90(n−1)+900+200)` 幂等兜底还原。

5. **非 x-boot 导航(刷新 / 后退 / 带锚点)h1 仍等 BOOT_T0+500:标题最后出现**
   触发:reload / back_forward / `/#hash`;fx.ts:587 不看 `html.x-boot`(Base.astro:93 仅 navigate 挂)。
   依据:reload 29ms 时 sub=1 nav=1 而 h1 空(内层 110%),565ms 才 `.in`,1566ms 还原;navigate 下为 nav .48→h1 .63→sub 1.49s。
   建议:`delay = x-boot ? delay : 0`(或建好即播)。

6. **display 字体慢于 ≈1.3s 时标题仍漂到副题之后(注释称已解,未解)**
   触发:latin-500 延迟 2s(3G 级);fx.ts:587 锚 BOOT_T0 但 build 仍等字体(603-609,cap 2.5s > 副题拍 1.4s)。
   依据:h1 hidden 至 2015ms(built 2013 / play 2033 / restored 3049),sub 1.5→2.0s 已满亮。
   建议:cap ≤1.2s,或副题/按钮拍改由「标题已播」的 html 类触发。

7. **字体等待只覆盖含 U+0020 的子集:vi 叠音符子集未等,build 在其 loading 中进行**
   触发:`/vi/` 慢网;fx.ts:606-608 `fonts.load(key)` 默认 text=" "。
   依据:`fonts.load('400 16px "Be Vietnam Pro",…')` 实测只返回 U+0-FF 面;延迟 vietnamese-400/500 后 build 时该面仍 loading(h1–h3 全部),拆行按回退字形量;本轮文案未改行数,但音符在上滑中途换字形,换文案即可能错行。
   建议:`document.fonts.load(key, original)`。

8. **遮罩余量:en 降部已贴边,vi 大写叠音符必切**
   依据:Funnel Display g/y 需 .105em,底给 .1(tokens.css:336):实测「earning」−0.2px、「How you get it」−0.5px 被切。Be Vietnam Pro 大写 Ậ/Ệ/Ố 需 .305em(vi 档 .16)、Mega 需 .41em(给 .26):当前文案无大写叠音符;以 Ấ/Ệ/Ố 起头的新标题顶部会切 ≈.15em(54px≈8px)。zh 余量正常。
   建议:clip-path 后余量免费,给 .32/.42em。

9. **未播放宿主文本双份:查找 / 复制命中两次**
   触发:任一未滚到的 `[data-lr]`(t=1s 时 15 个 `.x-sr` 全在;不滚到底则页脚字标永久双份);fx.ts:551-555 x-sr 与行 span 并存。
   依据:`innerText` 中「Put your idle devices to work.」「What the network computes」各 2 次;Ctrl+F 计数翻倍且首命中落在 1px 隐藏节点。
   建议:行 span `user-select:none`;x-sr 仅在播放期存在。

## 观察
- 4399 供的是 06:26 dist,与 fx.ts/tokens.css 同时刻(bundle 关键串与 CSS 规则均与源一致),行号引用有效。
- 正常路径全绿:三语 ×1440/390 全滚后残留 0、15/15 lr-ready;9 条路由 console 0 error;reduced-motion 66ms 内 15/15 直显;print 可归位;zh Segmenter 拆行数与纯文本一致;IO 单发。
- 锚点直达 `/#final-cta`:无 Lenis 飞行,目标顶 83px 对 scroll-margin 84px;仅视口内两标题 + h1(离屏照播)播放,锚点以上标题留在拆行态待上滚(与 P2-9 叠加)。
- 首屏闪现:本地 build(33–39ms)早于 FCP(60–68ms),404/法务短页页脚在首屏也未见先绘再消失;生产慢网模块晚于 FCP 则会 [INFERRED]。2560×1440 首屏仅 h1。
- 宿主必须纯文本(`el.textContent` 拍平子标记;当前 15 个均纯文本);15 个 `.lr-inner` will-change 合成层常驻至被滚到,未量化。
