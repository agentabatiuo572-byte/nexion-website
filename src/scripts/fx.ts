/* 全站交互引擎 R7(axiom 方向,自研实现;参数规格见 PRD/specs/WEBSITE-axiom-teardown.md)。
   ① 洛伦兹背景:五姿态链式插值(界内恒定/跨界变形),首绘 1s zoom-fade 入场;
   ② Lenis:duration 1.2 + easeOutExpo(恒定收尾时长的「奢滑」);
   ③ 行遮罩逐行上滑(display 标题唯一进场方式)+ ④ 打字机(mono 眉标/编号);
   ⑤ data-rv 次要块 reveal(阈值 .05/底-20px,位移 12px);
   ⑥ 设备 deck:整排连续推进传送带(恒一步差,无显隐翻转),步距 1.0923 卡宽;
   ⑦ 三列滚动视差(反白卡区);⑧ UTC 时钟(秒奇偶冒号,锁墙钟秒);
   首载四拍编排由 html.x-boot + CSS 时间线承担(仅首页)。
   reduced-motion:全部降级直显。 */
import Lenis from 'lenis';

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = matchMedia('(pointer: coarse)').matches;

/* ---------- ① 洛伦兹吸引子背景 ---------- */
function initLorenz() {
  const canvas = document.getElementById('x-bg') as HTMLCanvasElement | null;
  if (!canvas) return;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return;

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
  const bctx = body.getContext('2d')!;
  /* R32:辉光离屏——线条图的模糊副本承载「点燃带」,与线条层同帧贴合成;
     只在主体重渲时烘焙一次,帧循环零滤镜成本 */
  const glow = document.createElement('canvas');
  const gctx = glow.getContext('2d')!;

  let W = 0,
    H = 0;

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
  const dbg = { renders: 0, tiltX: 0, tiltY: 0, driftX: 0, driftY: 0 };
  (window as unknown as Record<string, unknown>).__xbg = dbg;

  /* R36:高分屏适配——渲染精度乘 DPR(性能上限 1.5:主体重渲像素 ≤2.25×,离屏缓存机制不变) */
  let DPR = 1;
  const resize = () => {
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    DPR = Math.min(window.devicePixelRatio || 1, 1.5);
    for (const c of [canvas, body, glow, cometLayer]) {
      c.width = Math.round(W * DPR);
      c.height = Math.round(H * DPR);
    }
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    bctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    gctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    cctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    dirty = true;
  };

  const renderBody = (cx: number, cy: number, G: number, yaw: number, pitch: number) => {
    dbg.renders++;
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

    for (const g of groups) g.length = 0;
    for (let i = stride; i < N - stride; i += stride) {
      const d = Math.min(DB - 1, Math.max(0, Math.floor(((dep[i] + 1) / 2) * DB)));
      groups[tBucket[i] * DB + d].push(i);
    }

    /* R33:不透明黑底(screen 合成下黑=无效果),配合预乘亮度色实现零增亮覆盖 */
    bctx.globalCompositeOperation = 'source-over';
    bctx.fillStyle = '#000000';
    bctx.fillRect(0, 0, W, H);
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
    /* R32:烘焙辉光副本(仅重渲帧执行);drawImage 显式逻辑尺寸(DPR 变换下源为物理像素) */
    gctx.clearRect(0, 0, W, H);
    gctx.filter = 'blur(7px)';
    gctx.globalAlpha = 0.85;
    gctx.drawImage(body, 0, 0, W, H);
    gctx.filter = 'none';
    gctx.globalAlpha = 1;
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
  const cctx = cometLayer.getContext('2d')!;
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
        cctx.moveTo(px[i0], py[i0]);
        for (let k = k0 + 1; k <= k1; k++) {
          const i = (head - k + N) % N;
          cctx.lineTo(px[i], py[i]);
        }
        cctx.strokeStyle = cometStyles[cb2];
        cctx.stroke();
      }
    }
    ctx.drawImage(cometLayer, 0, 0, W, H); /* ctx 处于 screen 模式,黑底无效果 */
  };

  let raf = 0;
  let running = false;
  const frame = () => {
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
    ctx.drawImage(glow, 0, 0, W, H); /* R32:辉光垫底(点燃带) */
    ctx.drawImage(body, 0, 0, W, H);
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
    ctx.drawImage(glow, 0, 0, W, H);
    ctx.drawImage(body, 0, 0, W, H);
    return;
  }
  start();
  // 首载第一拍:1s zoom-fade(P1-15;参考曲线 (0.22,1,.36,1),scale 起点目测 1.04)
  canvas.animate(
    [
      { opacity: 0, transform: 'scale(1.04)' },
      { opacity: 1, transform: 'scale(1)' },
    ],
    { duration: 1000, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both' },
  );
}

/* ---------- ② Lenis(duration 1.2 + easeOutExpo,恒定收尾时长) ---------- */
function initLenis() {
  if (reduced) return;
  const lenis = new Lenis({
    duration: 1.2,
    easing: (t: number) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
  });
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
    lenis.scrollTo(el.getBoundingClientRect().top + window.scrollY - 84);
    history.pushState(null, '', `#${id}`);
  });
  return lenis;
}

