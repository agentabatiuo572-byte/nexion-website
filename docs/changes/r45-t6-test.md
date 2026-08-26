# R45 · T6 独立黑盒验收 — 行遮罩裁切 / 几何 / 经典滚动条 / 页脚透底 / Mission 窄屏

结论先行:**PASS 4/5**。AC2 / AC3 / AC4 / AC5 全部子项实测达标;**AC1 fail**——/vi/ 15 个 `[data-lr]` 标题里 7 个在遮罩终态相对无遮罩态有非零像素差(每个 5–18 px,全是贴着遮罩边缘的 1px 条带:越南语叠加声调顶部 / 下点(dấu nặng)底部 / 圆形字底被切 1 行),含首屏 h1(「mạnh」的下点底行被切)。en 首屏 h1 第二行「p」的降部完好(diff = 0)。裁切只存在于揭示动画期间(实测 h1 遮罩存活 ≈1.1 s 后还原纯文本),reduced-motion 下不拆行、无此问题。

## 环境

| 项 | 值 |
|---|---|
| 对象 | 构建产物 http://localhost:4399/ (/、/vi/、/zh/),只读,未起停服务 |
| 引擎 | Playwright Chromium(借 Nexion-uniapp 的 playwright),device scale 1 |
| 脚本 | `C:/Users/jason/AppData/Local/Temp/claude/D--WORKS-PLAN/42e4397e-0bc4-4987-8cc3-a0bc8464e0bd/scratchpad/t6-lib.mjs`、`t6-ac1.mjs`、`t6-ac1-zoom.mjs`、`t6-ac1-restore.mjs`、`t6-ac2.mjs`、`t6-ac3.mjs`、`t6-ac4.mjs`、`t6-ac5.mjs`(同目录);原始输出 `t6-ac*.out.json`;证据图 `t6-ac1-<lang>-<i>-{masked,unmasked,zoom}.png`、`t6-ac4-<w>-footer-{canvas,nocanvas}.png` |
| 静态几何 | `reducedMotion:'reduce'`(AC2 / AC3 / AC5),等 `fonts.ready` + networkidle + 0.8 s |
| 遮罩终态量法(AC1) | 非 reduced;经 route 在每个 `/_astro/*.css` 末尾追加 `.lr-inner{transition:none!important}`(`.in` 加上即到终态、无 transitionend → 不还原、拆行 DOM 与 overflow:hidden 遮罩持续存在)+ `#x-bg{visibility:hidden}` 去粒子;每个标题:滚入视口 → 等所有 `.lr-inner.in` → 稳定性护栏(间隔 250 ms 两张遮罩截图必须逐像素相同)→ 注入 `.lr-line{overflow:visible!important}` 截图 → 撤销后再截一张自检(全部 self-diff = 0)。像素差 = 任一通道不同(n0),并附通道差 >8 的计数(n8) |
| 经典滚动条(AC3) | `chromium.launch({ ignoreDefaultArgs:['--hide-scrollbars'] })`,每档断言 `clientWidth < innerWidth`(实测滚动条 15 px) |

## 逐条 AC

