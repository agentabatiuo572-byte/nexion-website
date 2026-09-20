import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { aiRoutes } from '../src/ai-routes';
import { ensureInit } from '../src/config';
import { AI_PROVIDERS, type AiProvider } from '../src/ai-client';
import {
  aiLeaseGuardSql, aiLeaseGuardValues, claimAiCall, decryptApiKey, encryptApiKey, finishAiCall,
  getAiConnection, getAiConnectionState, markAiCallSent, recoverAiCall, type AiEnv, type AiCallLease,
} from '../src/ai-connection';

const KEY = 'synthetic-zen-key-that-must-never-escape';
const ROOT = btoa(String.fromCharCode(...new Uint8Array(32).fill(17)));
const local = () => ({ ...env, AI_CREDENTIAL_ENCRYPTION_KEY: ROOT }) as AiEnv;
const app = new Hono<{ Bindings: AiEnv }>().route('/api/ai', aiRoutes);
const request = (path: string, method = 'GET', body?: unknown, bindings = local(), extra: Record<string, string> = {}) =>
  app.request('http://localhost/api/ai' + path, { method,
    headers: { cookie: 'nx_sid=ai-test-session', origin: 'http://localhost', 'content-type': 'application/json', ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, bindings);
const successful = () => Response.json({
  id: 'resp-test', status: 'completed', error: null, incomplete_details: null,
  output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text',
    text: JSON.stringify({ translations: [{ id: 'connection-test', text: 'Welcome to Uvel.' }] }) }] }],
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
});
const saveBody = (rev = 0, seq = 0, op = 'operation-0001') => ({
  provider: 'zen', model: 'gpt-5.4-mini', apiKey: KEY, expectedCredentialRev: rev, expectedOperationSeq: seq, operationId: op,
});
const GEMINI_KEY = 'AQ.synthetic-gemini-key-that-must-never-escape';
const geminiBody = (rev = 0, seq = 0, op = 'gemini-operation') => ({ ...saveBody(rev, seq, op),
  provider: 'gemini', model: AI_PROVIDERS.gemini.defaultModel, apiKey: GEMINI_KEY });
const geminiSuccess = (id = 'connection-test', text = 'Welcome to Uvel.') => Response.json({
  id: 'chatcmpl-test', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant',
    content: JSON.stringify({ translations: [{ id, text }] }) } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});
const providers = Object.keys(AI_PROVIDERS) as AiProvider[];
const migrationStatements = (name: string) => {
  const migration = env.TEST_MIGRATIONS.find(item => item.name === name);
  if (!migration) throw new Error('Missing migration: ' + name);
  return migration.queries.map(sql => env.DB.prepare(sql));
};
const mainstreamMigration = () => migrationStatements('0020_ai_mainstream_providers.sql');
const nvidiaMigration = () => migrationStatements('0022_ai_nvidia_provider.sql');
const restore0019 = () => env.DB.batch([env.DB.prepare('DROP TABLE ai_connection'),
  ...migrationStatements('0018_ai_connection.sql'), ...migrationStatements('0019_ai_providers.sql')]);
const restore0020 = () => env.DB.batch([env.DB.prepare('DROP TABLE ai_connection'),
  ...migrationStatements('0018_ai_connection.sql'), ...migrationStatements('0019_ai_providers.sql'), ...mainstreamMigration()]);
const providerSuccess = (provider: AiProvider, id = 'connection-test', text = 'Welcome to Uvel.') => {
  const content = JSON.stringify({ translations: [{ id, text }] });
  if (AI_PROVIDERS[provider].protocol === 'responses' && provider !== 'zen') return Response.json({ status: 'completed', error: null, incomplete_details: null,
    output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: content }] }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } });
  if (AI_PROVIDERS[provider].protocol === 'messages') return Response.json({ type: 'message', role: 'assistant', stop_reason: 'end_turn',
    content: [{ type: 'text', text: content }], usage: { input_tokens: 10, output_tokens: 5 } });
  return geminiSuccess(id, text);
};
async function configured(enabled = true) {
  const encrypted = await encryptApiKey(local(), KEY);
  await env.DB.prepare('UPDATE ai_connection SET key_ciphertext=?,key_iv=?,key_version=?,root_initialized=1,credential_rev=1,enabled=?,connection_status=? WHERE id=1')
    .bind(encrypted.ciphertext, encrypted.iv, encrypted.version, Number(enabled), 'available').run();
}
async function lease(): Promise<AiCallLease> {
  const claim = await claimAiCall(local(), { purpose: 'translation', characters: 20, expectedCredentialRev: 1 });
  expect(claim.status).toBe('claimed');
  if (claim.status !== 'claimed') throw new Error('Expected claim');
  return claim.lease;
}
beforeEach(async () => {
  vi.restoreAllMocks();
  // Migration tests deliberately rebuild older schemas; subsequent tests start on the latest one.
  const schema = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ai_connection'").first<{ sql: string }>();
  if (schema && !schema.sql.includes("'openrouter'")) await env.DB.batch(mainstreamMigration());
  const current = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ai_connection'").first<{ sql: string }>();
  if (current && !current.sql.includes("'nvidia'")) await env.DB.batch(nvidiaMigration());
  // Workerd storage is shared within the file; reset only this suite's isolated database state.
  await env.DB.prepare('DELETE FROM ai_connection').run();
  await env.DB.prepare('INSERT INTO ai_connection(id) VALUES(1)').run();
  await env.DB.prepare('DELETE FROM audit').run();
  await env.DB.prepare('DELETE FROM sessions').run();
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('ai-test-session')))].map(b => b.toString(16).padStart(2, '0')).join('');
  await env.DB.prepare('INSERT INTO sessions(token_hash,created_at,expires_at) VALUES(?,?,?)').bind(digest, Date.now(), Date.now() + 3600000).run();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => successful());
});
afterEach(() => vi.restoreAllMocks());

