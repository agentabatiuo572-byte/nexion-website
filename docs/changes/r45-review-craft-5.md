# R45 独立视觉评审 · craft-5(排版与工艺)

角度:尺子一致性 / 节奏 / 对齐 / 细节收口。只看构建产物 http://localhost:4399,仓库只读。

## 方法

- Playwright(借 Nexion-uniapp 依赖),脚本在 scratchpad `rev2e-*.mjs`。主量 1455 视口(`--x-vw`=1440,zoom 恰为 1,画布 px = 屏幕 px),另探 390 / 360 / 414 / 1024 / 1935 / 2560。
- 排印尺子:逐元素抓 font-size / line-height / letter-spacing / font-weight / text-transform / font-family,按「字号档 → 有几套尺子」聚类(9 路由 × 3 宽度)。
- 基线:在元素首个文本节点前插入 `display:inline-block;width:0;height:0;vertical-align:baseline` 的探针,`getBoundingClientRect().top` 即真基线(不靠 rect 估算)。
- 光学中心:亮态导航底板是纯色 #f2f2f2,直接扫墨迹行(逐行统计暗像素)取 ink top/bottom。
- 底板 / 护字层:同一滚动位冻结 rAF 后做 A/B 截图,再在浏览器里解码 PNG 算**水平梯度能量**(高频细节量)与逐点亮度;所有结论都带「已知答案对照组」。
- 标题动画:`requestAnimationFrame` 逐帧采样宿主高度 / 行盒 top / clip-path / inner transform(en/vi/zh 各 ~193 帧),另在起滑前逐时刻扫 h1 盒内像素。
- 亮区不看截图判色(本机强制暗色),一律 DOM/计算样式或「废 canvas」配方 + 回看。

---

## 逐区观察

### 导航(全站常驻,三态)

- 行内所有 mono 件基线完全一致:clock / 五条链接 / 语言链 / DOWNLOAD 键标签**全部 52.39**;光学中心全部 **51.5**;logo 方块光学中心 52.0。这一排收得很干净。
- **字标 "nexgrid" 是例外**:基线 **62**(低 9.61px),光学中心 **54.5**(低 3.0px)。根因不是位移,是它没有任何排印尺子——见扣点 2。
- 半透明磨砂底板:暗 0.64 / 亮 0.72 / 内页 0.9 三态的 tint 与 alpha 都按拍板值下发,计算样式 `backdrop-filter: blur(14px) saturate(1.15)` 也**逐字符正确**。但像素层面首页三语**完全没有磨砂**——见扣点 1。
- 内页(x-inner,0.9)导航呈左右两色:左 rgb(34,34,35)(780 纸面板透出)、右 rgb(11,11,12),交界被 blur 摊成 ~28px 缓坡,不是硬边。这是 0.9 这个既有值的必然残留,不算缺陷。

### 首屏

- 画布 zoom=1 时 `.cluster` 右锚 1400:h1 盒 892.8 左对齐(ink 右缘 1280.94)、`.sub` 盒 439.2 右贴、`.dl-wrap` 右贴 1400。三者右缘按设计不齐(标题左对齐是拍板体例)。
- `.sub` 首行 ink 右缘 **1381.88**,与下载键右缘 1400 差 **18.12px**(≈1.9 个等宽字位)——见扣点 5(既有值)。
- 行遮罩(逐帧):宿主高度 en 159.25 / vi 238.88 / zh 241.91,**开场前、动画中、还原后三者完全相同**;行距 79.62 / 79.63 / 120.95 全程恒定;t≈1.54s 拆掉 `.lr-line` 包装后高度不变。起滑前 h1 盒内最大通道 **11–12**(=页底色)、>40 的像素 **0 个**,三语全中。`clip-path` 负 inset 那一版修法在运行时是干净的。

### 数字条 / 陈述区 / 品类章

- 五格 grid:cell 左缘 40 / 316.8 / 593.6 / 870.4 / 1147.2,墨起点统一 +19(1px 竖线 + 18 内衬),节奏精确。`.asof` 落在区块 padding 线 40 上(与 hero note、`.state` h2 同一条全局左缘),是外挂不是错位。
- 品类章 `.fields li` 用 `align-items: baseline`,序号与名称共基线。**但序号 `.idx` 的行高掉到 1.6**(见扣点 2),今天被更高的 `.name` 盖住,属休眠态。

