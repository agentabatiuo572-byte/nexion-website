# R47c 定稿版黑盒验收 — Done-when 5/5 · 冒烟 6/6

- 验收人:r47c-review-blackbox(独立 tester,全部自测,未采信实现方数字)
- 产物锚:http://localhost:4399(HTTP 200);仓 HEAD = f51c169「R47.3+R47.4 滚动旋转增益重标定 + 网络二次加密」
- **版本判别:`__xbg.fl` 桌面=14 ✓ / 移动模拟=6 ✓ → 整轮有效**
- 工具:Playwright(Nexion-uniapp 依赖借道)headless Chromium;脚本 scratchpad/{probe,dw,smoke,smoke2}.mjs;截图同目录

## ① Done-when 逐条

### 1. 首屏点阵地球 — PASS
- 正面半球大陆可辨:亚洲大陆块 + 澳洲清晰(hero0.png / dw1_t0.png)
- 两时点(间隔 1.5s)对比 dw1_t0.png vs dw1_t1.png:球体转动、多条弧线(流光)推进、枢纽亮点亮度/位置变化明显
- `__xbg.fl === 14` ✓(流光计数即 14 条)

### 2. 常转 / reduced-motion / 暂停恢复 — PASS
- 静止 10s(200ms 采样 + 解卷绕):**44.99°/10s**,落在 33.8–56.3° 区间正中(标称 45°)
- reduced-motion 上下文:renders 2→2(2s 增量 0)、yaw 增量 0、两张画布区截图**逐字节相等** → 真静帧
- PAUSE BACKGROUND(页脚 [data-bg-toggle]):点击前 37 renders/600ms → 暂停后 **0/1200ms**,aria-pressed=true
- 暂停 2s+ 后恢复:点击后 100ms 窗内(页内 rAF 采样 12 帧/200ms)最大 yaw 跳变 **0.60° < 1.5°**;恢复后 37 renders/600ms 续转 ✓

### 3. 滚动 = 缩放 + 耦合旋转 — PASS
- r 顶部 414 → 页脚底 786.6,**比值 1.8999**(球随滚动放大),±10% 区间 1.71–2.09 内 ✓
- rAF 节拍匀速 scrollBy 22px/帧 × 2s(121 帧,2640px):总 yaw 2.2691 rad,扣常转份额 0.1569 rad → 耦合增量 **2.1122 rad vs 期望 2640×0.0008=2.1120 rad,比 1.0001**(±35% 内,几乎准确值)
- 瞬时长跳:top→bottom(13895px)单帧 yaw 最大 **5.24°**;bottom→top 单帧最大 **5.08°**,均 ≤~10° ✓
- 滚回顶部 r 复位:414→414,**偏差 0%**(≤2%)✓

### 4. 悬停变形 — PASS
- mouse.move 至陆地密集处 (640,340) 停 0.6s:hover_on.png 光标处点阵被径向推开成**大片凹陷空腔**,边缘点被压密
- 移开 1.1s 后:hover_off.png 凹陷消失、点阵复原(对照 hover_pre.png)
- 量化(画布 2d 像素回读,60×60 框绿色亮像素计数):pre 4 → hover **0** → post 22,与凹陷同向

### 5. 帧率 + console — PASS
- 1440×900 桌面:静止 2s **60.1 fps**、滚动 2s **60.6 fps**
- 390×844 触屏模拟(isMobile+hasTouch,DSF3,fl=6):静止 **60.2 fps**、滚动 **60.2 fps**
- 全部 ≥50 ✓(headless rAF 上限 60,四路全钉满 = 无掉帧;真机性能不在本环境覆盖面)
- 全程 console error/pageerror:**0**(desktop / reduced-motion / mobile 三上下文)

## ② 冒烟回归

### S1 导航锚点 HOW IT WORKS — PASS
- 点击后 1.8s 内采到 20 个不同 scrollY 中间值(3174→…→8295,带缓动)= 平滑滚动
- 到位后标题「Idle devices hold real compute.」top=83.95 > 导航条 bottom=73.69,**不被压住**(smoke_how.png)

### S2 语言切换 EN→中文→VI — PASS
- 经导航切换器实点:/zh/(lang=zh,title「NexGrid — 分布式 AI 算力…」,smoke_zh.png 全中文)→ /vi/(lang=vi,title越南语,smoke_vi.png)
- 两页画布均在且在转:renders +55/900ms、yaw 在动、fl=14;三语 console error 均 0

### S3 设备叠卡滚动编舞 — PASS
- 区内 15% 进度(smoke_dev_a.png):NX-02 Cloud Share + NX-03 NexGridBox S1;75% 进度(smoke_dev_b.png):推进至 NX-06/NX-07 Rack 卡
- 数值证据:6 个元素 transform 变化,卡片 translateX 543.4/1096.4→0 + scale 0.9974→0.85(横向推进收拢)

### S4 TRUST 证书灯箱 — PASS
- 点 cert-msb 图 → 灯箱开(CLOSE 可见,MSB 证书大图,smoke_lightbox.png);html overflow:hidden
- 开着时 CDP 真实滚动手势 scrollY 10495→10495 **锁定**;Esc → 关(CLOSE 消失、overflow 复原 visible、scrollY 复原原位 10495);关后手势滚动 10495→10790 **解锁** ✓
- (仪器备注:首轮用程序化 scrollBy 误判 lock=false——规范上 overflow:hidden 只挡用户输入不挡脚本滚动;已换 Input.synthesizeScrollGesture 复测,且先做了「未开灯箱手势能滚」的探针对照)

### S5 手机菜单 390 — PASS
- .menu-toggle 开:aria-expanded=true、#nav-menu 全屏可见(smoke_mobile_menu2.png:五链接+EN/VI/中文+DOWNLOAD)
- 开着时真实手势 scrollY 466→466 **锁定**;再点关:aria-expanded=false、菜单隐藏;关后手势 466→564 恢复滚动 ✓

### S6 全站 console 扫描 — PASS
- 首页(EN/zh/vi)+ /nex/ + /learn/getting-started/(各含半页滚动停留):console error + pageerror 合计 **0**;二内页画布均存活(hasXbg=true)

## 附注
- 无头截图暗反转为已知环境问题;本站自带暗色,证据图均未见反转伪影,灯箱白底证书图渲染正常。
- 数据与实现方自测如有出入,以上述实测为准(本轮未发现矛盾项)。
