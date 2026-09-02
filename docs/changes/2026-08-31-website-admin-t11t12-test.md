# T11/T12 独立黑盒验收报告 — 文案树 / 下载入口 / 平台数字(2026-08-31)

- **验收人**:独立 tester(未参与实现);真浏览器 Playwright(Chromium,借 Nexion-uniapp 依赖)黑盒实测。
- **规格依据**:官网后台 PRD [FEAT-CON04]②⑤⑥ · [FEAT-CON05] · [FEAT-CON06];plan T11/T12 节。
- **环境**:站仓 `npm run build` → `npm run build:console`(exit 0)→ worker `wrangler d1 migrations apply --local --persist-to .wrangler-t11`(2 迁移 ✓)→ `wrangler dev --port 8796 --persist-to .wrangler-t11`;URL 全走 `http://127.0.0.1:8796`;SETUP_TOKEN=dev-setup-token。专属资源,未触碰 8787/8788 与默认 .wrangler。
- **口径**:全部判定来自运行时真操作(真输入/真点击/页面内带 cookie fetch/截图回看),不以代码读到什么为准;代码引用仅作旁证并标注。

## 总裁决:AC 8 组(A–H)全 pass;细项 41/42 pass(唯一 fail=本脚本时序伪影,单点复测闭环)

| AC | 判定 | 关键证据 |
|---|---|---|
| A 编辑闭环 | ✅ pass | 改 hero.subtitle vi → 保存 → toast「已保存 1 处到草稿 · 未发布」+ 状态条「草稿 · 1 处未发布改动」+ 发布导航徽标 **1**;**页面刷新后改动仍在**(真落库)+ 行标「已改未发布」;「撤销为线上值」→ 文本回线上值(暂存)→ 保存 → 状态条回「与线上一致」、徽标消失 |
| B 禁用词即时红 | ✅ pass | en 框输入 `guaranteed returns` → **失焦前**即红框(style border=var(--bad))+「合规拦截 [guarantee+收益词]:「guaranteed returns」——可存草稿,发布将被拒」,失焦后仍在;**保存草稿允许**(toast 成功=200 落库);带 cookie POST `/api/config/validate` → errors 含 `{path:"copy.en.hero.scrollHint", rule:"forbidden-word", message:"合规拦截 [guarantee+收益词]:「guaranteed returns」"}` —— **UI 标签与服务端命中标签逐字一致**(旁证:两面 import 同一份 `scripts/forbidden-patterns.mjs`,零副本);撤销+保存后回「与线上一致」 |
| C 占位符守恒 | ✅ pass | social.scaleLine vi 删 `{devices}` → 黄警「占位符缺失:{devices}(保存后发布校验将拒)」+ 警示框(var(--warn));validate errors 含 `{rule:"placeholder", message:"占位符 {devices} 缺失"}`(发布线硬拦实证);已恢复。**保存行为实录:草稿保存被允许(200)**——与 PRD E2 字面「保存被拒」不同,见 P-2 |
| D 高敏与集合 | ✅ pass | 左栏「信任板块」「法务提示」带「高敏」pill;信任板块 14 行全带「高敏 · 发布须理由」;footer.legalLine 行带高敏标;FAQ 标题组说明+链接 → /content/faq,**组内 key 仅 `["faq.title"]`(无 faq.q1 之类问答键)**;设备板块组说明+链接 → /content/skus,组内 7 个板块文案 key、无 tagline 键 —— 每 key 唯一编辑面成立 |
| E 冲突条(CON04-E3) | ✅ pass | 两个 browser context 各自登录;A 改 hero.note2 保存成功后,B 用旧状态改 hero.subtitle 保存 → **冲突条出现**「草稿已在别处更新(另一个标签页?)…本次保存被拒——刷新后重试(本页未保存改动将丢弃)」;服务端草稿核验:**B 的值未入库、A 的改动完好**(subtitle 无 B 标记 / note2 含 A 标记);点「刷新后重试」→ B 视图刷到 A 的最新草稿 → 再改再存成功(chip「草稿 · 2 处」)——**出口可用**;但横幅本身滞留,见 P-1 |
| F 下载入口 | ✅ pass | 开启 iOS + URL 空 → 红条「ios:开启的入口必须有 URL(或关闭改 coming-soon)」+ **保存按钮禁用**;填 `http://x` → 「ios:须为 https 完整链接」仍拦;填 `https://example.com` 保存成功 → 状态条「草稿 · **3** 处未发布改动」(ios.url+ios.enabled+android.url 三叶子;派单预期"+1"按叶子口径实记,见 O-2);「立即探活」→ iOS「已上线 · **可达 200**」/ Android(`https://nonexistent-t11-probe.invalid`)「**不可达(超时)**」/ Web App(空)「不可达(空)」;撤回全部改动保存 → 「与线上一致」 |
| G 平台数字 | ✅ pass | 五数字卡**全部**显示锚值黄警「与旧演示值相同——生产上线门(R49-F1)将拦截」(5/5,口径与 R49-F1 一致);activeJobs=5104 → 该卡黄警消失换「✓ 非演示锚值」;uptime=101 → 红条「uptime:不得超过 100」+ 保存禁用;口径月 `2026-13`:客户端无红条、保存可点,服务端 validate 同放行(**双端同一形状 regex `YYYY-MM`,13 月放行——如实记录**,见 O-1);仅存 activeJobs → 状态条「草稿 · 1 处未发布改动」;改回 4812 保存 → 「与线上一致」 |
| H 三语格式预览 | ✅ pass | 站上预览行:`en 28,432 · vi 28.432 · zh 28,432 · uptime 99.7%` —— **vi 千分位为点分隔 `28.432`(越南写法)**,截图回看确认 |

