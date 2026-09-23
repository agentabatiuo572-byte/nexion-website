import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { SiteConfigSchema, type SiteConfig } from '../../schema/src/index.js';
import { enumerateTranslationFields, setDraftField, validateTranslationValue, type TranslationField } from '../../schema/src/draft-fields.js';
import seed from '../seed/site-config.seed.json';
import { requireAuth, requireSameOriginJson } from './auth';
import { ensureInit } from './config';
import { AiError, isTranslationTarget, TRANSLATION_TARGET_LOCALES, requestTranslations, validateTranslationInputs, validateTranslationText, type AiUsage } from './ai-client';
import { AI_LEASE_MS, aiConnectionUsable, aiLeaseGuardSql, aiLeaseGuardValues, allowedAiModels, claimAiCall,
  finishAiCall, getAiConnection, markAiCallSent, recoverAiCall, type AiEnv, type AiCallLease } from './ai-connection';
import { commitDraftWrite, DRAFT_MANIFEST, DraftWriteError, fillDraftDefaults, type DraftSnapshot } from './draft-write';
import { createTranslationJob, hashTranslationText, translationSourceHash, translationStateKey,
  type TranslationChanges, type TranslationJobRow, type TranslationStateRow } from './translation-state';

type C = Context<{ Bindings: AiEnv }>;
const key = (f: { fieldId: string; targetLocale: string }) => translationStateKey(f.fieldId, f.targetLocale);
const jobKey = (j: TranslationJobRow) => translationStateKey(j.field_id, j.target_locale);
const MAX_ATTEMPTS = 3;
export const TRANSLATION_ENQUEUE_BATCH_SIZE = 50;
const JOB_STATUSES = ['pending', 'running', 'succeeded', 'obsolete', 'cancelled', 'failed'] as const;
const connectionGuard = 'EXISTS (SELECT 1 FROM ai_connection WHERE id=1 AND enabled=1 AND credential_rev=? AND execution_rev=?)';
const stateGuard = 'EXISTS (SELECT 1 FROM translation_state s WHERE s.field_id=translation_jobs.field_id AND s.target_locale=translation_jobs.target_locale AND s.generation=translation_jobs.generation AND s.deleted=0)';
const countCharacters = (f: TranslationField) => Array.from(f.source).length + Array.from(f.context).length;

async function current(db: D1Database) {
  const upgrade = await ensureInit(db);
  if (upgrade.status === 'blocked') throw new DraftWriteError(409, { error: 'config-upgrade-conflict', conflicts: upgrade.conflicts });
  if (upgrade.status === 'retry') throw new DraftWriteError(409, { error: 'config-upgrade-retry' });
  const rows = await db.batch([db.prepare('SELECT payload,draft_rev,updated_at FROM config_draft WHERE id=1'), db.prepare('SELECT * FROM translation_state'),
    db.prepare(`SELECT j.id,j.field_id,j.target_locale,j.generation,j.status,j.error_code FROM translation_jobs j JOIN translation_state s
      ON s.field_id=j.field_id AND s.target_locale=j.target_locale AND s.generation=j.generation WHERE s.deleted=0`)]);
  const snapshot = rows[0].results[0] as unknown as DraftSnapshot | undefined;
  if (!snapshot) throw new DraftWriteError(409, { error: 'draft-uninitialized' });
  const config = SiteConfigSchema.parse(JSON.parse(snapshot.payload));
  const fields = enumerateTranslationFields(config, DRAFT_MANIFEST);
  const states = new Map((rows[1].results as unknown as TranslationStateRow[]).map(s => [translationStateKey(s.field_id, s.target_locale), s]));
  const currentJobs = new Map((rows[2].results as unknown as Array<Pick<TranslationJobRow, 'id' | 'field_id' | 'target_locale' | 'generation' | 'status' | 'error_code'>>)
    .map(j => [translationStateKey(j.field_id, j.target_locale), j]));
  const hashes = new Map<string, Promise<string>>();
  const sourceHash = (f: TranslationField) => {
    const input = JSON.stringify([f.fieldId, f.source, f.context]);
    if (!hashes.has(input)) hashes.set(input, translationSourceHash(f));
    return hashes.get(input)!;
  };
  return { snapshot, config, fields, states, currentJobs, sourceHash, byKey: new Map(fields.map(f => [key(f), f])) };
}
type Current = Awaited<ReturnType<typeof current>>;
async function eligible(ctx: Current, job: TranslationJobRow): Promise<TranslationField | null> {
  const f = ctx.byKey.get(jobKey(job)), s = ctx.states.get(jobKey(job));
  if (!f || !s || s.deleted || s.generation !== job.generation || !f.source.trim() ||
    f.target !== job.target_value || await ctx.sourceHash(f) !== job.source_hash ||
    (job.intent === 'auto' && (s.origin === 'manual' || s.applied_value_hash !== await hashTranslationText(f.target)))) return null;
  return f;
}
async function stateFor(ctx: Current, f: TranslationField, manual: boolean, confirm: boolean): Promise<TranslationStateRow> {
  const old = ctx.states.get(key(f)), hash = await ctx.sourceHash(f);
  return { field_id: f.fieldId, target_locale: f.targetLocale,
    origin: manual ? 'manual' : old?.origin ?? 'seed', source_hash: confirm ? hash : old?.source_hash ?? '',
    observed_source_hash: hash, applied_value_hash: await hashTranslationText(f.target),
    generation: (old?.generation ?? 0) + 1, deleted: 0, updated_at: Date.now() };
}
const safeResult = (result: Awaited<ReturnType<typeof commitDraftWrite>>) => ({
  ok: true, draftRev: result.draftRev, applied: result.applied, skipped: result.skipped, queued: result.queued,
});

