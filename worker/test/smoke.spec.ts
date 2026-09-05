// T1 冒烟:app 可响应 + D1 迁移建齐当前全部表 + KV 可读写(plan T1-AC2)。
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { app } from '../src/index';

const EXPECTED_TABLES = [
  'config_versions', 'config_draft', 'audit',
  'auth_account', 'sessions', 'login_throttle',
  'raw_events',
  'daily_traffic', 'daily_visitors', 'daily_dimensions', 'daily_cta', 'daily_section', 'daily_faq', 'daily_learn',
  'daily_vitals', 'daily_errors', 'daily_blocked', 'daily_bot',
];

describe('T1 smoke', () => {
  it('health 端点 200 且带环境标', async () => {
    const res = await app.request('/api/health', {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; environment: string };
    expect(body.ok).toBe(true);
    expect(typeof body.environment).toBe('string');
  });

  it('D1 迁移建齐全部表,audit 可插行', async () => {
    const rows = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf%' AND name NOT LIKE 'd1_%'",
    ).all<{ name: string }>();
    const names = rows.results.map((r) => r.name);
    for (const t of EXPECTED_TABLES) {
      expect(names, `缺表 ${t}`).toContain(t);
    }
    await env.DB.prepare('INSERT INTO audit (ts, actor, action, target) VALUES (?1, ?2, ?3, ?4)')
      .bind(Date.now(), 'test', 'test.smoke', 't1')
      .run();
    const n = await env.DB.prepare('SELECT COUNT(*) AS c FROM audit').first<{ c: number }>();
    expect(n?.c).toBeGreaterThan(0);
  });

  it('KV binding 可读写', async () => {
    await env.KV.put('t1:probe', 'ok');
    expect(await env.KV.get('t1:probe')).toBe('ok');
  });
});