/* ---------- ③ 行遮罩逐行上滑(display 标题;P1-01) ---------- */
function initLineReveal() {
  const els = [...document.querySelectorAll<HTMLElement>('[data-lr]')];
  if (!els.length || reduced) return;

  const splitWords = (text: string, lang: string): string[] => {
    if (lang.startsWith('zh') && 'Segmenter' in Intl) {
      const seg = new (Intl as unknown as { Segmenter: new (l: string, o: object) => { segment(t: string): Iterable<{ segment: string }> } }).Segmenter('zh', { granularity: 'word' });
      return [...seg.segment(text)].map((s) => s.segment);
    }
    return text.split(/(\s+)/).filter((s) => s.length);
  };

  const build = (el: HTMLElement) => {
    const original = el.textContent ?? '';
    const lang = document.documentElement.lang || 'en';
    el.setAttribute('aria-label', original.trim());
    // 词包 span → 按 rect.top 归行
    el.textContent = '';
    const words = splitWords(original, lang);
    const spans = words.map((w) => {
      const s = document.createElement('span');
      s.textContent = w;
      if (!/^\s+$/.test(w)) s.style.display = 'inline-block';
      el.appendChild(s);
      return s;
    });
    const lines: HTMLSpanElement[][] = [];
    let lastTop = -1e9;
    for (const s of spans) {
      // R42:空白块保持 inline(行盒高),词块是 inline-block(内容盒高),两者 rect.top 实测差 7px,
      // 超过 2px 阈值 ⇒ 每个空白开一新「行」、其后每个词再开一新「行」,标题被裂成「一词一行」的词梯。
      // 实测后果:首屏标题载入后 2.4 秒内高 531px(应 212px),33 路由 75 个标题全中。
      // 空白不参与归行判定,跟着前一行走即可。
      if (/^\s+$/.test(s.textContent || '')) {
        if (lines.length) lines[lines.length - 1].push(s);
        continue;
      }
      const top = Math.round(s.getBoundingClientRect().top);
      if (Math.abs(top - lastTop) > 2) {
        lines.push([]);
        lastTop = top;
      }
      lines[lines.length - 1].push(s);
    }
    el.textContent = '';
    const inners: HTMLElement[] = [];
    for (let li = 0; li < lines.length; li++) {
      const outer = document.createElement('span');
      outer.className = 'lr-line';
      outer.setAttribute('aria-hidden', 'true');
      const inner = document.createElement('span');
      inner.className = 'lr-inner';
      inner.style.setProperty('--lrd', `${li * 90}ms`);
      for (const s of lines[li]) inner.appendChild(s);
      outer.appendChild(inner);
      el.appendChild(outer);
      inners.push(inner);
    }
    const play = () => {
      requestAnimationFrame(() => requestAnimationFrame(() => inners.forEach((n) => n.classList.add('in'))));
      const last = inners[inners.length - 1];
      last.addEventListener(
        'transitionend',
        () => {
          el.textContent = original; // 还原原始文本(a11y/选中/SEO 一致性)
          el.removeAttribute('aria-label');
        },
        { once: true },
      );
    };
    const mode = el.dataset.lr;
    const delay = Number(el.dataset.lrDelay || 0);
    if (mode === 'load') {
      setTimeout(play, delay);
    } else {
      const io = new IntersectionObserver(
        ([en]) => {
          if (en.isIntersecting) {
            io.disconnect();
            setTimeout(play, delay);
          }
        },
        { threshold: 0.05, rootMargin: '0px 0px -20px 0px' },
      );
      io.observe(el);
    }
  };

  (document.fonts?.ready ?? Promise.resolve()).then(() => els.forEach(build));
}

/* ---------- ④ 打字机(mono 眉标/编号;P1-02) ---------- */
function initType() {
  const els = [...document.querySelectorAll<HTMLElement>('[data-tw]')];
  if (!els.length || reduced) return;
  const zh = (document.documentElement.lang || '').startsWith('zh');
  const run = (el: HTMLElement) => {
    const text = el.textContent ?? '';
    const speed = Number(el.dataset.twSpeed || (zh ? 90 : 50));
    el.style.display = 'inline-block';
    el.style.width = `${text.length}ch`;
    el.setAttribute('aria-label', text);
    el.textContent = '';
    let i = 0;
    const iv = setInterval(() => {
      i++;
      el.textContent = text.slice(0, i);
      if (i >= text.length) {
        clearInterval(iv);
        el.textContent = text;
        el.style.width = '';
        el.removeAttribute('aria-label');
      }
    }, speed);
  };
  for (const el of els) {
    const delay = Number(el.dataset.twDelay || 0);
    if (el.dataset.tw === 'load') {
      setTimeout(() => run(el), delay);
    } else {
      const io = new IntersectionObserver(
        ([en]) => {
          if (en.isIntersecting) {
            io.disconnect();
            setTimeout(() => run(el), delay);
          }
        },
        { threshold: 0.1 },
      );
      io.observe(el);
    }
  }
}

