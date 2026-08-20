/* 全站交互引擎 R6(axiom 方向,自研实现)。
   粒子背景 = 2026-08-20 对参考站源码逐行解码后的同构实现:
   ① 单 canvas、五组固定姿态(默认/A/B/C/D),各锚定一个板块;
   ② 每帧读锚板块的视口位置 → smoothstep 过渡进度 → 五姿态**链式插值**:
      板块内部姿态纹丝不动(顶/底永远同一形态族,偏转角小,始终是同一只"蝴蝶"),
      跨板块连续变形,过渡中途缩放先俯冲再回弹(dip 因子);
   ③ 鼠标极克制:中心反向漂移 ≤8px、倾角 ≤0.04/0.03 rad(lerp .035 / 离场衰减 .96);推斥 160px/90;
   ④ 流光:4 头、尾 180、步进 0.5、暖黄 255,220,120、线宽 1.4;移动端 stride3 无流光无推斥。
   性能层为自研改良:颜色×深度分桶批量描边 + 离屏缓存,姿态/鼠标全静止时零重渲染(输出与逐帧重画全等)。
   设备卡 = 滑入收叠编舞(实测解码);候卡在前卡落锚瞬间现身,无远端排队。
   鼠标一律原生光标。reduced-motion:静帧,全动效关。 */
import Lenis from 'lenis';

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = matchMedia('(pointer: coarse)').matches;

