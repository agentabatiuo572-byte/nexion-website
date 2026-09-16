import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/index';
import type { Env } from '../src/env';

const token = 'local-ai-tick-test-token-with-more-than-32-characters';
const local: Env = { ...env, ENVIRONMENT: 'dev', AI_TICK_TOKEN: token, AI_CREDENTIAL_ENCRYPTION_KEY: undefined, AI_ALLOWED_MODELS: undefined };
const headers = { authorization: `Bearer ${token}` };
beforeEach(async () => {
  await env.DB.prepare('UPDATE ai_connection SET root_initialized=0,key_ciphertext=NULL,key_iv=NULL,key_version=NULL,enabled=0 WHERE id=1').run();
});

describe('local translation supervisor boundary', () => {
  it('only the dedicated token authorizes the dev endpoint; production stays closed', async () => {
    for (const path of ['/api/internal/translations/bootstrap', '/api/internal/translations/tick']) {
      const method = path.endsWith('tick') ? 'POST' : 'GET';
      expect((await app.request(path, { method }, local)).status).toBe(401);
      expect((await app.request(path, { method, headers: { authorization: `Bearer ${local.PUBLISH_RUNNER_TOKEN}` } }, local)).status).toBe(401);
      expect((await app.request(path, { method, headers }, { ...local, ENVIRONMENT: 'production' })).status).toBe(404);
      expect((await app.request(path, { method, headers }, { ...local, AI_TICK_TOKEN: '' })).status).toBe(401);
    }
  });

  it('bootstrap returns only three booleans and never creates or repairs secrets', async () => {
    const before = await env.DB.prepare('SELECT * FROM ai_connection WHERE id=1').first();
    const read = async (bindings: Env) => (await app.request('/api/internal/translations/bootstrap', { headers }, bindings)).json();
    expect(await read(local)).toEqual({ initialized: false, hasCredential: false, encryptionReady: false });
    expect(await env.DB.prepare('SELECT * FROM ai_connection WHERE id=1').first()).toEqual(before);
    expect(await read({ ...local, AI_CREDENTIAL_ENCRYPTION_KEY: btoa('a'.repeat(32)) })).toEqual({ initialized: false, hasCredential: false, encryptionReady: true });
    await env.DB.prepare("UPDATE ai_connection SET root_initialized=1,key_ciphertext='unreadable',key_iv='unreadable',key_version=1 WHERE id=1").run();
    expect(await read(local)).toEqual({ initialized: true, hasCredential: true, encryptionReady: false });
  });

  it('rejects a tick request carrying commands or content', async () => {
    const request = await app.request('/api/internal/translations/tick', { method: 'POST', headers, body: '{}' }, local);
    expect(request.status).toBe(400);
    expect(await request.json()).toEqual({ error: 'empty-body-required' });
  });

  it('a disabled AI tick returns without making a paid request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected-paid-call'));
    try {
      expect((await app.request('/api/internal/translations/tick', { method: 'POST', headers }, local)).status).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  });
});
