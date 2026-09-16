import { isLocale, type Locale } from '../../../schema/src/locales.ts';

/** Normalize validator paths and diff paths once, preserving their locale and stable item ID. */
export function parseFieldTarget(path: string) {
  let canonical = path.startsWith('/') ? path.slice(1).split('/').map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~')).join('.') : path;
  if (/^faq\.(?!items(?:\.|\[|$))/.test(canonical)) canonical = canonical.replace(/^faq\./, 'faq.items.');
  if (/^seo\.(?!pages(?:\.|$))/.test(canonical)) canonical = canonical.replace(/^seo\./, 'seo.pages.');
  const original = canonical.replace(/\[(\d+)\]/g, '.$1').split('.');
  let locale: Locale | undefined;
  const candidate = original[0] === 'copy' ? original[1] : original.at(-1);
  if (candidate && isLocale(candidate)) locale = candidate;
  if (original[0] === 'legal' && locale && original.length === 3) canonical = `legal.${original[1]}.md.${locale}`;
  const segments = canonical.replace(/\[(\d+)\]/g, '.$1').split('.');
  return { path, canonical, locale, area: segments[0], segments };
}

export function fieldEditorLink(path: string): string {
  const area = parseFieldTarget(path).area;
  const route = area === 'enabledLocales' ? '/content/languages'
    : area === 'copy' ? '/content'
    : area === 'footer' ? '/content/seo'
    : area === 'geo' ? '/geo'
    : ['downloads', 'stats', 'skus', 'faq', 'announcement', 'seo', 'legal'].includes(area ?? '') ? `/content/${area}` : '/content';
  return `${route}?focus=${encodeURIComponent(path)}`;
}
