import { LOCALES, SOURCE_LOCALE, type Locale } from './locales.js';
import type { CopyManifest } from './manifest.js';
import type { SiteConfig } from './site-config.js';

/** JSON Pointer names, with collection IDs in place of unstable array offsets. */
export const pointer = (...parts: string[]) => '/' + parts.map((part) => part.replaceAll('~', '~0').replaceAll('/', '~1')).join('/');
export const equalDraftValue = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equalDraftValue(v, b[i]));
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) return false;
  const aa = a as Record<string, unknown>, bb = b as Record<string, unknown>;
  return Object.keys(aa).length === Object.keys(bb).length && Object.keys(aa).every((key) => Object.hasOwn(bb, key) && equalDraftValue(aa[key], bb[key]));
};
export interface DraftField { fieldId: string; value: unknown }
export const DRAFT_COLLECTIONS = ['/faq/items', '/skus', '/footer/social'] as const;
export type DraftCollection = typeof DRAFT_COLLECTIONS[number];
export type DraftOperation =
  | { op: 'set'; fieldId: string; before: unknown; after: unknown }
  | { op: 'add'; collection: DraftCollection; after: { id: string; [key: string]: unknown } }
  | { op: 'remove'; collection: DraftCollection; before: { id: string; [key: string]: unknown } }
  | { op: 'reorder'; collection: DraftCollection; before: string[]; after: string[] };

function collection(config: SiteConfig, name: DraftCollection): Array<{ id: string }> {
  if (name === '/faq/items') return config.faq.items;
  if (name === '/skus') return config.skus;
  return config.footer.social;
}

/** Only known, editable config fields are exposed. Optional values use null for absence. */
export function enumerateDraftFields(config: SiteConfig, manifest: Pick<CopyManifest, 'editable'>): DraftField[] {
  const fields: DraftField[] = [];
  const add = (parts: string[], value: unknown) => fields.push({ fieldId: pointer(...parts), value: value ?? null });
  const walk = (value: unknown, parts: string[]) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value)) walk(child, [...parts, key]);
    } else add(parts, value);
  };
  add(['enabledLocales'], config.enabledLocales);
  for (const locale of LOCALES) for (const key of manifest.editable) add(['copy', locale, key], config.copy[locale][key]);
  walk(config.downloads, ['downloads']);
  for (const [key, value] of Object.entries(config.stats)) if (key !== 'growth') add(['stats', key], value);
  // Growth is one optional configuration object; it contains no asynchronously translated fields.
  add(['stats', 'growth'], config.stats.growth);
  for (const name of DRAFT_COLLECTIONS) for (const item of collection(config, name)) {
    const parts = name.slice(1).split('/');
    for (const [key, value] of Object.entries(item)) if (key !== 'id') walk(value, [...parts, item.id, key]);
    if (name === '/faq/items' && !Object.hasOwn(item, 'deleted')) add([...parts, item.id, 'deleted'], null);
    if (name === '/skus' && !Object.hasOwn(item, 'free')) add([...parts, item.id, 'free'], null);
  }
  for (const key of ['enabled', 'text', 'href', 'startsAt', 'endsAt'] as const) walk(config.announcement[key] ?? null, ['announcement', key]);
  walk(config.seo, ['seo']);
  add(['footer', 'contactEmail'], config.footer.contactEmail);
  walk(config.legal, ['legal']);
  return fields;
}

/** Called only after membership in enumerateDraftFields has been checked. */
export function setDraftField(config: SiteConfig, fieldId: string, value: unknown, manifest: Pick<CopyManifest, 'editable'>): void {
  if (!enumerateDraftFields(config, manifest).some((field) => field.fieldId === fieldId)) throw new Error('unknown-field');
  const parts = fieldId.slice(1).split('/').map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  let current: unknown = config;
  for (const part of parts.slice(0, -1)) {
    current = Array.isArray(current) ? current.find((item) => item.id === part) : (current as Record<string, unknown>)[part];
  }
  const owner = current as Record<string, unknown>;
  const key = parts.at(-1)!;
  if (value === null) delete owner[key];
  else Object.defineProperty(owner, key, { value: structuredClone(value), enumerable: true, writable: true, configurable: true });
}

