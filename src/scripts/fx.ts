/* 全站交互引擎 R47(axiom 方向,自研实现;参数规格见 PRD/specs/WEBSITE-axiom-teardown.md)。
   ① 洛伦兹蝴蝶背景（恢复最后历史版 8e4c7a3）：五姿态链式插值，静止时缓存主体、流光沿轨迹运行；
      保留当前手机护字层与动态偏好切换。首绘 1s zoom-fade 由 CSS 承担；暂停/减弱动态下 resize 重画静帧。
   ② Lenis:duration 1.2 + easeOutExpo(恒定收尾时长的「奢滑」);站内锚点补间 + 目标获焦;修饰键点击放行原生。
   ③ 行遮罩逐行上滑(display 标题唯一进场方式;可访问文本走 .x-sr,不给无角色宿主挂 aria-label)
   ④ 打字机:R45 改「影子层定版面、打字层叠打」——不再按 ch 数猜宽度(CJK 一字 1em、chip 内衬、右对齐都曾因此折行/跳动),
      注册即隐藏原文(不再「满亮再清空」),终态还原纯文本。
   ⑤ data-rv 次要块 reveal(阈值 .05/底-20px,位移 12px);进场结束加 .rv-done 把过渡交还给元素自己的 hover 规则。
   ⑥ 设备 deck:整排连续推进传送带(恒一步差,无显隐翻转),步距 1.0923 卡宽;桌面编舞时卡图改 eager(裁切框挡住了 lazy 预取)。
   ⑦ 三列滚动视差(反白卡区);⑧ UTC 时钟(秒奇偶冒号,锁墙钟秒)。
   首载四拍编排由 html.x-boot + CSS 时间线承担(仅首页 navigate 型导航,Base.astro 头部内联脚本在首帧前判定)。
   reduced-motion:全部降级直显。 */
import Lenis from 'lenis';
import { renderLorenzRaster } from './lorenz-raster';
import type { LorenzRasterReply } from './lorenz-raster.worker';

/* 🔴 「引擎到货了」的信号,必须在模块**最顶上**挂,不能等 boot():
   [data-rv] 的隐藏初始态由 html.js 开启(内联脚本首帧前就挂,bundle 挂掉也照挂),
   而解除隐藏靠的是本模块的 IntersectionObserver 加 .in。bundle 一失败,首页 35 个内容块
   永远停在 opacity:0,/nex/ 连 H1 都是 data-rv、整页近乎空白。
   兜底的条件只能是「引擎没到货」(html.js:not(.fx)),不能是「超时」——
   data-rv 是滚动进场,单纯超时会让整页提前全显。挂在顶上是为了尽早熄掉那条兜底动画:
   延迟到 DOMContentLoaded 才挂,慢网上会先闪一下再被隐藏。 */
document.documentElement.classList.add('fx');

const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
let reduced = motionQuery.matches;
/* 偏好可能在页面已打开后变化；所有长驻 JS 动效共用这一个可变状态和事件。 */
motionQuery.addEventListener('change', (event) => {
  reduced = event.matches;
  document.dispatchEvent(new CustomEvent('x:motion-preference', { detail: reduced }));
});
const coarse = matchMedia('(pointer: coarse)').matches;
/* 开场钟:四拍的 CSS 时间线锚在 html.x-boot 落地(首帧前),JS 拍(标题)以本模块执行时刻近似锚点 */
const BOOT_T0 = performance.now();
/* 首屏四拍必须共用一个钟:副题/下载/数字条走 CSS 的 html.x-boot 动画(锚点 = 元素首次渲染),
   标题走这里的 setTimeout(锚点 = fx 模块执行时刻)。两者之差 = JS 到达延迟,慢网上能到 1–3 秒,
   于是标题会排到副题后面(1.5Mbps 实测晚 17–49ms、0.75Mbps 晚 366ms)。取两个锚点里更早的那个。 */
const PAINT_T0 = (() => {
  try {
    return performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? BOOT_T0;
  } catch {
    return BOOT_T0;
  }
})();
const BEAT_T0 = Math.min(BOOT_T0, PAINT_T0);

let lenisInst: Lenis | null = null;
/* 文档锁按引用计数:菜单与灯箱共用 documentElement.style.overflow,各自 close 时无条件清空,
   谁先关谁就把另一层的锁也解了(当前三重互斥使真实操作不可达,但新增第三个锁主时会复活) */
let lockN = 0;
const scrollLock = (on: boolean) => {
  lockN = Math.max(0, lockN + (on ? 1 : -1));
  document.documentElement.style.overflow = lockN > 0 ? 'hidden' : '';
  if (!lenisInst) return;
  if (on) lenisInst.stop();
  else if (!reduced) lenisInst.start();
};

/* 可用视口宽(html 布局宽,不含经典滚动条/滚动条槽)→ --x-vw,画布缩放系数的输入(tokens.css 以 100vw 兜底)。
   why:100vw 含滚动条而 fixed/流盒不含,Windows 经典滚动条 15px 曾让 1440–1935 宽画布多 15px 被裁。
   不用 clientWidth:无头/隐藏滚动条环境下它不减 scrollbar-gutter 的槽宽,与布局分家(实测 1440 vs 1425)。 */
const setVw = () =>
  document.documentElement.style.setProperty('--x-vw', `${document.documentElement.getBoundingClientRect().width}px`);

/* ---------- ① 洛伦兹吸引子背景 ----------
   恢复自最后蝴蝶版 8e4c7a3（地球替换提交 0aa0e53 之前）。
   几何、配色与滚动姿态沿用原版；保留当前手机护字、暂停缩放与动态偏好兼容。 */
