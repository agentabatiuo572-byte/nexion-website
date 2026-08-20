/* 全站交互引擎 R4(axiom 方向,自研实现)。
   粒子背景行为规则(2026-08-20 对参考站双路实测解码:画布不监听滚动;
   形状 bbox 在板块内逐像素静止、跨板块边界平滑变化):
   —— **姿态按板块定义,滚动跨界时缓动插值到新姿态,板块内完全静止,只有流光沿轨迹跑**;
   鼠标倾斜+推斥为叠加项。性能:分桶批量描边 + 离屏缓存 + 静止零重渲染(R2 架构)。
   设备卡:横排轨道随滚动整排左移(多卡同屏,主人 R4 依图 2 定)。
   鼠标一律原生光标。reduced-motion:静帧,全动效关。 */
import Lenis from 'lenis';

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = matchMedia('(pointer: coarse)').matches;

/* ---------- ① 洛伦兹吸引子背景(板块姿态 + 离屏缓存) ---------- */
function initLorenz() {
  const canvas = document.getElementById('x-bg') as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return;

  const N = coarse ? 6000 : 14000;
  const pts = new Float32Array(N * 3);
  let sx0 = 0.1,
    sy0 = 0,
    sz0 = 0;
  const step = () => {
    const dx = 10 * (sy0 - sx0);
    const dy = sx0 * (28 - sz0) - sy0;
    const dz = sx0 * sy0 - (8 / 3) * sz0;
    sx0 += 0.005 * dx;
    sy0 += 0.005 * dy;
    sz0 += 0.005 * dz;
  };
  for (let i = 0; i < 6000; i++) step();
  for (let i = 0; i < N; i++) {
    step();
    pts[i * 3] = sx0;
    pts[i * 3 + 1] = sy0;
    pts[i * 3 + 2] = sz0;
  }

  const px = new Float32Array(N);
  const py = new Float32Array(N);

  const stride = coarse ? 3 : 2;
  const B = 20;
  const buckets: number[][] = Array.from({ length: B }, () => []);
  const styles: string[] = [];
  for (let i = stride; i < N - stride; i += stride) {
    const t = Math.max(0, Math.min(1, (pts[i * 3 + 2] - 2) / 46));
    buckets[Math.min(B - 1, Math.floor(t * B))].push(i);
  }
  for (let b = 0; b < B; b++) {
    const t = (b + 0.5) / B;
    styles.push(
      `rgba(${Math.round(55 + 200 * t)},${Math.round(30 + 155 * t)},${Math.round(2 + 10 * t)},${(0.1 + 0.44 * t).toFixed(3)})`,
    );
  }

  const body = document.createElement('canvas');
  const bctx = body.getContext('2d')!;

  let W = 0,
    H = 0;

  /* —— 板块姿态表:az 方位角 / sc 缩放 / cx,cy 画布锚点(视口占比)。
     首页 12 板块循环取用;跨界即插值,界内静止(参考站同款机制)。 —— */
  const POSES = [
    { az: 0.55, sc: 0.92, cx: 0.42, cy: 0.5 },
    { az: 1.35, sc: 1.06, cx: 0.6, cy: 0.42 },
    { az: 2.2, sc: 0.88, cx: 0.44, cy: 0.62 },
    { az: 3.05, sc: 1.14, cx: 0.36, cy: 0.5 },
    { az: 3.9, sc: 0.96, cx: 0.58, cy: 0.54 },
    { az: 4.75, sc: 1.24, cx: 0.5, cy: 0.5 },
  ];
  let bandTops: number[] = [];
  const measureBands = () => {
    bandTops = [...document.querySelectorAll('main > section')].map(
      (s) => (s as HTMLElement).getBoundingClientRect().top + scrollY,
    );
  };
  const activePose = () => {
    if (!bandTops.length) return POSES[0];
    const probe = scrollY + innerHeight * 0.5;
    let idx = 0;
    for (let i = 0; i < bandTops.length; i++) if (bandTops[i] <= probe) idx = i;
    return POSES[idx % POSES.length];
  };

  // 当前姿态(向目标缓动,吸附定格)
  let az = POSES[0].az,
    sc = POSES[0].sc,
    pcx = POSES[0].cx,
    pcy = POSES[0].cy;
  const mouse = { x: -9999, y: -9999 };
  let tiltX = 0,
    tiltY = 0,
    driftX = 0,
    driftY = 0;
  let dirty = true;
  let mouseStamp = 0,
    renderedStamp = -1;
  let lastScrollY = -1;
  const dbg = { renders: 0 };
  (window as unknown as Record<string, unknown>).__xbg = dbg;

  const resize = () => {
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = W;
    canvas.height = H;
    body.width = W;
    body.height = H;
    measureBands();
    dirty = true;
  };

  const renderBody = () => {
    dbg.renders++;
    const a = az + tiltX;
    const b = 0.42 + tiltY;
    const ca = Math.cos(a),
      sa = Math.sin(a),
      cb = Math.cos(b),
      sb = Math.sin(b);
    const scale = (Math.min(W, H) / 52) * sc;
    const cx = W * pcx + driftX;
    const cy = H * pcy + driftY;
    const mx = mouse.x,
      my = mouse.y;
    const repelOn = !coarse && mx > -9000;

    for (let i = 0; i < N; i++) {
      const X = pts[i * 3],
        Y = pts[i * 3 + 1],
        Z = pts[i * 3 + 2] - 27;
      const rx = X * ca - Y * sa;
      const ry = X * sa + Y * ca;
      const rz = ry * cb - Z * sb;
      const depth = Math.max(-1, Math.min(1, rz / 22));
      const p = 1 + 0.2 * depth;
      let x = cx + rx * scale * p;
      let y = cy - (ry * sb + Z * cb) * scale * p;
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
    }

    bctx.clearRect(0, 0, W, H);
    bctx.lineWidth = 1.2;
    for (let bkt = 0; bkt < B; bkt++) {
      const idx = buckets[bkt];
      if (!idx.length) continue;
      bctx.beginPath();
      for (let k = 0; k < idx.length; k++) {
        const i = idx[k];
        bctx.moveTo((px[i - stride] + px[i]) / 2, (py[i - stride] + py[i]) / 2);
        bctx.quadraticCurveTo(px[i], py[i], (px[i + stride] + px[i]) / 2, (py[i + stride] + py[i]) / 2);
      }
      bctx.strokeStyle = styles[bkt];
      bctx.stroke();
    }
  };

  let comet = 0;
  const TAIL = 150;
  const CB = 6;
  const cometStyles = Array.from({ length: CB }, (_, k) => {
    const fade = 1 - (k + 0.5) / CB;
    return `rgba(255,196,64,${(fade * fade * 0.7).toFixed(3)})`;
  });
  const drawComets = () => {
    ctx.lineWidth = 1.2;
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
  };

  let raf = 0;
  let running = false;
  const frame = () => {
    // —— 姿态目标:滚动位变了才重取(界内目标不变 → 收敛后零重渲染)——
    if (scrollY !== lastScrollY) {
      lastScrollY = scrollY;
    }
    const tp = activePose();
    const prevAz = az,
      prevSc = sc,
      prevCx = pcx,
      prevCy = pcy,
      prevTx = tiltX,
      prevTy = tiltY;
    az += (tp.az - az) * 0.045;
    sc += (tp.sc - sc) * 0.045;
    pcx += (tp.cx - pcx) * 0.045;
    pcy += (tp.cy - pcy) * 0.045;
    if (Math.abs(tp.az - az) < 1.5e-3) az = tp.az;
    if (Math.abs(tp.sc - sc) < 1e-3) sc = tp.sc;
    if (Math.abs(tp.cx - pcx) < 5e-4) pcx = tp.cx;
    if (Math.abs(tp.cy - pcy) < 5e-4) pcy = tp.cy;

    // —— 鼠标倾斜:在场 lerp(近目标吸附),离场衰减 ——
    if (!coarse && mouse.x > -9000) {
      const nx = (mouse.x / W - 0.5) * 2;
      const ny = (mouse.y / H - 0.5) * 2;
      const t1 = 0.3 * nx,
        t2 = 0.24 * ny,
        d1 = 22 * nx,
        d2 = 16 * ny;
      tiltX += (t1 - tiltX) * 0.05;
      tiltY += (t2 - tiltY) * 0.05;
      driftX += (d1 - driftX) * 0.05;
      driftY += (d2 - driftY) * 0.05;
      if (Math.abs(t1 - tiltX) < 2e-3) tiltX = t1;
      if (Math.abs(t2 - tiltY) < 2e-3) tiltY = t2;
      if (Math.abs(d1 - driftX) < 0.15) driftX = d1;
      if (Math.abs(d2 - driftY) < 0.15) driftY = d2;
    } else {
      tiltX *= 0.96;
      tiltY *= 0.96;
      driftX *= 0.96;
      driftY *= 0.96;
      if (Math.abs(tiltX) < 2e-3) tiltX = 0;
      if (Math.abs(tiltY) < 2e-3) tiltY = 0;
      if (Math.abs(driftX) < 0.15) driftX = 0;
      if (Math.abs(driftY) < 0.15) driftY = 0;
    }

    if (
      dirty ||
      mouseStamp !== renderedStamp ||
      az !== prevAz ||
      sc !== prevSc ||
      pcx !== prevCx ||
      pcy !== prevCy ||
      tiltX !== prevTx ||
      tiltY !== prevTy
    ) {
      renderBody();
      dirty = false;
      renderedStamp = mouseStamp;
    }

    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#0c0c0d';
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'screen';
    ctx.drawImage(body, 0, 0);
    comet = (comet + 0.6) % N;
    drawComets();

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
  addEventListener('resize', resize);
  // 轨道段高由 JS 后设,布局稳定后补量一次界表
  setTimeout(measureBands, 400);
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
    renderBody();
    ctx.fillStyle = '#0c0c0d';
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'screen';
    ctx.drawImage(body, 0, 0);
    drawComets();
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

/* ---------- ③ 设备横排轨道:整排随滚动左移,多卡同屏(主人 R4 依图 2) ---------- */
function initRail() {
  const sec = document.querySelector<HTMLElement>('[data-deck]');
  const track = sec?.querySelector<HTMLElement>('[data-deck-track]');
  if (!sec || !track) return;
  if (reduced || coarse || matchMedia('(max-width: 860px)').matches) return; // 原生横滑降级
  sec.classList.add('decked');

  let T = 0;
  const measure = () => {
    T = Math.max(0, track.scrollWidth - Math.round(innerWidth * 0.72));
    sec.style.height = `${innerHeight + T + Math.round(innerHeight * 0.2)}px`;
  };
  measure();
  addEventListener('resize', measure);

  let raf = 0;
  const apply = () => {
    raf = 0;
    const total = sec.offsetHeight - innerHeight;
    const p = total > 0 ? Math.min(1, Math.max(0, -sec.getBoundingClientRect().top / total)) : 0;
    track.style.transform = `translate3d(${(-p * T).toFixed(1)}px,0,0)`;
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
  initRail();
};
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
