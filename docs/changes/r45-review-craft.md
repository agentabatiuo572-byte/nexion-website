# R45 独立评审 · 角度 2:排版与工艺(尺子一致性 / 节奏 / 对齐 / 细节收口)

评审对象:`http://localhost:4399/` 构建产物(dist 2026-08-26 02:17,晚于全部 src 改动时间戳,产物新鲜)。仓库只读。
评审人:排版工艺评审 agent(r45-rev-craft)。本报告只写我量到 / 看到的,不预设结论。

## 大白话三件事

| 做了啥 | 结果咋样 | 要主人拍板啥 |
|---|---|---|
| 15 条路由 × 6 档视口,把每个文字节点的字号/行高/字距/字重/颜色/坐标全量抓下来做"同角色同尺子"比对;新加块(目录/相关文章/404/灯箱关闭行/无 JS 导航)逐个对体例;磨砂导航在黑区/白带/内页纸面三态截图;页脚透底后用画布像素实测小字与粒子线的对比度 | **总分 8.3/10**。尺子体系本身很整齐(对齐、基线、节奏、三语行高都过关);扣分集中在**磨砂导航在内页纸面上出现灰色"鬼影"**(P1,四类内页都有)+ 5 条新增小缺陷(目录行线参差、404 三语块没挂语言尺、法务大标题贴 meta 行、底板收口、页脚小字压粒子)| ① 内页鬼影修法选 a(内页底板加深到 .88)还是别的;② 导航文字行居中(30/0 → 15/15,涉及 R40 既有值);③ 页脚小字要不要加局部护字层(透底不动);④ vi 首屏 Mega 标题 0.79 行高叠音符擦上一行——尺子本身,是否给 vi 单独行高 |

## 方法

- 工具:Playwright(借 Nexion-uniapp 依赖),脚本 `scratchpad/rev2-*.mjs`,产物截图 / JSON 在 `scratchpad/rev2/`。全部打 4399,未起停任何服务、未 build。
- 视口:1455×900(zoom=1,主量尺)、1440×900(带 15px 槽 → zoom .9896,与 Windows 经典滚动条同态)、1920×1080、2560×1440(`ignoreDefaultArgs:['--hide-scrollbars']` 经典滚动条)、1600/1366/1280/1024/900(笔记本段)、390×844(触屏)。
- 静态几何:`reducedMotion:'reduce'` 下对 15 条路由做文字节点普查(每个文字节点的 face/size/weight/tracking/leading/transform/color/rect,首页 206 节点、内页 28–81 节点),再按 (face,size,weight,tracking,leading) 聚成"配方"看同角色是否同尺。
- 动态:正常动效下走完整页,检查打字机 / 行遮罩 / reveal 残留;磨砂翻色按 rAF 采样时间线。
- 截图纪律:暗区截图直接用;亮区(白带 / 内页纸面 / 灯箱)一律「废 canvas」配方(`addInitScript` 令 `#x-bg` `getContext` 返回 null),并回看确认未被强制暗色翻转;字形级判断用 `deviceScaleFactor:2` 的局部裁图。
- 页脚:滚到底后直接读 `#x-bg` 2D 画布的 `getImageData`(与屏幕像素同源),在小字矩形内算亮度分位数与"0.62 白字压在该像素上"的对比度,4 秒内采 6 次(流光会动)。

## 逐区观察