function initLorenz() {
  const canvas = document.getElementById('x-bg') as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return;

  /* 底色只有一个真源(tokens.css 的 --x-bg)。此前这里写了两处 `#0c0c0d` 字面量,
     改品牌底色时改不到 —— 画布会和页面差一个色。开局读一次,读不到才退回字面量。 */
  const BG = getComputedStyle(document.documentElement).getPropertyValue('--x-bg').trim() || '#0c0c0d';
  const N = coarse ? 8000 : 20000;
  const pts = new Float32Array(N * 3);
  let ax = 0.1,
    ay = 0,
    az = 0;
  const step = () => {
    const dx = 10 * (ay - ax);
    const dy = ax * (28 - az) - ay;
    const dz = ax * ay - (8 / 3) * az;
    ax += 0.005 * dx;
    ay += 0.005 * dy;
    az += 0.005 * dz;
  };
  for (let i = 0; i < 6000; i++) step();
  for (let i = 0; i < N; i++) {
    step();
    pts[i * 3] = ax;
    pts[i * 3 + 1] = ay;
    pts[i * 3 + 2] = az;
  }
  let cu = 0,
    cv = 0,
    cw = 0;
  for (let i = 0; i < N; i++) {
    cu += pts[i * 3];
    cv += pts[i * 3 + 1];
    cw += pts[i * 3 + 2];
  }
  cu /= N;
  cv /= N;
  cw /= N;

  const px = new Float32Array(N);
  const py = new Float32Array(N);
  const dep = new Float32Array(N);
  // 流光必须沿已经显示的那一帧运行，不能提前使用尚未绘完的投影。
  const shownX = new Float32Array(N);
  const shownY = new Float32Array(N);

  const stride = coarse ? 3 : 1;
  const TB = 20;
  const DB = 3;
  const tBucket = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const t = Math.max(0, Math.min(1, (pts[i * 3 + 2] - 2) / 46));
    tBucket[i] = Math.min(TB - 1, Math.floor(t * TB));
  }
  const groupStyle: string[] = [];
  for (let b = 0; b < TB; b++) {
    const t = (b + 0.5) / TB;
    /* R30 同相位:暗端→亮端全程与品牌 #9EDC1D 同 hue(~79°)。
       R38:色相由 verify 门 particle-hue 守——下面两行标注是门的读取点,改字面量必同步改标注。
       HUE-GUARD:dark-end (40, 55, 7)
       HUE-GUARD:bright-end (190, 245, 52) */
    const r = Math.round(40 + 150 * t);
    const g = Math.round(55 + 190 * t);
    const bl = Math.round(7 + 45 * t);
    for (let d = 0; d < DB; d++) {
      const mMid = -1 + ((d + 0.5) * 2) / DB;
      const alpha = Math.max(0, Math.min(1, (0.12 + 0.48 * t) * (1 + 0.4 * mMid)));
      /* R33:透明度预乘为亮度、线条层全不透明(黑底+screen 合成下等效)——
         段接头/交叉重画只是同色覆盖,物理上无法增亮 → 串珠亮点根治 */
      groupStyle.push(`rgb(${Math.round(r * alpha)},${Math.round(g * alpha)},${Math.round(bl * alpha)})`);
    }
  }

  const body = document.createElement('canvas');
  const bctx = body.getContext('2d', { alpha: false })!;
  /* R32:辉光离屏——线条图的模糊副本承载「点燃带」,与线条层同帧贴合成;
     只在主体重渲时烘焙一次,帧循环零滤镜成本 */
  const glow = document.createElement('canvas');
  const gctx = glow.getContext('2d')!;

  /* 护字渐变只在几何变化时烘焙；帧循环只合成一张透明位图，避免每帧创建渐变对象。 */
  const copyShield = document.createElement('canvas');
  const sctx = copyShield.getContext('2d')!;

  let W = 0,
    H = 0;

  /* 移动首页护字区：粒子参数与运动原样保留，只在最终合成后把标题/副题每一行背后的
     局部亮度柔和压回底色。按真实换行盒取材，三语自然跟随；桌面分支完全不进入。 */
  interface CopyShield {
    left: number;
    top: number;
    right: number;
    bottom: number;
    padX: number;
    padY: number;
  }
  const mobileHeroQuery = matchMedia('(max-width: 860px)');
  const isHome = document.documentElement.hasAttribute('data-home');
  let copyShields: CopyShield[] = [];
  let copyShieldCssHeight = 0;
  const refreshCopyShields = () => {
    copyShields = [];
    if (mobileHeroQuery.matches) {
      const canvasRect = canvas.getBoundingClientRect();
      const canvasScaleX = canvasRect.width / W || 1;
      const canvasScaleY = canvasRect.height / H || 1;
      for (const element of document.querySelectorAll<HTMLElement>('.hero h1, .hero .sub, .hero .sub2')) {
        const revealLines = [...element.querySelectorAll<HTMLElement>(':scope > .lr-line')];
        const rects = revealLines.length
          ? revealLines.map((line) => {
              const box = line.getBoundingClientRect();
              const inner = line.querySelector<HTMLElement>('.lr-inner');
              if (!inner) return box;
              const range = document.createRange();
              range.selectNodeContents(inner);
              const ink = [...range.getClientRects()].filter((rect) => rect.width > 0);
              if (!ink.length) return box;
              const left = Math.min(...ink.map((rect) => rect.left));
              const right = Math.max(...ink.map((rect) => rect.right));
              const top = Math.min(box.top, ...ink.map((rect) => rect.top));
              const bottom = Math.max(box.bottom, ...ink.map((rect) => rect.bottom));
              return {
                left,
                right,
                top,
                bottom,
                width: right - left,
                height: bottom - top,
              };
            })
          : (() => {
              const range = document.createRange();
              range.selectNodeContents(element);
              return [...range.getClientRects()];
            })();
        for (const rect of rects) {
          if (rect.width <= 0 || rect.height <= 0) continue;
          const title = element.matches('h1');
          copyShields.push({
            left: (rect.left - canvasRect.left) / canvasScaleX + scrollX,
            top: (rect.top - canvasRect.top) / canvasScaleY + scrollY,
            right: (rect.right - canvasRect.left) / canvasScaleX + scrollX,
            bottom: (rect.bottom - canvasRect.top) / canvasScaleY + scrollY,
            padX: Math.max(title ? 24 : 16, rect.height * (title ? 0.48 : 0.6)),
            padY: Math.max(title ? 14 : 10, rect.height * 0.28),
          });
        }
      }
    }
    copyShieldCssHeight = copyShields.length
      ? Math.max(H, Math.ceil(Math.max(...copyShields.map((zone) => zone.bottom + zone.padY))))
      : 0;
    copyShield.width = Math.max(1, Math.round(W * DPR));
    copyShield.height = Math.max(1, Math.round(copyShieldCssHeight * DPR));
    sctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    sctx.clearRect(0, 0, W, copyShieldCssHeight);
    // The homepage veil handles the scene; feathered line shields also protect
    // long copy against bright moving flights, including after announcement changes.
    sctx.globalAlpha = isHome ? 0.72 : 0.94;
    for (const zone of copyShields) {
      const outerTop = zone.top - zone.padY;
      const outerBottom = zone.bottom + zone.padY;
      const outerHeight = outerBottom - outerTop;
      const edgeStop = Math.min(0.42, zone.padY / outerHeight);
      const vertical = sctx.createLinearGradient(0, outerTop, 0, outerBottom);
      vertical.addColorStop(0, 'transparent');
      vertical.addColorStop(edgeStop, BG);
      vertical.addColorStop(1 - edgeStop, BG);
      vertical.addColorStop(1, 'transparent');
      sctx.fillStyle = vertical;
      sctx.fillRect(zone.left, outerTop, zone.right - zone.left, outerHeight);

      const cy = (zone.top + zone.bottom) / 2;
      const ry = outerHeight / 2;
      for (const cx of [zone.left, zone.right]) {
        sctx.save();
        sctx.translate(cx, cy);
        sctx.scale(zone.padX / ry, 1);
        const cap = sctx.createRadialGradient(0, 0, 0, 0, 0, ry);
        cap.addColorStop(0, BG);
        cap.addColorStop(Math.max(0.5, (zone.bottom - zone.top) / outerHeight), BG);
        cap.addColorStop(1, 'transparent');
        sctx.fillStyle = cap;
        sctx.fillRect(-ry, -ry, ry * 2, ry * 2);
        sctx.restore();
      }
    }
    sctx.globalAlpha = 1;
    dbg.shieldLines = copyShields.length;
  };

  const drawCopyShields = () => {
    if (!copyShields.length || !copyShieldCssHeight) return;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(copyShield, 0, 0, copyShield.width, copyShield.height, -scrollX, -scrollY, W, copyShieldCssHeight);
    ctx.restore();
  };

  interface Pose {
    cx: number;
    cy: number;
    scl: number;
    yaw: number;
    pitch: number;
  }
  const poseHome = (): Pose => ({ cx: 0.5 * W, cy: 0.54 * H, scl: Math.min(W, H) / 44, yaw: 0, pitch: 0 });
  const poseA = (): Pose => ({ cx: 0.33 * W, cy: 0.68 * H, scl: Math.min(W, H) / 65, yaw: 1.25, pitch: 0.5 });
  const poseB = (): Pose => ({ cx: 0.65 * W, cy: 0.5 * H, scl: Math.min(W, H) / 62, yaw: -1.55, pitch: 1.15 }); /* R26:回参考真值 0.5——v4/v5 两轮抬高实测引发顶裁+底空,三路评审同向证伪 */
  const poseC = (): Pose => {
    const u = (Math.min(W, H) / 32) * 1.85;
    return { cx: 0.5 * W - 6 * u, cy: 0.5 * H + 14.25 * u, scl: Math.min(W, H) / 32, yaw: 0.4, pitch: 1.1 };
  };
  const poseD = (): Pose => ({ cx: 0.56 * W, cy: 0.52 * H, scl: Math.min(W, H) / 28, yaw: 0.2, pitch: 1.05 });
  /* R21 重绑(R8 区序重排后旧绑定错位:页尾最大姿态 D 曾锚在页中 mission → 粒子过大):
     statement→A(左下小) about→B(右中景) 叠卡→C(特写) 收尾黑区→D(最大);白带段被盖住 */
  const ANCHOR_IDS = ['social', 'mission', 'devices', 'final-cta'];
  let anchors: (HTMLElement | null)[] = [];
  const smooth = (e: number) => e * e * (3 - 2 * e);
  /* dly:延迟起混(0-1,占进区行程比例)——特写档 C 若从区顶入视口即起混,
     会提前撑大上一屏(mission)的背景;延后 35% 行程,mission 停位时 C≈0(R23) */
  const prog = (el: HTMLElement | null, dly = 0) => {
    if (!el) return 0;
    const raw = Math.max(0, Math.min(1, (innerHeight - el.getBoundingClientRect().top) / innerHeight));
    const e = dly > 0 ? Math.max(0, Math.min(1, (raw - dly) / (1 - dly))) : raw;
    return smooth(e);
  };
  const mix = (a: Pose, b: Pose, p: number): Pose => ({
    cx: a.cx + p * (b.cx - a.cx),
    cy: a.cy + p * (b.cy - a.cy),
    scl: a.scl + p * (b.scl - a.scl),
    yaw: a.yaw + p * (b.yaw - a.yaw),
    pitch: a.pitch + p * (b.pitch - a.pitch),
  });

  const mouse = { x: -9999, y: -9999 };
  let tiltX = 0,
    tiltY = 0,
    driftX = 0,
    driftY = 0;
  let dirty = true;
  let mouseStamp = 0,
    renderedStamp = -1;
  let rG = -1,
    rCx = 0,
    rCy = 0,
    rYaw = 99,
    rPitch = 99;
  const dbg = { kind: 'lorenz', points: N, comets: coarse ? 0 : 4, frames: 0, shieldLines: 0, renders: 0, quality: 1, worker: false, tiltX: 0, tiltY: 0, driftX: 0, driftY: 0 };
  (window as unknown as Record<string, unknown>).__xbg = dbg;

  /* R36:高分屏适配——渲染精度乘 DPR(性能上限 1.5:主体重渲像素 ≤2.25×,离屏缓存机制不变) */
  let DPR = 1;
  let rasterWorker: Worker | null = null;
  let rasterReady = false;
  let rasterBusy = false;
  let rasterEpoch = 0;
  let rasterId = 0;
  let rasterTimeout = 0;
  let rasterSyncNext = true;
  type RasterPose = { cx: number; cy: number; G: number; yaw: number; pitch: number; stamp: number };
  let queuedPose: RasterPose | null = null;
  const disableRasterWorker = () => {
    clearTimeout(rasterTimeout);
    rasterWorker?.terminate();
    rasterWorker = null;
    rasterReady = rasterBusy = dbg.worker = false;
    queuedPose = null;
    dirty = true;
  };
  const resize = () => {
    rasterEpoch++;
    rasterSyncNext = true;
    queuedPose = null;
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    DPR = Math.min(window.devicePixelRatio || 1, 1.5);
    /* R47.5:物理像素预算 ≤5.5M(评审在无显卡软光栅下量到 2560 掉帧;有头 GPU 实测 60fps,
       此为高 DPR × 超宽组合的保险,常规机型不触发)——超预算等比降内部分辨率 */
    if (W * H * DPR * DPR > 5.5e6) DPR = Math.max(0.75, Math.sqrt(5.5e6 / (W * H)));
    for (const c of [canvas, body, glow, cometLayer]) {
      c.width = Math.round(W * DPR);
      c.height = Math.round(H * DPR);
    }
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    bctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    gctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    cctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    refreshCopyShields();
    dirty = true;
    /* 没有帧循环的两种状态都必须在 resize 清空位图后补静帧。 */
    if ((reduced || userPaused) && W > 0 && H > 0) drawStatic();
  };

  const renderBody = (cx: number, cy: number, G: number, yaw: number, pitch: number, synchronous = false) => {
    const asynchronous = !synchronous && dbg.renders > 0 && rasterReady && rasterWorker;
    // 不排队旧鼠标位置；任务完成后，下一帧直接提交最新姿态。
    if (asynchronous && rasterBusy) return false;
    const ca = Math.cos(yaw),
      sa = Math.sin(yaw),
      cb = Math.cos(pitch),
      sbn = Math.sin(pitch);
    const rc1 = cu * sa + cv * ca;
    const rc2 = cu * ca - cv * sa;
    const cen1 = rc1 * cb - cw * sbn;
    const cen2 = rc1 * sbn + cw * cb;
    const mx = mouse.x,
      my = mouse.y;
    const repelOn = !coarse && mx > -9000;

    for (let i = 0; i < N; i++) {
      const X = pts[i * 3],
        Y = pts[i * 3 + 1],
        Z = pts[i * 3 + 2];
      const n = X * ca - Y * sa;
      const c2 = X * sa + Y * ca;
      const m = Math.max(-1, Math.min(1, (c2 * cb - Z * sbn - cen1) / 22));
      const p = 1 + 0.22 * m;
      let x = cx + (n - rc2) * G * p;
      let y = cy - (c2 * sbn + Z * cb - cen2) * G * p;
      if (repelOn) {
        const ddx = x - mx;
        const ddy = y - my;
        const d2 = ddx * ddx + ddy * ddy;
        if (d2 >= 1 && d2 < 25600) {
          const d = Math.sqrt(d2);
          const f = 90 * (1 - d / 160) ** 2;
          x += (ddx / d) * f;
          y += (ddy / d) * f;
        }
      }
      px[i] = x;
      py[i] = y;
      dep[i] = m;
    }

    if (asynchronous) {
      rasterBusy = true;
      try {
        // structured clone 保留主线程工作数组；显示数组只随完整位图一起更新。
        rasterWorker!.postMessage({ type: 'raster', epoch: rasterEpoch, id: ++rasterId,
          width: W, height: H, dpr: DPR, px, py, dep });
        rasterTimeout = window.setTimeout(disableRasterWorker, 5000);
        return true;
      } catch { disableRasterWorker(); }
    }
    renderLorenzRaster(bctx, gctx, W, H, DPR, px, py, dep, tBucket, stride, groupStyle);
    shownX.set(px);
    shownY.set(py);
    dbg.renders++;
    return true;
  };

  const requestBody = (pose: RasterPose) => {
    if (!renderBody(pose.cx, pose.cy, pose.G, pose.yaw, pose.pitch, rasterSyncNext)) {
      queuedPose = pose;
      return;
    }
    queuedPose = null;
    rasterSyncNext = false;
    dirty = false;
    renderedStamp = pose.stamp;
    rG = pose.G;
    rCx = pose.cx;
    rCy = pose.cy;
    rYaw = pose.yaw;
    rPitch = pose.pitch;
  };

  let comet = 0;
  const TAIL = 180;
  const CB = 12; /* R34:衰减档 6→12,亮度台阶平滑 */
  /* R34:预乘不透明色(黑底离屏 + screen 合成)——接头/重画零增亮 */
  /* HUE-GUARD:comet (225, 255, 150) */
  const cometStyles = Array.from({ length: CB }, (_, k) => {
    const fade = 1 - (k + 0.5) / CB;
    const a = fade * fade * 0.88;
    return `rgb(${Math.round(225 * a)},${Math.round(255 * a)},${Math.round(150 * a)})`;
  });
  /* R34:流光独立离屏。旧实现逐点位画 1 点距短段——涡内圈点距 <1px,
     每段退化成 1.55px 圆点,慢速区整条流光渲染成串珠(主人两次抓到的「小点」主源)。
     改连续折线:零长段物理消失;桶间共享端点在不透明覆盖下零增亮。 */
  const cometLayer = document.createElement('canvas');
  const cctx = cometLayer.getContext('2d', { alpha: false })!;
  const drawComets = () => {
    cctx.globalCompositeOperation = 'source-over';
    cctx.fillStyle = '#000000';
    cctx.fillRect(0, 0, W, H);
    cctx.lineWidth = 1.55;
    cctx.lineJoin = 'round';
    cctx.lineCap = 'round';
    for (let c = 0; c < 4; c++) {
      const head = Math.floor((comet + (N / 4) * c) % N);
      for (let cb2 = 0; cb2 < CB; cb2++) {
        const k0 = Math.floor((TAIL / CB) * cb2);
        const k1 = Math.floor((TAIL / CB) * (cb2 + 1));
        cctx.beginPath();
        const i0 = (head - k0 + N) % N;
        cctx.moveTo(shownX[i0], shownY[i0]);
        for (let k = k0 + 1; k <= k1; k++) {
          const i = (head - k + N) % N;
          cctx.lineTo(shownX[i], shownY[i]);
        }
        cctx.strokeStyle = cometStyles[cb2];
        cctx.stroke();
      }
    }
    ctx.drawImage(cometLayer, 0, 0, W, H); /* ctx 处于 screen 模式,黑底无效果 */
  };

  /* 静帧合成(reduced-motion 初绘与 resize 重画共用) */
  const drawStatic = () => {
    const P = poseHome();
    renderBody(P.cx, P.cy, P.scl, P.yaw, P.pitch, true);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'screen';
    ctx.drawImage(glow, 0, 0, W, H);
    ctx.drawImage(body, 0, 0, W, H);
    drawCopyShields();
  };

  let raf = 0;
  let running = false;
  const frame = () => {
    dbg.frames++;
    let P = poseHome();
    const ps = [prog(anchors[0]), prog(anchors[1]), prog(anchors[2], 0.35), prog(anchors[3])];
    P = mix(P, poseA(), ps[0]);
    P = mix(P, poseB(), ps[1]);
    P = mix(P, poseC(), ps[2]);
    P = mix(P, poseD(), ps[3]);
    const G =
      P.scl *
      (1 - 2.2 * ps[0] * (1 - ps[0])) *
      (1 - 2 * ps[1] * (1 - ps[1])) *
      (1 - 2 * ps[2] * (1 - ps[2])) *
      (1 - 2 * ps[3] * (1 - ps[3])) *
      (1 + 0.45 * ps[0] + 0.2 * ps[1] + 0.2 * ps[2] + 0.2 * ps[3]);

    if (!coarse && mouse.x > -9000) {
      const ex = (mouse.x - 0.5 * W) / (0.5 * W);
      const ey = (mouse.y - 0.5 * H) / (0.5 * H);
      driftX += (-8 * ex - driftX) * 0.035;
      driftY += (-8 * ey - driftY) * 0.035;
      tiltX += (0.04 * ex - tiltX) * 0.035;
      tiltY += (0.03 * ey - tiltY) * 0.035;
      if (Math.abs(-8 * ex - driftX) < 0.15) driftX = -8 * ex;
      if (Math.abs(-8 * ey - driftY) < 0.15) driftY = -8 * ey;
      if (Math.abs(0.04 * ex - tiltX) < 1.5e-3) tiltX = 0.04 * ex;
      if (Math.abs(0.03 * ey - tiltY) < 1e-3) tiltY = 0.03 * ey;
    } else {
      driftX *= 0.96;
      driftY *= 0.96;
      tiltX *= 0.96;
      tiltY *= 0.96;
      if (Math.abs(driftX) < 0.15) driftX = 0;
      if (Math.abs(driftY) < 0.15) driftY = 0;
      if (Math.abs(tiltX) < 1.5e-3) tiltX = 0;
      if (Math.abs(tiltY) < 1e-3) tiltY = 0;
    }

    const cx = (coarse ? 0.5 * W : P.cx) + driftX;
    const cy = (coarse ? 0.5 * H : P.cy) + driftY;
    const yaw = P.yaw + tiltX;
    const pitch = P.pitch + tiltY;

    dbg.tiltX = tiltX;
    dbg.tiltY = tiltY;
    dbg.driftX = driftX;
    dbg.driftY = driftY;

    const geometryChanged =
      mouseStamp !== renderedStamp ||
      Math.abs(G - rG) > 1e-3 ||
      Math.abs(cx - rCx) > 0.3 ||
      Math.abs(cy - rCy) > 0.3 ||
      Math.abs(yaw - rYaw) > 1e-4 ||
      Math.abs(pitch - rPitch) > 1e-4;
    if (dirty || geometryChanged) requestBody({ cx, cy, G, yaw, pitch, stamp: mouseStamp });
    else queuedPose = null;

    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'screen';
    ctx.drawImage(glow, 0, 0, W, H); /* R32:辉光垫底(点燃带) */
    ctx.drawImage(body, 0, 0, W, H);
    if (!coarse) {
      comet = (comet + 0.5) % N;
      drawComets();
    }

    drawCopyShields();
    if (running) raf = requestAnimationFrame(frame);
  };

  /* 用户按了暂停就不再自启(标签切回来触发的 visibilitychange 也不能把它带起来)。
     存储读写都包 try:隐私模式 / 禁用站点数据时 localStorage 会直接抛。 */
  const PAUSE_KEY = 'x-bg-paused';
  let userPaused = false;
  try { userPaused = localStorage.getItem(PAUSE_KEY) === '1'; } catch { /* 存储不可用:按未暂停处理 */ }
  const start = () => {
    if (running || reduced || userPaused) return;
    // 静帧会覆盖主体缓存；恢复时按当前滚动姿态重画一次，随后继续静止缓存。
    dirty = true;
    running = true;
    raf = requestAnimationFrame(frame);
  };
  const stop = () => {
    rasterEpoch++;
    queuedPose = null;
    running = false;
    cancelAnimationFrame(raf);
  };

  // 线条始终完整 DPR。昂贵的曲线光栅化离开主线程，鼠标/滚动/流光无需等待。
  // 不转移屏幕 canvas：不支持 Worker 时及暂停/减弱动态都可同步绘制同一份原版算法。
  if (typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined') {
    try {
      rasterWorker = new Worker(new URL('./lorenz-raster.worker.ts', import.meta.url), { type: 'module' });
      rasterWorker.onmessage = ({ data }: MessageEvent<LorenzRasterReply>) => {
        clearTimeout(rasterTimeout);
        if (data.type === 'ready') { rasterReady = dbg.worker = true; return; }
        if (data.type === 'error') { disableRasterWorker(); return; }
        rasterBusy = false;
        try {
          if (data.epoch !== rasterEpoch || data.id !== rasterId || data.width !== W || data.height !== H
            || data.dpr !== DPR || !running || reduced || userPaused) return;
          // 位图和其对应轨迹同批交付；没有流光提前跳到下一帧轨迹的窗口。
          bctx.setTransform(1, 0, 0, 1, 0, 0);
          bctx.drawImage(data.body, 0, 0);
          gctx.setTransform(1, 0, 0, 1, 0, 0);
          gctx.clearRect(0, 0, glow.width, glow.height);
          gctx.drawImage(data.glow, 0, 0);
          shownX.set(data.px);
          shownY.set(data.py);
          dbg.renders++;
        } catch {
          disableRasterWorker();
        } finally {
          data.body.close();
          data.glow.close();
        }
        // 合并忙时的所有输入，只补交最新姿态，省去等待下一次主线程 rAF 的空档。
        if (queuedPose && rasterReady) requestBody(queuedPose);
      };
      rasterWorker.onerror = (event) => { event.preventDefault(); disableRasterWorker(); };
      rasterWorker.addEventListener('messageerror', disableRasterWorker);
      rasterWorker.postMessage({ type: 'init', tBucket, stride, groupStyle });
      rasterTimeout = window.setTimeout(disableRasterWorker, 5000);
    } catch { disableRasterWorker(); }
  }

  resize();
  anchors = ANCHOR_IDS.map((id) => document.getElementById(id));
  addEventListener('resize', resize);
  /* 字体与开场行遮罩都会改变真实换行盒；各自稳定后重取一次，避免缓存过渡态几何。 */
  const refreshSettledCopyShields = () => {
    refreshCopyShields();
    if (reduced || userPaused) drawStatic();
  };
  document.addEventListener('x:hero-copy-layout', refreshSettledCopyShields);
  document.fonts?.ready.then(refreshSettledCopyShields);
  setTimeout(refreshSettledCopyShields, Math.max(0, BOOT_T0 + 2800 - performance.now()));
  /* #x-bg 首秒会从 1.05 倍缩回 1；护字位图与它同画布，首秒按当前变换逆算坐标并低频重烘，
     否则较早缓存的行盒会随 canvas 缩放漂离正在上滑的字。只跑这 1s，常驻帧零布局读取。 */
  if (mobileHeroQuery.matches && document.documentElement.classList.contains('x-boot')) {
    const syncBootCopyShield = () => {
      refreshCopyShields();
      const remaining = BOOT_T0 + 1050 - performance.now();
      if (remaining > 0) setTimeout(syncBootCopyShield, Math.min(100, remaining));
    };
    syncBootCopyShield();
  }
  let copyShieldResizeTimer = 0;
  addEventListener('resize', () => {
    clearTimeout(copyShieldResizeTimer);
    copyShieldResizeTimer = window.setTimeout(refreshSettledCopyShields, 260);
  });
  if (!coarse) {
    addEventListener(
      'mousemove',
      (e) => {
        mouse.x = e.clientX;
        mouse.y = e.clientY;
        mouseStamp++;
      },
      { passive: true },
    );
    document.documentElement.addEventListener('mouseleave', () => {
      mouse.x = -9999;
      mouse.y = -9999;
      mouseStamp++;
    });
  }
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  document.addEventListener('x:bg-pause', (e) => {
    userPaused = (e as CustomEvent<boolean>).detail === true;
    try { localStorage.setItem(PAUSE_KEY, userPaused ? '1' : '0'); } catch { /* 同上 */ }
    if (userPaused) { stop(); drawStatic(); } else start();
  });
  document.addEventListener('x:motion-preference', () => {
    refreshCopyShields();
    if (reduced) {
      stop();
      drawStatic();
    } else if (!document.hidden && !userPaused) {
      start();
    }
  });

  if (reduced) {
    drawStatic();
    return;
  }
  if (userPaused) {
    drawStatic(); // 上次就是暂停态:画一帧静帧,不起循环
    return;
  }
  start();
}

