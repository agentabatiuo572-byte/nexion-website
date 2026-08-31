# 包⑦ 区域屏蔽(T15/T16/T17)独立验收报告

- **验收人**:独立 tester(未参与实现)
- **日期**:2026-08-31
- **被测代码基线**:`fdfd9b2`(A–G 全部取证于此提交,逐项校验见「环境事故」节)
- **规格来源**:`PRD/NexGrid_官网后台PRD_v1.0.md` [FEAT-CON12] 全部;`docs/changes/2026-08-31-website-admin.plan.md` T15/T16/T17 节
- **环境**:`worker` 目录 `wrangler dev`,D1/KV 本地模拟;站产物 `npm run build` + `npm run build:console` 全绿
- **实测端口**:**8799**(隔离环境,非派单原定的 8798——原因见「环境事故」节)

## 一、逐 AC 结论

| AC | 项 | 结论 |
|---|---|---|
| A | 初始态未配置不拦 | **PASS** |
| B | 启用与拦截(451/双语/noindex/资产无体) | **PASS** |
| C | 自锁保护(/admin、/api 恒不拦) | **PASS** |
| D | 直通签发 / 兑换 / 伪造拒绝 / 不计统计 | **PASS** |
| E | 规则面板(select 不手输/chips/理由≥8/文案生效/回读态) | **PASS** |
| F | 误伤护栏(≥5% 流量国二次确认) | **PASS** |
| G | 统计(今日实时增长 / TopN 排序) | **PASS** |
| H | 收尾还原(关闭后 CN 恢复 200) | **结果作废,未取得 HEAD 口径判定** |
| 附 | E4 生产恒忽略 `x-geo-sim`(双向 + 正对照) | **PASS**(超出派单 AC,主动补测) |

> AC-H 说明见第四节。它**实际被执行过且当时表现正常**,但执行时工作树上的 `geo.ts` 已被主控在途改写,与 A–G 的取证基线不是同一份代码,故按冻结纪律**不采信为 HEAD 结论**。

## 二、逐项证据

### A 初始态(未配置规则 → 不拦)

KV 无 `geo:rules`(`initialized:false` 的全新持久化目录),`INITIAL = {enabled:false, countries:['CN']}`:

```
/      sim=CN  -> 200 (len 56984)      /      sim=VN -> 200
/zh/   sim=CN  -> 200 (len 51505)      /learn/ sim=CN -> 200 (len 17378)
/      无 sim 头 -> 200
/_astro/x.css sim=CN -> 404            ← 落到静态层 404,证明未被中间件接管
```

「未启用即不拦」成立;资产 404 而非 451,说明中间件确实放行而非静默吞掉。

### B 启用与拦截

经**控制台 UI**(非直接打 API)开总开关 → 名单 `[CN]` → 理由「合规要求,上线前开启中国大陆屏蔽」→ 应用。

拦截页(`/` + `x-geo-sim: CN` + `accept: text/html`)→ **451**,`content-type: text/html; charset=UTF-8`,body 813 B:

- `<meta name="robots" content="noindex">` ✓
- zh 标题「服务在您所在的地区不可用」+ zh 正文 ✓
- en 标题「Service unavailable in your region」+ en 正文 ✓
- **外部 `src=` / `href=` 引用数 = 0**,样式全部内联 `<style>` ✓(CON12-A1「不引站内资源」)

对照与横扫:

```
VN 模拟 /            -> 200 (56984)
CN 模拟 /zh/         -> 451  /vi/ -> 451  /learn/ -> 451  /nex/ -> 451
        /legal/privacy/ -> 451           /does-not-exist/ -> 451
VN 对照 /zh/ 200 · /vi/ 200 · /learn/ 200
```

资产面(CN 模拟):

```
/_astro/a.css  accept:text/css        -> 451  body 0 B  content-type: null
/_astro/a.js   accept:*/*             -> 451  body 0 B
/favicon.svg   accept:image/svg+xml   -> 451  body 0 B
/              accept:text/css        -> 451  body 0 B   ← 同一路径,按 accept 判文档/资产
```