/** Explicit scans also run when AI is re-enabled; cancellations are not silently rescanned by ticks. */
export async function enqueueMissingTranslations(env: AiEnv, requestedLocale?: (typeof TRANSLATION_TARGET_LOCALES)[number], requestedLimit = TRANSLATION_ENQUEUE_BATCH_SIZE) {
  await current(env.DB);
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctx = await current(env.DB);
    const existing = (await env.DB.prepare("SELECT * FROM translation_jobs WHERE status IN ('pending','running') AND intent='auto'").all<TranslationJobRow>()).results;
    const activeLocales = new Set(existing.map(job => job.target_locale));
    const changes: TranslationChanges = { states: [], jobs: [] };
    let targetLocale = requestedLocale;
    for (const f of ctx.fields) {
      if (!isTranslationTarget(f.targetLocale)) continue;
      if (requestedLocale && f.targetLocale !== requestedLocale) continue;
      if (activeLocales.has(f.targetLocale)) continue;
      const s = ctx.states.get(key(f));
      if (!f.source.trim() || s?.origin === 'manual' || (f.target.trim() && (!s || s.deleted || s.applied_value_hash !== await hashTranslationText(f.target)))) continue;
      const hash = await ctx.sourceHash(f);
      if (f.target.trim() && s?.source_hash === hash) continue;
      if (!targetLocale) targetLocale = f.targetLocale;
      if (f.targetLocale !== targetLocale) continue;
      const row = await stateFor(ctx, f, false, false);
      changes.states.push(row); changes.jobs.push(createTranslationJob(f, row.generation, hash));
      if (changes.jobs.length >= requestedLimit) break;
    }
    try {
      const result = await commitDraftWrite(env.DB, { snapshot: ctx.snapshot, payload: ctx.config, translation: changes, reason: 'translation.enqueue' });
      const inserted = changes.jobs.length ? await env.DB.prepare('SELECT COUNT(*) AS count FROM translation_jobs WHERE id IN (SELECT value FROM json_each(?))')
        .bind(JSON.stringify(changes.jobs.map(job => job.id))).first<{ count: number }>() : null;
      return { ...safeResult(result), queued: inserted?.count ?? 0, targetLocale: targetLocale ?? null, batchLimit: TRANSLATION_ENQUEUE_BATCH_SIZE };
    }
    catch (e) { if (!(e instanceof DraftWriteError) || e.status !== 409 || attempt === 2) throw e; }
  }
  throw new DraftWriteError(409, { error: 'conflict' });
}

