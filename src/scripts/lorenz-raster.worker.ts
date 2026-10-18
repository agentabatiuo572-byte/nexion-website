/* Main thread owns backpressure: send at most one raster job,
   retain only the latest desired pose while busy, and match results by epoch/id.
   No visible canvas is transferred, so synchronous pause/reduce fallback remains
   available even if worker creation, initialization or rendering fails. */
import { renderLorenzRaster } from './lorenz-raster';

export interface LorenzRasterInit {
  type: 'init';
  tBucket: Uint8Array;
  stride: number;
  groupStyle: string[];
}

export interface LorenzRasterJob {
  type: 'raster';
  epoch: number;
  id: number;
  width: number;
  height: number;
  dpr: number;
  px: Float32Array;
  py: Float32Array;
  dep: Float32Array;
}

export interface LorenzRasterResult {
  type: 'raster';
  epoch: number;
  id: number;
  width: number;
  height: number;
  dpr: number;
  body: ImageBitmap;
  glow: ImageBitmap;
  px: Float32Array;
  py: Float32Array;
  dep: Float32Array;
}

export type LorenzRasterReply = LorenzRasterResult | { type: 'ready' } | {
  type: 'error';
  epoch?: number;
  id?: number;
  message: string;
};

// A structural worker scope keeps the app's existing DOM TypeScript library;
// adding a global webworker lib beside lib.dom would introduce duplicate globals.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<LorenzRasterInit | LorenzRasterJob>) => void) | null;
  postMessage(message: LorenzRasterReply, transfer?: Transferable[]): void;
};

let settings: LorenzRasterInit | null = null;
let body: OffscreenCanvas | null = null;
let glow: OffscreenCanvas | null = null;
let bctx: OffscreenCanvasRenderingContext2D | null = null;
let gctx: OffscreenCanvasRenderingContext2D | null = null;

scope.onmessage = ({ data }) => {
  let bodyBitmap: ImageBitmap | null = null;
  let glowBitmap: ImageBitmap | null = null;
  try {
    if (data.type === 'init') {
      body = new OffscreenCanvas(1, 1);
      glow = new OffscreenCanvas(1, 1);
      bctx = body.getContext('2d', { alpha: false });
      gctx = glow.getContext('2d');
      if (!bctx || !gctx) throw new Error('OffscreenCanvas 2D context unavailable');
      if (!('filter' in gctx) || typeof body.transferToImageBitmap !== 'function') {
        throw new Error('OffscreenCanvas filter or ImageBitmap transfer unavailable');
      }
      gctx.filter = 'blur(7px)';
      if (gctx.filter !== 'blur(7px)') throw new Error('OffscreenCanvas blur filter unavailable');
      gctx.filter = 'none';
      settings = data;
      scope.postMessage({ type: 'ready' });
      return;
    }

    if (!settings || !body || !glow || !bctx || !gctx) throw new Error('Raster worker not initialized');
    renderLorenzRaster(
      bctx, gctx, data.width, data.height, data.dpr,
      data.px, data.py, data.dep, settings.tBucket, settings.stride, settings.groupStyle,
    );
    // Produce glow before transferring body: transferToImageBitmap replaces the
    // source canvas image, so glow must already be complete at this point.
    bodyBitmap = body.transferToImageBitmap();
    glowBitmap = glow.transferToImageBitmap();
    scope.postMessage({
      type: 'raster', epoch: data.epoch, id: data.id,
      width: data.width, height: data.height, dpr: data.dpr,
      body: bodyBitmap, glow: glowBitmap, px: data.px, py: data.py, dep: data.dep,
    }, [bodyBitmap, glowBitmap, data.px.buffer as ArrayBuffer, data.py.buffer as ArrayBuffer, data.dep.buffer as ArrayBuffer]);
    bodyBitmap = null;
    glowBitmap = null;
  } catch (error) {
    bodyBitmap?.close();
    glowBitmap?.close();
    scope.postMessage({
      type: 'error',
      ...(data.type === 'raster' ? { epoch: data.epoch, id: data.id } : {}),
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