**451 且零字节体**,判据是 `accept` 含 `text/html` 与否,不是路径后缀——同一个 `/` 用 `text/css` 请求也只拿到空体 451。

### C 自锁保护(核心:不会把自己关在门外)

全部带 `x-geo-sim: CN`,总开关开启、名单含 CN 的状态下:

```
/admin/           -> 200 (控制台 SPA 外壳)
/admin            -> 302 (→ /admin/,是既定重定向不是拦截)
/admin/geo        -> 200
/admin/login      -> 200
/api/health       -> 200 {"ok":true,...}
/api/geo          -> 200 (规则 JSON 正常返回)
/api/me           -> 200 {"ok":true,"actor":"admin"}
/api/auth/state   -> 200 {"initialized":true}
/admin/assets/index-BFTZMGCm.js -> 200 (339 724 B,控制台 JS 完整可取)
```

控制台页面、控制台静态资源、健康检查、全部 API 面在被屏蔽地区均可达。

### D 直通

**签发链走真实 UI**:控制台点「获取直通」→ `window.open` 新标签 → `/api/bypass?t=…` → set-cookie → 302 回 `/`。

```
新标签落地 URL : http://127.0.0.1:8799/     (兑换后重定向到站首页)
面板 toast     : 已在新标签兑换 30 天直通并打开官网(…;直通访问不计统计)
gx_bypass      : httpOnly=true  secure=true  path=/  有效期 30.0 天
令牌 TTL       : /api/geo/bypass-token → {"expiresInSec":300}   ← 5 分钟,合规格
```

放行与计数:

```
直通 cookie + x-geo-sim: CN  → /      200(非拦截页,66 163 B 真实首页)
                              /zh/   200      /learn/ 200
统计 todayLive:  访问前 7 → 访问后 7   ← 直通请求一次都没进统计
```

伪造 / 篡改 / 过期一律拒绝(仍 451 且落统计):

```
gx_bypass=9999999999999.deadbeef                    -> 451   (派单指定的伪造串)
gx_bypass=<未来 exp>.aaaa…                          -> 451
gx_bypass=1.ffff…                                   -> 451   (exp 已过期)
gx_bypass=<真令牌末字节篡改>                          -> 451   (签名不匹配)
gx_bypass=notatoken                                 -> 451   (格式非法)
gx_bypass=<真令牌>                                   -> 200   ← 正对照
统计 todayLive: 7 → 12,增量恰为 5 = 上述 5 次伪造被拦
```

兑换端点本身也 fail-closed:

```
/api/bypass(无 t) / ?t= / ?t=notatoken / ?t=9999999999999.deadbeef / ?t=1.ffff…
  → 全部 403 "bypass token invalid or expired",且 Set-Cookie 为空数组(不发任何 cookie)
```

### E 规则面板

| 判据 | 实测 |
|---|---|
| 国家只能下拉选 | 名单卡内**自由文本输入框 = 0**,`<select>` = 1,选项 **249** 条(ISO alpha-2 全集) |
| chips 可移除 | 加 VN → chips `["CN 中国大陆✕","VN 越南✕"]` → 点 ✕ → `["CN 中国大陆✕"]` |
| 理由 <8 字被拒 | UI 弹 toast「理由至少 8 字」,确认框不关闭,pill 保持「改动未应用」 |
| 「已生效」须回读后显示 | 改动后 pill = **改动未应用**;应用成功后 pill = **已生效 · 21:03:48 回读确认**(带回读时刻) |
| 拦截页文案真实生效 | 改 zh/en 正文 → 应用 → 重新访问拦截页:新 zh 文案 ✓、新 en 文案 ✓、**旧文案已消失** ✓ |

服务端硬校验(绕过 UI 直打 API,防「只有前端拦」):

