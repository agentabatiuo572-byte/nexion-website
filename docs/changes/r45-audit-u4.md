## P0
无

## P1
1. 图标全套仍是琥珀旧色:`public/favicon.svg` stroke `#DA840A`;R45 新增 `favicon.ico`(32×32 PNG-in-ICO)/`apple-touch-icon.png`(180×180)实测主色 rgb(216,136,8),而 `src/styles/tokens.css:34 --x-accent:#9edc1d`(08-21 拍板柠檬)。触发:任何标签页 / iOS 桌面 / JSON-LD logo(`Base.astro:75`)。后果:站内全柠檬、图标琥珀;svg 注释「与 --x-accent 同源」已失真,新资产据此翻制。
2. 文案指向不存在的截图:`src/content/learn/{en,vi,zh}/getting-started.md:29`「Screenshots follow… / Ảnh chụp… / 截图对应当前 App 版本」,18 篇 md 无任何图片(`![` 0 命中)。触发:读到文末引用块。后果:读者找不到截图=错文;PRD WEB11 阳光「步骤图文(截图占位)」未落地。
3. 404 页语言切换死链:`Base.astro:99` 把 `path="/404"` 交给 SiteNav,`SiteNav.astro:22 langHref` 生成 `/vi/404/`、`/zh/404/`(实测 404)。按口径字面属 P0 死链;实际落点仍是同一三语 404 页、用户无损,故判 P1,主人可升。方向:noindex 页语言链回各语首页。

## P2
4. zh 术语分叉:`zh.json:192 learn.related`「相关指南」,同文件 176-180 学习中心全用「教程」(en 全 guides、vi 全 hướng dẫn 一致)。触发:zh 文章页尾。后果:同页两套称谓。
5. 序号 `0{n+1}` 无 padStart:`LearnArticle.astro:42`(同型 `LearnTeaser.astro:25`、`TrustSection.astro:49`,后两处有界)。触发:某篇 ≥10 个 h2。后果:显示 010/011;StatsBar/LearnList 已用 padStart,同站两写法。
6. 缺译回退态三处欠账(当前 18 篇齐全未触发,机制层):`LearnArticle.astro:51` 英文正文不带 `lang="en"`(html lang=vi 包英文);`Base.astro:58` 仍向 hreflang=vi 宣告该 URL 为越南语版(内容英文=跨语重复);相关文章行 `LearnArticle.astro:60-66` 无 `learn.enOnly` 标记(`LearnList.astro:32` 有)。
7. og.png 仍为 08-20 琥珀期资产:1200×630 采样含 rgb(72,56,24)/(56,40,24) 暗琥珀晕,与 #1 同族。触发:社交分享卡。后果:分享图与站色不一致。
8. 目录 `<ol>` `list-style:none`(`LearnArticle.astro:38,132-134`)未加 `role="list"`,Safari/VoiceOver 丢列表语义。

## 观察
- 运行时全绿:33 路由 + /404 的 console / pageerror / 失败请求 = 0;121 条内链除 #3 外全 200,页面内链全带尾斜杠,`#download/#how/#devices/#trust/#stats` 目标 id 存在;canonical / hreflang / sitemap 三方同形(尾斜杠)。
- 18 篇文章:目录 href 与 `<h2 id>` 逐条相等(vi 声调、zh 汉字、数字开头 id 均可),`fx.ts:449 getElementById` 不吃选择器语法,点击补间后目标顶距 84 ≥ 导航 74、hash / 焦点同步;相关文章恒 2 条、不含本篇、不重复、标题为本语;fallback 时 `slugOf` 去语言前缀与列表 slug 一致(`learn.ts:10-23`)。
- 数字格式:SSR 与客户端 count-up 终值逐字相等(en/zh `28,432·99.7%`,vi `28.432·4.812·99,7%`),1440/390/360 与 reduced-motion 均验;价格恒 en-US `$1,199`,倍数随语言 `1.250×`(vi)——同卡两套千分位是 B8 拍板结果,只记不扣;`$19.9` 无补零,与 App PRD §7.1 字面一致。
- i18n:三语 185 key 树与顺序全等,无与 en 同文的漏译,新增 key 无工程名词;禁用词 / 占位背书 0 命中(含 learn md 与 notfound.*)。
- 404:`dist/404.html` 存在,`/nonexistent` 返回它(404 状态);noindex、无 canonical / hreflang、三块 lang=en/vi/zh、单 h1、回各语首页;`og:url=/404/`(`Base.astro:63` 对 noindex 页仍发)无害;Chrome 对任何 404 文档都记一条「Failed to load resource」console error,非站点缺陷。
- 图标 `<link>` 顺序 ico(sizes=32×32)→ svg → apple-touch 符合惯例;ico 仅 1 枚 32×32 PNG 编码项。证书 `@2x` 实为 1160×1548 = 1.76×(1x 660×881)、RGB 无 alpha,仅作灯箱源(`TrustSection.astro:25,31`)——命名名不副实,灯箱 760 画布 px 在 DPR2 略软。
- 机制盲点:vi/zh 独有而 en 缺的文章不生成路由也不报错(`learn.ts:17` 以 en 为骨架、`[slug].astro:7` 只取 en);`SocialSection.astro:31` countries 未过 fmtStat(<1000 无影响);learn CTA 复用 `nex.getApp` key。
- 证据脚本:scratchpad `au4-runtime.mjs` / `au4-i18n.mjs` / `au4-icons.mjs`,日志 `au4-runtime.log`。