/* ---------- ② Lenis(duration 1.2 + easeOutExpo,恒定收尾时长) ---------- */
function initLenis() {
  if (reduced) return;
  const lenis = new Lenis({
    duration: 1.2,
    easing: (t: number) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
  });
  lenisInst = lenis;
  const raf = (t: number) => {
    lenis.raf(t);
    requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);
  document.addEventListener('x:motion-preference', () => {
    if (reduced || lockN > 0) lenis.stop();
    else lenis.start();
  });

  return lenis;
}

/* 站内 hash 的展开、聚焦和历史语义不依赖平滑滚动；初始 reduced-motion 也必须安装。 */
function initHashNavigation() {
  document.addEventListener('click', (e) => {
    /* R45:修饰键 / 非主键 / 已被处理的点击放行原生语义(Ctrl+click 开新标签等) */
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as HTMLElement).closest?.('a[href^="#"]') as HTMLAnchorElement | null;
    if (!a) return;
    const id = a.getAttribute('href')!.slice(1);
    const el = id && document.getElementById(id);
    if (!el) return;
    e.preventDefault();
    /* 目标在折叠 details 内时先展开再量位置/聚焦；对隐藏后代 focus 会静默失败。 */
    const closedDetails = el.closest<HTMLDetailsElement>('details:not([open])');
    if (closedDetails) closedDetails.open = true;
    /* R43:此前写死 84(屏幕量),而 [id]{scroll-margin-top} 是画布量、会随画布缩,
       两者在 >=1440 分家 16px —— 点击站内链接后目标标题被导航条压住(实测净空 -16.1px)。
       改为实测导航条高度,单位天然一致。 */
    const navBottom = document.querySelector('.site-nav')?.getBoundingClientRect().bottom ?? 0;
    const top = id === 'download' && el.classList.contains('floating')
      ? 0 : el.getBoundingClientRect().top + window.scrollY - navBottom - 10;
    if (lenisInst && !reduced) {
      // details 刚展开时自动尺寸观察尚未刷新；不能按旧文档高度截断本次跳转。
      lenisInst.resize();
      lenisInst.scrollTo(top);
    }
    else window.scrollTo({ top, behavior: 'auto' });
    // hash 没变就不 push:连点同一个锚点曾让 history 每次 +1(与原生片段导航口径不同,back 要按 N 次)
    let currentId = location.hash.slice(1);
    try { currentId = decodeURIComponent(currentId); } catch { /* 畸形旧 hash 按不同目标处理 */ }
    if (currentId !== id) history.pushState(null, '', `#${id}`);
    /* R45:原生片段导航会把键盘焦点起点移到目标,补间版也要——否则点完 Tab 又回到导航 */
    if (!el.hasAttribute('tabindex')) el.tabIndex = -1;
    el.focus({ preventScroll: true });
  });
}