### 导航(磨砂底板)
- 几何 [COMPUTED]:底板 74px(1440 画布),`nav` 内衬 30/40/0;链接文字行盒 42.7–59.7,墨心 ≈51(底板高度的 69%);LOGO x-height 中心 ≈52。底板 = `rgba(12,12,13,.64)` + `blur(14px) saturate(1.15)`,白带态 `rgba(242,242,242,.72)`。底板无任何下缘线 / 阴影。
- 黑区(hero / stats / social / mission / deck / final):底板在纯黑上几乎不可见;首屏标题上滚过导航时,底板下缘在 "NexGrid" 字形上切出一条硬边(上半模糊灰、下半白),见 `navtall-dark-heroTitle.png`、`z-nav-over-title.png`。deck 区卡片钉屏位在 183px 起,不会进底板,无鬼影。
- 白带(how / path / trust / faq / final 前):翻色时间线 [COMPUTED]:onLight 置位 → 底板 250ms 线性变亮,文字在 ≈67ms 后瞬切黑(设计 54ms,rAF 采样粒度 33ms),全程无同色窗。底板亮态压白带干净;大标题(How 三步题、FAQ Q6)滚过时同样是硬切边(`navtall-light-howCards.png`)。白带上缘穿过底板的 ~74px 行程里底板呈上灰下白两段(`navtall-light-bandEdge.png`),半透明底板的固有现象,不扣。
- **内页纸面(/legal、/learn/[slug]、/nex、/learn)**:内页不切 on-light(只认 `.x-invert`),暗底板压在 780/1100 宽的 `.x-paper` 白纸上 → 底板内出现一块 **#454545 的灰矩形,四边 14px 羽化**;/learn 是四块灰云(四张卡)。像素 [COMPUTED]:底板压纸面 (69,69,69),纸面外 (12,12,12),纸面边缘 (39,39,40),边缘外 10px (25,25,25)、内 10px (55,55,55)。四条路由同值。截图 `navinner_*.png`。R45 之前是实底幕布,这一态从不可见——**这是本轮磨砂决定在内页的直接产物**。
- 手机(390):条高 54,LOGO 20px,汉堡 44×44 两杠 22×2;开态两杠成 ×(matrix 45°/-45°,位移 ±4)、LOGO 隐、`aria-expanded=true`;菜单链接 44/500/-0.02em/52.8,语言行 24 间距、EN 柠檬下划线偏移 4.2,下载键 48 高。干净。
- 笔记本段 [COMPUTED]:`.dl-btn` 字号 `max(11px,12u)` → 1280/1024/900 为 11px、1366 为 11.38px,同排链接恒 12px;1440+ 才回到 12。

### 首屏 / 数字条 / 陈述区 / Mission / 叠卡(黑带)
- hero:h1 100.8/500/-0.04em/0.79;副题 16/1.2 两行贴簇右缘;下载三键 44 高一行;底空 220 [COMPUTED]。vi Mega 标题 2x 裁图(`z-vi-hero.png`):第二行 "Để" 的 ê+hook 顶到第一行 "NexGrid" 基线带,第三行 "chảy" hook 与第二行 "tính" 近贴——0.79 行高对越南叠音符没有余量(尺子本身,见扣分 P3-17)。
- stats:编号 hot 柠檬、54/500 数字 tabular、标签 12/1.2 单行;vi `28.432` / `99,7%`,zh/en `28,432` [COMPUTED]。基线整齐(`z-home-stats.png`)。
- social / mission:54/400/-0.03em 陈述,16 档眉标 + 刻度,zh 走 1.15/-0.01em;mission 答案层 24/500/-0.01em,编号 hot。390 下 en 说明段右缘 352.9 < 390,标题两行 32px。
- deck:序号章 16/1.2/-0.36px 不再吃 zh 12.5/1.6;phone 图 contain。卡内 `.price`(Funnel 20/500)继承了 `.col.x-mono` 的 uppercase → "FREE"(见 P3-16)。

### 白带六块
- 行式表(learn teaser / FAQ / PoC)基线全部对齐 [COMPUTED+截图];FAQ 答案左缘 = 问题左缘(58/58),PoC 答案左缘 = 问题左缘(24/24)。
- zh 全站 CJK 行高 1.6 已统一:trust 五卡 / FAQ 答案 / how / path / nex teaser / PoC 全部 12.5px/20px [COMPUTED]。
- PoC 与 FAQ 同带两套手风琴语法(PoC 记号在左无序号,FAQ 序号左记号右);B7 归一的是线式与字面规格,AC5 又钉死了"答案左缘=问题左缘",判为有意为之,不扣。

