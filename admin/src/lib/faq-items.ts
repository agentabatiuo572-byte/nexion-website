import type { Tri } from './use-draft';
import { emptyTranslation } from './locale-editor';

export interface FaqItemValue {
  id: string;
  q: Tri;
  a: Tri;
  sort: number;
  visible: boolean;
  deleted?: boolean;
}

/** mint-id 返回时必须基于“此刻”的工作副本追加，不能覆盖等待期间的编辑。 */
export function appendMintedFaqItem(
  current: FaqItemValue[] | null,
  fallback: FaqItemValue[],
  id: string,
): FaqItemValue[] {
  const latest = current ?? fallback;
  return [
    ...latest,
    { id, q: emptyTranslation(), a: emptyTranslation(), sort: latest.length + 1, visible: true },
  ];
}
