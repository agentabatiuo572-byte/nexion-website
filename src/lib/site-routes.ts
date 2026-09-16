import { activeLocales } from './locales';
import { localizedPath } from './locale-policy';
import { learnList } from './learn';
import type { Locale } from '../../schema/src/locales';

export const PAGE_PATHS = {
  home: '/', nex: '/nex/', learn: '/learn/',
  terms: '/legal/terms/', privacy: '/legal/privacy/', appPrivacy: '/legal/app-privacy/',
} as const;
export type PageKind = keyof typeof PAGE_PATHS | 'article';
export interface SitePageProps { locale: Locale; kind: PageKind; path: string; slug?: string }

export async function siteRoutes() {
  const articles = await learnList('en');
  return activeLocales.flatMap((locale) => {
    const pages: SitePageProps[] = Object.entries(PAGE_PATHS).map(([kind, path]) => ({ locale, kind: kind as keyof typeof PAGE_PATHS, path }));
    pages.push(...articles.map(({ slug }) => ({ locale, kind: 'article' as const, path: `/learn/${slug}/`, slug })));
    return pages.map((props) => ({ params: { path: localizedPath(locale, props.path).replace(/^\/|\/$/g, '') || undefined }, props }));
  });
}
