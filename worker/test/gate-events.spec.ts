// FEAT-ANTIBOT01 §3.5 事件与汇总验收:gate 事件入库、daily_gate 聚合、坏 payload 拒绝、幂等。
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { runDailyRollup } from '../src/rollup';

const DAY = '2026-09-24';
const TS = Date.parse(`${DAY}T12:00:00.000Z`);

const gatePayload = (overrides: Record<string, unknown> = {}) => ({
  t: 'gate',
  v: 'block',
  r: 'ai_bot_ua',
  ua: 'GPTBot',
  asn: 13335,
  p: 'home',
  lv: 1,
  e: 1,
  ...overrides,
});

async function insertGate(payload: unknown, ts = TS): Promise<void> {
  await env.DB.prepare("INSERT INTO raw_events (ts, type, uid, payload) VALUES (?1, 'gate', NULL, ?2)")
    .bind(ts, JSON.stringify(payload))
    .run();
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM raw_events').run();
  await env.DB.prepare('DELETE FROM daily_gate').run();
  await env.DB.prepare('DELETE FROM rollup_rejected_events').run();
});

describe('gate events rollup', () => {
  it('aggregates valid gate events into daily_gate by verdict and reason', async () => {
    await insertGate(gatePayload());
    await insertGate(gatePayload({ v: 'challenge', r: 'challenge_issued', ua: '', asn: null, p: 'learn', lv: 2, e: 0 }));
    await insertGate(gatePayload({ v: 'challenge', r: 'challenge_issued', ua: '', asn: null, p: 'learn', lv: 2, e: 0 }));
    await insertGate(gatePayload({ v: 'pass', r: 'gate_degraded', ua: '', asn: null, p: 'home', lv: 1, e: 0 }));

    const result = await runDailyRollup(env.DB, DAY);
    expect(result).toMatchObject({ scannedEvents: 4, processedEvents: 4, rejectedEvents: 0 });

    const rows = await env.DB.prepare('SELECT verdict, reason, hits, enforced_hits FROM daily_gate ORDER BY verdict, reason').all();
    expect(rows.results).toEqual([
      { verdict: 'block', reason: 'ai_bot_ua', hits: 1, enforced_hits: 1 },
      { verdict: 'challenge', reason: 'challenge_issued', hits: 2, enforced_hits: 0 },
      { verdict: 'pass', reason: 'gate_degraded', hits: 1, enforced_hits: 0 },
    ]);
  });

  it('rejects malformed gate payloads without poisoning aggregation', async () => {
    await insertGate(gatePayload());
    await insertGate(gatePayload({ v: 'nope' }));
    await insertGate(gatePayload({ r: 'made_up' }));
    await insertGate(gatePayload({ p: '' }));
    await insertGate(gatePayload({ e: 2 }));
    await insertGate(gatePayload({ asn: 'x' }));

    const result = await runDailyRollup(env.DB, DAY);
    expect(result).toMatchObject({ scannedEvents: 6, processedEvents: 1, rejectedEvents: 5 });

    const rows = await env.DB.prepare('SELECT verdict, reason, hits, enforced_hits FROM daily_gate').all();
    expect(rows.results).toEqual([{ verdict: 'block', reason: 'ai_bot_ua', hits: 1, enforced_hits: 1 }]);
  });

  it('is idempotent: rerunning the same day replaces its rows', async () => {
    await insertGate(gatePayload());
    await runDailyRollup(env.DB, DAY);
    await insertGate(gatePayload({ v: 'block', r: 'search_engine_ua', ua: 'Googlebot' }));
    await runDailyRollup(env.DB, DAY);

    const rows = await env.DB.prepare('SELECT verdict, reason, hits FROM daily_gate ORDER BY reason').all();
    expect(rows.results).toEqual([
      { verdict: 'block', reason: 'ai_bot_ua', hits: 1 },
      { verdict: 'block', reason: 'search_engine_ua', hits: 1 },
    ]);
  });
});
