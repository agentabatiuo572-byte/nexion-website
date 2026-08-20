/* [FEAT-WEB11] Learn 取数 — 列表/单篇;缺译回退 en 并标记(WEB01 异常2 的机制实现)。 */
import { getCollection, type CollectionEntry } from 'astro:content';
import type { Locale } from '../i18n';

export type LearnEntry = CollectionEntry<'learn'>;

function localeOf(e: LearnEntry): string {
  return e.id.split('/')[0];
}
export function slugOf(e: LearnEntry): string {
  return e.id.split('/').slice(1).join('/');
}

/** 该语言的文章列表:en 全集为骨架,存在本语版则用之,否则回退 en 条目(带 fallback 标记) */
export async function learnList(locale: Locale): Promise<{ entry: LearnEntry; slug: string; fallback: boolean }[]> {
  const all = await getCollection('learn');
  const en = all.filter((e) => localeOf(e) === 'en').sort((a, b) => a.data.order - b.data.order);
  const own = new Map(all.filter((e) => localeOf(e) === locale).map((e) => [slugOf(e), e]));
  return en.map((e) => {
    const slug = slugOf(e);
    const local = locale === 'en' ? e : own.get(slug);
    return { entry: local ?? e, slug, fallback: locale !== 'en' && !local };
  });
}

export async function learnOne(locale: Locale, slug: string): Promise<{ entry: LearnEntry; fallback: boolean } | null> {
  const list = await learnList(locale);
  const hit = list.find((x) => x.slug === slug);
  return hit ? { entry: hit.entry, fallback: hit.fallback } : null;
}