async function chooseField(ctx: Current, input: { fieldId: string; targetLocale: string; sourceHash: string; targetValue: string }) {
  const f = ctx.byKey.get(key(input));
  if (!f) throw new DraftWriteError(400, { error: 'unknown-field' });
  if (await ctx.sourceHash(f) !== input.sourceHash || f.target !== input.targetValue) throw new DraftWriteError(409, { error: 'field-conflict' });
  return f;
}
async function explicit(env: AiEnv, input: z.infer<typeof fieldRequest>) {
  const ctx = await current(env.DB), f = await chooseField(ctx, input);
  if (input.mode === 'retranslate' && !f.source.trim()) throw new DraftWriteError(400, { error: 'source-empty' });
  const old = ctx.states.get(key(f));
  const job = ctx.currentJobs.get(key(f));
  const active = job && ['pending', 'running'].includes(job.status) ? job : null;
  if (input.mode === 'keep' && !active && old?.origin === 'manual' && !old.deleted && old.source_hash === input.sourceHash &&
    old.observed_source_hash === input.sourceHash && old.applied_value_hash === await hashTranslationText(f.target))
    return safeResult(await commitDraftWrite(env.DB, { snapshot: ctx.snapshot, payload: ctx.config, translation: { states: [], jobs: [] } }));
  const row = await stateFor(ctx, f, true, input.mode === 'keep');
  const changes: TranslationChanges = { states: [row], jobs: input.mode === 'keep' ? [] : [createTranslationJob(f, row.generation, await ctx.sourceHash(f), 'manual')],
    cancelJobs: input.mode === 'keep' && active ? [{ id: active.id, generation: active.generation }] : [] };
  return safeResult(await commitDraftWrite(env.DB, { snapshot: ctx.snapshot, payload: ctx.config, translation: changes, reason: 'translation.' + input.mode }));
}

async function defaultsPreview(db: D1Database) {
  const ctx = await current(db);
  const defaults = new Map(enumerateTranslationFields(SiteConfigSchema.parse(seed), DRAFT_MANIFEST).map(f => [key(f), f]));
  let applied = 0, skipped = 0;
  for (const f of ctx.fields) {
    if (f.target.trim()) continue;
    const match = defaults.get(key(f));
    if (ctx.states.get(key(f))?.origin === 'manual' || !f.source.trim() || !match || match.source !== f.source || match.context !== f.context || validateTranslationValue(f, match.target)) skipped++;
    else applied++;
  }
  return { ok: true, dryRun: true, draftRev: ctx.snapshot.draft_rev, applied, skipped, queued: 0 };
}

