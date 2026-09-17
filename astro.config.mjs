// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync, renameSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveEnabledLocales } from './src/lib/locale-policy.ts';

// The behavior gate and normal build must read the same materialized selection.
const siteFile = process.env.NEXGRID_SITE_FIXTURE_DIR
  ? join(process.env.NEXGRID_SITE_FIXTURE_DIR, 'site.json')
  : new URL('./src/config/site.json', import.meta.url);
const activeLocales = resolveEnabledLocales(JSON.parse(readFileSync(siteFile, 'utf8')).enabledLocales);

// PRD §2.4 O1: 域名待主人确认,占位 nexgrid.ai;上线前(T13)核定
// 2026-08-20 axiom 重做:React 岛全部移除(cobe 地球 → vanilla 洛伦兹 canvas),站内零框架 JS
export default defineConfig({
  site: 'https://nexgrid.ai',
  output: 'static',
  integrations: [{
    name: 'localized-not-found',
    hooks: {
      'astro:build:done': ({ dir }) => {
        // Astro directory output uses /<locale>/404/index.html; the asset host needs /<locale>/404.html.
        for (const locale of activeLocales.filter((locale) => locale !== 'en')) {
          renameSync(new URL(`${locale}/404/index.html`, dir), new URL(`${locale}/404.html`, dir));
          rmdirSync(new URL(`${locale}/404/`, dir));
        }
      },
    },
  }, sitemap({
    i18n: { defaultLocale: 'en', locales: Object.fromEntries(activeLocales.map((locale) => [locale, locale])) },
    filter: (page) => !/\/404\/?$/.test(new URL(page).pathname),
  })],
  vite: { plugins: [tailwindcss()] },
  i18n: {
    defaultLocale: 'en',
    locales: activeLocales,
    routing: { prefixDefaultLocale: false },
  },
});
