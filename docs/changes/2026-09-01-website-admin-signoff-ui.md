# 官网运营后台 · 独立验收实景走查(界面面)

> **本次实际走了什么**:真浏览器(Playwright / Chromium,`http://127.0.0.1:8787`,伺服 `dist-live`,bundle `index-BInopkMx.js` = 当前 HEAD `dd46330` 构建物)。
> 路由全覆盖:`/admin/login` `/admin/setup`(未初始化态 + 已初始化态)`/admin/`(驾驶舱)`/admin/content` `/content/downloads` `/content/stats` `/content/skus` `/content/faq` `/content/announcement` `/content/seo` `/content/legal` `/admin/geo` `/admin/publish` `/admin/audit` `/admin/no-such-page`。
> 真点真输:登录/退出/会话过期回跳、文案树改值+存草稿+撤销、禁用词命中、去修复真链接点击、下载入口非法 URL 与开启空 URL、平台数字负值与 uptime 150、公告条超长/倒挂时间/非法链接、FAQ 连删 7 条到剩 2 条、产品卡展开+改价格+全隐藏、SEO 非法邮箱、Legal 粘 `<script>`/`<iframe>` 并保存、区域屏蔽加国家/写入失败/降级态/正文超 300、审计筛选+导出 CSV(比对服务端真实条数)、发布页红项/提醒/diff 溢出、回滚确认面板位置、登录与初始化 429 限流。
> 窄屏:看了,`375px` 全路由 + `1000px` / `1200px` 对照(1023/1024 断点两侧)。触达面积、焦点可见、reduced-motion、对比度均实测。
> 判据来源:CON01–CON16 回源自 `D:/WORKS/PLAN/PRD/NexGrid_官网后台PRD_v1.0.md`(**注:派单写的是 `NexGrid_官网PRD_v1.0.md`,该文件里没有 CON 条目;CON01–CON16 在「官网后台 PRD」**)+ `D:/WORKS/PLAN/CLAUDE.md` 项目不变量。
> 环境说明:走查期间另有 agent 在同一 dev 库上跑接口审计,版本号/草稿计数/drift 提示在截图之间会变;下列结论均不依赖具体数据值。

**合计 30 条:P0 × 1 · P1 × 11 · P2 × 18。**

---

## P0

### P0-1 窄于 1024px 时,文案树 18 个分组名全部消失,只剩一列空白按钮

- **路由**:`/admin/content`
- **文件**:`admin/src/styles.css:104`(`@media (max-width: 1023px) { … .nav span.lbl, .navg, .brandrow .lbl { display: none; } }`)× `admin/src/pages/content.tsx:78-79`(`<button className="nav"> … <span className="lbl">{label}</span>`)
- **复现**:登录 → 把浏览器窗口拉到 1000px 宽(或任何 <1024px,含手机)→ 打开左侧「文案树」。
- **屏幕上实际是什么**:左栏 18 个分组按钮宽 190px、**内容全空**。程序取值:`visibleText: ""`,`getComputedStyle(.lbl).display === "none"`,18 项全中。整列只剩两枚孤零零的橙色「高敏」小标签浮在空白上,当前选中项是一条没有字的橄榄色高亮条。同一页面拉到 1200px,同样这三项立刻恢复成「首屏 Hero / 下载按钮文案 / 统计标签」。
  截图:`30-content-1000px.png`(1000px,空白列)对照 `31-content-1200px.png`(1200px,正常);手机档 `w375-content.png`。
- **为什么是问题**:根因是 `styles.css:104` 那条选择器**没有限定在 `aside` 内**。它本意是 CON02-⑤「窄窗(<1024px)导航折叠为抽屉」,只该收侧边导航;而文案树的分组列表复用了同一个 `nav`/`lbl` 类名,于是被连坐。
  后果落在不变量「业务链必须有下一步 / 禁用原因」与 CON04-⑤「默认态:左组列表(18 组中文名+改动角标)」上:运营在 <1024px 的窗口里**无法知道自己正在编辑哪一组文案**,只能盲点。文案树是三语上线文案的唯一编辑面,点错组直接改错站上文字。侧栏折叠后还有 `aria-label` 兜住(shell.tsx:94),这一列**连 aria-label 都没有**——读屏器同样什么都读不到。
  这是「守被调用方≠守调用点」的同型:上一轮为侧栏折叠加的规则,伤到了另一个复用同名类的调用点。

---

## P1

### P1-1 「去修复」九个红项路径里八个定位不到,点过去落在完全无关的分组

