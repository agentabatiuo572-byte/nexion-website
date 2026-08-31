## P0
无

## P1
1. Base.astro:34「标题拍锚在字体就绪…fonts.ready」/ fx:587,596 锚开场钟 max(boot+delay,自身字重) → 改「预载缩短字重就绪;拍锚开场钟」
2. tokens.css:110「首帧的 clientWidth 就是终态可用宽」/ Base:87、fx:29 明禁 clientWidth→ 改「html rect 宽」;与 R45 踩坑根因相反
3. tokens.css:139「等宽标签…700(唯二 700 位)」/ :143 是 400(R44)→ 改 400,700 只剩 .xbtn
4. CLAUDE.md:20「html[lang=vi] 覆写」/ tokens:96-100 改 :lang(vi):not(html) 并明禁 html[lang] → 改写
5. CLAUDE.md:8「过 .x-invert 翻墨 0.25s」/ SiteNav:94-118 底板 0.25s、文字 54/196ms 瞬切;未提磨砂 → 补
6. CLAUDE.md:32「后两门要构建+真渲染」/ canvas-hazard 静态(gate-canvas-unit:1),只末门运行时 → 改「末门」
7. CLAUDE.md:32「390/768/1440/1920/2560」/ gate-canvas-geometry:40 = 390/1024/…,768 不在门内 → 改 1024
8. DevicesSection:244「裁切交给 main 的 overflow-x:clip」/ main 无此属性,在 Base:133 .x-frame → 改
9. DevicesSection:268「由 body 裁在屏缘」/ Base:130 写明 body 不裁 → 改 .x-frame

## P2
1. fx.ts:1-12 头注只列 ①-⑧ / 另有 ⑨灯箱(:466)⑩扰动(:862)→ 补
2. fx.ts:596「首屏 500、其余 400」/ 页脚字标也 500(SiteFooter:33)→ 改「Mega 500、其余 400」
3. SiteNav:122,475「300ms」/ :477 是 320 → 统一
4. SiteNav:254 R30 下载键孤注挂在 .menu-toggle 上,规则已不存在 → 移至 .dl-btn 或删
5. Base:2「自托管双字体」/ 三族(+Be Vietnam Pro)→ 改三
6. tokens.css:3「标签按钮 700」/ .x-label 400 → 改「按钮 700」
7. tokens:82、HeroSection:2-5、SiteFooter:2-4「→…vw」/ R42 起画布 px+zoom → 删 vw 尾巴
8.「琥珀」:FaqSection:4(R45 新写)、Hero:80、Mission:3,4,67,118、Social:71 / 08-21 已换柠檬 → 改
9. CLAUDE.md:8「Astro 5」/ 7.2.4 → 改
10. CLAUDE.md:8「Lenis(velocity 喂粒子)」/ fx 无 velocity → 删
11. CLAUDE.md:8「px→px/14.4 vw,±1.333 clamp」/ 被 :9-13 R42 zoom 壳取代 → 删
12. CLAUDE.md:8 引擎清单 ①-④ / fx 现 10 模块 → 指向头注
13. CLAUDE.md:8「小字密集板块必须不透明底」/ B1 页脚透底+护字层(SiteFooter:93)→ 补页脚例外
14. CLAUDE.md:24 证书条未提新增 cert-*@2x.png 1160w 灯箱源(Trust:25)→ 补
15. CLAUDE.md:32「全链约 11 秒」/ verify.mjs:176「分钟级」互斥 → 实测留一处
16. CLAUDE.md:40 axiom-probe.mjs / 仓内无此文件 → 删或落 scripts/
17. CLAUDE.md:53「[data-rail]/[data-rail-track]」/ 全仓 0 命中 → 改列 data-lr/tw/rv/deck/plx/scr
18. CLAUDE.md:56 Base 职责 / 漏 head 内联 boot(Base:78-95)→ 补
19. verify.mjs:173、gate-canvas-geometry:1「第七门」,gate-canvas-unit:1「第八门」/ 执行序 unit 7、geometry 8 → 对齐
20. 标记:verify.mjs:84「T11 升级为 dist 级死链扫描」未兑现;astro.config:6「域名占位,T13 核定」仍占位(Base:30 同);i18n/index.ts:10 ponytail 注准确;src 无 TODO/FIXME/PENDING

## 台账逐条核对
- 导航磨砂 → SiteNav:90-113;幕布/羽化带 → diff 已删
- B1 → SiteFooter:49-60;护字层 :93-100(台账 :46 已记)
- B2 → Hero:48 · B3b → tokens:383、FinalCta:32-37 · B5 → SiteNav:97,118,110-112
- B7 → LegalPrivacy:18,19,79,92;NexContent:228,235;Trust:185 · B8 → stats.ts:40-51;skus.ts:31,35 · B9b → Devices:30,154
- A1 → Base:83-95,35,53;tokens:318-321,377,398;fx:587 · A2 → fx:614-668;tokens:356-373
- A3 → SiteNav:327,260,438,279,50,432,431,332 · A4 → Trust:38,118,129-131,25;fx:480-487
- A5 → tokens:289-310;fx:681-698;rv-fade How:33/NexTeaser:24/Path:28;SiteNav:236 · A6 → Footer:122-131;LearnArticle:105;How:161
- A7 → fx:770-787;Devices:157-171 · A8 → tokens:314,331-344;fx:512,543,564
- A9 → Mission:174-181;fx:30;Base:89+tokens:111;SiteNav:462;Trust:232;tokens:198;Trust:175/How:144
- A10 → fx:181,446,460,545;Base:10;tokens:505;SiteNav:376。「.x-sr 取代 aria-label」仅行遮罩/打字机;fx:885 扰动链仍 aria-label(宿主 <a> 合规)→ 措辞收窄
- A11 → Base:32-33,37,50-52;Legal:16;404.astro;LearnArticle:19-23,36,57;LearnList:37;无尾斜杠内链 0 · A12 → SiteNav:219-222;How:150-154
- 门 → gate:200(经典滚动条)、:173(布局宽);.verify-exit.code=0(本审未复跑)
- 第三轮 :40-46 → SiteNav:123-128,130;LearnArticle:36,57;tokens:96-100;Trust:249-263;How:151;Footer:98;NexContent:244;LearnList:104;Legal:95;Devices:221;SiteNav:247;hover×3
- :47 待拍板值未动(Hero:29=500;SiteNav:147;tokens:195)· memory 与 plan:9 base-home.json 均存在 · 找不到:无