describe('provider migration and Gemini credentials', () => {
  it('0019 preserves every legacy column, active lease and old Zen AES-GCM ciphertext', async () => {
    const legacy = env.TEST_MIGRATIONS.find(m => m.name === '0018_ai_connection.sql')!;
    const migration = env.TEST_MIGRATIONS.find(m => m.name === '0019_ai_providers.sql')!;
    expect(legacy).toBeTruthy(); expect(migration).toBeTruthy();
    await env.DB.batch([env.DB.prepare('DROP TABLE ai_connection'), ...legacy.queries.map(sql => env.DB.prepare(sql))]);
    const iv = new Uint8Array(12).fill(5);
    const key = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(17), 'AES-GCM', false, ['encrypt']);
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128,
      additionalData: new TextEncoder().encode('nexgrid-ai-connection:1:zen:v1:' + local().ENVIRONMENT) }, key, new TextEncoder().encode(KEY));
    const cipher = btoa(String.fromCharCode(...new Uint8Array(encrypted)));
    const columns = (await env.DB.prepare('PRAGMA table_info(ai_connection)').all<{name: string; type: string}>()).results;
    const names = columns.map(c => c.name).filter(n => !['id','provider','enabled'].includes(n));
    const base = await getAiConnection(env.DB);
    const values = names.map((name, i) => name === 'key_ciphertext' ? cipher : name === 'key_iv' ? btoa(String.fromCharCode(...iv)) : name === 'key_version' ? 1 :
      name === 'call_lease_until' ? Date.now() + 90_000 : name === 'model' ? 'gpt-5.4-nano' :
      columns.find(c => c.name === name)!.type === 'INTEGER' ? i + 23 : 'legacy-' + name);
    await env.DB.prepare('UPDATE ai_connection SET enabled=1,' + names.map(n => n + '=?').join(',') + ' WHERE id=1').bind(...values).run();
    const before = await getAiConnection(env.DB);
    expect(Object.keys(before)).toEqual(Object.keys(base));
    await env.DB.batch(migration.queries.map(sql => env.DB.prepare(sql)));
    const after = await getAiConnection(env.DB);
    expect(after).toEqual(before);
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM ai_connection').first())).toEqual({ count: 1 });
    expect(await decryptApiKey(local(), after)).toBe(KEY);
    expect(await getAiConnectionState(local())).toMatchObject({ busy: true });
    expect(await claimAiCall(local(), { purpose: 'preview', characters: 1, expectedCredentialRev: after.credential_rev }))
      .toMatchObject({ status: 'rejected', error: 'busy' });
    expect(await getAiConnection(env.DB)).toEqual(before);
    await expect(env.DB.prepare("UPDATE ai_connection SET provider='unknown'").run()).rejects.toThrow();
    await env.DB.prepare("UPDATE ai_connection SET provider='gemini'").run();
    await expect(decryptApiKey(local(), await getAiConnection(env.DB))).rejects.toMatchObject({ code: 'decryption-failed' });
  });
  it('reports every registry provider with per-provider environment allowlists', async () => {
    const selected = ['gpt-5.4-nano', 'gemini-3.1-flash-lite', 'unknown'];
    const state = await getAiConnectionState({ ...local(), AI_ALLOWED_MODELS: selected.join(',') });
    expect(state).toMatchObject({ provider: 'zen', model: 'gpt-5.4-mini', allowedModels: ['gpt-5.4-nano'], status: 'model-unavailable',
      providers: providers.map(id => ({ id, name: AI_PROVIDERS[id].name, defaultModel: AI_PROVIDERS[id].defaultModel,
        allowedModels: selected.filter(model => (AI_PROVIDERS[id].allowedModels as readonly string[]).includes(model)) })) });
    expect((await request('/connection', 'PUT', geminiBody(), { ...local(), AI_ALLOWED_MODELS: 'gpt-5.4-mini' })).status).toBe(422);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects mismatched models and missing-provider Gemini candidates without a paid call', async () => {
    const noProvider = { ...geminiBody(), provider: undefined };
    for (const input of [{ ...geminiBody(), model: 'gpt-5.4-mini' }, { ...saveBody(), model: AI_PROVIDERS.gemini.defaultModel }, noProvider]) {
      expect((await request('/connection', 'PUT', input)).status).toBe(422);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(await getAiConnection(env.DB)).toMatchObject({ provider: 'zen', credential_rev: 0, call_count: 0 });
    expect((await request('/connection', 'PUT', { ...saveBody(), provider: undefined })).status).toBe(200);
  });
  it('atomically switches Zen to Gemini after success, then current test and preview use Google', async () => {
    await configured(false);
    const old = await getAiConnection(env.DB);
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      expect(url).toBe(AI_PROVIDERS.gemini.endpoint);
      expect(init?.headers).toMatchObject({ authorization: 'Bearer ' + GEMINI_KEY });
      const beforeSave = await getAiConnection(env.DB);
      expect(beforeSave).toMatchObject({ provider: 'zen', model: 'gpt-5.4-mini', key_ciphertext: old.key_ciphertext });
      return geminiSuccess();
    });
    const response = await request('/connection', 'PUT', geminiBody(1));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ provider: 'gemini', model: AI_PROVIDERS.gemini.defaultModel,
      allowedModels: [...AI_PROVIDERS.gemini.allowedModels], ready: true, configured: true, enabled: false, credentialRev: 2 });
    const saved = await getAiConnection(env.DB);
    expect(saved.key_ciphertext).not.toBe(old.key_ciphertext);
    expect(await decryptApiKey(local(), saved)).toBe(GEMINI_KEY);
    await expect(decryptApiKey(local(), { ...saved, provider: 'zen' })).rejects.toMatchObject({ code: 'decryption-failed' });
    await env.DB.prepare('UPDATE ai_connection SET next_test_at=0').run();
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      expect(url).toBe(AI_PROVIDERS.gemini.endpoint);
      expect(init?.headers).toMatchObject({ authorization: 'Bearer ' + GEMINI_KEY });
      return geminiSuccess();
    });
    expect((await request('/connection/test', 'POST', { expectedCredentialRev: 2, expectedOperationSeq: 1, operationId: 'current-gemini-test' })).status).toBe(200);
    vi.mocked(fetch).mockResolvedValueOnce(geminiSuccess('preview', 'Scroll down to explore.'));
    expect(await (await request('/translate', 'POST', { source: '向下滚动以探索。', targetLocale: 'en' })).json()).toEqual({ text: 'Scroll down to explore.' });
    expect(vi.mocked(fetch).mock.calls[2][0]).toBe(AI_PROVIDERS.gemini.endpoint);
    expect(await getAiConnectionState(local())).toMatchObject({ provider: 'gemini', credentialRev: 2,
      usage: { calls: 3, inputTokens: 30, outputTokens: 15, unknownCalls: 0 } });
    const snapshot = JSON.stringify({ state: await getAiConnectionState(local()), audit: (await env.DB.prepare('SELECT * FROM audit').all()).results });
    expect(snapshot).not.toContain(GEMINI_KEY); expect(snapshot).not.toContain(saved.key_ciphertext!);
  });
  it('failed Gemini candidate or audit keeps the old provider, model and credential', async () => {
    await configured();
    const old = await getAiConnection(env.DB);
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: { code: 400, status: 'INVALID_ARGUMENT', message: GEMINI_KEY,
      details: [{ reason: 'API_KEY_INVALID' }] } }, { status: 400 }));
    const response = await request('/connection', 'PUT', geminiBody(1));
    expect(response.status).toBe(422); expect(await response.json()).toMatchObject({ error: 'invalid-key' });
    expect(await getAiConnection(env.DB)).toMatchObject({ provider: old.provider, model: old.model, key_ciphertext: old.key_ciphertext,
      credential_rev: old.credential_rev, connection_status: 'available', enabled: 1 });
    await env.DB.prepare('UPDATE ai_connection SET next_test_at=0').run();
    await env.DB.prepare("CREATE TRIGGER gemini_audit_fail BEFORE INSERT ON audit WHEN NEW.action='ai.connection.saved' BEGIN SELECT RAISE(ABORT,'private-gemini-error'); END").run();
    vi.mocked(fetch).mockResolvedValueOnce(geminiSuccess());
    try {
      const failed = await request('/connection', 'PUT', geminiBody(1, 1, 'gemini-audit-op'));
      expect(failed.status).toBe(422); expect(await failed.text()).not.toContain('private-gemini-error');
      expect(await getAiConnection(env.DB)).toMatchObject({ provider: old.provider, model: old.model, key_ciphertext: old.key_ciphertext, credential_rev: 1 });
    } finally { await env.DB.prepare('DROP TRIGGER gemini_audit_fail').run(); }
  });
  it('a saved Gemini key cannot route as Zen after the provider column is tampered with', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(geminiSuccess());
    expect((await request('/connection', 'PUT', geminiBody())).status).toBe(200);
    vi.mocked(fetch).mockClear();
    await env.DB.prepare("UPDATE ai_connection SET provider='zen',model='gpt-5.4-mini',next_test_at=0").run();
    const response = await request('/connection/test', 'POST', { expectedCredentialRev: 1, expectedOperationSeq: 1, operationId: 'tampered-provider' });
    expect(response.status).toBe(503); expect(fetch).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ error: 'decryption-failed' });
  });
});

