import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SiteConfig } from '../../schema/src/index.js';
import { app } from '../src/index';

const HEADERS = { 'cf-connecting-ip': '203.0.113.91', 'content-type': 'application/json' };
const PASSWORD = 'probe-revision-pass!';

async function login(): Promise<string> {
  await app.request('/api/auth/setup', {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ token: env.SETUP_TOKEN, password: PASSWORD }),
  }, env);
  const response = await app.request('/api/auth/login', {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ password: PASSWORD }),
  }, env);
  const session = (response.headers.get('set-cookie') ?? '').match(/nx_sid=([^;]+)/)?.[1];
  return `nx_sid=${session}`;
}

const jsonHeaders = (cookie: string) => ({ cookie, 'content-type': 'application/json' });

async function overview(cookie: string): Promise<{ draft: { payload: SiteConfig; draftRev: number } }> {
  const response = await app.request('/api/config', { headers: { cookie } }, env);
  expect(response.status).toBe(200);
  return response.json();
}

beforeEach(async () => {
  for (const table of ['audit', 'sessions', 'login_throttle', 'auth_account', 'config_versions', 'config_draft']) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('download probe draft identity', () => {
  it('rejects a stale expectedDraftRev and returns the atomically-read revision on success', async () => {
    const cookie = await login();
    const before = await overview(cookie);
    const payload = structuredClone(before.draft.payload);
    payload.copy.en['hero.title'] = 'revision moved before probe';
    for (const target of ['ios', 'android', 'h5'] as const) payload.downloads[target].enabled = false;
    const save = await app.request('/api/config/draft', {
      method: 'PUT',
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ payload, baseRevision: before.draft.draftRev }),
    }, env);
    expect(save.status).toBe(200);
    const after = await overview(cookie);

    const stale = await app.request('/api/config/probe-downloads', {
      method: 'POST',
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ expectedDraftRev: before.draft.draftRev }),
    }, env);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: 'draft-changed',
      expectedDraftRev: before.draft.draftRev,
      draftRev: after.draft.draftRev,
    });

    const current = await app.request('/api/config/probe-downloads', {
      method: 'POST',
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ expectedDraftRev: after.draft.draftRev }),
    }, env);
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({
      draftRev: after.draft.draftRev,
      ios: { skipped: true },
      android: { skipped: true },
      h5: { skipped: true },
    });
  });

  it('rejects probe results when the draft changes while an external HEAD is pending', async () => {
    const cookie = await login();
    const before = await overview(cookie);
    const payload = structuredClone(before.draft.payload);
    payload.downloads.ios = { enabled: true, url: 'https://probe.example/ios' };
    payload.downloads.android.enabled = false;
    payload.downloads.h5.enabled = false;
    const save = await app.request('/api/config/draft', {
      method: 'PUT',
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ payload, baseRevision: before.draft.draftRev }),
    }, env);
    expect(save.status).toBe(200);
    const current = await overview(cookie);

    let markHeadStarted!: () => void;
    let releaseHead!: () => void;
    const headStarted = new Promise<void>((resolve) => { markHeadStarted = resolve; });
    const headPending = new Promise<void>((resolve) => { releaseHead = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('HEAD');
      markHeadStarted();
      await headPending;
      return new Response(null, { status: 204 });
    }));

    const pendingProbe = app.request('/api/config/probe-downloads', {
      method: 'POST',
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ expectedDraftRev: current.draft.draftRev }),
    }, env);
    await headStarted;

    const changedPayload = structuredClone(current.draft.payload);
    changedPayload.copy.en['hero.title'] = 'revision moved during probe';
    await env.DB
      .prepare('UPDATE config_draft SET payload = ?1, draft_rev = draft_rev + 1, updated_at = ?2 WHERE id = 1')
      .bind(JSON.stringify(changedPayload), Date.now())
      .run();
    releaseHead();

    const response = await pendingProbe;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: 'draft-changed',
      expectedDraftRev: current.draft.draftRev,
      draftRev: current.draft.draftRev + 1,
    });
  });

  it('returns 200 with the real draft revision when HEAD completes without drift', async () => {
    const cookie = await login();
    const before = await overview(cookie);
    const payload = structuredClone(before.draft.payload);
    payload.downloads.ios = { enabled: true, url: 'https://probe.example/ios' };
    payload.downloads.android.enabled = false;
    payload.downloads.h5.enabled = false;
    const save = await app.request('/api/config/draft', {
      method: 'PUT',
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ payload, baseRevision: before.draft.draftRev }),
    }, env);
    expect(save.status).toBe(200);
    const current = await overview(cookie);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));

    const response = await app.request('/api/config/probe-downloads', {
      method: 'POST',
      headers: jsonHeaders(cookie),
      body: JSON.stringify({ expectedDraftRev: current.draft.draftRev }),
    }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      draftRev: current.draft.draftRev,
      ios: { ok: true, status: 204 },
    });
  });
});