```
reason="短" / "1234567" / 8 个空格   → 400 {"error":"reason-required(≥8 字)"}
countries=["cn"] / ["CHINA"] / ["<script>"] → 400 {"error":"bad-country-code"}
复验规则未被这些非法请求改动:enabled=true countries=["CN"] ✓
```

理由与国家码在**服务端**同样是硬门,不是纯前端装饰。

### F 误伤护栏

造数(派单指定语句):`daily_traffic` 插入昨日 VN pv=90(近 7 天 VN 占比 100%)。

```
面板加 VN → 应用(理由「验收测试:新增越南验证误伤护栏」)
  → 服务端 409 need-confirm-high-traffic
  → 护栏条:「⚠ 误伤护栏:VN 越南 占近 7 天流量 100.0%——这是主要市场流量。」
  → 勾选项:「我知道这会拦截主要市场流量」
未勾选时「仍然应用」按钮 disabled = true
未勾选时服务端规则 countries = ["CN"]        ← 没有被偷偷写入,409 是真拒绝不是假弹窗
勾选后按钮 disabled = false → 应用 → 「已写入并回读确认」,pill「已生效 · 回读确认」
生效复验:VN 模拟 / → 451 ✓
还原:移除 VN → 应用 → VN 模拟 / → 200 ✓,CN 模拟 / → 451(仍拦)✓
```

关键点:**409 时规则确实没落盘**——护栏是真闸门,不是先写后问。

### G 统计

```
今日拦截(实时)  12 → 打 4 次 CN 页面请求(/、/zh/、/learn/、/vi/)→ 16   (+4,精确)
近 7 天拦截      195,占总请求 68.4%(口径:拦截数 ÷ 拦截+人类访问)
被拦区域 TopN    ["CN 中国大陆 150", "RU 俄罗斯 45"]
```

TopN 造数为 `daily_blocked`:CN 昨日 120 + 前日 30、RU 前日 45。面板显示 CN **150**(跨日正确求和)、RU 45,**降序正确**。占比 195/(195+90)=68.4% 与 `daily_traffic` pv=90 吻合,说明两张表都真读到了。

### 附加:E4 生产环境恒忽略 `x-geo-sim`(派单 AC 外,主动补测)

这条是 CON12-E4 的 🔴 安全不变量,且是**唯一能让外人自行绕过屏蔽的方向**,故补测。

单测 `geo.spec.ts` 里那条 E4 用例只断言 `expect(res.status).not.toBe(451)`,**没有正对照**——中间件在生产整个失效(永远放行)也会让它变绿。故改用运行时双向 + 正对照测法:

先测出本地 `wrangler dev` 的真实 `request.cf.country` = **JP**(经 `/api/e` 打点后回读 `raw_events.payload` 得到),用它当正对照。

```
【dev 基线,名单 = CN,JP】
  无 sim 头(真实 JP)        -> 451     ← 中间件在拦
  x-geo-sim: VN             -> 200     ← dev 下模拟头生效,能逃逸
  x-geo-sim: CN             -> 451

【production,名单 = CN,JP】方向一:试图用模拟头逃逸
  无 sim 头(真实 JP)        -> 451     ← 正对照:生产下中间件确实在拦(不是整体失效)
  x-geo-sim: VN             -> 451     ← 逃逸失败 ✓
  x-geo-sim: US             -> 451     ← 逃逸失败 ✓

【production,名单 = 仅 CN,真实国 JP 不在名单】方向二:试图用模拟头强制触发拦截
  无 sim 头(真实 JP)        -> 200
  x-geo-sim: CN             -> 200     ← 强制拦截失败 ✓
```

两个方向都证伪,且有「生产下拦截功能仍活着」的正对照。**PASS**。

### 附加观察(非 AC,不构成 fail)

