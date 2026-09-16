import { z } from 'zod';
import { LOCALES, SiteConfigSchema, addLegacyLocaleFields, diffPaths, validateConfig, type CopyManifest, type SiteConfig } from '../../schema/src/index.js';
import { DRAFT_COLLECTIONS, applyDraftPatch, enumerateTranslationFields, equalDraftValue, setDraftField, validateTranslationValue, type DraftOperation } from '../../schema/src/draft-fields.js';
import seedJson from '../seed/site-config.seed.json';
import manifestJson from '../seed/copy-manifest.json';
import { deriveTranslationChanges, loadTranslationState, prepareTranslationChanges, translationStateKey, type TranslationChanges } from './translation-state';

export const DRAFT_MANIFEST = manifestJson as unknown as CopyManifest;
const SEED = SiteConfigSchema.parse(addLegacyLocaleFields(seedJson, DRAFT_MANIFEST.editable));
export interface DraftSnapshot { payload: string; draft_rev: number; updated_at: number }
export class DraftWriteError extends Error {
  constructor(public status: 400 | 409, public body: Record<string, unknown>) { super(String(body.error)); }
}
export async function readDraftSnapshot(db: D1Database): Promise<DraftSnapshot> {
  const row = await db.prepare('SELECT payload,draft_rev,updated_at FROM config_draft WHERE id=1').first<DraftSnapshot>();
  if (!row) throw new DraftWriteError(409, { error: 'draft-uninitialized' });
  return row;
}

/** Shared for PUT, PATCH, seed backfill, AI application and explicit legacy resolution. */
export async function normalizeDraftPayload(db: D1Database, snapshot: DraftSnapshot, input: unknown): Promise<{ config: SiteConfig; sanitized: number; changed: string[] }> {
  const parsed = SiteConfigSchema.safeParse(input);
  if (!parsed.success) throw new DraftWriteError(400, { error: 'bad-structure', issues: parsed.error.issues.slice(0, 10) });
  const errors = validateConfig(parsed.data, DRAFT_MANIFEST).errors.filter((issue) => ['placeholder', 'unknown-key', 'missing-key', 'dup-id'].includes(issue.rule));
  if (errors.length) throw new DraftWriteError(400, { error: errors[0]!.rule, issues: errors.slice(0, 10) });
  for (const items of [parsed.data.skus, parsed.data.footer.social]) {
    if (new Set(items.map((item) => item.id)).size !== items.length) throw new DraftWriteError(400, { error: 'dup-id' });
  }
  let previous: unknown;
  try { previous = JSON.parse(snapshot.payload); } catch { previous = snapshot.payload; }
  const previousConfig = SiteConfigSchema.safeParse(previous);
  const pa = previousConfig.success ? previousConfig.data.announcement : null;
  const live = await db.prepare("SELECT payload FROM config_versions WHERE status='live' ORDER BY id DESC LIMIT 1").first<{ payload: string }>();
  const la = live ? (addLegacyLocaleFields(JSON.parse(live.payload), DRAFT_MANIFEST.editable) as SiteConfig).announcement : null;
  const a = parsed.data.announcement;
  const same = (other: SiteConfig['announcement']) => LOCALES.every((locale) => a.text[locale] === other.text[locale]) && a.href === other.href;
  if (la && same(la)) a.id = la.id;
  else if (!pa || !same(pa)) a.id = `ann-${crypto.randomUUID().slice(0, 8)}`;
  let sanitized = 0;
  for (const doc of ['terms', 'privacy', 'appPrivacy'] as const) for (const locale of LOCALES) {
    const before = parsed.data.legal[doc].md[locale];
    const after = before.replace(/<script[\s\S]*?<\/script\s*>/gi, '')
      .replace(/<iframe[\s\S]*?(?:<\/iframe\s*>|\/>)/gi, '')
      .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    if (before !== after) { parsed.data.legal[doc].md[locale] = after; sanitized++; }
  }
  return { config: parsed.data, sanitized, changed: diffPaths(previous as Parameters<typeof diffPaths>[0], parsed.data) };
}

