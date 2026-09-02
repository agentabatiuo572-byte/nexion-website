# T13/T14 独立黑盒验收报告 — 产品卡 / FAQ / 公告条 / SEO 页脚 / Legal(2026-08-31)

- **验收人**:独立 tester(未参与实现);真浏览器 Playwright(Chromium,借 Nexion-uniapp 依赖)黑盒实测。
- **规格依据**:官网后台 PRD [FEAT-CON07]~[FEAT-CON11];plan T13/T14 节;被测提交 `ab7bb7e`。
- **环境**:站仓 `npm run build` → `npm run build:console`(exit 0)→ worker `wrangler d1 migrations apply nexgrid_site --local --persist-to .wrangler-t13`(2 迁移 ✓)→ `wrangler dev --port 8797 --persist-to .wrangler-t13`;URL 全走 `http://127.0.0.1:8797`;SETUP_TOKEN=dev-setup-token 初始化+登录。专属资源,全程未触碰 8787/8788 与默认 `.wrangler`。
- **口径**:全部判定来自运行时真操作(真输入/真点击/真拖拽/页面内带 cookie fetch/截图回看);代码引用仅作旁证。API 探针(GET /api/config、POST /api/config/validate、PUT /api/config/draft)一律页面内 fetch(浏览器自带会话 cookie,规避 page.request 不带 Secure cookie 的已知坑)。

## 总裁决:AC 7 组(A–G)全 pass;细项主跑 38/40 + 复测 9/9(主跑仅有的 2 条 fail 均为测试脚本骨架期读取伪影,单点复测闭环)