### 设备叠卡

- 卡脚 `.cols` 是 `align-items: flex-start`:20px 价格基线 108.16、12px 说明基线 100.16,**差 8.00px**,说明整行浮在价格之上。1:1 裁图肉眼可辨。站内同型行(mission / nex list / learn teaser / 相关文章)全部是 baseline——见扣点 3。
- zh 卡的 `.price` 行盒 32px、en/vi 24px(同为 20px 字号),zh 卡因此高 8px——同扣点 2 的第三处泄漏。

### FAQ(首页 / /nex/)

- 两处几何已完全归一:行距 61、`.idx` 列 30、gap 28、`.q` 同一条 `max(18px, 24u)` 公式、`.mark` 右缘贴行线。R45 的归一修法落地。
- 六个 `+` 记号实测**全部 rgb(72,100,5)**(我第一眼在缩图上看成隔行换色,回源逐点采样证伪,不计扣点)。
- `summary` 用 `align-items:center`,`.idx`/`.mark` 基线 129.27、`.q` 基线 134.47(差 5.2px)。手风琴用 center 是为了 `+` 在多行问句上居中,与静态行用 baseline 各有道理,不作扣点。

### 文章页(R45 新块复核)

全部落地,且未见新伤:
- h1 → meta **14**;meta → toc 30;toc → prose 24(`.prose{margin-top:10}` 被 toc 的 24 折叠吞掉,是死值不是错位);prose → related 24;related → cta 40。
- `.toc` 与 `.related` 同 gap 10、同横内衬 34、内容左缘同为 74、行线同 0.23、底线收口一致。
- `.related .name` 24/500/1.1,与 `/learn/` 卡标题同尺。
- `.row .arr` 作用域已收窄,18 个页面的转化键箭头未被染色。

### 404

三块几何精确:块距 **56 / 56**,块内 title→body **16**、body→button **16**(三语全等);标题 en/vi 行盒 54、zh 62.1,正文 en/vi 12/18、zh 12.5/20——`:lang()` 分尺生效;三个按钮统一实心、同高 44。

### 护字层(页脚披露段 / 版权行 / 404 三块)

- **纯色底上完全不可见**:`.info` 框内 [12,12,13] = 框外 [12,12,13] = 远处底色 [12,12,13](`--x-scrim` 与 `--x-bg` 同值)。
- 活粒子下:框内平均亮度 0.01042、框外 0.00369(未开护字层时框内 0.01841)→ 衰减 **43%**,边缘按 blur14 摊成 ~28px 缓坡。矩形能被看出来,但那正是护字层该做的事,不作扣点。
- 三处配方不同:`.info` inset -18/-28 blur14、`.copy` inset -14/-24 blur14、`.blk` inset -18/-28 blur16。同一件器物三套参数,列为观察(下文)。

### 宽度

390 / 1024 / 1935 / 2560 × 9 路由:**横向溢出 0 处**。1920 下画布 zoom 1.3333 全站等比,无破例(逐元素比宽,唯二异常是我 key 撞号造成的假匹配,回查后排除)。

---

## 扣分清单

### 1 · P1 ·【新增缺陷】磨砂底板在首页三语**完全不生效**,内页只发挥 64%

主人本轮亲自拍板的「半透明磨砂」,像素层面首页一层磨砂都没有:导航底下的内容原样清晰透过来,和导航自己的字撞在一起。

**证据**(同一滚动位、冻结 rAF、只改一条声明,量导航条内的水平梯度能量 = 残留细节量):

| 变体 | 梯度能量 | 结论 |
|---|---|---|
| 线上现状 | **4.752** | 与「完全关掉 blur」无差别 |
| 关掉 `backdrop-filter`(对照组) | 4.742 | — |
| 只改 `animation-fill-mode: backwards` | 3.323 | 磨砂恢复 ~63% |
| 再把 alpha 挪进颜色 | **2.464** | 磨砂 100% |

鬼影峰值:现状 rgb(55,55,56) 压在底板 rgb(11,11,12) 上 = **1.65:1**、字形完全可读;修后 rgb(31,31,31) = 1.19:1、化成一片柔光。截图 `shots/ab-2400-cur.png`(「Scientific computing」「Climate modeling」整句可读、压着 logo 与时钟)vs `shots/nav-bothfix.png`;亮态同病 `shots/lightnav-cur.png`(「…UENTLY ASKED QUESTIONS」透过来压住字标)。页脚位 `shots/navcollide.png` 里三个下载键的边框直接穿过导航条。

