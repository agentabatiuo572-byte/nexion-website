# 官网后台(Site Console)· 实施方案

> nexion-workflow P1.7 落盘拆解(跨会话 SoT)。子任务粒度 ≤1 上下文(≤5 文件 / diff ≤300 行 / 一个 AC 簇);每子任务由独立 tester agent 黑盒验收,pass 才打勾,打勾必填回源三问。

- **配对提案**:`docs/changes/2026-08-31-website-admin-proposal.md`(Aligned 2026-08-31)
- **PRD**:`PLAN/PRD/NexGrid_官网后台PRD_v1.0.md`(spec-lint --strict 16/16 PASS)· 原型 `PLAN/PRD/prototypes/nexgrid-site-console.html`
- **定级**:L · **状态**:**InProgress**(主人 2026-08-31 签字;包① 开工)
- **修订记**:2026-08-31 原始事件存储 AE→D1(90 天滚动清理;行为契约零变化;PRD §2.2/§5.2/O3 同步)
- **北极星**:官网内容与安全控制零码化可配;每次发布强制过站上全部机器门,门红不上线、可回滚;驾驶舱按书面口径呈现真数据(含屏蔽统计),不编造、不冒充。
- **分支纪律**:每包一条 `pkg/w-*` 分支,审计来回留分支,完成合主线;站仓挂点文件(`src/layouts/Base.astro`、`package.json`、`scripts/*` 新增)与 R45 视觉线无交集,可并行。
- **新增目录**:`worker/`(Hono+D1+KV)· `admin/`(Vite React SPA)· `schema/`(zod 单源);站仓现有 13 门一门不动。

## 包① 基建与登录底座(pkg/w-console-core)

### [ ] T1 · monorepo 骨架与本地运行环境
- **范围**:`worker/`(wrangler 配置、Hono 入口、D1 迁移、KV 绑定)`schema/` 占位、站仓 `package.json` 加两条脚本(不引 workspaces,子包自装依赖)
- **AC**:
  - AC1:Given 全新 checkout,When 按 README 三条命令,Then worker 本地起服(wrangler dev)且 D1 迁移建齐表(versions/audit/daily_* 9 表)。
  - AC2:Given vitest 环境,When `npm run test:worker`,Then 冒烟用例绿(含 D1/KV 本地 binding 可用)。
  - AC3:「跑不起来先造环境」:失败态可造——断掉 D1 binding 跑测须真红。
- **测试指令**:`nexgrid-website/` 内 `npm run test:worker`;wrangler dev 端口写入 README(默认 8787)
- **敏感度**:普通 · **tester 报告**: · **回源三问**:

### [ ] T2 · 认证 + 会话 + 审计底座(API 层)
- **AC**(继承 CON01-A1/E1/E2/E3/E4 + CON14-A1/E2):
  - AC1:正确口令 → 7 天滑动会话 cookie(HttpOnly+Secure+Lax),审计 `login.success`。
  - AC2:错误口令 → 通用报错不泄露字段;15 分钟 5 次失败 → 锁 15 分钟,期间正确口令也拒。
  - AC3:会话过期访问受保护 API → 401;/setup 在已初始化后 410。
  - AC4:审计表无修改/删除 API(404);敏感值(哈希/会话)不出现在任何审计行。
- **范围**:`worker/src/auth.ts` `worker/src/audit.ts` + 迁移 + 测试
- **敏感度**:🔴 权限(tester 外加 code-review agent)· **tester 报告**: · **回源三问**:

### [ ] T3 · 静态产物伺服
- **AC**:worker 伺服 `dist/` 与 `astro preview` 对同一构建产物抽样字节一致(≥10 路由);未知路径回站点 404 页;`/api/*` 不被静态层吞。
- **敏感度**:普通 · **tester 报告**: · **回源三问**:

## 包② 埋点采集(pkg/w-beacon)

