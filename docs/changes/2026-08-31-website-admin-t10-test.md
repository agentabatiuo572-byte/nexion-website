# T10 独立黑盒验收报告 — 登录/初始化/壳/审计页(2026-08-31)

- **验收人**:独立 tester(未参与实现);真浏览器 Playwright(Chromium,借 Nexion-uniapp 依赖)黑盒实测。
- **规格依据**:官网后台 PRD [FEAT-CON01]⑤⑥ · [FEAT-CON02] 全部 · [FEAT-CON14]⑤⑥;plan T10 节。
- **环境**:站仓 `npm run build` → `npm run build:console`(dist/admin 组装 ✓);worker `wrangler d1 migrations apply --local --persist-to .wrangler-t10`(2 迁移 ✓)→ `wrangler dev --port 8795 --persist-to .wrangler-t10`;URL 全走 `http://127.0.0.1:8795`;SETUP_TOKEN=dev-setup-token。专属资源,未触碰 8787/8788 与默认 .wrangler。
- **口径**:全部判定来自运行时真操作(请求监听/download 事件/cookie 枚举/截图),不以代码读到什么为准。

## 总裁决:AC 7 组 → 6 pass · 1 partial-fail(A);细项 46/48 pass

| AC | 判定 | 关键证据 |
|---|---|---|
| A 初始化流 | ⚠️ **partial fail**(5 细项 4 过,1 违:见 P-1) | 短口令→「口令至少 12 位」✓;两次不一致→「两次口令不一致」✓;错 token→403+「初始化令牌不正确」✓;正确提交→跳 /admin/login ✓;**再访 /admin/setup 未见死卡(P-1)** |
| B 登录 4 态 + 🔴 回车裁决 | ✅ pass | **密码框 `keyboard.press('Enter')` 真发 POST /api/auth/login(request 监听捕获,回 401)——争议点裁决:回车提交真实生效**;错口令红字「用户名或口令不正确」✓;连错 5 次均 401(未提前锁),第 6 次**正确口令**→429+「尝试过多,15 分钟后再试(900s)」,倒计时 2.6s 后 900→898 在走、按钮禁用 ✓;正确登录→进壳 ✓ |
| C 壳与状态条 | ✅ pass | chips=`["线上 v1","与线上一致","屏蔽 —"]`;12 个导航项(覆盖 PRD 五组:驾驶舱/内容×8/区域屏蔽/发布/审计)逐个点击:URL 正确+h2 正确+占位页均有内容与规格锚点 `[FEAT-CONxx]`+高亮唯一且指向当前项;驾驶舱占位含真数据卡(线上版本 v1);「去发布」→ /admin/publish ✓ |
| D 401 踢回 | ✅ pass | clearCookies 后直开 /admin/audit → 踢至 `/admin/login?back=/audit`;登录后回跳 /admin/audit 且审计页渲染 ✓ |
| E 审计页 | ✅ pass | 本轮真实流水 auth.setup / login.fail / login.success 全部在列;chip「登录」过滤后仅剩 login.*(实测 3 行,含 fail+success,auth.setup 消失);「导出 CSV」触发 download 事件(`audit-2026-08-31.csv`,267B,表头 `id,time,actor,action,target,before,after,reason`,含数据行)✓ |
| F 深链与 404 | ✅ pass | 直开 /admin/content/faq → FAQ 占位页渲染(SPA 回退)+壳 12 导航在;/admin/no-such → 「页面不存在」且壳仍在;console:**全程 12 条,全部是负路径故意触发的 4xx 网络层日志(403/410/401×9/429),JS/pageerror 为 0**;正路径阶段(C/E/F)console 零条目(逐条清单见下) |
| G 登出 | ✅ pass(复验) | 登录后浏览器持有 nx_sid(64 hex,httpOnly+secure);**登出前同 cookie 直访 /api/audit=200(对照)→ 点退出→回登录页+Toast「已退出」→ 同一旧 cookie 再访 /api/audit=401**——服务端会话真销毁,不只是浏览器删 cookie |

## 问题清单(全部上报,不分级自审)

### P-1 · 已初始化后再访 /admin/setup 仍渲染可填写的初始化表单(AC-A 违项)
- **实测**:初始化成功后重新打开 /admin/setup:渲染的是完整初始化表单(令牌+两个口令框+提交按钮),**非「已初始化」死卡**;挂载后 3 秒内**零** `/api` 请求(无任何初始化状态探针)。死卡只在用户提交一次、吃到 server 410 后才出现(410 时死卡正确:无 input/无按钮/仅「去登录」链接,即无重置入口)。
- **规格对照**:本轮 AC 明文「再访 /admin/setup 见『已初始化』死卡」→ **fail**。PRD CON01-E4 原文「When 携旧 SETUP_TOKEN 访问 /setup,Then 410 页面『已初始化』」——若把「访问」读作 GET,则同违;读作「携 token 提交」则实现符合。两种读法差异留主人/main 裁决,实测事实如上。
- **影响评估**:安全不变量未破——server 对一切 setup 提交回 410,无旁路、无重置面;属 UI/规格层偏差(表单邀请用户填一个永远不会成功的东西)。
- **建议**(非结论):挂载时探一次初始化态(现无状态端点,可挂在既有面上)或提交前置探测;修法由实现方定。