### 内页体例
- 四类内页共享 84+46 顶部节奏与 40 边距 [COMPUTED];/learn 与法务 H1 同为 88 档,文章与 /nex、404 同为 54 档(54 档的流体段 4.6vw/5.2vw 与下限 30/34 不同,只影响 <1440)。
- 文章页:back 链 → h1 → meta(12 下)→ 目录(30 下)→ 纸面(24 下)→ 相关(40 下)→ CTA(40 下),节奏落在 12/24/30/40 阶梯。**目录行线只有文字那么长**(`.toc a` 是 inline-flex 且 border 挂在 a 上):四行线长 237/245/230/128px,末行无收口线;相关文章行线全宽且有收口线 —— 同页两套行线(`z-toc.png`、390 同样)。目录编号 #9edc1d,黑底编号体例(stats/mission)是 hot #d4ff55。
- 法务页:H1 升 88 档后 `margin-bottom` 仍是 8px,"Privacy Policy" 的 y 降部距 meta 行大写字顶约 5px(`z-legal-head.png`);/learn 88 档 → 副题 14px,文章 54 档 → meta 12px:同一关系三把尺。
- /zh/legal/:main `lang=en` 但尺子按 `html[lang]` 选择,"Terms of Service" 在 zh 路由吃到 1.15/-0.01em(文字宽 673 vs en 路由 645),`Last updated` 12.5/20 vs 12/14.4。
- /nex:块 h2 32/500/-0.02em/1.1,列表三列基线对齐,mcard h3 24/500/-0.01em,FAQ 与首页 FAQ 字重 / 字距 / 行高 / 记号色已同,但列几何未同(序号列 30 vs 28、序号→问题 28 vs 16、答案量 760 vs 680)。
- /learn 列表:卡 h2 24/500/-0.015em/**1.18**(本轮"子页 h2/h3 ≤1.15"的漏网);副题在 1440 断在连字符 "SIGN-/UP"。
- 404(新):三语块 84/46/56/16 节奏与内页同家;但块级 `lang` 不触发任何语言尺:vi 标题在 Funnel Display 里,越南预组合字母回退到系统字体(通用回退宽度探针 540.6 vs 534.9 → 有回退;`fonts.check('Be Vietnam Pro')` false;对照 `z-404-vi.png` / `z-404-vi-bvp.png`),zh 标题 1.0/-0.03em(zh 尺应 1.15/-0.01em)、zh 正文 12/18(zh 尺 12.5/20)。
- 灯箱(新关闭行):sticky 行 72 高(16/44/12),按钮为纸面语境 ghost 键(墨字 + 0.23 细边),内滚 214px 后关闭行不动、页面 scrollY 不动,Esc 后焦点回 `a.cert-open` [COMPUTED];hover 提示条 26px 左对齐小字。体例与白带 ghost 键一家。

### 页脚(透底)
- 顶线由页脚 `border-top` 画,**只跨 1920 画布**:2560 下两侧各缺 312px(`wide-2560-footer.png`),而白带是全出血。
- 小字与粒子 [COMPUTED,1455 与 1920 各 6 采样]:披露段 / 法务链 / 版权行三块:中位对比 7.7:1,p95 5.1–5.6:1,p99 3.7–4.5:1,最亮像素 1.3–2.4:1(流光);任一瞬间 5.6–7.8% 的小字面积压在把对比拉到 4.5 以下的线上,0.5–1.8% 压在 3:1 以下。截图 `footer-1455.png` / `footer-2560.png`:两行披露段被柠檬线穿过。字标 120/500/0.79 压在最密的弧上,是构图主体,不算问题。

### 引擎残留 [COMPUTED,正常动效走完整页]
`[data-tw]` 未完成 0、影子/打字层残留 0、inline style 残留 0;`[data-rv]` 35/35 进场;行遮罩动画结束后结构拆除、文本还原(终态无 `.lr-line`,与 AC3 "打完后无残留"一致)。

### 全站配方普查(en 路由,1440 画布 px)[COMPUTED]
display 17 个配方 / 9 个字号档:同为 24/500 有 -0.015em(prose/legal/learn 卡 h2)与 -0.01em(nex mcard h3、mission 字段)两种字距;同为 24/400 行标题有 1.25(FAQ)与 1.15(相关文章)两种行高;teaser 32/400 用 1.1。mono 12 段落行高四把尺:1.2(learn 副题 / 卡说明、nex lead / 说明 / 表格,多行仍 1.2)、1.45(how/path/trust/nex teaser/FAQ)、1.5(hero note / devices sub / 页脚 / 404 正文 / social roles)、1.85(prose/legal)。

## 扣分清单

| # | 严重度 | 类型 | 扣分点 | 证据 | 参数级修法 |
|---|---|---|---|---|---|
| 1 | **P1** | 新增缺陷(磨砂决定的内页后果) | 内页纸面块在磨砂底板里成灰色"鬼影":四类内页只要纸面滚到导航下,条内就有一块 #454545、四边 14px 羽化的灰矩形(/learn 是四块灰云),文章阅读全程可见 | `navinner_legal_privacy_.png` `navinner_learn_getting-started_.png` `navinner_nex_.png` `navinner_learn_.png`;像素 over 69/beside 12/edge 39 | (a) 推荐:内页给深底板 `main:has(.x-paper)` 不可行于 fixed 兄弟,改为 Base 按页类型给 `html` 挂 class,`html.x-sheet .site-nav{--x-nav-tint:rgba(12,12,13,.88)}` → 鬼影降到 ≈#2a2a2a;(b) `blur(14px)`→`blur(6px)` 只缩羽化、灰块仍在;(c) 让 `.x-paper` 也触发 on-light 会得到"白条压黑边",不推荐 |
| 2 | P2 | 新增缺陷 | 文章目录行线参差、无收口:线挂在 inline-flex 的 `a` 上,长度随文字(237/245/230/128px),`ol` 无 border-bottom;同页相关文章行线全宽 + 收口 | `z-toc.png`、`m-inner_learn_getting-started_.png` | `.toc li{border-top:1px solid var(--x-line-soft)}` 并从 `.toc a` 移除 border(或 `.toc a{display:flex}`);`.toc ol{border-bottom:1px solid var(--x-line-soft)}` |
| 3 | P2 | 新增缺陷 | 404 三语块不走语言尺:vi 标题越南字母回退拼字(Be Vietnam Pro 未加载)、zh 标题/正文按 Latin 尺(1.0/-0.03em、12/18) | 探针 `titleFallback.fallbackUsed=true`、`fonts.check` false;`z-404-vi.png` vs `z-404-vi-bvp.png`、`z-404-zh.png` | tokens.css 语言尺从 `html[lang=…]` 改 `:lang()`:`:lang(vi){--x-font-display:'Be Vietnam Pro',…}`、`.x-display:lang(zh){…}`、`.x-mono:lang(zh){…}`、`.x-display-mega:not(.wordmark):lang(zh){…}`(@fontsource 各面已在全站声明,按需加载) |
| 4 | P2 | 新增缺陷(升档后果) | 法务 H1 升 88 档,H1→meta 仍 8px:降部与 12px 小字仅 ≈5px;同关系 /learn 14、文章 12 | `z-legal-head.png`;probe `h1CS.marginBottom:8px` | `LegalPrivacy/Terms h1{margin-bottom:calc(14*var(--uc))}`(与另一 88 档页 /learn 同值),或三页统一一个值 |
| 5 | P2 | 新增缺陷(底板可见后暴露) | 磨砂底板收口:① 下缘无定义,大字滚过时硬切;② 文字行偏下(30/0 内衬,墨心在 69% 高度,上 43 下 23);③ 当前语言柠檬下划线正好落在底板最后一像素行(链接盒底 73.6 vs 底板 74) | `z-nav-over-title.png` `z-nav-right.png` `navtall-light-howCards.png`;probe links txt 42.7–59.7 / header 74 | 条高不变:`nav{padding:calc(15*var(--uc)) var(--x-pad)}`(行居中,下划线离边 15px);可选 `.site-nav::before{box-shadow:0 1px 0 var(--x-line-soft)}`,on-light 用 `rgba(12,12,13,.08)`。⚠ `padding-top:30` 是 R40 既有值,须主人点头 |
| 6 | P2(轻) | 已拍板项的边缘(透底本身不扣,扣无护字层) | 页脚小字直压粒子线:最亮像素对比 1.3–2.4:1,p99 3.7–4.5:1;5.6–7.8% 小字面积低于 4.5:1、0.5–1.8% 低于 3:1(1455/1920 各 6 采样) | `footer-1455.png` `footer-2560.png`;`footer2-log.json` | 保持透底:(a) 推荐 `.info` 加局部护字层 `.info::before{content:'';position:absolute;inset:-24px;z-index:-1;background:radial-gradient(closest-side,rgba(12,12,13,.85),transparent)}`(字标周围粒子照旧);(b) fx 在页脚 info 矩形内钳流光亮度;(c) 小字升 cap/白(动 R35 既有值,须主人) |
| 7 | P3 | 部分归一 | 首页 FAQ 与 /nex FAQ "同规格"只归了字面:序号列 30/28、序号→问题 28/16(问题左缘 58 vs 44)、答案量 760/680、问题下限 18/16 | probe faq/nex faqs;`z-home-faq.png` `z-nex-faq.png` | 两处共用 30/28/760,或注明卡内变体为意图 |
| 8 | P3 | 漏归一 | /learn 卡 h2 行高 1.18(本轮"子页 h2/h3 ≤1.15",兄弟页全 1.1) | probe learn cards `lh 28.32px` | `.card h2{line-height:1.1}` |
| 9 | P3 | 既有值口味 | 24px display 双字距:24/500 有 -0.015em 与 -0.01em;24/400 行标题 1.25 与 1.15(相关文章新块沿用了 1.15 而非 FAQ 的 1.25) | 配方普查表 | 24/500 统一 -0.015em;24/400 行标题统一一个行高 |
| 10 | P3 | 既有值口味 | mono 段落行高 1.2/1.45/1.5/1.85 四把尺;/learn 副题与卡说明、/nex lead 与说明多行仍 1.2,偏紧 | 配方普查表;`inner_learn_.png` `inner_nex_.png` | 1.5 并入 1.45;/learn、/nex 多行 12 档给 1.45,1.2 只留单行标签 |
| 11 | P3 | 既有值(与拍板"12px 下限"相抵) | 导航下载键字号下限 11px(`max(11px,12u)`),1280/1024/900 为 11、1366 为 11.38,同排链接 12 | `wide-log.json` lap-*;`lap-1280-nav.png` | `.dl-btn{font-size:max(12px,calc(12*var(--u)))}`(若 11 是有意保留则注明) |
| 12 | P3 | 新增(后果) | zh 路由把 zh 陈列尺套在 `lang=en` 的英文法务标题上:1.15/-0.01em vs en 路由 1.0/-0.03em(文字宽 673 vs 645);meta 行 12.5/20 vs 12/14.4 | probe /zh/legal/terms/ h1F;`inner_zh_legal_terms_.png` | 同 #3 的 `:lang()` 改法即根治 |
| 13 | P3 | 新增 | 黑底编号双柠檬:目录编号用 `--x-accent-ink` #9edc1d,黑底编号体例(stats/mission 编号、刻度)是 `--x-accent-hot` #d4ff55(token 注释"亮柠檬:仅黑底静态强调件(刻度线/竖标/编号)") | probe tocRows nF color / stats idx | `.toc .n{color:var(--x-accent-hot)}`,或在 token 注释里写明"链接内编号走 accent-ink" |
| 14 | P3 | 新增 | 页脚顶线不全出血:本轮加的 `border-top` 只跨画布,2560 两侧各缺 312px;白带是全出血 | `wide-2560-footer.png` | `.site-footer{margin-inline:calc(-1*var(--x-bleed));padding-inline:calc(var(--x-bleed)+var(--x-pad))}`(照抄 `.band-light`) |
| 15 | P3 | 既有值(文案) | /learn 副题 1440 断在连字符 "SIGN-/UP" | `z-learn-head.png` | en `learn.subtitle` 用不断行连字符 U+2011,或副题 `max-width` 520→540 |
| 16 | P3 | 既有值 | 设备卡价格 "Free"/"Miễn phí" 被 `.col.x-mono` 的 uppercase 传染成 "FREE"/"MIỄN PHÍ",全站唯一大写 display 文字,旁边设备名是正常大小写 | probe devices price `tt:uppercase` | `.price{text-transform:none}` |
| 17 | P3 | 既有值(尺子本身) | vi 首屏 Mega 标题 0.79 行高下叠音符擦上一行("Để" 的 ê+hook 顶到 "NexGrid" 基线带;"chảy" hook 近贴 "tính") | `z-vi-hero.png` | 字号 / 文案不动,只给 vi 单独行高 `html[lang=vi] .x-display-mega{line-height:.86}`;簇高 +17px,现距导航 188px(AC ≥150)仍过。是否动尺子由主人定 |

不扣分的观察:PoC 与 FAQ 两套手风琴语法(判有意);hero / 收尾下载键是全站唯一大小写混排按钮(品牌拼写,有意);白带上缘穿底板时的上灰下白两段(半透明固有);导航时钟 / 滚动提示 / 版权行 -0.03em 与标签 0 是一条稳定的"工具小字"子规则;`dialog` 继承 CanvasText 白色但无裸露文字,无害。

## 已排除清单(主人已拍板,未计分)

首屏标题字号与文案 · 窄屏不做第二套画布 · 信任五卡 4+1 · FAQ 右缘 · 正文行长全大写 · 页脚空档 · 排印档位数(9 display / 2 mono)· 导航小字 12px 下限与条高(#11 只指出下载键 11px 与该下限相抵,归主人)· 画布 zoom 机制 · 导航底板=半透明磨砂(底板本身不扣;#1/#5 扣的是它在内页与收口上的工艺后果)· 页脚透底(#6 只扣无护字层)· 首屏底空 220 · 编号强调色(#13 只指出同一角色两种柠檬)· 卡片淡入 · R17/R23/R24 陈述区结构 · 灯箱原尺寸。

## 通过项(供回归时不必再看)

导航内容与画布在 1440/1455/1600/1920/2560 五档全部零偏差(LOGO 左缘 − 首屏提示左缘 = 0);2560 画布两侧空档 312.5 / 312.5(+15 滚动条);内页四类共享 84+46+40 节奏;行式表(teaser / 相关 / nex 三列)基线全对齐;手风琴答案与问题左缘全对齐(58/58、44/44、24/24);zh CJK 行高 1.6 全站统一;vi 千分位 `.` 小数 `,`;打字机 / 行遮罩 / reveal 零残留;灯箱关闭行常驻、锁滚、焦点回归;手机菜单 ×、焦点、48 高下载键;磨砂翻色无同色窗。

## 总分:**8.3 / 10**

一句话:尺子体系本身已经很稳(对齐、基线、节奏、三语行高全部过关),但本轮的头号改动"磨砂底板"在内页把白纸压成一块羽化灰影,加上目录行线参差、404 没挂语言尺、法务大标题贴 meta 这几处新增的收口失手,离"只剩口味项"还差一轮。

[RULES I BROKE]: 无。