### [ ] T4 · 站侧 beacon 脚本
- **AC**(继承 CON15-A1/E1/E3):
  - AC1:页面 load 后批量上报(5s/10 事件/pagehide),sendBeacon 降级 fetch keepalive;pv/sec/cta/faq/learn/vit/err 七类字段合 §5.2 契约。
  - AC2:DNT=1 → 零请求;接口 5xx → 站体验零影响零重试风暴。
  - AC3:脚本 gzip ≤2KB(新增体积门脚本断言);站仓 `npm run verify` 13 门全绿(零框架 JS 承诺不破)。
- **范围**:`src/scripts/metrics.ts`、`src/layouts/Base.astro`(一行挂载)、体积门脚本
- **敏感度**:普通 · **tester 报告**: · **回源三问**:

### [ ] T5 · 采集接口(校验+限速)
- **AC**(继承 CON15-E2):畸形包 4xx 丢弃;60 请求/分/IP(突发 120)超限 429;合法事件写原始事件表(断言行数与字段)。
- **敏感度**:普通 · **tester 报告**: · **回源三问**:

### [ ] T6 · 日汇总 cron 与口径单测
- **AC**(继承 CON03-③ 口径字典):合成事件集注入 → `daily_*` 各表数值精确断言:uv 去重(同 uid 多 pv 计 1)、30 分钟会话切分、跨日盐轮换后同人计新访客、Bot UA 排除出流量只入占比、blocked 独立分桶不进 pv/uv。
- **敏感度**:普通(口径对照表逐行测)· **tester 报告**: · **回源三问**:

## 包③ 配置模型与物化(pkg/w-config)

### [ ] T7 · schema 单源与校验器
- **AC**(继承 CON04-③/§5.1/§6-7):SiteConfig zod 全结构;key manifest 从站仓 en.json 生成;校验器(禁用词/占位符守恒/三语 parity/枚举/范围)三消费面同 import;**变异测试:向共享词表加词,控制台校验与站上门同时变红**。
- **敏感度**:🔴(单一真理源)· **tester 报告**: · **回源三问**:

### [ ] T8 · 配置 CRUD + 版本表 + 乐观锁
- **AC**(继承 CON04-A1/E3、CON13-③):草稿保存带 baseRevision,落后 → 409;版本 append-only 每版全量快照;diff 计数 server 派生与壳徽标同源。
- **敏感度**:🔴 状态机 · **tester 报告**: · **回源三问**:

### [ ] T9 · 物化脚本 + 等价性基线
- **AC**(继承 CON16-A1/A2/E1/E2,§6-4):
  - AC1:🔴 **种子配置(未经修改)物化产物与仓内现文件逐字节一致**(i18n 三 JSON + site.json)——迁移零视觉变化的机器判据。
  - AC2:faq/devices.tagline 集合物化正确(增删条目 → key 集合随动且三语 parity 保持)。
  - AC3:API 不可达 → 物化步失败可辨;本地 `npm run dev`/`build` 不联网、用仓内快照,行为与现状零差。
  - AC4:schema 版本漂移 → 拒绝执行并报站码需先部署。
- **敏感度**:🔴(契约核心)· **tester 报告**: · **回源三问**:

## 包④ 控制台壳与登录页(pkg/w-admin-shell)

### [ ] T10 · 登录/初始化页 + 壳 + 状态条
- **AC**(继承 CON01-⑤⑥、CON02 全部):登录 4 态;壳导航高亮当前页;状态条三 chip(线上版本/草稿计数/屏蔽状态)取真 API;API 挂 → 重试态不白屏;上次发布失败 → 红条跳 /publish。
- **敏感度**:普通 · **tester 报告**: · **回源三问**:

## 包⑤ CMS 批 A(pkg/w-cms-a)

### [ ] T11 · 文案树编辑器
- **AC**(继承 CON04-A1/E1/E2/E4):18 组分组三语并排;改 vi 存草稿 → 计数 +1;禁用词命中 → 字段红+词高亮,草稿可存、发布前置校验列红;占位符缺失 → 保存拒绝;缺译黄旗;行级撤销回线上值(确认弹窗);高敏组(trust/legalLine/legal)标识生效。
- **敏感度**:🔴(合规拦截逻辑)· **tester 报告**: · **回源三问**:

