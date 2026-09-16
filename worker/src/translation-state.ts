import { enumerateTranslationFields, type TranslationField } from '../../schema/src/draft-fields.js';
import type { CopyManifest, Finding, SiteConfig } from '../../schema/src/index.js';

export interface TranslationStateRow {
  field_id: string; target_locale: string; origin: 'seed' | 'ai' | 'manual';
  source_hash: string; observed_source_hash: string; applied_value_hash: string;
  generation: number; deleted: number; updated_at: number;
}
export interface TranslationJobRow {
  id: string; field_id: string; target_locale: string; generation: number; intent: 'auto' | 'manual';
  source_text: string; context: string; source_hash: string; target_value: string;
  credential_rev: number | null; execution_rev: number | null; model: string | null; rules_version: string;
  status: 'pending' | 'running' | 'succeeded' | 'obsolete' | 'cancelled' | 'failed';
  lease_token: string | null; lease_until: number | null; attempts: number; next_attempt_at: number;
  result: string | null; error_code: string | null; usage: string | null; created_at: number; updated_at: number;
}
export interface TranslationChanges {
  states: TranslationStateRow[];
  jobs: TranslationJobRow[];
  completeJobs?: Array<{ id: string; leaseToken: string }>;
  cancelJobs?: Array<{ id: string; generation: number }>;
}
export const translationStateKey = (fieldId: string, locale: string) => JSON.stringify([fieldId, locale]);
export async function hashTranslationText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
export const translationSourceHash = (field: TranslationField) => hashTranslationText(JSON.stringify([field.fieldId, field.source, field.context]));
export async function loadTranslationState(db: D1Database): Promise<Map<string, TranslationStateRow>> {
  const rows = await db.prepare('SELECT * FROM translation_state').all<TranslationStateRow>();
  return new Map(rows.results.map((row) => [translationStateKey(row.field_id, row.target_locale), row]));
}
export function createTranslationJob(field: TranslationField, generation: number, sourceHash: string, intent: 'auto' | 'manual' = 'auto'): TranslationJobRow {
  const now = Date.now();
  return { id: crypto.randomUUID(), field_id: field.fieldId, target_locale: field.targetLocale, generation, intent,
    source_text: field.source, context: field.context, source_hash: sourceHash, target_value: field.target,
    credential_rev: null, execution_rev: null, model: null, rules_version: '1', status: 'pending',
    lease_token: null, lease_until: null, attempts: 0, next_attempt_at: 0, result: null, error_code: null,
    usage: null, created_at: now, updated_at: now };
}

/** Observe source changes without relabelling the source of an already applied translation. */
export async function deriveTranslationChanges(
  previous: SiteConfig, next: SiteConfig, manifest: CopyManifest, existing: Map<string, TranslationStateRow>,
  touched: ReadonlySet<string> = new Set(), seeded: ReadonlySet<string> = new Set(),
): Promise<TranslationChanges> {
  const before = new Map(enumerateTranslationFields(previous, manifest).map((field) => [translationStateKey(field.fieldId, field.targetLocale), field]));
  const fields = enumerateTranslationFields(next, manifest), present = new Set<string>();
  const changes: TranslationChanges = { states: [], jobs: [] }, now = Date.now();
  const hashes = new Map<string, Promise<string>>();
  const hash = (text: string) => { if (!hashes.has(text)) hashes.set(text, hashTranslationText(text)); return hashes.get(text)!; };
  const sourceHash = (field: TranslationField) => hash(JSON.stringify([field.fieldId, field.source, field.context]));
  for (const field of fields) {
    const key = translationStateKey(field.fieldId, field.targetLocale); present.add(key);
    const prev = before.get(key), state = existing.get(key);
    const sourceChanged = !prev || prev.source !== field.source || prev.context !== field.context || Boolean(state?.deleted);
    const manuallyTouched = touched.has(field.draftFieldId) || Boolean(prev && prev.target !== field.target && !seeded.has(key));
    if (!sourceChanged && !manuallyTouched && !seeded.has(key)) continue;
    const [currentHash, valueHash] = await Promise.all([sourceHash(field), hash(field.target)]);
    let row: TranslationStateRow;
    if (seeded.has(key) || manuallyTouched) {
      const origin = seeded.has(key) ? 'seed' : 'manual';
      if (state && !state.deleted && state.origin === origin && state.source_hash === currentHash && state.applied_value_hash === valueHash && state.observed_source_hash === currentHash) continue;
      row = { field_id: field.fieldId, target_locale: field.targetLocale, origin, source_hash: currentHash,
        observed_source_hash: currentHash, applied_value_hash: valueHash, generation: (state?.generation ?? 0) + 1, deleted: 0, updated_at: now };
    } else {
      const valueIsManaged = state && !state.deleted && state.origin !== 'manual' && state.applied_value_hash === valueHash;
      const manual = state?.origin === 'manual' || (!valueIsManaged && Boolean(field.target.trim()));
      row = { field_id: field.fieldId, target_locale: field.targetLocale, origin: manual ? 'manual' : state?.origin ?? 'seed',
        source_hash: state?.source_hash ?? (prev && field.target.trim() ? await sourceHash(prev) : ''),
        observed_source_hash: currentHash, applied_value_hash: valueHash,
        generation: (state?.generation ?? 0) + 1, deleted: 0, updated_at: now };
      if (!manual && field.source.trim() && (!field.target.trim() || row.source_hash !== currentHash)) {
        changes.jobs.push(createTranslationJob(field, row.generation, currentHash));
      }
    }
    changes.states.push(row);
  }
  // Tombstones survive deletion and same-ID restoration, so A→delete→A cannot revive an old result.
  for (const [key, field] of before) if (!present.has(key)) {
    const state = existing.get(key);
    if (state?.deleted) continue;
    changes.states.push({ field_id: field.fieldId, target_locale: field.targetLocale, origin: state?.origin ?? 'manual',
      source_hash: state?.source_hash ?? await sourceHash(field), observed_source_hash: state?.observed_source_hash ?? await sourceHash(field),
      applied_value_hash: state?.applied_value_hash ?? await hash(field.target), generation: (state?.generation ?? 0) + 1, deleted: 1, updated_at: now });
  }
  return changes;
}

