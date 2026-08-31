# T9 独立验收报告 — 数据源反转与等价性基线(FEAT-CON16 / §6-4)

- 日期:2026-08-31 · 验收人:t9-tester(独立,未参与实现)
- 对象:`D:\WORKS\PLAN\.wt\w-console`(HEAD 检出,dist 为既有产物,未重建)
- 结论:**5/5 AC 全 PASS**;附 1 条 P2(self-test 在 CRLF 检出下第一断言空转)+ 3 条观察

## 逐 AC 判定

| AC | 判定 | 实测证据 |
|---|---|---|
| A 等价性门+独立复算 | PASS | ① `npm run gate:equivalence` exit 0,输出含 en/vi/zh 三行「逐字节一致」;② 自写脚本(scratchpad/t9-equiv.mjs,`node --import ./register-ts-ext.mjs` 直调 `schema/src/materialize.ts`)以**盘上种子+盘上清单**(不经 buildSeed 重算,与门通路独立)物化,`materializeI18n(seed,manifest,'vi')` 与 git blob `HEAD:src/i18n/vi.json` **Buffer.equals=true**(15885B);en(12732B)/zh(11918B)同 PASS;`materializeSiteJson(seed)` ≡ blob `src/config/site.json` 亦 true |
| B 自测方向 | PASS | `node --import ./register-ts-ext.mjs gate-equivalence.mjs --self-test` exit 0(2 断言绿)。另独立验证变异真实可测:注入 `copy.en['hero.subtitle']='MUTATED-BY-T9'` → 物化输出含标记且 ≠ LF 基线;`stats.activeDevices=99999` → site.json 物化 ≠ 基线。主门(LF 归一)判据在两类变异下都会红。**但见 P2-1** |
| C 消费面反转 | PASS | `stats.ts:8`、`skus.ts:23`、`downloads.ts:4` 均 `import site from '../config/site.json'`;`STATS_SNAPSHOT` 全字段取 `site.stats.*`(stats.ts:19-28),`SKUS = site.skus`(skus.ts:25),`DOWNLOAD_URLS` 取 `site.downloads.*`(env 兜底为 CON05 设计内过渡链);`DownloadButtons.astro:9,18-20` 与 `SiteNav.astro:28-29` 均经 `lib/downloads` 消费。全 src 扫描:硬编码统计/SKU 数值仅存在于 `site.json` 本体(stats.ts 第 5 行为注释;i18n 里是标签/标语=物化文案),无旁路残留。数值对账:site.json stats ≡ 种子 stats(28432/4812/156/47/99.7/"2026-08");site.json skus ≡ 种子 skus 的 visible 过滤+sort 排序+字段投影,7 项逐项 OK |
| D 产物不回归 | PASS | `node test-static.mjs` exit 0:`/api/health` 200 + **36/36 路由字节一致** + 未知路径 404(8788 自起自杀,回读 0 监听);`npm run gate:beacon` exit 0(内联埋点 gzip 1477B ≤2048,37 页每页恰 1 份);统计数字在产物页上:`dist/index.html` 含 `28,432`、`dist/vi/index.html` 含 `28.432`(vi 千分位点,与 fmtStat localeTag 一致)、`dist/zh/index.html` 含 `28,432` —— 渲染链未断 |
| E 构建不依赖网络 | PASS(读码判定) | `npm run build` = `astro build` 单命令,package.json 无 pre/post 钩子;astro.config.mjs 仅本地 import(astro/config、@astrojs/sitemap、@tailwindcss/vite),`site:` 为字符串常量;数据源全为仓内文件静态 import(src/config/site.json、src/i18n/*.json、content 集合走 `glob({base:'./src/content/learn'})` 本地 loader);全 src 唯一 `fetch(` 在 `metrics.ts:24`(浏览器运行时埋点,相对路径 `/api/e`,非构建期);`https://` 命中全是字符串字面量(schema.org context/外链 href/canonical 基);字体 @fontsource npm 自托管。构建期零配置拉取 |

## 问题上报

- **P2-1 self-test 第一断言在 CRLF 检出下空转**:`worker/gate-equivalence.mjs:30` 读原文件**未做** `\r\n→\n` 归一(主门 :45 做了)。本机 git autocrlf 检出为 CRLF,未变异时 `out !== orig` 已恒真(实测 true)——即比较器若坏掉(如变异不生效),self-test 在 Windows CRLF 检出上仍会绿,防假门保护在此环境失效(LF 检出/CI 上仍有效)。变异方向本身我已独立证真(见 AC B),故不阻断本包;建议修法:self-test 读 orig 时同样归一,或改比较「变异物化 vs 未变异物化」(与检出方式无关)。
- **观察-1 工作树 CRLF vs 契约 LF**:三份 i18n 与 site.json 的 git blob 均为 LF(物化契约),工作树被 autocrlf 检出成 CRLF——对工作树原始字节做 Buffer.equals 为 false 属检出转换,非缺陷;门已显式归一处理。真等价对象=仓库内容,已按 blob 逐字节验真。
- **观察-2 validateConfig 13 条软警告**(errors=0):5 条 mock-anchor(统计锚值,设计内——R49-F1 生产门拦截真值化前上线)+ 2 条 newline-shape(copy.zh hero.note / hero.subtitle2 换行结构异于源语言)+ 6 条 seo-length(title/description 超长,vi 居多)。均软警告不阻断;newline-shape 两条若站上分行契约敏感,可请主人过目一次。
- **观察-3 并行验收足迹与污染排除**:我跑门期间共享副本上存在 t7 探针(`scripts/forbidden-patterns.mjs` 追加 `/NXTESTWORD/i` + `src/nxtest-probe.md`,标注测毕还原)与 t8 的 `.wrangler-t8/`。影响分析:词表变异**只增不减**且种子文案不含该 token,加严词表下 errors=0 ⇒ 原词表下必然 errors=0,我的 AC A 结论不受污染;字节对比不经词表;probe md 不在 pages/ 不入 dist。本报告结论全部成立。

## 收尾自证

- 8788/8794 回读 **0 监听**;`.wrangler-t9` 从未创建(未自起 8794 服);默认 `.wrangler`/8787/8793 未触碰。
- 本仓写入仅本报告一份;临时脚本在 scratchpad(t9-equiv.mjs / t9-mutation.mjs)。
