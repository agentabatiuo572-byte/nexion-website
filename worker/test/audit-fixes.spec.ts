import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/index';
import type { Env } from '../src/env';
import { LOCALES, MATERIALIZED_FILES, SiteConfigSchema, materializeI18n, materializeSiteJson, type SiteConfig } from '../../schema/src/index.js';
import manifest from '../seed/copy-manifest.json';

const secret = 'test-service-secret-with-at-least-32-characters';
const local = () => ({ ...env, PUBLISH_RUNNER_TOKEN: secret, PUBLISH_EXECUTION_MODE: 'local' }) as Env;
let cookie = '';

const headers = () => ({ cookie, 'content-type': 'application/json', authorization: `Bearer ${secret}` });
const post = (path: string, body: unknown = {}, e: Env = local()) =>
  app.request(path, { method: 'POST', headers: headers(), body: JSON.stringify(body) }, e);

async function overview(e: Env = local()) {
  const response = await app.request('/api/config', { headers: { cookie } }, e);
  expect(response.status).toBe(200);
  return response.json() as Promise<{ draft: { payload: SiteConfig; draftRev: number } }>;
}

async function save(state: { draft: { payload: SiteConfig; draftRev: number } }, e: Env = local()) {
  return app.request('/api/config/draft', {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({ payload: state.draft.payload, baseRevision: state.draft.draftRev }),
  }, e);
}