async function status(env: AiEnv, offset: number, limit: number) {
  const ctx = await current(env.DB);
  const states = await Promise.all(ctx.fields.map(async f => {
    const s = ctx.states.get(key(f)), sourceHash = await ctx.sourceHash(f), job = ctx.currentJobs.get(key(f));
    return { fieldId: f.fieldId, targetLocale: f.targetLocale, draftFieldId: f.draftFieldId,
      origin: s && !s.deleted ? s.origin : f.target.trim() ? 'manual' as const : 'none' as const,
      generation: s?.generation ?? 0, stale: !!s && !s.deleted && s.origin !== 'manual' && s.source_hash !== sourceHash && !!f.target.trim(),
      reviewNeeded: !!s && !s.deleted && s.origin === 'manual' && s.source_hash !== sourceHash && !!f.target.trim(),
      missing: !!f.source.trim() && !f.target.trim(), sourceHash, targetValue: f.target, required: f.required,
      jobStatus: job?.status ?? null, jobErrorCode: job?.error_code ?? null };
  }));
  const counts = { missing: states.filter(s => s.missing).length, stale: states.filter(s => s.stale).length,
    ready: states.filter(s => s.targetValue.trim() && !s.stale).length, manualReview: states.filter(s => s.reviewNeeded).length,
    pending: 0, running: 0, succeeded: 0, obsolete: 0, cancelled: 0, failed: 0 };
  const grouped = (await env.DB.prepare('SELECT status,COUNT(*) AS count FROM translation_jobs GROUP BY status').all<{status: string; count: number}>()).results;
  for (const g of grouped) if (JOB_STATUSES.includes(g.status as typeof JOB_STATUSES[number])) counts[g.status as typeof JOB_STATUSES[number]] = g.count;
  const now = Date.now(), connection = await getAiConnection(env.DB);
  const activity = await env.DB.prepare(`SELECT
    MAX(updated_at) AS last_activity_at,
    MIN(CASE WHEN status='pending' AND next_attempt_at>?1 THEN next_attempt_at END) AS next_attempt_at,
    SUM(CASE WHEN status='pending' AND next_attempt_at<=?1 THEN 1 ELSE 0 END) AS ready_pending,
    MAX(CASE WHEN status='running' THEN lease_until END) AS running_lease_until
    FROM translation_jobs`).bind(now).first<{ last_activity_at: number | null; next_attempt_at: number | null;
      ready_pending: number; running_lease_until: number | null }>();
  const active = counts.pending + counts.running;
  const usedToday = connection.usage_day === new Date(now).toISOString().slice(0, 10) ? connection.sent_characters : 0;
  let queueStatus = 'idle';
  if (active) {
    if (!connection.enabled) queueStatus = 'paused';
    else if (!aiConnectionUsable(connection) || !allowedAiModels(env, connection.provider).includes(connection.model)) queueStatus = 'unavailable';
    else if (usedToday >= connection.daily_character_limit) queueStatus = 'daily-limit';
    else if (counts.running && (activity?.running_lease_until ?? 0) > now) queueStatus = 'running';
    else if (!(activity?.ready_pending ?? 0) && (activity?.next_attempt_at ?? 0) > now) queueStatus = 'waiting';
    else queueStatus = now - (activity?.last_activity_at ?? now) > 150_000 ? 'stalled' : 'queued';
  }
  const rows = (await env.DB.prepare('SELECT * FROM translation_jobs ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?').bind(limit + 1, offset).all<TranslationJobRow>()).results;
  const items = await Promise.all(rows.slice(0, limit).map(async j => {
    const f = ctx.byKey.get(jobKey(j));
    return { id: j.id, status: j.status, fieldId: j.field_id, targetLocale: j.target_locale, intent: j.intent,
      errorCode: j.error_code, sourceHash: f ? await ctx.sourceHash(f) : null, targetValue: f?.target ?? null,
      createdAt: j.created_at, updatedAt: j.updated_at, attempts: j.attempts,
      canRetry: !!f && !!f.source.trim() && ['failed', 'cancelled', 'obsolete'].includes(j.status) };
  }));
  return { draftRev: ctx.snapshot.draft_rev, enabledLocales: ctx.config.enabledLocales, batchLimit: TRANSLATION_ENQUEUE_BATCH_SIZE,
    counts, queue: { status: queueStatus, lastActivityAt: activity?.last_activity_at ?? null,
      nextAttemptAt: activity?.next_attempt_at ?? null }, states, items, nextCursor: rows.length > limit ? String(offset + limit) : null };
}

const fieldBaseline = { fieldId: z.string().min(1).max(512), targetLocale: z.custom<(typeof TRANSLATION_TARGET_LOCALES)[number]>(isTranslationTarget),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/), targetValue: z.string().max(20000) };
const fieldRequest = z.object({ mode: z.enum(['retranslate','keep']), ...fieldBaseline }).strict();
const enqueueRequest = z.union([z.object({ mode: z.literal('missing'),
  targetLocale: fieldBaseline.targetLocale, limit: z.number().int().min(1).max(TRANSLATION_ENQUEUE_BATCH_SIZE).optional() }).strict(), fieldRequest]);
const retryRequest = z.object({ items: z.array(z.object({ id: z.string().uuid(), sourceHash: fieldBaseline.sourceHash, targetValue: fieldBaseline.targetValue }).strict()).min(1).max(100) }).strict();
const cancelRequest = z.object({ ids: z.array(z.string().uuid()).min(1).max(100) }).strict();
async function body<T extends z.ZodType>(c: C, schema: T): Promise<z.infer<T>> {
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new DraftWriteError(400, { error: 'bad-request' });
  const chunks: Uint8Array[] = []; let length = 0;
  try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.length;
    if (length > 128 * 1024) { await reader.cancel(); throw new DraftWriteError(400, { error: 'body-too-large' }); } chunks.push(chunk.value); } }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let parsed: unknown; try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new DraftWriteError(400, { error: 'bad-request' }); }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new DraftWriteError(400, { error: 'bad-request' });
  return result.data;
}
export const translationsRoutes = new Hono<{ Bindings: AiEnv }>();
translationsRoutes.onError((e, c) => e instanceof DraftWriteError ? c.json(e.body, e.status)
  : c.json({ error: e instanceof AiError ? e.code : 'translation-operation-failed', message: '翻译操作未完成，请刷新状态后重试。' }, 503));