/* Mobile conversion controls: one set of real links, also used by the desktop
   hero. A small scroll threshold avoids collapsing on touch/bounce jitter. */
function initMobileDownloads() {
  const dock = document.querySelector<HTMLElement>('.hero .dl-wrap');
  const options = document.getElementById('download-options');
  const toggle = dock?.querySelector<HTMLButtonElement>('.download-toggle');
  if (!dock || !options || !toggle) return;
  const narrow = matchMedia('(max-width: 860px)');
  let compact = window.scrollY > 48;
  let expanded = false;
  let pending = false;
  const render = () => {
    const mobile = narrow.matches;
    dock.classList.toggle('floating', mobile);
    document.documentElement.classList.toggle('mobile-download', mobile);
    options.toggleAttribute('data-lenis-prevent', mobile);
    const hideOptions = mobile && compact && !expanded;
    const hideToggle = !mobile || !compact || expanded;
    // Never leave keyboard focus in a control we are about to hide.
    if (hideOptions && options.contains(document.activeElement)) {
      toggle.hidden = false;
      toggle.focus({ preventScroll: true });
    }
    if (hideToggle && document.activeElement === toggle) {
      options.hidden = false;
      options.querySelector<HTMLElement>('a, button')?.focus({ preventScroll: true });
    }
    options.hidden = hideOptions;
    toggle.hidden = hideToggle;
    toggle.setAttribute('aria-expanded', String(!hideOptions));
  };
  const syncScroll = () => {
    pending = false;
    const next = compact ? window.scrollY > 8 : window.scrollY > 48;
    if (next === compact) return;
    compact = next;
    expanded = false;
    render();
  };
  toggle.addEventListener('click', (event) => {
    expanded = !expanded;
    render();
    if (expanded && event.detail === 0) options.querySelector<HTMLElement>('a, button')?.focus({ preventScroll: true });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !expanded) return;
    expanded = false;
    render();
    toggle.focus({ preventScroll: true });
  });
  document.addEventListener('click', (event) => {
    if (!expanded || dock.contains(event.target as Node)) return;
    expanded = false;
    render();
  });
  window.addEventListener('scroll', () => {
    if (!pending) { pending = true; requestAnimationFrame(syncScroll); }
  }, { passive: true });
  narrow.addEventListener('change', () => {
    compact = window.scrollY > 48;
    expanded = false;
    render();
  });
  window.addEventListener('pageshow', syncScroll);
  render();
}

