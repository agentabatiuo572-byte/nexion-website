// cloudflare:test 的 env 类型 = 全局 Cloudflare.Env(worker-configuration.d.ts 生成);
// 这里只追加测试专用绑定 TEST_MIGRATIONS(vitest.config.ts 注入)。
import type { D1Migration } from '@cloudflare/vitest-pool-workers';

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
