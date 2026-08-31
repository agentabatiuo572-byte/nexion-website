## P0
无

## P1
1. **B 溢出对区块级 overflow:hidden 内被裁失明**(`legit()` 把祖先任一 hidden/clip/auto 都算设计裁切;六区块全带 hidden)。变异③两次 8/8 绿;R45 实录「mission 说明段 ≤480 被裁 50–140px」即此形态。建议 hidden/clip 不豁免。
2. **forbidden-words 覆盖窄**:12 条收益表述探针仅 3 命中,漏「12% monthly returns / up to 15% per year / 12% ROI / 0.5 USDT every day / lợi nhuận đảm bảo / 年化收益 12% / zero risk / guarantee your income / APY of 12%」。主人红线全靠此门。
3. **`.verify-exit.code` 在 import 期崩溃时留上次的绿**:置 2 写在 `import gate-canvas-unit` 之后,ESM import 先执行;⑦d 门模块语法错 → exit 1、文件仍 0。建议 `await import()`。
4. **visual-diff 静默丢配对 + 无 top 指标**:仅 A 有的键直接跳过;删整块 StatsBar(23 键消失)只表现为 `SPAN|idx` 串位噪声,不指名。

## P2
1. 几何门每跑留一个 preview 进程:agent 环境 astro 自动后台化,`child.kill()` 只杀壳(原仓现有 4399+63693 两个);人类终端 shell:true 杀不到 node 子进程。建议按 lock pid 杀。
2. 人类终端(无 CLAUDECODE)且已有守护进程:launcher 报文无 `already running at`,sniff 失配 → 31s 后 NOT-RUN「预览服务未能起来」误导。
3. 门崩溃原因被丢(verify 只读 stdout):⑦b 红叉 detail 仅「[geo] 构建产物…」。
4. ④ 去 gutter + 内联脚本后 8/8 仍绿 ×2:门只量 load 终态,fx.ts setVw 抹平首帧 15px 跳变;「首帧即终态」无门守。
5. 环境:`node node_modules/astro/bin/astro.mjs build` 直调产物无任何 CSS(exit 0 静默),npm/npx 正常,原因未定位;门链走 npm 不受影响。
6. 审计冻结 hook 按相对路径后缀误拦副本写入,已加 ALLOW-AUDIT-EDIT 留痕,原仓零写入;u5b 06:36 robocopy 触碰副本,树与原仓全等,结论未受影响。
7. 派单前提:`gate-canvas-hazard.mjs` 不存在,该门在 `gate-canvas-unit.mjs`。

## 变异结果表
| 用例 | 期望 | 实际 | 判定 |
|---|---|---|---|
| ① 删 `.x-canvas{margin-inline:auto}` | A @1920/2560 红 | 33 路由 @2560 未居中 + B 越界;@1920 无(经典滚动条下画布=可用宽) | PASS |
| ② `.state{width:100vw}` | hazard 红 | 红,指名 MissionSection.astro:84;几何门绿(被 hidden 裁) | PASS |
| ③ `.mission .state{min-width:600px}` | B 红 | 8/8 绿 ×2 | FAIL→P1-1 |
| ③b How h2 `min-width:600px`(无 hidden 祖先) | B 红 | 红 @390 246px/@1024 65px ×3 | PASS |
| ④ gutter auto + 删内联 | 记录 | 8/8 绿 ×2 | P2-4 |
| ⑤ 删 vi `nav.how` | parity 红 | 红「vi 缺 key: nav.how」 | PASS |
| ⑥ en "Earn 12% APY" | forbidden 红 | 红;12 变体仅 3 命中 | PASS→P1-2 |
| ⑦a 门中途 exit(1) | 文件≠0 | ✗ 7/8,文件 2 | PASS |
| ⑦b 加载页面时杀预览 | 文件≠0 | ✗ 文件 2;无原因 | PASS→P2-3 |
| ⑦c 构建中杀 verify | 文件≠0 | 文件 2,无孤儿 | PASS |
| ⑦d 门模块语法错 | 文件≠0 | exit 1,文件仍 0 | FAIL→P1-3 |
| ⑧a 同产物 snap×2 | 0 | 0/4843 ×2 | PASS |
| ⑧b How h2 `padding-top:40px` | 指名 | `H2\|lr-ready\|Idle devices…` 高 56→96 ×3 语言+祖先 | PASS |
| ⑧c 删 `<StatsBar>` | 指名消失块 | 23 键静默丢,只报 idx 串位 | FAIL→P1-4 |
| ⑨a 人类终端+守护在 | — | 31s NOT-RUN | P2-2 |
| ⑨b 人类终端+无守护 | 绿无残留 | 绿;残留 preview 65069 | P2-1 |
| 无 CSS 产物跑几何门 | 红 | exit 2,400 条 | PASS |

环境:隔离副本 au5-copy,预览 4398/随机端口;原仓与 4399 未动;副本预览进程已停。
