/* 发布增量分级:纯文案改动跳过源码静态门,未知路径一律按全量跑(fail-closed)。
   分级只决定「源码静态门跳过」,内容门/构建/版面检查/上线核验永远跑 ——
   文案变长会撑破版面(i18n-parity/render-fit 管),源码门才与配置正文无关。 */

export type PublishChangeTier = 'content-only' | 'config-shape';

/** diff 路径形状见 schema/src/diff.ts(对象点号、数组方括号)。 */
const CONTENT_ONLY_PATTERNS = [
  /^copy\./,
  /^faq\.items/,
  /^skus\[\d+\]\.tagline\./,
  /^announcement\.text\./,
  /^seo\.pages\./,
  /^legal\.(terms|privacy|appPrivacy)\.(md|updatedAt)/,
  /^footer\./,
];

export function classifyChangedPaths(changedPaths: readonly string[]): PublishChangeTier {
  if (changedPaths.length === 0) return 'config-shape';
  const allContent = changedPaths.every((p) => CONTENT_ONLY_PATTERNS.some((re) => re.test(p)));
  return allContent ? 'content-only' : 'config-shape';
}
