# App 隐私政策取证与发布检查

日期：2026-09-06。状态：正文已定稿，正式配置已接入；最终机器门及独立运行时验收见交付记录。

## 范围与执行计划

目标：从 App 代码与 v3.7 PRD 生成官网可用政策，检查真实数据类别、用途、权限、共享、保留和联系方式。

基本事实：政策必须描述真实处理；前端发送字段能证明客户端行为，不能证明第三方处理或后台定时删除。三语必须一致，原有生产门不能通过删除标记或空正文绕过。

依赖顺序：代码与 PRD 取证 → 三语草稿 → 独立语义审查并补正 → 主人补充地点并授权制定规则 → 写入现有 seed/config → typecheck、verify、verify:prod、独立黑盒验收。各检查必须针对无 fixture 的正式构建；机器门运行期间不同时派运行时验收。

采用文档短清单，未另建工作流运行器计划或发布系统。官网实现复用 LegalDocument 和 legal.appPrivacy 配置。修改政策文档、官网 seed、物化配置及共用法律标题行高；不修改 App、服务端、PRD、记忆、远端或部署状态。

官网基线：a171bba61bdb4658f979acdfcf088a14cd81f6e8；独立工作树：D:/WORKS/PLAN/.wt/website-app-privacy-20260906，分支 codex/app-privacy-20260906。

App 取证：D:/WORKS/PLAN/Nexion-uniapp，e6ec2277，pkg/bd-storage-degrade-port；与 UniApp 分支核对了相关接口。PRD：D:/WORKS/PLAN/PRD/NexGrid_产品功能架构设计文档_v3.7.md。

## 已核实来源

以下 src 路径均相对 App 仓；PRD 行号以本轮读取快照为准。

| 主题 | 证据 | 能证明的范围 |
| --- | --- | --- |
| 真实 API 模式 | src/api/runtime.ts:68-104；runtime-config.ts:23-44 | 默认真实接口，服务地址配置化；不等于生产已部署 |
| 账号 | src/api/auth-api.ts:6-50,295-409 | 电话、密码、验证码、外部登录请求 |
| 资料与头像 | src/api/profile-api.ts:87-122；src/pages/me/profile.vue:384 | 昵称、语言、上传头像，相机/相册选择 |
| 设备评估 | src/api/onboarding-calibration-api.ts:7-18 | 型号、品牌、内存、核心数、图形、电池、网络等观察值 |
| 安全报告 | src/services/janus-c2.ts:371-443；src/api/janus-api.ts:312-319 | 设备标识、UA、OS、活动计数及异常信号；硬编码 false 字段不证明对应侦测已实现 |
| 使用分析 | src/api/behavior-analytics-api.ts:7-34,112-122；src/services/behavior-analytics.ts:35-37,188-190,223-229 | 页面、停留、点击区域及相对坐标；路由无 query/hash；不是匿名承诺 |
| Nova | src/api/nova-ai-api.ts:8-12,118-165 | 自有 API 接收消息、语言、会话/轮次标识及返回历史；不证明外部模型方 |
| 人工支持 | src/api/support-api.ts:149-166 | 工单与聊天字段及状态 |
| 团队展示 | src/api/team-network-api.ts:6,30-35 | 成员资料在团队功能展示，不能推成向整个互联网公开 |
| 可选申请 | src/api/developer-access-api.ts:10；ambassador-application-api.ts:40-42 | 公司/邮箱/用途；活动城市/日期/预算/类型 |
| 图片保存与复制 | src/components/team/share-poster-sheet.vue:517；src/pages/me/proof.vue:548-549；src/lib/share.ts:113 | 主动保存图片及写剪贴板 |
| 注销 | src/api/account-api.ts:166-183；src/pages/me/security.vue:648-655 | 发起/查询申请及退出登录，不证明物理清理 |
| 保留 | PRD:622；src/i18n/messages/zh.ts:2820-2823 | PRD 规定完成后 1 个月；现文案保留财务/安全例外，实际期限与执行未证 |
| 成年定位 | PRD:863；src/i18n/messages/en.ts:169 | 面向 18 岁以上，不证明年龄核验已实现 |
| 联系 | PRD:4424；src/i18n/messages/zh.ts:1025 | 有 compliance@nexgrid.ai 字符串；主人本轮指定暂用作占位，未验证收件 |

## 主人确认与本轮制定规则

主人确认外部服务商和数据所在地为美国，并授权其余内容参考资料或通用惯例编写。邮箱按主人指令暂用 compliance@nexgrid.ai；未验证收件，不再重复请求批准。