| AC | 判定 | 关键证据 |
|---|---|---|
| A 产品卡 | ✅ pass | ①页面按钮全集=[编辑 \| 保存草稿(+dirty 时「放弃」)],**无任何新增/删除 SKU 入口(不存在,非置灰)**,7 卡齐;②改 Phone 价格 → 行 pill「事实字段已改」+ 卡内警条「产品事实字段已改——发布须理由,且请确认与 App PRD §7.1 一致」(截图 01);③7 个展示全关 → 红条「设备板块不可为空:至少保留 1 个可见(当前 0)——保存被拦」+ 保存禁用;④真拖拽(dragTo 把手位)第 2 卡到第 1 位 → 保存 200 → **刷新后顺序保持**(Cloud Share, Phone, …),拖回还原保存后 dirty=0;⑤标语 en 输入 `earn $5 per day` → textarea 红框(var(--bad))+「合规拦截:en:earn $5 per day(可存草稿,发布将被拒)」;⑥撤净 dirty=0 |
| B FAQ | ✅ pass | ①「+ 新增条目」→ **网络面板证据 POST /api/config/mint-id → 200 `{"id":"faq-916beba9"}`**(id 服务端签发),空白展开卡追加(9→10);②只填 en 保存 → 列表该行「缺译」黄旗(截图 06);③validate errors 含该 id untranslated **4 条**(q/a × vi/zh);④删除第 1 条 → **两步确认**(按钮原地变「确认移入回收区?」)→ 入回收区 → 列表重排(原 #2「How do I earn?」变 #1,截图 08);⑤回收区「恢复」→ 回列表、回收区回空态;⑥可见减到 2 → 红条「FAQ 可见条目须 ≥3(当前 2)——保存被拦」+ 保存禁用;⑦未填三语条目两角度:缺译角度=②③;回收区角度=删除+保存后 validate 该 id untranslated 4→**0**、min-visible 无误报 |
| C FAQ 回收区发布语义(API 面) | ✅ pass | ①标 deleted 保存成功后 GET /api/config:draft.faq.items **该条仍在且 `deleted:true`**;②min-visible 口径判别实验:活条可见 2 + 回收条 visible=true → validate **报 min-visible**(若计回收应凑满 3 不报);活条可见 3 → 不报——**「不计回收」口径实证**;③物化不含回收条目:既有机器门背书(派单口径,不自建);④恢复+保存 200;终态经草稿写回 live(产品自身 PUT 通道,T11 同配方)达 **dirty=0**、列表 9 条还原(UI 路径的语义限制见 P-1) |
| D 公告条 | ✅ pass | ①初始 pill=disabled(复测 R21);开启不填 → 红条**逐条**列出 4 条(en/vi/zh 文案必填 + 须有起止时间)+ 保存禁用 + pill「缺时间」(截图 10);②三语填好、结束(明日 09:00)早于开始(明日 10:00)→ 红条「结束时间须晚于开始」+ 保存禁用;③改结束 12:00 → 红条清零、**未来窗 pill=「scheduled(未到窗)」**→ 保存 200 → id 由种子 `"none"` 变 server 铸 `ann-3cac16c2`;④再改 en 文案再保存 → GET 对比 **id `ann-3cac16c2` → `ann-f9b53abe` 不同**(内容变更换 id 实证);⑤关闭开关+清空保存 → 终态 dirty=0(id 重铸残差见 P-3) |
| E SEO 页脚 | ✅ pass | ①6 页签逐点切换 6/6;②首页 en title 种子即 62 字符:计数「62/60」warn 色 + 黄警「超长——搜索结果可能截断(软警,可发布)」,加长后黄警仍在且**保存可点(不拦)**;③邮箱填 `not-an-email` → 红条「邮箱格式不合法」+ **保存禁用(拦)**;④填 `ops-t13@example.com` 保存 → **dirty 0→1**,changedPaths=`["footer.contactEmail"]`,chip「草稿 · 1 处未发布改动」;⑤清空保存 → 旁注「当前为空:站上联系行隐藏中(R49 待办③,配好邮箱后填入)」+ dirty=0 |
| F Legal | ✅ pass | ①高敏 pill「高敏 · 发布须理由」在场(复测 R22);文档 3 + 语言 3 页签全通,「·改」dirty 标记随动;②en 粘贴含 `# 标题`/`**加粗**`/`- 列表`/`[链接](/x)` 的 md → 右栏**逐类**渲染:标题 div(18px/600)、`<b>加粗文字</b>`、`<ul>` 2 `<li>`、站内 `a[href=/legal/privacy]` + 外链 `a[href=https://example.com/t13]`(截图 16);③追加 `<script>alert(1)</script>` 保存 → **200 且响应 `sanitized:1`**,GET 读回正文**无 script/alert(1)**、md 结构保留,保存后编辑区同步显示剥离后文本;④vi 留空 → 预览「(空——站上将回退英文正文并显示 EN-prevails 提示行)」;⑤清空保存 → dirty=0 |
| G 全程质量 | ✅ pass | 主跑+复测两轮:**pageerror=0;console error=0;console warning=0;dialog=0**(负路径全程零 4xx——所有拦截均为客户端禁用保存,无网络层报错噪声);死按钮全扫:编辑/收起(产品卡+FAQ)、删除两步/恢复/新增、总开关、6+6 页签、保存/放弃(五页)、SEO「文案树」链接落 /admin/content——**全部有响应,零死按钮** |

## 问题清单(全部上报,不自我审查;分级为建议,裁决权在 main/主人)

### P-1 · 已保存的新增 FAQ 条目没有 UI 路径彻底移出草稿——「删除+保存」后 dirty 恒 >0(规格空隙,留裁决)
- **实测**:新增条目保存后(dirty=9),删除→两步确认→保存,该条以 `deleted:true` 墓碑留在草稿(C1 实测 dirty=10);恢复+保存亦然。发布物理剪除前,草稿与线上永远有差,状态条/发布徽标持续显示未发布改动。
- **对照**:派单收尾口径「新增条目要靠『放弃本页未保存改动』**或删除+保存**撤净」——前者仅对未保存态成立;后者与实现语义不符(墓碑=CON08-④ 设计,发布时才剪除)。本轮撤净走了产品自身 `PUT /api/config/draft` 草稿写回 live(T11 报告同配方),终态 dirty=0 实证。
- **裁决点**:V1 期(发布流水线 T21 未落地)这是「误增条目后无法自助归零」的操作面空隙;是否给回收区加「彻底移除(仅限从未发布过的条目)」或接受现状等 T21,留 main/主人。

### P-2 · 回收区「恢复」回原位,PRD ⑥ 字面为「回列表末位」(规格偏差,建议 P3)
- **实测**:第 1 位条目删除入回收区后点「恢复」,回到**第 1 位**(原位);PRD CON08-⑥ 点击流行写「回收区『恢复』→ 回列表末位」。回原位对用户更友好(位置不丢),但与规格字面不符,照实上报。

### P-3 · 公告手工全量回滚后残留 1 处幽灵改动(announcement.id)(UI 语义噪声,建议 P3)
- **实测**:公告发过草稿改动后,手工把开关/文案/时间全部改回原样保存 → 服务端因「内容变更」再次铸新 id(CON09-E3 语义),draft.id ≠ live.id → chip 仍显「草稿 · 1 处未发布改动」,而页面上看不到任何差异(id 不可见不可编辑)。主人手工回滚场景会遇到解释不了的 1 处计数;终态本轮由 API 写回 live 归零。

### P-4 · Legal 剥离提示为泛化文案,未用响应中的 sanitized 计数(提示精度,建议 P3)
- **实测**:注入 `<script>` 保存,服务端响应带 `sanitized:1`,但 toast 恒为「草稿已保存(服务端已剥离危险内容,如有)」——未发生剥离时同文案。PRD E3「剥离危险节点**并提示**」字面有提示,但管理员无法从提示得知是否真的发生了剥离、剥离了几处。

### 观察项(不计分,照报)
- **O-1**:SEO 首页 en title 种子值本身 62 字符,载入即黄警——属如实反映现状,非缺陷。
- **O-2**:FAQ 回收墓碑的全部叶子(含 `deleted`)计入 dirty 计数与发布徽标(与 P-1 同根,单独记录口径事实)。
- **O-3**:公告窗口态 pill 四态中本轮实测 disabled/缺时间/scheduled 三态;live/expired 未构造(需窗口即时命中,非本轮 AC)。

## 验收方法交底(透明)
- **主跑 2 条 fail 均为测试自身伪影**:公告/Legal 的加载骨架与实页共用同一 `<h2>`,脚本在数据到达前读取 pill 得 false;单点复测(等 checkbox/textarea 渲染后读)两条均 PASS(R21/R22 截图),**非产品缺陷**。
- **拖拽为真输入**:Playwright `dragTo`(把手位起手)一次成功,未动用合成事件兜底。
- **夹具复位**:全部撤净动作优先走 UI(放弃/清空/恢复);UI 语义到不了 dirty=0 的两处(P-1 墓碑、P-3 id 残差)用产品自身 `PUT /api/config/draft` 把草稿写回 live payload(与 T11 报告同配方),未触碰产品逻辑之外的任何面。
- 证据文件(会话 scratchpad,不入仓):`t13-test.cjs` / `t13-retest.cjs` / `t13-results.json` / `t13-retest-results.json` / `t13-shots/*.png` 22 张(A2 高敏、A3 全隐藏、A4 刷新后顺序、A5 禁用词、B1 新增、B2 缺译、B4 两步/回收区、B6 门槛、D1 空开启、D2 倒挂、D3 scheduled、E1 超长、E2 坏邮箱、E4 清空、F1 预览、F2 剥离、F3 回退、G 终态、R21/R22/R23 复测)。

## 收尾核销(硬收尾项)
- **草稿撤净**:主跑 G1 `overview.dirty=0`、chip「与线上一致」;复测收尾 R-FINAL 再证 `dirty=0`——**终态=与线上一致 ✓**。
- **8797 进程树杀净**:按「监督进程树」杀(launcher cmd → npx → wrangler node → workerd 全树);回读 `netstat` 8797 LISTENING=**0**;命令行含 `wrangler-t13` 的进程(排除自身 shell)=**0**。8787/8788 与默认 `.wrangler` 全程未触碰。
- **`worker/.wrangler-t13` 已删除**(Test-Path=False;缓存目录,守卫 hook 按其逃生阀标记放行)。
- **浏览器关净**:两轮脚本均走到 finally `browser.close()` 且 node 进程正常退出。
- **仓内写入**:冻结期间零写入;测试后 `git status --porcelain` 唯一新增=本报告(dist 组装物在 ignore 内)。

## 四点复测(2026-08-31 修后,commit f72a3c0 + 181aa85)

P-1~P-4 修法四连,站仓重建(`npm run build` + `build:console`,新 bundle `index-CvLVvsT2.js`)→ **全新** `.wrangler-t13` 迁移 → 8797 → setup+登录,真浏览器复测 **8/8 PASS**:

| # | 项 | 结果 | 关键证据 |
|---|---|---|---|
| ① P-1 彻底移除 | ✅ | 新增 FAQ 保存(dirty=9)→ 删除入回收区 → 回收行带「**从未发布**」pill + 红字「**彻底移除**」按钮(截图 F31)→ 点击行消失 → 保存 200 → **dirty=0**、草稿中该 id 零残留、chip「与线上一致」——**UI 路径归零实证** |
| ② P-2 恢复回末位 | ✅ | 删第 1 条「What is NexGrid?」入回收区:既有条目**无**「从未发布」pill、**无**「彻底移除」(仅限从未发布的对照成立);按钮文案=「**恢复(回末位)**」→ 点击后该条位于第 **9/9** 位(#9 pill,截图 F34);放弃后 dirty=0 |
| ③ P-3 幽灵清零 | ✅ | 改公告 en 文案保存 → id=`ann-45aa7b17`、changedPaths=`["announcement.id","announcement.text.en"]`;**改回与线上逐字一致**再保存 → id 还原 `"none"`、GET /api/config **changedPaths 含 announcement 项=0**、dirty=0 |
| ④ P-4 剥离真实计数 | ✅ | 粘贴含 2 个 `<script>` 块的 md 保存 → toast=「**已剥离 1 处危险内容并保存 · 未发布**」(数字=服务端响应 `sanitized:1`,计数口径=发生剥离的**字段**数,非 script 块数——照实记),无「如有」字样;读回无 script;对照:无剥离保存 → toast 回常规「草稿已保存 · 未发布」 |

- console 全程:JS error / pageerror = 0;dialog=0。
- 收尾核销(同前配方):终态 `dirty=0`、chip「与线上一致」;8797 进程树杀净回读 LISTENING=**0**、含 `wrangler-t13` 进程=**0**(本轮匹配显式排除自身 shell);`worker/.wrangler-t13` 已删(Test-Path=False);浏览器随脚本关净;仓内写入仍仅本报告。
- 证据:scratchpad `t13-retest2.cjs` / `t13-retest2-results.json` / `t13-shots/F31~F36.png`。

**结论:P-1~P-4 全部修复实证成立,问题清单就此全数关闭**(P-4 的计数口径按字段数,与「N 处」文案自洽,无遗留)。