### [ ] T12 · 下载入口 + 平台数字
- **AC**(继承 CON05-A1/E1/E2/E3、CON06-A1/E1/E2):URL https 校验;开启空 URL → 发布前置拒绝;探活黄条预警不自动下架;三入口全关站上零死链(E2E 复核站产物);五数字范围校验;锚值 → 软警告文案与 R49-F1 口径一致。
- **敏感度**:🔴 高敏字段 · **tester 报告**: · **回源三问**:

## 包⑥ CMS 批 B(pkg/w-cms-b)

### [ ] T13 · 产品卡 + FAQ
- **AC**(继承 CON07-A1/E1/E2/E3、CON08-A1/E1/E2/E3):SKU 无增删入口(按钮不存在);事实字段改动标高敏+App PRD 提示;全隐藏发布拒绝;FAQ 增删改排+回收区;可见 <3 拒绝;JSON-LD 随物化更新(E2E 查产物)。
- **敏感度**:🔴 高敏字段 · **tester 报告**: · **回源三问**:

### [ ] T14 · 公告条 + SEO 页脚 + Legal
- **AC**(继承 CON09-A1/E1/E2/E3、CON10-A1/E1/E2/E3、CON11-A1/E1/E2/E3):时间倒挂/非法链接拒绝;公告到窗自动隐藏(站侧,产物内验证);sessionStorage 关闭记忆零 cookie;title/desc 长度软警;社媒空链发布拒绝;legalLine 高敏;Legal markdown sanitize 白名单(注入 `<script>` 被剥离并提示);vi/zh 缺文回退 en+enPrevails 行为保持。
- **敏感度**:🔴(sanitize 安全面)· **tester 报告**: · **回源三问**:

## 包⑦ 区域屏蔽(pkg/w-geo)

### [ ] T15 · 拦截中间件 + KV 规则 + 兜底
- **AC**(继承 CON12-A1/E3/E4):名单命中 text/html → 451 内联拦截页,资源与下载一概不给;非名单放行;KV 读失败 → 内置默认名单(CN)兜底(测试:弄坏 KV binding 验证兜底真生效);`x-geo-sim` 仅 dev/preview 生效、生产恒忽略(两向测试);拦截事件仅 text/html 入库。
- **敏感度**:🔴 状态机/安全 · **tester 报告**: · **回源三问**:

### [ ] T16 · 直通机制 + 拦截页
- **AC**(继承 CON12-E1):控制台登录 → 换 5 分钟令牌 → 站域 set 30 天 HMAC cookie → 屏蔽区放行;直通请求不入任何统计;伪造/过期 cookie 不放行;控制台子域路由不经屏蔽中间件(测试断言)。
- **敏感度**:🔴 权限 · **tester 报告**: · **回源三问**:

### [ ] T17 · 规则面板 + 护栏 + 屏蔽统计视图
- **AC**(继承 CON12-A2/E2/⑤⑥):国家 select 枚举不手输;变更确认+理由(≥8 字)→ KV 写入回读确认才显示「已生效」,写失败显示「线上仍为旧规则」;高流量国(≥5% 近 7 天)二次确认展示占比;统计区三卡(趋势/TopN/占比)读 daily_blocked;空态两档文案。
- **敏感度**:🔴 高敏 · **tester 报告**: · **回源三问**:

### [ ] T18 · 站仓集成回归
- **AC**:beacon+伺服+屏蔽合体后站仓 `npm run verify` 13 门全绿;Playwright:模拟 CN 见 451、直通放行、正常区完整渲染 console 0。
- **敏感度**:普通 · **tester 报告**: · **回源三问**:

## 包⑧ 驾驶舱(pkg/w-dash)

