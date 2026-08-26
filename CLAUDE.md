# nexgrid-website

NexGrid 官网(marketing site)。**纯展示站**:无登录/无交易,唯一转化 = App 下载(iOS/Android)+ H5 入口。规格唯一权威:`D:\WORKS\PLAN\PRD\NexGrid_官网PRD_v1.0.md`;实施拆解与 tester 报告在 `PLAN/PRD/specs/WEBSITE-*`。产品事实(SKU/收益机制/信任口径)只消费 App PRD v3.7,**不新造业务规则**。

## Heads-up(与直觉不同的点,最先读)

- **视觉体系 = axiom 方向**(主人 2026-08-20 指令:样式 100% 参照 axiom.peppermint.id,内容不变)。`src/styles/tokens.css` 自此为**本仓自有 SoT**(近黑 `--x-bg` / 反白 `--x-light` / 柠檬 `--x-accent`=V5 品牌 #9EDC1D 同值,2026-08-21 主人拍板由琥珀换系,粒子引擎双色公式同步柠檬族),不再镜像 App V5 dark tokens;App 侧 `nexion-design` 的 V5 字号/色板规则**对本仓不适用**(i18n/触达 44pt/focus/reduced-motion 纪律仍适用)。
- Astro 7 + Tailwind 4(`@tailwindcss/vite`,无 config)。**零框架 JS**:React 岛已全部移除(cobe 地球 → 自研洛伦兹 canvas)。交互引擎单文件 `src/scripts/fx.ts`(R2 契约,主人 2026-08-20):①洛伦兹粒子背景——**静止不旋转不缩放(离屏缓存+分桶批量描边,主体零重渲染),只有流光沿轨迹跑;滚动才驱动缩放/旋转;鼠标倾斜+推斥** ②Lenis 平滑滚动 ③进场 / 行遮罩 / 打字机 / 叠卡 / 视差 / 时钟等(模块清单见 fx.ts 头注)——reduced-motion 全降级。**鼠标一律原生光标(圆点已移除,勿回加)**;**R8 区带制(2026-08-21)**:整站按参考站 1440 画布等比(R42 起由画布 zoom 壳实现,见下条;区高 token `--x-sec-h`),首页=黑带(hero/stats/statement/about/叠卡)→白幕布带 `.band-light.x-invert`(六块,decked 时 fx 加 `.curtain` 上拉一个区高盖钉屏尾)→黑收尾;设备叠卡=fx `initPile` 画布节拍(锚 27.43%/16.63%、卡宽 45.14%、STEP=1.0923 卡宽、拍距=区高、总高=(N+1)·区高、末态全叠 0.85),移动/coarse/reduced=竖排静态列;导航 z40 常驻置顶,**半透明磨砂底板**(主人 2026-08-26 拍板;暗 .64 / 亮 .72 / 内页 .9),过 `.x-invert` 底板 0.25s 淡变、文字在亮度交叉点瞬切(R45);小字密集板块/页必须不透明底,禁文字直压粒子线(页脚例外:透底 + 信息列护字层,B1)。
- 🔴 **画布整体缩放(R42,2026-08-25 主人拍板换机制)**:参考站是「1440 画布整体缩放、1920 封顶、再宽居中」。
  本站 R40/R41 曾用三百多条声明**逐个模拟**这条曲线,两轮八份评审证明那条路的缺陷族补不完
  (门被换个写法即绕过,R39 那场原始事故可原样复活而两门全绿)。R42 改为**一层画布壳**:
  `.x-frame`(全宽裁切,停放的叠卡裁在屏缘)> `.x-canvas`(`width:1440px; margin-inline:auto; zoom: var(--x-zoom)`)。
  `--x-zoom = min(100vw,1920px)/1440px`;**断点 1440 以下** `zoom:1; width:auto`,退回自适应(窄屏行为不变)。
  断点定在 1440 是因为那里画布宽=视口宽、zoom 恰为 1,**两条曲线天然接合,裂缝在构造上不存在**
  (R41 定在 1200 曾留下 16.7% 硬跳变 + 小字掉到 10px + 触达破 44)。
  用 `zoom` 不用 `transform`:zoom 影响布局(零 JS 补高)且**不破坏 sticky**(叠卡编舞原样保留),transform 两条都不满足(已逐项实测)。
  ⚠️ **画布内禁用视口单位**(会被二次放大)——静态门守;导航条与粒子层在壳外,导航自套一份画布。
  ⚠️ JS 里量几何要分清**布局单位**(offsetHeight / style.height,画布量)与**屏幕单位**(getBoundingClientRect),两者差一个 zoom。
  — 检查:`canvas-hazard`(静态)+ `canvas-geometry`(运行时七判据)
- 字体 @fontsource 自托管:Funnel Display(display)+ Space Mono(mono)+ Be Vietnam Pro(vi 专用 display,Funnel 无 vietnamese 字集;语言尺一律挂元素自身的 `:lang()`,块级 lang 岛各吃各的尺)。zh 的 CJK 由系统字体栈接。
- 文案全 key 化进 `src/i18n/{en,vi,zh}.json`,三语 key 树必须全等(verify 门);硬编码文案=回归。
- 🔴 **本机截图验证坑(2026-08-20 实证)**:主人 Windows 全暗色主题,Chromium 无头/被遮挡窗口会**非确定性**触发强制暗色(Auto Dark)——反白板块被翻成黑底亮字(彩色/图片不动),连 `meta color-scheme` 都可能被无视,且同一配方时好时坏。**站点代码无罪**(最小复现页复现同症;计算样式/产物 CSS 全对;可见 GPU 窗口渲染正确)。协议:**DOM/计算样式断言任何模式都可信;亮区块(path/how/trust)的像素级截图必须用「废 canvas 无头」配方(addInitScript 令 #x-bg getContext 返回 null)或可见有头窗,且拍完必须回看**。暗区块截图不受影响。
- 🔴 Browser pane(Claude 面板)在深滚动位整页黑屏,不可作渲染判断面;真验证一律 Playwright(借 `Nexion-uniapp` 依赖:`createRequire('D:/WORKS/PLAN/Nexion-uniapp/package.json')('playwright')`)。
- 证书图 `public/cert-{msb,colorado}.png` 已降采样 660w(缩略 2x);灯箱用 `cert-*@2x.png`(1160w 原件);更早原件在 `.trash/*-cert-reencode/`。
- 源文件 CRLF 警告无害(Windows);commit 用 `-c core.autocrlf=false`。

## Commands

- dev:`npm run dev`(端口 **4321**;Browser pane 用 launch.json 名 `nexgrid-website`)
- 类型:`npm run typecheck`(astro check,完成前 0 错)
- 验证:`npm run verify`(**10 门**:禁用词/三语 parity/部署门 warn/锚点/brand-parity/particle-hue/**canvas-hazard**/**css-shadowed**/**canvas-geometry**/**render-fit**);**退出码读 `.verify-exit.code` 文件不读管道**(开跑即置 2,崩溃/中止不会留下上一次的绿)
  - `css-shadowed`:抓「写进去了但从未生效」的死声明——同一规则内同属性重复、或更窄的 media 块写在基础规则**前面**(嵌套 media 不加特异度,同层靠源序决胜)。同型踩过两次且两次都是独立评审逐像素才量出来的;逃生阀 `/* shadow-ok */`,红测 `scripts/test-css-shadowed.mjs`(红绿两向 13 条)。🔴 它对**正交相交**的媒体块也报(如 `max-width:860` 与 `max-height:520` 各自都不是对方的超集,却在横屏手机上重叠):那不是死声明,但答案藏在「谁写在后面」里 —— 修法是**把两块写成互斥**(`and (min-height: 521px)` / `max-height: 520px`),别加逃生阀
  - `render-fit`:**墨迹不能相撞**,三条判据。A 行间:逐行取出该行的字、用它自己的字体量实际上伸/下伸,上一行的墨底不得低于下一行的墨顶;B 层间:首屏文字的墨不得钻进导航磨砂蒙版底下;C:`--x-nav-h` 的声明值 × zoom 必须等于导航实测高(首屏上内衬从它派生,声明漂了就红)。
    🔴 **三条判据全部构造性,禁止改回手写清单**:路由从 `dist/**/index.html` 枚举、视口从产物 CSS 的媒体断点推导(压缩器会把 `(max-width:860px)` 改写成 `(width<=860px)`,两种写法都要认;**解析出 0 个断点必须 exit 3**,不许拿「地板+天花板」冒充覆盖)、墨高用 canvas 逐行实测(不设常数、不设字体表)。上一版三张手写清单各漏一块:漏 9 条路由、漏窄屏整面、漏了 Be Vietnam Pro 的字身(实测 Space Mono 1.22 / Funnel 1.15 / **Be Vietnam Pro 1.37** 倍字号,而常数写的是 1.3)。
    豁免只有「单行」与元素级逃生阀 class `line-fit-ok`;**「作者写死断行」曾是豁免、已删除** —— 墨撞就是撞,那条整块放过了撞得最狠的首屏大标题(逐行实测 −29.2px)。自检 `node scripts/gate-render-fit.mjs --self-test`(6 条,红绿两向)
  - 两道运行时门要构建+真渲染(canvas-geometry 33 路由×5 档宽 390/1024/1440/1920/2560,R45 起**带经典滚动条**跑、可用宽取 html 布局宽;render-fit 自带静态服务直接伺服 dist,不跟 astro preview 抢单例);其余八门全是文本/token/静态检查,**没有一门看渲染盒子**,R39 的「正文被挤成 33px」正是在静态门全绿时溜进产物的
  - `brand-parity`:官网 `--x-accent`+`--x-on-accent` 必须是 App `Nexion-uniapp/src/styles/tokens.css` **同一主题块**内的 brand+on-brand 配对(锁跨主题错配),且 `--x-accent-ink` 必须 `var(--x-accent)` 引用(封第二字面量漂移旁路);App 仓不在本机时 warn 放行
  - `particle-hue`:`fx.ts` 注释里 `HUE-GUARD:<名> (r,g,b)` 标注的粒子三端须与品牌同色相带 ±6°——**改粒子色值必同步改标注**,否则门失效
- 🔴 **机械改写后必跑逐元素回归**:`node scripts/visual-diff.mjs snap <url> <a.json> [宽度]` 前后各一次,再 `diff a.json b.json [容差%]`
  — why:R40-R42 三轮,每轮都在修好真东西的同时造新伤,同一个模式——**大范围改写后用总量指标(页高/门全绿)验收,总量对逐元素回归是瞎的**。
  R42 用页高「修好」了手机端,而那个修法本身把窄屏标题砍掉 44%,页高恰好正常所以没被发现,直到独立评审逐元素量才抓到。
  键 = 标签+类名+**数字归一后的文本**+序号(插包装层不影响;不归一则实时时钟会让该元素被静默排除出比对)。
- 生产门:`npm run verify:prod`(部署门升硬红:`PENDING-TRUST-ASSETS` 标记或 Legal 页缺失 → exit 2)

## 完成门(宣布子任务 done 前)

1. typecheck 0 错 → 2. `npm run verify` exit 0 → 3. Playwright 真浏览器实测(交互断言 + console=0;亮区块截图按上述协议)→ 4. 独立 tester 黑盒验收(AC 出自官网 PRD 对应 FEAT;**tester 在途期间本仓零写入**,机器门让 tester 用 `git archive` 隔离副本跑)。
- 🔴 **探针与评审 agent 一律打构建产物(4399),绝不打 dev**(2026-08-21 同型三踩定规):`npm run build` 后 `npx astro preview --port 4399` 常驻(产物静态文件,build 覆盖 dist 即新,无陈旧可能),探针与评分/走查 agent 的 URL 全用 4399——why:整文件重写 .astro 后 dev 的 HMR 供应旧 scoped 样式(模板热、样式陈旧),R19/R22 坑了自证探针、R23 坑了评分 agent(整份评审基于杂种页面作废);dev(4321)只作主人观看面,大改后冷重启一次。评审报告收到后先核「证据指纹 vs 产物实测」,矛盾即判环境失效作废重派。
- 🔴 **视觉整改评分门**(主人 2026-08-21 拍板,本整改线有效;及格线 2026-08-26 主人改令 9 → 8.5):每轮视觉改动完成后派 **≥3 路独立评审 agent** 从不同角度打分(角度按改动性质选,如原版还原度/排版工艺/视觉叙事),每路满分 10;**任一路 <8.5 → 按扣分点重新设计再送审**,全 ≥8.5 才许提交收包。派单守审计独立性(不告知门槛/轮次/期望),报告收齐前被审文件冻结。**1A 判例(主人 2026-08-21 立、08-22 换色战役二次援引)**:结构性扣点清零后,若剩余扣点进入「评审口味震荡」(扣点逐轮换人换项、两角度对同一元素反向要求、分数无收敛趋势)→ 停机械循环,给主人全景分数+冲突台账+选项拍板收线;两次实录:mission 六轮(工艺 9.2/还原度 8.6/叙事结构项全落地)、柠檬换色六轮(工艺 9.3/品牌扣点全修/氛围 8.6 口味带)。
- 🔴 **评审报告是待核实断言,不是判决**(2026-08-22 三次实证):收到扣分先回源核对再动手——曾出现「测错元素」(量容器继承值当答案层字号,撤销 1.2 分误判)、「只扫单个 CSS 文件即断言死 token」(结论对但方法窄)、「产物实算 5.33:1 却报 2.64:1」。判据:**扣分点与自证探针/产物实测矛盾时,以产物为准并向评审发勘误质询**(只给矛盾数据与复核方法,不暗示结论)。
- 🔴 **回源核实只封住「评审说错」,封不住「评审说对了、但那件事本来就不该动」**(2026-08-25 实证):扣点「首屏标题比页脚字标小」测量成立,我照改并顺手缩短了主人的文案,主人当场推翻——那个字号本来就是调好的。**仓库里已存在、且主人看过的数值 = 决定,不是默认值**;凡扣点在说「某个既有值该换个数」(字号/间距/比例/配色/**文案**),一律先报主人,评分低不构成授权。评审可自主执行的只有**新增缺陷**(死链/溢出/不对齐/撞车/不可读)。检查:无机器门(评审看不见值的来历),靠本条 + memory 心智层。

## 架构(单一真源指针)

- 设计 token:`src/styles/tokens.css`(axiom 方向自有 SoT;含 `.xbtn` slide-swap/`.x-mono`/`.x-invert` 反白区块等全局型类);组件禁硬编码 hex,一律 var(--x-*)
- 交互引擎:`src/scripts/fx.ts`(Base.astro 全站单点挂载;canvas id=`x-bg`;钩子 `[data-rv]` 进场 / `[data-lr]` 行遮罩 / `[data-tw]` 打字机 / `[data-deck]` 叠卡 / `[data-plx]` 视差 / `[data-scr]` 扰动)
- i18n:`src/i18n/{en,vi,zh}.json` + `index.ts` 的 `useT()`;en 为源语言
- 下载/H5 链接:构建环境变量 `PUBLIC_IOS_URL / PUBLIC_ANDROID_URL / PUBLIC_H5_URL`——空值=按钮 Coming-soon 降级/H5 不渲染,**零死链**
- 全局壳:`src/layouts/Base.astro`(SEO meta/hreflang/`meta color-scheme=dark`/favicon/标题后缀规则;head 内联脚本首帧前挂 `html.js`/`html.x-boot`/`--x-vw`)挂 `SiteNav`/`SiteFooter` + canvas + fx

## 红线(违反即返工)

- 🔴 **官网不出现任何收益数字/收益承诺**(主人 2026-08-20 裁决,含计算器已删)——why:英文市场证券化表述高危;检查:`npm run verify` 禁用词门
- 🔴 信任板块只放主人提供的真实注册实体资料;App PRD §11.3 的占位背书(投资方/审计/媒体)**一项不得出现**——why:公网虚假背书=虚假陈述;检查:资料未到位时 `PENDING-TRUST-ASSETS` 标记 + verify:prod 拦截
- 🔴 文案改动跑 verify 禁用词门;i18n 三语同步不豁免
