import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { translationsRoutes, drainTranslations, enqueueMissingTranslations } from '../src/translations';
import { encryptApiKey, getAiConnection, type AiEnv } from '../src/ai-connection';
import { AI_PROVIDERS } from '../src/ai-client';
import { DRAFT_MANIFEST, readDraftSnapshot, saveDraftPatch } from '../src/draft-write';
import { enumerateTranslationFields, setDraftField } from '../../schema/src/draft-fields.js';
import { SiteConfigSchema } from '../../schema/src/index.js';
import { SOURCE_LOCALE, type Locale } from '../../schema/src/locales.js';
import seed from '../seed/site-config.seed.json';
import { hashTranslationText, translationSourceHash, type TranslationJobRow } from '../src/translation-state';

const ROOT = btoa(String.fromCharCode(...new Uint8Array(32).fill(23)));
const local = () => ({ ...env, AI_CREDENTIAL_ENCRYPTION_KEY: ROOT }) as AiEnv;
const app = new Hono<{ Bindings: AiEnv }>().route('/api/translations', translationsRoutes);
const request = (path = '', method = 'GET', body?: unknown, headers: Record<string, string> = {}, bindings = local()) =>
  app.request('http://localhost/api/translations' + path, { method,
    headers: { cookie: 'nx_sid=translations-session', origin: 'http://localhost', 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, bindings);
async function jobs() { return (await env.DB.prepare('SELECT * FROM translation_jobs ORDER BY created_at,id').all<TranslationJobRow>()).results; }
async function setupField(source = '欢迎来到未来。', target = '', locale = 'ja') {
  const config = SiteConfigSchema.parse(seed);
  config.copy[SOURCE_LOCALE]['hero.note'] = source;
  config.copy[locale as keyof typeof config.copy]['hero.note'] = target;
  await env.DB.prepare('UPDATE config_draft SET payload=? WHERE id=1').bind(JSON.stringify(config)).run();
  return enumerateTranslationFields(config, DRAFT_MANIFEST).find(f => f.fieldId === '/copy/hero.note' && f.targetLocale === locale)!;
}
async function enqueue(field: Awaited<ReturnType<typeof setupField>>, mode = 'retranslate') {
  const response = await request('', 'POST', { mode, fieldId: field.fieldId, targetLocale: field.targetLocale,
    sourceHash: await translationSourceHash(field), targetValue: field.target });
  expect(response.status).toBe(200);
  return response.json();
}
function success(ids: string[], text = '未来へようこそ。') {
  return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: JSON.stringify({ translations: ids.map(id => ({ id, text })) }) }] }],
    usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } });
}
beforeEach(async () => {
  vi.restoreAllMocks();
  await env.DB.prepare('DELETE FROM translation_jobs').run();
  await env.DB.prepare('DELETE FROM translation_state').run();
  await env.DB.prepare('DELETE FROM config_draft').run();
  await env.DB.prepare('INSERT INTO config_draft(id,payload,base_revision,draft_rev,updated_at) VALUES(1,?,0,1,?)').bind(JSON.stringify(SiteConfigSchema.parse(seed)), Date.now()).run();
  await env.DB.prepare('DELETE FROM ai_connection').run();
  await env.DB.prepare('INSERT INTO ai_connection(id) VALUES(1)').run();
  const encrypted = await encryptApiKey(local(), 'synthetic-zen-translation-test-key');
  await env.DB.prepare("UPDATE ai_connection SET key_ciphertext=?,key_iv=?,key_version=1,credential_rev=1,enabled=1,connection_status='available' WHERE id=1")
    .bind(encrypted.ciphertext, encrypted.iv).run();
  await env.DB.prepare('DELETE FROM sessions').run();
  await env.DB.prepare('INSERT INTO sessions(token_hash,created_at,expires_at) VALUES(?,?,?)')
    .bind(await hashTranslationText('translations-session'), Date.now(), Date.now() + 3600000).run();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const input = JSON.parse(body.input) as { fields: Array<{ id: string }> };
    return success(input.fields.map(f => f.id));
  });
});
afterEach(() => vi.restoreAllMocks());