### 观察项(不在本轮 AC,不计分,照报)
1. **状态条第三 chip「屏蔽 —」为占位**,未取真 API(tooltip 自述:规则面板随包⑦交付)。plan T10 的 AC 行写「三 chip 取真 API」;CON12 未交付前无 geo 数据面,属排期内空位还是 T10 欠账,留 main 裁决。
2. CON02-E1(API 挂→重试态不白屏)与 E2(上次发布失败红条→/publish)不在本轮指派 AC 内,**未测**(壳内存在对应分支属代码事实,无运行时结论)。
3. 审计页导出 CSV 仅覆盖「当前已加载范围」(toast 自述),PRD 未明说全量;照实记录。

## 验收方法勘误(透明交底)
- 首轮 G-2 曾报 pass 但**证据无效**:`ctx.cookies(url)` 对 http URL 过滤掉 Secure cookie,拿到空值,空 cookie 也 401——属恒真断言。已按「登出前 200 对照 + 登出后同 cookie 401」重做(需先清限速:停服后对隔离 D1 执行 `DELETE FROM login_throttle` 再重启,属测试夹具复位,未触碰任何产品逻辑),复验 5/5 过,上表 G 组结论以复验为准。

## console error 全程清单(12 条,全为故意负路径的浏览器网络层日志)
A-setup:403(错 token)、410(已初始化提交);B1:401(错口令回车);D:401×3(清 cookie 踢回);B2:401×5(连错五次)+429(锁定)。**非 4xx 网络日志 / JS 错误 / pageerror:0。**

## 收尾核销
- wrangler(8795/.wrangler-t10)进程树按监督树杀净:含 `.wrangler-t10` 命令行的 node 进程 = 0;`netstat` 8795 LISTENING = 0(仅内核 TIME_WAIT 残迹,自清)。
- `worker/.wrangler-t10` 已删除(Test-Path=False)。本 tester 的 Playwright 浏览器随脚本 `browser.close()` 关净(机器上另有 2026-08-27 起的他会话 chromium,非本轮产物,未触碰)。
- 仓内写入:仅本报告 + dist/(构建)+ dist/admin(组装)——均在授权范围;.wrangler-t10 已清。
- 证据文件(会话 scratchpad,不入仓):`t10-test.cjs` / `t10-g-rerun.cjs` / `t10-results.json` / `t10-g-rerun-results.json` / `t10-shots/*.png`(A1 短口令、A5 死卡与再访实况、B 错口令、B 锁定倒计时、C 状态条、C publish、D 踢回、E 审计全表+登录过滤、F 404)/ `audit-2026-08-31.csv`。

## P-1 复测(2026-08-31 修后单点验证)

修法:setup 页开门探公开只读接口 `/api/auth/state`。重走原配方(重建前端产物 → 全新 `.wrangler-t10` 迁移 → 8795),真浏览器单点复测 **6/6 PASS**:

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| R-0 | `/api/auth/state` 公开可读(无 cookie) | ✅ | 200 `{"initialized":false}`(全新库);仅暴露布尔,无敏感面 |
| R-1 | ① 全新库开 /admin/setup → 3s 内渲染可填表单,**不误杀** | ✅ | 表单在、死卡无;探针请求实发 `GET /api/auth/state` |
| R-2 | setup 正确提交 → 跳 /admin/login(回归) | ✅ | — |
| R-3 | ② 已初始化后**零提交**再访 /admin/setup → 3s 内直接死卡「已初始化」 | ✅ | 死卡在、表单无;原「零探针」判据反向成立:挂载即发 `GET /api/auth/state` |
| R-4 | ③ 死卡无重置入口 | ✅ | 0 input / 0 button / 仅「去登录」链接 |
| R-5 | 已初始化后端点形状 | ✅ | 200 `{"initialized":true}`,仍公开只读 |

**结论:P-1 已修实证成立,AC-A 升为全过;本报告首表 A 行的 partial-fail 就此闭环(细项 48+6=54,唯一违项已消)。** 复测收尾同前:进程树 0 残留、8795 LISTENING=0、当日 Playwright chromium=0、`.wrangler-t10` 已删。脚本/结果:scratchpad `t10-p1-retest.cjs` / `t10-p1-retest-results.json` / `t10-shots/P1-retest-*.png`(注:脚本退出期有一条 libuv teardown assertion 噪音,发生于全部判定输出与结果落盘之后,不影响结论)。
