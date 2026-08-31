## 结论表

| # | 结论 | 一句理由 |
|---|---|---|
| 1 | 可以照做 | 全站零 `scrollIntoView`/`scroll-behavior` 依赖;无 JS 跳锚、reduced 跳锚、focus(preventScroll) 三条实测均正常 |
| 2 | 需要修正 | 114/136ms 的算术对**底板色**成立(实测 t=114 时 `::before` 恰为 rgb(117,117,117)),但画到屏上的是 0.95 alpha 合成 + 深字是 #0c0c0d,实测瞬切那一刻只有 **3.89:1** |
| 3 | 需要修正 | 行为全部实测通过;但 760uc 定宽把 1160×1548 原件压成 720×961 塞进 846 高的盒子,核验证书仍要盒内滚动 |
| 4 | 可以照做 | 前提为真(宿主 computed `display:flex`,纯空格/尾随空格被 flex 吃掉),NBSP 后实测渲染 `UTC 03:07 AM` |
| 5 | 需要修正 | `:lang(en)` 把 `--x-font-display` 的 CJK 回退栈整段删了;/404 的 zh 块实测拿到 `"Funnel Display", system-ui, sans-serif` |
| 6 | 可以照做 | print/reduce 两态实测:导航与 canvas 隐藏、0 个 hidden 的 lr/tw、ghost visible / live none、navDelay 0s |
| 7 | 需要修正 | `rgba(12,12,13,.9)` 是硬编码不吃 print 的 token 翻转,打印时合规免责声明变成黑底黑字(截图为证) |
| 8 | 可以照做 | 4 条目录锚点全部命中真 id、role=list、行高 43.5(=44uc×zoom)、相关文章 2 条链接可达 |
| 9 | 可以照做 | /404 实测:导航锚点 `/#how` 跨页形、语言链 `/ /vi/ /zh/` 无死链、noindex 有、canonical 无 |
| 10 | 需要修正 | 归因错(线上旧码每条行缝只有**一个**负外边距,折叠≡相加);且负 inset 实测让等待中的下一段字顶露出来(截图为证) |
| 11 | 可以照做 | 竞态三处都查了,已播判定/重拆/兜底还原逻辑成立;两个 P2 见下 |
| 12 | 需要修正 | 8 个 `[data-plx]` 里只有 3 个含可聚焦件(共 3 个);且 `focusin` 鼠标点击同样触发,半露的卡内链接一点就 `immediate` 瞬移 |
| 13 | 需要修正 | preamble **没有**解决它自己注释里写的那种失效(语法错红测:文件仍留 0);禁用词新模式有真误报族;visual-diff 仍漏「只在新快照里的整页」 |

## 问题清单

**2-①③ 翻色瞬切点算早了,AA 不成立(P1)**
证据:1440 视口滚到白带边界,冻结过渡逐点取屏幕像素 —— t=113 底板 110 白字 5.09:1;**t=114 底板 111 换成 #0c0c0d,3.89:1**;到 t≈128 才回到 4.5。两个原因:`.flipping::before` 是 0.95 不是 1(painted 比 tint 暗 ~6 档),深字是 #0c0c0d 不是 #000(等对比点在 L=0.1874=分量 120,不是 0.179=117,且该点最好也只有 4.42:1)。
建议:翻色窗内把底板改成瞬切(`.flipping::before{transition:background-color 0s}`)+ opacity 1,文字同一刻切 —— 对比永不落到中间灰;若保留渐变则至少 delay 改 ~130ms/~120ms 并把 0.95 提到 1。

**2-② 其余分项实测全过**
`data-lenis-prevent` 是 lenis 1.3.26 在 wheel/touch 事件里沿 composedPath **动态**读的(`dist/lenis.mjs:609`),挂/摘即时生效;mq 断点 860 与组件 `@media (max-width:860px)` 对齐,开着菜单拉宽到 1000 实测自动收口(overflow/inert/prevent 全清、页面恢复可滚);Esc 关闭并回焦汉堡;`.menu-switch` 60ms 与 `.flipping` 270ms > 色过渡 250ms 均自洽。
残留:`inert` 在 Safari 15.0–15.4 不支持(目标矩阵含 Safari 15+),那半个焦点陷阱会失效,好在菜单内 Tab 循环仍在,降级可接受。