**根因两条,叠加**:

**(a) 主因 —— 开场淡入动画把导航钉成了 Backdrop Root。**
`tokens.css:418` `html.x-boot .site-nav { animation: x-fade 0.6s ease 0.4s both; }`。`both` 让这条 opacity 动画**永久保持在 fill 态**(实测 `document.querySelector('.site-nav').getAnimations().length === 1` 一直是 1,`.x-boot` 也没人摘),于是 `.site-nav` 始终是个 backdrop root,`::before` 的 `backdrop-filter` 采不到页面内容。

判据:去掉动画 或 摘掉 `.x-boot` → 磨砂立刻回来(4.752 → 3.276);内页(`x-inner`,无 `x-boot`、`animationName: none`)本来就正常(2.304 vs 无 blur 2.529)。

**这也解释了为什么前几轮没抓到**:`prefers-reduced-motion: reduce` 下 tokens.css 第 519 行把这条动画清成 `animation: none`,磨砂就正常了——用 `reducedMotion:'reduce'` 跑探针(自动化默认姿势)看到的是好的,普通访客看到的是坏的。

**(b) 次因 —— `opacity` 与 `backdrop-filter` 同元素,把模糊结果按 alpha 压在「未模糊」的背景上。**
隔离对照页(已知答案):

| 写法 | 梯度能量 |
|---|---|
| `background-color: rgb(12 12 13 / .64)` + blur14(正确形) | **0.04** |
| `backdrop-filter: none` + 同 alpha(无磨砂) | 2.90 |
| `background-color: rgb(12 12 13)` + `opacity:.64` + blur14(**现状写法**) | **1.07** |

即现状只拿回 (2.90−1.07)/(2.90−0.04) = **64%** 的磨砂。

**修法(两处都只改写法,0.64 / 0.72 / 0.9 三个拍板值一个不动)**:

```css
/* tokens.css:418 —— 动画不再永久 fill;终态本就是元素自身 opacity:1,视觉等价 */
html.x-boot .site-nav,
html.x-boot .hero .scroll-hint,
html.x-boot .hero .note { animation: x-fade .6s ease .4s backwards; }

/* SiteNav.astro:103 —— alpha 挪进颜色,翻色改由 background-color 一条属性承担 */
.site-nav { --x-nav-tint: 12 12 13; --x-nav-a: .64; }
.site-nav.on-light { --x-nav-tint: 242 242 242; --x-nav-a: .72; }
:global(html.x-inner) .site-nav { --x-nav-a: .9; }
.site-nav::before {
  background-color: rgb(var(--x-nav-tint) / var(--x-nav-a));
  backdrop-filter: blur(14px) saturate(1.15);
  transition: background-color .25s linear;      /* 原来的 color .25s + opacity .2s 合成一条 */
}
.site-nav.flipping::before { --x-nav-a: 1; transition: background-color 0s; }
```

翻色行为不变:窗内瞬切到目标实底、窗后 alpha 淡回半透明(色已在目标值),与现注释描述的口径一致。

> 补一句:`.site-nav` 自己的 `--x-nav-a` 只是变量,不再有 `opacity` 参与合成,`::before` 的计算样式在修前修后都「读起来正确」——**这类缺陷只有像素能证伪**,建议把「导航条梯度能量 ≥ 无 blur 对照组的 80% 即判红」焊成机器门。

---

### 2 · P2 ·【新增缺陷 · 不对齐】三处文字掉出排印体系,落到 `body { line-height: 1.6 }`

`Base.astro:118` 的 `body { line-height: 1.6 }` 是个隐形尺子。全站扫「计算行高 = 1.6 且没有任何 ruler 能解释」的元素,只中三处(zh mono 的 1.6 是 CJK 密排不变量,已排除):

| 元素 | 实测行盒 | 该有的尺 | 后果 |
|---|---|---|---|
| 导航字标 `span`(28px display,三语 × 全部页面) | 44.8px | display 无 1.6 档 | 基线 62 vs 导航其余全部 52.39(**低 9.61px**);光学中心 54.5 vs 51.5(**低 3.0px**) |
| Mission `.idx`(12px mono,en/vi 各 6 个) | 19.2px | `.x-mono` 1.2 → 14.4px | 今天被 27.6px 的 `.name` 盖住,休眠缺陷 |
| zh `.price`(20px display,7 张设备卡) | 32px | `.x-display:lang(zh)` 1.15 → 23px | 继承了 `.x-mono:lang(zh)` 的 CJK 1.6;zh 设备卡比 en/vi 高 8px |

