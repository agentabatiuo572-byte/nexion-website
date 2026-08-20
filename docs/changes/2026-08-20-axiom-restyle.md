# 2026-08-20 · 全站视觉重做:axiom.peppermint.id 风格(主人指令)

状态:Implemented(待主人验收)。Done-when 回测:①三语+子页新皮 console=0 ✓(29 项探针)②粒子动画+鼠标推斥运行时帧证 ✓;reduced 静帧/Lenis 关/直出 ✓ ③交互 7 项逐项 PASS ✓ ④typecheck 0 错+verify 4/4+build 33 页 ✓ ⑤移动端:布局/原生横滑/菜单开合/无光标 ✓ ⑥i18n json 零 diff(git 可证)✓。
排坑记录:本机 Windows 暗色主题致 Chromium 无头/遮挡窗非确定性强制暗色(反白板块被翻;站点代码经最小复现页洗清;可见 GPU 窗正确)——协议与配方已进仓 CLAUDE.md Heads-up;`meta color-scheme=dark` 已加(保护真实 Android Auto-Dark 用户)。证书 PNG 降采样 660w(原件 .trash)。

原始指令:主人 2026-08-20 直接下令,方向即签字:「内容不变但是样式给我100%copy这个网站」+「有很多鼠标滑动和交互动效的,你不要漏了」

## R2(2026-08-20 主人验收反馈六条,当日修)

1. **性能**:粒子引擎重构——主体轨迹按颜色分桶批量描边(20 次 stroke 替代上万次)+ 离屏缓存 + dpr 钉 1;实测鼠标连续移动帧间隔 16.6ms(约 60fps),卡顿消除。
2. **背景行为对齐原版**:静止时不旋转不缩放(吸附定格,主体零重渲染),只有流光沿轨迹跑;**滚动**才驱动缩放/旋转(Lenis 速度喂入);鼠标倾斜+推斥保留。
3. **鼠标**:自定义圆点光标移除,恢复原生光标。
4. **产品卡**:接入 App 仓产品实拍图(App PRODUCT_PHOTO 映射同款;Share 无图=等高线,与 App 一致;照片降采样 JPEG 64-91KB,原件 .trash)。
5. **叠卡交互**:设备板块横向轨改为滚动叠卡(sticky 逐张叠上,6px 阶梯露边);fx 的 rail 模块删除。
6. **文字底色**:小字密集板块/页面(NEX/学习中心/FAQ/NEX 详情/文章/Legal)一律不透明底,禁文字直压粒子线;大字陈述区(hero/社证/使命/收尾/页脚)保留粒子透底。
7. **导航层叠**:改为参考站哲学——导航在内容之下(z1<z2),反白区块滑上来直接盖过导航,白字白底冲突消除;移动菜单展开时导航整体提层。
   R2 验证:10/10 专项探针 + 10 页×三语 console=0 + 移动端叠卡/无溢出;typecheck/verify/build 全绿。

## R3(2026-08-20 主人两条追改,当日修)

1. **设备卡对齐原版卡板块**(主人截图指正「卡太大」):卡改约 44vw 宽、图上文下、序号章贴图角、底部两栏等宽小字,浮于暗底;交互改「新卡自右滑入、逐张落锚叠住前一张」(fx.ts initDeck,滚动驱动、缓出落位;移动/reduced 静态纵列)。R2 的满屏 sticky 叠卡废弃。
2. **纸白节奏**(主人指正「半黑半白难看」):R2 黑底补丁方向反了——参考站语言=宣言黑底/内容纸白。NEX/学习中心/FAQ 三板块 + 四个子页(NEX 详情/学习列表/文章/Legal)全部翻 x-invert 纸白;子页顶部留 84px 黑带保导航可见。配套:--x-accent-ink 文字琥珀 token(纸底自动换深琥珀 #8a5405,对比度达标)+ x-invert 内 xbtn/细线自动适配 + stats 脚注对比度修复(Lighthouse a11y 两处清零)。
   R3 验证:6/6 专项探针(纸白三板块/深琥珀/deck 段高/滑入叠落时序/子页黑带/全路由 console=0);typecheck/verify/build 全绿。
   排坑:途中一次正则替换弄破 StatsBar 样式块(CSS 断裂只有 build/dev 编译能抓,类型门与 verify 门不解析 CSS)→ 修复后把 build 前置到探针之前;dev server 在 CSS 管线报错后 module graph 中毒(计算样式对、渲染错位)→ 冷重启后正常,再次印证「可疑实例证据全重取」。

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