**3-① 灯箱定宽让核验仍要滚(P2)**
证据:1440×900 下 dialog 752.1×846、img 720.4×961.4,`scrollHeight 1059 > clientHeight 855` —— 打开后仍有约 115px 证书在盒外,要在盒内滚。信任区的唯一目的是核验,这一步没消掉。
建议:宽度别只由 `760uc` 定,改让高度也参与(`img{max-height:calc(94vh/var(--x-zoom) - 关闭行高);width:auto;object-fit:contain}`),或直接按 `min(760uc, 高度反推宽)`。

**3-② 已实测通过的部分 + 两个小口子**
`removeAttribute('src')` 后 1160×1548 属性撑住盒子零抖;`scrollTop=0` 在 `showModal()` 之后确实生效;点内衬带(左缘 +3px)不关、点盒外关;`html{overflow:hidden}` 因 `scrollbar-gutter:stable` 零宽度位移、零滚动跳;无 `showModal` 时不 preventDefault、走 `<a href>` 原生(Safari 15.0–15.3 正是这条)。
口子:(a) 从盒内按下、盒外抬起的拖选也会命中「点在盒外」判据而关闭;(b) `96vw` 是裸视口单位(含滚动条),而 `--x-zoom` 现在由不含滚动条的 `--x-vw` 驱动,两者约差 1%,仅在 <792px 视口才起作用,低危。

**5 `:lang(en)` 删掉了 CJK 回退栈(P1)**
证据:`/404` 上 html 是 `lang="en"`,`:lang(en)`(0,1,0)在源序上晚于 `:root`(0,1,0)故获胜,zh 并列块继承到 `"Funnel Display", system-ui, sans-serif` —— `PingFang SC / Hiragino Sans GB / Microsoft YaHei` 三个回退全没了,「页面不存在」落到 system-ui。EN 页导航的「中文」标签因为走 `--x-font-mono` 才幸免。
建议:`:lang(en)` 的值照抄 `:root` 那一整串(带 CJK 回退),只是为了在 vi 页的英文岛里把 Be Vietnam Pro 换回来,不该顺手瘦身。附:`.x-mono:lang(zh):not(html)` 的特异度 (0,2,1) 与旧 `html[lang='zh'] .x-mono` 完全相等,补特异度这半条是对的。

**7 打印时护字层变成黑底压黑字(P1)**
证据:`emulateMedia('print')` 下 `.info::before` 仍是 `rgba(12,12,13,0.9)` + `blur(14px)`,而 `.disclaimer` 已被 print 块翻成 `rgba(0,0,0,0.7)` —— 截图里「EARNINGS VARY … NOT GUARANTEED. NOTHING ON THIS SITE IS FINANCIAL ADVICE.」整段黑底黑字。这是合规免责声明,不是装饰。
建议:护字层的颜色走 token(新增 `--x-scrim` 之类),print 块里把它翻成透明或白;顺带这条硬编码 rgba 也绕过了「颜色用 token 不写 hex」的项目不变量(hex 门抓不到 rgba 写法)。屏幕态实测是好的,粒子被压住,只有 print 这一面漏了 —— 也就是说 #6 的 print 清扫漏了同类。