## 问题清单(全部上报,不自我审查;分级为建议,裁决权在 main/主人)

### P-1 · 冲突条点「刷新后重试」后横幅不消失(UI 可用性,建议 P2)
- **实测**:B 点「刷新后重试」→ 数据确已刷新(A 的改动进入 B 视图,3s 轮询内横幅始终在),但红色横幅连同「本次保存被拒」字样**滞留到下一次保存动作才消失**。刚刷新完的用户看到的仍是"保存被拒",易误判刷新失败。
- **根因面**(代码旁证):按钮 onClick 只清 edits+reload,`conflict` 状态仅在下次 save() 开头复位。修法由实现方定。

### P-2 · 占位符缺失时草稿保存被允许 —— 与 PRD CON04-E2 字面不符(规格偏差,留裁决)
- **实测**:vi 删 `{devices}` 后保存 → 200 落库成功;UI 黄警自述「保存后发布校验将拒」;`/api/config/validate` errors 确含 placeholder 项(发布线硬拦存在,**无占位符残缺可上站的路径**)。
- **规格对照**:PRD E2 原文「保存被拒 + inline『占位符 {devices} 缺失』(占位符守恒是硬校验)」;plan T11 AC 行同写「占位符缺失 → 保存拒绝」;本次派单 AC-C 只要求黄警(与实现一致)。三方口径不一致:实现把"硬"落在发布前置而非草稿保存。属方案级选择还是欠账,留裁决;防线闭环本身实证成立。

### P-3 · 行级撤销无确认弹窗 —— PRD CON04-④⑥ 字面「确认弹窗」未见(规格偏差,留裁决)
- **实测**:点「撤销为线上值」直接把线上值填回编辑区(**未落库的暂存态**),需再点「保存草稿」才生效;全程 dialog 事件 0 次。两步式实质提供了反悔机会(不保存即可放弃),但字面上无弹窗。plan AC 行「行级撤销回线上值(确认弹窗)」同源。

### P-4 · 「查看线上值」行内 diff 未实现(PRD CON04-⑥ 点击流行,建议 P2)
- **实测**:改动行只有「撤销为线上值」一个行级动作;PRD ⑥「查看线上值(行级)→ 行内 diff 展示(线上 vs 草稿)」的入口在页面上不存在。代码旁证:线上值仅以撤销按钮 hover title 展示(en 单语,非结构化 diff)。

### P-5 · 探活后空 URL 且关闭的入口显示红色「不可达(空)」pill(UI 噪声,建议 P3)
- **实测**:Web App 行(未配置、coming-soon 态)在探活后打红点「不可达(空)」。该行"空"是合法目标态(空+关闭=coming-soon),以红色故障语义呈现属噪声;预警语义应留给"配了 URL 但探不通"。

### 观察项(不计分,照报)
- **O-1 口径月范围**:`2026-13` 客户端与服务端(zod `^\d{4}-\d{2}$`)一致放行——双端同口径成立,但 regex 只查形状不查 01–12 范围;可选加固,非本轮 AC 违项。
- **O-2 状态条计数口径**:计**叶子路径**数。下载入口"开 iOS+填 URL+android URL"一次保存=3 处;派单 AC 写"+1"按次数直觉,实现按叶子——非缺陷,口径记录(与发布 diff/高敏判定同一 diffPaths 单源)。
- **O-3 旧标签页状态条**:B 在冲突发生前状态条仍显「与线上一致」(其 overview 是旧的)——stale-tab 固有属性,冲突条已兜住写路径;照实记录。
- **O-4 uptime=101 时**该卡同时显示「✓ 非演示锚值」(101≠99.7 锚值,逻辑自洽)与全局红条——组合略怪但无害。