| AC | 判定 | 证据(原始数字) | 脚本 |
|---|---|---|---|
| AC1-a /vi/ 15 个 `[data-lr]` 遮罩终态 vs 无遮罩 像素差 = 0(1440×900) | **fail**(7/15 非零) | 见下表;非零者:#0 h1 8px、#3 h2 5px、#4 p 7px、#7 h3 14px、#8 h3 18px、#12 h3 14px、#13 h2 8px;其余 8 个 = 0。所有 15 个 stable=true、self-diff=0、拆行 DOM 在截图时仍在(stillSplit>0)、`.lr-line` computed overflow=hidden、`.lr-inner` transition 0s / transform none | t6-ac1.mjs、t6-ac1-zoom.mjs |
| AC1-b / 首屏 h1 第二行「p」降部不被裁 | pass | en h1「NexGrid / Let compute flow」2 行,整体 diff n0=0/n8=0(区域 310 863 px),逐行 [0,0] [1,0] | t6-ac1.mjs |
| AC2-a en 390/414/430/480 `#mission .body p` 两句右缘 < 视口宽且不被 `#mission` 裁 | pass | Range 右缘:390/414/430 → p1 352.94、p2 333.34;480 → p1 352.94、p2 441.06。`#mission` 右缘(overflow hidden)= 375/399/415/465,视口 390/414/430/480;文本左缘 20,盒宽 335/359/375/425,`scrollWidth==clientWidth`;文档无横向溢出(scrollWidth = 375/399/415/465) | t6-ac2.mjs |
| AC2-b /zh/ 390 `#mission .state` 行数 = max-width:100% 下最少行数 | pass | 现状 1 行(computed max-width 已是 100%,宽 285.13 / 父 335,32px/36.8px);强制 max-width:100% → 1 行;max-width:none → 1 行 | t6-ac2.mjs |
| AC3-a 经典滚动条 1440/1600/1920 `.x-canvas` 右缘 ≤ clientWidth | pass | 1440:右缘 1425 = clientWidth 1425(`--x-vw` 1425px,zoom 0.989583);1600:1585 = 1585(zoom 1.10069);1920:1905 = 1905(zoom 1.32292);三档滚动条均 15 px | t6-ac3.mjs |
| AC3-b 首屏 `.hero .left` 左空档 vs `.hero .cluster` 右空档(到 clientWidth)差 ≤1 | pass | 1440:39.578 / 39.578(差 0);1600:44.016 / 44.016;1920:52.906 / 52.906;(1439:39.547 / 39.547;2560:365.828 / 365.828) | t6-ac3.mjs |
| AC3-c 1439 vs 1440 页面总高变化 ≤1% | pass | scrollHeight 13145 → 13051,变化 0.715% | t6-ac3.mjs |
| AC3-d 2560 `.x-canvas` 在 clientWidth 内居中(左右差 ≤1) | pass | clientWidth 2545,canvas x 312.5 → 2232.5(宽 1920,zoom 1.33333),左 312.5 / 右 312.5,差 0 | t6-ac3.mjs |
| AC4-a 1440 与 2560 `.site-footer` 背景透明 | pass | 两档 computed background-color `rgba(0, 0, 0, 0)`,background-image none(position relative、z-index 1、overflow hidden) | t6-ac4.mjs |
| AC4-b 页脚区内粒子可见(亮度 >60 占比 >1%) | pass | 非 reduced,滚到底等 2 s,截页脚矩形(1440:1425×653;2560:1921×880),与 `#x-bg` 隐藏后的同区截图相减:归因于 canvas 的亮像素占比 1440 = **6.67%**(1 s 后复采 6.60%),2560 = **4.59%**(复采 4.56%);裸亮度占比 canvas 显示 9.04% / 7.76%,隐藏 2.57% / 3.31%(仅文字)。截图 `t6-ac4-1440-footer-canvas.png` 可见绿色线场透过页脚 | t6-ac4.mjs |
| AC4-c 2560 页脚左右无实底硬边 | pass | 页脚矩形 x 312.5→2232.5(宽 1920,不出血)。内侧 ±8px elementFromPoint 链:FOOTER.site-footer(透明)→ .x-canvas(透明)→ .x-frame(透明)→ body #0c0c0d;外侧 ±8px:CANVAS#x-bg(fixed 全宽地色 rgb(12,12,13))→ body。隐藏 canvas 后横跨左右边缘各 24 列 × 200 行的像素条:24 列均值全部 = (12,12,13),两侧同色无台阶。1440 页脚满铺 1425 宽,内侧链同上,外侧不适用 | t6-ac4.mjs |
| AC4-d 页脚小字对 #0c0c0d 对比度 ≥4.5:1 | pass | `.disclaimer`、`.copy`、`nav a`×2 均 `rgba(255,255,255,0.62)` 12px、祖先 opacity 1;合成到 #0c0c0d 后 **7.72:1**(纯白 19.55:1);html `--x-bg` 实为 #0c0c0d | t6-ac4.mjs |
| AC5-a 导航翻色阈值随条高(1440 加载 → 390 / 1920) | pass | 390:导航高 54(fixed),白带文档 top 4907.16;逐 px 滚动,`.on-light` 首次出现于 scrollY 4844,此时白带 top **63.16**(前一像素 64.16 未翻),期望 54+10 = 64,偏差 −0.84。1920:导航高 98.95,翻转于 scrollY 8616,白带 top **108.20**(前一像素 109.20 未翻),期望 108.95,偏差 −0.75。两档均 ±3 内;`.x-invert` 仅 1 个 | t6-ac5.mjs |
| AC5-b PoC 手风琴打开后答案 p 左缘 = `.q` 左缘(±1) | pass | 1440 点 summary 后 `details.open=true`;p 盒左 63.328 = p 文本左 63.328 = `.q` 文本左 63.328(差 0;p margin-left 24,mark 宽 11.875)。附 390:44 = 44 | t6-ac5.mjs |
| AC5-c /zh/ `.wordmark` line-height / font-size ≈0.79 | pass | 1440:94.8px / 120px = **0.79**(盒高 93.81);附 390:40.053 / 50.7 = 0.79 | t6-ac5.mjs |
| AC5-d /zh/ 白带五块卡文 line-height 全同 | pass | How `.stack .body`×3、Path `#path .desc`×2、Trust `#trust .card p`×5、NEX `#nex .desc`×3、FAQ `#faq .item p`×6 → 19 个元素 computed line-height 全为 **20px**(font-size 均 12.5px);390 下同样全为 20px | t6-ac5.mjs |

