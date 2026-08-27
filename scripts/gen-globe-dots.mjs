/* 点阵地球数据生成器(R47 · docs/changes/2026-08-27-dotted-globe.md)。
   用法:node scripts/gen-globe-dots.mjs <ne_110m_land.geojson 路径>
   输入:Natural Earth 110m land(公有领域,https://www.naturalearthdata.com/,不入仓);
   输出:src/scripts/globe-dots.ts —— centi-degree Int16 交错 [lat,lon],base64(小端)。
   采样:纬度行错位(行距 1.7°,行内经度步长 1.7°/cos(lat),隔行半步)——与参考组件的
   stagger 行观感一致,且球面等间距(经纬网格采样会在两极聚集,不用)。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.argv[2];
if (!src) {
  console.error('用法:node scripts/gen-globe-dots.mjs <ne_110m_land.geojson 路径>');
  process.exit(2);
}
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const gj = JSON.parse(readFileSync(src, 'utf8'));

/* 收集全部环(外环/内环同表,even-odd 天然处理孔洞)+ 包围盒预筛 */
const rings = [];
for (const f of gj.features) {
  const g = f.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  for (const p of polys)
    for (const r of p) {
      let x0 = 180, x1 = -180, y0 = 90, y1 = -90;
      for (const [x, y] of r) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      rings.push({ pts: r, x0, x1, y0, y1 });
    }
}

const inLand = (lon, lat) => {
  let inside = false;
  for (const R of rings) {
    if (lon < R.x0 || lon > R.x1 || lat < R.y0 || lat > R.y1) continue;
    const p = R.pts;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const [xi, yi] = p[i];
      const [xj, yj] = p[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
};

const STEP = 1.7; /* 度;全球候选约 1.43 万,陆地约 29% → ~4.2k 点 */
const out = [];
let cand = 0;
const band = new Map(); /* 30° 纬度带统计(自证 Antarctica 等没有整带丢失) */
let row = 0;
for (let lat = -90 + STEP / 2; lat < 90; lat += STEP, row++) {
  const n = Math.max(1, Math.round((360 * Math.cos((lat * Math.PI) / 180)) / STEP));
  const lonStep = 360 / n;
  const off = row % 2 ? lonStep / 2 : 0;
  for (let k = 0; k < n; k++) {
    cand++;
    let lon = -180 + off + (k + 0.5) * lonStep;
    if (lon >= 180) lon -= 360;
    if (inLand(lon, lat)) {
      out.push(Math.round(lat * 100), Math.round(lon * 100));
      const b = Math.floor(lat / 30) * 30;
      band.set(b, (band.get(b) || 0) + 1);
    }
  }
}

const N = out.length / 2;
const i16 = new Int16Array(out); /* x86/node 小端;消费端按小端显式解码 */
const b64 = Buffer.from(i16.buffer).toString('base64');
const ts = `/* 由 scripts/gen-globe-dots.mjs 生成 —— 输入 Natural Earth 110m land(公有领域),禁手改。
   纬度行错位采样(行距 ${STEP}°,行内 ${STEP}°/cos(lat),隔行半步),N=${N};
   编码:centi-degree Int16 交错 [lat,lon],小端 base64。再生成:见生成器头注。 */
export const GLOBE_DOTS_N = ${N};
export const GLOBE_DOTS_B64 =
  '${b64}';
`;
writeFileSync(join(ROOT, 'src', 'scripts', 'globe-dots.ts'), ts, 'utf8');
console.log(`候选 ${cand} → 陆地 ${N} 点;TS 源 ${(ts.length / 1024).toFixed(1)}KB(base64 ${(b64.length / 1024).toFixed(1)}KB)`);
console.log('纬度带分布:', [...band.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}°:${v}`).join('  '));
