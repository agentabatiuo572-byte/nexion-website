/* 文案 key 清单(CON04-③ 契约:key 树=代码所有,值=后台所有)。
   清单按【每语言】捕获叶子路径的**文件内顺序**——物化按原顺序回写,字节级等价的前提。
   集合背书命名空间(faq.qN·aN、devices.tagline.*)不入可编辑集,由集合模块物化回填。 */

import { LOCALES, type Locale } from './locales.js';

export type Nested = { [k: string]: string | Nested };

export function flatten(obj: Nested, prefix = ''): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.push([p, v]);
    else out.push(...flatten(v, p));
  }
  return out;
}

const FAQ_RUN = /^faq\.(q|a)\d+$/;
const TAGLINE_RUN = /^devices\.tagline\./;

export function isCollectionBacked(path: string): boolean {
  return FAQ_RUN.test(path) || TAGLINE_RUN.test(path);
}

export interface LocaleManifest {
  /** 全部叶子路径,保留文件内顺序(含集合背书位) */
  paths: string[];
}
export type CopyManifest = Record<Locale, LocaleManifest> & {
  /** 可编辑集 = en 叶子 − 集合背书位(全部语言共用 key 集,parity 门保证) */
  editable: string[];
}

export function buildManifest(dictionaries: Record<Locale, Nested>): CopyManifest;
/** Compatibility for callers holding the historical three-language source fixture. */
export function buildManifest(en: Nested, vi: Nested, zh: Nested): CopyManifest;
export function buildManifest(source: Nested | Record<Locale, Nested>, vi?: Nested, zh?: Nested): CopyManifest {
  const dictionaries = vi && zh
    ? Object.fromEntries(LOCALES.map((locale) => [locale, locale === 'vi' ? vi : locale === 'zh' ? zh : source])) as Record<Locale, Nested>
    : source as Record<Locale, Nested>;
  const paths = (o: Nested) => flatten(o).map(([p]) => p);
  const enPaths = paths(dictionaries.en);
  return {
    ...Object.fromEntries(LOCALES.map((locale) => [locale, { paths: paths(dictionaries[locale]) }])) as Record<Locale, LocaleManifest>,
    editable: enPaths.filter((p) => !isCollectionBacked(p)),
  };
}

/** 按原顺序回填嵌套结构;集合背书位由 resolver 供值(faq/sku 集合),其余取 copy 平铺表 */
export function unflatten(
  orderedPaths: string[],
  valueOf: (path: string) => string | undefined,
): Nested {
  const root: Nested = {};
  for (const p of orderedPaths) {
    const v = valueOf(p);
    if (v === undefined) continue; // 集合缩减时旧位跳过(如 FAQ 9→6)
    const segs = p.split('.');
    let cur = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i]!;
      if (typeof cur[s] !== 'object' || cur[s] === null) cur[s] = {};
      cur = cur[s] as Nested;
    }
    cur[segs.at(-1)!] = v;
  }
  return root;
}

/** 集合扩张支持:把 faq.q1..qN 的「连续段」按当前集合大小重生成路径序
    (N 变化时:以该语言原文件里首个 faq.q* 位置为锚,整段替换为 q1..aN 交错序——
    与现文件 q1..q9,a1..a9 的**实际排布**对齐由调用方传入的生成器决定) */
export function expandFaqPaths(paths: string[], faqCount: number): string[] {
  const firstIdx = paths.findIndex((p) => FAQ_RUN.test(p));
  if (firstIdx === -1) return paths;
  const rest = paths.filter((p) => !FAQ_RUN.test(p));
  // 现站排布:q1..qN 全在前、a1..aN 全在后?还是交错?—— 以原文件真实排布探测:
  const origFaq = paths.filter((p) => FAQ_RUN.test(p));
  const interleaved = origFaq[1]?.startsWith('faq.a'); // q1,a1,q2,a2… 形态
  const gen: string[] = [];
  if (interleaved) {
    for (let i = 1; i <= faqCount; i++) gen.push(`faq.q${i}`, `faq.a${i}`);
  } else {
    for (let i = 1; i <= faqCount; i++) gen.push(`faq.q${i}`);
    for (let i = 1; i <= faqCount; i++) gen.push(`faq.a${i}`);
  }
  const out = [...rest];
  out.splice(paths.slice(0, firstIdx).filter((p) => !FAQ_RUN.test(p)).length, 0, ...gen);
  return out;
}