- **路由**:`/admin/publish` → `/admin/content`(及其余七个内容页)
- **文件**:`admin/src/lib/use-focus-field.ts:20-26`;消费端只有 `admin/src/pages/downloads.tsx:54`(`data-field={`downloads.${k}`}`)与 `admin/src/pages/skus.tsx:53`(`data-field={`skus[${…}]`}`);`content.tsx` / `stats.tsx` / `faq.tsx` / `announcement.tsx` / `seo.tsx` / `legal.tsx` 六页调了 `useFocusField()` 但**一个 `data-field` 都没有**。
- **复现**:构造一条真实红项(我用 mock 的 preflight 回了 `{path:'copy.zh.footer.legalLine', rule:'forbidden-word'}`,与真实校验器 `schema/src/validators.ts:88/96` 产出的路径同形)→ `/admin/publish` → 点该行「去修复」。
- **屏幕上实际是什么**:URL 变成 `…/admin/content?focus=copy.zh.footer.legalLine`,**页面停在顶部**(`main.content.scrollTop = 0`),没有任何高亮(`.focus-flash` 数量 = 0),左栏当前选中的仍是默认的「首屏 Hero」组,右侧第一行仍是 `hero.title`。浏览器控制台留下一行:`[focus] 页面上找不到字段容器:copy.zh.footer.legalLine(链接给的路径这一页认不出)`。红项本身指的是**页脚**组的法定名行。
  截图:`A1-gofix-row.png`(红项行)、`A2-gofix-landing.png`(落地页)。
- **为什么是问题**:CON13-⑥ 明写「红项「去修复」→ 对应内容页 → **定位到红字段**」。逐条实测九个真实路径形态,只有 `downloads.*` 一条成立:

  | 校验器真实路径 | 目标页 | 结果 |
  |---|---|---|
  | `copy.zh.hero.note` | /content | ✗ 找不到容器 |
  | `copy.vi.footer.legalLine` | /content | ✗ |
  | `downloads.ios.url` | /content/downloads | ✓ 高亮 + 聚焦 |
  | `stats.activeDevices` | /content/stats | ✗ |
  | `skus.<id>.tagline.zh` | /content/skus | ✗(页面写的是 `skus[0]` 下标式,校验器发的是 id 式,前缀兜底切到 `skus[0].tagline` 也对不上) |
  | `faq.<id>.q.zh` | /content/faq | ✗ |
  | `announcement.text.en` | /content/announcement | ✗ |
  | `seo.<pid>.title.en` | /content/seo | ✗ |
  | `legal.terms.en` | /content/legal | ✗ |

  派单交底里第 4 条写「已接消费端」——**只接了下载入口一处**,而红项里占绝对多数的文案类(禁用词/缺译/占位符,`copy.*`)一条都没接。运营拿到「42 项红」的清单,点每一项都落在页顶,还得自己去 18 个组里翻。
  附带:`skus` 那处虽然有属性,但两边路径记法不同(`skus[0]` vs `skus.<id>`),属于「有门但判据对不上」,比没有更容易被误认为已修。

### P1-2 文案输入框不自增高,多行内容被裁掉一半且视觉上像坏掉