/** JSON batches keep D1 bind counts bounded, even for the initial 1,482-field backfill. */
export function prepareTranslationChanges(db: D1Database, changes: TranslationChanges, nonce: string, revision: number): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  const guard = 'EXISTS (SELECT 1 FROM config_draft WHERE id=1 AND write_nonce=?2 AND draft_rev=?3)';
  for (let start = 0; start < changes.states.length; start += 100) {
    const batch = JSON.stringify(changes.states.slice(start, start + 100));
    statements.push(db.prepare(`INSERT INTO translation_state
      (field_id,target_locale,origin,source_hash,observed_source_hash,applied_value_hash,generation,deleted,updated_at)
      SELECT json_extract(value,'$.field_id'),json_extract(value,'$.target_locale'),json_extract(value,'$.origin'),
        json_extract(value,'$.source_hash'),json_extract(value,'$.observed_source_hash'),json_extract(value,'$.applied_value_hash'),
        json_extract(value,'$.generation'),json_extract(value,'$.deleted'),json_extract(value,'$.updated_at')
      FROM json_each(?1) WHERE ${guard}
      ON CONFLICT(field_id,target_locale) DO UPDATE SET origin=excluded.origin,source_hash=excluded.source_hash,
        observed_source_hash=excluded.observed_source_hash,applied_value_hash=excluded.applied_value_hash,
        generation=excluded.generation,deleted=excluded.deleted,updated_at=excluded.updated_at`).bind(batch, nonce, revision));
    statements.push(db.prepare(`UPDATE translation_jobs SET status='obsolete',lease_token=NULL,lease_until=NULL,updated_at=?4
      WHERE status IN ('pending','running','failed') AND ${guard}
      AND EXISTS (SELECT 1 FROM json_each(?1) AS changed WHERE translation_jobs.field_id=json_extract(changed.value,'$.field_id')
        AND translation_jobs.target_locale=json_extract(changed.value,'$.target_locale')
        AND translation_jobs.generation < json_extract(changed.value,'$.generation'))`).bind(batch, nonce, revision, Date.now()));
  }
  for (let start = 0; start < changes.jobs.length; start += 50) {
    const fields = ['id','field_id','target_locale','generation','intent','source_text','context','source_hash','target_value',
      'credential_rev','execution_rev','model','rules_version','status','lease_token','lease_until','attempts','next_attempt_at',
      'result','error_code','usage','created_at','updated_at'];
    statements.push(db.prepare(`INSERT INTO translation_jobs (${fields.join(',')})
      SELECT ${fields.map((field) => `json_extract(value,'$.${field}')`).join(',')} FROM json_each(?1) WHERE ${guard}
      ON CONFLICT(field_id,target_locale,generation) DO NOTHING`).bind(JSON.stringify(changes.jobs.slice(start, start + 50)), nonce, revision));
  }
  for (const job of changes.completeJobs ?? []) statements.push(db.prepare(`UPDATE translation_jobs SET status='succeeded',lease_token=NULL,lease_until=NULL,updated_at=?4
    WHERE id=?1 AND status='running' AND lease_token=?5 AND ${guard}`).bind(job.id, nonce, revision, Date.now(), job.leaseToken));
  for (const job of changes.cancelJobs ?? []) statements.push(db.prepare(`UPDATE translation_jobs SET status='cancelled',lease_token=NULL,lease_until=NULL,updated_at=?4
    WHERE id=?1 AND generation=?5 AND status IN ('pending','running','failed','obsolete') AND ${guard}`).bind(job.id, nonce, revision, Date.now(), job.generation));
  return statements;
}

export async function translationFreshness(db: D1Database, config: SiteConfig, manifest: CopyManifest): Promise<Finding[]> {
  const states = await loadTranslationState(db), issues: Finding[] = [];
  for (const field of enumerateTranslationFields(config, manifest)) {
    if (!field.required || !config.enabledLocales.includes(field.targetLocale) || !field.target.trim()) continue;
    const state = states.get(translationStateKey(field.fieldId, field.targetLocale));
    if (state && !state.deleted && state.origin !== 'manual' && state.source_hash !== await translationSourceHash(field)) {
      issues.push({ path: field.draftFieldId, rule: 'translation-stale', message: '原文已更新，译文尚未更新' });
    }
  }
  return issues;
}
