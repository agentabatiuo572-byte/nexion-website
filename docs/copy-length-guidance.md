# 后台多语言文案长度提示

后台只给编辑建议：不截断输入，不新增 `maxlength`，不改变保存、发布或现有系统校验。字符数按 `Intl.Segmenter` 的可读字符计算，空格、换行、格式标记和占位符计入；计数时把 CRLF/CR 视为 LF，保存的原文不改写。

## 纠正了什么

默认英文标题 `NexGrid\nLet compute flow` 是 24 个字符，计数正确；旧 16 字建议错误。旧探针把正常滚动判为超出空间，又用不保留默认断行的样本文字求最小值。在 390×521 下，默认两行标题与 17 字样本具有相同几何，只能证明区块正常随内容增高，不能证明每个字形都完整绘制。错误的首屏边界、样本构造及其后的联合缩减不能作为建议依据，旧表与联合缩减结果已撤回。

旧探针也漏查了文字自身的背景绘制边界。后续独立实景确认：德语 320 宽标题被自身渐变背景裁切；英语 390×521 的 compute 中 p 下伸约 4px 也被裁去。公告开启时，葡语 320 与越南语 390 的首屏说明还会被导航遮挡。DOM 字符完整、盒子可滚动或没有祖先 overflow 裁切，都不能排除这些真实例外。

另一次复核发现缩放测量尺本身算错：旧 Canvas 先按未缩放字号取得已取整的字体度量，再乘缩放比例；浏览器实际按缩放后的字号取整，两者并不等价。在 2560 宽下，12px Space Mono 实际按约 16px 绘制，DOM 字形范围高 24px，旧算法却算成约 22.67px，误判为字体测量不一致。修正为使用元素的实际累计缩放值，在实际绘制字号下直接测量，没有放宽容差，也没有修改前台字号。九语、两档宽度的 126 次对照中，旧算法误排除 37 次，修正后的最大差值为 0；[缩放尺原始证据](../.cache/copy-length-correction/zoom-proof/evidence.json)及[德语导航像素对照](../.cache/copy-length-correction/zoom-proof/de-nav-zoom-pixel.png)记录了数值与真实绘制。测量错误必须修尺后重算，不能以大量“仅预览”掩盖；真实背景裁切和遮挡仍需另行记录。

新的测量保留默认断行与段落，区分真实容器边界和原有排版比例，检查文字自身背景与真实菜单状态，并排除停放在屏外的设备卡制造的假冲突。既有字号、间距、公开文案与页面滚动方式保持原样；遇到无法可靠量化的原有例外，标题等字段可能只给预览说明，不承诺整数建议。旧交互报告只能证明提示跟随旧表，不能证明旧建议合理。

本地纠错证据：[旧默认值盘点](../.cache/copy-length-correction/inventory.json)、[首屏几何复现](../.cache/copy-length-correction/hero-diagnosis.md)、[独立标题报告](../.cache/copy-length-correction/hero-blackbox/REPORT.md)、[英文原背景绘制](../.cache/copy-length-correction/gradient-proof/en-gradient-original.png)与[仅增高背景的同坐标对照](../.cache/copy-length-correction/gradient-proof/en-gradient-taller.png)。几何复现的早期结论应结合后两类绘制证据理解。

## 如何理解提示

- **默认断行参考**：具备可靠数值时显示“按默认断行建议约 M 字符”。超过参考可能增加行数或改变原有排版比例，不等于已发生裁切。手动换行数量不同，即使未超建议，也提示检查预览。
- **真实容器建议**：从当前字体、可用宽度、文字自身背景、裁切祖先和相关兄弟元素测量。超过建议显示软警告；区块自然增高和正常滚动本身不判错，绘制裁切或遮挡仍需单独检查。
- **无法可靠换算**：只显示计数和具体预览原因，不虚构数字、不标成输入错误。新产品没有自身测量记录时采用这一状态。
- **自然增长、辅助文字、SEO、链接与邮箱**：不给视觉总字数上限，保留各自说明及原有系统校验。邮箱按地址配置处理，不承诺它能自动换行。

同样字数的宽字母、长单词、手动断行和模板替换结果可能占用不同空间。数字是带条件的编辑参考，不能保证任意输入都适合版面，也不自动分配同区域多个字段的共同配额。

当前 621 条字段／产品／语言测量记录中，437 条提供带条件的数字建议，184 条仅给预览说明；消费者位置覆盖缺口 0。覆盖齐全不代表每项都能可靠换算，也不代表取得了全部字段的精确上限。“仅预览”需要区分：已观察到的前台绘制或遮挡例外，以及测量无法可靠换算的情况；两者都不应包装成数字通过。本轮保留既有前台设计，不把取消数字说成修好了版面。

产品名称和简介按稳定 SKU id 分别取记录。共用名称只有在该产品全部九语均可测时才取九语最小建议；不会把其他产品的最小值套过来。

