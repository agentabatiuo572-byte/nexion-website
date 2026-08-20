/* 等高线纹样生成器 — 构建期跑,输出同心扰动环 path 组(卡片装饰图形)。
   确定性伪随机(seed 驱动),纯数学生成,无外部资产。 */

function prng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

export interface ContourArt {
  viewBox: string;
  paths: string[];
}

/** rings 条同心扰动环,中心 (cx,cy),整体尺寸 w×h */
export function contour(seed: number, rings = 14, w = 480, h = 300): ContourArt {
  const rnd = prng(seed);
  const cx = w * (0.3 + rnd() * 0.4);
  const cy = h * (0.35 + rnd() * 0.3);
  const f1 = 2 + Math.floor(rnd() * 3); // 扰动谐波
  const f2 = 3 + Math.floor(rnd() * 4);
  const p1 = rnd() * Math.PI * 2;
  const p2 = rnd() * Math.PI * 2;
  const squash = 0.5 + rnd() * 0.25; // 纵向压扁
  const maxR = Math.min(w, h) * 1.15;
  const paths: string[] = [];

  for (let i = 1; i <= rings; i++) {
    const base = (maxR / rings) * i;
    const wob = base * (0.1 + 0.12 * rnd());
    const STEPS = 64;
    let d = '';
    for (let k = 0; k <= STEPS; k++) {
      const a = (k / STEPS) * Math.PI * 2;
      const r = base + wob * Math.sin(f1 * a + p1 + i * 0.35) + wob * 0.6 * Math.sin(f2 * a + p2 - i * 0.2);
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r * squash;
      d += (k === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1);
    }
    d += 'Z';
    paths.push(d);
  }
  return { viewBox: `0 0 ${w} ${h}`, paths };
}