describe('persistent translation application', () => {
  const translated = { en: 'Welcome to the future.', vi: 'Chào mừng đến với tương lai.', es: 'Bienvenido al futuro.',
    pt: 'Bem-vindo ao futuro.', fr: 'Bienvenue dans le futur.', de: 'Willkommen in der Zukunft.',
    ja: '未来へようこそ。', ko: '미래에 오신 것을 환영합니다.' };
  it.each(Object.entries(translated).flatMap(([target, text]) => ['manual', 'auto'].map(mode => ({ target, text, mode }))))
  ('$mode Chinese to $target persists without changing the source', async ({ target, text, mode }) => {
    const field = await setupField('欢迎来到未来。', '', target);
    if (mode === 'manual') await enqueue(field);
    else {
      await enqueueMissingTranslations(local());
      // Other seed gaps are unrelated to this field's end-to-end language contract.
      await env.DB.prepare("UPDATE translation_jobs SET status='cancelled' WHERE field_id<>? OR target_locale<>?")
        .bind(field.fieldId, target).run();
    }
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)), input = JSON.parse(body.input);
      expect(body.instructions).toContain(`from ${SOURCE_LOCALE} into ${target}`);
      expect(input.fields[0].source).toBe(field.source);
      return success(input.fields.map((item: { id: string }) => item.id), text);
    });
    expect(await drainTranslations(local())).toMatchObject({ applied: 1, requested: 1 });
    const saved = SiteConfigSchema.parse(JSON.parse((await readDraftSnapshot(env.DB)).payload));
    expect(saved.copy[target as Locale]['hero.note']).toBe(text);
    expect(saved.copy[SOURCE_LOCALE]['hero.note']).toBe(field.source);
    expect((await jobs()).find(job => job.field_id === field.fieldId && job.target_locale === target))
      .toMatchObject({ status: 'succeeded', target_locale: target, intent: mode });
    expect(await drainTranslations(local())).toMatchObject({ applied: 0, requested: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('cannot enqueue the authored source as a translation target', async () => {
    const field = await setupField(), before = await readDraftSnapshot(env.DB);
    expect((await request('', 'POST', { mode: 'retranslate', fieldId: field.fieldId, targetLocale: SOURCE_LOCALE,
      sourceHash: await translationSourceHash(field), targetValue: field.target })).status).toBe(400);
    expect(await readDraftSnapshot(env.DB)).toEqual(before);
    expect(await jobs()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('Gemini background translation uses the stored provider and persists one validated draft result', async () => {
    const field = await setupField(); await enqueue(field);
    const encrypted = await encryptApiKey(local(), 'AQ.synthetic-gemini-translation-key', 'gemini');
    await env.DB.prepare("UPDATE ai_connection SET provider='gemini',model=?,key_ciphertext=?,key_iv=? WHERE id=1")
      .bind(AI_PROVIDERS.gemini.defaultModel, encrypted.ciphertext, encrypted.iv).run();
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      expect(url).toBe(AI_PROVIDERS.gemini.endpoint);
      expect(init?.headers).toMatchObject({ authorization: 'Bearer AQ.synthetic-gemini-translation-key' });
      const body = JSON.parse(String(init?.body)), input = JSON.parse(body.messages[1].content);
      return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant',
        content: JSON.stringify({ translations: input.fields.map((f: { id: string }) => ({ id: f.id, text: '未来へようこそ。' })) }) } }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });
    });
    expect(await drainTranslations(local())).toMatchObject({ status: 'processed', applied: 1, requested: 1 });
    expect(JSON.parse((await readDraftSnapshot(env.DB)).payload).copy.ja['hero.note']).toBe('未来へようこそ。');
    expect((await jobs())[0]).toMatchObject({ status: 'succeeded', model: AI_PROVIDERS.gemini.defaultModel });
    expect(await getAiConnection(env.DB)).toMatchObject({ provider: 'gemini', call_count: 1, input_tokens: 20, output_tokens: 10, unknown_usage_count: 0 });
    expect(await drainTranslations(local())).toMatchObject({ applied: 0, requested: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('provider/model mismatch pauses queued work without spending or mutating the draft', async () => {
    const field = await setupField(); await enqueue(field);
    const before = await readDraftSnapshot(env.DB);
    await env.DB.prepare("UPDATE ai_connection SET model=? WHERE id=1").bind(AI_PROVIDERS.gemini.defaultModel).run();
    expect(await drainTranslations(local())).toMatchObject({ status: 'paused', requested: 0 });
    expect(await readDraftSnapshot(env.DB)).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['http://localhost:4399','http://127.0.0.1:4399'])('built-origin %s is allowed for development translations', async origin => {
    expect((await request('/defaults', 'POST', { dryRun: true }, { origin })).status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['http://localhost:4398','http://127.0.0.1:4444','https://attacker.example'])('translation origin guard rejects unlisted origin %s', async origin => {
    expect((await request('/defaults', 'POST', { dryRun: true }, { origin })).status).toBe(403);
  });
  it('production translations require same origin and JSON bodies', async () => {
    expect((await request('/defaults', 'POST', { dryRun: true }, { origin: 'http://localhost:4399' }, { ...local(), ENVIRONMENT: 'production' })).status).toBe(403);
    expect((await request('/defaults', 'POST', { dryRun: true }, { 'content-type': 'text/plain' })).status).toBe(415);
  });
  it.each(['pending', 'running'] as const)('keep invalidates a %s retranslation even when manual source and target were already confirmed', async phase => {
    const field = await setupField('Welcome to the future.', '今の人工訳を保ちます。');
    await enqueue(field, 'keep');
    await enqueue(field, 'retranslate');
    let release!: () => void, entered!: () => void;
    const arrived = new Promise<void>(r => { entered = r; }), hold = new Promise<void>(r => { release = r; });
    vi.mocked(fetch).mockImplementation(async () => { entered(); await hold; return success([field.fieldId]); });
    const running = phase === 'running' ? drainTranslations(local()) : null;
    if (running) await arrived;
    let result: unknown;
    try { result = await enqueue(field, 'keep'); }
    finally { if (running) { release(); await running; } }
    expect(result).toMatchObject({ draftRev: 4 });
    expect((await jobs())[0]).toMatchObject({ status: 'cancelled', lease_token: null });
    expect(JSON.parse((await readDraftSnapshot(env.DB)).payload).copy.ja['hero.note']).toBe(field.target);
    expect(await env.DB.prepare('SELECT generation,origin FROM translation_state WHERE field_id=? AND target_locale=?')
      .bind(field.fieldId, 'ja').first()).toEqual({ generation: 3, origin: 'manual' });
    await enqueue(field, 'keep');
    expect((await readDraftSnapshot(env.DB)).draft_rev).toBe(4);
    if (phase === 'pending') { await drainTranslations(local()); expect(fetch).not.toHaveBeenCalled(); }
    else expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('queues explicit translation and stores validated text in the draft with manual ownership', async () => {
    const field = await setupField();
    await enqueue(field);
    expect((await jobs())[0]).toMatchObject({ status: 'pending', intent: 'manual' });
    await drainTranslations(local());
    expect((await jobs())[0]).toMatchObject({ status: 'succeeded', attempts: 1, result: expect.any(String) });
    const draft = await readDraftSnapshot(env.DB);
    expect(JSON.parse(draft.payload).copy.ja['hero.note']).toBe('未来へようこそ。');
    expect(draft.draft_rev).toBe(3);
    expect(await env.DB.prepare('SELECT origin FROM translation_state WHERE field_id=? AND target_locale=?').bind(field.fieldId, 'ja').first()).toEqual({ origin: 'manual' });
    expect(await getAiConnection(env.DB)).toMatchObject({ call_count: 1, input_tokens: 20, output_tokens: 10, unknown_usage_count: 0 });
  });
  it('GET and default preview do not write; exact defaults fill once without a model request', async () => {
    const field = await setupField(SiteConfigSchema.parse(seed).copy.zh['hero.note']);
    const before = await readDraftSnapshot(env.DB);
    const status = await (await request()).json() as { draftRev: number; states: Array<{ draftFieldId: string; sourceHash: string }> };
    expect(status.draftRev).toBe(1);
    expect(status.states.find(s => s.draftFieldId === field.draftFieldId)?.sourceHash).toBe(await translationSourceHash(field));
    const preview = await (await request('/defaults', 'POST', { dryRun: true })).json();
    expect(preview).toMatchObject({ applied: 1, draftRev: 1 });
    expect(await readDraftSnapshot(env.DB)).toEqual(before);
    expect(await (await request('/defaults', 'POST', {})).json()).toMatchObject({ applied: 1, draftRev: 2 });
    expect(await (await request('/defaults', 'POST', {})).json()).toMatchObject({ applied: 0, draftRev: 2 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('manual keep including an empty target protects it from bulk scans and defaults', async () => {
    const field = await setupField();
    await enqueue(field, 'keep');
    await enqueueMissingTranslations(local());
    expect((await jobs()).filter(j => j.field_id === field.fieldId && j.target_locale === 'ja')).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('bulk scans reuse a current generation and queue only unprotected missing translations', async () => {
    const field = await setupField();
    await enqueueMissingTranslations(local());
    await enqueueMissingTranslations(local());
    const selected = (await jobs()).filter(j => j.field_id === field.fieldId && j.target_locale === 'ja');
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({ intent: 'auto', status: 'pending' });
    await env.DB.prepare("UPDATE translation_jobs SET status='cancelled' WHERE id<>?").bind(selected[0].id).run();
    await drainTranslations(local());
    expect(await env.DB.prepare('SELECT origin FROM translation_state WHERE field_id=? AND target_locale=?').bind(field.fieldId, 'ja').first()).toEqual({ origin: 'ai' });
  });
  it('bulk scans enqueue one requested language in bounded batches', async () => {
    const config = SiteConfigSchema.parse(seed);
    const names = Object.keys(config.copy.zh).slice(0, 12);
    const untouchedDefault = Object.keys(config.copy.zh).find(name => !names.includes(name) && config.copy.ja[name])!;
    config.copy.ja[untouchedDefault] = '';
    for (const name of names) {
      config.copy.zh[name] = 'A phrase that needs translation.';
      config.copy.ja[name] = '';
      config.copy.fr[name] = '';
    }
    await env.DB.prepare('UPDATE config_draft SET payload=?').bind(JSON.stringify(config)).run();
    const first = await (await request('', 'POST', { mode: 'missing', targetLocale: 'fr', limit: 5 })).json() as {
      queued: number; targetLocale: string; batchLimit: number;
    };
    expect(first).toMatchObject({ queued: 5, targetLocale: 'fr', batchLimit: 50 });
    expect((await jobs()).filter(job => job.target_locale === 'fr')).toHaveLength(5);
    expect((await jobs()).filter(job => job.target_locale === 'ja')).toHaveLength(0);
    const second = await (await request('', 'POST', { mode: 'missing', targetLocale: 'fr', limit: 50 })).json() as typeof first;
    expect(second.queued).toBe(0);
    expect((await jobs()).filter(job => job.target_locale === 'fr')).toHaveLength(first.queued);
    expect((await jobs()).filter(job => job.target_locale === 'ja')).toHaveLength(0);
    expect(SiteConfigSchema.parse(JSON.parse((await readDraftSnapshot(env.DB)).payload)).copy.ja[untouchedDefault]).toBe('');
  });
  it('bulk scan request rejects unsupported targets and oversized batches', async () => {
    expect((await request('', 'POST', { mode: 'missing' })).status).toBe(400);
    expect((await request('', 'POST', { mode: 'missing', targetLocale: SOURCE_LOCALE, limit: 50 })).status).toBe(400);
    expect((await request('', 'POST', { mode: 'missing', targetLocale: 'fr', limit: 51 })).status).toBe(400);
    expect(await jobs()).toEqual([]);
  });
  it('concurrent clicks keep one current job per field and language', async () => {
    const config = SiteConfigSchema.parse(seed);
    const names = Object.keys(config.copy.zh).slice(0, 4);
    for (const name of names) { config.copy.zh[name] = 'Concurrent batch source.'; config.copy.fr[name] = ''; }
    await env.DB.prepare('UPDATE config_draft SET payload=?').bind(JSON.stringify(config)).run();
    const responses = await Promise.all([
      request('', 'POST', { mode: 'missing', targetLocale: 'fr', limit: 50 }),
      request('', 'POST', { mode: 'missing', targetLocale: 'fr', limit: 50 }),
    ]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    const payloads = await Promise.all(responses.map(response => response.json() as Promise<{ queued: number }>));
    const localeJobs = (await jobs()).filter(job => job.target_locale === 'fr');
    expect(payloads.reduce((sum, response) => sum + response.queued, 0)).toBe(localeJobs.length);
    const selected = (await jobs()).filter(job => job.target_locale === 'fr' && names.includes(job.field_id.slice('/copy/'.length)));
    expect(selected).toHaveLength(4);
    expect(new Set(selected.map(job => `${job.field_id}:${job.target_locale}:${job.generation}`)).size).toBe(4);
  });
  it('a manual field translation does not block a separate automatic language batch', async () => {
    const config = SiteConfigSchema.parse(seed);
    const [manualName, automaticName] = Object.keys(config.copy.zh).slice(0, 2);
    config.copy.zh[manualName!] = 'Translate this field manually.'; config.copy.fr[manualName!] = '';
    config.copy.zh[automaticName!] = 'Translate this field in the batch.'; config.copy.fr[automaticName!] = '';
    await env.DB.prepare('UPDATE config_draft SET payload=?').bind(JSON.stringify(config)).run();
    const fields = enumerateTranslationFields(config, DRAFT_MANIFEST);
    const manual = fields.find(field => field.fieldId === `/copy/${manualName}` && field.targetLocale === 'fr')!;
    await enqueue(manual);
    const response = await (await request('', 'POST', { mode: 'missing', targetLocale: 'fr', limit: 50 })).json() as { queued: number };
    expect(response.queued).toBeGreaterThan(0);
    const selected = await jobs();
    expect(selected.find(job => job.field_id === `/copy/${manualName}` && job.target_locale === 'fr')).toMatchObject({ intent: 'manual', status: 'pending' });
    expect(selected.find(job => job.field_id === `/copy/${automaticName}` && job.target_locale === 'fr')).toMatchObject({ intent: 'auto', status: 'pending' });
  });
  it('full field states include current-generation failures outside the paginated task list', async () => {
    const field = await setupField(); await enqueueMissingTranslations(local());
    const job = (await jobs()).find(j => j.field_id === field.fieldId && j.target_locale === 'ja')!;
    await env.DB.prepare("UPDATE translation_jobs SET created_at=1,status='failed',error_code='invalid-result' WHERE id=?").bind(job.id).run();
    const response = await (await request('?limit=1')).json() as {
      items: Array<{id: string}>; nextCursor: string | null;
      states: Array<{draftFieldId: string; jobStatus: string | null; jobErrorCode: string | null}>;
    };
    expect(response.items).toHaveLength(1);
    expect(response.items[0].id).not.toBe(job.id);
    expect(response.nextCursor).toBe('1');
    expect(response.states.find(s => s.draftFieldId === field.draftFieldId)).toMatchObject({ jobStatus: 'failed', jobErrorCode: 'invalid-result' });
    await enqueue(field, 'keep');
    const next = await (await request()).json() as typeof response;
    expect(next.states.find(s => s.draftFieldId === field.draftFieldId)).toMatchObject({ jobStatus: null, jobErrorCode: null });
  });
  it('rejects stale per-field baselines, unknown paths, missing sessions, foreign origins and oversized bodies', async () => {
    const field = await setupField();
    const body = { mode: 'retranslate', fieldId: field.fieldId, targetLocale: 'ja', sourceHash: '0'.repeat(64), targetValue: '' };
    expect((await request('', 'POST', body)).status).toBe(409);
    expect((await request('', 'POST', { ...body, fieldId: '/legal/terms/md' })).status).toBe(400);
    expect((await request('', 'POST', body, { cookie: '', authorization: 'Bearer publish-token' })).status).toBe(401);
    expect((await request('', 'POST', body, { origin: 'https://attacker.example' })).status).toBe(403);
    expect((await request('', 'POST', { ...body, targetValue: 'x'.repeat(140000) })).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('cancellation advances generation atomically and prevents a delayed result from applying', async () => {
    const field = await setupField(); await enqueue(field);
    let release!: () => void, entered!: () => void;
    const arrived = new Promise<void>(r => { entered = r; }), hold = new Promise<void>(r => { release = r; });
    vi.mocked(fetch).mockImplementation(async () => { entered(); await hold; return success([field.fieldId]); });
    const pending = drainTranslations(local()); await arrived;
    const job = (await jobs())[0];
    expect((await request('/cancel', 'POST', { ids: [job.id] })).status).toBe(200);
    release(); await pending;
    expect((await jobs())[0]).toMatchObject({ status: 'cancelled', lease_token: null });
    expect(JSON.parse((await readDraftSnapshot(env.DB)).payload).copy.ja['hero.note']).toBe('');
    expect(await env.DB.prepare('SELECT generation FROM translation_state WHERE field_id=? AND target_locale=?').bind(field.fieldId, 'ja').first()).toEqual({ generation: 2 });
    await drainTranslations(local()); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['source', 'target', 'source-aba'] as const)('late result cannot overwrite %s edits', async mode => {
    const field = await setupField(); await enqueue(field);
    let release!: () => void, entered!: () => void;
    const arrived = new Promise<void>(r => { entered = r; }), hold = new Promise<void>(r => { release = r; });
    vi.mocked(fetch).mockImplementation(async () => { entered(); await hold; return success([field.fieldId]); });
    const pending = drainTranslations(local()); await arrived;
    const path = mode === 'target' ? field.draftFieldId : '/copy/zh/hero.note';
    const before = mode === 'target' ? '' : field.source;
    const after = mode === 'target' ? '人工の文面です。' : 'A changed source.';
    const edited = await saveDraftPatch(env.DB, { baseRevision: 2, operations: [{ op: 'set', fieldId: path, before, after }] });
    if (mode === 'source-aba') await saveDraftPatch(env.DB, { baseRevision: edited.draftRev, operations: [{ op: 'set', fieldId: path, before: after, after: before }] });
    release(); await pending;
    expect((await jobs())[0]).toMatchObject({ status: 'obsolete' });
    expect(JSON.parse((await readDraftSnapshot(env.DB)).payload).copy.ja['hero.note']).toBe(mode === 'target' ? after : '');
  });
  it('stored candidate survives an application transaction failure and recovers without another paid request', async () => {
    const field = await setupField(); await enqueue(field);
    await env.DB.prepare("CREATE TRIGGER translation_apply_failure BEFORE INSERT ON audit WHEN NEW.reason='translation.apply' BEGIN SELECT RAISE(ABORT,'synthetic-secret-detail'); END").run();
    try { expect(await drainTranslations(local())).toMatchObject({ status: 'storage-error', applied: 0 }); }
    finally { await env.DB.prepare('DROP TRIGGER translation_apply_failure').run(); }
    expect((await jobs())[0]).toMatchObject({ status: 'pending', result: expect.any(String), attempts: 1 });
    expect(JSON.parse((await readDraftSnapshot(env.DB)).payload).copy.ja['hero.note']).toBe('');
    await env.DB.prepare('UPDATE translation_jobs SET next_attempt_at=0').run();
    await drainTranslations(local());
    expect((await jobs())[0].status).toBe('succeeded');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await getAiConnection(env.DB)).toMatchObject({ call_count: 1, input_tokens: 20, output_tokens: 10 });
    expect(JSON.stringify(await (await request()).json())).not.toContain('synthetic-secret-detail');
  });
  it('expired running candidate is applied directly after restart', async () => {
    const field = await setupField(); await enqueue(field);
    await env.DB.prepare("UPDATE translation_jobs SET status='running',lease_token='old',lease_until=1,attempts=1,result=?,credential_rev=1,execution_rev=0 WHERE field_id=?")
      .bind(JSON.stringify({ text: '未来へようこそ。' }), field.fieldId).run();
    await drainTranslations(local());
    expect((await jobs())[0].status).toBe('succeeded');
    expect(fetch).not.toHaveBeenCalled();
    expect((await getAiConnection(env.DB)).call_count).toBe(0);
  });
  it('old-connection persisted manual candidate becomes needs-retry and never changes the draft', async () => {
    const field = await setupField(); await enqueue(field);
    await env.DB.prepare("UPDATE translation_jobs SET status='running',lease_token='old',lease_until=1,attempts=1,result=?,credential_rev=1,execution_rev=0")
      .bind(JSON.stringify({ text: '未来へようこそ。' })).run();
    await env.DB.prepare('UPDATE ai_connection SET credential_rev=2,execution_rev=1').run();
    await drainTranslations(local());
    expect((await jobs())[0]).toMatchObject({ status: 'failed', error_code: 'needs-retry', result: null, attempts: 1 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('disabling and re-enabling during a call invalidates its candidate despite the same final enabled value', async () => {
    const field = await setupField(); await enqueue(field);
    let release!: () => void, entered!: () => void;
    const arrived = new Promise<void>(r => { entered = r; }), hold = new Promise<void>(r => { release = r; });
    vi.mocked(fetch).mockImplementation(async () => { entered(); await hold; return success([field.fieldId]); });
    const pending = drainTranslations(local()); await arrived;
    await env.DB.prepare('UPDATE ai_connection SET enabled=0,execution_rev=execution_rev+1').run();
    await env.DB.prepare('UPDATE ai_connection SET enabled=1,execution_rev=execution_rev+1').run();
    expect(await drainTranslations(local())).toMatchObject({ requested: 0 });
    release(); await pending;
    expect((await jobs())[0]).toMatchObject({ status: 'failed', error_code: 'needs-retry' });
    expect(JSON.parse((await readDraftSnapshot(env.DB)).payload).copy.ja['hero.note']).toBe('');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('concurrent ticks admit one model call', async () => {
    const field = await setupField(); await enqueue(field);
    let release!: () => void, entered!: () => void;
    const arrived = new Promise<void>(r => { entered = r; }), hold = new Promise<void>(r => { release = r; });
    vi.mocked(fetch).mockImplementation(async () => { entered(); await hold; return success([field.fieldId]); });
    const one = drainTranslations(local()); await arrived;
    await drainTranslations(local()); release(); await one;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await jobs())[0]).toMatchObject({ status: 'succeeded', attempts: 1 });
  });
  it('limits long fields without payment and bounds rate-limit retries to three attempts', async () => {
    const long = await setupField('word '.repeat(700)); await enqueue(long);
    await drainTranslations(local());
    expect((await jobs())[0]).toMatchObject({ status: 'failed', error_code: 'too-long', attempts: 0 });
    expect(fetch).not.toHaveBeenCalled();
    const field = await setupField(); await enqueue(field);
    vi.mocked(fetch).mockResolvedValue(Response.json({ error: { code: 'rate_limit_exceeded', message: 'private-provider-error' } }, { status: 429, headers: { 'retry-after': '180' } }));
    await drainTranslations(local());
    let active = (await jobs()).find(j => j.status === 'pending')!;
    expect(active).toMatchObject({ attempts: 1, error_code: 'rate-limited' });
    expect(active.next_attempt_at).toBeGreaterThan(Date.now() + 170000);
    await drainTranslations(local()); expect(fetch).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 2; i++) { await env.DB.prepare('UPDATE translation_jobs SET next_attempt_at=0').run(); await drainTranslations(local()); }
    active = (await jobs()).find(j => j.id === active.id)!;
    expect(active).toMatchObject({ attempts: 3, status: 'failed' });
    await drainTranslations(local()); expect(fetch).toHaveBeenCalledTimes(3);
    expect((await getAiConnection(env.DB)).unknown_usage_count).toBe(3);
    expect(JSON.stringify(await (await request()).json())).not.toContain('private-provider-error');
  });
  it('explicit retry uses current baselines and creates a new generation preserving manual intent', async () => {
    const field = await setupField(); await enqueue(field);
    vi.mocked(fetch).mockResolvedValue(Response.json({ status: 'incomplete' }));
    await drainTranslations(local()); const old = (await jobs())[0];
    expect(old.status).toBe('failed');
    expect((await request('/retry', 'POST', { items: [{ id: old.id, sourceHash: '0'.repeat(64), targetValue: '' }] })).status).toBe(409);
    expect((await request('/retry', 'POST', { items: [{ id: old.id, sourceHash: await translationSourceHash(field), targetValue: '' }] })).status).toBe(200);
    expect((await jobs()).find(j => j.id !== old.id)).toMatchObject({ status: 'pending', intent: 'manual', generation: 2, attempts: 0 });
    expect((await getAiConnection(env.DB)).call_count).toBe(1);
  });
  it('paused and exhausted configurations leave tasks pending with zero requests', async () => {
    const field = await setupField(); await enqueue(field);
    await env.DB.prepare('UPDATE ai_connection SET enabled=0').run();
    expect(await drainTranslations(local())).toMatchObject({ status: 'paused' });
    await env.DB.prepare('UPDATE ai_connection SET enabled=1,usage_day=?,sent_characters=daily_character_limit').bind(new Date().toISOString().slice(0,10)).run();
    expect(await drainTranslations(local())).toMatchObject({ status: 'daily-limit' });
    expect((await jobs())[0]).toMatchObject({ status: 'pending', attempts: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('a recovery racing a newer connection and job owner cannot erase the new owner or candidate', async () => {
    const field = await setupField(); await enqueue(field);
    await env.DB.prepare("UPDATE translation_jobs SET status='running',credential_rev=1,execution_rev=0,lease_token='old-owner',lease_until=?")
      .bind(Date.now() + 90000).run();
    let injected = false;
    const db = new Proxy(env.DB, { get(target, name) {
      if (name !== 'prepare') { const value = Reflect.get(target, name); return typeof value === 'function' ? value.bind(target) : value; }
      return (sql: string) => {
        const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(stmt, prop) {
          if (prop === 'bind') return (...args: unknown[]) => wrap(stmt.bind(...args));
          if (prop === 'run') return async () => {
            if (!injected && sql.includes("status=CASE WHEN intent='manual'")) {
              injected = true;
              await env.DB.batch([
                env.DB.prepare('UPDATE ai_connection SET credential_rev=2,execution_rev=1'),
                env.DB.prepare("UPDATE translation_jobs SET credential_rev=2,execution_rev=1,lease_token='new-owner',result=?").bind(JSON.stringify({ text: '新しい候補です。' })),
              ]);
            }
            return stmt.run();
          };
          const value = Reflect.get(stmt, prop); return typeof value === 'function' ? value.bind(stmt) : value;
        } });
        return wrap(target.prepare(sql));
      };
    } });
    await drainTranslations({ ...local(), DB: db });
    expect(injected).toBe(true);
    expect((await jobs())[0]).toMatchObject({ status: 'running', credential_rev: 2, execution_rev: 1, lease_token: 'new-owner', result: JSON.stringify({ text: '新しい候補です。' }) });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('first visit initializes an empty installation and incompatible old drafts return explicit conflicts', async () => {
    await env.DB.prepare('DELETE FROM config_draft').run();
    await env.DB.prepare('DELETE FROM config_versions').run();
    expect((await request()).status).toBe(200);
    expect((await readDraftSnapshot(env.DB)).draft_rev).toBe(1);
    await env.DB.prepare('UPDATE config_draft SET payload=?').bind('{"version":999}').run();
    const old = await readDraftSnapshot(env.DB);
    const response = await request();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'config-upgrade-conflict' });
    expect(await readDraftSnapshot(env.DB)).toEqual(old);
    expect((await request('/defaults', 'POST', {})).status).toBe(409);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('manual source changes are review reminders, separate from machine stale counts', async () => {
    const field = await setupField('Welcome to the future.', '人工の訳文です。'); await enqueue(field, 'keep');
    await saveDraftPatch(env.DB, { baseRevision: 2, operations: [{ op: 'set', fieldId: '/copy/zh/hero.note', before: field.source, after: 'Welcome to a new future.' }] });
    const result = await (await request()).json() as { counts: { stale: number; manualReview: number }; states: Array<{ draftFieldId: string; stale: boolean; reviewNeeded: boolean }> };
    expect(result.states.find(s => s.draftFieldId === field.draftFieldId)).toMatchObject({ stale: false, reviewNeeded: true });
    expect(result.counts.stale).toBe(0);
    expect(result.counts.manualReview).toBeGreaterThan(0);
  });
  it('same-language batching admits at most twenty fields and accounts for a response once', async () => {
    const config = SiteConfigSchema.parse(seed);
    const names = Object.keys(config.copy.zh).slice(0, 23);
    for (const name of names) { config.copy.zh[name] = 'Welcome to the future.'; config.copy.ja[name] = ''; }
    await env.DB.prepare('UPDATE config_draft SET payload=?').bind(JSON.stringify(config)).run();
    await enqueueMissingTranslations(local());
    await env.DB.prepare("UPDATE translation_jobs SET status='cancelled' WHERE target_locale<>'ja' OR field_id NOT IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(names.map(name => '/copy/' + name))).run();
    const result = await drainTranslations(local());
    expect(result).toMatchObject({ requested: 20, applied: 20 });
    expect((await jobs()).filter(j => j.status === 'pending')).toHaveLength(3);
    expect(await getAiConnection(env.DB)).toMatchObject({ call_count: 1, input_tokens: 20, output_tokens: 10 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('uses the remaining daily character budget for a smaller language batch', async () => {
    const config = SiteConfigSchema.parse(seed);
    const names = Object.keys(config.copy.zh).slice(0, 2);
    for (const name of names) { config.copy.zh[name] = 'A short source.'; config.copy.ja[name] = ''; }
    await env.DB.prepare('UPDATE config_draft SET payload=?').bind(JSON.stringify(config)).run();
    const fields = enumerateTranslationFields(config, DRAFT_MANIFEST).filter(field => field.targetLocale === 'ja' && names.includes(field.fieldId.slice('/copy/'.length)));
    await enqueue(fields[0]!); await enqueue(fields[1]!);
    const selected = (await jobs()).filter(job => job.target_locale === 'ja' && names.includes(job.field_id.slice('/copy/'.length)));
    await env.DB.prepare('UPDATE translation_jobs SET created_at=? WHERE id=?').bind(1, selected[0]!.id).run();
    await env.DB.prepare('UPDATE translation_jobs SET created_at=? WHERE id=?').bind(2, selected[1]!.id).run();
    const first = fields.find(field => field.fieldId === selected[0]!.field_id)!;
    const characters = Array.from(first.source).length + Array.from(first.context).length;
    const connection = await getAiConnection(env.DB);
    await env.DB.prepare('UPDATE ai_connection SET usage_day=?,sent_characters=?').bind(new Date().toISOString().slice(0, 10), connection.daily_character_limit - characters).run();
    expect(await drainTranslations(local())).toMatchObject({ status: 'processed', requested: 1, applied: 1 });
    expect((await jobs()).filter(job => job.status === 'pending' && job.target_locale === 'ja')).toHaveLength(1);
  });
  it('uses another language when the oldest language cannot fit the remaining daily budget', async () => {
    const config = SiteConfigSchema.parse(seed);
    const [longName, shortName] = Object.keys(config.copy.zh).slice(0, 2);
    config.copy.zh[longName!] = 'L'.repeat(240); config.copy.ja[longName!] = '';
    config.copy.zh[shortName!] = 'Short.'; config.copy.fr[shortName!] = '';
    await env.DB.prepare('UPDATE config_draft SET payload=?').bind(JSON.stringify(config)).run();
    const fields = enumerateTranslationFields(config, DRAFT_MANIFEST);
    const long = fields.find(field => field.fieldId === `/copy/${longName}` && field.targetLocale === 'ja')!;
    const short = fields.find(field => field.fieldId === `/copy/${shortName}` && field.targetLocale === 'fr')!;
    await enqueue(long); await enqueue(short);
    const selected = await jobs(), longJob = selected.find(job => job.target_locale === 'ja')!, shortJob = selected.find(job => job.target_locale === 'fr')!;
    await env.DB.prepare('UPDATE translation_jobs SET created_at=? WHERE id=?').bind(1, longJob.id).run();
    await env.DB.prepare('UPDATE translation_jobs SET created_at=? WHERE id=?').bind(2, shortJob.id).run();
    const shortCharacters = Array.from(short.source).length + Array.from(short.context).length;
    expect(Array.from(long.source).length + Array.from(long.context).length).toBeGreaterThan(shortCharacters);
    const connection = await getAiConnection(env.DB);
    await env.DB.prepare('UPDATE ai_connection SET usage_day=?,sent_characters=?').bind(new Date().toISOString().slice(0, 10), connection.daily_character_limit - shortCharacters).run();
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)), input = JSON.parse(body.input) as { fields: Array<{ id: string }> };
      return success(input.fields.map(field => field.id), 'Traduction courte.');
    });
    expect(await drainTranslations(local())).toMatchObject({ status: 'processed', requested: 1, applied: 1 });
    expect((await jobs()).find(job => job.id === longJob.id)).toMatchObject({ status: 'pending' });
    expect((await jobs()).find(job => job.id === shortJob.id)).toMatchObject({ status: 'succeeded' });
  });
  it('a deleted FAQ stays deleted when its in-flight translation returns', async () => {
    const config = SiteConfigSchema.parse(seed), faq = config.faq.items[0];
    faq.q.zh = 'Welcome to the future.'; faq.q.ja = '';
    await env.DB.prepare('UPDATE config_draft SET payload=?').bind(JSON.stringify(config)).run();
    const field = enumerateTranslationFields(config, DRAFT_MANIFEST).find(f => f.fieldId === `/faq/items/${faq.id}/q` && f.targetLocale === 'ja')!;
    await enqueue(field);
    let release!: () => void, entered!: () => void;
    const arrived = new Promise<void>(r => { entered = r; }), hold = new Promise<void>(r => { release = r; });
    vi.mocked(fetch).mockImplementation(async () => { entered(); await hold; return success([field.fieldId]); });
    const running = drainTranslations(local()); await arrived;
    await saveDraftPatch(env.DB, { baseRevision: 2, operations: [{ op: 'remove', collection: '/faq/items', before: faq }] });
    release(); await running;
    expect(JSON.parse((await readDraftSnapshot(env.DB)).payload).faq.items.some((i: {id: string}) => i.id === faq.id)).toBe(false);
    expect((await jobs())[0]).toMatchObject({ status: 'obsolete' });
    expect(await env.DB.prepare('SELECT deleted FROM translation_state WHERE field_id=? AND target_locale=?').bind(field.fieldId, 'ja').first()).toEqual({ deleted: 1 });
  });
  it('cancel audit failure rolls back both the draft revision and generation', async () => {
    const field = await setupField(); await enqueue(field);
    const before = await readDraftSnapshot(env.DB), job = (await jobs())[0];
    await env.DB.prepare("CREATE TRIGGER translation_cancel_failure BEFORE INSERT ON audit WHEN NEW.reason='translation.cancel' BEGIN SELECT RAISE(ABORT,'synthetic-cancel-detail'); END").run();
    try {
      const response = await request('/cancel', 'POST', { ids: [job.id] });
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('synthetic-cancel-detail');
      expect(await readDraftSnapshot(env.DB)).toEqual(before);
      expect((await jobs())[0]).toMatchObject({ status: 'pending', generation: 1 });
      expect(await env.DB.prepare('SELECT generation FROM translation_state WHERE field_id=? AND target_locale=?').bind(field.fieldId, 'ja').first()).toEqual({ generation: 1 });
    } finally { await env.DB.prepare('DROP TRIGGER translation_cancel_failure').run(); }
  });
  it.each(['cancel', 'lease', 'generation', 'connection'] as const)('final SQL rejects %s changes after the application read', async mode => {
    const field = await setupField(); await enqueue(field);
    await env.DB.prepare("UPDATE translation_jobs SET status='pending',attempts=1,result=?,credential_rev=1,execution_rev=0")
      .bind(JSON.stringify({ text: '未来へようこそ。' })).run();
    let guarded: D1PreparedStatement | null = null, injected = false;
    const db = new Proxy(env.DB, { get(target, name) {
      if (name === 'prepare') return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.startsWith('UPDATE config_draft SET payload=') || !sql.includes('lease_until>')) return statement;
        return new Proxy(statement, { get(stmt, prop) {
          if (prop === 'bind') return (...args: unknown[]) => { guarded = stmt.bind(...args); return guarded; };
          const value = Reflect.get(stmt, prop); return typeof value === 'function' ? value.bind(stmt) : value;
        } });
      };
      if (name === 'batch') return async (statements: D1PreparedStatement[]) => {
        if (!injected && guarded && statements.includes(guarded)) {
          injected = true;
          // Changes intentionally keep draft_rev unchanged, proving the additional final guards.
          if (mode === 'cancel') await env.DB.prepare("UPDATE translation_jobs SET status='cancelled',lease_token=NULL").run();
          if (mode === 'lease') await env.DB.prepare("UPDATE translation_jobs SET lease_token='successor-owner',lease_until=?").bind(Date.now() + 90000).run();
          if (mode === 'generation') await env.DB.prepare('UPDATE translation_state SET generation=generation+1').run();
          if (mode === 'connection') await env.DB.prepare('UPDATE ai_connection SET enabled=0,execution_rev=execution_rev+1').run();
        }
        return target.batch(statements);
      };
      const value = Reflect.get(target, name); return typeof value === 'function' ? value.bind(target) : value;
    } });
    await drainTranslations({ ...local(), DB: db });
    expect(injected).toBe(true);
    expect(JSON.parse((await readDraftSnapshot(env.DB)).payload).copy.ja['hero.note']).toBe('');
    expect((await readDraftSnapshot(env.DB)).draft_rev).toBe(2);
    expect((await jobs())[0].status).not.toBe('succeeded');
    if (mode === 'lease') expect((await jobs())[0].lease_token).toBe('successor-owner');
    expect(fetch).not.toHaveBeenCalled();
  });
});