/** Build intent from the editor's frozen baseline, never from a newly polled overview. */
export function createDraftPatch(before: SiteConfig, after: SiteConfig, manifest: Pick<CopyManifest, 'editable'>): DraftOperation[] {
  const result: DraftOperation[] = [];
  const added = new Set<string>(), removed = new Set<string>();
  for (const name of DRAFT_COLLECTIONS) {
    const oldItems = collection(before, name), newItems = collection(after, name);
    for (const item of oldItems) if (!newItems.some((next) => next.id === item.id)) {
      result.push({ op: 'remove', collection: name, before: structuredClone(item) });
      removed.add(name + '/' + pointer(item.id).slice(1) + '/');
    }
    for (const item of newItems) if (!oldItems.some((prev) => prev.id === item.id)) {
      result.push({ op: 'add', collection: name, after: structuredClone(item) });
      added.add(name + '/' + pointer(item.id).slice(1) + '/');
    }
    // Applying removes preserves survivor order; adds append. Compare that intermediate
    // order with the full requested order, including new items inserted before survivors.
    const oldOrder = [...oldItems.filter((item) => newItems.some((next) => next.id === item.id)),
      ...newItems.filter((item) => !oldItems.some((prev) => prev.id === item.id))].map((item) => item.id);
    const newOrder = newItems.map((item) => item.id);
    if (!equalDraftValue(oldOrder, newOrder)) result.push({ op: 'reorder', collection: name,
      before: oldOrder, after: newOrder });
  }
  const oldFields = new Map(enumerateDraftFields(before, manifest).map((field) => [field.fieldId, field.value]));
  for (const field of enumerateDraftFields(after, manifest)) {
    if ([...added, ...removed].some((prefix) => field.fieldId.startsWith(prefix))) continue;
    if (!oldFields.has(field.fieldId) || equalDraftValue(oldFields.get(field.fieldId), field.value)) continue;
    result.push({ op: 'set', fieldId: field.fieldId, before: oldFields.get(field.fieldId), after: field.value });
  }
  return result;
}

export interface DraftConflict { fieldId: string; current: unknown }
export function applyDraftPatch(config: SiteConfig, operations: DraftOperation[], manifest: Pick<CopyManifest, 'editable'>):
  { ok: true; config: SiteConfig; touched: string[] } | { ok: false; conflicts: DraftConflict[]; invalid?: boolean } {
  const output = structuredClone(config), conflicts: DraftConflict[] = [], seen = new Set<string>(), touched: string[] = [];
  for (const operation of operations) {
    if (operation.op === 'set') {
      if (seen.has(operation.fieldId)) return { ok: false, conflicts: [], invalid: true };
      seen.add(operation.fieldId);
      const field = enumerateDraftFields(output, manifest).find((entry) => entry.fieldId === operation.fieldId);
      if (!field) return { ok: false, conflicts: [{ fieldId: operation.fieldId, current: null }], invalid: true };
      if (!equalDraftValue(field.value, operation.before) && !equalDraftValue(field.value, operation.after)) conflicts.push({ fieldId: operation.fieldId, current: field.value });
      else { setDraftField(output, operation.fieldId, operation.after, manifest); touched.push(operation.fieldId); }
      continue;
    }
    const items = collection(output, operation.collection);
    if (operation.op === 'reorder') {
      const current = items.map((item) => item.id);
      if (seen.has(operation.collection + ':order') || new Set(operation.after).size !== operation.after.length || operation.after.length !== current.length || operation.after.some((id) => !current.includes(id))) return { ok: false, conflicts: [], invalid: true };
      seen.add(operation.collection + ':order');
      if (!equalDraftValue(current, operation.before) && !equalDraftValue(current, operation.after)) conflicts.push({ fieldId: operation.collection, current });
      else items.splice(0, items.length, ...operation.after.map((id) => items.find((item) => item.id === id)!));
      continue;
    }
    const item = operation.op === 'add' ? operation.after : operation.before;
    const itemId = operation.collection + '/' + pointer(item.id).slice(1);
    if (seen.has(itemId)) return { ok: false, conflicts: [], invalid: true };
    seen.add(itemId);
    const existing = items.find((entry) => entry.id === item.id);
    if (operation.op === 'add') {
      if (existing && !equalDraftValue(existing, item)) conflicts.push({ fieldId: itemId, current: existing });
      else if (!existing) items.push(structuredClone(item));
    } else if (existing) {
      if (!equalDraftValue(existing, item)) conflicts.push({ fieldId: itemId, current: existing });
      else items.splice(items.indexOf(existing), 1);
    }
  }
  return conflicts.length ? { ok: false, conflicts } : { ok: true, config: output, touched };
}