## 验收方法交底(透明)
- **page.request 401 伪影**:Playwright `page.request` 不随 http URL 携带 Secure cookie(T10 报告同族坑),首轮 B3/C2/E2 因此误红;已全部改为**页面内 fetch**(浏览器自带会话 cookie)复测,结论以复测为准。
- **F3 时序伪影**:主跑读状态条早于壳异步刷新,读到旧值;单点复测(t12f-retest)加等待后 4/4 pass(chip=「草稿 · 3 处未发布改动」),F 组结论以复测为准。
- **夹具复位**:前两轮脚本中断各留 1 处残稿,复跑前用产品自身 `PUT /api/config/draft` 把草稿写回 live payload(dirty 1→0),未触碰任何产品逻辑与数据面之外的东西。
- console 全程:JS error / pageerror = **0**;唯一 console 条目=AC-E 故意触发的 409 网络层日志。dialogs=0(P-3 佐证)。

## 收尾核销(硬收尾项)
- **草稿撤净**:主跑 FINAL 断言 `chip=与线上一致 · dirty=0 · changedPaths=[]`;其后 F 复测自身收尾再证「与线上一致」——**最终状态=与线上一致 ✓**。
- 8796 进程树杀净:`netstat` 8796 LISTENING=0;命令行含 `.wrangler-t11` 的进程=0(按 PID 树杀,严格排除他人 8787/8788 与本 shell 自匹配)。
- `worker/.wrangler-t11` 已删除(Test-Path=False)。
- 浏览器:4 次 launch 全部走到 finally `browser.close()` 且 node 进程正常退出;机器上现存 chromium 为并行他会话产物,未触碰。
- 仓内写入:`git status --porcelain`=0(dist 组装物在 ignore 内),**本报告为唯一新增文件**。
- 证据文件(会话 scratchpad,不入仓):`t11t12-test.cjs` / `t12f-retest.cjs` / `t11-results.json` / `t12f-retest-results.json` / `t11-shots/*.png`(基线、A 保存/刷新/清净、B 红框、C 黄警、D 信任/FAQ/设备、E 冲突条/刷新后、F 空URL/http/探活三态、G 锚值/101、H 预览、终态清净共 20 张)。

## 五点复测(2026-08-31 修后,commit 6544d69)

修法五连(P-1~P-5)+ 口径月正则收紧,重建前端产物 → **全新** `.wrangler-t11` 迁移 → 8796 → setup+登录,真浏览器复测 **12/12 PASS**:

| # | 项 | 结果 | 关键证据 |
|---|---|---|---|
| ① P-2 客户端 | ✅ | vi 删 `{devices}` → 行级红提示「占位符缺失:{devices}——保存被拦(缺了站上会渲染残缺)」+ 工具栏「有占位符缺失,保存被拦」+ **保存按钮禁用**(截图 R2) |
| ① P-2 服务端 | ✅ | 绕过 UI 带 cookie 直接 `PUT /api/config/draft`(payload 丢占位符)→ **400 `error=placeholder`**,issues 指名 `copy.vi.social.scaleLine`;回读草稿未变(`{devices}` 仍在,draftRev 1→1,dirty=0) |
| ② P-3 两步撤销 | ✅ | 改一处后点「撤销为线上值」→ 按钮变「**确认撤销为线上值?**」且文本**未**回退;再点 → 回线上值、确认态复位 |
| ③ P-4 查看线上值 | ✅ | 行点「查看线上值」→ 行内展开三语线上值对照(en/vi/zh 三行),**与草稿有差的 vi 行黄标**(var(--warn))、无差的 en/zh 行常色;「收起线上值」→ 面板消失(截图 R4) |
| ④ P-1 冲突条即清 | ✅ | 双 context 制造 409 冲突条后点「刷新后重试」→ 横幅 **1ms 内消失**(不等下次保存);随后 B 视图刷到对方最新草稿,再存成功 |
| ⑤ P-5 探活灰标 | ✅ | 三入口全部未启用+空 URL 点「立即探活」→ 三行灰标「**未启用/未配置,不探**」、红标 0;API 返回 `{ios:{skipped:true},android:{skipped:true},h5:{skipped:true}}`(截图 R5) |
| 附 口径月收紧 | ✅ | `2026-13` → 客户端红条「口径月格式:YYYY-MM(月份 01-12)」+ 保存禁用;绕过 UI PUT → 400 `error=bad-structure`——**双端同拒** |

- console 全程:JS error / pageerror = 0;仅 3 条故意负路径网络日志(2×400 为绕过 UI 的 PUT 探针、1×409 为冲突制造)。
- 收尾核销(同前配方):终态 `chip=与线上一致 · dirty=0 · changedPaths=[]`;8796 树杀后 LISTENING=0、含 `.wrangler-t11` 进程=0;`worker/.wrangler-t11` 已删(Test-Path=False);浏览器随脚本关净;仓内写入仍仅本报告(`git status --porcelain` 唯一条目)。
- 证据:scratchpad `t11t12-retest5.cjs` / `t11-retest5-results.json` / `t11-shots/R*.png`(R5 灰标、R6 口径月、R2 保存被拦、R3 确认步、R4 对照展开、R1 横幅即清、R 终态)。

**结论:P-1~P-5 全部修复实证成立,观察项 O-1(口径月)同步闭环;本报告问题清单就此全数关闭。**
