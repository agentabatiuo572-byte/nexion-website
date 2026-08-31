# T4 · 站侧 beacon 脚本 —— 独立 tester 黑盒验收报告

- **日期**:2026-08-31 · **验收人**:独立 tester agent(未参与实现)
- **对象**:官网匿名埋点端到端链路(真浏览器 → 内联 beacon → POST /api/e → D1 raw_events)
- **环境**:worktree `D:\WORKS\PLAN\.wt\w-console`;worker `npx wrangler dev --port 8792 --persist-to .wrangler-t4`(与并行验收隔离,8787 未触碰);真浏览器 = Playwright Chromium(借 Nexion-uniapp 依赖),headless,视口 1280×720;查库 = `wrangler d1 execute nexgrid_site --local --persist-to .wrangler-t4`
- **结论:6/6 AC pass;另报 1 条 P1 数据缺口 + 2 条 P2 契约/环境出入 + 4 条观察项**(问题无论大小全部上报,分级仅供参考,裁决归主人/main)

## 逐 AC 结果

| AC | 内容 | 结果 | 关键证据 |
|---|---|---|---|
| AC1 | pv 链路(开页→6s→入库) | ✅ pass(1 条环境性偏差,见 P2-1) | 库行 `{"t":"pv","path":"/","loc":"en","dev":"d","ref":"direct","us":"","um":"","uc":"","country":"JP","bot":1}`;/api/e POST 200 |
| AC2 | 板块曝光 + 同板块同访问去重 | ✅ pass(字面);**devices 板块构造性采不到 → P1-1** | 两轮全页往返滚动 → 11 个板块各**恰 1 条** sec 行,零重复;sectionId 全部 ∈ 12 枚举 |
| AC3 | FAQ 展开 | ✅ pass | 点开第 1 条(open=true 实测)→ 库行 `{"t":"faq","faq":"q1","loc":"en"}` |
| AC4 | CTA 真点(H5 键) | ✅ pass | 重建后真点击 nav「Web App」→ 库行 `{"t":"cta","cta":"h5","sec":"nav-menu","loc":"en","path":"/"}`;现场已恢复(见下节) |
| AC5 | DNT 尊重 | ✅ pass | 页面内 `navigator.doNotTrack==="1"` 实测;全程滚动+离页 /api/e 请求数 **0**;清库后终查 **0 行** |
| AC6 | 体积与覆盖门 | ✅ pass | `npm run gate:beacon` **exit 0**:gzip **1421B** ≤2048B;37 页每页恰 1 份内联脚本 |

## 证据摘录(按时序)

**AC1+2+3(单会话:开页 6.5s → 滚到底 → 回顶再滚到底 → 点 FAQ,每步等批量周期)**
- 网络:`/api/e` 共 3 次 POST 全 200;console 错误 0。
- 库(清库后 13 行):id1 pv;id2-12 sec ×11(download/stats/social/mission/how/path/trust/nex/learn-entry/faq/final-cta,**各恰 1 条**——两轮曝光只记首个,去重实证);id13 faq q1。
- pv 契约字段齐:loc/dev/ref/us/um/uc + server 注入 country/bot/uid(uid=16hex,当日盐哈希)。

**补充探针(超出 AC 的链路旁证,单独会话)**
- `err`:页面内真 `throw` → 库行 `{"t":"err","h":"527b63a2","path":"/"}` ✅
- `vit` + pagehide 冲刷:导航离页(/ → /learn/getting-started/)→ vit 行 `{"lcp":1496,"cls":0}` 经 sendBeacon 送达 ✅;learn 页自身 pv 行(path=/learn/getting-started/)入库 ✅
- 新 pageload 重新曝光 download 板块 → 新 sec 行(去重作用域=单次访问,跨访问重记,符合契约)✅

**AC5(清库 → addInitScript 注 DNT → 开页+滚全页+等 8s+导航离页)**
- 页面内 doNotTrack="1" → `/api/e` 网络请求 0 次(含 pagehide 时点)→ 库 COUNT(*)=0。

**AC6**:`gate:beacon` 输出「✓ gzip=1421B(上限 2048B)/ ✓ 全站 37 页每页恰 1 份」,exit 0。

## AC4 现场恢复证明(重建→测→恢复→复验一气呵成)

1. `PUBLIC_H5_URL=https://app.example.com npm run build` → dist 出现 `<a class="h5 …" href="https://app.example.com" target="_blank">`(运行中 worker 热读新 dist,curl 复核 2 处命中)。
2. 真点击 → popup 弹出;原页 5s 批冲刷 → cta=h5 入库(上表)。
3. **恢复**:站仓根 `npm run build`(无环境变量)→ dist 中 `app.example.com` **0 处**、`class="h5"` **0 处**。
4. **复验**:worker `node test-static.mjs` → `PASS test-static(36 路由)` 字节级 36/36 一致,**exit 0**;`gate:beacon` 复跑同值(1421B/37 页)exit 0。
5. 仓面:`git status --porcelain` 0 行(除本报告外零写入;dist/.wrangler 为构建/缓存产物,dist 在 .gitignore)。

## 问题上报(全量,不遗漏不合并)