真实配置的九语公告正文均为空。隔离构建为了观察启用后的公告，使用短品牌名 `NexGrid` 作可见初始样例，再追加各语言语料；不把已经被省略的长整句样例当作正常基准，也不把样例写回真实文案。

公告还要区分普通文字和带跳转链接两种渲染分支。链接分支会多出空格与箭头，同一段文字可能因此被省略：独立 320 宽检查中，28 字样本在普通分支占约 205.64px，带链接占约 225px，而可用空间为 209px。正式校准覆盖两种真实构建分支，替换正文时保留箭头；早期临时重建分支只作为缺口复现，不替代正式构建证据。见[公告分支原始观察](../.cache/copy-length-correction/hero-blackbox/announcement-branch.json)，正式证据保存在 `copy-layout-calibration.json` 的 `linkedAnnouncement` 与覆盖状态中。

两种真实公告构建另做九语共 18 次观察：[公告分支复验](../.cache/copy-length-correction/announcement-variants.json)。带链接分支出现省略号时，部分字素的 DOM 测量范围被分裂，无法可靠还原字宽，证据明确标为 **DEGRADED（测量受限）**；相应建议取消数字，提示预览。这是测量边界，不是已经证明所有公告都适合版面。

页脚邮箱单独显示“邮件地址可能无法换行，请检查手机端预览”，并保留原邮箱校验。实景中的合法 76 字地址（64 个 ASCII a 加 `@example.com`）在 320 宽保持单行，超出画布而被裁切；它不能按普通段落的自然换行推导总字数建议。见[邮箱原始观察](../.cache/copy-length-correction/hero-blackbox/flowing-spotcheck.json)与[手机截图](../.cache/copy-length-correction/hero-blackbox/flowing-email-en-320.png)。

## 数据与复验

- [字段分类与前台位置](../scripts/copy-layout-catalog.mjs)：全部字段及消费者。
- [后台建议表](../admin/src/lib/text-layout-limits.json)：version 2，`limits`、`references`、`previewReasons`、`basis`；产品记录在 `instances[skuId]`。
- [渲染证据](copy-layout-calibration.json)：普通字段记录键为 `字段||语言`，产品为 `字段|SKU id|语言`。
- [浏览器验收脚本](../scripts/test-copy-hints-runtime.mjs)：先核对全部默认输入，再测边界、粘贴、AI 回填、切换、保存刷新和发布请求。
- [Worker 独立 D1 检查](../worker/test/copy-advisory.spec.ts)：持久化、发布快照和原有硬校验；与后台内存 API 夹具分层说明。

重新校准使用 `node scripts/calibrate-copy-layout.mjs --write`，随后运行 `npm --prefix admin run build` 和 `node scripts/test-copy-hints-runtime.mjs`。新版不使用旧 `jointLimits` 缩减值。旧版或不支持的数据版本只显示核验提醒，拒绝继续提供旧数字。

校准数据和构建必须具有匹配的源码、字体及产物指纹。后台测试使用真实构建与隔离内存 API；它不代表真实 AI 服务调用、托管发布完成或公网已更新。

## 当前验收证据

新表完成 2480 次默认输入检查，九语及全部集合都在人工样本之前验证，无默认误报；1164 个边界样本、9 次保存刷新、9 个换行参考检查通过。真实剪贴板状态：pass。浏览器错误 0，失败 0。

后台源码目录 SHA-256：`655b2274fcf267bdecd80a347095dd31228699b2dc63f0f228416e1c14677279`。构建目录 SHA-256：`39fed46ebf3d41a9f96d96cac43095fefc9dedb82dcb6c83f7a66926f218d153`。

完整本地证据位于 `.cache/copy-length-correction/admin-runtime/`，含 `report.json`、默认英文标题的桌面/手机截图及完整交互记录。

另有[独立前台边界复验](../.cache/copy-length-correction/independent-final-budget/review.md)及[原始证据](../.cache/copy-length-correction/independent-final-budget/evidence.json)：直接检查真实 DOM 与截图，覆盖英语／越南语 `nav.how`、日语 `nav.download`、中文 `nex.getApp` 共 4 组、12 个默认及边界样本。它没有复用校准探针作判断，也不代表对全部 437 条数字逐条做了独立浏览器复验。

## 多字段同时修改的诊断

联合检查只记录默认文案、同时扩写到各自建议、同字数宽字母和改动断行的实际表现。它不按比例缩减建议，不生成共同字数配额，也不改写单字段数字。单字段建议不能保证多个字段同时扩写后仍保持原有版式。

采用 [version 2 联合诊断](copy-layout-joint.json)，状态为 `failed`；布局与构建指纹和当前校准一致，完整报告 SHA 及默认／扩写原文均已核对。下表区分可观察的排版关注与技术测量缺口；同一场景可能同时出现两者。关注记录需结合实际几何判断，不能直接等同于应修改既有设计。