describe('mainstream provider migration and registry routes', () => {
  it('0022 preserves the active connection while adding NVIDIA to the provider constraint', async () => {
    await restore0020(); await configured();
    const before = await getAiConnection(env.DB);
    await expect(env.DB.prepare("UPDATE ai_connection SET provider='nvidia' WHERE id=1").run()).rejects.toThrow();
    await env.DB.batch(nvidiaMigration());
    expect(await getAiConnection(env.DB)).toEqual(before);
    await env.DB.prepare("UPDATE ai_connection SET provider='nvidia',model=? WHERE id=1").bind(AI_PROVIDERS.nvidia.defaultModel).run();
    expect(await getAiConnection(env.DB)).toMatchObject({ provider: 'nvidia', model: AI_PROVIDERS.nvidia.defaultModel });
    await expect(env.DB.prepare("UPDATE ai_connection SET provider='unknown' WHERE id=1").run()).rejects.toThrow();
  });

  it.each(['zen', 'gemini'] as const)('0020 preserves all 35 old %s fields, constraints and ciphertext', async provider => {
    await restore0019();
    const iv = new Uint8Array(12).fill(7), bytes = new Uint8Array(32).fill(17);
    const key = await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt']);
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128,
      additionalData: new TextEncoder().encode('nexgrid-ai-connection:1:' + provider + ':v1:' + local().ENVIRONMENT) }, key, new TextEncoder().encode(KEY));
    const cipher = btoa(String.fromCharCode(...new Uint8Array(encrypted)));
    const columns = (await env.DB.prepare('PRAGMA table_info(ai_connection)').all<{ name: string; type: string }>()).results;
    expect(columns).toHaveLength(35);
    const names = columns.map(column => column.name).filter(name => !['id', 'provider', 'enabled'].includes(name));
    const values = names.map((name, index) => name === 'key_ciphertext' ? cipher : name === 'key_iv' ? btoa(String.fromCharCode(...iv)) : name === 'key_version' ? 1 :
      name === 'model' ? AI_PROVIDERS[provider].defaultModel : name === 'call_lease_until' ? Date.now() + 90000 :
      columns.find(column => column.name === name)!.type === 'INTEGER' ? index + 23 : 'legacy-' + name);
    await env.DB.prepare('UPDATE ai_connection SET provider=?,enabled=1,' + names.map(name => name + '=?').join(',') + ' WHERE id=1').bind(provider, ...values).run();
    const before = await getAiConnection(env.DB);
    await env.DB.batch(mainstreamMigration());
    expect(await getAiConnection(env.DB)).toEqual(before);
    expect((await env.DB.prepare('PRAGMA table_info(ai_connection)').all()).results).toEqual(columns);
    expect(await decryptApiKey(local(), await getAiConnection(env.DB))).toBe(KEY);
    expect(await getAiConnectionState(local())).toMatchObject({ busy: true });
    expect(await claimAiCall(local(), { purpose: 'preview', characters: 1, expectedCredentialRev: before.credential_rev })).toMatchObject({ status: 'rejected', error: 'busy' });
    expect((await env.DB.prepare("SELECT name FROM sqlite_master WHERE name='ai_connection_next'").all()).results).toEqual([]);
    for (const id of providers.filter(id => id !== 'nvidia')) await env.DB.prepare('UPDATE ai_connection SET provider=? WHERE id=1').bind(id).run();
    await expect(env.DB.prepare("UPDATE ai_connection SET provider='nvidia' WHERE id=1").run()).rejects.toThrow();
    await expect(env.DB.prepare("UPDATE ai_connection SET provider='unknown'").run()).rejects.toThrow();
    await expect(env.DB.prepare('UPDATE ai_connection SET enabled=2').run()).rejects.toThrow();
    await expect(env.DB.prepare('INSERT INTO ai_connection(id) VALUES(2)').run()).rejects.toThrow();
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM ai_connection').first()).toEqual({ count: 1 });
  });

  it.each(['zen', 'gemini'] as const)('0020 retains a live %s call owner and settles it once', async provider => {
    await restore0019();
    const encrypted = await encryptApiKey(local(), KEY, provider);
    await env.DB.prepare('UPDATE ai_connection SET provider=?,model=?,key_ciphertext=?,key_iv=?,key_version=?,root_initialized=1,credential_rev=4,settings_rev=7,execution_rev=9,enabled=1,connection_status=? WHERE id=1')
      .bind(provider, AI_PROVIDERS[provider].defaultModel, encrypted.ciphertext, encrypted.iv, encrypted.version, 'available').run();
    const claim = await claimAiCall(local(), { purpose: 'translation', characters: 20, expectedCredentialRev: 4, expectedExecutionRev: 9 });
    expect(claim.status).toBe('claimed');
    if (claim.status !== 'claimed') throw new Error('Expected migration lease');
    expect(await markAiCallSent(local(), claim.lease)).toBe(true);
    const before = await getAiConnection(env.DB);
    await env.DB.batch(mainstreamMigration());
    expect(await getAiConnection(env.DB)).toEqual(before);
    expect(await claimAiCall(local(), { purpose: 'preview', characters: 1, expectedCredentialRev: 4 })).toMatchObject({ status: 'rejected', error: 'busy' });
    const outcome = { usage: { inputTokens: 7, outputTokens: 8, totalTokens: 15 } };
    expect(await finishAiCall(local(), claim.lease, outcome)).toBe(true);
    expect(await finishAiCall(local(), claim.lease, outcome)).toBe(false);
    expect(await getAiConnection(env.DB)).toMatchObject({ provider, credential_rev: 4, settings_rev: 7, execution_rev: 9,
      call_lease_token: null, call_count: 1, sent_characters: 20, input_tokens: 7, output_tokens: 8, unknown_usage_count: 0 });
  });

  it('0020 failure after replacing the table restores the original schema and row', async () => {
    await restore0019(); await configured();
    const before = await getAiConnection(env.DB);
    const schema = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE name='ai_connection'").first();
    await expect(env.DB.batch([...mainstreamMigration(), env.DB.prepare('INSERT INTO ai_connection(id) VALUES(1)')])).rejects.toThrow();
    expect(await getAiConnection(env.DB)).toEqual(before);
    expect(await env.DB.prepare("SELECT sql FROM sqlite_master WHERE name='ai_connection'").first()).toEqual(schema);
    expect((await env.DB.prepare("SELECT name FROM sqlite_master WHERE name='ai_connection_next'").all()).results).toEqual([]);
  });

  it.each(providers)('%s saves the registry model/key atomically, then previews with the saved provider', async provider => {
    await configured(false);
    const before = await getAiConnection(env.DB), spec = AI_PROVIDERS[provider];
    const endpoint = provider === 'zen' ? 'https://opencode.ai/zen/v1/chat/completions' : spec.endpoint;
    vi.mocked(fetch).mockImplementationOnce(async (url, init) => {
      expect(url).toBe(endpoint);
      expect(String(init?.body)).toContain('Uvel');
      expect(String(init?.body)).not.toContain('NexGrid');
      expect(await getAiConnection(env.DB)).toMatchObject({ provider: before.provider, model: before.model, key_ciphertext: before.key_ciphertext, credential_rev: before.credential_rev });
      return providerSuccess(provider);
    });
    const response = await request('/connection', 'PUT', { ...saveBody(1), provider, model: spec.defaultModel });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ provider, model: spec.defaultModel, ready: true, configured: true, enabled: false, credentialRev: 2 });
    const saved = await getAiConnection(env.DB);
    expect(await decryptApiKey(local(), saved)).toBe(KEY);
    for (const other of providers.filter(id => id !== provider)) await expect(decryptApiKey(local(), { ...saved, provider: other })).rejects.toMatchObject({ code: 'decryption-failed' });
    vi.mocked(fetch).mockImplementationOnce(async url => { expect(url).toBe(endpoint); return providerSuccess(provider, 'preview', 'Scroll down to explore.'); });
    expect(await (await request('/translate', 'POST', { source: '向下滚动以探索。', targetLocale: 'en' })).json()).toEqual({ text: 'Scroll down to explore.' });
    expect(await getAiConnection(env.DB)).toMatchObject({ provider, credential_rev: 2, call_count: 2, input_tokens: 20, output_tokens: 10, unknown_usage_count: 0 });
  });

  it.each(providers)('%s failed candidate and failed audit preserve the active provider/model/key', async provider => {
    await configured();
    const before = await getAiConnection(env.DB);
    const candidate = { ...saveBody(1), provider, model: AI_PROVIDERS[provider].defaultModel };
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: { message: KEY } }, { status: 401 }));
    const rejected = await request('/connection', 'PUT', candidate);
    expect(rejected.status).toBe(422); expect(await rejected.text()).not.toContain(KEY);
    expect(await getAiConnection(env.DB)).toMatchObject({ provider: before.provider, model: before.model, key_ciphertext: before.key_ciphertext,
      credential_rev: before.credential_rev, connection_status: before.connection_status, enabled: before.enabled });
    await env.DB.prepare('UPDATE ai_connection SET next_test_at=0').run();
    await env.DB.prepare("CREATE TRIGGER provider_save_audit_fail BEFORE INSERT ON audit WHEN NEW.action='ai.connection.saved' BEGIN SELECT RAISE(ABORT,'synthetic-audit-failure'); END").run();
    vi.mocked(fetch).mockResolvedValueOnce(providerSuccess(provider));
    try {
      const rejectedSave = await request('/connection', 'PUT', { ...candidate, expectedOperationSeq: 1, operationId: 'provider-audit-retry' });
      expect(rejectedSave.status).toBe(422);
      expect(await rejectedSave.text()).not.toContain('synthetic-audit-failure');
      expect(await getAiConnection(env.DB)).toMatchObject({ provider: before.provider, model: before.model, key_ciphertext: before.key_ciphertext,
        credential_rev: before.credential_rev, connection_status: before.connection_status, enabled: before.enabled });
      expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM audit WHERE action='ai.connection.saved'").first()).toEqual({ count: 0 });
    } finally { await env.DB.prepare('DROP TRIGGER provider_save_audit_fail').run(); }
  });

  it.each(providers)('%s rejects a candidate outside its model allowlist without a request', async provider => {
    expect((await request('/connection', 'PUT', { ...saveBody(), provider, model: 'not-an-allowed-model' })).status).toBe(422);
    expect((await request('/connection', 'PUT', { ...saveBody(), provider, model: AI_PROVIDERS[provider].defaultModel }, { ...local(), AI_ALLOWED_MODELS: 'disabled-all-models' })).status).toBe(422);
    expect(fetch).not.toHaveBeenCalled(); expect(await getAiConnection(env.DB)).toMatchObject({ credential_rev: 0, call_count: 0 });
  });

  it.each(['unknown', '__proto__', 'constructor', '', null, 1])('rejects invalid provider %s before any external call', async provider => {
    expect((await request('/connection', 'PUT', { ...saveBody(), provider })).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('inline translation suggestions', () => {
  const suggestion = (text = 'Scroll down to explore.') => Response.json({ status: 'completed',
    output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text',
      text: JSON.stringify({ translations: [{ id: 'preview', text }] }) }] }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } });
  const input = { source: '向下滚动以探索。', targetLocale: 'en' };
  it.each([['vi', 'Cuộn xuống để khám phá.'], ['es', 'Desplázate hacia abajo para explorar.'],
    ['pt', 'Role para baixo para explorar.'], ['fr', 'Faites défiler pour découvrir.'],
    ['de', 'Zum Entdecken nach unten scrollen.'], ['ja', '下にスクロールして探索。'],
    ['ko', '아래로 스크롤하여 둘러보세요.'], ['en', 'Scroll down to explore.']])
  ('returns editable %s text with automatic translation off, without writing draft or jobs', async (targetLocale, text) => {
    await configured(false); await ensureInit(env.DB);
    const snapshot = async () => Promise.all(['config_draft', 'translation_state', 'translation_jobs', 'audit']
      .map(async table => (await env.DB.prepare('SELECT * FROM ' + table).all()).results));
    const before = await snapshot();
    vi.mocked(fetch).mockResolvedValueOnce(suggestion(text));
    const response = await request('/translate', 'POST', { ...input, targetLocale });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ text });
    expect(await snapshot()).toEqual(before);
    expect(await getAiConnectionState(local())).toMatchObject({ enabled: false,
      operationSeq: 0, usage: { calls: 1, inputTokens: 10, outputTokens: 5, unknownCalls: 0 } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('validates authentication, origin, input and quota before sending', async () => {
    await configured(false);
    expect((await request('/translate', 'POST', input, local(), { cookie: '' })).status).toBe(401);
    expect((await request('/translate', 'POST', input, local(), { origin: 'https://attacker.example' })).status).toBe(403);
    expect((await request('/translate', 'POST', { ...input, targetLocale: 'zh' })).status).toBe(400);
    expect((await request('/translate', 'POST', { ...input, source: 'a'.repeat(3001) })).status).toBe(422);
    await env.DB.prepare('UPDATE ai_connection SET daily_character_limit=1').run();
    expect((await request('/translate', 'POST', input)).status).toBe(429);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('discards a late suggestion after the connection changes', async () => {
    await configured(false);
    vi.mocked(fetch).mockImplementationOnce(async () => {
      await env.DB.prepare('UPDATE ai_connection SET credential_rev=credential_rev+1,execution_rev=execution_rev+1').run();
      return suggestion();
    });
    const response = await request('/translate', 'POST', input);
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: 'cancelled' });
    expect((await getAiConnection(env.DB)).call_lease_token).toBeNull();
  });
  it('does not retry or disclose provider details when a request fails', async () => {
    await configured(false);
    vi.mocked(fetch).mockRejectedValueOnce(new Error('provider echoed ' + KEY));
    const response = await request('/translate', 'POST', input);
    expect(response.status).toBe(422); expect(await response.text()).not.toContain(KEY);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await getAiConnectionState(local())).toMatchObject({ enabled: false,
      usage: { calls: 1, unknownCalls: 1 }, busy: false });
  });
});

