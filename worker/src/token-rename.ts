import { equalDraftValue } from '../../schema/src/draft-fields.js';

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Legacy names exist only at this boundary; stored historical versions stay immutable. */
export function renameTokenCopyKey(key: string): string {
  return key.replace(/^nex\./, 'uvt.').replace(/^nav\.nex$/, 'nav.uvt')
    .replace(/^learn\.topics\.nex$/, 'learn.topics.uvt')
    .replace(/(cmpType|cmpVol|cmpUse)Nex$/, '$1Uvt');
}

export function legacyTokenCopyKey(key: string): string {
  return key.replace(/^uvt\./, 'nex.').replace(/^nav\.uvt$/, 'nav.nex')
    .replace(/^learn\.topics\.uvt$/, 'learn.topics.nex')
    .replace(/(cmpType|cmpVol|cmpUse)Uvt$/, '$1Nex');
}

export function renameTokenFieldId(fieldId: string): string {
  if (fieldId.startsWith('/copy/')) return '/copy/' + renameTokenCopyKey(fieldId.slice('/copy/'.length));
  return fieldId.replace(/^\/seo\/pages\/nex\//, '/seo/pages/uvt/');
}

export const renameTokenText = (text: string): string => text.replace(/\bNEX\b/g, 'UVT')
  .replace(/\/nex(?=[/#?]|$)/g, '/uvt').replace(/\/staking-nex(?=[/#?]|$)/g, '/staking-uvt')
  .replace(/#nex(?=[-/?\s]|$)/g, '#uvt');

export interface TokenRenameConflict { path: string; reason: string }
export type TokenRenameResult = { ok: true; config: unknown } | { ok: false; conflicts: TokenRenameConflict[] };

/** Rename authored prose and its token page links; dedicated credentials, contacts, IDs and external destinations stay unchanged. */
export function renameLegacyTokenConfig(input: unknown): TokenRenameResult {
  const output = structuredClone(input), conflicts: TokenRenameConflict[] = [];
  if (!record(output)) return { ok: true, config: output };
  const prose = (value: unknown): unknown => {
    if (typeof value === 'string') return renameTokenText(value);
    if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, prose(child)]));
    return value;
  };
  const renameKey = (value: Record<string, unknown>, oldKey: string, nextKey: string, path: string) => {
    if (oldKey === nextKey || !Object.hasOwn(value, oldKey)) return;
    if (Object.hasOwn(value, nextKey) && !equalDraftValue(value[oldKey], value[nextKey])) {
      conflicts.push({ path: `${path}.${oldKey}`, reason: '旧代币字段与 UVT 字段同时存在且内容不同；原内容已保留，请先合并' });
      return;
    }
    value[nextKey] = value[oldKey];
    delete value[oldKey];
  };
  if (record(output.copy)) for (const [locale, raw] of Object.entries(output.copy)) {
    if (!record(raw)) continue;
    const copy = prose(raw) as Record<string, unknown>;
    for (const key of Object.keys(copy)) renameKey(copy, key, renameTokenCopyKey(key), `copy.${locale}`);
    output.copy[locale] = copy;
  }
  if (record(output.seo) && record(output.seo.pages)) {
    output.seo.pages = prose(output.seo.pages);
    renameKey(output.seo.pages as Record<string, unknown>, 'nex', 'uvt', 'seo.pages');
  }
  if (record(output.faq) && Array.isArray(output.faq.items)) for (const item of output.faq.items) {
    if (record(item)) { item.q = prose(item.q); item.a = prose(item.a); }
  }
  if (Array.isArray(output.skus)) for (const sku of output.skus) {
    if (record(sku)) { sku.name = prose(sku.name); sku.tagline = prose(sku.tagline); }
  }
  if (record(output.announcement)) {
    output.announcement.text = prose(output.announcement.text);
    if (typeof output.announcement.href === 'string' && output.announcement.href.startsWith('/')) {
      output.announcement.href = renameTokenText(output.announcement.href);
    }
  }
  if (record(output.legal)) for (const document of Object.values(output.legal)) {
    if (record(document)) document.md = prose(document.md);
  }
  return conflicts.length ? { ok: false, conflicts } : { ok: true, config: output };
}
