# nexgrid-website

NexGrid 官网(marketing site)。**纯展示站**:无登录/无交易,唯一转化 = App 下载(iOS/Android)+ H5 入口。规格唯一权威:`D:\WORKS\PLAN\PRD\NexGrid_官网PRD_v1.0.md`;实施拆解与 tester 报告在 `PLAN/PRD/specs/WEBSITE-*`。产品事实(SKU/收益机制/信任口径)只消费 App PRD v3.7,**不新造业务规则**。

## Heads-up(与直觉不同的点,最先读)

- **视觉体系 = axiom 方向**(主人 2026-08-20 指令:样式 100% 参照 axiom.peppermint.id,内容不变)。`src/styles/tokens.css` 自此为**本仓自有 SoT**(近黑 `--x-bg` / 反白 `--x-light` / 琥珀 `--x-accent`),不再镜像 App V5 dark tokens;App 侧 `nexion-design` 的 V5 字号/色板规则**对本仓不适用**(i18n/触达 44pt/focus/reduced-motion 纪律仍适用)。
- Astro 5 + Tailwind 4(`@tailwindcss/vite`,无 config)。**零框架 JS**:React 岛已全部移除(cobe 地球 → 自研洛伦兹 canvas)。交互引擎单文件 `src/scripts/fx.ts`(R2 契约,主人 2026-08-20):①洛伦兹粒子背景——**静止不旋转不缩放(离屏缓存+分桶批量描边,主体零重渲染),只有流光沿轨迹跑;滚动才驱动缩放/旋转;鼠标倾斜+推斥** ②Lenis 平滑滚动(velocity 喂粒子) ③data-rv 进场 reveal ④UTC 时钟——reduced-motion 全降级。**鼠标一律原生光标(圆点已移除,勿回加)**;设备板块=CSS sticky 滚动叠卡(无 JS)。导航 z1 在内容 z2 之下(参考站哲学:反白区块盖过导航);小字密集板块/页必须不透明底,禁文字直压粒子线。
- 字体 @fontsource 自托管:Funnel Display(display)+ Space Mono(mono)+ Be Vietnam Pro(vi 专用 display,Funnel 无 vietnamese 字集,`html[lang=vi]` 覆写)。zh 的 CJK 由系统字体栈接。
- 文案全 key 化进 `src/i18n/{en,vi,zh}.json`,三语 key 树必须全等(verify 门);硬编码文案=回归。
- 🔴 **本机截图验证坑(2026-08-20 实证)**:主人 Windows 全暗色主题,Chromium 无头/被遮挡窗口会**非确定性**触发强制暗色(Auto Dark)——反白板块被翻成黑底亮字(彩色/图片不动),连 `meta color-scheme` 都可能被无视,且同一配方时好时坏。**站点代码无罪**(最小复现页复现同症;计算样式/产物 CSS 全对;可见 GPU 窗口渲染正确)。协议:**DOM/计算样式断言任何模式都可信;亮区块(path/how/trust)的像素级截图必须用「废 canvas 无头」配方(addInitScript 令 #x-bg getContext 返回 null)或可见有头窗,且拍完必须回看**。暗区块截图不受影响。
- 🔴 Browser pane(Claude 面板)在深滚动位整页黑屏,不可作渲染判断面;真验证一律 Playwright(借 `Nexion-uniapp` 依赖:`createRequire('D:/WORKS/PLAN/Nexion-uniapp/package.json')('playwright')`)。
- 证书图 `public/cert-{msb,colorado}.png` 已降采样 660w(显示 2x);更高清原件在 `.trash/*-cert-reencode/`。
- 源文件 CRLF 警告无害(Windows);commit 用 `-c core.autocrlf=false`。

## Commands

- dev:`npm run dev`(端口 **4321**;Browser pane 用 launch.json 名 `nexgrid-website`)
- 类型:`npm run typecheck`(astro check,完成前 0 错)
- 验证:`npm run verify`(4 门:禁用词/三语 parity/部署门 warn/锚点);**退出码读 `.verify-exit.code` 文件不读管道**
- 生产门:`npm run verify:prod`(部署门升硬红:`PENDING-TRUST-ASSETS` 标记或 Legal 页缺失 → exit 2)
- 运行时探针(29 项交互断言):`node <scratchpad>/axiom-probe.mjs`(会话临时件,模式可复制:Lenis/canvas 动画/光标/时钟/reveal/横向轨/三语/移动/reduced)

## 完成门(宣布子任务 done 前)

1. typecheck 0 错 → 2. `npm run verify` exit 0 → 3. Playwright 真浏览器实测(交互断言 + console=0;亮区块截图按上述协议)→ 4. 独立 tester 黑盒验收(AC 出自官网 PRD 对应 FEAT;**tester 在途期间本仓零写入**,机器门让 tester 用 `git archive` 隔离副本跑)。

## 架构(单一真源指针)

- 设计 token:`src/styles/tokens.css`(axiom 方向自有 SoT;含 `.xbtn` slide-swap/`.x-mono`/`.x-invert` 反白区块等全局型类);组件禁硬编码 hex,一律 var(--x-*)
- 交互引擎:`src/scripts/fx.ts`(Base.astro 全站单点挂载;canvas id=`x-bg`,横向轨 `[data-rail]`/`[data-rail-track]`,reveal `[data-rv]`)
- i18n:`src/i18n/{en,vi,zh}.json` + `index.ts` 的 `useT()`;en 为源语言
- 下载/H5 链接:构建环境变量 `PUBLIC_IOS_URL / PUBLIC_ANDROID_URL / PUBLIC_H5_URL`——空值=按钮 Coming-soon 降级/H5 不渲染,**零死链**
- 全局壳:`src/layouts/Base.astro`(SEO meta/hreflang/`meta color-scheme=dark`/favicon)挂 `SiteNav`/`SiteFooter` + canvas + fx

## 红线(违反即返工)

- 🔴 **官网不出现任何收益数字/收益承诺**(主人 2026-08-20 裁决,含计算器已删)——why:英文市场证券化表述高危;检查:`npm run verify` 禁用词门
- 🔴 信任板块只放主人提供的真实注册实体资料;App PRD §11.3 的占位背书(投资方/审计/媒体)**一项不得出现**——why:公网虚假背书=虚假陈述;检查:资料未到位时 `PENDING-TRUST-ASSETS` 标记 + verify:prod 拦截
- 🔴 文案改动跑 verify 禁用词门;i18n 三语同步不豁免
