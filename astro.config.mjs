// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

// PRD §2.4 O1: 域名待主人确认,占位 nexgrid.ai;上线前(T13)核定
// 2026-08-20 axiom 重做:React 岛全部移除(cobe 地球 → vanilla 洛伦兹 canvas),站内零框架 JS
export default defineConfig({
  site: 'https://nexgrid.ai',
  output: 'static',
  integrations: [sitemap()],
  vite: { plugins: [tailwindcss()] },
  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'vi', 'zh'],
    routing: { prefixDefaultLocale: false },
  },
});
