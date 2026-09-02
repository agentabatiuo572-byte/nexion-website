import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/* 控制台构建:base=/admin/(V1-dev 与站同域路径挂载,worker 伺服 dist/admin;
   Phase C 迁 admin 子域时只改 base 与部署面)。dev 时 /api 代理到 wrangler 8787。 */
export default defineConfig({
  plugins: [react()],
  base: '/admin/',
  server: {
    port: 5175,
    proxy: { '/api': 'http://127.0.0.1:8787' },
    fs: { allow: ['..'] }, // 禁用词单源在仓根 scripts/,dev 需放行上级读取
  },
  build: {
    // 构建到自有目录;站 dist 保持纯官网产物(站上三道运行时门按「dist=官网页」设计,
    // 门域分离铁则)。部署/本地起服前由 worker/assemble-admin.mjs 拷入 dist/admin。
    outDir: 'dist',
    emptyOutDir: true,
  },
});
