/* 全站交互引擎 R2(axiom 方向,自研实现)。
   行为规则(主人 2026-08-20 R2 定):
   ① 粒子背景静止时**不旋转不缩放**,只有流光沿轨迹跑;**页面滚动**才驱动缩放/旋转;
     鼠标靠近推斥 + 移动带动轻微倾斜(参考站原有交互)。
   ② 鼠标一律**原生光标**(自定义圆点已移除)。
   性能架构:主体轨迹按颜色分桶批量描边(20 次 stroke 替代上万次)、离屏缓存,
   静止帧只贴缓存 + 画流光;dpr 钉 1(与参考站一致)。
   reduced-motion:静帧一张,Lenis/reveal 全关。 */
import Lenis from 'lenis';

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = matchMedia('(pointer: coarse)').matches;

/* ---------- ① 洛伦兹吸引子背景(滚动驱动 + 离屏缓存) ---------- */
interface LorenzApi {
  setVel(v: number): void;
}
function initLorenz(): LorenzApi | undefined {
  const canvas = document.getElementById('x-bg') as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return;

  // 经典参数 σ=10 ρ=28 β=8/3,欧拉步 dt=0.005;热身进入吸引子再录轨迹
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

  // 颜色分桶(z 静态 → 桶静态):20 桶,每桶存分段起点索引,渲染时一桶一 stroke
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

  // 离屏主体层(透明底,主画布以 screen 合成贴上)
  const body = document.createElement('canvas');
  const bctx = body.getContext('2d')!;

  let W = 0,
    H = 0;
  const resize = () => {
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = W; // dpr 钉 1(参考站同款;高分屏线条略柔,换取一半以上像素成本)
    canvas.height = H;
    body.width = W;
    body.height = H;
    dirty = true;
  };

  const mouse = { x: -9999, y: -9999 };
  let tiltX = 0,
    tiltY = 0,
    driftX = 0,
    driftY = 0;
  let rot = 0; // 只随滚动累进
  let scale = 1,
    targetScale = 1;
  let vel = 0; // 滚动速度(Lenis 喂入,指数衰减)
  let dirty = true;
  let mouseStamp = 0,
    renderedStamp = -1;
  const dbg = { renders: 0 };
  (window as unknown as Record<string, unknown>).__xbg = dbg;

  const renderBody = () => {
    dbg.renders++;
    const a = rot + tiltX;
    const b = 0.42 + tiltY;
    const ca = Math.cos(a),
      sa = Math.sin(a),
      cb = Math.cos(b),
      sb = Math.sin(b);
    const sc = (Math.min(W, H) / 52) * scale;
    const cx = W * 0.42 + driftX;
    const cy = H * 0.52 + driftY;
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
      let x = cx + rx * sc * p;
      let y = cy - (ry * sb + Z * cb) * sc * p;
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

  // 流光:4 个亮头沿轨迹推进,150 段渐隐拖尾,按透明度分 6 桶批量描边
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
    // —— 滚动驱动的缩放/旋转(静止时全部归零,不自转不缩放)——
    vel *= 0.9;
    if (Math.abs(vel) < 0.05) vel = 0;
    const speed = Math.abs(vel);
    targetScale = 1 + Math.min(0.16, speed * 0.004);
    const prevScale = scale,
      prevRot = rot,
      prevTx = tiltX,
      prevTy = tiltY;
    scale += (targetScale - scale) * 0.07;
    if (Math.abs(targetScale - scale) < 5e-4) scale = targetScale; // 吸附定格,静止即停
    if (speed > 0.3) rot += vel * 0.00025;

    // —— 鼠标倾斜:在场 lerp 进(近目标即吸附定格),离场衰减 ——
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
      Math.abs(scale - prevScale) > 1e-4 ||
      Math.abs(rot - prevRot) > 1e-5 ||
      Math.abs(tiltX - prevTx) > 1e-4 ||
      Math.abs(tiltY - prevTy) > 1e-4
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
  return { setVel: (v) => (vel = v) };
}

/* ---------- ② Lenis 平滑滚动 + 锚点接管 + 滚动速度喂粒子 ---------- */
function initLenis(lorenz?: LorenzApi) {
  if (reduced) return;
  const lenis = new Lenis();
  const raf = (t: number) => {
    lenis.raf(t);
    requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);

  if (lorenz) lenis.on('scroll', (e: { velocity: number }) => lorenz.setVel(e.velocity));

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

/* ---------- ③ 滚动进场 reveal ---------- */
function initReveal() {
  const els = document.querySelectorAll('[data-rv]');
  if (!els.length || reduced) return; // reduced:CSS 已直出终态
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

/* ---------- ④ UTC 时钟(冒号 CSS 闪烁) ---------- */
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
  // 粒子背景延后到空闲帧,不挤首屏渲染;Lenis 需拿到粒子句柄喂滚动速度
  const wire = () => {
    const api = initLorenz();
    initLenis(api);
  };
  if ('requestIdleCallback' in window) {
    requestIdleCallback(wire, { timeout: 1200 });
  } else {
    setTimeout(wire, 300);
  }
  initReveal();
  initClock();
};
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