translationsRoutes.use('*', requireAuth);
translationsRoutes.use('*', requireSameOriginJson);
translationsRoutes.get('/', async c => {
  const offset = Number(c.req.query('cursor') ?? 0), limit = Number(c.req.query('limit') ?? 50);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) return c.json({ error: 'bad-request' }, 400);
  return c.json(await status(c.env, offset, limit));
});
translationsRoutes.post('/defaults', async c => {
  const input = await body(c, z.object({ dryRun: z.boolean().optional() }).strict());
  await current(c.env.DB);
  return c.json(input.dryRun ? await defaultsPreview(c.env.DB) : safeResult(await fillDraftDefaults(c.env.DB)));
});
translationsRoutes.post('/', async c => {
  const input = await body(c, enqueueRequest);
  return c.json(input.mode === 'missing' ? await enqueueMissingTranslations(c.env, input.targetLocale, input.limit) : await explicit(c.env, input));
});
translationsRoutes.post('/retry', async c => {
  const input = await body(c, retryRequest), ctx = await current(c.env.DB);
  if (new Set(input.items.map(i => i.id)).size !== input.items.length) return c.json({ error: 'bad-request' }, 400);
  const changes: TranslationChanges = { states: [], jobs: [] }; const selected = new Set<string>();
  for (const item of input.items) {
    const job = await c.env.DB.prepare('SELECT * FROM translation_jobs WHERE id=?').bind(item.id).first<TranslationJobRow>();
    if (!job || !['failed','cancelled','obsolete'].includes(job.status) || selected.has(jobKey(job))) throw new DraftWriteError(409, { error: 'task-conflict' });
    selected.add(jobKey(job));
    const f = await chooseField(ctx, { ...item, fieldId: job.field_id, targetLocale: job.target_locale });
    if (!f.source.trim()) throw new DraftWriteError(400, { error: 'source-empty' });
    const old = ctx.states.get(key(f));
    if (job.intent === 'auto' && (old?.origin === 'manual' || (f.target.trim() && (!old || old.applied_value_hash !== await hashTranslationText(f.target))))) throw new DraftWriteError(409, { error: 'manual-protected' });
    const row = await stateFor(ctx, f, job.intent === 'manual', false);
    changes.states.push(row); changes.jobs.push(createTranslationJob(f, row.generation, await ctx.sourceHash(f), job.intent));
  }
  return c.json(safeResult(await commitDraftWrite(c.env.DB, { snapshot: ctx.snapshot, payload: ctx.config, translation: changes, reason: 'translation.retry' })));
});
translationsRoutes.post('/cancel', async c => {
  const input = await body(c, cancelRequest), ctx = await current(c.env.DB);
  const changes: TranslationChanges = { states: [], jobs: [], cancelJobs: [] };
  for (const id of new Set(input.ids)) {
    const j = await c.env.DB.prepare('SELECT * FROM translation_jobs WHERE id=?').bind(id).first<TranslationJobRow>();
    if (!j || !['pending','running','failed','obsolete'].includes(j.status)) continue;
    const s = ctx.states.get(jobKey(j));
    if (s && s.generation === j.generation && !changes.states.some(r => r.field_id === s.field_id && r.target_locale === s.target_locale))
      changes.states.push({ ...s, generation: s.generation + 1, updated_at: Date.now() });
    changes.cancelJobs!.push({ id: j.id, generation: j.generation });
  }
  return c.json(safeResult(await commitDraftWrite(c.env.DB, { snapshot: ctx.snapshot, payload: ctx.config, translation: changes, reason: 'translation.cancel' })));
});