### AC1-a 明细:/vi/ 1440×900,15 个 `[data-lr]`

| # | 元素 | 行数 | diff n0 / n8 | 差异位置(裁掉的墨) |
|---|---|---|---|---|
| 0 | h1 `x-display-mega` [load]「NexGrid / Để sức mạnh / tính toán tuôn chảy」100.8px | 3 | **8 / 8** | 1 行 × 8 px:第 2 行「mạnh」的 ạ **下点底行**被遮罩下缘切掉(放大图 `t6-ac1-vi-0-zoom.png`:圆点底部平切;遮罩态像素 = 背景 12,无遮罩态 36–102 灰墨) |
| 1 | h2「28.432+ thiết bị …」54px | 2 | 0 / 0 | — |
| 2 | h2 `.state`「Mạng lưới tính toán những gì」54px | 1 | 0 / 0 | — |
| 3 | h2「Thiết bị nhàn rỗi chứa sức mạnh tính toán thực.」40px(亮区,bg 242) | 2 | **5 / 5** | 1 行 × 5 px,行 0 底缘 |
| 4 | p「NexGrid đưa nó đến đúng công việc đang cần.」40px | 2 | **7 / 5** | 1 行 × 7 px,行 0 底缘 |
| 5 | h3「Tải xuống & kết nối」54px | 2 | 0 / 0 | — |
| 6 | h3「Tác vụ AI chạy tự động」54px | 2 | 0 / 0 | — |
| 7 | h3「Nhận thanh toán bằng USDT」54px | 3 | **14 / 14** | 2 行 × 7 px,行 0/1 交界 |
| 8 | h3「Bắt đầu miễn phí với điện thoại」54px | 2 | **18 / 14** | 行 0 **顶缘**,横跨 360 px 的散点:ắ / ầ / ễ / í 叠加声调顶端各被切 1 行(`t6-ac1-vi-8-zoom.png`) |
| 9 | h3「Mở rộng với NexGridBox」54px | 1 | 0 / 0 | — |
| 10 | h3「Nó là gì」40px | 1 | 0 / 0 | — |
| 11 | h3「Cách nhận」40px | 1 | 0 / 0 | — |
| 12 | h3「Dùng để làm gì」40px | 1 | **14 / 11** | 1 行 × 8 px,底缘(墨深达 41,即几乎实心的一行) |
| 13 | h2「Để những thiết bị nhàn rỗi của bạn làm việc.」40px | 1 | **8 / 7** | 1 行 × 8 px,底缘 |
| 14 | div `.wordmark`「NexGrid」120px(页脚) | 1 | 0 / 0 | —(连同 `.site-footer{overflow:visible}` 一起打开也是 0) |

