# R48 · 玻璃改版:首屏段换皮 + 「工作原理→页底」重构

Status: **Aligned**(主人 2026-08-27 逐项拍板后「定稿开工」;设计画布 https://claude.ai/code/artifact/869c7df8-8d65-431d-a806-3f0775f63efd)
Branch: `restyle/glass`(基 `eb3b326`)

## Why

主人 2026-08-27 改令:整体风格改为磨砂玻璃 + 圆角;白色大块区域按内容重构;**参照站路线退役**(R45 差距提案作废,客观缺陷项保留并入本轮)。
拍板链:① 深色沉浸·地球全程透底 ② 首页+全局件先行(子页第二包)③ R45 作废留客观缺陷 ④ 重构段拆法 = **B+C 杂交**(蜂巢玻璃瓷砖 + 幽灵编号/大字错位记忆点)⑤ 首屏段只换皮 ⑥ 定稿开工。

## What changes

**Zone 1 换皮(Hero / Stats / Social / Mission / Devices 叠卡 + 导航;DOM 结构、文案 key、滚动编舞不动)**
- tokens:新增玻璃系 token(`--x-glass*`、圆角档)+ `.x-tile` 工具类;`.xbtn` 全圆角胶囊化。
- 导航:全出血磨砂条 → 画布内**悬浮圆角玻璃条**(底板从 `.site-nav::before` 移到 `nav` 自身;`--x-nav-h` 同步重标,render-fit 判据 C 钉住;翻色机制保留但首页无浅带后自然休眠)。
- 数据条:五格开放列 → 一条玻璃圆角横带(数字/count-up/SSE 逻辑不动)。
- 叠卡:卡面 `.x-paper` 白卡 → 玻璃卡(几何锚位/编舞/门 11 判据不动;序号章与徽章改暗玻璃胶囊)。

**Zone 2 重构(#how 起到页底;结构自由)**
- `band-light x-invert` 白幕布退役 → `band-deep` 透明深带(z10 与 curtain 上拉机制保留;fx 选择器随迁;叠卡在 curtain 重叠段加淡出,防透出钉屏卡)。
- 五章蜂巢:01 工作原理 / 02 加入方式 / 03 信任 / 04 NEX / 05 学习+FAQ——玻璃瓷砖 + 幽灵编号章头左右交替;打字机/行遮罩/进场/视差钩子保留;contour 线稿图保留(墨色翻暗底)。
- 信任章:证书实图 + 灯箱机制原样;五卡文案全量保留(重排进瓷砖,不删一句法务文案)。
- 末屏 CTA:大字错位压玻璃板(C 记忆点);下载三键组件原样(后台配置钩子不动)。
- 页脚:透底散排 → 玻璃圆角面板(链接/免责/暂停背景键/护字层逻辑保留;品牌字标与方标保留)。
- i18n:新增 `path.headline` ×3(主人已过目英文稿);其余全用既有 key。
- print:band-deep / 玻璃面片翻纸面。

## Out of scope

学习/NEX/法务子页与 404 的玻璃化(第二包);评审 P2 遗留四项;下载 URL 后台接线;R45 A 包中与本轮版面无交集的缺陷(死链/灯箱滚轮类已在 R45-R46 修过的不重做)。

## Impact

- 页面:三语首页(en/vi/zh index);组件:SiteNav / StatsBar / DevicesSection / How / Path / Trust / NexTeaser / LearnTeaser / Faq / FinalCta / SiteFooter;tokens.css;fx.ts(仅 curtain 选择器 + 叠卡淡出四行);i18n 三 json。
- 机器门:11 门全部适用;`--x-nav-h` 重标触发 render-fit C 重钉;新区块自动进 render-fit/canvas-unit/css-shadowed 扫描面。
- 风险:backdrop-filter 压在动画画布上的滚动开销(实测把关,fps ≥50;`@supports` 无模糊回退)。

## Done-when

1. 三语首页无白幕布:`#how`〜页脚区间内不存在 `#f2f2f2` 实底大面,地球画布在该区间透底可见(实景截图)。
2. Zone 1 结构零变:hero/stats/social/mission/deck 的 DOM 结构与文案 key 不变(diff 仅样式层),叠卡门(第 11 门)与编舞判据原样全绿。
3. `npm run verify` 11/11 全绿(本轮收尾时跑,同时清偿上午合并押后的 full 债)。
4. 三语首页实景走查 console error = 0;新区块在 1440/1920 无墨撞(render-fit 绿)+ 锚点全通(#how/#trust/#devices/#download 等)。
5. 桌面滚动 fps ≥ 50(玻璃层压在动态地球上实测)。

## 实施拆解

- [ ] T1 tokens:玻璃 token + `.x-tile` + `.xbtn` 胶囊 + print 补丁
- [ ] T2 导航悬浮玻璃条 + `--x-nav-h` 重标
- [ ] T3 数据条玻璃横带
- [ ] T4 叠卡玻璃皮(x-paper 摘除 + 章/徽章暗玻璃)
- [ ] T5 band-deep 换装 + fx 选择器 + 叠卡 curtain 淡出
- [ ] T6-T10 五章重构(How / Path / Trust / NEX / Learn+FAQ)
- [ ] T11 末屏 CTA 大字错位
- [ ] T12 页脚玻璃面板
- [ ] T13 i18n `path.headline` ×3 + parity 门
- [ ] T14 三语实景 + fps 实测 + 修伤
- [ ] T15 full verify 11 门 + 审计轮