export interface DraftWriteOptions {
  snapshot: DraftSnapshot;
  payload: SiteConfig;
  touched?: string[];
  actor?: string;
  reason?: string;
  /** Internal-only, fixed SQL supplied by the translation executor, never by an API body. Use anonymous ? bindings. */
  guard?: { sql: string; bindings: unknown[] };
  /** Executor-supplied state changes replace automatic intent derivation. */
  translation?: TranslationChanges;
  /** Explicit default fill uses all missing fields; ordinary writes scan source changes/new items/language changes. */
  defaults?: 'all' | 'changed' | 'none';
}
export interface DraftWriteResult { ok: true; draftRev: number; changedFromPrev: number; sanitized: number; applied: number; skipped: number; queued: number; payload: SiteConfig }

export async function commitDraftWrite(db: D1Database, options: DraftWriteOptions): Promise<DraftWriteResult> {
  const { snapshot } = options;
  const previous = SiteConfigSchema.parse(JSON.parse(snapshot.payload));
  const normalized = await normalizeDraftPayload(db, snapshot, options.payload);
  const existing = await loadTranslationState(db);
  const seeded = new Set<string>();
  let applied = 0, skipped = 0;
  if (!options.translation && options.defaults !== 'none') {
    const seedFields = new Map(enumerateTranslationFields(SEED, DRAFT_MANIFEST).map((field) => [translationStateKey(field.fieldId, field.targetLocale), field]));
    const before = new Map(enumerateTranslationFields(previous, DRAFT_MANIFEST).map((field) => [translationStateKey(field.fieldId, field.targetLocale), field]));
    const languageChanged = !equalDraftValue(previous.enabledLocales, normalized.config.enabledLocales);
    for (const field of enumerateTranslationFields(normalized.config, DRAFT_MANIFEST)) {
      const key = translationStateKey(field.fieldId, field.targetLocale), state = existing.get(key), prev = before.get(key), seed = seedFields.get(key);
      const explicitTarget = options.touched?.includes(field.draftFieldId) || Boolean(prev && prev.target !== field.target);
      const scan = options.defaults === 'all' || languageChanged || !prev || field.source !== prev.source || field.context !== prev.context;
      if (!scan || field.target.trim()) continue;
      if (explicitTarget || state?.origin === 'manual' || !field.source.trim() || !seed || seed.source !== field.source || seed.context !== field.context || validateTranslationValue(field, seed.target)) { skipped++; continue; }
      setDraftField(normalized.config, field.draftFieldId, seed.target, DRAFT_MANIFEST);
      seeded.add(key); applied++;
    }
  }
  const changes = options.translation ?? await deriveTranslationChanges(previous, normalized.config, DRAFT_MANIFEST, existing, new Set(options.touched), seeded);
  const changed = diffPaths(previous, normalized.config);
  const nextRev = snapshot.draft_rev + 1, nonce = crypto.randomUUID(), now = Date.now();
  if (!changed.length && !changes.states.length && !changes.jobs.length && !changes.completeJobs?.length && !changes.cancelJobs?.length) {
    const current = await readDraftSnapshot(db);
    if (current.draft_rev !== snapshot.draft_rev || current.payload !== snapshot.payload) throw new DraftWriteError(409, { error: 'conflict', draftRev: current.draft_rev });
    return { ok: true, draftRev: snapshot.draft_rev, changedFromPrev: 0, sanitized: normalized.sanitized, applied, skipped, queued: 0, payload: normalized.config };
  }
  // Snapshot bytes add protection for old maintenance writers which may not yet know write_nonce.
  const update = db.prepare(`UPDATE config_draft SET payload=?,updated_at=?,draft_rev=draft_rev+1,write_nonce=?
    WHERE id=1 AND draft_rev=? AND payload=?${options.guard ? ` AND (${options.guard.sql})` : ''}`)
    .bind(JSON.stringify(normalized.config), now, nonce, snapshot.draft_rev, snapshot.payload, ...(options.guard?.bindings ?? []));
  const statements = [update, ...prepareTranslationChanges(db, changes, nonce, nextRev),
    db.prepare(`INSERT INTO audit (ts,actor,action,target,before_summary,after_summary,reason)
      SELECT ?1,?2,'config.save','draft',?3,?4,?5
      WHERE EXISTS (SELECT 1 FROM config_draft WHERE id=1 AND write_nonce=?6 AND draft_rev=?7)`)
      .bind(now, options.actor ?? 'admin', `r${snapshot.draft_rev}`,
        `${changed.length} 处改动:${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ' …' : ''}; 来源 ${changes.states.length}; 待办 ${changes.jobs.length}`,
        options.reason ?? null, nonce, nextRev)];
  const result = await db.batch(statements);
  if ((result[0]!.meta.changes ?? 0) !== 1) throw new DraftWriteError(409, { error: 'conflict', draftRev: (await readDraftSnapshot(db)).draft_rev });
  return { ok: true, draftRev: nextRev, changedFromPrev: changed.length, sanitized: normalized.sanitized, applied, skipped, queued: changes.jobs.length, payload: normalized.config };
}