/* ---------- ⑨ 证书放大(R44 · R45 锁滚) ----------
   原生 <dialog>:Esc 关闭、焦点管理、背景遮罩由浏览器负责;开启键是 <a href=大图>,无 JS 直接打开图片。
   R45:灯箱开着时 Lenis 仍吃滚轮去滚页面 → 打开即 stop、关闭即 start;dialog 自带 data-lenis-prevent 让滚轮进灯箱。 */
function initCertZoom() {
  const dlg = document.querySelector<HTMLDialogElement>('.cert-zoom');
  const img = dlg?.querySelector('img') as HTMLImageElement | null;
  if (!dlg || !img) return;
  /* R49-D6:灯箱桌面实渲仅 ~528px,letter 版式小字读不清(可用性实测)——补显式「查看原件」出口 */
  const orig = dlg.querySelector<HTMLAnchorElement>('.cert-orig');
  for (const btn of document.querySelectorAll<HTMLAnchorElement>('.cert-open')) {
    btn.addEventListener('click', (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // 修饰键放行:新标签打开原件(与锚点处理器同口径)
      if (typeof dlg.showModal !== 'function') return; // 无 <dialog> 的老浏览器:不拦默认动作,走 <a href> 原生打开
      e.preventDefault();
      img.removeAttribute('src'); // 先清上一张:盒子由 width/height 属性撑住,慢网首开不弹小白框、也不闪上一张
      img.src = btn.dataset.src ?? btn.href;
      if (btn.dataset.srcset) img.srcset = btn.dataset.srcset;
      img.alt = btn.dataset.alt ?? '';
      if (orig) orig.href = btn.dataset.src ?? btn.href;
      dlg.classList.add('is-loading'); // 慢网下大图要几秒,先给个加载态
      const settle = () => dlg.classList.remove('is-loading');
      if (img.complete) settle();
      else {
        img.addEventListener('load', settle, { once: true });
        img.addEventListener('error', settle, { once: true });
      }
      dlg.showModal();
      dlg.scrollTop = 0; // 必须在 showModal 之后:关闭态 dialog 无盒,赋值无效(重开曾残留上次滚动位)
      dlg.scrollLeft = 0;
      scrollLock(true); // 连 documentElement 的 overflow 一起管(计数式,见 scrollLock)
    });
  }
  dlg.addEventListener('close', () => scrollLock(false));
  dlg.addEventListener('click', (e) => {
    // 点背景关闭:按几何判「点在对话框盒子之外」——e.target===dlg 会把对话框自己的内衬带也当背景(点左缘 5px 即关)
    const r = dlg.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
  });
}