- **路由**:`/admin/content`
- **文件**:`admin/src/pages/content.tsx:150`(`rows={Math.min(6, Math.max(2, Math.ceil(v.length / 46)))}`)
- **复现**:打开文案树 → 任一 key 的任一语言框里输入五行文本(每行 3 字)。或直接看默认数据里的 `hero.subtitle2`(en/vi 都含一个 `\n`)。
- **屏幕上实际是什么**:输入五行后,`rows` 仍是 2,`clientHeight = 59`、`scrollHeight = 124` —— **一半以上内容看不见**。默认数据的 `hero.subtitle2` en 栏屏幕上显示:
  > Offering you high-performance
  > computing services
  > *(第三行 "and GPU cloud hosting solutions" 只露出上半截笔画,被框底切断)*

  1000px 宽时同一缺陷扩散到 `hero.subtitle` 的 en/vi 两栏(截图 `30-content-1000px.png` 中「The world's leading provider of distributed …」与「Nhà cung cấp dịch vụ chia sẻ năng lực tính toán phân …」都被切在第三行腰上)。测量:`/content` 首屏 18 个输入框里 2 个被裁;`92-textarea-multiline.png` 为五行输入实拍。
- **为什么是问题**:CON04-⑤ 报错/极限态明写「长文 textarea **自增高**,`\n` 可见保留;**超长不溢出**」。行数只按 `字符数 / 46` 估算,既不看真实列宽(三语并排时每栏只有 ~250px,1000px 窗口下更窄),也**完全不看内容里的 `\n`**——而这一页恰恰是三语换行结构要对齐的地方(校验器 `newline-shape` 规则专门盯它)。运营看到的是一条被腰斩的半截字,分不清是文案本身有问题还是界面坏了。

### P1-3 发布前置校验只列 15 条红项,剩下的没有任何出口

- **路由**:`/admin/publish`
- **文件**:`admin/src/pages/publish.tsx:342`(`pre.errors.slice(0, 15)`)、`:352`(`…另有 {pre.errors.length - 15} 项`)
- **复现**:让 preflight 返回 42 条红项(我 mock 了接口;真实场景下三语缺译很容易上百条)→ 打开 `/admin/publish`。
- **屏幕上实际是什么**:
  > **前置校验未通过(42 项),不会进入发布流程:**
  > *(15 行表格,每行带「去修复」)*
  > …另有 27 项

  实测可见行数 = 15,页面上**没有任何「展开 / 查看全部 / 加载更多」按钮**(我把全页所有 button/a 的文案筛过一遍:只有「发布(过全部机器门)」)。截图 `90-publish-truncation.png`。
- **为什么是问题**:CON13-E1 逐字写的是「不进流水线,**列出全部红项**(每项带「去修复」跳转)」。27 项既看不到内容也拿不到跳转,运营只能修 15 条 → 再刷新 → 再看下 15 条,而且永远不知道总共要修几轮。这条同时踩不变量「业务链必须有下一步」。

### P1-4 审计导出 CSV 只导已加载的 50 行,库里还有 45 行没进文件

- **路由**:`/admin/audit`
- **文件**:`admin/src/pages/audit.tsx:35`(`limit: '50'`)、`:52-70`(`exportCsv` 只序列化 `rows`,即当前已加载的部分)
- **复现**:打开审计页(不点「加载更早」)→ 点「导出 CSV」→ 打开下载的文件数行;再直接查服务端 `GET /api/audit?limit=500` 的条数。
- **屏幕上实际是什么**:表格 50 行;导出的 CSV 51 行(1 表头 + 50 数据);服务端同一时刻返回 **95** 条。导出按钮上写的只有「导出 CSV」四个字,**点之前没有任何提示**;点完弹一条 2.6 秒后自动消失的浮层:
  > 已导出 50 行(当前已加载范围)

  产物见 `signoff-ui/audit-export.csv`。
- **为什么是问题**:CON14-② A1 的口径是「按类型与时间过滤 → 列表显示 … **可导出 CSV**」,导出对象应是筛选结果集而不是「视口里恰好加载了多少」。审计是追责面,一份缺了近一半记录的存档交出去,读的人无从知道它是残缺的——唯一的告知在一条已经消失的浮层里。**反方观点**:toast 文案确实说了「当前已加载范围」,不算撒谎;但事前不告知、事后即消失,不足以支撑一份要拿去追责的存档。

### P1-5 审计没有「发布」筛选,发布/回滚/取消全被归进「内容」

- **路由**:`/admin/audit`
- **文件**:`admin/src/pages/audit.tsx:20-22`(`FILTERS = [['', '全部'], ['config.', '内容'], ['geo.', '规则'], ['login.', '登录'], ['auth.', '账号'], ['admin.', '运维']]`)
- **复现**:打开审计页 → 点「内容」页签 → 看「动作」列有哪几种。
- **屏幕上实际是什么**:页签只有「全部 内容 规则 登录 账号 运维」六个。点「内容」后,动作列出现七种:`保存草稿` / `发起发布` / `发布失败` / `取消发布` / `发起回滚` / `发布被拒(已有发布进行中)` / `发布成功上线`。截图 `A0-audit-content-filter.png`。
- **为什么是问题**:CON14-② A1 写死了四类「内容/规则/**发布**/登录」。现在「发布」这一类不存在,且被塞进一个语义相反的标签底下——运营想查「谁在什么时候发布了什么」,得先猜到要点「内容」。另附:`auth.logout`(退出登录)归在「账号」而 `login.*` 归在「登录」,查一次会话进出要点两个页签。

### P1-6 审计完全没有时间过滤

- **路由**:`/admin/audit`
- **文件**:`admin/src/pages/audit.tsx:75-81`(过滤条只渲染类型 pill + 导出按钮)
- **复现**:打开审计页,数一下有几个日期/时间输入。
- **屏幕上实际是什么**:`document.querySelectorAll('input[type=date], input[type=datetime-local]').length === 0`。过滤条上只有六个类型 pill 和一个「导出 CSV」。往前翻只能靠底部「加载更早 …」一次 50 条地翻。截图 `C2-audit-table.png`。
- **为什么是问题**:CON14-② A1「按类型(…)**与时间过滤**」、⑤ 默认态「过滤条(类型/**时间**)」两处都明写。出事后要定位「昨天下午三点到四点发生了什么」,现在只能一页一页往回按。

### P1-7 区域屏蔽写入失败:只有一条 2.6 秒后消失的浮层,没有重试,还直印错误码

- **路由**:`/admin/geo`
- **文件**:`admin/src/pages/geo.tsx:57-59`(`toast(\`未生效,线上仍为旧规则:${ex.body.error}\`)`)
- **复现**:拦截 `PUT /api/geo` 返回 500 → 在页面上加一个国家 → 点「应用变更(确认+理由)」→ 填理由 → 点「确认应用」。
- **屏幕上实际是什么**:屏幕底部浮出一行,2.6 秒后自动消失:
  > 未生效,线上仍为旧规则:kv_write_failed

  之后页面上**再也没有任何失败痕迹**——我把全页按钮文案筛了一遍,含「重试」的数量为 `[]`(零个)。「应用变更」按钮恢复可点,旁边的小标签仍是改动前就有的「改动未应用」。截图 `41-geo-write-fail.png` / `42-geo-write-fail-after.png`。
- **为什么是问题**:CON12-⑤ 报错/极限态逐字写「写 KV 失败 → 「未生效,线上仍为旧规则」**+重试**(失败态不装成功)」。重试入口不存在;更要紧的是这是**合规姿态**的开关,失败信息在 2.6 秒内蒸发,运营一转头就会以为「我点了、没报错、应该生效了」。附带 `kv_write_failed` 是服务端错误码,踩不变量「页面文案禁止错误码」。

### P1-8 拦截页正文超 300 字:没有计数、不拦、提交后只得到一句 `bad-request`

- **路由**:`/admin/geo`
- **文件**:`admin/src/pages/geo.tsx:121-122`(label 写着「≤300」,`<textarea rows={2}>` 无 `maxLength`、无计数、无 inline 校验);失败路径同 `:58`
- **复现**:在「拦截页文案」的「zh 正文(≤300)」里粘 340 个字 → 点「应用变更」→ 填理由 → 「确认应用」。
- **屏幕上实际是什么**:输入过程中**没有任何计数或红字**(对比公告条有 `130/120` 计数);「应用变更」按钮保持可点(`disabled === false`);提交后浮出:
  > 未生效,线上仍为旧规则:bad-request

  2.6 秒后消失,页面无残留提示。截图 `B0-geo-over300.png` / `B1-geo-over300-submit.png`。
- **为什么是问题**:CON12-③ 约束 `blockPage` 长度 ≤300。运营被界面放行到最后一步,再被一句自己看不懂、且很快消失的英文码打回,没有任何指向「是哪一栏、超了多少」的信息。踩不变量「业务链必须有下一步 / 失败重试」与「页面文案禁止错误码」。

### P1-9 公告条总开关关着时全部校验缺席:倒挂时间、`javascript:` 链接、超长正文都能存进草稿

- **路由**:`/admin/content/announcement`
- **文件**:`admin/src/pages/announcement.tsx:29`(`if (a.enabled) { …所有校验… }`)、`:79`(保存按钮只在 `errs.length > 0` 时禁用,而 `errs` 在关闭态恒为空)
- **复现**(总开关保持关闭):链接栏填 `javascript:alert(1)` → 开始时间填 `2026-09-10 10:00`、结束时间填 `2026-09-01 10:00` → 点「保存草稿」。
- **屏幕上实际是什么**:输入全程**没有任何红条**(页面上 `.note.bad` 只有壳顶那两条与公告无关的);保存按钮可点;点完浮出「草稿已保存 · 未发布」——**存下去了**。随后把总开关打开,四条红条才一次性冒出来:
  > 启用的公告 vi 文案必填 / 启用的公告 zh 文案必填 / **结束时间须晚于开始** / **链接须为 https 或站内路径(/ 开头)**

  另一条相关的:正文打到 130 字时计数变红「130/120」,但保存按钮**仍可点**,点下去得到浮层「保存被拒:数据结构不合法」(2.6 秒后消失,不说是哪一栏、超了几个字)。截图 `70-announce-off-novalidate.png` / `71-announce-off-saved.png` / `72-announce-on-validate.png` / `61-announce-save-over.png`。
- **为什么是问题**:CON09-E1「Given 结束 ≤ 开始,When **保存**,Then 拒绝「结束时间须晚于开始」」与 E2「href 非 https/站内路径 → 拒绝」都**没有以 enabled 为前提**。而运营的自然顺序恰恰是「先把文案和时间填好,最后才打开开关」——整个填写过程零反馈,错误全部堆到最后一步。「保存被拒:数据结构不合法」是工程说法,不告诉人下一步该改哪。

### P1-10 壳顶红条和驾驶舱健康卡把两串十六进制摘要当「大白话」印出来

- **路由**:全部页面(壳顶)+ `/admin/`(运营健康卡)
- **文件**:`admin/src/lib/fail-reason.ts:26`(`looksTechnical = !/[一-鿿]/.test(raw) || /[A-Za-z]:\\|…/.test(raw)`);消费面 `shell.tsx:125`、`dashboard.tsx:321`;文案源头 `worker/src/publish.ts:223`
- **复现**:让一次发布走到「上线核验」失败(摘要不符)→ 打开任意控制台页面。
- **屏幕上实际是什么**:壳顶常驻红条原文:
  > 上次发布失败(v11):上线核验未通过:线上快照不是照这一版的配置构建的(内容摘要对不上:期望 4a34ea4d0279…,实际 80e1f4a84ab0…)　线上仍是 v5,未受影响。

  驾驶舱「运营健康」卡里同一句原样再出现一次:
  > 最近发布 v11:失败(上线核验未通过:线上快照不是照这一版的配置构建的(内容摘要对不上:期望 4a34ea4d0279…,实际 80e1f4a84ab0…)) 发布页 →

  截图 `51-stats.png`(顶部红条)、`60-dashboard-health.png`。
- **为什么是问题**:CON02-③ 对 `lastPublish.failReason` 的约束是「**已映射为大白话**」;`fail-reason.ts:30` 自己的注释也写「单行场合(壳顶红条/驾驶舱健康卡)**只给人话**:那两处没有排查场景」。实际漏的是判据:`looksTechnical` 认「有没有中文」,而服务端这条消息是**中文句子里嵌机器值**,于是整句(含两串 hex)被判成人话原样送上主视线。派单交底第 6 条只覆盖了发布页那两处,这两处没跟上——同型第三、第四个消费面。

### P1-11 窄屏三页整页横滚,公告条页有一整栏在屏幕外

- **路由**:`/admin/content`、`/admin/content/announcement`、`/admin/content/stats`
- **文件**:`content.tsx:75`(`gridTemplateColumns: '210px 1fr'`)与 `:140`(`repeat(3,1fr)`)、`announcement.tsx:50` 与 `:60`(两处 `repeat(3,1fr)`)、`stats.tsx` 的卡片栅格 —— 三处都没有窄屏断点
- **复现**:视口设 375×780 → 逐页打开,看 `document.documentElement.scrollWidth`。
- **屏幕上实际是什么**:

  | 路由 | 布局宽 / 视口宽 | 整页横滚 |
  |---|---|---|
  | `/content` | 449 / 375 | 是 |
  | `/content/announcement` | **634 / 375** | 是 |
  | `/content/stats` | 393 / 375 | 是 |
  | 其余九条路由 | = 375 | 否 |

  公告条页最严重:「结束(本地输入,存 UTC;当前 —)」整个卡片在屏幕右侧外面,要横向滚半屏才看得到(截图 `w375-content-announcement.png`)。
- **为什么是问题**:整页横滚意味着导航、状态条、保存按钮全都跟着跑出屏幕,得先横着滚回去才能点别的——这正是 `styles.css:81-88` 那条注释为审计页/发布页表格修掉的同一个毛病。派单交底第 10 条说「已改成表格自己滚」:表格那一族确实修好了(实测 `/audit` `/publish` 的 `scrollWidth == clientWidth`,只有表格自己滚),但**栅格那一族原样留着**,是典型的「修一处 ≠ 修全部」。

---

## P2

### P2-1 发布提醒只显示 4 条、不去重,15 条看不见
`/admin/publish` · `publish.tsx:355-359`(`pre.warnings.slice(0, 4)`)。19 条提醒时屏幕上是:
> 提醒(19 项,不阻断发布):SEO 长度(SEO · 英文 · 首页 · 标题) · SEO 长度(SEO · 英文 · 首页 · 标题) · SEO 长度(SEO · 英文 · 首页 · 标题) · SEO 长度(SEO · 英文 · 首页 · 标题) …

四个位置被**同一条**重复占满,另外 15 条(可能是完全不同的问题)一条都看不到,也没有展开入口。CON13-⑤「diff 很大时分组折叠」的精神是折叠可展开,不是截断丢弃。

### P2-2 发布 diff 只列 30 条,确认弹窗却说「确认发布 64 处改动」
`/admin/publish` · `publish.tsx:328`(`changedPaths.slice(0, 30)`)、`:334`(`…另有 34 处`)、`:373`。运营只能过目 30 条,却要对 64 条按下确认,且没有展开出口。

### P2-3 版本历史直印原始 Node 报错和本机绝对路径,还截断在半个词上
`/admin/publish` · `publish.tsx:417`(`f.tech.slice(0, 160)`)。v2 行屏幕上是:
> 构建或执行过程报错(非文案问题)
> `Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'D:\WORKS\PLAN\.wt\w-console\schema\src\manifest.js' imported from D:\WORKS\PLAN\.wt\w-console\schema\src\mater`

截断在 `\src\mater` 处,无展开、无折叠。人话主视线这一层是对的(`fail-reason.ts` 起了作用),但小字这一层既读不完也用不上,同时把服务器目录结构摆在页面上。截图 `84-publish-many.png`。

### P2-4 区域屏蔽:总开关关着也写「已生效」,降级态下与红条自相矛盾
`/admin/geo` · `geo.tsx:83`。实测总开关 `checked === false`,旁边绿色标签写:
> 总开关 ☐ **已生效 · 12:58:40 回读确认**

而同屏壳状态条写的是「屏蔽 **未启用**」——同一件事两个词。降级态更明显(截图 `43-geo-degraded.png`):红条「⚠ 规则存储读取异常——边缘正在使用内置兜底名单(仅 CN)」正上方,同一枚绿标仍写「已生效」,而此刻页面显示的根本不是真规则。「已生效」指的是「KV 里的规则=页面上这份」,但这个含义在界面上没有任何交代。

### P2-5 Legal 剥离计数按「文档×语言」计,却写成「已剥离 N 处危险内容」
`/admin/content/legal` · `worker/src/config.ts:120-133`(每个 `doc×locale` 变了就 `sanitized++`)× `admin/src/lib/use-draft.ts:46`(`已剥离 ${res.sanitized} 处危险内容并保存`)。实测:在 `terms.en` 里同时粘 `<script>` 和 `<iframe>` **两个**危险节点 → 保存 → 浮层写「已剥离 **1** 处危险内容并保存 · 未发布」;重载后两段都已被删。另外保存前预览区把 `<script>alert(1)</script>` 原样当文字显示(不执行,安全没问题),但**没有任何「这两行将被删掉」的预告**,CON11-⑤ 要求的「E3 剥离提示列表」不存在。截图 `76-legal-script.png` / `77-legal-after-save.png`。

### P2-6 平台数字五条黄条印内部门号 `R49-F1`
`/admin/content/stats` · 文案源 `schema/src/validators.ts:116`,渲染 `stats.tsx:55`。屏幕上五张卡各挂一条:
> 与旧演示值相同——生产上线门(R49-F1)将拦截,请填真实口径值

`R49-F1` 是内部门编号,运营既查不到也用不上。踩不变量「页面文案禁止工程名词/错误码」。截图 `C3-stats-warn.png`。

### P2-7 校验报错直印字段键
- `/admin/content/stats` · `stats.tsx:34-35`:填 `-5` → 「**activeDevices**:须为正数」;填 uptime `150` → 「**uptime**:不得超过 100」。而输入框上方的标签写的是「Active devices(活跃设备)」「Uptime %(可用率)」。
- `/admin/content/downloads` · `downloads.tsx:28-29`:「**ios**:须为 https 完整链接」「**ios**:开启的入口必须填写链接(…)」,而那一行的标题是「iOS」。

`publish.tsx:62-80` 里已经有一张 `FIELD_NAME` 映射表(含 `activeDevices: '活跃设备'`、`ios: 'iOS 版'`),两处报错都没用上。

### P2-8 发布页的「人话路径」对文案树整族不生效
`/admin/publish` · `publish.tsx:82-96` + `:62-80`。红项行主视线显示:
> 合规禁用词　**文案 · 中文 · footer · legalLine**　命中禁用词「稳赚」　[去修复]

`FIELD_NAME` 没有收 18 个文案分组名与 key 名,于是 `copy.*` 这一族(红项与 diff 里最大的一族)只翻出了「文案 · 中文」两个词,后半截仍是英文 key。而 `content.tsx:11-16` 的 `GROUPS` 表里现成就有 `footer → 页脚`。

### P2-9 高敏页面的关键控件触达面积不足
在 1440 与 375 两档都实测:`/admin/geo` 总开关复选框 **18×18**(`geo.tsx:82`)、国家移除「✕」**22×22**(`geo.tsx:102`)、`/admin/content/downloads` 三个上下架开关 **18×18**(`downloads.tsx:62`)、`/admin/content/announcement` 总开关 **18×18**(`announcement.tsx:46`)。侧栏导航项 44×**40**,状态条 chip 高 30,「去发布」62×32。不变量要求触达 ≥44pt。区域屏蔽与下载上下架都是高敏动作,点歪的代价不小。

### P2-10 缺译黄旗点不动
`/admin/content` · `content.tsx:148`(`<span className="pill warn">缺译</span>`)。实测该元素 `tagName === 'SPAN'`、`cursor: default`、无 `onclick`、不在任何 button 内。CON04-⑥ 点击流矩阵里「缺译黄旗 → 当前页 → **聚焦该空栏**」这一行没有实现。截图 `C1-missing-translation.png`。

### P2-11 FAQ 可以一路删到 0 条,拦截发生在保存时而不是删除时
`/admin/content/faq` · `faq.tsx:56`(`visibleCount < 3` 时显示红条 + 禁用保存)、`:76-78`。实测连点 7 次「删除 → 确认移入回收区?」畅通无阻,直到剩 2 条才在页面顶部出现「FAQ 可见条目须 ≥3(当前 2)——保存被拦」。CON08-E1 写的是「Given 删到仅剩 2 条,When **删除第 3 条**,Then **拒绝**」——拦点应在删除动作上。附带:回收区 7 条只能一条条「恢复(回末位)」(`faq.tsx:120`),原来的排序全丢,没有「全部恢复」。截图 `A6-faq-min3.png`。

### P2-12 文案树搜索只在当前组内过滤
`/admin/content` · `content.tsx:40`(`.filter(k => k.startsWith(group + '.'))` 先于关键词过滤)、`:87` 占位符写「按 key 或内容过滤**本组**…」。运营记得站上有句话要改、但不知道它属于 18 组里的哪一组时,搜索帮不上忙,只能逐组点开再搜(在 <1024px 下配合 P0-1 完全不可行)。

### P2-13 审计整行可点,但短行点了没有任何变化
`/admin/audit` · `audit.tsx:106`(整行 `onClick` + `cursor: pointer`)、`:113-124`(只有 `bytes > 200` 才有「点击展开」提示,展开效果也只是解除单行省略)。实测点第一行(登录记录)前后 `innerText` 完全相同。界面给的每个可点位置都该要么有效、要么显式说明——这一条是发布页「去发布」按钮修过的同一族。

### P2-14 页面上残留的工程名词
- `/admin/login` · `login.tsx:53`:「首次使用?先完成初始化(部署时的 **SETUP_TOKEN**):去初始化 →」
- `/admin/setup` · `setup.tsx:50`:「忘记口令须重新部署轮换 **SETUP_TOKEN**(见 **worker/README 运维手册**)」;`:60` 输入框标签「初始化令牌(**SETUP_TOKEN**)」
- `/admin/geo` · `geo.tsx:92`:「直通功能当前停用:部署密钥(**BYPASS_SECRET**)未配置、或仍是仓库内的开发默认值。」
- `/admin/content/seo` · `seo.tsx:61`:「当前为空:站上联系行隐藏中(**R49 待办③**,配好邮箱后填入)」
- `/admin/content/legal` · `legal.tsx:81`:「Markdown 原文(**terms.en**)」
- `/admin/audit` · `audit.tsx:108`:每行动作名下方小字直印枚举值 `login.success` / `geo.update` / `config.publish.live` 等

不变量:「页面文案禁止工程名词 / 字段名 / 枚举值 / 错误码」。**反方观点**:审计表那处代码里有明确理由(排查时要与后端日志对得上),`SETUP_TOKEN` 也确实需要与运维手册对得上——这两处我倾向保留但建议改写成「部署时配置的初始化令牌(运维手册里叫 SETUP_TOKEN)」这种「人话在前、机器名在括号里」的写法;`R49 待办③` 与 `terms.en` 没有这种正当性。

### P2-15 窄屏下壳顶红条里的链接被压成 40px 宽的竖排单字
`/admin/*`(375px)· `shell.tsx:108-127`(`display: flex` 无换行策略)。实测「去处理」链接盒 **40×60**,屏幕上是竖着排的「去 / 处 / 理」三个字(截图 `w375-content-announcement.png`、`C4-375-banners.png`)。既难读也难点。

### P2-16 18 个分组里唯一一个英文组名
`/admin/content` · `content.tsx:14`(`['how', 'How it works']`)。CON04-⑤ 写的是「左组列表(18 组**中文名**+改动角标)」,其余 17 组都是中文。

### P2-17 版本号跳空但界面标题写「只增不删」,不给解释
`/admin/publish` · `publish.tsx:392`(标题)。实测版本列表是 `v12 v11 v10 v8 v7 v6 v5 v4 v3 v2 v1` —— **没有 v9**,而 `versionsTruncated === false`。回源查到真因在 `worker/src/publish.ts:322-330`:并发发布拿不到锁时会把刚建的行删掉(这个决定本身有充分理由,不是缺陷)。但从运营那边看,一个写着「只增不删」的表格里少了一个号,界面没有任何说明,审计里那条 `发布被拒(已有发布进行中)` 也没有和这个号挂钩。

### P2-18 「应用变更」在无改动时禁用,但不说为什么
`/admin/geo` · `geo.tsx:131`。非降级态下按钮禁用(因为 `!dirty`),`title` 为空字符串,旁边也没有任何说明文字。对照发布页在同样情形下会在按钮旁写「无改动可发布」(`publish.tsx:365`)。不变量要求「禁用原因」可见。

---

## 复验通过、不构成缺陷的部分(逐条回归派单交底的 10 项)

| 交底项 | 复验结果 |
|---|---|
| ① 界面文案原样印 markdown 记号 | ✅ 全站未见裸 `**`;发布页强制中止面用的是 `<b>` |
| ② 机器状态词直出 | ✅ 版本状态、公告窗口态、审计动作名主视线都已过映射表(残留见 P1-10 / P2-14) |
| ③ 后端整体不可达时永久骨架屏 | ✅ 断开后出现「后台服务连不上,页面无法加载 [重试]」 |
| ④ `?focus=` 没有消费者 | ❌ **只接了 1/9**,见 P1-1 |
| ⑤ 改动位置显示内部字段路径 | ⚠️ 下载入口/平台数字/产品卡等已译;文案树整族未译(P2-8),校验报错未译(P2-7) |
| ⑥ 发布失败原因门名/构建报错在主视线 | ⚠️ 发布页两处已修;壳顶与驾驶舱另有一族漏网(P1-10);版本表小字仍是截断的原始报错(P2-3) |
| ⑦ 初始化页限流不说等多久、按钮不禁用 | ✅ 实测 429 → 「尝试过多,15 分钟后再试(880s)」+ 按钮禁用,登录页同源同一份 |
| ⑧ 审计空结果只有一句话 | ✅ 现为「「内容」这一类目前没有记录。/ 换个类别或看全部,已发生的动作都会在这里留痕。/ [看全部记录]」;取不到时另有「这一段记录当前取不到,不代表没有发生过」 |
| ⑨ 降级态「应用变更」仍可点 | ✅ 实测 `disabled === true` + 悬停说明 + 顶部红条 |
| ⑩ 手机上审计页整页横滚 | ✅ 表格自己滚(`scrollWidth == clientWidth`);但同族的栅格页未修,见 P1-11 |

其它复验通过项:登录焦点环可见(2px 品牌色 outline)· `autocomplete="current-password"` 正确 · 会话过期 302 带 `?back=` 且登录后精确回跳 `/admin/geo` · 退出有 toast 并回登录页 · `/setup` 已初始化死卡且无重置入口 · 驾驶舱**单卡**查询失败只红该卡并给卡内重试(实测「今日实时 / 按日趋势 / 来源与设备」三卡独立红,其余卡正常)· 驾驶舱空态为 composed 文案且不画 0% 假环比 · 骨架屏在 `prefers-reduced-motion` 下不动 · `.kv` 说明文字对比度 6.17:1、`label` 5.99:1(均过 AA)· 产品卡事实字段改动触发高敏提示、全隐藏被拦、无增删 SKU 按钮 · FAQ ≥3 门槛与回收区可恢复 · 下载入口非 https / 开启空 URL 均拦 + 保存禁用 · SEO 邮箱格式拦截 · 区域屏蔽国家用 select 不手输且 CN/HK/MO/TW 口径有旁注 · 误伤护栏二次确认(勾选框)存在 · 发布确认面板点击后落在视口内 · 回滚按钮只长在真上线过的版本上 · `/admin/no-such-page` 有 404 文案与回航指引 · 全站浏览器控制台零报错(除我人为注入的 4xx/5xx)。