/* ---------- ⑤ 次要块 reveal(P1-03:阈值 .05/底-20px) ---------- */
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
    { threshold: 0.05, rootMargin: '0px 0px -20px 0px' },
  );
  els.forEach((el) => io.observe(el));
}

/* ---------- ⑥ 设备 deck:画布几何连续推进(R8) ----------
   机制:滚动总程 = N×区高,拍 k 占 [k/N,(k+1)/N];
   卡 i 位移 = STEP·(i − Σ_{k<i}beats)(STEP=1.0923 卡宽),缩放 = 1−0.15·beats[i];
   末态全叠于锚位(高序号在上);白幕布带(.band-light)在 decked 时上拉一个区高盖过钉屏尾段。 */
function initPile() {
  const sec = document.querySelector<HTMLElement>('[data-deck]');
  const pin = sec?.querySelector<HTMLElement>('[data-deck-pin]') ?? null;
  const cards = sec ? [...sec.querySelectorAll<HTMLElement>('[data-deck-card]')] : [];
  const band = document.querySelector<HTMLElement>('.band-light');
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
    band?.classList.remove('curtain');
    sec.style.height = '';
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
    const e = clamp01((T - sec.getBoundingClientRect().top) / DIST);
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
      band?.classList.add('curtain');
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
  if (!els.length || reduced || coarse) return;
  let raf = 0;
  const apply = () => {
    raf = 0;
    if (matchMedia('(max-width: 850px)').matches) {
      for (const el of els) el.style.transform = '';
      return;
    }
    const vh2 = innerHeight / 2;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      const k = Number(el.dataset.plx || 0.08);
      const dy = (vh2 - (r.top + r.height / 2)) * k;
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
  el.replaceChildren('UTC ', h12, colon, mm, ' ', ap);
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

/* ---------- ⑨ 导航字符扰动 hover(R10):悬停即扰动、左→右每 4 帧定格一字 ----------
   字池按文种分:拉丁→A-Z、数字→0-9、CJK→基础笔画(一丨丿丶乛十),
   空格/标点不动 → 宽度稳定不跳版;中文不闪随机汉字(避免乱码感,笔画=「字在组装」)。
   移开立即还原;按下取消(点击瞬间文本必须稳定);reduced/无 hover 设备不挂。 */
function initScramble() {
  const els = [...document.querySelectorAll<HTMLElement>('[data-scr]')];
  if (!els.length || reduced || !matchMedia('(hover: hover)').matches) return;
  const LAT = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const DIG = '0123456789';
  const CJK = '一丨丿丶乛十';
  const isCjk = (ch: string) => /[㐀-鿿豈-﫿]/.test(ch);
  const pick = (pool: string) => pool[Math.floor(Math.random() * pool.length)];
  const scrambleChar = (ch: string) => {
    if (/\s/.test(ch)) return ch;
    if (isCjk(ch)) return pick(CJK);
    if (/[0-9]/.test(ch)) return pick(DIG);
    if (/[A-Za-zÀ-ỹ]/.test(ch)) return pick(LAT);
    return ch; // 标点/符号不扰动
  };
  for (const el of els) {
    const original = el.textContent ?? '';
    if (!original.trim()) continue;
    const chars = [...original]; // 码点级拆分(vi 声调字 NFC 单码点,安全)
    el.setAttribute('aria-label', original.trim());
    let raf = 0;
    let frame = 0;
    const stop = (restore: boolean) => {
      cancelAnimationFrame(raf);
      raf = 0;
      if (restore) el.textContent = original;
    };
    const run = () => {
      const settled = Math.min(Math.floor(frame / 4), chars.length);
      el.textContent = chars.map((c, i) => (i < settled ? c : scrambleChar(c))).join('');
      frame++;
      if (settled < chars.length) raf = requestAnimationFrame(run);
      else raf = 0;
    };
    el.addEventListener('mouseenter', () => {
      stop(false);
      frame = 0;
      raf = requestAnimationFrame(run);
    });
    el.addEventListener('mouseleave', () => stop(true));
    el.addEventListener('pointerdown', () => stop(true));
  }
}

/* ---------- boot ---------- */
const boot = () => {
  const html = document.documentElement;
  html.classList.add('js'); // no-JS 防隐形闸(P2-09)
  // 首载四拍编排仅首页(三语首页路径);内页即显
  if (/^\/(vi\/?|zh\/?)?$/.test(location.pathname)) html.classList.add('x-boot');

  if ('requestIdleCallback' in window) {
    requestIdleCallback(() => initLorenz(), { timeout: 800 });
  } else {
    setTimeout(initLorenz, 200);
  }
  initLenis();
  initLineReveal();
  initType();
  initReveal();
  initClock();
  initPile();
  initParallax();
  initScramble();
};
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
