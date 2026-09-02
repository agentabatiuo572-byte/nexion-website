// 红测配置(plan T1-AC3):故意不给 D1 binding,证明冒烟测试真依赖 D1。
// 用法:npm run test:red-d1 —— 预期【非零退出】;它绿了才是坏事。
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.red.jsonc' } })],
  test: {
    setupFiles: ['./test/apply-migrations.ts'],
  },
});