async function updateOwned(db: D1Database, job: TranslationJobRow, next: string, error: string | null, nextAt = 0) {
  await db.prepare('UPDATE translation_jobs SET status=?,error_code=?,next_attempt_at=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status=? AND lease_token IS ?')
    .bind(next, error, nextAt, Date.now(), job.id, job.status, job.lease_token).run();
}

/** Candidate is already durable. CAS retries never call the provider again. */
async function applyCandidate(env: AiEnv, job: TranslationJobRow): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctx = await current(env.DB), f = await eligible(ctx, job);
    if (!f) { await updateOwned(env.DB, job, 'obsolete', 'baseline-changed'); return false; }
    let text: string;
    try { const value: unknown = JSON.parse(job.result ?? '');
      if (!value || typeof value !== 'object' || Object.keys(value).length !== 1 || !('text' in value) || typeof value.text !== 'string') throw new Error();
      text = value.text; validateTranslationText(f.source, f.targetLocale, text, f.maxLength);
    } catch { await updateOwned(env.DB, job, 'failed', 'invalid-result'); return false; }
    const state = ctx.states.get(key(f))!;
    setDraftField(ctx.config, f.draftFieldId, text, DRAFT_MANIFEST);
    const now = Date.now();
    const guard = { sql: `${connectionGuard} AND EXISTS (SELECT 1 FROM translation_jobs WHERE id=? AND status='running' AND lease_token=? AND lease_until>? AND generation=? AND credential_rev=? AND execution_rev=? AND ${stateGuard})`,
      bindings: [job.credential_rev, job.execution_rev, job.id, job.lease_token, now, job.generation, job.credential_rev, job.execution_rev] };
    try {
      await commitDraftWrite(env.DB, { snapshot: ctx.snapshot, payload: ctx.config, guard,
        translation: { states: [{ ...state, origin: job.intent === 'manual' ? 'manual' : 'ai', source_hash: job.source_hash,
          observed_source_hash: job.source_hash, applied_value_hash: await hashTranslationText(text), updated_at: now }],
          jobs: [], completeJobs: [{ id: job.id, leaseToken: job.lease_token! }] }, reason: 'translation.apply' });
      return true;
    } catch (e) { if (!(e instanceof DraftWriteError) || e.status !== 409) throw e; }
  }
  // Keep the candidate for a later tick; the current lease may have been cancelled or transferred.
  await updateOwned(env.DB, job, 'pending', 'apply-conflict', Date.now() + 1000);
  return false;
}

async function recoverJobs(env: AiEnv) {
  const now = Date.now();
  await recoverAiCall(env.DB, now);
  // Changed credentials/execution invalidate candidates; manual replacement needs fresh consent.
  await env.DB.prepare(`UPDATE translation_jobs SET status=CASE WHEN intent='manual' THEN 'failed' WHEN attempts>=? THEN 'failed' ELSE 'pending' END,
    error_code=CASE WHEN intent='manual' THEN 'needs-retry' ELSE 'connection-changed' END,result=NULL,usage=NULL,lease_token=NULL,lease_until=NULL,updated_at=?
    WHERE status IN ('running','pending') AND credential_rev IS NOT NULL AND EXISTS
      (SELECT 1 FROM ai_connection c WHERE c.id=1 AND (translation_jobs.credential_rev<>c.credential_rev OR translation_jobs.execution_rev<>c.execution_rev))`)
    .bind(MAX_ATTEMPTS, now).run();
  await env.DB.prepare(`UPDATE translation_jobs SET status=CASE WHEN result IS NOT NULL OR attempts<? THEN 'pending' ELSE 'failed' END,
    error_code=CASE WHEN result IS NOT NULL THEN NULL ELSE 'interrupted' END,lease_token=NULL,lease_until=NULL,updated_at=?
    WHERE status='running' AND lease_until<=?`).bind(MAX_ATTEMPTS, now, now).run();
}

