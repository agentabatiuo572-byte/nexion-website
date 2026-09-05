/* 异步提交期间允许继续编辑时，只清掉“本次已经提交”的那部分。
   后来输入的值与提交快照不同，必须继续留在本页工作副本里。 */

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => sameValue(value, b[index]));
  }
  if (isPlainRecord(a) && isPlainRecord(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return aKeys.length === bKeys.length && aKeys.every((key) => key in b && sameValue(a[key], b[key]));
  }
  return false;
}

const REMOVED = Symbol('submitted-value-removed');

function subtractSubmitted(current: unknown, submitted: unknown): unknown | typeof REMOVED {
  if (sameValue(current, submitted)) return REMOVED;
  if (!isPlainRecord(current) || !isPlainRecord(submitted)) return current;

  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(current)) {
    if (!(key in submitted)) {
      next[key] = value;
      continue;
    }
    const kept = subtractSubmitted(value, submitted[key]);
    if (kept !== REMOVED) next[key] = kept;
  }
  return Object.keys(next).length ? next : REMOVED;
}

/**
 * React functional setter 用的三方归并：
 * - current === submitted：本次提交后没人再改，回到 empty；
 * - 以空对象表示 patch 的状态：逐字段移除已提交值，只保留提交后的新输入；
 * - 数组/null 等整份工作副本：只要提交后变了，就完整保留最新副本。
 */
export function retainPostSubmit<T>(current: T, submitted: T, empty: T): T {
  if (sameValue(current, submitted)) return empty;
  if (isPlainRecord(current) && isPlainRecord(submitted) && isPlainRecord(empty) && Object.keys(empty).length === 0) {
    const kept = subtractSubmitted(current, submitted);
    return (kept === REMOVED ? empty : kept) as T;
  }
  return current;
}

export const submissionSnapshot = <T>(value: T): T => structuredClone(value);