**10-① 归因不成立:线上旧码没有那条折叠(P1,结论可留、理由要改)**
证据:`git show HEAD:src/styles/tokens.css:289` 只有 `.lr-line{overflow:hidden;padding-bottom:.1em;margin-bottom:-.1em}`,**没有** vi/Mega 的上边负外边距变体。每条行缝只有「上一行 margin-bottom -0.1em」对「下一行 margin-top 0」,折叠取最负 = -0.1em,与相加同值 —— 「取最负而非相加,每缝净多一个余量」在已发布的代码里不可能发生。那个「首屏 h1 第 2 行差 23px」的实测,更可能是**末行负外边距穿透宿主**(新码另用 `.lr-ready{display:flow-root}` 单独修掉了)。
说明:该机制在「要同时保护上边」的假想扩展里是真的(-0.14 与 -0.16 折叠成 -0.16、padding 却加到 0.30,净 +0.14)。换 clip-path 的**决定**我不反对,但理由必须改写成「负外边距路线无法扩展到上边」,否则下一轮会照着错根因再改一次。

**10-② 负 inset 真的让等待中的下一段提前露出(P1)**
证据:把 `.lr-inner` 钉在 `translateY(110%)`(真·未播状态)截图页脚字标 —— 28.8px 的下扩窗里露出 "NexGrid" 每个字母的**顶端白条**(`wordmark-preplay2.png`)。量化:0.79 行高下等待层顶端只在行底下方 0.1×lh(120px 字号 = 9.5px),而窗子开了 0.24em=28.8px,再叠上负 half-leading,字顶必然落进窗内。三语同中。
暴露时长不是一两帧:`data-lr-delay` 最大 400ms(HowSection `100*(n-1)`)、PathSection/NexTeaser `100*i`,这段时间宿主已在视口内、`.in` 还没加。建议:下扩量只按**降部**给(0.1em 量级够),叠音符靠上扩解决;或对未播状态额外用 `clip-path: inset(… 0)`,`.in` 之后再放开下边。附:`.lr-line` 现在 computed `overflow-x: visible`,`clip-path` 走的是 border-box,`inset()` 是纯矩形裁切、Chromium 走合成器,性能与 Safari 兼容性无实测反例(本机只装了 Chromium,Firefox/WebKit 未能实测,需真机补一次)。

**11 竞态查完成立,两个 P2**
已核:`s.played` 在 `play()` 首行置位,重拆对**正在播**的宿主直接 return(不会打断在途动画);resize 去抖 200ms 后重拆会 `clearTimeout` 掉未到点的 play 并重装 IO,在视口内会立刻重新排;`transitioncancel` + `90*(n-1)+1100` 兜底两道都在;`x-boot` 判定使 刷新/后退/带锚点不排队。
P2-a:`document.fonts.ready.then(()=>els.forEach(rebuild))` 可能早于 `Promise.race` 的 `build` 落地,此时 `st.get(el)` 还是 undefined、rebuild 空转一次(无害但那道保险等于没生效)。P2-b:慢字体下 1.2s 兜底后的行数变化未能证伪 —— 本机把 `**/*.woff2` 延迟 2.5s 后三语行数(2/3/2)与快网完全一致,说明本机字体回退度量恰好不改行数,不等于慢网机型也如此,这条留作未验证项。

**12 视差 focusin 两个问题(P2)**
证据:全站 8 个 `[data-plx]`,可聚焦件分布 `[0,0,1,1,1,0,0,0]` —— 只有 3 个;`reduced || coarse` 时 `initParallax` 提前 return,所以触屏/减动态下这条修法根本不挂。收益面比描述的小。
更实的问题:`focusin` 鼠标点击一样触发。守卫 `if (r.top>=0 && r.bottom<=innerHeight) return` 只在元素**完整可见**时放行,卡片半露时用鼠标点里面的链接,会被 `lenisInst.scrollTo(y,{immediate:true})` 瞬移居中。建议加 `if (!t.matches(':focus-visible')) return`(或 `e.detail !== 0` 判鼠标),把这条限死在键盘路径。
另:与锚点跳转不叠加 —— 锚点目标是 `#how/#devices/#trust/#download` 这些区块,`closest('[data-plx]')` 为 null,已核。非视差区焦点不受影响,已核。