1. **`page=206B` 之外的一条 API 契约脚印**:`PUT /api/geo` 的 `blockPage` 是可选字段,缺省时**回落内置默认文案**。控制台 UI 永远整份提交所以不可达,但直接打 API 时「只想改名单」会**静默把自定义拦截页文案重置回默认**。建议要么必填,要么缺省时保留现有文案。
2. **TopN 空态文案与规格字面有差**:代码为「屏蔽未启用,暂无数据」,规格 ⑤ 为「屏蔽未启用**过**,暂无数据」。更实质的是语义:规格区分的是「**从未**启用过」,实现判的是「**当前** enabled=false」——曾启用后再关闭时,会显示「未启用」这档文案。属轻微偏差。
3. **初始 pill 措辞**:从未写过 KV 时 pill 即显示「已生效」(无回读时刻后缀)。状态本身没错(生效值确为「关闭」),但「已生效」用在一次都没写过的初始态上略松。AC 要求的「改动后须回读才显示已生效」已满足。

## 三、环境事故(本轮证据的一部分,如实记录)

### 事故一:8798 / `.wrangler-t15` 被两套实例共用,验收中途登录态被打掉

- 派单给我的「专属资源」是 `8798` + `.wrangler-t15`。
- 跑到 AC-D 前后我的登录突然全部 401。回查 `Win32_Process`:**8798 上有 6 个 wrangler 进程 = 2 组独立实例**(每组 `npx-cli → wrangler.js → cli.js` 三进程),命令行都是 `dev --port 8798 --persist-to .wrangler-t15`。
- 数据面佐证:`auth_account.initialized_at = 1788177631291`,比我写入 geo 规则的 `updatedAt = 1788177350976` **晚约 4.7 分钟**——账户在我开跑之后被重新初始化过,我的口令随之失效。
- **处置**:不动共享的 8798(禁杀他路被测服务),另起 **8799 + `.wrangler-t15b`** 全新隔离环境,**A–G 全部从头重跑**,保证结论不含被污染的样本。本报告所有数据均出自 8799。
- 主控裁决:8798 上那组不是安全评审 agent 的(它全程只做静态审查、未起服),归因待主控自查;`8799` + `.wrangler-t15b` 正式归我。

### 事故二:冻结期内被审文件被改写,dev server 热重载崩溃,AC-H 口径失效

时间线(文件 mtime + wrangler 日志实测):

| 时刻 | 事件 |
|---|---|
| 20:43:57 / 20:45:55 | `worker/src/index.ts` / `worker/src/geo.ts` 最后修改(= 我全部 A–G 取证所吃的那份) |
| 21:02–21:08 | 我在 8799 上跑完 A–G + E4 补测 |
| 21:08:54 | 新增 `worker/src/ratelimit.ts` |
| 21:09:00 | 我的 `wrangler dev` 热重载,撞上「`ingest.ts` 已引用、`ratelimit.ts` 未落全」的中间态,workerd 抛 `Uncaught ReferenceError: createLimiter is not defined`,进程 exit 1,8799 掉线 |
| 21:09:01 / 21:09:04 | `worker/src/ingest.ts` / `worker/src/auth.ts` 被改 |
| 21:10 前 | 我重启 8799,**跑 AC-H 前**执行 `git diff --stat HEAD -- worker/src/geo.ts worker/src/index.ts` → **输出为空**(与 HEAD 一致),据此判定可以继续 |
| 21:10:38 | AC-H 执行,当时表现正常(关闭后 CN/VN/JP/US 全部 200,各页面 200,资产 404) |
| 跑完后复验 | 同一条 `git diff --stat` → **`worker/src/geo.ts` 110 插入 / 40 删除**。`geo.ts` 在 AC-H 执行窗口内被改写 |

**如何发现结果已失效**(不是靠 git,是靠数据面自证):AC-H 落下的审计行是
`before_summary = "enabled=true [CN] page=206B"`,而 HEAD 的 `writeAudit` 调用里**根本没有 `page=NNNB` 这个字段**。这条只可能由改写后的 `geo.ts` 产出——证明 AC-H 那次请求走的是新代码,不是我 A–G 的基线。