### [ ] T19 · 驾驶舱数据 API
- **AC**(继承 CON03-A1/A2/E2):7/30/90 区间聚合查询;分语言转化拆列口径=③ 字典;今日实时预览标注、失败显示「—」不显 0;单卡查询互不拖垮。
- **敏感度**:普通 · **tester 报告**: · **回源三问**:

### [ ] T20 · 驾驶舱 UI(全卡 + 4 态)
- **AC**(继承 CON03-⑤⑥/E1/E3):11 组卡按 PRD 布置;未上线空态文案;下载探活红条跳 /content/downloads;屏蔽卡跳 /geo;骨架加载;单卡失败卡内重试;「点击≠安装」口径说明在场。
- **敏感度**:普通 · **tester 报告**: · **回源三问**:

## 包⑨ 发布流水线(pkg/w-publish)

### [ ] T21 · 发布编排(状态机 + 锁 + 前置校验汇总)
- **AC**(继承 CON13-A1/E1/E3/E4):前置校验红 → 不进流水线并逐项列出+去修复定位;红项自动排除保留草稿;状态机 draft→validating→publishing→live/failed 单向且 server 权威;并发发布 409(锁 TTL 15 分钟超时自动 failed);执行器不在线 → 排队态可取消;**不存在绕门发布 API**(路由审计测试)。
- **敏感度**:🔴 状态机 · **tester 报告**: · **回源三问**:

### [ ] T22 · 本机执行器 + 失败面 + 版本/回滚 UI
- **AC**(继承 CON13-A2/E2):执行器按 §5.4 契约领取任务→物化→verify 全门→build→上新→回报;任一门红 → failed+线上保旧版(实测:注入禁用词发布,站产物未变);失败面=门名+大白话映射+原始日志折叠,映射表覆盖 13 门缺项显门名原文;版本列表 append-only;回滚走完整门链生成新版本(实测回滚后站产物=旧内容)。
- **敏感度**:🔴 状态机 · **tester 报告**: · **回源三问**:

## 包⑩ 安全收口(pkg/w-hardening)

### [ ] T23 · security-reviewer 全面审 + 审计覆盖测试
- **AC**:security-reviewer agent 过 auth/输入校验/SQL 参数化/CSRF/安全头/限速/cookie 属性/直通签名,CRITICAL/HIGH = 0;审计覆盖测试(§6-5):遍历动作字典逐动作触发,审计表逐行有据,缺一红。
- **敏感度**:🔴 安全 · **tester 报告**: · **回源三问**:

## 包⑪ 联调与审计(收官)

### [ ] T24 · E2E 全链套件
- **AC**(§6-3):改文案→发布→站产物真变;禁用词前置拦截;geo 三态;回滚;登录锁定——Playwright 全绿并入 `test:worker:e2e`。
- **敏感度**:普通 · **tester 报告**: · **回源三问**:

## 总回测(全部打勾后才进)
- [ ] 全量机器门:站仓 verify 13 门 + worker 单测 + E2E + 体积门 + 等价性基线,FAIL=0 · NOT-RUN=0
- [ ] nexion-audit 五层(④对抗层 skeptic agent 化)confirmed P0=P1=0
- [ ] 独立端到端走查 agent 报告:
- [ ] done-review 6 维(证据全部来自 agent/机器产出)+ 回测提案 Done-when
- [ ] 临时产物清理(截图/scratch/一次性脚本——主人 2026-08-31 新规矩)

## Phase C · 上线切换清单(依赖主人侧账号,单独排期)
- [ ] Cloudflare 资源开通(Worker/D1/KV/AE/域名 DNS)+ GitHub 仓与 CI 执行器接线(§5.4 契约无感切换)
- [ ] 屏蔽开启 + 模拟 CN 实测 451 + 直通实测放行(CON12 演练三勾)
- [ ] 统计五数字真值确认非锚值(R49-A2/O4)· `verify:prod` 生产门全绿
- [ ] DNS 切换 + 上线后回看(驾驶舱首日数据入库)
