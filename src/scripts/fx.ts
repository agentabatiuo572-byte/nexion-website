/* 全站交互引擎(axiom 方向,自研实现):
   ① 固定全屏洛伦兹吸引子粒子背景(鼠标推斥 + 倾斜跟随 + 流星拖尾)
   ② Lenis 平滑滚动  ③ 自定义琥珀圆点光标  ④ 滚动进场 reveal
   ⑤ 导航 UTC 时钟  ⑥ 设备板块 pinned 横向轨
   reduced-motion:①静帧 ②③④⑥ 全关(⑥ 降级原生横滑)。 */
import Lenis from 'lenis';

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = matchMedia('(pointer: coarse)').matches;

/* ---------- ① 洛伦兹吸引子背景 ---------- */
function initLorenz() {
  const canvas = document.getElementById('x-bg') as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return;

  // 经典参数 σ=10 ρ=28 β=8/3,欧拉步 dt=0.005;先热身进入吸引子再录轨迹
  const N = coarse ? 7000 : 20000;
  const pts = new Float32Array(N * 3);
  let x = 0.1,
    y = 0,
    z = 0;
  const step = () => {
    const dx = 10 * (y - x);
    const dy = x * (28 - z) - y;
    const dz = x * y - (8 / 3) * z;
    x += 0.005 * dx;
    y += 0.005 * dy;
    z += 0.005 * dz;
  };
  for (let i = 0; i < 6000; i++) step();
  for (let i = 0; i < N; i++) {
    step();
    pts[i * 3] = x;
    pts[i * 3 + 1] = y;
    pts[i * 3 + 2] = z;
  }

  const px = new Float32Array(N); // 投影后坐标
  const py = new Float32Array(N);
  const ag = new Float32Array(N); // 鼠标扰动量(用于提亮)

  let W = 0,
    H = 0,
    dpr = 1;
  const resize = () => {
    dpr = Math.min(devicePixelRatio || 1, 1.5);
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();

  const mouse = { x: -9999, y: -9999 };
  let tiltX = 0,
    tiltY = 0, // 鼠标驱动的附加旋转(lerp 进,离开衰减)
    driftX = 0,
    driftY = 0; // 中心微漂移
  let az = 0; // 基础方位角,持续慢转

  let raf = 0;
  let running = false;
  const frame = () => {
    az += 0.0016;

    // 鼠标影响:在场 lerp 进,不在场指数衰减
    if (mouse.x > -9000) {
      const nx = (mouse.x / W - 0.5) * 2;
      const ny = (mouse.y / H - 0.5) * 2;
      tiltX += (0.35 * nx - tiltX) * 0.035;
      tiltY += (0.28 * ny - tiltY) * 0.035;
      driftX += (24 * nx - driftX) * 0.035;
      driftY += (18 * ny - driftY) * 0.035;
    } else {
      tiltX *= 0.96;
      tiltY *= 0.96;
      driftX *= 0.96;
      driftY *= 0.96;
    }

    const a = az + tiltX; // 绕竖轴
    const b = 0.42 + tiltY; // 俯仰
    const ca = Math.cos(a),
      sa = Math.sin(a),
      cb = Math.cos(b),
      sb = Math.sin(b);

    // 吸引子几何中心约 (0,0,27);画布锚点偏左居中(参考站构图)
    const scale = Math.min(W, H) / 52;
    const cx = W * 0.42 + driftX;
    const cy = H * 0.52 + driftY;

    for (let i = 0; i < N; i++) {
      const X = pts[i * 3],
        Y = pts[i * 3 + 1],
        Z = pts[i * 3 + 2] - 27;
      const rx = X * ca - Y * sa;
      const ry = X * sa + Y * ca;
      const rz = ry * cb - Z * sb; // 旋转后的深度分量
      const depth = Math.max(-1, Math.min(1, rz / 22));
      const p = 1 + 0.2 * depth; // 近大远小的轻微透视
      let sx = cx + rx * scale * p;
      let sy = cy - (ry * sb + Z * cb) * scale * p;

      // 鼠标推斥:半径 160px,力随距离二次衰减
      let w = 0;
      if (!coarse && mouse.x > -9000) {
        const ddx = sx - mouse.x;
        const ddy = sy - mouse.y;
        const d = Math.hypot(ddx, ddy);
        if (d >= 1 && d < 160) {
          const f = 90 * (1 - d / 160) ** 2;
          sx += (ddx / d) * f;
          sy += (ddy / d) * f;
          w = 1 - d / 160;
        }
      }
      px[i] = sx;
      py[i] = sy;
      ag[i] = w;
    }

    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#0c0c0d';
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'screen';
    ctx.lineWidth = 1.2;

    // 主体轨迹:z 深浅映射暗琥珀 → 亮金
    const stride = coarse ? 3 : 1;
    for (let i = stride; i < N - stride; i += stride) {
      const t = Math.max(0, Math.min(1, (pts[i * 3 + 2] - 2) / 46));
      const boost = 1 + 0.5 * ag[i];
      const r = Math.round(55 + 200 * t);
      const g = Math.round(30 + 155 * t);
      const bl = Math.round(2 + 10 * t);
      const alpha = Math.min(1, (0.1 + 0.42 * t) * boost);
      ctx.beginPath();
      ctx.moveTo((px[i - stride] + px[i]) / 2, (py[i - stride] + py[i]) / 2);
      ctx.quadraticCurveTo(px[i], py[i], (px[i + stride] + px[i]) / 2, (py[i + stride] + py[i]) / 2);
      ctx.strokeStyle = `rgba(${r},${g},${bl},${alpha})`;
      ctx.stroke();
    }

    // 流星:4 个亮头沿轨迹推进,180 段渐隐拖尾(移动端省略)
    if (!coarse) {
      comet = (comet + 0.5) % N;
      for (let c = 0; c < 4; c++) {
        const head = Math.floor((comet + (N / 4) * c) % N);
        for (let k = 1; k < 180; k++) {
          const i = (head - k + N) % N;
          const j = (i + 1) % N;
          const fade = 1 - k / 180;
          ctx.beginPath();
          ctx.moveTo(px[i], py[i]);
          ctx.lineTo(px[j], py[j]);
          ctx.strokeStyle = `rgba(255,196,64,${(fade * fade * 0.7).toFixed(3)})`;
          ctx.stroke();
        }
      }
    }

    if (running) raf = requestAnimationFrame(frame);
  };
  let comet = 0;

  const start = () => {
    if (running || reduced) return;
    running = true;
    raf = requestAnimationFrame(frame);
  };
  const stop = () => {
    running = false;
    cancelAnimationFrame(raf);
  };

  addEventListener('resize', resize);
  if (!coarse) {
    addEventListener(
      'mousemove',
      (e) => {
        mouse.x = e.clientX;
        mouse.y = e.clientY;
      },
      { passive: true },
    );
    document.documentElement.addEventListener('mouseleave', () => {
      mouse.x = -9999;
      mouse.y = -9999;
    });
  }
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));

  if (reduced) {
    // 静帧:渲染一帧即止(无旋转/无推斥/无拖尾)
    running = true;
    frame();
    running = false;
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

/* ---------- ③ 自定义光标(fine pointer 限定) ---------- */
function initCursor() {
  if (reduced || coarse || !matchMedia('(pointer: fine)').matches) return;
  const dot = document.createElement('div');
  dot.id = 'x-cursor-dot';
  dot.style.left = '-30px';
  dot.style.top = '-30px';
  document.body.appendChild(dot);
  document.documentElement.classList.add('x-cursor');

  let tx = -30,
    ty = -30,
    cxr = -30,
    cyr = -30,
    shown = false;
  addEventListener(
    'mousemove',
    (e) => {
      tx = e.clientX;
      ty = e.clientY;
      if (!shown) {
        cxr = tx;
        cyr = ty;
        shown = true;
      }
      const on = (e.target as HTMLElement).closest?.('a, button, summary, [data-cursor-big]');
      dot.classList.toggle('big', !!on);
    },
    { passive: true },
  );
  document.documentElement.addEventListener('mouseleave', () => {
    dot.style.opacity = '0';
  });
  document.documentElement.addEventListener('mouseenter', () => {
    dot.style.opacity = '1';
  });
  const loop = () => {
    cxr += (tx - cxr) * 0.22;
    cyr += (ty - cyr) * 0.22;
    dot.style.left = `${cxr}px`;
    dot.style.top = `${cyr}px`;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

/* ---------- ④ 滚动进场 reveal ---------- */
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

/* ---------- ⑥ 设备横向轨(sticky pin + 进度驱动) ---------- */
function initRail() {
  const sec = document.querySelector<HTMLElement>('[data-rail]');
  const track = sec?.querySelector<HTMLElement>('[data-rail-track]');
  if (!sec || !track) return;
  const mobile = () => matchMedia('(max-width: 860px)').matches;
  if (reduced || coarse || mobile()) return; // CSS 原生横滑降级
  sec.classList.add('railed'); // JS 接管标记:track 由横滑容器切换为 transform 驱动

  let span = 0;
  const measure = () => {
    const vw = innerWidth;
    span = Math.max(0, track.scrollWidth - vw);
    sec.style.height = `${innerHeight + span}px`;
  };
  measure();
  addEventListener('resize', measure);

  let raf = 0;
  const apply = () => {
    raf = 0;
    const r = sec.getBoundingClientRect();
    const total = sec.offsetHeight - innerHeight;
    const p = total > 0 ? Math.min(1, Math.max(0, -r.top / total)) : 0;
    track.style.transform = `translate3d(${-p * span}px,0,0)`;
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

/* ---------- boot ---------- */
const boot = () => {
  // 粒子背景延后到空闲帧,不挤首屏渲染
  if ('requestIdleCallback' in window) {
    requestIdleCallback(() => initLorenz(), { timeout: 1200 });
  } else {
    setTimeout(initLorenz, 300);
  }
  initLenis();
  initCursor();
  initReveal();
  initClock();
  initRail();
};
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
