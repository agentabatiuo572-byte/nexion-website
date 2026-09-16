import { env } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import { app } from '../src/index';
import type { SiteConfig } from '../../schema/src/index.js';
import limits from '../../admin/src/lib/text-layout-limits.json';

type Overview = { draft: { payload: SiteConfig; draftRev: number }; live: { payload: SiteConfig } };

beforeEach(async () => {
  // cloudflare:test supplies the isolated migrated D1 database, never the local development DB.
  await env.DB.prepare('DELETE FROM publish_runner').run();
  await env.DB.prepare('DELETE FROM publish_dispatch').run();
  await env.DB.prepare('INSERT INTO publish_runner(runner_id,last_seen_at) VALUES(?1,?2)').bind('availability', Date.now()).run();
  for (const table of ['translation_jobs', 'translation_state', 'audit', 'sessions', 'login_throttle', 'auth_account', 'config_versions', 'config_draft', 'publish_lock', 'publish_steps']) {
    await env.DB.prepare('DELETE FROM ' + table).run();
  }
});

it('persists over-advisory copy and accepts its immutable publication snapshot while retaining the announcement hard limit', async () => {
  const password = 'copy-advisory-test-password!';
  const authHeaders = { 'cf-connecting-ip': '203.0.113.91', 'content-type': 'application/json' };
  expect((await app.request('/api/auth/setup', { method: 'POST', headers: authHeaders, body: JSON.stringify({ token: env.SETUP_TOKEN, password }) }, env)).status).toBe(200);
  const login = await app.request('/api/auth/login', { method: 'POST', headers: authHeaders, body: JSON.stringify({ password }) }, env);
  expect(login.status).toBe(200);
  const cookie = login.headers.get('set-cookie')?.match(/nx_sid=[^;]+/)?.[0];
  expect(cookie).toBeTruthy();
  const headers = { cookie: cookie!, 'content-type': 'application/json' };
  const read = async () => {
    const response = await app.request('/api/config', { headers }, env);
    expect(response.status).toBe(200);
    return await response.json() as Overview;
  };
  const before = await read();
  expect(limits.version).toBe(2);
  const candidate = Object.entries(limits.fields as Record<string, { kind: string; limits?: { vi?: number } }>)
    .find(([key, rule]) => rule.kind === 'bounded' && Object.hasOwn(before.draft.payload.copy.vi, key)
      && Number.isInteger(rule.limits?.vi) && rule.limits!.vi! > 0 && rule.limits!.vi! < 120);
  expect(candidate, 'The persistence case needs a real measured copy-field recommendation').toBeTruthy();
  const field = candidate![0], budget = candidate![1].limits!.vi!;
  expect(Number.isInteger(budget) && budget > 0).toBe(true);
  const text = 'i'.repeat(budget + 1);
  const payload = structuredClone(before.draft.payload);
  payload.copy.vi[field] = text;
  const saved = await app.request('/api/config/draft', {
    method: 'PUT', headers, body: JSON.stringify({ payload, baseRevision: before.draft.draftRev }),
  }, env);
  expect(saved.status).toBe(200);
  const after = await read();
  expect(after.draft.payload.copy.vi[field]).toBe(text);
  const stored = await env.DB.prepare('SELECT payload,draft_rev FROM config_draft WHERE id=1').first<{ payload: string; draft_rev: number }>();
  expect((JSON.parse(stored!.payload) as SiteConfig).copy.vi[field]).toBe(text);
  expect(stored!.draft_rev).toBe(after.draft.draftRev);

  const invalid = structuredClone(after.draft.payload);
  invalid.announcement.text.vi = 'i'.repeat(121);
  const rejected = await app.request('/api/config/draft', {
    method: 'PUT', headers, body: JSON.stringify({ payload: invalid, baseRevision: after.draft.draftRev }),
  }, env);
  expect(rejected.status).toBe(400);
  expect(await env.DB.prepare('SELECT payload,draft_rev FROM config_draft WHERE id=1').first()).toEqual(stored);
  expect((await read()).draft).toEqual(after.draft);

  const preflight = await app.request('/api/publish/preflight', { headers }, env);
  expect(preflight.status).toBe(200);
  const pre = await preflight.json() as { ready: boolean; draftRev: number; errors: unknown[] };
  expect(pre.errors).toEqual([]);
  expect(pre.ready).toBe(true);
  const published = await app.request('/api/publish', {
    method: 'POST', headers, body: JSON.stringify({ draftRev: pre.draftRev }),
  }, env);
  expect(published.status).toBe(200);
  const { versionId } = await published.json() as { versionId: number };
  const version = await env.DB.prepare('SELECT payload,status FROM config_versions WHERE id=?1').bind(versionId).first<{ payload: string; status: string }>();
  expect(version!.status).toBe('validating');
  expect((JSON.parse(version!.payload) as SiteConfig).copy.vi[field]).toBe(text);

  const next = await read();
  next.draft.payload.copy.vi[field] = text + 'i';
  expect((await app.request('/api/config/draft', {
    method: 'PUT', headers, body: JSON.stringify({ payload: next.draft.payload, baseRevision: next.draft.draftRev }),
  }, env)).status).toBe(200);
  expect((await env.DB.prepare('SELECT payload,status FROM config_versions WHERE id=?1').bind(versionId).first())).toEqual(version);
  // Queue acceptance only: no runner, asset substitute, final publication or public deployment.
  expect((await read()).live.payload).toEqual(before.live.payload);
});