**13-① preamble 没解决它引用的那类失效(P1)**
红测(scratchpad/pt2,与 verify 同构):`import './pre.mjs'` 在前、后一个门模块里放**语法错** → Node 在 link 阶段就抛,**任何模块体都没执行**,`.verify-exit.code` 原样留 `0`(绿)。同一装置换成门模块顶层 `throw` → preamble 执行,文件变 `2`。也就是说它只修了「运行期抛」,注释里点名的「U5 ⑦d 门模块语法错 → 文件仍 0」一模一样地复现。
建议:把置红移到 node 进程之外(`"verify": "node -e \"require('fs').writeFileSync('.verify-exit.code','2')\" && node scripts/verify.mjs"`),或把所有门改成 `await import()` 动态加载。附:`ROOT` 推导在 Windows 上是对的,实测得 `D:/WORKS/PLAN/nexgrid-website/`(路径无空格/非 ASCII 时成立)。

**13-② 禁用词新模式的真误报族(P1)**
拿探针跑:真阳性 16 条全中、当前仓库 0 命中;但这些**合法**文案会误红 —— `Compute uptime 99.9% monthly average`、`Network fee is 1% per month`、`battery at 80% daily`(都撞 `pct+period`,该模式不要求出现收益名词);越南语 `5% mỗi tháng phí nền tảng` / `Phí nền tảng 5% mỗi tháng`(手续费,撞 vi 族);中文否定式免责 `本站不保证收益`、`我们不保证赚钱`、`零风险是不存在的`(撞 `保证(收益…)` 与 `零风险`)。英文侧因为要求 `guarantee` 后紧跟收益名词,`not guaranteed` 才幸免 —— 中文/越南语没有对等的否定守卫。
建议:`pct+period` 要求邻近收益名词(或排除 fee/uptime/commission/battery 名词);中文加否定前瞻 `(?<!不)保证`、`零风险` 要求不在否定句;越南语 `%\s*mỗi tháng` 同样要求邻近 `lợi nhuận/lãi`。这个仓的产品文案天生充满「抽成 %/在线率 %」,不加守卫会把门变成日常绕行的对象。

**13-③ visual-diff 仍有一半盲区(P2)**
外层是 `for (const page of Object.keys(A))` —— 只在**新**快照里的整页(新增路由、sitemap 新条目)永远不被访问,既不点名也不计入 `total`。新增的「只在一边的键」只覆盖了同一页内部的键。另 `if (!a[key])` 用真值判断而非 `key in a`,若 collect 某键取到假值会误判为消失。
建议:改成 `new Set([...Object.keys(A), ...Object.keys(B)])` 遍历,并把 `!a[key]` 换成 `!(key in a)`。

**13-④ 新 legit() 安全,但列表有一条死项(P2/信息)**
实测:6 路由 × {390,1440,2560} 逐元素跑「旧 legit vs 新 legit」,每次有 9–125 个元素从「合法裁切」翻成「受审」,**其中真正越界的 0 个** → 无新误报;完整几何门对 33 路由 × 5 宽度 + 5 个断点两侧实测七判据全过(滚动条:经典(占位))。
死项:`.lr-line` 现在 computed `overflow-x: visible`(已改用 clip-path),它留在 `CLIPPERS` 里不再匹配任何东西;`legit()` 只看 `overflowX`,不认 `clip-path`,所以行遮罩这类裁切在门里已无豁免路径(当前无害,因为 B 判据只量横向)。

**跨条附注(未能实测)**
本机 `ms-playwright` 只装了 Chromium,Firefox / WebKit 未安装且不便安装。以下三条按规范推断、需真机补测:(a) `background-color` 走 `var()` 变量换值时的过渡在 Safari 是否照常触发(不触发的话底板会瞬切、文字仍等 114ms,#2 会退化成整整 114ms 的同色);(b) 0 时长 + 延迟的 `color` 过渡在 Firefox/WebKit 是否照 combined-duration 规则起效;(c) `clip-path` 负 inset 叠 `will-change:transform` 子层在 Safari 的合成表现。