| 样本 | 场景数 | 有排版关注的场景 | 有技术缺口的场景 |
|---|---|---|---|
| 默认文案 | 2790 | 897 | 44 |
| 同时扩写到各自建议 | 2790 | 1215 | 44 |
| 同字数宽字母 | 2790 | 1640 | 2 |
| 改变断行 | 2790 | 1202 | 44 |

这轮联合诊断为 **DEGRADED（测量受限）**，脚本保留失败状态与退出码 1：134 个场景存在 348 条技术观察，涉及 19 组字段／语言（ja）。其中 0 组仍显示数字建议。这些字段当前均只给预览说明；字体混排或实际字宽无法可靠还原，不作为新增精确数字的依据。

本轮 134 个技术缺口场景只有字体混排或实际字宽无法可靠还原，未出现原文不匹配或消费者缺失。这类记录不证明排版出了问题。

默认文案的真实裁切／遮挡、扩写时新增的问题、人工宽字和断行压力样本各有不同含义，不能合并成“建议全部通过”或用来反推统一缩减系数。

## 全部字段的九语建议

下表包含 235 类字段：排版建议 57、自然增长 164、辅助文字 7、搜索展示 5、链接/联系信息 2。数字为后台实际显示值；“约”表示断行/排版比例参考；“计数”表示不设视觉总字数建议。产品字段的数值见后面的 SKU 表。