Mission `.idx` 这处是 A7「序号章脱离全局 `.x-mono`」的漏项:给了 font-family / font-size / letter-spacing,**没给 line-height**。

**修法**(三条,不动任何既有数值,只是把缺的那一格补上):

- `SiteNav.astro` 字标:`line-height: 1.2`(补完后基线回到 55 一线;要不要再动导航竖内衬 30/0 属主人待拍板项,本条只是把它拉回体系内)
- `MissionSection.astro:150 .idx`:补 `line-height: 1.2`
- `DevicesSection.astro:217 .price`:补 `line-height: 1.2`(与 en 同档;zh 想留呼吸就写 1.15 走 display 的 zh 尺)

---

### 3 · P2 ·【不对齐 · 既有】设备卡脚 `.cols` 用 `flex-start`,与站内同型行的 baseline 体例相反

`DevicesSection.astro:204` `align-items: flex-start` → 两列盒顶对齐(都是 89.16),但 20px 价格基线 108.16、12px 说明基线 100.16,**差 8.00px**,说明行整体浮高。裁图 `shots/cardfoot.png` 1:1 可见。

站内同型(小号 mono + 大号 display 同排)全部是 baseline:`MissionSection:146`、`NexContent:202`、`LearnTeaser:60`、`LearnArticle:216`。6 张卡 × 3 语 = 18 处。

**修法**:`.cols { align-items: baseline }`(一个词,两列都是 `flex:1`,宽度不变;说明多行时首行贴价格基线、向下生长,正是要的效果)。

---

### 4 · P2 ·【新增缺陷】EN `getting-started` 文章 meta 在 390 / 360 把日期拆行

`LearnArticle.astro:32` 的 meta 行是裸文本,`entry.data.updatedAt` 无保护,连字符成了断行点:

- W=390:`["Getting started · App version 3.7 · 2026-08-", "20"]`
- W=360:`["Getting started · App version 3.7 · 2026-", "08-20"]`

390 是主流手机宽度,而这是站内首篇指南。六篇 EN 文章只有这篇中(topic 标签最长),vi/zh 不中。

**修法**:日期套一层 `<span class="nw">`,`.nw { white-space: nowrap }`(或三段 `·` 分隔项各自 nowrap,更保险)。

---

### 5 · P3 ·【既有值 · 报主人】首屏副题 ink 右缘比下载键右缘短 18.12px

`.sub` 盒宽 `439.2`(HeroSection.astro:129)右贴 1400,但文字左对齐,首行 ink 只到 **1381.88**,与下载键行的硬边 1400 差 18.12px ≈ 1.9 个等宽字位。标题 ink 右缘 1280.94 是拍板的左对齐体例,不在此列;这一条只是「两个右贴件的可见右缘不齐」。

439.2 是主人看过的既有值,按「既有值 = 决定」我不动它,只报数据。若要收:把 `.sub` 宽度取成字位整数倍(43 × 9.6047 ≈ 413),或让副题也走 `text-align: right`。**建议先不动**——目前观感是「等宽文本自然的参差」,不是错位。

---

### 6 · P3 ·【既有 · 低】`/nex/ .list b` 无 `text-wrap`,第二行只剩一个词

「Device compute / output」「Check-ins & welcome / gift」——中列被 `minmax(140, 220)` 卡住必然折行,但没有 balance,孤词落单。5 项的那张表不中。

**修法**:`NexContent.astro .list b { text-wrap: balance }`(不改任何尺寸)。

---

## 观察(不扣分)