- **结论**:AC-H **执行过、当时全绿,但不采信**。它与 A–G 不同源,混入会让整份报告口径不一致。
- 主控归因更正:破坏冻结的是**主控自身**(在自己下的冻结令生效期间落安全修复),并已指示我不要在当前工作树上补跑、也不要重跑 A–G,AC-H 留到安全修复提交且机器门全绿后的完整重验轮。

### 在途安全改动(会影响后续重验口径,先记在案)

主控已在工作树上改写 `geo.ts`(未提交),要点:

- **C1 密钥 fail-closed**:`BYPASS_SECRET` 缺失、或非 dev 环境仍用仓库内默认值 `dev-bypass-secret` → 直通链整体停用;令牌另加**有效期上限**校验,伪造者不能自选遥远 exp;签名比较改常数时间 `timingSafeEqualHex`。
- **C2 判据反转**:模拟头从「`!== 'production'` 才允许」改为「环境 ∈ `{dev, preview}` 白名单才允许」——配置漏设/拼错时默认拒绝模拟。
- **M1 / M4 限速**:兑换端点 20 次/分/IP(超限 429);**拦截统计写入 60 条/分/IP**。
- **L1**:拦截页转义补 `"` 与 `'`。

对重验的提醒:**M4 直接改变 AC-G 的语义**——「今日拦截(实时)」在单 IP 高频下会封顶 60/分,不再与真实拦截次数一一对应。我这轮 AC-G 的 +4 精确增长是在 HEAD(无限速)下测得的,重验时该 AC 需换判据。

## 四、AC-H 未决项

- **需要做的**:工作树干净且冻结后,在与 A–G 同一份代码上重跑「面板关总开关 → 理由 → 应用 → CN 模拟恢复 200」。
- **已有的旁证(不能替代 AC-H)**:AC-A 在 `enabled=false` 下实测 CN 模拟 `/`、`/zh/`、`/learn/` 全部 200,即「关闭态 ⇒ 不拦」这一端点行为在 HEAD 上是成立的;AC-H 额外要验的是**「开 → 关」这条状态迁移**本身(含面板确认框目标文案、回读态、边缘缓存失效),这部分未取得 HEAD 口径。
- 建议一并纳入重验的新场景:`BYPASS_SECRET` 未轮换 / 缺失时直通停用;`ENVIRONMENT` 拼错时模拟头默认拒绝;统计限速生效后的 AC-G 新判据。

## 五、收尾

| 项 | 状态 |
|---|---|
| 8799 进程树 | 已树杀,回读 `t15b 进程 = 0`、`8799 监听 = 0` |
| 8798 | 未由我关闭(禁杀他路被测服务);复查时其进程与监听均已自行归零 |
| `.wrangler-t15b` | 已移出仓库到 scratchpad(遵「禁硬删,先 Move」铁律),仓内零残留 |
| `.wrangler-t15` | **保留未动**——非我所建,归属待主控裁决 |
| 浏览器 | Playwright 实例全部 `close()`,复查残留进程 = 0 |
| 仓内写入 | 仅本报告 + `dist` 组装物;`git status` 中 `auth.ts` / `geo.ts` / `ingest.ts` / `ratelimit.ts` 的改动**均非我所为**(主控在途安全修复) |

## 六、主人可自验(3 步)

1. `worker` 目录起服:`npx wrangler d1 migrations apply nexgrid_site --local --persist-to .wrangler-x && npx wrangler dev --port 8799 --persist-to .wrangler-x`,浏览器开 `http://127.0.0.1:8799/admin/setup`(token `dev-setup-token`)初始化并登录。
2. 进「区域屏蔽」页,打开总开关(名单默认已含 CN),填 8 字以上理由,点「应用变更」——应看到「已写入并回读确认」,状态由「改动未应用」变成「已生效 · <时刻> 回读确认」。
3. 命令行 `curl -i -H "x-geo-sim: CN" -H "accept: text/html" http://127.0.0.1:8799/`——应看到 **451** 和中英双语拦截页;把 `CN` 换成 `VN` 应看到 **200**;浏览器里 `/admin/` 始终打得开(自锁保护)。