/* ---------- ③ 行遮罩逐行上滑(display 标题;P1-01) ---------- */
function initLineReveal() {
  const els = [...document.querySelectorAll<HTMLElement>('[data-lr]')];
  if (!els.length) return;
  if (reduced) {
    for (const el of els) el.classList.add('lr-ready');
    return;
  }

  /* 每个宿主一份状态:原文(重建要用)、是否已播(播完已还原成纯文本,重建无意义)、在途的观察器/定时器 */
  type LR = { original: string; played: boolean; io?: IntersectionObserver; timer?: number };
  const st = new Map<HTMLElement, LR>();
  const notifyHeroCopyLayout = (el: HTMLElement) => {
    if (el.closest('.hero')) document.dispatchEvent(new Event('x:hero-copy-layout'));
  };

  const finish = (el: HTMLElement, state = st.get(el)) => {
    if (!state) return;
    state.played = true;
    state.io?.disconnect();
    clearTimeout(state.timer);
    el.textContent = state.original;
    el.style.height = '';
    el.classList.add('lr-ready');
    notifyHeroCopyLayout(el);
  };

  const build = (el: HTMLElement) => {
    const s: LR = st.get(el) ?? { original: el.textContent ?? '', played: false };
    st.set(el, s);
    const original = s.original;
    const plainH = el.offsetHeight; // 拆行前的高度:动画期锁住,版面零位移
    // 直接读取原文的自然行;临时 inline-block 分词会破坏不可换行字符和 text-wrap:balance。
    const text = document.createTextNode(original);
    el.replaceChildren(text);
    const range = document.createRange();
    const lines: string[] = [];
    let lastTop: number | undefined;
    let start = 0;
    let offset = 0;
    for (const char of original) {
      range.setStart(text, offset);
      range.setEnd(text, offset + char.length); // 按码点前进,Range 偏移仍是 UTF-16。
      const rect = range.getBoundingClientRect();
      if (rect.width && rect.height && !/^\s+$/.test(char)) {
        if (lastTop !== undefined && Math.abs(rect.top - lastTop) > 2) {
          lines.push(original.slice(start, offset));
          start = offset;
        }
        lastTop = rect.top;
      }
      offset += char.length;
    }
    // 空白/零宽字符留在原文切片里;连续换行仍在相应行的文本中,不会丢失空行。
    lines.push(original.slice(start));
    el.textContent = '';
    /* R45:可访问文本走视觉隐藏节点(aria-label 在 div/p 这类无角色宿主上是 ARIA 禁止用法) */
    const sr = document.createElement('span');
    sr.className = 'x-sr';
    sr.textContent = original.trim();
    el.appendChild(sr);
    const inners: HTMLElement[] = [];
    for (let li = 0; li < lines.length; li++) {
      const outer = document.createElement('span');
      outer.className = 'lr-line';
      outer.setAttribute('aria-hidden', 'true');
      const inner = document.createElement('span');
      inner.className = 'lr-inner';
      /* 首屏(load 模式)逐行错拍 176ms 对齐参考站实测的 176.5;正文块保持 90 ——
         参考站正文是逐行独立触发、错拍随滚速浮动(实测 50–150),我方固定值反而更稳。 */
      inner.style.setProperty('--lrd', `${li * (el.dataset.lr === 'load' ? 176 : 90)}ms`);
      inner.textContent = lines[li];
      outer.appendChild(inner);
      el.appendChild(outer);
      inners.push(inner);
    }
    el.classList.add('lr-ready'); // 遮罩已建,宿主可见(内层仍在 110% 处,被 overflow 遮住)
    if (Math.abs(el.offsetHeight - plainH) > 0.5) el.style.height = `${plainH}px`; // 拆行盒子高度与纯文本不一致时锁高
    notifyHeroCopyLayout(el);
    const play = () => {
      if (reduced) {
        finish(el, s);
        return;
      }
      s.played = true;
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          inners.forEach((n) => {
            n.classList.add('in');
            n.parentElement?.classList.add('lr-open'); // 起滑同帧放开下边余量(等待期遮死,见 tokens.css)
          }),
        ),
      );
      const last = inners[inners.length - 1];
      const restore = () => {
        if (!el.querySelector('.lr-inner')) return;
        el.textContent = original; // 还原原始文本(a11y/选中/SEO 一致性)
        el.style.height = '';
        notifyHeroCopyLayout(el);
      };
      last.addEventListener('transitionend', restore, { once: true });
      /* 过渡被取消(播放中切「减少动态」/ 打印 / 祖先被隐藏)时 transitionend 永不到达,
         标题会永久停在拆行态;取消事件 + 总时长兜底各补一道 */
      last.addEventListener('transitioncancel', restore, { once: true });
      /* 步进要按本档的真值取:滚动档 90ms、开场档 176ms。写死 90 时,四行及以上的开场标题
         兜底会早于实际收尾(n=4 实测兜底 1370ms vs 收尾 1428ms),把最后一行提前拍回纯文本。 */
      const stepMs = el.dataset.lr === 'load' ? 176 : 90;
      s.timer = window.setTimeout(restore, stepMs * (inners.length - 1) + 900 + 200);
    };
    const mode = el.dataset.lr;
    /* 开场钟的延迟只属于首页开场(html.x-boot);刷新 / 后退 / 带锚点进来时不排队、建好即播——
       否则标题成了整屏最后出现的元素(实测刷新时 565ms 才起滑,导航与副题早已就位) */
    const delay = document.documentElement.classList.contains('x-boot') ? Number(el.dataset.lrDelay || 0) : 0;
    if (mode === 'load') {
      /* R45:标题拍锚在开场钟(boot+delay),不再是「字体就绪 + delay」——慢字体下曾漂到副题拍之后 */
      s.timer = window.setTimeout(play, Math.max(0, BEAT_T0 + delay - performance.now()));
    } else {
      const io = new IntersectionObserver(
        ([en]) => {
          if (en.isIntersecting) {
            io.disconnect();
            s.timer = window.setTimeout(play, delay);
          }
        },
        { threshold: 0.05, rootMargin: '0px 0px -20px 0px' },
      );
      s.io = io;
      io.observe(el);
    }
  };

  /* 未播放的宿主按当前字形与当前宽度重拆:视口变了(旋转 / 拖窗 / 缩放)旧行组就是过期的,
     字体在兜底到点之后才落地时,拆行是按回退字形量的(行数可能差一行) */
  const rebuild = (el: HTMLElement) => {
    const s = st.get(el);
    if (!s || s.played) return; // 播完已是纯文本,浏览器自己重排
    s.io?.disconnect();
    clearTimeout(s.timer);
    el.textContent = s.original;
    el.style.height = '';
    el.classList.remove('lr-ready');
    build(el);
  };
  let rt = 0;
  addEventListener('resize', () => {
    clearTimeout(rt);
    rt = window.setTimeout(() => {
      if (!reduced) els.forEach(rebuild);
    }, 200);
  });
  document.addEventListener('x:motion-preference', () => {
    if (reduced) els.forEach((el) => finish(el));
  });

  /* 每个标题只等自己那档字重**和自己那串字**(Mega 500:首屏标题与页脚字标;其余 400),不等 fonts.ready:
     等两档曾让 vi 慢网首屏标题跟着 400 子集晚到 1.4s;不带文本则只等含空格的那个子集(vi 叠音符子集不在内)。
     兜底必须早于副题拍,标题才一定先到;兜底后到的字体由上面的 rebuild 接手 */
  /* 兜底同样锚在 BEAT_T0(与副题的 CSS 拍同钟),不是「从现在起 N 毫秒」——
     后者在慢网下会跟着 fx 的到达一起顺延,而副题拍不会,于是 vi 的标题排到副题后面(实测晚 0.67s)。
     🔴 400 是从副题拍倒推的,不是随手取的:tokens.css 里 .hero .sub 的 animation-delay 是 0.55s,
        兜底必须小于它。改那一拍必须同步改这里 —— R46 把副题拍从 1.4s 提到 0.55s 时,
        原来的 600 就已经晚于副题拍了(慢字体下标题会反过来排在副题后面)。 */
  const cap = new Promise<void>((r) => setTimeout(r, Math.max(0, BEAT_T0 + 400 - performance.now())));
  for (const el of els) {
    const cs = getComputedStyle(el);
    const key = `${cs.fontWeight} 16px ${cs.fontFamily}`;
    const load = document.fonts ? document.fonts.load(key, el.textContent ?? '').catch(() => undefined) : Promise.resolve(undefined);
    Promise.race([load, cap]).then(() => {
      if (reduced) el.classList.add('lr-ready');
      else build(el);
    });
  }
  if (document.fonts) document.fonts.ready.then(() => {
    if (!reduced) els.forEach(rebuild);
  });
}

/* ---------- ④ 打字机(mono 眉标/编号;P1-02 · R45 影子层) ----------
   注册:原文放进 visibility:hidden 的影子层定版面(折行/宽度/内衬全部与终态一致),
   打字层叠在同一格子里逐字填;结束还原纯文本。CJK/chip/右对齐不再需要任何宽度预留。 */
function initType() {
  const els = [...document.querySelectorAll<HTMLElement>('[data-tw]')];
  if (!els.length) return;
  if (reduced) {
    for (const el of els) el.classList.add('tw-done');
    return;
  }
  const zh = /^(zh|ja|ko)(-|$)/.test(document.documentElement.lang || '');
  const originals = new Map<HTMLElement, string>();
  const finish = (el: HTMLElement, text = originals.get(el) ?? el.textContent ?? '') => {
    el.textContent = text;
    el.classList.remove('tw', 'tw-inline', 'tw-block');
    el.classList.add('tw-done');
  };
  const prep = (el: HTMLElement) => {
    const text = el.textContent ?? '';
    originals.set(el, text);
    const inline = getComputedStyle(el).display === 'inline';
    const sr = document.createElement('span');
    sr.className = 'x-sr';
    sr.textContent = text;
    const ghost = document.createElement('span');
    ghost.className = 'tw-ghost';
    ghost.setAttribute('aria-hidden', 'true');
    ghost.textContent = text;
    const live = document.createElement('span');
    live.className = 'tw-live';
    live.setAttribute('aria-hidden', 'true');
    el.replaceChildren(sr, ghost, live);
    el.classList.add('tw', inline ? 'tw-inline' : 'tw-block');
    return { text, live };
  };
  const run = (el: HTMLElement, text: string, live: HTMLElement) => {
    const speed = Number(el.dataset.twSpeed || (zh ? 90 : 50));
    let i = 0;
    const iv = setInterval(() => {
      if (reduced) {
        clearInterval(iv);
        finish(el, text);
        return;
      }
      i++;
      live.textContent = text.slice(0, i);
      if (i >= text.length) {
        clearInterval(iv);
        finish(el, text); // 终态 === i18n 原文,影子/打字层全部拆除
      }
    }, speed);
  };
  for (const el of els) {
    const { text, live } = prep(el);
    const delay = Number(el.dataset.twDelay || 0);
    const go = () => setTimeout(() => reduced ? finish(el, text) : run(el, text, live), delay);
    if (el.dataset.tw === 'load') {
      go();
    } else {
      const io = new IntersectionObserver(
        ([en]) => {
          if (en.isIntersecting) {
            io.disconnect();
            go();
          }
        },
        { threshold: 0.1 },
      );
      io.observe(el);
    }
  }
  document.addEventListener('x:motion-preference', () => {
    if (reduced) for (const [el, text] of originals) finish(el, text);
  });
}