/* ---------- ① 洛伦兹吸引子背景(五姿态链式插值 + 离屏缓存) ---------- */
function initLorenz() {
  const canvas = document.getElementById('x-bg') as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return;

  // 经典参数 σ=10 ρ=28 β=8/3,欧拉步 0.005,热身 6000,录 20000 点(与参考站同规格)
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
  // 轨迹质心(投影绕质心旋转,与参考站同法)
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

  // 颜色 20 桶(z 静态)× 深度 3 带(随旋转每次渲染重分)= 60 组批量描边
  const stride = coarse ? 3 : 1;
  const TB = 20;
  const DB = 3;
  const tBucket = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const t = Math.max(0, Math.min(1, (pts[i * 3 + 2] - 2) / 46));
    tBucket[i] = Math.min(TB - 1, Math.floor(t * TB));
  }
  const groups: number[][] = Array.from({ length: TB * DB }, () => []);
  const groupStyle: string[] = [];
  for (let b = 0; b < TB; b++) {
    const t = (b + 0.5) / TB;
    const r = Math.round(55 + 200 * t);
    const g = Math.round(30 + 155 * t);
    const bl = Math.round(2 + 10 * t);
    for (let d = 0; d < DB; d++) {
      const mMid = -1 + ((d + 0.5) * 2) / DB; // 桶中值深度 ∈ (-1,1)
      const alpha = Math.min(1, (0.12 + 0.48 * t) * (1 + 0.4 * mMid));
      groupStyle.push(`rgba(${r},${g},${bl},${Math.max(0, alpha).toFixed(3)})`);
    }
  }

  const body = document.createElement('canvas');
  const bctx = body.getContext('2d')!;

  let W = 0,
    H = 0;

  /* —— 五姿态(参考站常量):k=min(W,H)/k 为缩放;C 姿态含专用位移单元 $ —— */
  interface Pose {
    cx: number;
    cy: number;
    scl: number;
    yaw: number;
    pitch: number;
  }
  const poseHome = (): Pose => ({ cx: 0.5 * W, cy: 0.54 * H, scl: Math.min(W, H) / 44, yaw: 0, pitch: 0 });
  const poseA = (): Pose => ({ cx: 0.33 * W, cy: 0.68 * H, scl: Math.min(W, H) / 65, yaw: 1.25, pitch: 0.5 });
  const poseB = (): Pose => ({ cx: 0.65 * W, cy: 0.5 * H, scl: Math.min(W, H) / 62, yaw: -1.55, pitch: 1.15 });
  const poseC = (): Pose => {
    const u = (Math.min(W, H) / 32) * 1.85;
    return { cx: 0.5 * W - 6 * u, cy: 0.5 * H + 14.25 * u, scl: Math.min(W, H) / 32, yaw: 0.4, pitch: 1.1 };
  };
  const poseD = (): Pose => ({ cx: 0.56 * W, cy: 0.52 * H, scl: Math.min(W, H) / 28, yaw: 0.2, pitch: 1.05 });
  // 锚板块(本站叙事等位):A=数字条 B=How C=设备卡 D=使命;子页无锚 → 恒为默认姿态
  const ANCHOR_IDS = ['stats', 'how', 'devices', 'mission'];
  let anchors: (HTMLElement | null)[] = [];
  const smooth = (e: number) => e * e * (3 - 2 * e);
  const prog = (el: HTMLElement | null) => {
    if (!el) return 0;
    const e = Math.max(0, Math.min(1, (innerHeight - el.getBoundingClientRect().top) / innerHeight));
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
  // 上次渲染采用的姿态参数(静止判定)
  let rG = -1,
    rCx = 0,
    rCy = 0,
    rYaw = 99,
    rPitch = 99;
  const dbg = { renders: 0, tiltX: 0, tiltY: 0, driftX: 0, driftY: 0 };
  (window as unknown as Record<string, unknown>).__xbg = dbg;

  const resize = () => {
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = W;
    canvas.height = H;
    body.width = W;
    body.height = H;
    dirty = true;
  };

  const renderBody = (cx: number, cy: number, G: number, yaw: number, pitch: number) => {
    dbg.renders++;
    const ca = Math.cos(yaw),
      sa = Math.sin(yaw),
      cb = Math.cos(pitch),
      sbn = Math.sin(pitch);
    // 旋转后的质心分量(投影绕质心)
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

    for (const g of groups) g.length = 0;
    for (let i = stride; i < N - stride; i += stride) {
      const d = Math.min(DB - 1, Math.max(0, Math.floor(((dep[i] + 1) / 2) * DB)));
      groups[tBucket[i] * DB + d].push(i);
    }

    bctx.clearRect(0, 0, W, H);
    bctx.lineWidth = 1.2;
    for (let gi = 0; gi < groups.length; gi++) {
      const idx = groups[gi];
      if (!idx.length) continue;
      bctx.beginPath();
      for (let k = 0; k < idx.length; k++) {
        const i = idx[k];
        bctx.moveTo((px[i - stride] + px[i]) / 2, (py[i - stride] + py[i]) / 2);
        bctx.quadraticCurveTo(px[i], py[i], (px[i + stride] + px[i]) / 2, (py[i + stride] + py[i]) / 2);
      }
      bctx.strokeStyle = groupStyle[gi];
      bctx.stroke();
    }
  };

  // 流光(参考站规格:4 头 / 尾 180 / 步进 0.5 / 暖黄 / 线宽 1.4)
  let comet = 0;
  const TAIL = 180;
  const CB = 6;
  const cometStyles = Array.from({ length: CB }, (_, k) => {
    const fade = 1 - (k + 0.5) / CB;
    return `rgba(255,220,120,${(fade * fade * 0.75).toFixed(3)})`;
  });
  const drawComets = () => {
    ctx.lineWidth = 1.4;
    for (let cb2 = 0; cb2 < CB; cb2++) {
      ctx.beginPath();
      const k0 = Math.floor((TAIL / CB) * cb2) + 1;
      const k1 = Math.floor((TAIL / CB) * (cb2 + 1));
      for (let c = 0; c < 4; c++) {
        const head = Math.floor((comet + (N / 4) * c) % N);
        for (let k = k0; k <= k1; k++) {
          const i = (head - k + N) % N;
          const j = (i + 1) % N;
          ctx.moveTo(px[i], py[i]);
          ctx.lineTo(px[j], py[j]);
        }
      }
      ctx.strokeStyle = cometStyles[cb2];
      ctx.stroke();
    }
    ctx.lineWidth = 1.2;
  };

  let raf = 0;
  let running = false;
  const frame = () => {
    // —— 姿态:锚板块进度 → 链式插值;界内进度饱和 → 姿态恒定 ——
    let P = poseHome();
    const ps = [prog(anchors[0]), prog(anchors[1]), prog(anchors[2]), prog(anchors[3])];
    P = mix(P, poseA(), ps[0]);
    P = mix(P, poseB(), ps[1]);
    P = mix(P, poseC(), ps[2]);
    P = mix(P, poseD(), ps[3]);
    // 过渡中途缩放俯冲再回弹 + 完成后的净增益(参考站 dip 公式)
    const G =
      P.scl *
      (1 - 2.2 * ps[0] * (1 - ps[0])) *
      (1 - 2 * ps[1] * (1 - ps[1])) *
      (1 - 2 * ps[2] * (1 - ps[2])) *
      (1 - 2 * ps[3] * (1 - ps[3])) *
      (1 + 0.45 * ps[0] + 0.2 * ps[1] + 0.2 * ps[2] + 0.2 * ps[3]);

    // —— 鼠标(参考站口径:反向漂移 ≤8px,倾角 ≤.04/.03,lerp .035,离场衰减 .96)——
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

    // 常驻轻量状态输出(探针核规格用:倾角/漂移应精确吸附到 0.04ex / -8ex)
    dbg.tiltX = tiltX;
    dbg.tiltY = tiltY;
    dbg.driftX = driftX;
    dbg.driftY = driftY;
    if (
      dirty ||
      mouseStamp !== renderedStamp ||
      Math.abs(G - rG) > 1e-3 ||
      Math.abs(cx - rCx) > 0.3 ||
      Math.abs(cy - rCy) > 0.3 ||
      Math.abs(yaw - rYaw) > 1e-4 ||
      Math.abs(pitch - rPitch) > 1e-4
    ) {
      renderBody(cx, cy, G, yaw, pitch);
      dirty = false;
      renderedStamp = mouseStamp;
      rG = G;
      rCx = cx;
      rCy = cy;
      rYaw = yaw;
      rPitch = pitch;
    }

    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#0c0c0d';
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'screen';
    ctx.drawImage(body, 0, 0);
    if (!coarse) {
      comet = (comet + 0.5) % N;
      drawComets();
    }

    if (running) raf = requestAnimationFrame(frame);
  };

  const start = () => {
    if (running || reduced) return;
    running = true;
    raf = requestAnimationFrame(frame);
  };
  const stop = () => {
    running = false;
    cancelAnimationFrame(raf);
  };

  resize();
  anchors = ANCHOR_IDS.map((id) => document.getElementById(id));
  addEventListener('resize', resize);
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

  if (reduced) {
    const P = poseHome();
    renderBody(P.cx, P.cy, P.scl, P.yaw, P.pitch);
    ctx.fillStyle = '#0c0c0d';
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'screen';
    ctx.drawImage(body, 0, 0);
    return;
  }
  start();
}

