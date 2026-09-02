/* 通用叶子级 diff(控制台徽标/发布 diff 摘要/高敏判定共用一个口径,禁各算各的)。 */

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export function flattenJson(v: Json, prefix = '', out: Map<string, string> = new Map()): Map<string, string> {
  if (v === null || typeof v !== 'object') {
    out.set(prefix, JSON.stringify(v));
  } else if (Array.isArray(v)) {
    out.set(`${prefix}.__len`, String(v.length));
    v.forEach((x, i) => flattenJson(x, `${prefix}[${i}]`, out));
  } else {
    for (const [k, x] of Object.entries(v)) flattenJson(x, prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

/** 返回 a→b 的变更叶子路径(含增删) */
export function diffPaths(a: Json, b: Json): string[] {
  const fa = flattenJson(a);
  const fb = flattenJson(b);
  const changed: string[] = [];
  for (const [k, v] of fb) if (fa.get(k) !== v) changed.push(k);
  for (const k of fa.keys()) if (!fb.has(k)) changed.push(k);
  return changed.filter((p) => !p.endsWith('.__len'));
}