/* ---------- ⑤ 次要块 reveal(P1-03:阈值 .05/底-20px) ---------- */
/* 背景暂停键(WCAG 2.2.2 A 级)。键在页脚,状态存 localStorage,跨页保持。 */
function initBgToggle() {
  const btn = document.querySelector<HTMLButtonElement>('[data-bg-toggle]');
  if (!btn) return;
  let userPaused = false;
  try { userPaused = localStorage.getItem('x-bg-paused') === '1'; } catch { /* 存储不可用 */ }
  const render = () => {
    const effectivePaused = reduced || userPaused;
    btn.textContent = reduced
      ? btn.dataset.labelReduced ?? btn.dataset.labelPlay ?? ''
      : userPaused ? btn.dataset.labelPlay ?? '' : btn.dataset.labelPause ?? '';
    btn.setAttribute('aria-pressed', String(effectivePaused));
    btn.disabled = reduced;
  };
  render();
  btn.addEventListener('click', () => {
    if (reduced) return;
    userPaused = !userPaused;
    render();
    document.dispatchEvent(new CustomEvent('x:bg-pause', { detail: userPaused }));
  });
  document.addEventListener('x:motion-preference', render);
}

function initReveal() {
  const els = document.querySelectorAll<HTMLElement>('[data-rv]');
  if (!els.length || reduced) return;
  /* 引擎到得比 CSS 兜底还晚:兜底已经把这些块显出来了,再走一遍进场等于先闪一下再消失,直接落终态。
     阈值**从 CSS 读**(--x-rv-fallback),不再在这里另写一个 3000 —— 原来两处各写一个、
     靠注释「改一处必须改另一处」约束,而那正是应该焊成单一真源的写法。 */
  const fb = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--x-rv-fallback')) || 3000;
  if (performance.now() - BEAT_T0 > fb) {
    for (const el of els) el.classList.add('in', 'rv-done');
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const el = en.target as HTMLElement;
        el.classList.add('in');
        /* R45:进场结束后加 .rv-done,把过渡时长/延迟交还给元素自己的规则(hover 0.2s 曾被 0.9s+延迟接管) */
        const done = () => el.classList.add('rv-done');
        /* 指针停着不动、元素滑到手下:hover 样式先于本事件生效,已开始的 0.9s 过渡改不了时长——
           把当前透明度钉成内联值再放开,强制过渡从当前值按 0.2s 重启 */
        const doneNow = () => {
          if (el.classList.contains('rv-done')) return;
          el.style.opacity = getComputedStyle(el).opacity;
          done();
          requestAnimationFrame(() => {
            el.style.opacity = '';
          });
        };
        const onEnd = (ev: TransitionEvent) => {
          if (ev.target !== el) return;
          el.removeEventListener('transitionend', onEnd);
          done();
        };
        el.addEventListener('transitionend', onEnd);
        el.addEventListener('pointerenter', doneNow, { once: true }); // 光标已停在元素上时进场:hover 的 0.2s 不必等 0.9s 走完
        setTimeout(done, 1600); // 兜底:过渡被打断/元素不可见时也要交还
        io.unobserve(el);
      }
    },
    { threshold: 0.05, rootMargin: '0px 0px -20px 0px' },
  );
  els.forEach((el) => io.observe(el));
  document.addEventListener('x:motion-preference', () => {
    if (!reduced) return;
    io.disconnect();
    for (const el of els) el.classList.add('in', 'rv-done');
  });
}

/* ---------- ⑥ 设备 deck:画布几何连续推进(R8) ----------
   机制:滚动总程 = N×区高,拍 k 占 [k/N,(k+1)/N];
   卡 i 位移 = STEP·(i − Σ_{k<i}beats)(STEP=1.0923 卡宽),缩放 = 1−0.15·beats[i];
   末态全叠于锚位(高序号在上);透明深带(.band-deep,R48 前身是白幕布 .band-light)在 decked 时
   上拉一个区高盖过钉屏尾段——带子透明后「遮挡」由叠卡在重叠段自淡出承担(见 apply 末段)。 */
function initPile() {
  const sec = document.querySelector<HTMLElement>('[data-deck]');
  const pin = sec?.querySelector<HTMLElement>('[data-deck-pin]') ?? null;
  const cards = sec ? [...sec.querySelectorAll<HTMLElement>('[data-deck-card]')] : [];
  const artSources = sec ? [...sec.querySelectorAll<HTMLSourceElement>('[data-deck-source]')] : [];
  const band = document.querySelector<HTMLElement>('.band-deep');
  if (!sec || !pin || !cards.length) return;
  const engaged = () => !reduced && !coarse && !matchMedia('(max-width: 860px)').matches;
  let active = false;

  const PARK = 0.85;
  const N = cards.length;
  let ZOOM = 1;
  let STEP = 0,
    DIST = 0;
  const measure = () => {
    const pinH = pin.offsetHeight; // = --x-sec-h(与参考站钉屏区同角色);画布单位
    STEP = Math.round(cards[0].offsetWidth * 1.0923); // 步距=1.0923 卡宽(710/650,间隙 9.23%);画布单位
    /* R42:页面套了画布壳(zoom),于是「布局单位」与「屏幕单位」不再等价 ——
       offsetHeight / style.height 是画布单位,getBoundingClientRect 是屏幕单位。
       推进量拿 rect 算,故 DIST 必须换算到屏幕单位,否则编舞跑得快一个缩放倍数、提前收完。
       zoom 直接由「同一元素的两种读数之比」得出,不依赖 CSS 变量。 */
    ZOOM = pin.getBoundingClientRect().height / (pinH || 1) || 1;
    DIST = N * pinH * ZOOM; // 每拍一个区高(屏幕单位)
    sec.style.height = `${(N + 1) * pinH}px`; // 画布单位(它是 CSS 长度,住在画布内)
  };
  const clear = () => {
    sec.classList.remove('decked');
    for (const source of artSources) source.media = 'not all';
    band?.classList.remove('curtain');
    sec.style.height = '';
    pin.style.opacity = '';
    for (const c of cards) c.style.transform = '';
  };
  const smooth = (t: number) => t * t * (3 - 2 * t); // smoothstep(P2-22)
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  let raf = 0;
  const apply = () => {
    raf = 0;
    if (!active) return;
    // R42:钉屏区在高屏上垂直居中(sticky top = T),推进量必须同步平移 —— 否则先有一段
    // 「钉住但什么都不发生」的死区,末段编舞又发生在钉屏区已开始上移、幕布已盖上之后
    // (实测 1440 高屏:336px 死区 + 末卡只收到 0.90 而非 0.85)。
    const T = (parseFloat(getComputedStyle(pin).top) || 0) * ZOOM; // CSS 值是画布单位,换算到屏幕单位
    const secTop = sec.getBoundingClientRect().top;
    const e = clamp01((T - secTop) / DIST);
    /* R48:深带透明后,curtain 重叠段的「遮挡」改由叠卡自淡出承担(白幕布时代靠不透明底)。
       带顶从 DIST−secH 处开始压进钉屏区、到 DIST 处盖满 —— 重叠窗与**最后一拍同期**
       (白幕布时代最后一拍本来就在幕布底下播完,不可见;淡出让这段等价)。
       0.8 让卡在盖满前略提前隐没,不与压上来的新区内容叠影。 */
    const secH = pin.offsetHeight * ZOOM || 1;
    const o = smooth(clamp01((T - secTop - (DIST - secH)) / (secH * 0.8)));
    pin.style.opacity = o > 0 ? (1 - o).toFixed(3) : '';
    const beats: number[] = [];
    for (let k = 0; k < N; k++) beats.push(smooth(clamp01((e - k / N) * N)));
    for (let i = 0; i < N; i++) {
      let done = 0;
      for (let k = 0; k < i; k++) done += beats[k];
      const x = Math.max(0, STEP * (i - done));
      const s = 1 - (1 - PARK) * beats[i];
      cards[i].style.transform = `translate3d(${x.toFixed(1)}px, 0, 0) scale(${s.toFixed(4)})`;
    }
  };
  const engage = () => {
    const want = engaged();
    if (want && !active) {
      active = true;
      sec.classList.add('decked');
      for (const source of artSources) source.media = 'all';
      band?.classList.add('curtain');
      /* R45:停放在屏外的卡被 .x-frame 的裁切框挡住 lazy 预取,滑入时整张白框;桌面编舞在离叠卡区一屏半时预取(不在首载就拉 1MB) */
      const imgs = [...sec.querySelectorAll<HTMLImageElement>('img')];
      const pre = new IntersectionObserver(
        ([en]) => {
          if (!en.isIntersecting) return;
          pre.disconnect();
          for (const img of imgs) img.loading = 'eager';
        },
        { rootMargin: '150% 0px' },
      );
      pre.observe(sec);
      measure();
      apply();
    } else if (!want && active) {
      active = false;
      clear();
    } else if (want && active) {
      measure();
      apply();
    }
  };
  engage();
  addEventListener('resize', engage);
  document.addEventListener('x:motion-preference', engage);
  addEventListener(
    'scroll',
    () => {
      if (active && !raf) raf = requestAnimationFrame(apply);
    },
    { passive: true },
  );
}