export interface TranslationDrainResult { status: string; applied: number; requested: number }
/** One bounded batch per tick, shared global model-call lease with connection tests. */
export async function drainTranslations(env: AiEnv): Promise<TranslationDrainResult> {
  const started = Date.now();
  await recoverJobs(env);
  const connection = await getAiConnection(env.DB);
  const summary: TranslationDrainResult = { status: 'idle', applied: 0, requested: 0 };
  if (!connection.enabled || !aiConnectionUsable(connection) || !allowedAiModels(env, connection.provider).includes(connection.model)) return { ...summary, status: 'paused' };
  const candidates = (await env.DB.prepare("SELECT * FROM translation_jobs WHERE status='pending' AND result IS NOT NULL AND next_attempt_at<=? ORDER BY created_at LIMIT 20").bind(Date.now()).all<TranslationJobRow>()).results;
  for (const job of candidates) {
    if (Date.now() - started > 4000) return { ...summary, status: 'partial' };
    const now = Date.now(), token = crypto.randomUUID();
    const claimed = await env.DB.prepare(`UPDATE translation_jobs SET status='running',lease_token=?,lease_until=?,updated_at=?
      WHERE id=? AND status='pending' AND result IS NOT NULL AND credential_rev=? AND execution_rev=? AND ${connectionGuard} AND ${stateGuard}`)
      .bind(token, now + AI_LEASE_MS, now, job.id, connection.credential_rev, connection.execution_rev, connection.credential_rev, connection.execution_rev).run();
    if (claimed.meta.changes) { job.status = 'running'; job.lease_token = token; job.lease_until = now + AI_LEASE_MS;
      if (await applyCandidate(env, job)) summary.applied++; }
  }
  if (Date.now() - started > 4000) return { ...summary, status: 'partial' };
  const ctx = await current(env.DB);
  const today = new Date(started).toISOString().slice(0, 10);
  const remainingCharacters = connection.daily_character_limit - (connection.usage_day === today ? connection.sent_characters : 0);
  if (remainingCharacters <= 0) return { ...summary, status: 'daily-limit' };
  const characterLimit = Math.min(3000, remainingCharacters);
  const now = Date.now();
  const locales = (await env.DB.prepare(`SELECT target_locale,MIN(created_at) AS oldest FROM translation_jobs
    WHERE status='pending' AND result IS NULL AND attempts<? AND next_attempt_at<=?
    GROUP BY target_locale ORDER BY oldest,target_locale`).bind(MAX_ATTEMPTS, now).all<{ target_locale: string }>()).results;
  if (!locales.length) return summary;
  // Riva may need two 24 s calls per field; claim only what one 90 s lease can cover.
  const batchLimit = connection.provider === 'nvidia' ? 1 : 20;
  let batch: Array<{ job: TranslationJobRow; field: TranslationField }> = [], characters = 0, budgetBlocked = false;
  for (const locale of locales) {
    const pending = (await env.DB.prepare("SELECT * FROM translation_jobs WHERE status='pending' AND result IS NULL AND attempts<? AND next_attempt_at<=? AND target_locale=? ORDER BY created_at,id LIMIT 100")
      .bind(MAX_ATTEMPTS, now, locale.target_locale).all<TranslationJobRow>()).results;
    const candidate: typeof batch = []; let candidateCharacters = 0;
    for (const job of pending) {
      const field = await eligible(ctx, job);
      if (!field) { await updateOwned(env.DB, job, 'obsolete', 'baseline-changed'); continue; }
      const count = countCharacters(field);
      if (count > 3000) { await updateOwned(env.DB, job, 'failed', 'too-long'); continue; }
      if (candidateCharacters + count > characterLimit) { budgetBlocked = true; continue; }
      candidate.push({ job, field }); candidateCharacters += count;
      if (candidate.length >= batchLimit) break;
    }
    if (candidate.length) { batch = candidate; characters = candidateCharacters; break; }
    if (Date.now() - started > 4000) return { ...summary, status: 'partial' };
  }
  if (!batch.length) return budgetBlocked ? { ...summary, status: 'daily-limit' } : summary;
  if (Date.now() - started > 4000) return summary;
  const ids = JSON.stringify(batch.map(b => b.job.id));
  const claim = await claimAiCall(env, { purpose: 'translation', characters, expectedCredentialRev: connection.credential_rev,
    expectedExecutionRev: connection.execution_rev }, lease => [env.DB.prepare(`UPDATE translation_jobs SET status='running',lease_token=?,lease_until=?,
      credential_rev=?,execution_rev=?,model=?,attempts=attempts+1,error_code=NULL,updated_at=?
      WHERE id IN (SELECT value FROM json_each(?)) AND status='pending' AND result IS NULL AND attempts<? AND ${stateGuard}
      AND EXISTS (SELECT 1 FROM config_draft WHERE id=1 AND draft_rev=? AND payload=?) AND ${aiLeaseGuardSql()}`)
      .bind(lease.token, lease.until, lease.credentialRev, lease.executionRev, lease.model, Date.now(), ids, MAX_ATTEMPTS,
        ctx.snapshot.draft_rev, ctx.snapshot.payload, ...aiLeaseGuardValues(lease))]);
  if (claim.status !== 'claimed') return { ...summary, status: claim.status === 'rejected' ? claim.error : 'busy' };
  const lease: AiCallLease = claim.lease;
  let usage: AiUsage | null = null, error: AiError | undefined;
  const owned = (await env.DB.prepare("SELECT * FROM translation_jobs WHERE lease_token=? AND status='running'").bind(lease.token).all<TranslationJobRow>()).results;
  try {
    const latest = await current(env.DB);
    if (owned.length !== batch.length || (await Promise.all(owned.map(j => eligible(latest, j)))).some(f => !f)) throw new AiError('cancelled');
    const fields = batch.map(b => ({ id: b.job.field_id, source: b.field.source, context: b.field.context, maxLength: b.field.maxLength }));
    validateTranslationInputs(batch[0].field.targetLocale, fields);
    if (!await markAiCallSent(env, lease)) throw new AiError('cancelled');
    summary.requested = fields.length;
    const response = await requestTranslations(lease.apiKey, lease.model, batch[0].field.targetLocale, fields, undefined, lease.provider);
    usage = response.usage;
    const translated = new Map(response.translations.map(value => [value.id, value]));
    const failed = new Map((response.failures ?? []).map(value => [value.id, value]));
    // Persist the whole validated response before any draft update, under this execution's ownership.
    const completed = owned.filter(job => translated.has(job.field_id));
    if (completed.length) await env.DB.batch(completed.map(j => env.DB.prepare(`UPDATE translation_jobs SET result=?,usage=?,updated_at=?
      WHERE id=? AND status='running' AND lease_token=? AND lease_until>? AND ${stateGuard} AND ${connectionGuard}`)
      .bind(JSON.stringify({ text: translated.get(j.field_id)!.text }), JSON.stringify(usage), Date.now(),
        j.id, lease.token, Date.now(), lease.credentialRev, lease.executionRev)));
    for (const job of owned) {
      const failure = failed.get(job.field_id);
      if (!failure) continue;
      await updateOwned(env.DB, job, failure.retryable && job.attempts < MAX_ATTEMPTS ? 'pending' : 'failed', failure.code,
        Date.now() + Math.max(failure.retryAfterMs, job.attempts <= 1 ? 30000 : 120000));
    }
    for (const job of owned) {
      const saved = await env.DB.prepare("SELECT * FROM translation_jobs WHERE id=? AND status='running' AND lease_token=? AND result IS NOT NULL").bind(job.id, lease.token).first<TranslationJobRow>();
      if (saved && Date.now() - started < 24500 && await applyCandidate(env, saved)) summary.applied++;
    }
    summary.status = response.translations.length ? 'processed' : response.failures?.[0]?.code ?? 'invalid-result';
    if (!response.translations.length && response.failures?.[0]) error = new AiError(response.failures[0].code,
      response.failures[0].retryable, response.failures[0].retryAfterMs);
  } catch (e) {
    error = e instanceof AiError ? e : new AiError('storage-error');
    summary.status = error.code;
    for (const j of owned) {
      const saved = await env.DB.prepare('SELECT result FROM translation_jobs WHERE id=?').bind(j.id).first<{ result: string | null }>();
      const retry = !!saved?.result || ((error.retryable || error.code === 'cancelled') && j.attempts < MAX_ATTEMPTS);
      await updateOwned(env.DB, j, retry ? 'pending' : 'failed', error.code,
        Date.now() + (saved?.result ? 1000 : Math.max(error.retryAfterMs, j.attempts <= 1 ? 30000 : 120000)));
    }
  } finally { await finishAiCall(env, lease, { usage, error: error?.code }); }
  return summary;
}
