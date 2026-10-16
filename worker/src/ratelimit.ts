/* 内存限速器工厂(每 isolate 近似值:滥用挡板,不是计费表;需要全局精确时升级 Rate Limiting binding / DO)。
   统一出处:采集(CON15-E2)、直通兑换、拦截统计写入共用同一实现,避免各写各的节流语义。 */

export interface Limiter {
  /** 返回 true = 已超限(应拒绝) */
  hit(key: string, now?: number): boolean;
  reset(): void;
}

export function createLimiter(windowMs: number, burst: number, maxKeys = 10_000): Limiter {
  let bucket = new Map<string, { n: number; start: number }>();
  return {
    hit(key, now = Date.now()) {
      const b = bucket.get(key);
      if (!b || now - b.start > windowMs) {
        if (!b && bucket.size >= maxKeys) {
          for (const [oldKey, value] of bucket) if (now - value.start > windowMs) bucket.delete(oldKey);
          if (bucket.size >= maxKeys) return true;
        }
        bucket.set(key, { n: 1, start: now });
        return false;
      }
      b.n++;
      return b.n > burst;
    },
    reset() {
      bucket = new Map();
    },
  };
}
