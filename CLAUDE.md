# nexgrid-website

NexGrid 官网(marketing site)。**纯展示站**:无登录/无交易,唯一转化 = App 下载(iOS/Android)+ H5 入口。规格唯一权威:`D:\WORKS\PLAN\PRD\NexGrid_官网PRD_v1.0.md`;实施拆解与 tester 报告在 `PLAN/PRD/specs/WEBSITE-*`。产品事实(SKU/收益机制/信任口径)只消费 App PRD v3.7,**不新造业务规则**。

## Heads-up(与直觉不同的点,最先读)

- Astro 5 + Tailwind 4(`@tailwindcss/vite`,无 tailwind.config)+ React 19 岛(`@astrojs/react`)。样式主要是组件内 `<style>` + token,Tailwind 按需。
- 🔴 **Claude 浏览器面板(Browser pane)会剥 HTML 注释 → Astro 岛在里面永不水合**(`astro-island` 等 `<!--astro:end-->` 信号被剥,卡 `await-children`)。岛/水合类验证**必须用 Playwright 真浏览器**:探针脚本模式见 `scratchpad/globe-probe.mjs`(借 `Nexion-uniapp` 的 playwright 依赖,`createRequire('D:/WORKS/PLAN/Nexion-uniapp/package.json')`)。pane 只可看静态渲染,勿据 pane 判「岛坏了」。
- cobe 用 **v2 API**:`globe.update(state)` + 自持 rAF;`onRender` 已从类型移除,别用。
- 文案全 key 化进 `src/i18n/{en,vi,zh}.json`,三语 key 树必须全等(verify 门);硬编码文案=回归。
- 源文件 CRLF 警告无害(Windows);commit 用 `-c core.autocrlf=false`。

## Commands

- dev:`npm run dev`(端口 **4321**;Browser pane 用 launch.json 名 `nexgrid-website`)
- 类型:`npm run typecheck`(astro check,完成前 0 错)
- 验证:`npm run verify`(4 门:禁用词/三语 parity/部署门 warn/锚点);**退出码读 `.verify-exit.code` 文件不读管道**
- 生产门:`npm run verify:prod`(部署门升硬红:`PENDING-TRUST-ASSETS` 标记或 Legal 页缺失 → exit 2,半成品发不出去)

## 完成门(宣布子任务 done 前)

1. typecheck 0 错 → 2. `npm run verify` exit 0 → 3. Playwright 真浏览器实测(岛水合 + console=0)→ 4. 独立 tester 黑盒验收(AC 出自官网 PRD 对应 FEAT;**tester 在途期间本仓零写入**,机器门让 tester 用 `git archive` 隔离副本跑)。

## 架构(单一真源指针)

- 设计 token:`src/styles/tokens.css` —— 从 `Nexion-uniapp/src/styles/tokens.css` dark 段逐字节移植的子集;改值先改 App 源再同步,**禁本仓自创色值/硬编码 hex**
- i18n:`src/i18n/{en,vi,zh}.json` + `index.ts` 的 `useT()`;en 为源语言
- 下载/H5 链接:构建环境变量 `PUBLIC_IOS_URL / PUBLIC_ANDROID_URL / PUBLIC_H5_URL`——空值=按钮隐藏/Coming soon 降级,**零死链**
- 全局壳:`src/layouts/Base.astro`(SEO meta/hreflang/favicon)挂 `SiteNav`/`SiteFooter`
- Home 未落地板块:`src/components/HomeSkeleton.astro` 占位(id 一律字面量,anchor 门按字面量扫);逐板块落地后删对应 stub

## 红线(违反即返工)

- 🔴 **官网不出现任何收益数字/收益承诺**(主人 2026-08-20 裁决,含计算器已删)——why:英文市场证券化表述高危;检查:`npm run verify` 禁用词门
- 🔴 信任板块只放主人提供的真实注册实体资料;App PRD §11.3 的占位背书(投资方/审计/媒体)**一项不得出现**——why:公网虚假背书=虚假陈述;检查:资料未到位时 `PENDING-TRUST-ASSETS` 标记 + verify:prod 拦截
- 🔴 UI 改动前加载 `nexion-design` skill(V5 token/字重 ≤600/零 border 卡/44pt);文案改动跑 verify 禁用词门
