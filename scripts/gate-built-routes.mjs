import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Coverage comes from generated documents, never from a second list of locale names.
export function classifyBuiltPage(route, html) {
  const root = html.replace(/<!--[\s\S]*?-->/g, '').match(/<html\b[^>]*>/i)?.[0];
  const locale = root?.match(/\slang\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i)?.slice(1).find(Boolean)?.toLowerCase();
  if (!locale || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/i.test(locale)) throw new Error(`Missing/invalid document locale: ${route}`);
  return { route, locale, home: /\sdata-home(?=\s|=|\/?>)/i.test(root) };
}

export function readBuiltPages(dist) {
  const pages = [];
  const walk = (dir, route = '/') => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, `${route}${entry.name}/`);
      else if (entry.name === 'index.html') pages.push(classifyBuiltPage(route, readFileSync(path, 'utf8')));
    }
  };
  walk(dist);
  if (!pages.length) throw new Error('No built routes to check');
  return pages.sort((a, b) => a.route.localeCompare(b.route, 'en'));
}

export function homeRoutes(pages) {
  if (!pages.length) throw new Error('No built routes to check');
  const routes = [];
  for (const locale of new Set(pages.map((page) => page.locale))) {
    const homes = pages.filter((page) => page.locale === locale && page.home);
    if (homes.length !== 1) throw new Error(`Expected one generated home for ${locale}, found ${homes.length}`);
    routes.push(homes[0].route);
  }
  return routes.sort();
}

/* 增量裁剪:只实测内容变化的路由。--routes 值为逗号分隔的路由(如 /,/zh/learn/)。
   调用方传产物枚举出的全量,再取交集 —— 过滤从不断言覆盖面,枚举仍是构造性的。
   返回 { pages, scoped, total }:scoped 为真且 pages 为空 = 无变化路由,调用方须如实报跳过、不许冒充全量通过。 */
export function parseRoutesArg(argv) {
  const i = argv.indexOf('--routes');
  if (i < 0 || i + 1 >= argv.length) return null;
  const list = argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean)
    .map((s) => (s.startsWith('/') ? s : `/${s}`))
    .map((s) => (s.endsWith('/') ? s : `${s}/`));
  return [...new Set(list)];
}

export function scopeRoutes(pages, only) {
  if (!only) return { pages, scoped: false, total: pages.length };
  const set = new Set(only);
  const routeOf = (p) => (typeof p === 'string' ? p : p.route);
  return { pages: pages.filter((p) => set.has(routeOf(p))), scoped: true, total: pages.length };
}

export function seamRoutes(pages) {
  const routes = homeRoutes(pages);
  for (const locale of new Set(pages.map((page) => page.locale))) {
    const inner = pages.find((page) => page.locale === locale && !page.home);
    if (!inner) throw new Error(`No generated inner-page baseline for ${locale}`);
    routes.push(inner.route);
  }
  return routes.sort();
}