| 字段 | 类型 | EN | VI | ES | PT | FR | DE | JA | KO | ZH | 前台消费位置 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| site.name | 搜索展示 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 首页默认 SEO 标题的站点名片段，不在正文渲染；页面 SEO 配置可覆盖。 |
| site.tagline | 搜索展示 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 首页默认 SEO 标题的标语片段，不在正文渲染；页面 SEO 配置可覆盖。 |
| site.description | 搜索展示 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 首页默认描述及社交分享描述，不占正文版面；页面 SEO 配置可覆盖。 |
| nav.how | 排版建议 | 24 | 19 | 14 | 15 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P2〕 | 24 | 22 | all: .site-nav .links a[href$="#how"] |
| nav.devices | 排版建议 | 19 | 13 | 13 | 14 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P2〕 | 21 | 20 | all: .site-nav .links a[href$="#devices"] |
| nav.trust | 排版建议 | 17 | 12 | 10 | 11 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P2〕 | 21 | 20 | all: .site-nav .links a[href$="#trust"]；home: #trust .head .lab |
| nav.learn | 排版建议 | 17 | 8 | 6 | 7 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P2〕 | 22 | 22 | all: .site-nav .links a[href$="/learn/"]；home: #learn-entry .head .lab |
| nav.nex | 排版建议 | 15 | 8 | 4 | 5 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P2〕 | 22 | 21 | all: .site-nav .links a[href$="/nex/"] |
| nav.launchH5 | 排版建议 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P2〕 | 预览〔P1〕 | 预览〔P1〕 | all: .site-nav .h5；home: .hero .dl > :nth-child(3)；home: .final .dl > :nth-child(3) |
| nav.download | 排版建议 | 20 | 14 | 10 | 8 | 预览〔P1〕 | 预览〔P1〕 | 18 | 20 | 19 | all: .site-nav .dl-btn |
| nav.ariaMain | 辅助文字 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 主导航辅助技术名称，仅 aria-label，不渲染为文字。 |
| nav.ariaMenu | 辅助文字 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 移动菜单按钮辅助技术名称，仅 aria-label。 |
| nav.skip | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | all: .x-skip |
| nav.ariaLanguage | 辅助文字 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 语言选择器与语言组的辅助技术名称，仅 aria-label。 |
| hero.title | 排版建议 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P2〕 | 预览〔P1〕 | 预览〔P1〕 | home: .hero .cluster h1 |
| hero.subtitle | 排版建议 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P2〕 | 预览〔P1〕 | 预览〔P1〕 | home: .hero .left .note |
| hero.scrollHint | 排版建议 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P2〕 | 预览〔P1〕 | 预览〔P1〕 | home: .hero .scroll-hint .txt |
| hero.note | 排版建议 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P2〕 | 预览〔P1〕 | 预览〔P1〕 | home: .hero .subs .sub |
| hero.subtitle2 | 排版建议 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P2〕 | 预览〔P1〕 | 预览〔P1〕 | home: .hero .left .note2 |
| hero.note2 | 排版建议 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P2〕 | 预览〔P1〕 | 预览〔P1〕 | home: .hero .subs .sub2 |
| download.ios | 排版建议 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P2〕 | 预览〔P1〕 | 预览〔P1〕 | home: .hero .dl > :nth-child(1)；home: .final .dl > :nth-child(1) |
| download.android | 排版建议 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P2〕 | 预览〔P1〕 | 预览〔P1〕 | home: .hero .dl > :nth-child(2)；home: .final .dl > :nth-child(2) |
| stats.activeDevices | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #stats .cell:nth-child(1) .label |
| stats.activeJobs | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #stats .cell:nth-child(2) .label |
| stats.nodes | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #stats .cell:nth-child(3) .label |
| stats.countries | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #stats .cell:nth-child(4) .label |
| stats.uptime | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #stats .cell:nth-child(5) .label |
| stats.asOf | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #stats .asof |
| path.title | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #path .head .lab |
| path.headline | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #path .lead h2 |
| path.cat1 | 排版建议 | 24 | 24 | 24 | 24 | 24 | 24 | 14 | 15 | 14 | home: #path .card:nth-child(1) .metarow span:last-child |
| path.cat2 | 排版建议 | 26 | 26 | 26 | 26 | 26 | 26 | 16 | 17 | 16 | home: #path .card:nth-child(2) .metarow span:last-child |
| path.freeTitle | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #path .card:nth-child(1) h3 |
| path.freeDesc | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #path .card:nth-child(1) .desc |
| path.freeCta | 排版建议 | 21 | 21 | 21 | 21 | 预览〔P1〕 | 21 | 13 | 13 | 13 | home: #path .card:nth-child(1) .xbtn |
| path.scaleTitle | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #path .card:nth-child(2) h3 |
| path.scaleDesc | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #path .card:nth-child(2) .desc |
| path.scaleLink | 排版建议 | 24 | 24 | 24 | 24 | 24 | 24 | 14 | 15 | 15 | home: #path .card:nth-child(2) .xbtn |
| path.note | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #path > .note |
| how.title | 排版建议 | 29 | 29 | 29 | 29 | 29 | 29 | 17 | 19 | 17 | home: #how .head .lab |
| how.head1 | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #how .statements h2 |
| how.head2 | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #how .statements p |
| how.cat1 | 排版建议 | 32 | 32 | 32 | 32 | 32 | 32 | 19 | 21 | 15 | home: #how .step:nth-child(1) .metarow span:last-child |
| how.cat2 | 排版建议 | 32 | 32 | 32 | 32 | 32 | 32 | 19 | 20 | 15 | home: #how .step:nth-child(2) .metarow span:last-child |
| how.cat3 | 排版建议 | 32 | 32 | 32 | 32 | 32 | 32 | 19 | 21 | 15 | home: #how .step:nth-child(3) .metarow span:last-child |
| how.step1Title | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #how .step:nth-child(1) h3 |
| how.step1Desc | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #how .step:nth-child(1) .body |
| how.step2Title | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #how .step:nth-child(2) h3 |
| how.step2Desc | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #how .step:nth-child(2) .body |
| how.step3Title | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #how .step:nth-child(3) h3 |
| how.step3Desc | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #how .step:nth-child(3) .body |
| how.verifyLink | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #how .vlink |
| devices.title | 排版建议 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P1〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | home: #devices .gutter .lab |
| devices.subtitle | 排版建议 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P1〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | home: #devices .gutter .sub |
| devices.free | 排版建议 | 约 10 | 约 11 | 约 11 | 约 11 | 约 11 | 约 11 | 约 6 | 约 7 | 约 6 | home: #devices .price |
| devices.multiplierLabel | 排版建议 | 约 17 | 约 27 | 约 27 | 约 33 | 约 32 | 约 36 | 约 14 | 约 14 | 约 9 | home: #devices .mult |
| devices.classicBadge | 排版建议 | 19 | 19 | 19 | 19 | 20 | 19 | 11 | 13 | 11 | home: #devices .card:not(.coming) .chip |
| devices.comingBadge | 排版建议 | 20 | 19 | 19 | 19 | 19 | 19 | 11 | 12 | 11 | home: #devices .card.coming .chip |
| devices.cta | 排版建议 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P1〕 | 预览〔P1〕 | 10 | 11 | 12 | home: #devices .gutter .cta |
| trust.whitepaper.title | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #whitepaper-title |
| trust.whitepaper.summary | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #whitepaper .whitepaper-summary |
| trust.whitepaper.details | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #whitepaper .whitepaper-details |
| trust.title | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #trust .head h2 |
| trust.pocTitle | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #poc summary .q |
| trust.pocBody1 | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #poc > p:nth-of-type(1) |
| trust.pocBody2 | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #poc > p:nth-of-type(2) |
| trust.certMsbAlt | 辅助文字 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | MSB 证书图片替代文本及灯箱图片替代文本，不占普通版面。 |
| trust.certCoAlt | 辅助文字 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 公司证书图片替代文本及灯箱图片替代文本，不占普通版面。 |
| trust.t1Title | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #trust .verification:nth-child(1) .ctitle |
| trust.t1Body | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #trust .verification:nth-child(1) .cdesc |
| trust.t1Chip | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #trust .verification:nth-child(1) .vchip |
| trust.t1Cta | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #trust .verification:nth-child(1) .vcta |
| trust.t2Title | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #trust .verification:nth-child(2) .ctitle |
| trust.t2Body | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #trust .verification:nth-child(2) .cdesc |
| trust.t2Chip | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #trust .verification:nth-child(2) .vchip |
| trust.t2Cta | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #trust .verification:nth-child(2) .vcta |
| trust.t3Title | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #trust .meaning .ctitle |
| trust.t3Lead | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #trust .meaning .cdesc |
| trust.t3MeansTitle | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #trust .t3h |
| trust.t3Means1 | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #trust .t3list li:nth-child(1) |
| trust.t3Means2 | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #trust .t3list li:nth-child(2) |
| trust.t3Means3 | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #trust .t3list li:nth-child(3) |
| trust.certZoom | 排版建议 | 193 | 157 | 170 | 174 | 186 | 160 | 99 | 98 | 98 | home: #trust .cert-hint |
| trust.certClose | 排版建议 | 25 | 25 | 25 | 25 | 25 | 24 | 15 | 17 | 15 | home: #trust .cert-zoom-close .xbtn |
| trust.openOriginal | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #trust .cert-orig |
| why.kicker | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #why .ktxt |
| why.title | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #why .state |
| why.act1Title | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #why .act:nth-child(1) .atitle |
| why.act1Body | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #why .act:nth-child(1) .abody |
| why.act1Num | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #why .act:nth-child(1) .anum-big |
| why.act1Cap | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #why .act:nth-child(1) .acap |
| why.act2Title | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #why .act:nth-child(2) .atitle |
| why.act2Body | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #why .act:nth-child(2) .abody |
| why.act2Num | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #why .act:nth-child(2) .anum-big |
| why.act2Cap | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #why .act:nth-child(2) .acap |
| why.act3Title | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #why .act:nth-child(3) .atitle |
| why.act3Body | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #why .act:nth-child(3) .abody |
| why.act3Num | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #why .act:nth-child(3) .anum-big |
| why.act3Cap | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #why .act:nth-child(3) .acap |
| why.quote1 | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #why .qcard:nth-child(1) .quote |
| why.name1 | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #why .qcard:nth-child(1) .pname |
| why.role1 | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #why .qcard:nth-child(1) .prole |
| why.meta1 | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #why .qcard:nth-child(1) .qsrc |
| why.date1 | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #why .qcard:nth-child(1) .qdate |
| why.quote2 | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #why .qcard:nth-child(2) .quote |
| why.name2 | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #why .qcard:nth-child(2) .pname |
| why.role2 | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #why .qcard:nth-child(2) .prole |
| why.meta2 | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #why .qcard:nth-child(2) .qsrc |
| why.date2 | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #why .qcard:nth-child(2) .qdate |
| why.portraitAlt | 辅助文字 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 人物图片替代文本，{name} 由对应姓名替换；不占普通版面。 |
| why.sourcesTitle | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #why .sources summary .q |
| why.src1 | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #why-src-1 .srctxt |
| why.src2 | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #why-src-2 .srctxt |
| why.src3 | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #why-src-3 .srctxt |
| why.src4 | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #why-src-4 .srctxt |
| why.src5 | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #why-src-5 .srctxt |
| why.src6 | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #why-src-6 .srctxt |
| why.photoCredit | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #why .disclaim .dtext:nth-child(2) |
| why.disclaim | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #why .disclaim .dtext:nth-child(1) |
| social.kicker | 排版建议 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 362 | 373 | home: #social .kicker .x-mono-lg |
| social.scaleLine | 排版建议 | 308 | 230 | 247 | 217 | 预览〔P2〕 | 265 | 预览〔P2〕 | 148 | 147 | home: #social .disp h2 |
| social.rolesLine | 排版建议 | 预览〔P2〕 | 预览〔P2〕 | 610 | 594 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 439 | 415 | home: #social .roles |
| mission.kicker | 排版建议 | 170 | 预览〔P1〕 | 172 | 164 | 170 | 预览〔P1〕 | 预览〔P2〕 | 56 | 54 | home: #mission .ktxt |
| mission.title | 排版建议 | 117 | 预览〔P1〕 | 93 | 88 | 87 | 预览〔P1〕 | 预览〔P2〕 | 37 | 31 | home: #mission .state |
| mission.lead | 排版建议 | 183 | 预览〔P1〕 | 201 | 201 | 214 | 预览〔P1〕 | 预览〔P2〕 | 123 | 89 | home: #mission .body |
| mission.f1 | 排版建议 | 60 | 预览〔P1〕 | 58 | 60 | 55 | 预览〔P1〕 | 预览〔P2〕 | 12 | 11 | home: #mission .cell:nth-child(1) .name |
| mission.f2 | 排版建议 | 68 | 预览〔P1〕 | 68 | 69 | 60 | 预览〔P1〕 | 预览〔P2〕 | 11 | 10 | home: #mission .cell:nth-child(2) .name |
| mission.f3 | 排版建议 | 64 | 预览〔P1〕 | 68 | 67 | 64 | 预览〔P1〕 | 预览〔P2〕 | 11 | 12 | home: #mission .cell:nth-child(3) .name |
| mission.f4 | 排版建议 | 67 | 预览〔P1〕 | 69 | 66 | 62 | 预览〔P1〕 | 预览〔P2〕 | 11 | 12 | home: #mission .cell:nth-child(4) .name |
| mission.f5 | 排版建议 | 67 | 预览〔P1〕 | 65 | 67 | 60 | 预览〔P1〕 | 预览〔P2〕 | 12 | 10 | home: #mission .cell:nth-child(5) .name |
| mission.f6 | 排版建议 | 63 | 预览〔P1〕 | 69 | 72 | 60 | 预览〔P1〕 | 预览〔P2〕 | 12 | 10 | home: #mission .cell:nth-child(6) .name |
| nex.teaserTitle | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #nex .lead h2 |
| nex.teaser.whatTitle | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #nex .what h3 |
| nex.teaser.whatDesc | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #nex .what .desc |
| nex.teaser.earnTitle | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #nex .side .card:nth-child(1) h3 |
| nex.teaser.earnDesc | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #nex .side .card:nth-child(1) .desc |
| nex.teaser.useTitle | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #nex .side .card:nth-child(2) h3 |
| nex.teaser.useDesc | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #nex .side .card:nth-child(2) .desc |
| nex.teaserCta | 排版建议 | 27 | 27 | 27 | 27 | 27 | 27 | 18 | 19 | 19 | home: #nex .more .xbtn |
| nex.pageTag | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #nex .head .lab；nex: .nex-page .hero .tag |
| nex.pageTitle | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: .nex-page .hero h1 |
| nex.pageLead | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: .nex-page .hero .lead |
| nex.compareTitle | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: #nex-compare |
| nex.cmpProp | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: .nex-page table thead th:first-child |
| nex.cmpType | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: .nex-page table tbody tr:nth-child(1) td:nth-child(1) |
| nex.cmpTypeUsdt | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: .nex-page table tbody tr:nth-child(1) td:nth-child(2) |
| nex.cmpTypeNex | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: .nex-page table tbody tr:nth-child(1) td:nth-child(3) |
| nex.cmpVol | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: .nex-page table tbody tr:nth-child(2) td:nth-child(1) |
| nex.cmpVolUsdt | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: .nex-page table tbody tr:nth-child(2) td:nth-child(2) |
| nex.cmpVolNex | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: .nex-page table tbody tr:nth-child(2) td:nth-child(3) |
| nex.cmpUse | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: .nex-page table tbody tr:nth-child(3) td:nth-child(1) |
| nex.cmpUseUsdt | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: .nex-page table tbody tr:nth-child(3) td:nth-child(2) |
| nex.cmpUseNex | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: .nex-page table tbody tr:nth-child(3) td:nth-child(3) |
| nex.sourcesTitle | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: #nex-sources |
| nex.src1Title | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: [aria-labelledby="nex-sources"] li:nth-child(1) b |
| nex.src1Desc | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: [aria-labelledby="nex-sources"] li:nth-child(1) .x-copy |
| nex.src2Title | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: [aria-labelledby="nex-sources"] li:nth-child(2) b |
| nex.src2Desc | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: [aria-labelledby="nex-sources"] li:nth-child(2) .x-copy |
| nex.src3Title | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: [aria-labelledby="nex-sources"] li:nth-child(3) b |
| nex.src3Desc | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: [aria-labelledby="nex-sources"] li:nth-child(3) .x-copy |
| nex.src4Title | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: [aria-labelledby="nex-sources"] li:nth-child(4) b |
| nex.src4Desc | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: [aria-labelledby="nex-sources"] li:nth-child(4) .x-copy |
| nex.usesTitle | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: #nex-uses |
| nex.use1Title | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: [aria-labelledby="nex-uses"] li:nth-child(1) b |
| nex.use1Desc | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: [aria-labelledby="nex-uses"] li:nth-child(1) .x-copy |
| nex.use2Title | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: [aria-labelledby="nex-uses"] li:nth-child(2) b |
| nex.use2Desc | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: [aria-labelledby="nex-uses"] li:nth-child(2) .x-copy |
| nex.use3Title | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: [aria-labelledby="nex-uses"] li:nth-child(3) b |
| nex.use3Desc | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: [aria-labelledby="nex-uses"] li:nth-child(3) .x-copy |
| nex.use4Title | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: [aria-labelledby="nex-uses"] li:nth-child(4) b |
| nex.use4Desc | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: [aria-labelledby="nex-uses"] li:nth-child(4) .x-copy |
| nex.use5Title | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: [aria-labelledby="nex-uses"] li:nth-child(5) b |
| nex.use5Desc | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: [aria-labelledby="nex-uses"] li:nth-child(5) .x-copy |
| nex.mechTitle | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: #nex-mech |
| nex.mech1Title | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: .nex-page .mcard:nth-child(1) h3 |
| nex.mech1Desc | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: .nex-page .mcard:nth-child(1) p |
| nex.mech2Title | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: .nex-page .mcard:nth-child(2) h3 |
| nex.mech2Desc | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: .nex-page .mcard:nth-child(2) p |
| nex.faqTitle | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: #nex-faq |
| nex.faq1Q | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: .nex-page .faq:nth-of-type(1) .q |
| nex.faq1A | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: .nex-page .faq:nth-of-type(1) > p |
| nex.faq2Q | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: .nex-page .faq:nth-of-type(2) .q |
| nex.faq2A | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: .nex-page .faq:nth-of-type(2) > p |
| nex.faq3Q | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: .nex-page .faq:nth-of-type(3) .q |
| nex.faq3A | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: .nex-page .faq:nth-of-type(3) > p |
| nex.faq4Q | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: .nex-page .faq:nth-of-type(4) .q |
| nex.faq4A | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | nex: .nex-page .faq:nth-of-type(4) > p |
| nex.getApp | 排版建议 | 27 | 27 | 27 | 27 | 27 | 27 | 17 | 18 | 19 | nex: .nex-page .cta-row .xbtn.solid；learn: .learn .cta .xbtn；article: .article .cta .xbtn |
| nex.whitepaper | 排版建议 | 33 | 33 | 33 | 33 | 34 | 33 | 预览〔P2〕 | 22 | 20 | home: #whitepaper .whitepaper-read；nex: .nex-page [data-whitepaper-read] |
| learn.title | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | learn: .learn .head h1 |
| learn.subtitle | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | learn: .learn .head > p |
| learn.homeTitle | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #learn-entry .head h2 |
| learn.browseAll | 排版建议 | 27 | 27 | 27 | 27 | 27 | 27 | 预览〔P2〕 | 19 | 17 | home: #learn-entry .more .xbtn |
| learn.backToList | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | article: .article > .back |
| learn.untranslated | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | article: .article > .notice |
| learn.enOnly | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | learn: .learn .card .fb |
| learn.appVersionLabel | 排版建议 | 32 | 33 | 32 | 32 | 32 | 32 | 19 | 21 | 20 | article: .article .meta .nw:first-of-type |
| learn.topics.start | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #learn-entry .topic；learn: .learn .topic；article: .article .meta；article: .article .related .topic |
| learn.topics.earn | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #learn-entry .topic；learn: .learn .topic；article: .article .meta；article: .article .related .topic |
| learn.topics.devices | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #learn-entry .topic；learn: .learn .topic；article: .article .meta；article: .article .related .topic |
| learn.topics.wallet | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #learn-entry .topic；learn: .learn .topic；article: .article .meta；article: .article .related .topic |
| learn.topics.team | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #learn-entry .topic；learn: .learn .topic；article: .article .meta；article: .article .related .topic |
| learn.topics.nex | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #learn-entry .topic；learn: .learn .topic；article: .article .meta；article: .article .related .topic |
| learn.related | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | article: .article .related > .x-label |
| learn.toc | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | article: .article .toc > .x-label；legal: .legal .legal-toc > summary |
| faq.title | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #faq .head .lab |
| final.title | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: .final > h2 |
| footer.privacy | 排版建议 | 29 | 29 | 29 | 29 | 29 | 30 | 17 | 19 | 17 | all: .site-footer nav a[href$="/legal/privacy/"] |
| footer.terms | 排版建议 | 29 | 29 | 29 | 29 | 29 | 29 | 17 | 19 | 17 | all: .site-footer nav a[href$="/legal/terms/"] |
| footer.contact | 排版建议 | 29 | 29 | 29 | 29 | 29 | 29 | 17 | 19 | 17 | all: .site-footer nav a[href^="mailto:"] |
| footer.rights | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | all: .site-footer .copy |
| footer.ariaLegal | 辅助文字 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 页脚链接组辅助技术名称，仅 aria-label。 |
| footer.pauseBg | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | all: .site-footer [data-bg-toggle] |
| footer.playBg | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | all: .site-footer [data-bg-toggle] |
| footer.reducedBg | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | all: .site-footer [data-bg-toggle] |
| footer.appPrivacy | 排版建议 | 29 | 29 | 29 | 29 | 预览〔P1〕 | 29 | 预览〔P2〕 | 19 | 19 | all: .site-footer nav a[href$="/legal/app-privacy/"] |
| footer.legalLine | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | all: .site-footer .legalline |
| footer.forTeams | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | all: .site-footer .teams |
| footer.forTeamsCta | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | all: .site-footer .teams |
| legal.enPrevails | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | legal: .legal .prevails |
| notfound.title | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 404: .nf .blk .title |
| notfound.body | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 404: .nf .blk .body |
| notfound.home | 排版建议 | 27 | 27 | 27 | 27 | 27 | 27 | 17 | 18 | 17 | 404: .nf .blk .xbtn |
| sku.name | 排版建议 | 按产品 | 按产品 | 按产品 | 按产品 | 按产品 | 按产品 | 按产品 | 按产品 | 按产品 | home: #devices .card .body > h3 |
| sku.tagline | 排版建议 | 按产品 | 按产品 | 按产品 | 按产品 | 按产品 | 按产品 | 按产品 | 按产品 | 按产品 | home: #devices .card .cols > .col:nth-child(2) |
| faq.q | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #faq .item .q |
| faq.a | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | home: #faq .item > p |
| announcement.text | 排版建议 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | all: #x-announcement .message |
| seo.title | 搜索展示 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 页面标题、社交分享标题及浏览器标签页标题；搜索展示建议单独给出，不作为正文布局字数。 |
| seo.description | 搜索展示 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 页面及社交分享描述；搜索展示建议单独给出，不作为正文布局字数。 |
| legal.md | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | legal: .legal > h1；legal: .legal .legal-toc；legal: .legal .legal-markdown |
| footer.contactEmail | 链接/联系信息 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | all: .site-footer .teams a[href^="mailto:"] |
| geo.title | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | all: body > main > h1 |
| geo.body | 自然增长 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | all: body > main > p |
| link | 链接/联系信息 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 计数 | 下载、H5、公告跳转和社交链接是地址配置，不按可见文案长度计量；沿用原 URL 校验。 |