async function sha(text: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function servedEnv(identity: { versionId: number; stamp: string; runnerId: string }) {
  const row = await env.DB.prepare('SELECT payload FROM config_versions WHERE id=?1').bind(identity.versionId).first<{ payload: string }>();
  const config = SiteConfigSchema.parse(JSON.parse(row!.payload));
  const files = MATERIALIZED_FILES;
  const contents = [...LOCALES.map((locale) => materializeI18n(config, manifest as never, locale)), materializeSiteJson(config)];
  const html = 'audit served valid publication';
  const stamp = {
    ...identity,
    configSha: await sha(files.map((file, index) => `${file}\0${contents[index]}`).join('\0')),
    anchors: { '/index.html': await sha(html) },
  };
  return {
    ...local(),
    ASSETS: {
      fetch: async (request: Request) => new URL(request.url).pathname === '/.publish-stamp.json'
        ? Response.json(stamp)
        : new Response(html),
    } as Fetcher,
  } as Env;
}

async function staleBuiltPublication() {
  const state = await overview();
  state.draft.payload.copy.en['hero.scrollHint'] = '取消并发回归';
  expect((await save(state)).status).toBe(200);
  await post('/api/publish/heartbeat', { runnerId: 'audit-runner' });
  const preflight = await (await app.request('/api/publish/preflight', { headers: { cookie } }, local())).json() as { draftRev: number };
  const publication = await post('/api/publish', { draftRev: preflight.draftRev });
  expect(publication.status).toBe(200);
  const { versionId } = await publication.json() as { versionId: number };
  const next = await post('/api/publish/next', { runnerId: 'audit-runner' });
  const { job } = await next.json() as { job: { stamp: string } };
  const identity = { versionId, stamp: job.stamp, runnerId: 'audit-runner' };
  for (const step of ['materialize', 'gates', 'build']) {
    expect((await post('/api/publish/step', { ...identity, step, status: 'running' })).status).toBe(200);
    expect((await post('/api/publish/step', { ...identity, step, status: 'ok' })).status).toBe(200);
  }
  const stale = Date.now() - 13 * 60_000;
  await env.DB.batch([
    env.DB.prepare('UPDATE publish_steps SET started_at=?1,ended_at=?1 WHERE version_id=?2').bind(stale,versionId),
    env.DB.prepare('UPDATE publish_lock SET claimed_at=?1,expires_at=?2 WHERE version_id=?3').bind(stale,stale+15*60_000,versionId),
  ]);
  await env.DB.prepare('UPDATE publish_runner SET last_seen_at=?1 WHERE runner_id=?2').bind(stale, identity.runnerId).run();
  return { identity, served: await servedEnv(identity) };
}

beforeEach(async () => {
  vi.restoreAllMocks();
  for (const table of [
    'config_draft_upgrades', 'publish_dispatch', 'publish_runner', 'publish_steps', 'publish_lock',
    'config_draft', 'config_versions', 'audit', 'sessions', 'login_throttle', 'auth_account',
  ]) await env.DB.prepare(`DELETE FROM ${table}`).run();
  await post('/api/auth/setup', { token: env.SETUP_TOKEN, password: 'audit-private-password' });
  const logged = await post('/api/auth/login', { password: 'audit-private-password' });
  cookie = (logged.headers.get('set-cookie') ?? '').split(';')[0]!;
});

describe('2026-09-05 服务端审计缺陷回归', () => {
  it('M10 同族：手动汇总审计失败时当日汇总整体回滚', async () => {
    const day = '2040-01-02';
    const from = Date.parse(`${day}T00:00:00.000Z`);
    await env.DB.prepare('DELETE FROM raw_events WHERE ts>=?1 AND ts<?2').bind(from,from+86_400_000).run();
    await env.DB.prepare('DELETE FROM daily_notfound WHERE date=?1').bind(day).run();
    await env.DB.prepare('INSERT INTO daily_notfound(date,path,hits) VALUES(?1,?2,?3)').bind(day,'/sentinel',99).run();
    await env.DB.prepare('INSERT INTO raw_events(ts,type,uid,payload) VALUES(?1,?2,NULL,?3)')
      .bind(from+1_000,'e404',JSON.stringify({t:'e404',path:'/replacement'})).run();
    const invalid = await env.DB.prepare(
      "INSERT INTO raw_events(ts,type,uid,payload) VALUES(?1,'e404',NULL,?2) RETURNING id",
    ).bind(from + 2_000, '{broken-json').first<{ id: number }>();
    await env.DB.prepare(
      "CREATE TRIGGER fail_rollup_audit BEFORE INSERT ON audit WHEN NEW.action='admin.rollup' BEGIN SELECT RAISE(ABORT, 'injected-rollup-audit-failure'); END",
    ).run();
    try {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      expect((await post('/api/admin/rollup',{date:day})).status).toBe(500);
      expect((await env.DB.prepare('SELECT path,hits FROM daily_notfound WHERE date=?1').bind(day).all()).results)
        .toEqual([{path:'/sentinel',hits:99}]);
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='admin.rollup' AND target=?1").bind(day).first())
        .toMatchObject({n:0});
      expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM rollup_rejected_events WHERE raw_event_id=?1').bind(invalid!.id).first())
        .toMatchObject({ n: 0 });
    } finally {
      vi.restoreAllMocks();
      await env.DB.prepare('DROP TRIGGER fail_rollup_audit').run();
      await env.DB.prepare('DELETE FROM raw_events WHERE ts>=?1 AND ts<?2').bind(from,from+86_400_000).run();
      await env.DB.prepare('DELETE FROM daily_notfound WHERE date=?1').bind(day).run();
      await env.DB.prepare('DELETE FROM rollup_rejected_events WHERE date=?1').bind(day).run();
    }
  });

  it('手动汇总如实返回处理/隔离数，且损坏 JSON 留在同一业务审计事务', async () => {
    const day = '2040-01-03';
    const from = Date.parse(`${day}T00:00:00.000Z`);
    await env.DB.prepare('DELETE FROM raw_events WHERE ts>=?1 AND ts<?2').bind(from, from + 86_400_000).run();
    await env.DB.prepare('DELETE FROM daily_notfound WHERE date=?1').bind(day).run();
    await env.DB.prepare('DELETE FROM rollup_rejected_events WHERE date=?1').bind(day).run();
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO raw_events(ts,type,uid,payload) VALUES(?1,'e404',NULL,?2)")
          .bind(from + 1_000, JSON.stringify({ t: 'e404', path: '/kept' })),
        env.DB.prepare("INSERT INTO raw_events(ts,type,uid,payload) VALUES(?1,'e404',NULL,?2)")
          .bind(from + 2_000, '{broken-json'),
      ]);

      const response = await post('/api/admin/rollup', { date: day });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        status: 'completed-with-rejections',
        scannedEvents: 2,
        processedEvents: 1,
        rejectedEvents: 1,
      });
      expect((await env.DB.prepare('SELECT path,hits FROM daily_notfound WHERE date=?1').bind(day).all()).results)
        .toEqual([{ path: '/kept', hits: 1 }]);
      expect(await env.DB.prepare(
        'SELECT reason,attempts FROM rollup_rejected_events WHERE date=?1',
      ).bind(day).first()).toMatchObject({ reason: 'invalid-json', attempts: 1 });
      expect(await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM audit WHERE action='admin.rollup' AND target=?1",
      ).bind(day).first()).toMatchObject({ n: 1 });
    } finally {
      await env.DB.prepare('DELETE FROM raw_events WHERE ts>=?1 AND ts<?2').bind(from, from + 86_400_000).run();
      await env.DB.prepare('DELETE FROM daily_notfound WHERE date=?1').bind(day).run();
      await env.DB.prepare('DELETE FROM rollup_rejected_events WHERE date=?1').bind(day).run();
    }
  });

  it('H02：发布只接受确认时绑定的草稿 revision，陈旧确认不建版本', async () => {
    const first = await overview();
    first.draft.payload.copy.en['hero.scrollHint'] = '确认版本甲';
    expect((await save(first)).status).toBe(200);
    const preflight = await (await app.request('/api/publish/preflight', { headers: { cookie } }, local())).json() as { draftRev: number };

    const second = await overview();
    second.draft.payload.copy.en['hero.scrollHint'] = '另一标签未确认版本乙';
    expect((await save(second)).status).toBe(200);
    await post('/api/publish/heartbeat', { runnerId: 'audit-runner' });

    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM config_versions WHERE status<>'live'").first<{ n: number }>();
    const stale = await post('/api/publish', { draftRev: preflight.draftRev });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: 'draft-changed', draftRev: preflight.draftRev + 1 });
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM config_versions WHERE status<>'live'").first<{ n: number }>();
    expect(after!.n).toBe(before!.n);

    const current = await overview();
    const accepted = await post('/api/publish', { draftRev: current.draft.draftRev });
    expect(accepted.status).toBe(200);
    const { versionId } = await accepted.json() as { versionId: number };
    const version = await env.DB.prepare('SELECT payload FROM config_versions WHERE id=?1').bind(versionId).first<{ payload: string }>();
    expect(JSON.parse(version!.payload).copy.en['hero.scrollHint']).toBe('另一标签未确认版本乙');
  });

  it('H02 原子窗口：路由读完草稿后 revision 才变化，建版本事务仍拒绝', async () => {
    const confirmed = await overview();
    confirmed.draft.payload.copy.en['hero.scrollHint'] = '事务前确认版本甲';
    expect((await save(confirmed)).status).toBe(200);
    const preflight = await (await app.request('/api/publish/preflight', { headers: { cookie } }, local())).json() as { draftRev: number };
    await post('/api/publish/heartbeat', { runnerId: 'audit-runner' });

    let interleaved = false;
    const racing = {
      ...local(),
      DB: {
        prepare: env.DB.prepare.bind(env.DB),
        batch: async (statements: D1PreparedStatement[]) => {
          if (!interleaved) {
            interleaved = true;
            const later = await overview();
            later.draft.payload.copy.en['hero.scrollHint'] = '事务窗口版本乙';
            expect((await save(later)).status).toBe(200);
          }
          return env.DB.batch(statements);
        },
      } as D1Database,
    } as Env;

    const result = await post('/api/publish', { draftRev: preflight.draftRev }, racing);
    expect(interleaved).toBe(true);
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ error: 'draft-changed', draftRev: preflight.draftRev + 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM config_versions WHERE status<>'live'").first()).toMatchObject({ n: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM publish_lock').first()).toMatchObject({ n: 0 });
  });

  it('M09：每次有效活动同时续 D1 会话和浏览器 cookie', async () => {
    const original = await env.DB.prepare('SELECT expires_at FROM sessions').first<{ expires_at: number }>();
    const nextTime = Date.now() + 6 * 24 * 3600_000;
    vi.spyOn(Date, 'now').mockReturnValue(nextTime);
    const active = await app.request('/api/me', { headers: { cookie } }, local());
    expect(active.status).toBe(200);
    const refreshed = active.headers.get('set-cookie') ?? '';
    expect(refreshed).toContain(cookie);
    expect(refreshed).toContain('Max-Age=604800');
    expect(refreshed).toContain('HttpOnly');
    expect(refreshed).toContain('Secure');
    expect(refreshed.toLowerCase()).toContain('samesite=lax');
    const updated = await env.DB.prepare('SELECT expires_at FROM sessions').first<{ expires_at: number }>();
    expect(updated!.expires_at).toBe(nextTime + 7 * 24 * 3600_000);
    expect(updated!.expires_at).toBeGreaterThan(original!.expires_at);
  });

  it('M10：config.save 审计失败时草稿与 revision 一并回滚', async () => {
    const state = await overview();
    const originalPayload = JSON.stringify(state.draft.payload);
    state.draft.payload.copy.en['hero.scrollHint'] = '审计失败不得保存';
    await env.DB.prepare(
      "CREATE TRIGGER fail_config_save_audit BEFORE INSERT ON audit WHEN NEW.action='config.save' BEGIN SELECT RAISE(ABORT, 'injected-audit-failure'); END",
    ).run();
    try {
      const result = await save(state);
      expect(result.status).toBe(500);
      const persisted = await env.DB.prepare('SELECT payload,draft_rev FROM config_draft WHERE id=1').first<{ payload: string; draft_rev: number }>();
      expect(persisted!.payload).toBe(originalPayload);
      expect(persisted!.draft_rev).toBe(state.draft.draftRev);
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='config.save'").first()).toMatchObject({ n: 0 });
    } finally {
      await env.DB.prepare('DROP TRIGGER fail_config_save_audit').run();
    }
  });

  it('M10 同族：取消审计失败时版本状态和锁一并回滚', async () => {
    const state = await overview();
    state.draft.payload.copy.en['hero.scrollHint'] = '取消审计原子性';
    expect((await save(state)).status).toBe(200);
    await post('/api/publish/heartbeat', { runnerId: 'audit-runner' });
    const preflight = await (await app.request('/api/publish/preflight', { headers: { cookie } }, local())).json() as { draftRev: number };
    const publication = await post('/api/publish', { draftRev: preflight.draftRev });
    const { versionId } = await publication.json() as { versionId: number };
    await env.DB.prepare(
      "CREATE TRIGGER fail_cancel_audit BEFORE INSERT ON audit WHEN NEW.action='config.publish.cancel' BEGIN SELECT RAISE(ABORT, 'injected-audit-failure'); END",
    ).run();
    try {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      expect((await post('/api/publish/cancel')).status).toBe(500);
      expect(await env.DB.prepare('SELECT status FROM config_versions WHERE id=?1').bind(versionId).first()).toMatchObject({ status: 'validating' });
      expect(await env.DB.prepare('SELECT version_id FROM publish_lock WHERE id=1').first()).toMatchObject({ version_id: versionId });
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='config.publish.cancel'").first()).toMatchObject({ n: 0 });
    } finally {
      await env.DB.prepare('DROP TRIGGER fail_cancel_audit').run();
    }
  });

  it('M10 同族：失败审计失败时步骤、版本和锁一并回滚', async () => {
    const state = await overview();
    state.draft.payload.copy.en['hero.scrollHint'] = '失败审计原子性';
    expect((await save(state)).status).toBe(200);
    await post('/api/publish/heartbeat', { runnerId: 'audit-runner' });
    const preflight = await (await app.request('/api/publish/preflight', { headers: { cookie } }, local())).json() as { draftRev: number };
    const publication = await post('/api/publish', { draftRev: preflight.draftRev });
    const { versionId } = await publication.json() as { versionId: number };
    const next = await post('/api/publish/next', { runnerId: 'audit-runner' });
    const { job } = await next.json() as { job: { stamp: string } };
    const identity = { versionId, stamp: job.stamp, runnerId: 'audit-runner' };
    expect((await post('/api/publish/step', { ...identity, step: 'materialize', status: 'running' })).status).toBe(200);
    await env.DB.prepare(
      "CREATE TRIGGER fail_failed_audit BEFORE INSERT ON audit WHEN NEW.action='config.publish.failed' BEGIN SELECT RAISE(ABORT, 'injected-audit-failure'); END",
    ).run();
    try {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      expect((await post('/api/publish/step', { ...identity, step: 'materialize', status: 'failed', detail: '受控失败' })).status).toBe(500);
      expect(await env.DB.prepare('SELECT status FROM config_versions WHERE id=?1').bind(versionId).first()).toMatchObject({ status: 'publishing' });
      expect(await env.DB.prepare("SELECT status FROM publish_steps WHERE version_id=?1 AND step='materialize'").bind(versionId).first()).toMatchObject({ status: 'running' });
      expect(await env.DB.prepare('SELECT version_id FROM publish_lock WHERE id=1').first()).toMatchObject({ version_id: versionId });
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='config.publish.failed'").first()).toMatchObject({ n: 0 });
    } finally {
      await env.DB.prepare('DROP TRIGGER fail_failed_audit').run();
    }
  });

  it('M10 同族：上线审计失败时旧 live、运行步骤和锁保持可重试', async () => {
    const { identity, served } = await staleBuiltPublication();
    expect((await post('/api/publish/heartbeat', identity, served)).status).toBe(200);
    expect((await post('/api/publish/step', { ...identity, step: 'swap', status: 'running' }, served)).status).toBe(200);
    await env.DB.prepare(
      "CREATE TRIGGER fail_live_audit BEFORE INSERT ON audit WHEN NEW.action='config.publish.live' BEGIN SELECT RAISE(ABORT, 'injected-audit-failure'); END",
    ).run();
    try {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      expect((await post('/api/publish/step', { ...identity, step: 'swap', status: 'ok' }, served)).status).toBe(500);
      expect(await env.DB.prepare('SELECT status FROM config_versions WHERE id=?1').bind(identity.versionId).first()).toMatchObject({ status: 'publishing' });
      expect(await env.DB.prepare("SELECT status FROM publish_steps WHERE version_id=?1 AND step='swap'").bind(identity.versionId).first()).toMatchObject({ status: 'running' });
      expect(await env.DB.prepare('SELECT version_id FROM publish_lock WHERE id=1').first()).toMatchObject({ version_id: identity.versionId });
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM config_versions WHERE status='live'").first()).toMatchObject({ n: 1 });
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='config.publish.live' AND target=?1").bind(`v${identity.versionId}`).first()).toMatchObject({ n: 0 });
    } finally {
      await env.DB.prepare('DROP TRIGGER fail_live_audit').run();
    }
  });

  it('H03：Legal 三文档 × 九语逐项进入 site.json，并保留日期和英文兜底判定所需的空白原值', async () => {
    const failures: string[] = [];
    for (const doc of ['terms', 'privacy', 'appPrivacy'] as const) {
      for (const locale of LOCALES) {
        const state = await overview();
        const text = `# Materialized ${doc} ${locale}\n\nPublished body.`;
        const updatedAt = `2026-0${LOCALES.indexOf(locale) + 1}-0${(['terms', 'privacy', 'appPrivacy'] as const).indexOf(doc) + 1}`;
        state.draft.payload.legal[doc].md[locale] = text;
        state.draft.payload.legal[doc].updatedAt = updatedAt;
        expect((await save(state)).status).toBe(200);
        const persisted = await overview();
        const output = JSON.parse(materializeSiteJson(persisted.draft.payload)) as { legal?: SiteConfig['legal'] };
        if (output.legal?.[doc].md[locale] !== text) failures.push(`${doc}.${locale}.md`);
        if (output.legal?.[doc].updatedAt !== updatedAt) failures.push(`${doc}.updatedAt(${locale})`);
      }
    }
    expect(failures).toEqual([]);

    const state = await overview();
    state.draft.payload.legal.terms.md.en = '# English fallback';
    state.draft.payload.legal.terms.md.vi = '  \n';
    state.draft.payload.legal.terms.updatedAt = '2026-09-05';
    const output = JSON.parse(materializeSiteJson(state.draft.payload)) as { legal: SiteConfig['legal'] };
    expect(output.legal.terms.md.en).toBe('# English fallback');
    expect(output.legal.terms.md.vi).toBe('  \n');
    expect(output.legal.terms.updatedAt).toBe('2026-09-05');
  }, 15_000); // Nine languages make 27 real save/read pairs, three times the original coverage.

  it('H01 顺序一：强制取消先提交时，迟到执行器不能再把该版本上线', async () => {
    const { identity, served } = await staleBuiltPublication();
    const cancelled = await post('/api/publish/cancel', { force: true, reason: '执行器确认失联后由运营中止' });
    expect(cancelled.status).toBe(200);
    expect((await post('/api/publish/heartbeat', identity, served)).status).toBe(409);
    expect((await post('/api/publish/step', { ...identity, step: 'swap', status: 'running' }, served)).status).toBe(409);
    expect(await env.DB.prepare('SELECT status FROM config_versions WHERE id=?1').bind(identity.versionId).first()).toMatchObject({ status: 'cancelled' });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM config_versions WHERE status='live'").first()).toMatchObject({ n: 1 });
  });

  it('H01 顺序二：执行器先完成时，陈旧取消必须拒绝且唯一 live 不受影响', async () => {
    const { identity, served } = await staleBuiltPublication();
    let interleaved = false;
    const racing = {
      ...served,
      DB: {
        prepare: env.DB.prepare.bind(env.DB),
        batch: async (statements: D1PreparedStatement[]) => {
          if (!interleaved) {
            interleaved = true;
            expect((await post('/api/publish/heartbeat', identity, served)).status).toBe(200);
            expect((await post('/api/publish/step', { ...identity, step: 'swap', status: 'running' }, served)).status).toBe(200);
            expect((await post('/api/publish/step', { ...identity, step: 'swap', status: 'ok' }, served)).status).toBe(200);
          }
          return env.DB.batch(statements);
        },
      } as D1Database,
    } as Env;

    const cancelled = await post('/api/publish/cancel', { force: true, reason: '陈旧判断不得覆盖已完成发布' }, racing);
    expect(interleaved).toBe(true);
    expect(cancelled.status).toBe(409);
    expect(await env.DB.prepare('SELECT status FROM config_versions WHERE id=?1').bind(identity.versionId).first()).toMatchObject({ status: 'live' });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM config_versions WHERE status='live'").first()).toMatchObject({ n: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='config.publish.cancel' AND target=?1").bind(`v${identity.versionId}`).first()).toMatchObject({ n: 0 });
    expect((await app.request('/api/config', { headers: { cookie } }, served)).status).toBe(200);
  });
});