export interface TranslationField {
  fieldId: string;
  targetLocale: Locale;
  draftFieldId: string;
  source: string;
  target: string;
  context: string;
  format: 'text';
  required: boolean;
  maxLength: number;
}

export function enumerateTranslationFields(config: SiteConfig, manifest: Pick<CopyManifest, 'editable'>): TranslationField[] {
  const out: TranslationField[] = [];
  const add = (id: string[], values: Record<Locale, string>, context: string, maxLength: number, required: boolean, copy = false) => {
    for (const targetLocale of LOCALES) if (targetLocale !== SOURCE_LOCALE) out.push({ fieldId: pointer(...id), targetLocale,
      draftFieldId: copy ? pointer('copy', targetLocale, id[1]!) : pointer(...id, targetLocale),
      source: values[SOURCE_LOCALE], target: values[targetLocale], context, format: 'text', required, maxLength });
  };
  for (const key of manifest.editable) add(['copy', key], Object.fromEntries(LOCALES.map((locale) => [locale, config.copy[locale][key] ?? ''])) as Record<Locale, string>, key, 10_000, true, true);
  for (const item of config.faq.items) if (!item.deleted) {
    const context = JSON.stringify({ id: item.id, question: item.q[SOURCE_LOCALE], answer: item.a[SOURCE_LOCALE] });
    add(['faq', 'items', item.id, 'q'], item.q, context, 300, true);
    add(['faq', 'items', item.id, 'a'], item.a, context, 2000, true);
  }
  for (const item of config.skus) add(['skus', item.id, 'tagline'], item.tagline, JSON.stringify({ id: item.id, name: item.name }), 200, true);
  add(['announcement', 'text'], config.announcement.text, 'announcement', 120, config.announcement.enabled);
  for (const [id, page] of Object.entries(config.seo.pages)) {
    add(['seo', 'pages', id, 'title'], page.title, `seo:${id}:title`, 120, false);
    add(['seo', 'pages', id, 'description'], page.description, `seo:${id}:description`, 300, false);
  }
  return out;
}

/** A deterministic, shared floor for both seed and model results. */
export function validateTranslationValue(field: Pick<TranslationField, 'source' | 'maxLength'>, value: string): string | null {
  if (!value.trim()) return 'empty';
  if (value.length > field.maxLength) return 'too-long';
  if (/^\s*(?:```|\{\s*["“«]?translations["”»]?\s*:)/iu.test(value)) return 'translation-envelope';
  if (/\bUvel\b/u.test(field.source) && !/\bNexGrid\b/u.test(field.source) && /\bNexGrid\b/u.test(value)) return 'stale-brand';
  const matches = (text: string, pattern: RegExp) => JSON.stringify((text.match(pattern) ?? []).sort());
  if (matches(field.source, /\{[a-zA-Z][a-zA-Z0-9_]*\}/g) !== matches(value, /\{[a-zA-Z][a-zA-Z0-9_]*\}/g)) return 'placeholder';
  if (matches(field.source, /https?:\/\/[^\s)<>]+/g) !== matches(value, /https?:\/\/[^\s)<>]+/g)) return 'link';
  // Match WhySection's complete marker grammar; inner text and order may be translated.
  const markup = (text: string) => {
    const tokens: string[] = [];
    const plain = text.replace(/\[\[(.+?)\]\]|__(.+?)__|\^(\d+)\^/g, (_all, data: string | undefined, emphasis: string | undefined, reference: string | undefined) => {
      tokens.push(data !== undefined ? 'data' : emphasis !== undefined ? 'emphasis' : `reference:^${reference}^`);
      return '';
    });
    // Broken/new marker delimiters must not disappear behind the valid-marker comparison.
    tokens.push(...(plain.match(/\[\[|\]\]|__|\^/g) ?? []).map(token => 'broken:' + token));
    return JSON.stringify(tokens.sort());
  };
  if (markup(field.source) !== markup(value)) return 'markup';
  if (value.includes('\uFFFD')) return 'encoding-damage';
  return null;
}