### P1-1 · `devices` 板块曝光构造性采集不到(数据永久缺口)
- **事实** [COMPUTED]:`#devices`(设备叠卡编舞区)offsetHeight=**5688px**,视口 720px → IntersectionObserver `threshold:0.5` 要求「目标自身 50% 可见」,最大可达交叉比 **0.13**;2560×1440 大屏也仅 0.25。桌面端**任何**视口都永不触发。两轮全页滚动实测 12 板块唯它无 sec 行。
- **影响**:§5.2 sectionId 12 枚举 + CON15-⑦「板块 id 集合=官网 PRD §2.3 12 板块」中,daily_section 的 devices 恒 0——驾驶舱该板块数据为结构性假 0,非「如实缺口」。
- **修法方向** [INFERRED,供实现方参考]:超高板块加备选判据(如 intersectionRect 高 ≥50% 视口 即视为曝光),或对 devices 观察其内部代表元素。裁决归实现方/主人。

### P2-1 · 「本地 country=XX」预设不成立(环境性,非代码缺陷)
- **事实** [COMPUTED]:全部入库行 country=**JP** 而非 AC 括号预期的 XX。已隔离浏览器因素:curl 不带任何头直打 /api/e 同得 JP → 来源是 wrangler dev 本地运行时注入的真实 `request.cf`(拉取本机出口的边缘数据)。
- **判定**:代码兜底链 `cf?.country ?? cf-ipcountry ?? 'XX'` 存在且序正确,但 XX 分支在本地环境**不可达**(未获运行时验证);country 字段本身有值、随 cf 走生产同路径。AC 字面的括号预设在该环境为伪,不扣实现分。

### P2-2 · `learn` 事件类型不存在于原始事件契约(有意设计,文档字面不符)
- **事实** [COMPUTED]:PRD §5.2 原始事件表列 learn(slug/locale/uid);实现中 `src/scripts/metrics.ts` 与 `worker/src/events.ts` 均无 learn 事件;`worker/src/rollup.ts` 头注明示「learn 阅读由 pv 路径派生(/learn/<slug>,三语前缀通吃)——§5.2 的 learn 行以此落地」,汇总面 daily_learn 语义保留。learn 页 pv 实测入库(path=/learn/getting-started/),派生原料在。
- **判定**:非 T4 功能缺陷;但 §5.2「原始事件表七类」与 plan T4-AC1「七类」字面失真(线上实际六类)。建议走 PRD 同步把 learn 行标注「派生自 pv,不走 beacon」,归主人裁决。

### 观察项(OBS,无需动作或归后续任务)
- **OBS-1**:headless 真浏览器 UA 含 Headless → 命中服务端 BOT_RE,本验收全部行 **bot=1**(curl 同)。入库不拦符合设计(bot 分流在 T6 汇总);**T6 验收若复用真浏览器验 pv/uv 口径,需自定义 UA**,否则数据全进 bot 桶。
- **OBS-2**:`vit` 仅在 pagehide/visibilitychange-hidden 冲刷,`browser.close()` 不触发——首会话无 vit 行,导航离页即达。契约如此(「首次可交互后一次」),非缺陷。
- **OBS-3**:cta 事件实发字段多带 `path`(§5.2 cta 行未列;zod 契约有,低敏路径串,无隐私面问题)——契约表与实现的字段清单一处小出入,可随 P2-2 一并同步。
- **OBS-4**:`test-static.mjs` 的 Node DEP0190 弃用告警复现——T3 报告已记档的既有 P2,非 T4 新增。

## 收尾与冻结遵守

- 自起进程全灭:8792/8788 端口回读 **0 listener**,workerd 残留 **0**(wrangler CLI 母进程会自动重启被杀的 workerd 子进程——须杀根 PID 整树,已按命令行核对归属后执行;8787 全程未触碰,期间它本就 0 监听)。
- `.wrangler-t4` 隔离缓存目录已整删;并行验收的 `.wrangler-t5t6` 未动(由对方会话自清)。
- 临时脚本 4 份全在 scratchpad,未入仓;仓内写入仅本报告。

## P1 复测(2026-08-31,同日追加)

**背景**:P1-1(devices 超高板块曝光判据构造性不可达)由实现方修复——`metrics.ts` 曝光判据改为双判据 `intersectionRatio ≥ 0.5 || intersectionRect.height ≥ innerHeight/2` + 细阈值梯度(0~0.5 步进 0.05),`unobserve` 首触即停保去重;站产物已重建(dist 三语页 grep `intersectionRect` 均恰 1 处,served 页 curl 复核同)。

**复测配方**(同原环境):8792 + `--persist-to .wrangler-t4` 全新库(migrations apply 后清 raw_events),Playwright Chromium headless 1280×720,真滚轮穿过设备叠卡钉屏区,**两轮全页往返**(去重探针),等 6.5s 批冲刷后查库。

**结果:3/3 断言全过 → P1-1 关闭** [COMPUTED]

| 断言 | 结果 | 证据 |
|---|---|---|
| ① sec=devices 出现 | ✅ | 库行 id=6 `{"t":"sec","sec":"devices","path":"/"}`(文档序落在 mission 与 how 之间,与滚动时序一致) |
| ② 每板块至多 1 条(修复未引入重复计数) | ✅ | 两轮往返滚动后 `GROUP BY sec`:**12 板块每板块恰 n=1**,零重复 |
| ③ 其余板块无回归 | ✅ | 12/12 全集齐(上轮缺 devices 的 11 个全部仍在);库总量 = 1 pv + 12 sec,无杂行;/api/e 2×POST 200,pageerror 0 |

**复测收尾**:wrangler 根进程整树杀净,8792/8788 回读 0 listener、workerd 0,`.wrangler-t4` 已删;仓内写入仍仅本报告。
