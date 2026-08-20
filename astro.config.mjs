// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

// PRD §2.4 O1: 域名待主人确认,占位 nexgrid.ai;上线前(T13)核定
export default defineConfig({
  site: 'https://nexgrid.ai',
  output: 'static',
  integrations: [react(), sitemap()],
  vite: { plugins: [tailwindcss()] },
  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'vi', 'zh'],
    routing: { prefixDefaultLocale: false },
  },
});
