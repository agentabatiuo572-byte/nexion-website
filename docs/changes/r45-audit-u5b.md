## P0
无

## P1
1. **B 溢出在 `overflow:hidden` 区块内全盲**:用例③ `.mission .state{min-width:600px}` 在 390 裁掉标题,verify 仍 8/8 绿;同变异放无裁切祖先的 HowSection h2 立刻红(越界 246px)。根因 `legit()` 把任何祖先 hidden/clip/auto/scroll 当设计裁切,只排除 `.x-frame`;Hero/Mission/Devices/Social/Footer/LearnList 六个区块根都带 overflow:hidden——R45 台账「≤480 说明段被裁 50–140px」正是此型。修法:section 级 hidden 不算合法,只认内层小容器。
2. **主人终端跑 verify 必 NOT-RUN(锁存在时)**:原仓 `.astro/preview.json` 指向 4399(pid 3612 常驻)。非 agent 环境(`env -u CLAUDECODE` 实测)astro 抛「already running.\n URL: …」,嗅探正则要 `already running at http…`→不匹配→31s→exit 3→红;agent 下 Astro 7 自动走 `--background` 分支恰好匹配→绿。同一命令两种环境结论相反。修法:兼认 `URL:\s+(http\S+)` 或起门前读锁 `--reuse`。

## P2
3. verify.mjs 过滤掉 `[geo] ✓` 证据行:输出只剩「— clean」,看不出 33 路由×5 宽 / 样本 37 / 经典滚动条。
4. 门崩溃无原因:⑦b 后 detail 只有「构建产物…」——报错走 stderr,verify 只读 stdout。
5. forbidden-words 只抓 `%` 紧跟 returns/yields/APY/APR:「Earn up to 12% monthly income.」8/8 绿。
6. visual-diff 缺页/缺键静默跳过(`if(!y) continue`):缺的宽打印「配对 0 … 0 个」且 exit 0;被删元素只经父容器现形,自身不指名。
7. visual-diff 仍按默认隐藏滚动条量,与 R45 几何门(经典滚动条)不是同一可用宽。
8. 门起的预览是分离守护进程(Astro 7 识别 agent 自动 `--background`),`child.kill()` 只杀启动器,每仓根留常驻 preview+锁(副本 57114→57164)。

## 变异结果表
| 用例 | 期望 | 实际 | 判定 |
|---|---|---|---|
| ⑨ 对照 | 8/8 | 8/8,exit 0,文件 0,13s;33 路由×5 宽+断点{768,860,900,1080,1439},样本 37,经典滚动条 | 通过 |
| ① 去 `.x-canvas` margin auto | A 未居中 | 2560 全 33 路由「左 0 应 312.5」+B 越界 312.5;1920 不报(画布=可用宽,判据恒真) | 红 ✓ |
| ② HowSection `width:100vw` | hazard 红 | 指名 HowSection.astro:181;几何 B 同红(@1920 越界 615px) | 红 ✓ |
| ③ `.mission .state{min-width:600px}` | B 红 | 8/8 绿(P1-1) | **未红 ✗** |
| ③b 同变异放 HowSection h2 | B 红 | @390 越界 246px、@1024 65px | 红 ✓ |
| ④ gutter auto+删内联设槽 | 记录 | 8/8 绿:fx.ts `setVw` 正文后重量;门只量稳态 | 绿(兜底) |
| ④b 再删 fx.ts setVw | A 红 | 333 条:画布 1440≠1425 / zoom / 超出可用宽 / NAV 越界 15px | 红 ✓ |
| ⑤ 删 vi.json `mission.title` | parity 红 | 「vi 缺 key」exit 2 文件 2 | 红 ✓ |
| ⑥ en「12% annual returns」 | forbidden 红 | 指名 en.json | 红 ✓ |
| ⑥b「12% monthly income」 | 探针 | 8/8 绿 | 漏(P2-5) |
| ⑦a 门后 `process.exit(1)`(预置 0) | 非 0 | exit 1,文件 2 | ✓ |
| ⑦b +7s 杀预览 | 非 0 | exit 2,文件 2;无原因;chromium 无泄漏 | ✓ |
| ⑦c +5s 杀 verify 本体 | 非 0 | 立即 2,25s 后仍 2 | ✓ |
| ⑦d 非 agent+锁存在 | 探针 | NOT-RUN exit 3,31s | 红(P1-2) |
| ⑧ 同产物 snap×2 | 0 变化 | 6 宽各配对 4096–4843,0 变化 | ✓ |
| ⑧b `.state{padding-top:40px}` | 指名 | H2.state 高 +40(63–109%)列首,exit 1 | ✓ |
| ⑧c 删 FAQ Q6 | 探针 | faq-sec 高 −12% 现形,details 不指名 | 部分(P2-6) |

交底:au5-copy 已被 r45-audit-u5 占用,本审用 `scratchpad/au5b-copy`+自选端口,报告落 u5b 免覆盖;原仓零写入(仅本报告);每例后 `diff -rq` 证 src 复原;只杀了自己的 57164。