| 规则 | 依据与性质 |
| --- | --- |
| 美国存储和处理 | 主人本轮直接确认；未编造具体服务商名称，按托管/认证/消息/支付/AI功能类别披露 |
| 注销完成后1自然月 | v3.7 PRD:622；不是把一个月改成30天 |
| 普通日志90天 | 本轮制定的用途最小化政策，非官方统一期限 |
| 客服/Nova最后互动后12个月 | 本轮制定，未关闭工单同样起算；较早的有效删除期限优先 |
| 活动系统删除后备份最多再90天 | 本轮制定，备份不得日常使用，恢复后先重新应用删除 |
| 财务/事件例外 | 限特定记录、法定期限或有记录的未结事项；至少年度复核；不延长无关资料 |
| 有适用依据的五年记录 | 31 CFR 1010.430(d)适用于该章要求保留的记录，不是全部账号字段一律五年 |
| 30天答复目标 | 本轮制定的服务目标，不是保证30天完成一切注销；依法延期须说明 |
| 不出售/不用于跨场景广告/不授权服务商训练通用AI | 本轮制定的处理限制；不是已审计所有提供方合同或执行环境 |

正文不含等待法务、上线前待确认或开发解释文字。安全、权利办理、删除期限和供应商限制均是主人授权制定的运营规则，不冒充已验证的服务端功能。新增规则的执行属于App服务端与运营；本任务交付官网政策和官网生产检查，不以文案证明后端定时清理已经执行。

## 官方参考

- FTC：https://www.ftc.gov/business-guidance/resources/protecting-personal-information-guide-business — 按必要用途保留、书面说明期限和销毁、限制访问。该指南没有提供本稿90天/12月的统一期限。
- eCFR：https://www.ecfr.gov/current/title-31/subtitle-B/chapter-X/part-1010/subpart-D/section-1010.430 — (d)对该章要求保留的记录规定五年。
- Apple：https://developer.apple.com/app-store/review/guidelines/#privacy — 数据类别、用途、共享、保留、撤回和删除说明。
- Google：https://support.google.com/googleplay/android-developer/answer/10144311 — 实体、联系方式、处理与保留删除政策。
- Google：https://support.google.com/googleplay/android-developer/answer/13327111 — App外删除请求路径；正文已明确无需进入App即可通过邮箱提出请求，收件能力未验证。

这些来源用于制定原则和检查完整性，不作为已核查全部适用法域或运营执行的声明。

## 独立审查与修补

privacy_evidence只读取证并审查三语。最终政策轮发现并修补：三语提前删除的强制程度不同；未关闭工单没有期限起点。现在普通记录统一执行分类期限与有效删除期限中较早者，未关闭工单从最后互动起最多12个月，调查保留须进入受限定且需年度复核的例外。

运行时render-fit先后检出320px越文第8、第4节标题行间碰字。首次缩短新标题不足以解决同族问题，最终修复LegalDocument的共用h2–h6行高1.1→1.5，容纳越文字形；未调整字号、配色或门判据。现有构造性render-fit门直接覆盖这些真实三语内容，作为回归哨兵，避免另建重复检查。

## 接入与验收边界

正文落在 worker/seed/site-config.seed.json 的 legal.appPrivacy.md 三语，复用 schema/src/materialize.ts 生成 src/config/site.json。contactEmail同步写入上述两份配置；gate-equivalence检查通过。docs中的三语Markdown为本次交付快照，未来正文维护入口仍是后台legal.appPrivacy，不另建第二发布系统。

原空配置的PENDING-TRUST-ASSETS fallback保护保留；有完整配置时使用现有LegalDocument。没有删门、改门或放宽规则。生产模式的检查必须对本次正式配置运行，不能使用上一轮fixture的结果。

已初始化的后台数据库live/draft不会因种子变化自动改变，本轮不宣称已推送配置到该数据库或公网。原生Android manifest含额外声明权限、iOS/SDK发布包未核实；本轮政策描述已取证的功能访问，不声称发布包权限审计完成。邮箱是主人允许的占位。

done-review六维：正式配置与产物逐字节核对并刷新验证；以取证清单检查完整性；测试邮箱与政策链接但不发送邮件；覆盖三语法律页；检查三语期限与规则一致；运行完整生产门后冻结产物交独立tester。服务端删除执行、原生发布包、真实邮件收件及公网部署不纳入已验证项。