合计 74 个像素分布在 7 个标题,每处都是紧贴 `.lr-line` 上缘或下缘的**单行**。

**复现步骤(fail)**:① `node <scratchpad>/t6-ac1.mjs /vi/` 打印上表并在 scratchpad 落 masked/unmasked PNG;`node t6-ac1-zoom.mjs` 生成 8× 放大对比图。② 手工:1440×900 打开 /vi/,在页面 JS 运行前注入 `.lr-inner{transition:none!important}`(DevTools 本地覆盖 CSS 或 overrides),h1 会停在拆行遮罩终态;切换 `.lr-line{overflow:visible}` 对比「mạnh」下点的底部一行 / 「Bắt đầu miễn phí」的声调尖端。③ 不冻结也能看:把 `.lr-inner` 的 transition-duration 改成 20 s,揭示结束前那几秒即是被切状态。

**运行时补充(非冻结对照,t6-ac1-restore.mjs)**:正常加载 /vi/,h1 在 69 ms 拆行、503 ms 加 `.in`、1603 ms 收到 transitionend 还原纯文本(遮罩存活 ≈1.10 s = 0.9 s 过渡 + 末行 180 ms 延迟);滚完全页后 15/15 都已还原(`.lr-line` = 0)。因此对读者的实际表现是:揭示动画的最后约 1 秒里这些字形边缘缺 1 px,还原瞬间补回;reduced-motion 用户不拆行、完全无此问题。

[INFERRED] 成因族(供实现方核,不是修法指令):`.lr-line{overflow:hidden}` 两轴都裁;纵向只预留 .1em(mega .22em/.2em、vi 顶部另 .1em),越南语叠加声调与下点、圆形字底在 40–100 px 字号下超出预留 ≤1 px;横向 0 预留,内容宽度盒的末字形墨迹外扩(见「额外发现」en 的右缘族)直接被右缘切。

## 额外发现(不计入 AC 判定)

1. **en 右缘裁切族(AC1 范围外的 en 其余 14 个)**:/ 15 个里 4 个非零,全部是**右缘 1–2 列**:#1 h2「28,432+ devices …」7 px(1 列 × 7 行,行 0 末字形);#2 h2「What the network computes」14 px(末字「s」右侧弧被平切,`t6-ac1-en-2-zoom.png`);#8 h3「Start free with your phone」7 px;#9 h3「Scale with NexGridBox」9 px(2 列 × 28 行,「x」右侧)。其余 11 个(含 h1、wordmark)= 0。/zh/ 15 个里 14 个 = 0,#8「用手机免费开始」1 px 且通道差仅 1(噪声级)。
2. **无头默认环境的 15 px 沟槽伪影(环境提示,不是站点缺陷)**:默认 headless(`--hide-scrollbars`)下 1440 视口 `clientWidth`=1440 但 `--x-vw`=1425、`.x-canvas` 右缘 1425、首屏右空档 54.58 vs 左 39.58(差 15);1920 / 2560 同样差 15。[INFERRED] 原因:`html{scrollbar-gutter:stable}` 在该模式下仍预留经典滚动条的 15 px,但滚动条不绘制,于是 `documentElement.getBoundingClientRect().width`(站点取 `--x-vw` 的来源)≠ `clientWidth`。经典滚动条模式(AC3)两者一致、全部对称;真机 overlay 滚动条不预留沟槽 [KNOWN]。其它 tester 在默认 headless 下看到右侧 15 px 空档时请先排除此项。
3. 观察(无判定):/zh/ 白带五块卡文 computed font-size 在 1440 与 390 下均为 12.5px(line-height 20px);仅记录数字,是否偏小由设计侧定。

**PASS 4/5**(子项 17/18:仅 AC1-a fail)