- **护字层三套参数**:`.info` inset -18/-28 blur14、`.copy` inset -14/-24 blur14、`.blk` inset -18/-28 blur16。同一件器物三组数,羽化宽与外扩量各不相同(页脚里 `.info` 与 `.copy` 的左羽化边差 4px)。视觉上量不出来,但作为体系是三把尺子;要归一就统一成 -18/-28 + blur14。
- **文内目录用 "01",正文小标题自带 "1."**:R45 已消掉同一行内的双编号,残留的是两种编号体例并存。涉及正文 md 文案,归主人。
- **hairline 体系自洽**:0.1 给非交互数据行(`/nex/ .list li`、对比表 `td`、`.mcard`),0.23 给交互行与结构线(FAQ / PoC / TOC / 相关文章 / learn 行 / 面板顶线)。唯一例外是 Trust `.card` 与 Path `.step` 的左竖线走 0.23(非交互)——那是装饰竖标,另一种角色。我原本准备按「R45 只把 /nex FAQ 提到 0.23、同页兄弟没跟」报一条,回源核完发现规则本身成立,撤回。

---

## 已排除清单

**主人已拍板(交底所列,一律不计)**:首屏标题字号与文案 · 窄屏不做第二套画布 · 信任五卡 4+1 · FAQ 右缘 · 正文行长全大写 · 页脚空档 · 排印档位数(9 display / 2 mono)· 导航小字 12px 下限与条高 · 画布 zoom 机制 · 导航底板 0.64/0.72/0.9 三档**数值** · 页脚透底 + 局部护字层 · 首屏底空 220 · 编号强调色 / 卡片淡入 / 陈述区结构 / 灯箱原尺寸 · mono 段落四把行高(1.2/1.45/1.5/1.85,实测确为四把)· mono 负字距 · 证书对与四列栅格差 · learn 卡 hover 0.92。

**待主人拍板(本轮不动)**:导航文字行内衬 30/0 与底板下缘加不加线 · 当前语言下划线位置 · vi Mega 行高 0.79 · 首屏标题拍 500ms · zh display 尺覆盖面 · 24 档 -0.01em 残留两处 · 小字压粒子既有族 · 20/32/54 三档各两套尺子 · `.xbtn` 幽灵键描边墨阶 · 证书对居中 · 目录条目「等宽 + 非大写」· 滑换按钮缓动曲线。

> 扣点 2 会碰到导航字标的垂直位置,与「导航竖内衬」待拍板项相邻——我只补了它缺失的 line-height(把它拉回体系),内衬 30/0 一个字没动,主人拍板时可把 55 这条新基线一并考虑。

**上一轮(工艺 7.5)修法复核 —— 逐条实测,全部真的修好,未发现新伤**:
文章页 CTA 箭头作用域已收窄(`.row .arr`,转化键未染色)· 版权行护字层 `width:fit-content` 生效(盒宽 251.4,未铺满 1360)· 404 三块护字层 + 按钮统一实心(几何 56/16/16 三语全等)· `/nex/` FAQ 行线逐条上线 + 末条下线 + 0.23 · `.q` 公式 `max(18px,24u)` 两处同源 · PoC 记号去定宽并与 FAQ 同 gap · `.related .name` 500/1.1 · `.related` gap 10(与 `.toc` 同)· 文章页 h1→meta 14。

**本轮其它改动复核**:行遮罩 `clip-path`(逐帧:宿主高度恒定、行距恒定、起滑前盒内零墨点,三语全过)· 护字层 token 化(`--x-scrim` 与 `--x-bg` 同值,纯色底完全不可见)· 焦点环 2.05uc · 语言尺 `:lang()`(404 三语块各归各尺)· 时钟 NBSP · 手机 /nex 放开定宽(390 零溢出)。

**我怀疑过、回源证伪、撤回的**:FAQ 六个 `+` 隔行换色(实测全 rgb(72,100,5),是缩图伪影)· 护字层在页面上是可见灰卡(实测框内外像素全等)· R45 把 `/nex/` 行线体系改乱(实测规则自洽)· 1920 下有元素不随画布等比(实测是我 key 撞号的假匹配)。

---

## 总分

# 7.5 / 10

**一句话理由**:所有量得出来的工艺都非常扎实——404 的 56/16/16、文章页 24 阶梯、learn 卡 322/22/24 全等、行遮罩逐帧零位移零漏墨、四档宽度零溢出、护字层像素级隐形、三语尺各归各——上一轮九条修法也逐条真修好了;但本轮主人亲自拍板的那件东西(半透明磨砂导航)在首页三语**一层磨砂都没上**,页面内容清清楚楚透过来压在导航自己的字上,而它的计算样式读起来完全正确、只有像素能证伪,再加上导航字标本身根本不在任何排印尺子上(基线比同排低 9.61px),扣的正是「工艺」这一维。