const itemSchema = z.object({ id: z.string().min(1) }).passthrough();
const operationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set'), fieldId: z.string().min(1).max(400), before: z.unknown(), after: z.unknown() }).strict(),
  z.object({ op: z.literal('add'), collection: z.enum(DRAFT_COLLECTIONS), after: itemSchema }).strict(),
  z.object({ op: z.literal('remove'), collection: z.enum(DRAFT_COLLECTIONS), before: itemSchema }).strict(),
  z.object({ op: z.literal('reorder'), collection: z.enum(DRAFT_COLLECTIONS), before: z.array(z.string()), after: z.array(z.string()) }).strict(),
]);
export const DraftPatchSchema = z.object({ baseRevision: z.number().int().positive(), operations: z.array(operationSchema).max(5000) }).strict();

export async function saveDraftPatch(db: D1Database, body: unknown): Promise<DraftWriteResult> {
  const parsed = DraftPatchSchema.safeParse(body);
  if (!parsed.success || parsed.data.operations.some((op) => op.op === 'set' && (!Object.hasOwn(op, 'before') || !Object.hasOwn(op, 'after')))) throw new DraftWriteError(400, { error: 'bad-request' });
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshot = await readDraftSnapshot(db);
    if (parsed.data.baseRevision > snapshot.draft_rev) throw new DraftWriteError(409, { error: 'conflict', draftRev: snapshot.draft_rev });
    const result = applyDraftPatch(SiteConfigSchema.parse(JSON.parse(snapshot.payload)), parsed.data.operations as DraftOperation[], DRAFT_MANIFEST);
    if (!result.ok) throw new DraftWriteError(result.invalid ? 400 : 409, { error: result.invalid ? 'invalid-patch' : 'field-conflict', conflicts: result.conflicts, draftRev: snapshot.draft_rev });
    try { return await commitDraftWrite(db, { snapshot, payload: result.config, touched: result.touched, defaults: 'changed' }); }
    catch (error) { if (!(error instanceof DraftWriteError) || error.status !== 409 || attempt === 2) throw error; }
  }
  throw new DraftWriteError(409, { error: 'conflict' });
}
export async function saveDraftPut(db: D1Database, body: { payload?: unknown; baseRevision?: number }): Promise<DraftWriteResult> {
  if (!Number.isInteger(body.baseRevision) || body.baseRevision! < 1) throw new DraftWriteError(400, { error: 'bad-request' });
  const snapshot = await readDraftSnapshot(db);
  if (snapshot.draft_rev !== body.baseRevision) throw new DraftWriteError(409, { error: 'conflict', draftRev: snapshot.draft_rev });
  const parsed = SiteConfigSchema.safeParse(body.payload);
  if (!parsed.success) throw new DraftWriteError(400, { error: 'bad-structure', issues: parsed.error.issues.slice(0, 10) });
  return commitDraftWrite(db, { snapshot, payload: parsed.data, defaults: 'changed' });
}
export async function fillDraftDefaults(db: D1Database): Promise<DraftWriteResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshot = await readDraftSnapshot(db);
    try { return await commitDraftWrite(db, { snapshot, payload: SiteConfigSchema.parse(JSON.parse(snapshot.payload)), defaults: 'all', reason: 'translation.defaults' }); }
    catch (error) { if (!(error instanceof DraftWriteError) || error.status !== 409 || attempt === 2) throw error; }
  }
  throw new DraftWriteError(409, { error: 'conflict' });
}