## 各产品的九语建议

名称是全语言共用值，表内各列显示该产品的实际共用建议。简介独立按语言取值。没有表中稳定 id 的新产品只提示预览，不套用相似名称或其他产品记录。

| SKU id | 字段 | EN | VI | ES | PT | FR | DE | JA | KO | ZH | 证据键格式 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| phone | sku.name | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | sku.name\|phone\|语言 |
| cloud-share | sku.name | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | sku.name\|cloud-share\|语言 |
| s1 | sku.name | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | sku.name\|s1\|语言 |
| pro | sku.name | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | sku.name\|pro\|语言 |
| pro-v2 | sku.name | 约 18 | 约 18 | 约 18 | 约 18 | 约 18 | 约 18 | 约 18 | 约 18 | 约 18 | sku.name\|pro-v2\|语言 |
| rack-p1 | sku.name | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | sku.name\|rack-p1\|语言 |
| rack-p2 | sku.name | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | 预览〔P2〕 | sku.name\|rack-p2\|语言 |
| phone | sku.tagline | 约 49 | 约 47 | 约 52 | 约 52 | 约 62 | 约 59 | 约 20 | 约 25 | 约 16 | sku.tagline\|phone\|语言 |
| cloud-share | sku.tagline | 约 48 | 约 58 | 约 55 | 约 64 | 约 53 | 约 60 | 预览〔P2〕 | 约 29 | 约 15 | sku.tagline\|cloud-share\|语言 |
| s1 | sku.tagline | 约 28 | 约 28 | 约 34 | 约 33 | 约 28 | 约 36 | 约 11 | 约 12 | 约 11 | sku.tagline\|s1\|语言 |
| pro | sku.tagline | 约 29 | 约 37 | 约 32 | 约 48 | 约 30 | 约 28 | 约 18 | 约 19 | 约 11 | sku.tagline\|pro\|语言 |
| pro-v2 | sku.tagline | 约 34 | 约 25 | 约 37 | 约 29 | 约 40 | 约 42 | 约 13 | 约 12 | 约 8 | sku.tagline\|pro-v2\|语言 |
| rack-p1 | sku.tagline | 约 34 | 约 38 | 约 42 | 约 42 | 约 47 | 约 45 | 约 14 | 约 18 | 约 13 | sku.tagline\|rack-p1\|语言 |
| rack-p2 | sku.tagline | 约 33 | 约 37 | 约 37 | 约 34 | 约 39 | 约 45 | 约 16 | 约 15 | 约 11 | sku.tagline\|rack-p2\|语言 |

## 仅预览的原因

- **P1**：该字段受同区域内容及显示状态影响，无法给出可靠的固定字数上限，请查看前台预览。
- **P2**：扩写测试未得到可靠的固定字数边界，请结合前台预览检查换行及内容显示。
