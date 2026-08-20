# 2026-08-20 · 全站视觉重做:axiom.peppermint.id 风格(主人指令)

状态:Implemented(待主人验收)。Done-when 回测:①三语+子页新皮 console=0 ✓(29 项探针)②粒子动画+鼠标推斥运行时帧证 ✓;reduced 静帧/Lenis 关/直出 ✓ ③交互 7 项逐项 PASS ✓ ④typecheck 0 错+verify 4/4+build 33 页 ✓ ⑤移动端:布局/原生横滑/菜单开合/无光标 ✓ ⑥i18n json 零 diff(git 可证)✓。
排坑记录:本机 Windows 暗色主题致 Chromium 无头/遮挡窗非确定性强制暗色(反白板块被翻;站点代码经最小复现页洗清;可见 GPU 窗正确)——协议与配方已进仓 CLAUDE.md Heads-up;`meta color-scheme=dark` 已加(保护真实 Android Auto-Dark 用户)。证书 PNG 降采样 660w(原件 .trash)。

原始指令:主人 2026-08-20 直接下令,方向即签字:「内容不变但是样式给我100%copy这个网站」+「有很多鼠标滑动和交互动效的,你不要漏了」

## Why

主人指定参考站 https://axiom.peppermint.id/ 作为新的视觉方向。内容(i18n 文案 / 板块 / 数据 / 链接逻辑)全部不变,仅换设计语言与交互层。

## What changes

**设计语言**(自研实现,不复制参考站代码/文案/图片资产;设计方向与参数为不可版权的风格事实):

- 配色:近黑 `#0c0c0d` 底 + 反白 `#f2f2f2` 亮区块 + 琥珀金 `#da840a` 强调;深浅区块交替
- 字体:Funnel Display(标题/陈述,400/500)+ Space Mono(标签/正文,400/700),@fontsource 自托管;zh 回退系统中文黑体
- 版式:全出血布局(非居中容器)、超大 display 标题(clamp 80→164px,行高 ~0.8,-4% 字距)、等宽大写小标签、序号编号(01/NX-01)作装饰、键值琥珀高亮 chip
- 交互(主人点名不许漏):
  1. 全屏固定 canvas 洛伦兹吸引子粒子背景(2 万点金色渐层、慢旋转、鼠标推斥 + 倾斜跟随、4 条流星拖尾;移动端降密、reduced-motion 静帧)——替换 cobe 地球
  2. Lenis 平滑滚动(reduced-motion 关)
  3. 自定义琥珀圆点光标(fine pointer 限定,交互元素 hover 放大)
  4. 滚动进场 reveal(IntersectionObserver + CSS,stagger)
  5. 导航实时 UTC 时钟(等宽,冒号闪烁)
  6. 设备板块 pinned 横向滚动轨(sticky + 进度驱动 translateX;移动端原生横滑降级)
  7. 按钮 hover 文字滑出/滑入(slide-swap,300ms)+ 链接 hover 降透明
- 技术:删 @astrojs/react/react/react-dom/cobe(站内不再有 React 岛,全 vanilla);新增 lenis + @fontsource 两字体包
- tokens.css 改为本仓自有 SoT(不再镜像 App dark tokens——主人本指令覆盖旧规;CLAUDE.md 同步改)

## Out of scope

- i18n 三语 json 零改动(无新 key;chrome 元数据行复用 stats.* 既有 key)
- 业务逻辑零改动:下载键 env 门/零死链、SSE/快照双模、SKU 契约、Legal 文本、learn 内容、锚点 id 全保留
- PRD 不同步(纯视觉,无功能契约变化)

## Done-when(P6 逐条回测)

1. 三语首页 + /nex + /learn + /learn/[slug] + legal 全部新皮渲染,console error = 0(Playwright 真浏览器)
2. 粒子背景运行时真在动且鼠标推斥生效(帧间 diff 证明);reduced-motion 下静帧、Lenis 关、reveal 直出
3. 交互清单 7 项逐项实景验证(时钟走秒、光标跟随+hover 放大、按钮滑字、横向轨随滚动位移、reveal 触发、Lenis 平滑、链接 hover)
4. `npm run typecheck` 0 错;`npm run verify` exit 0(禁用词/三语 parity/部署门/锚点);`npm run build` 成功
5. 移动视口(375px)可用:布局不破、横向轨降级原生滑动、菜单可开合、无自定义光标
6. i18n json 与 lib 数据文件 diff = 0(内容不变的机器证明)