/* ---------- ② Lenis 平滑滚动 + 锚点接管 ---------- */
function initLenis() {
  if (reduced) return;
  const lenis = new Lenis();
  const raf = (t: number) => {
    lenis.raf(t);
    requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);

  document.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest?.('a[href^="#"]') as HTMLAnchorElement | null;
    if (!a) return;
    const id = a.getAttribute('href')!.slice(1);
    const el = id && document.getElementById(id);
    if (!el) return;
    e.preventDefault();
    // 用真实 scrollY 算绝对目标(元素目标会撞 Lenis 内部值与原生跳转失同步的坑)
    lenis.scrollTo(el.getBoundingClientRect().top + window.scrollY - 84);
    history.pushState(null, '', `#${id}`);
  });
  return lenis;
}

/* ---------- ③ 设备「滑入收叠」编舞(实测解码) ---------- */
function initPile() {
  const sec = document.querySelector<HTMLElement>('[data-deck]');
  const cards = sec ? [...sec.querySelectorAll<HTMLElement>('[data-deck-card]')] : [];
  if (!sec || !cards.length) return;
  if (reduced || coarse || matchMedia('(max-width: 860px)').matches) return;
  sec.classList.add('decked');

  const STEP_VH = 0.8;
  const PARK = 0.85;
  let STEP = 0,
    ENTER = 0;
  const measure = () => {
    STEP = Math.round(innerHeight * STEP_VH);
    ENTER = Math.round(cards[0].offsetWidth * 1.23); // 候位偏移 = 1.23 卡宽(实测 710/578)
    sec.style.height = `${innerHeight + cards.length * STEP + Math.round(innerHeight * 0.25)}px`;
  };
  measure();
  addEventListener('resize', measure);

  const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  let raf = 0;
  const apply = () => {
    raf = 0;
    const y = -sec.getBoundingClientRect().top;
    for (let i = 0; i < cards.length; i++) {
      // 第 i 拍:卡 i 进场(卡 0 天生在锚位);第 i+1 拍:卡 i 缩入叠。
      // 参考站实测:一张卡在途时,下一张**不在场**;它在前卡落锚的那一刻
      // 才出现在候位(ENTER,右缘切边)并随自己的拍子滑入——无远处排队、无大空档。
      const pIn = i === 0 ? 1 : clamp01((y - (i - 1) * STEP) / STEP);
      const pSh = clamp01((y - i * STEP) / STEP);
      const x = (1 - ease(pIn)) * ENTER;
      const s = 1 - (1 - PARK) * ease(pSh);
      const visible = i <= 1 || y >= (i - 1) * STEP;
      cards[i].style.visibility = visible ? '' : 'hidden';
      cards[i].style.transform = `translate3d(${x.toFixed(1)}px, -50%, 0) scale(${s.toFixed(4)})`;
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
}

/* ---------- ④ 滚动进场 reveal ---------- */
function initReveal() {
  const els = document.querySelectorAll('[data-rv]');
  if (!els.length || reduced) return;
  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (en.isIntersecting) {
          en.target.classList.add('in');
          io.unobserve(en.target);
        }
      }
    },
    { threshold: 0.18 },
  );
  els.forEach((el) => io.observe(el));
}

/* ---------- ⑤ UTC 时钟(冒号 CSS 闪烁) ---------- */
function initClock() {
  const el = document.getElementById('x-clock');
  if (!el) return;
  const h12 = document.createElement('span');
  const mm = document.createElement('span');
  const ap = document.createElement('span');
  const colon = document.createElement('span');
  colon.className = 'colon';
  colon.textContent = ':';
  el.replaceChildren('UTC ', h12, colon, mm, ' ', ap);
  const tick = () => {
    const d = new Date();
    let h = d.getUTCHours();
    ap.textContent = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    h12.textContent = String(h).padStart(2, '0');
    mm.textContent = String(d.getUTCMinutes()).padStart(2, '0');
  };
  tick();
  setInterval(tick, 1000);
}

/* ---------- boot ---------- */
const boot = () => {
  if ('requestIdleCallback' in window) {
    requestIdleCallback(() => initLorenz(), { timeout: 1200 });
  } else {
    setTimeout(initLorenz, 300);
  }
  initLenis();
  initReveal();
  initClock();
  initPile();
};
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
