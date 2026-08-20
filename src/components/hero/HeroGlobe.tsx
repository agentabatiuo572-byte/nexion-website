/* [FEAT-WEB02] hero 背景视觉岛 — cobe 发光点阵地球,品牌化(纯黑底 + 柠檬绿光点)。
   PRD 约束:懒挂载不进首包(client:visible)、失败/低端/reduced-motion 一律静默回退
   CSS poster(由父级 .globe-poster 承担,本组件挂载失败即保持透明不渲染)、
   离屏停帧、DPR ≤ 1.5、全站唯一 WebGL context。
   标记点 = PRD §1.2 五大目标市场区域的泛节点坐标(区域级,不虚构具体机房城市)。 */
import { useEffect, useRef } from 'react';
import createGlobe from 'cobe';

// [lat, lng] 区域级泛节点(北美/欧洲/东南亚/日韩/中东)
const REGION_MARKERS: { location: [number, number]; size: number }[] = [
  { location: [40, -100], size: 0.08 },
  { location: [34, -118], size: 0.05 },
  { location: [45, -75], size: 0.05 },
  { location: [51, 0], size: 0.07 },
  { location: [50, 10], size: 0.06 },
  { location: [48, 2], size: 0.05 },
  { location: [14, 105], size: 0.08 },
  { location: [1, 104], size: 0.06 },
  { location: [13, 122], size: 0.05 },
  { location: [36, 128], size: 0.06 },
  { location: [35, 137], size: 0.07 },
  { location: [25, 47], size: 0.06 },
  { location: [39, 35], size: 0.05 },
];

// token 值的 0-1 RGB 镜像(cobe 只吃数值;源 = tokens.css --v5-brand #9EDC1D)
const BRAND_RGB: [number, number, number] = [158 / 255, 220 / 255, 29 / 255];

export default function HeroGlobe() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // 低端降级:内存 <4GB 或核 <4 → 不挂,poster 顶上(PRD WEB02 异常2)
    const nav = navigator as Navigator & { deviceMemory?: number };
    if ((nav.deviceMemory ?? 8) < 4 || (navigator.hardwareConcurrency ?? 8) < 4) return;

    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let phi = 0;
    let width = 0;

    const onResize = () => {
      width = canvas.offsetWidth;
      // reduced(无 rAF)时静态帧也要跟上新尺寸
      if (reduced) globe?.update({ width: width * 2, height: width * 2 });
    };
    addEventListener('resize', onResize);
    width = canvas.offsetWidth;

    let globe: ReturnType<typeof createGlobe> | undefined;
    let raf = 0;
    try {
      globe = createGlobe(canvas, {
        devicePixelRatio: Math.min(devicePixelRatio, 1.5),
        width: width * 2,
        height: width * 2,
        phi: 0,
        theta: 0.22,
        dark: 1,
        diffuse: 1.2,
        mapSamples: 14000,
        mapBrightness: 4.2,
        baseColor: [0.12, 0.12, 0.12],
        markerColor: BRAND_RGB,
        glowColor: [0.28, 0.38, 0.08],
        markers: REGION_MARKERS,
      });
    } catch {
      // WebGL 不可用 → 保持透明,父级 poster 可见(异常2 静默回退)
      return;
    }
    // v2 姿势:自持 rAF 循环驱动 update;离屏 = 真停帧(cancelAnimationFrame)
    const tick = () => {
      phi += 0.0035;
      globe?.update({ phi, width: width * 2, height: width * 2 });
      raf = requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver(([e]) => {
      cancelAnimationFrame(raf);
      if (e.isIntersecting && !reduced) raf = requestAnimationFrame(tick);
    });
    io.observe(canvas);
    if (!reduced) raf = requestAnimationFrame(tick);
    // 挂载后淡入,替换 poster
    canvas.style.opacity = '1';

    return () => {
      cancelAnimationFrame(raf);
      globe?.destroy();
      io.disconnect();
      removeEventListener('resize', onResize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        width: '100%',
        aspectRatio: '1',
        opacity: 0,
        transition: 'opacity 0.9s ease',
        contain: 'layout paint size',
      }}
    />
  );
}