/* ---------- ⑦ 三列滚动视差(反白卡区;P1-28) ---------- */
function initParallax() {
  const els = [...document.querySelectorAll<HTMLElement>('[data-plx]')];
  if (!els.length || coarse) return;
  let raf = 0;
  /* 已写进 transform 的位移(画布量)。必须记账:getBoundingClientRect() 读到的 top 里**已经含着它**,
     不减掉就成了递归定义 —— 每帧只走 1/(1+k) 的距离,而 apply() 只挂在 scroll/resize/focusin 上,
     瞬时滚动(锚点直达、刷新恢复)只触发一次,于是永久冻在半路。 */
  const written = new WeakMap<HTMLElement, number>();
  const clear = () => {
    for (const el of els) {
      el.style.transform = '';
      written.delete(el);
    }
  };
  const apply = () => {
    raf = 0;
    if (reduced || matchMedia('(max-width: 850px)').matches) {
      clear();
      return;
    }
    const vh2 = innerHeight / 2;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      const k = Number(el.dataset.plx || 0.08);
      /* R43:dy 由 rect(屏幕量)算出,却写进画布内元素的 transform(画布量),渲染时再乘一次 zoom
         ⇒ >=1440 位移超出 1.333 倍。除以缩放换算回画布量。同族第三处(前两处在叠卡编舞里已修)。 */
      const zx = el.offsetWidth ? el.getBoundingClientRect().width / el.offsetWidth : 1;
      /* 减掉上一帧写进去的那一份(记账值是画布量,渲染时被 zoom 放大 zx 倍才进 rect) */
      const shift = (written.get(el) ?? 0) * (zx || 1);
      const dy = ((vh2 - (r.top - shift + r.height / 2)) * k) / (zx || 1);
      written.set(el, dy);
      el.style.transform = `translate3d(0, ${dy.toFixed(1)}px, 0)`;
    }
  };
  apply();
  addEventListener(
    'scroll',
    () => {
      if (!raf) raf = requestAnimationFrame(apply);
    },
    { passive: true },
  );
  addEventListener('resize', apply);
  document.addEventListener('x:motion-preference', apply);
  /* 键盘 Tab 进视差层:浏览器按**旧位移**把元素滚进视口,随后视差重算又把它挪走(实测焦点件落到视口下方 300px)。
     重算完再把焦点件对到视口中间。 */
  addEventListener('focusin', (e) => {
    const t = e.target as HTMLElement | null;
    if (reduced || !t || !t.closest('[data-plx]')) return;
    if (!t.matches(':focus-visible')) return; // 只管键盘路径:鼠标点半露卡片里的链接不该被瞬移居中
    apply();
    requestAnimationFrame(() => {
      const r = t.getBoundingClientRect();
      if (r.top >= 0 && r.bottom <= innerHeight) return;
      const y = scrollY + r.top - innerHeight / 2 + r.height / 2;
      if (lenisInst) lenisInst.scrollTo(y, { immediate: true });
      else scrollTo(0, y);
    });
  });
}

/* ---------- ⑧ UTC 时钟(秒奇偶冒号,锁墙钟秒;P1-11) ---------- */
function initClock() {
  const el = document.getElementById('x-clock');
  if (!el) return;
  const h12 = document.createElement('span');
  const mm = document.createElement('span');
  const ap = document.createElement('span');
  const colon = document.createElement('span');
  colon.className = 'colon';
  colon.textContent = ':';
  el.replaceChildren('UTC\u00a0', h12, colon, mm, '\u00a0', ap); // 宿主是 inline-flex:裸空格文本节点成匿名 flex 项后不渲染(曾显示 UTC07:13PM),必须 NBSP
  const tick = () => {
    const d = new Date();
    let h = d.getUTCHours();
    ap.textContent = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    h12.textContent = String(h).padStart(2, '0');
    mm.textContent = String(d.getUTCMinutes()).padStart(2, '0');
    colon.style.opacity = d.getUTCSeconds() % 2 === 0 ? '1' : '0'; // 2s 周期方波
  };
  tick();
  setTimeout(() => {
    tick();
    setInterval(tick, 1000);
  }, 1000 - (Date.now() % 1000)); // 相位锁墙钟秒
}

/* ---------- ⑩ 导航字符扰动 hover(R10):悬停即扰动、左→右每 4 帧定格一字 ----------
   字池按文种分:拉丁→A-Z、数字→0-9、CJK→基础笔画(一丨丿丶乛十),
   空格/标点不动 → 宽度稳定不跳版;中文不闪随机汉字(避免乱码感,笔画=「字在组装」)。
   移开立即还原;按下取消(点击瞬间文本必须稳定);reduced/无 hover 设备不挂。 */
function initScramble() {
  const els = [...document.querySelectorAll<HTMLElement>('[data-scr]')];
  if (!els.length || !matchMedia('(hover: hover)').matches) return;
  /* R49-D6:导航落地后光标常驻原位,新页同位元素立刻收到 mouseenter——语言标签在
     「刚切完语言」这一最敏感时刻闪 130ms 乱码(可用性实测)。落地 600ms 内不响应首次悬停。 */
  const ARM_AT = performance.now() + 600;
  const LAT = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const DIG = '0123456789';
  const CJK = '一丨丿丶乛十';
  const isCjk = (ch: string) => /[㐀-鿿豈-﫿]/.test(ch);
  const pick = (pool: string) => pool[Math.floor(Math.random() * pool.length)];
  const scrambleChar = (ch: string) => {
    if (/\s/.test(ch)) return ch;
    if (isCjk(ch)) return pick(CJK);
    if (/[0-9]/.test(ch)) return pick(DIG);
    if (/[A-Za-zÀ-ỹ]/.test(ch)) return pick(LAT);
    return ch; // 标点/符号不扰动
  };
  for (const el of els) {
    // Animate the label only when a control also contains an icon.
    const label = el.querySelector<HTMLElement>('[data-scr-label]') ?? el;
    const original = label.textContent ?? '';
    if (!original.trim()) continue;
    const chars = [...original]; // 码点级拆分(vi 声调字 NFC 单码点,安全)
    if (!el.hasAttribute('aria-label')) el.setAttribute('aria-label', original.trim());
    let raf = 0;
    let frame = 0;
    const stop = (restore: boolean) => {
      cancelAnimationFrame(raf);
      raf = 0;
      if (restore) label.textContent = original;
    };
    const run = () => {
      const settled = Math.min(Math.floor(frame / 4), chars.length);
      label.textContent = chars.map((c, i) => (i < settled ? c : scrambleChar(c))).join('');
      frame++;
      if (settled < chars.length) raf = requestAnimationFrame(run);
      else raf = 0;
    };
    el.addEventListener('mouseenter', () => {
      if (reduced || performance.now() < ARM_AT) return;
      stop(false);
      frame = 0;
      raf = requestAnimationFrame(run);
    });
    el.addEventListener('mouseleave', () => stop(true));
    el.addEventListener('pointerdown', () => stop(true));
    document.addEventListener('x:motion-preference', () => {
      if (reduced) stop(true);
    });
  }
}

/* ---------- boot ---------- */
const boot = () => {
  const html = document.documentElement;
  html.classList.add('js'); // 兜底;正常由 Base.astro 头部内联脚本在首帧前加(no-JS 防隐形闸,P2-09)
  setVw();
  addEventListener('resize', setVw);
  document.addEventListener('x:scroll-lock', () => scrollLock(true));
  document.addEventListener('x:scroll-unlock', () => scrollLock(false));

  if ('requestIdleCallback' in window) {
    requestIdleCallback(() => initLorenz(), { timeout: 800 });
  } else {
    setTimeout(initLorenz, 200);
  }
  initLenis();
  initHashNavigation();
  initMobileDownloads();
  initLineReveal();
  initCertZoom();
  initType();
  initReveal();
  initBgToggle();
  initClock();
  initPile();
  initParallax();
  initScramble();

  /* R48.7:开场编排收官后整只摘掉 x-boot —— fill 态动画会让挂它的祖先永久成为 backdrop root,
     子孙的 backdrop-filter 采样面被切空(第一案 .site-nav 磨砂、第二案 #stats 玻璃带,均实测)。
     规则层已全改 backwards,这里把类摘掉让「x-boot 只存在于开场窗口」成为结构事实,同族永绝。
     2.6s = 最晚 CSS 拍(0.55s 延迟 + 0.5s 时长,锚点首帧)+ 余量;JS 拍只在注册时读该类,不受影响。 */
  if (html.classList.contains('x-boot')) {
    setTimeout(() => html.classList.remove('x-boot'), Math.max(0, BEAT_T0 + 2600 - performance.now()));
  }
};
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
