/* Shared full-resolution raster path for the restored Lorenz
   body and glow. Projection, animation, copy shields and compositing stay in fx.
   The synchronous fallback must call this same function with HTML canvases. */
export type LorenzRasterContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const DB = 3;
const groupsByContext = new WeakMap<LorenzRasterContext, number[][]>();
const samplesByContext = new WeakMap<LorenzRasterContext, LorenzRasterContext>();

export function renderLorenzRaster(
  bodyContext: LorenzRasterContext,
  gctx: LorenzRasterContext,
  width: number,
  height: number,
  dpr: number,
  px: Float32Array,
  py: Float32Array,
  dep: Float32Array,
  tBucket: Uint8Array,
  stride: number,
  groupStyle: readonly string[],
): void {
  const pixelWidth = Math.max(1, Math.round(width * dpr));
  const pixelHeight = Math.max(1, Math.round(height * dpr));
  for (const context of [bodyContext, gctx]) {
    if (context.canvas.width !== pixelWidth) context.canvas.width = pixelWidth;
    if (context.canvas.height !== pixelHeight) context.canvas.height = pixelHeight;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // 先以更密的采样栅格绘制，再单次缩回输出像素；线宽、轨迹和配色不变。
  // 像素预算约束超宽屏缓存，避免抗锯齿导致无界内存增长。
  let bctx = samplesByContext.get(bodyContext);
  if (!bctx) {
    const sample = typeof document !== 'undefined' ? document.createElement('canvas') : new OffscreenCanvas(1, 1);
    bctx = sample.getContext('2d', { alpha: false }) as LorenzRasterContext | null ?? bodyContext;
    samplesByContext.set(bodyContext, bctx);
  }
  const sampleScale = bctx === bodyContext ? 1 : Math.max(1, Math.min(1.5, Math.sqrt(11e6 / (pixelWidth * pixelHeight))));
  const sampleWidth = Math.round(pixelWidth * sampleScale);
  const sampleHeight = Math.round(pixelHeight * sampleScale);
  if (bctx.canvas.width !== sampleWidth) bctx.canvas.width = sampleWidth;
  if (bctx.canvas.height !== sampleHeight) bctx.canvas.height = sampleHeight;
  bctx.setTransform(dpr * sampleScale, 0, 0, dpr * sampleScale, 0, 0);

  let groups = groupsByContext.get(bctx);
  if (!groups || groups.length !== groupStyle.length) {
    groups = Array.from({ length: groupStyle.length }, () => []);
    groupsByContext.set(bctx, groups);
  }
  for (const group of groups) group.length = 0;
  for (let i = stride; i < px.length - stride; i += stride) {
    const depth = Math.min(DB - 1, Math.max(0, Math.floor(((dep[i] + 1) / 2) * DB)));
    groups[tBucket[i] * DB + depth].push(i);
  }

  // Same opaque black / screen-compositing contract as the original body.
  bctx.globalCompositeOperation = 'source-over';
  bctx.fillStyle = '#000000';
  bctx.fillRect(0, 0, width, height);
  bctx.lineWidth = 1.2;
  for (let gi = 0; gi < groups.length; gi++) {
    const indices = groups[gi];
    if (!indices.length) continue;
    bctx.beginPath();
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k];
      bctx.moveTo((px[i - stride] + px[i]) / 2, (py[i - stride] + py[i]) / 2);
      bctx.quadraticCurveTo(px[i], py[i], (px[i + stride] + px[i]) / 2, (py[i + stride] + py[i]) / 2);
    }
    bctx.strokeStyle = groupStyle[gi];
    bctx.stroke();
  }

  if (bctx !== bodyContext) {
    bodyContext.imageSmoothingEnabled = true;
    bodyContext.imageSmoothingQuality = 'high';
    bodyContext.drawImage(bctx.canvas, 0, 0, width, height);
  }

  // Keep the full-resolution original glow and intensity; no motion quality tier.
  gctx.clearRect(0, 0, width, height);
  gctx.filter = 'blur(7px)';
  gctx.globalAlpha = 0.1;
  gctx.drawImage(bodyContext.canvas, 0, 0, width, height);
  gctx.filter = 'none';
  gctx.globalAlpha = 1;
}