describe('encrypted AI credentials and administrator routes', () => {
  it.each(['http://localhost:4399','http://127.0.0.1:4399'])('built-origin %s is allowed for the development AI routes', async origin => {
    expect((await request('/settings', 'PATCH', { expectedSettingsRev: 0, enabled: false }, local(), { origin })).status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['http://localhost:4398','http://127.0.0.1:4444','https://attacker.example'])('AI origin guard rejects unlisted origin %s', async origin => {
    expect((await request('/settings', 'PATCH', { expectedSettingsRev: 0, enabled: false }, local(), { origin })).status).toBe(403);
  });
  it('AI production requests accept only their own origin and require JSON for changes', async () => {
    expect((await request('/settings', 'PATCH', { expectedSettingsRev: 0, enabled: false }, { ...local(), ENVIRONMENT: 'production' }, { origin: 'http://localhost:4399' })).status).toBe(403);
    expect((await request('/settings', 'PATCH', { expectedSettingsRev: 0, enabled: false }, local(), { 'content-type': 'text/plain' })).status).toBe(415);
  });
  it('scan failure preserves successful enablement and explicit same-value enable retries the scan', async () => {
    await configured(false); await ensureInit(env.DB);
    await env.DB.prepare('DELETE FROM translation_jobs').run();
    await env.DB.prepare('DELETE FROM translation_state').run();
    const draft = await env.DB.prepare('SELECT payload FROM config_draft WHERE id=1').first<{payload: string}>();
    const config = JSON.parse(draft!.payload);
    config.copy.zh['hero.note'] = 'A new phrase for scanning.'; config.copy.ja['hero.note'] = '';
    await env.DB.prepare('UPDATE config_draft SET payload=?').bind(JSON.stringify(config)).run();
    await env.DB.prepare("CREATE TRIGGER ai_scan_failure BEFORE INSERT ON audit WHEN NEW.reason='translation.enqueue' BEGIN SELECT RAISE(ABORT,'synthetic-scan-detail'); END").run();
    try {
      const first = await request('/settings', 'PATCH', { expectedSettingsRev: 0, enabled: true });
      expect(first.status).toBe(200);
      expect(await first.json()).toMatchObject({ enabled: true, settingsRev: 1, scanStatus: 'retry' });
    } finally { await env.DB.prepare('DROP TRIGGER ai_scan_failure').run(); }
    expect(await (await request('/settings', 'PATCH', { expectedSettingsRev: 1, enabled: true })).json())
      .toMatchObject({ enabled: true, settingsRev: 1, scanStatus: 'queued' });
    expect(await env.DB.prepare("SELECT status FROM translation_jobs WHERE field_id='/copy/hero.note' AND target_locale='ja'").first()).toEqual({ status: 'pending' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('GET is read-only, masked and unavailable until tested; bearer is not admin authority', async () => {
    const before = await getAiConnection(env.DB);
    const response = await request('/connection');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ configured: false, enabled: false, ready: false, provider: 'zen' });
    expect(await getAiConnection(env.DB)).toEqual(before);
    expect((await request('/connection', 'GET', undefined, local(), { cookie: '', authorization: 'Bearer machine-token' })).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('AES-GCM uses random IVs, authenticated environment and no plaintext storage', async () => {
    const one = await encryptApiKey(local(), KEY), two = await encryptApiKey(local(), KEY);
    expect(one.iv).not.toBe(two.iv);
    const row = { ...(await getAiConnection(env.DB)), key_ciphertext: one.ciphertext, key_iv: one.iv, key_version: one.version };
    expect(await decryptApiKey(local(), row)).toBe(KEY);
    expect(JSON.stringify(row)).not.toContain(KEY);
    await expect(decryptApiKey({ ...local(), ENVIRONMENT: 'production' }, row)).rejects.toMatchObject({ code: 'decryption-failed' });
    await expect(decryptApiKey(local(), { ...row, key_ciphertext: one.ciphertext.slice(0, -4) + 'AAAA' })).rejects.toMatchObject({ code: 'decryption-failed' });
  });
  it('tests then saves ciphertext and readiness, preserving the off switch and budget', async () => {
    const response = await request('/connection', 'PUT', saveBody());
    expect(response.status).toBe(200);
    const view = await response.json();
    expect(view).toMatchObject({ configured: true, ready: true, enabled: false, credentialRev: 1, operationSeq: 1, operationStatus: 'succeeded',
      usage: { calls: 1, inputTokens: 10, outputTokens: 5, unknownCalls: 0 } });
    const row = await getAiConnection(env.DB);
    expect(row.root_initialized).toBe(1);
    expect(await decryptApiKey(local(), row)).toBe(KEY);
    expect(JSON.stringify(view)).not.toContain(KEY);
    expect(JSON.stringify(view)).not.toContain(row.key_ciphertext!);
    expect(JSON.stringify(await env.DB.prepare('SELECT * FROM audit').all())).not.toContain(KEY);
    expect(row.call_lease_token).toBeNull();
    expect((await request('/connection')).headers.get('cache-control')).toBe('no-store');
  });
  it('saves an explicitly submitted candidate when its model is unavailable, but keeps it disabled', async () => {
    await configured();
    vi.mocked(fetch).mockResolvedValue(Response.json({ error: {
      type: 'server_error', message: 'Error from provider: Model is unavailable. synthetic detail',
    } }, { status: 400 }));
    const response = await request('/connection', 'PUT', { ...saveBody(1), model: AI_PROVIDERS.zen.defaultModel });
    expect(response.status).toBe(200);
    const view = await response.json();
    expect(view).toMatchObject({ saved: true, configured: true, provider: 'zen',
      model: AI_PROVIDERS.zen.defaultModel, status: 'model-unavailable', ready: false, enabled: false,
      credentialRev: 2, settingsRev: 1, executionRev: 1, operationSeq: 1, operationStatus: 'succeeded',
      usage: { calls: 1, unknownCalls: 1 } });
    const row = await getAiConnection(env.DB);
    expect(row).toMatchObject({ provider: 'zen', model: AI_PROVIDERS.zen.defaultModel,
      credential_rev: 2, settings_rev: 1, execution_rev: 1, connection_status: 'model-unavailable',
      enabled: 0, operation_status: 'succeeded', operation_error: null, call_lease_token: null,
      call_count: 1, unknown_usage_count: 1 });
    expect(await decryptApiKey(local(), row)).toBe(KEY);
    expect(JSON.stringify(view)).not.toContain(KEY);
    expect(JSON.stringify(await env.DB.prepare('SELECT * FROM audit').all())).not.toContain(KEY);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM audit WHERE action='ai.connection.saved'").first()).toEqual({ count: 1 });
    expect(await env.DB.prepare("SELECT after_summary FROM audit WHERE action='ai.connection.saved'").first())
      .toMatchObject({ after_summary: expect.stringContaining('status model-unavailable') });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM audit WHERE action='ai.connection.tested'").first()).toEqual({ count: 0 });
    expect(await (await request('/connection', 'PUT', { ...saveBody(1), model: AI_PROVIDERS.zen.defaultModel })).json())
      .toMatchObject({ duplicate: true, saved: true, status: 'model-unavailable', ready: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not save an unavailable-model candidate from another provider', async () => {
    await configured();
    const before = await getAiConnection(env.DB);
    vi.mocked(fetch).mockResolvedValue(Response.json({ error: {
      code: 404, status: 'NOT_FOUND', message: 'synthetic unavailable model',
    } }, { status: 404 }));
    const response = await request('/connection', 'PUT', geminiBody(1));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: 'model-unavailable' });
    const after = await getAiConnection(env.DB);
    expect(after).toMatchObject({ provider: before.provider, model: before.model,
      key_ciphertext: before.key_ciphertext, key_iv: before.key_iv, key_version: before.key_version,
      credential_rev: before.credential_rev, connection_status: before.connection_status, enabled: before.enabled });
    expect(await decryptApiKey(local(), after)).toBe(KEY);
  });
  it('does not half-commit a degraded save through a second tested-audit transaction', async () => {
    await configured();
    await env.DB.prepare("CREATE TRIGGER ai_fail_degraded_test_audit BEFORE INSERT ON audit WHEN NEW.action='ai.connection.tested' BEGIN SELECT RAISE(ABORT, 'synthetic-private-error'); END").run();
    vi.mocked(fetch).mockResolvedValue(Response.json({ error: {
      type: 'server_error', message: 'Error from provider: Model is unavailable. synthetic detail',
    } }, { status: 400 }));
    try {
      const response = await request('/connection', 'PUT', { ...saveBody(1), model: AI_PROVIDERS.zen.defaultModel });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ saved: true, status: 'model-unavailable', ready: false, enabled: false });
      expect(await getAiConnection(env.DB)).toMatchObject({ provider: 'zen', connection_status: 'model-unavailable',
        credential_rev: 2, operation_status: 'succeeded', call_lease_token: null });
    } finally { await env.DB.prepare('DROP TRIGGER ai_fail_degraded_test_audit').run(); }
  });
  it('requires origin and rejects arbitrary providers/models before a paid call', async () => {
    expect((await request('/connection', 'PUT', saveBody(), local(), { origin: 'https://attacker.example' })).status).toBe(403);
    expect((await request('/connection', 'PUT', { ...saveBody(), provider: 'unlisted-provider' })).status).toBe(400);
    expect((await request('/connection', 'PUT', { ...saveBody(), model: 'arbitrary-model' })).status).toBe(422);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('missing root rejects before provider request, while explicit removal remains possible', async () => {
    await configured();
    const without = { ...local(), AI_CREDENTIAL_ENCRYPTION_KEY: undefined };
    expect((await request('/connection', 'PUT', saveBody(1), without)).status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
    expect((await request('/connection', 'DELETE', { expectedCredentialRev: 1 }, without)).status).toBe(200);
    expect(await getAiConnection(env.DB)).toMatchObject({ key_ciphertext: null, credential_rev: 2, root_initialized: 1 });
  });
  it.each([
    ['invalid-key', () => Response.json({ error: { message: 'synthetic invalid key' } }, { status: 401 })],
    ['permission-denied', () => Response.json({ error: { message: 'synthetic permission denial' } }, { status: 403 })],
    ['billing-required', () => Response.json({ error: { type: 'CreditsError', message: 'No payment method configured' } }, { status: 401 })],
    ['provider-rejected', () => new Response(null, { status: 307, headers: { location: 'https://untrusted.example/' } })],
  ] as const)('candidate %s failure preserves the active connection and returns a business error', async (error, providerResponse) => {
    await configured();
    const before = await getAiConnection(env.DB);
    vi.mocked(fetch).mockResolvedValue(providerResponse());
    const response = await request('/connection', 'PUT', { ...saveBody(1),
      model: AI_PROVIDERS.zen.defaultModel, apiKey: GEMINI_KEY });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error });
    const after = await getAiConnection(env.DB);
    expect(after).toMatchObject({ provider: before.provider, model: before.model,
      key_ciphertext: before.key_ciphertext, key_iv: before.key_iv, key_version: before.key_version,
      credential_rev: 1, connection_status: 'available', enabled: 1, operation_status: 'failed', operation_error: error });
    expect(await decryptApiKey(local(), after)).toBe(KEY);
    expect((await getAiConnectionState(local())).ready).toBe(true);
  });
  it('duplicate in-flight and completed operation IDs do not repeat the paid request', async () => {
    let release!: () => void;
    let entered!: () => void;
    const arrived = new Promise<void>(resolve => { entered = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(fetch).mockImplementation(async () => { entered(); await hold; return successful(); });
    const first = request('/connection', 'PUT', saveBody());
    await arrived;
    const duplicate = await request('/connection', 'PUT', saveBody());
    expect(await duplicate.json()).toMatchObject({ duplicate: true, operationStatus: 'running' });
    release();
    expect((await first).status).toBe(200);
    expect(await (await request('/connection', 'PUT', saveBody())).json()).toMatchObject({ duplicate: true, saved: true, operationStatus: 'succeeded' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('a later limit edit is preserved when a candidate test completes', async () => {
    let release!: () => void, entered!: () => void;
    const arrived = new Promise<void>(resolve => { entered = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(fetch).mockImplementation(async () => { entered(); await hold; return successful(); });
    const pending = request('/connection', 'PUT', saveBody());
    await arrived;
    expect((await request('/settings', 'PATCH', { expectedSettingsRev: 0, dailyCharacterLimit: 1500 })).status).toBe(200);
    release();
    expect((await pending).status).toBe(200);
    expect(await getAiConnection(env.DB)).toMatchObject({ daily_character_limit: 1500, settings_rev: 1, enabled: 0, credential_rev: 1 });
  });
  it('removal invalidates a late save but keeps its lease until return and preserves counters', async () => {
    let release!: () => void, entered!: () => void;
    const arrived = new Promise<void>(resolve => { entered = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(fetch).mockImplementation(async () => { entered(); await hold; return successful(); });
    const pending = request('/connection', 'PUT', saveBody());
    await arrived;
    expect((await request('/connection', 'DELETE', { expectedCredentialRev: 0 })).status).toBe(200);
    const removed = await getAiConnection(env.DB);
    expect(removed.call_lease_token).toBeTruthy();
    expect(removed.call_count).toBe(1);
    release();
    expect((await pending).status).toBe(409);
    expect(await getAiConnection(env.DB)).toMatchObject({ key_ciphertext: null, credential_rev: 1, operation_seq: 2, enabled: 0, call_count: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('expired test is unknown; old operation cannot rerun after replacement', async () => {
    const claim = await claimAiCall(local(), { purpose: 'test-candidate', characters: 3, expectedCredentialRev: 0,
      expectedOperationSeq: 0, operationId: 'operation-0001', candidateKey: KEY, model: 'gpt-5.4-mini' });
    expect(claim.status).toBe('claimed');
    if (claim.status !== 'claimed') throw new Error();
    await markAiCallSent(local(), claim.lease);
    await recoverAiCall(env.DB, claim.lease.until + 1);
    expect(await getAiConnection(env.DB)).toMatchObject({ operation_status: 'unknown', call_count: 1, unknown_usage_count: 1 });
    expect((await request('/connection', 'PUT', saveBody())).status).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
    expect((await request('/connection', 'DELETE', { expectedCredentialRev: 0 })).status).toBe(200);
    expect((await request('/connection', 'PUT', saveBody())).status).toBe(409);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('a failed audit rolls back saving credentials but does not refund a sent request', async () => {
    await configured();
    const before = await getAiConnection(env.DB);
    await env.DB.prepare("CREATE TRIGGER ai_fail_save_audit BEFORE INSERT ON audit WHEN NEW.action='ai.connection.saved' BEGIN SELECT RAISE(ABORT, 'synthetic-private-error'); END").run();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await request('/connection', 'PUT', saveBody(1));
      expect(response.status).toBe(422);
      expect(await getAiConnection(env.DB)).toMatchObject({ key_ciphertext: before.key_ciphertext, credential_rev: 1, call_count: 1, connection_status: 'available' });
      expect(await response.text()).not.toContain('synthetic-private-error');
      expect(errors).not.toHaveBeenCalled();
    } finally { await env.DB.prepare('DROP TRIGGER ai_fail_save_audit').run(); }
  });
  it('a failed admission audit prevents the external request and rolls back its reservation', async () => {
    await env.DB.prepare("CREATE TRIGGER ai_fail_attempt_audit BEFORE INSERT ON audit WHEN NEW.action='ai.connection.attempt' BEGIN SELECT RAISE(ABORT, 'synthetic-private-error'); END").run();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await request('/connection', 'PUT', saveBody());
      expect(response.status).toBe(503);
      expect(await getAiConnection(env.DB)).toMatchObject({ credential_rev: 0, call_count: 0, operation_seq: 0, call_lease_token: null });
      expect(fetch).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
    } finally { await env.DB.prepare('DROP TRIGGER ai_fail_attempt_audit').run(); }
  });
  it('current-key failure pauses only that credential; connection tests have durable frequency limits', async () => {
    await configured();
    vi.mocked(fetch).mockResolvedValue(new Response('credential rejected', { status: 401 }));
    const response = await request('/connection/test', 'POST', { expectedCredentialRev: 1, expectedOperationSeq: 0, operationId: 'current-test-one' });
    expect(response.status).toBe(422);
    expect(await getAiConnection(env.DB)).toMatchObject({ credential_rev: 1, connection_status: 'invalid-key', execution_rev: 1, call_count: 1 });
    expect((await getAiConnectionState(local())).ready).toBe(false);
    expect((await request('/connection/test', 'POST', { expectedCredentialRev: 1, expectedOperationSeq: 1, operationId: 'current-test-two' })).status).toBe(429);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('clear ciphertext never resets the root-initialized marker or daily usage', async () => {
    await configured();
    const held = await lease();
    await markAiCallSent(local(), held);
    await finishAiCall(local(), held, {});
    expect((await request('/connection', 'DELETE', { expectedCredentialRev: 1 })).status).toBe(200);
    const removed = await getAiConnection(env.DB);
    expect(removed).toMatchObject({ root_initialized: 1, call_count: 1, sent_characters: 20, unknown_usage_count: 1, credential_rev: 2 });
    expect((await request('/connection', 'PUT', saveBody(2, removed.operation_seq, 'replacement-key'))).status).toBe(200);
    expect(await getAiConnection(env.DB)).toMatchObject({ credential_rev: 3, call_count: 2, unknown_usage_count: 1 });
  });
  it('rejects oversized JSON and ignores development origins on a production request', async () => {
    expect((await request('/connection', 'PUT', { ...saveBody(), apiKey: 'x'.repeat(9000) })).status).toBe(400);
    expect((await request('/connection', 'PUT', saveBody(), { ...local(), ENVIRONMENT: 'production' }, { origin: 'http://localhost:5175' })).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('one durable call lease, quota and execution guards', () => {
  it('concurrent reservations serialize across jobs and test calls', async () => {
    await configured();
    const outcomes = await Promise.all([lease(), claimAiCall(local(), {
      purpose: 'test-current', characters: 10, expectedCredentialRev: 1, expectedOperationSeq: 0, operationId: 'operation-test',
    })]);
    expect(outcomes[1]).toMatchObject({ status: 'rejected' });
    expect((await getAiConnection(env.DB)).call_count).toBe(1);
  });
  it('extra statements cannot mutate after losing the same atomic reservation', async () => {
    await configured();
    const held = await lease();
    const rejected = await claimAiCall(local(), { purpose: 'translation', characters: 20, expectedCredentialRev: 1 },
      owner => [env.DB.prepare('UPDATE ai_connection SET daily_character_limit=1000 WHERE ' + aiLeaseGuardSql()).bind(...aiLeaseGuardValues(owner))]);
    expect(rejected.status).toBe('rejected');
    expect((await getAiConnection(env.DB)).daily_character_limit).toBe(50000);
    expect(await finishAiCall(local(), held, {})).toBe(true);
    expect((await getAiConnection(env.DB)).call_count).toBe(0); // proven unsent
  });
  it('guards budget atomically and records known usage once per call, not per field', async () => {
    await configured();
    const day = new Date().toISOString().slice(0, 10);
    await env.DB.prepare('UPDATE ai_connection SET usage_day=?,sent_characters=49981 WHERE id=1').bind(day).run();
    expect(await claimAiCall(local(), { purpose: 'translation', characters: 20, expectedCredentialRev: 1 })).toMatchObject({ status: 'rejected', error: 'daily-limit' });
    await env.DB.prepare('UPDATE ai_connection SET sent_characters=49980 WHERE id=1').run();
    const held = await lease();
    expect(await markAiCallSent(local(), held)).toBe(true);
    expect(await markAiCallSent(local(), held)).toBe(false);
    expect(await finishAiCall(local(), held, { usage: { inputTokens: 7, outputTokens: 8, totalTokens: 15 } })).toBe(true);
    expect(await finishAiCall(local(), held, { usage: { inputTokens: 7, outputTokens: 8, totalTokens: 15 } })).toBe(false);
    expect(await getAiConnection(env.DB)).toMatchObject({ call_count: 1, sent_characters: 50000, input_tokens: 7, output_tokens: 8, unknown_usage_count: 0 });
  });
  it('disable/enable ABA invalidates old send tokens while retaining the active lease', async () => {
    await configured();
    const held = await lease();
    expect((await request('/settings', 'PATCH', { expectedSettingsRev: 0, enabled: false })).status).toBe(200);
    expect((await request('/settings', 'PATCH', { expectedSettingsRev: 1, enabled: true })).status).toBe(200);
    expect(await markAiCallSent(local(), held)).toBe(false);
    expect(await claimAiCall(local(), { purpose: 'translation', characters: 10, expectedCredentialRev: 1 })).toMatchObject({ status: 'rejected', error: 'busy' });
    await finishAiCall(local(), held, { error: 'invalid-key' });
    expect(await getAiConnection(env.DB)).toMatchObject({ connection_status: 'available', enabled: 1, execution_rev: 2, call_count: 0 });
  });
  it('late previous owner cannot release a new owner or replace current readiness', async () => {
    await configured();
    const old = await lease();
    await markAiCallSent(local(), old);
    await recoverAiCall(env.DB, old.until + 1);
    const next = await claimAiCall(local(), { purpose: 'translation', characters: 10, expectedCredentialRev: 1, now: old.until + 2 });
    if (next.status !== 'claimed') throw new Error('new lease missing');
    expect(await finishAiCall(local(), old, { error: 'invalid-key' })).toBe(false);
    expect((await getAiConnection(env.DB)).call_lease_token).toBe(next.lease.token);
    expect((await getAiConnection(env.DB)).unknown_usage_count).toBe(2);
  });
  it('a UTC rollover starts a new daily budget without resetting credential generations', async () => {
    await configured();
    await env.DB.prepare('UPDATE ai_connection SET usage_day=?,sent_characters=50000,call_count=999,input_tokens=100,output_tokens=200 WHERE id=1').bind('2020-01-01').run();
    const held = await lease();
    expect(await getAiConnection(env.DB)).toMatchObject({ sent_characters: 20, call_count: 1, input_tokens: 0, output_tokens: 0, credential_rev: 1 });
    await finishAiCall(local(), held, {});
    expect((await getAiConnection(env.DB)).sent_characters).toBe(0);
  });
});
