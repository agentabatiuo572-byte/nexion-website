## P0
无
## P1
无
## P2
1. R30 焦点环 2px 半退化:视口 1440–1454(经典滚动条)R45 `--x-vw` 令 zoom 0.9896–0.9993,Chrome 把 outline 宽按设备像素下取整(1.979→1),焦点环成 1 设备 px;1439/1455 为 2,HEAD 的 `100vw/1440` 此区间恒 1。仅此 15px 窗口。
2. A1 提案「canvas 淡入挂 `html.x-boot`」落地为 `html.js #x-bg`:刷新到 y=5200 背景 1s 淡入重放(t100 opacity .40),导航/标题不重放。声明≠实现。
3. reduced 首帧静帧画两次(`resize()` 内 drawStatic + 其后再画,renders=2),R45 引入;无视觉后果。
## 回归表
- R42 画布 zoom / =min(可用宽,1920)/1440;1439 zoom1 auto / 1439:1·auto;1440:.9896;1920:1.3229;2560:1.3333 宽1920 左右各312.5;几何门 `--reuse 4399` 复跑 exit0 / 已修保持
- R42 画布内无视口单位 / canvas-hazard 静态门 / 独立跑 pass;钉屏/灯箱显式 `/var(--x-zoom)` / 已修保持
- R39/R42/R43 叠卡裁屏缘、白带出血 / 不撑文档宽;2560 无黑边 / 5 档 maxCardRight>可用宽,scrollWidth=clientWidth,越界 0;band 0–2545 / 已修保持
- R8 区带序 / hero→stats→social→mission→devices→白带6块→final-cta / DOM 同序(how,path,trust,nex,learn-entry,faq);三语同形 / 已修保持
- R8 叠卡几何+编舞 / 锚 27.43/16.63 宽 45.14 STEP 1.0923;拍距=区高,总高=(N+1)·区高,末态 .85 / 27.43/16.63/45.14,STEP 710;两档屏 secH 6400=8·800;k=1 .85/落锚/候位 710;k=7 七卡 .85 x0 / 已修保持
- R8 幕布 / decked 加 .curtain,-mt 区高,z10 盖钉屏尾 / mt −800,z10>1;k=N−1 幕顶=钉底;k=N 幕顶=钉顶;k=N+.5 随页滚走 / 已修保持
- R41 钉屏居中 / top=(vh/zoom−区高)/2 / 1440×900 54.5/53.8;2560×1440 186.8/186.5 / 已修保持
- R8 移动兜底 / ≤860/coarse/reduced 竖排静态列 / 390·860·reduced·coarse:不 decked/static/纵序/不溢出;861 decked / 已修保持
- R2/R4/R6 粒子 / 静止零重渲只流光跑;滚动驱动跨界变形;五姿态 / 1s renders 1→1 而像素在变;滚 900 renders 1→2 再恒 2;姿态常量同 R6 / 已修保持
- R2/R6 鼠标 / 倾斜+推斥,静止吸附 / tiltX −.0083,renders 2→21;静止后 60→60 / 已修保持
- R2 reduced+原生光标 / 静帧、Lenis 关、直出;无自定义光标 / renders 恒 2,非黑,无 lenis,不 decked;resize 后重画非黑;产物无 cursor:none / 已修保持(P2-3)
- 三语 parity+硬编码 / key 树全等、引用存在;模板无未 key 文案 / en 185 三语等;106 引用 0 死;同文串仅品牌/SKU 名,硬字只在 legal 英文岛 / 已修保持
- 红线 / 禁用词 0、无 PENDING、legal 在、无背书 / dist 33 页 0 命中;legal 6 页;背书词 0 / 已修保持
- R7/R37/R31 导航翻墨 / 过白带黑字亮板、出带白字暗板、白带滚出即翻回;翻墨态 ink 深档 / 进带 Δ117ms 瞬切 2 色,末态 #0c0c0d/#f2f2f2 .72 blur14;出带白/#0c0c0d .64;on-light ink #486405,下划线/描边同 / 已修保持(R38 错峰按 B5 替换)
- R7/R45 首载四拍 / x-boot 仅首页 navigate;#stats 跟副题拍 / nav@300 0→@1300 1;stats@1300 0→@2200 1;刷新 y5200 无 x-boot、nav t100 1 / 已修保持
- R9/R35/R36 下载键 / URL 空→禁用实底护字 dim 字,零死链 / 6 键 aria-disabled,bg #0c0c0d 字 .62;空 href 0 / 已修保持
- R44 证书 / 缩略 660w + 灯箱 @2x 1160w 不放大 / 660/1160 各 2;显示 705px;滚轮只滚灯箱、关闭行 sticky;Esc 关、Lenis 复 / 已修保持
- A11 元数据 / canonical=og=sitemap 尾斜杠,hreflang 4,favicon 三件,404 noindex / 33 路由 0 差;ico/apple 180² 有效;内链 0 死 / 已修保持
- 触达 44 / 导航/页脚/指示器/按钮/FAQ ≥44 画布 px / 390·1024·1440·1920·2560 全 ≥44;门 F 绿 / 已修保持
- R30 focus 可见 / 2px 柠檬环,白带深柠檬 / 黑区 rgb(158,220,29)、白带 rgb(72,100,5);宽见 P2-1 / 半退化
- R45 aria / 滑层 aria-hidden、.x-sr、无角色宿主无 aria-label / xbtn 齐(灯箱关闭键纯文本,R44 原样);x-sr 50 个 1×1;lr/tw 层 hidden;无角色 label 0 / 已修保持
- R44 排印砍档 / display 9 档、mono 2 档、700 只给按钮 / 120/100.8/88/54/40/32/28/24/20 +zh 115.2;mono 12/16 +zh 12.5/16.56;700 仅按钮/strong / 已修保持
- R9/R10 导航 / 时钟贴 LOGO、扰动 hover 还原 / `UTC 09:52 PM` 紧邻 LOGO;hover 30 帧变体后还原 / 已修保持
- R11–R18 首屏 / vi 同 en 字号,标题 ≤3 行,副题/note 2 行;竖线 2px 热柠檬渐变;数字条无顶线 / en 100.8 2 行 sub/note 2 行;vi 3 行;zh 115.2 2 行;tick 2px 热柠檬→10%;#stats 无顶线 / 已修保持
- R43 锚点净空+视差换算 / 目标不被导航压;位移除以 zoom / 1440/1920 净空 9.95/9.80;屏幕位移=inline×zoom / 已修保持
- R29–R38 品牌 / brand-parity + particle-hue / #9edc1d/#0a0a0a=App 暗块配对,ink 引用;三端 78.8/77.1/77.1° vs 79.5°,标注=代码 / 已修保持
- R4 白底只给信息面 / 内页无 .x-invert 只 .x-paper / learn/nex/legal/文章 x-invert 0、x-paper 1–6 / 已修保持
- R30 页脚实底;R41/R43 导航羽化带 / — / B1 拍板改透底;R45 删改磨砂 / 已替换(拍板)
- R35 纸面禁用键 / 实底随语境翻转 / 无消费点(onLight 未用) / 无法测
- 机器门 / verify 8/8 / exit 文件 0(晚于 dist);几何门独立复跑 exit0 / 已修保持
