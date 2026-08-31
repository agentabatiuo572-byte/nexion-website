// T21 验收(plan;继承 CON13-A1/A2/E1/E2/E3/E4 与 ④ 状态机/禁止动作)。
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { SiteConfigSchema, materializeSiteJson } from '../../schema/src/index.js';

const IP = { 'cf-connecting-ip': '203.0.113.90', 'content-type': 'application/json' };
const PW = 'publish-suite-pass!';

async function login(): Promise<string> {
  await app.request('/api/auth/setup', { method: 'POST', headers: IP, body: JSON.stringify({ token: env.SETUP_TOKEN, password: PW }) }, env);
  const res = await app.request('/api/auth/login', { method: 'POST', headers: IP, body: JSON.stringify({ password: PW }) }, env);
  return `nx_sid=${(res.headers.get('set-cookie') ?? '').match(/nx_sid=([^;]+)/)?.[1]}`;
}
const J = (cookie: string) => ({ cookie, 'content-type': 'application/json' });

/** 改一处非高敏文案,制造「有改动」 */
async function makeChange(cookie: string, value = '改动一下') {
  const o = (await (await app.request('/api/config', { headers: { cookie } }, env)).json()) as { draft: { payload: Record<string, any>; draftRev: number } };
  const p = structuredClone(o.draft.payload);
  p.copy.zh['hero.scrollHint'] = value;
  const res = await app.request('/api/config/draft', { method: 'PUT', headers: J(cookie), body: JSON.stringify({ payload: p, baseRevision: o.draft.draftRev }) }, env);
  expect(res.status).toBe(200);
}
const post = (cookie: string, p: string, body: unknown = {}) => app.request(p, { method: 'POST', headers: J(cookie), body: JSON.stringify(body) }, env);
const status = async (cookie: string) => (await (await app.request('/api/publish/status', { headers: { cookie } }, env)).json()) as any;

/* 🔴 上线核验的测试替身(2026-09-01 复验 P0-A)。
   服务端标 live 前要读**自己伺服的**线上快照里的上线印记,那枚印记只有真跑过 promote.mjs 才会存在。
   单测跑在沙箱里没有真文件系统,所以这里给一个假的资产源——它扮演的是「快照里有/没有这枚印记」。
   ⚠️ 这是给外部依赖做替身,不是在测试里放宽判据:不给替身(默认 env)时读不到印记,
   服务端必须拒绝上线,而下面第一条测试断言的正是这一点。 */
/** 这一版配置该物化成什么样的摘要 —— 与服务端同一算法,测试不另造口径 */
async function shaOfVersion(versionId: number): Promise<string> {
  const row = await env.DB.prepare('SELECT payload FROM config_versions WHERE id=?1').bind(versionId).first<{ payload: string }>();
  const json = materializeSiteJson(SiteConfigSchema.parse(JSON.parse(row!.payload)));
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}
const envWithStamp = (stamp: { versionId: number; stamp: string; configSha?: string } | null) => ({
  ...env,
  ASSETS: { fetch: async () => (stamp ? new Response(JSON.stringify(stamp), { status: 200 }) : new Response('not found', { status: 404 })) },
});
const postAs = (e: unknown, cookie: string, p: string, body: unknown = {}) =>
  app.request(p, { method: 'POST', headers: J(cookie), body: JSON.stringify(body) }, e as typeof env);

/** 领单拿到本次一次性口令(执行器的第一步) */
async function claim(cookie: string): Promise<{ versionId: number; stamp: string }> {
  const j = (await (await app.request('/api/publish/next', { method: 'POST', headers: J(cookie), body: '{}' }, env)).json()) as { job: { versionId: number; stamp: string } | null };
  expect(j.job).not.toBeNull();
  return { versionId: j.job!.versionId, stamp: j.job!.stamp };
}

/** 走完整一轮**成功**发布:领单 → 逐步回报 → 切换步带着真印记(模拟 promote 真搬运过) */
async function runPipeline(cookie: string, versionId: number) {
  const job = await claim(cookie);
  expect(job.versionId).toBe(versionId);
  const e = envWithStamp({ versionId, stamp: job.stamp, configSha: await shaOfVersion(versionId) });
  for (const step of ['materialize', 'gates', 'build', 'swap']) {
    expect((await postAs(e, cookie, '/api/publish/step', { versionId, stamp: job.stamp, step, status: 'running' })).status).toBe(200);
    expect((await postAs(e, cookie, '/api/publish/step', { versionId, stamp: job.stamp, step, status: 'ok' })).status).toBe(200);
  }
}

beforeEach(async () => {
  for (const t of ['audit', 'sessions', 'login_throttle', 'auth_account', 'config_versions', 'config_draft', 'publish_lock', 'publish_steps'])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
});

describe('CON13 发布流水线', () => {
  it('未登录一律 401', async () => {
    for (const p of ['/api/publish/preflight', '/api/publish/status']) expect((await app.request(p, {}, env)).status).toBe(401);
    expect((await app.request('/api/publish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, env)).status).toBe(401);
  });

  it('E1 前置校验红 → 不进流水线(禁用词/缺译);无改动 → 409', async () => {
    const cookie = await login();
    expect((await post(cookie, '/api/publish')).status).toBe(409); // 无改动
    const o = (await (await app.request('/api/config', { headers: { cookie } }, env)).json()) as any;
    const p = structuredClone(o.draft.payload);
    p.copy.en['hero.note'] = 'We guarantee your returns.'; // 禁用词
    await app.request('/api/config/draft', { method: 'PUT', headers: J(cookie), body: JSON.stringify({ payload: p, baseRevision: o.draft.draftRev }) }, env);
    const pre = (await (await app.request('/api/publish/preflight', { headers: { cookie } }, env)).json()) as any;
    expect(pre.ready).toBe(false);
    expect(pre.errors.some((e: any) => e.rule === 'forbidden-word')).toBe(true);
    const res = await post(cookie, '/api/publish');
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toBe('preflight-failed');
    const n = await env.DB.prepare("SELECT COUNT(*) c FROM config_versions WHERE status<>'live'").first<{ c: number }>();
    expect(n!.c).toBe(0); // 没建任何发布版本
  });

  it('A1 成功发布:状态机 validating→publishing→live,旧版归档,审计留痕', async () => {
    const cookie = await login();
    await makeChange(cookie);
    const r = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    const st1 = await status(cookie);
    expect(st1.activeVersion).toBe(r.versionId);
    await runPipeline(cookie, r.versionId);
    const st2 = await status(cookie);
    expect(st2.activeVersion).toBeNull(); // 锁已释放
    const rows = st2.versions as Array<{ id: number; status: string }>;
    expect(rows.find((v) => v.id === r.versionId)!.status).toBe('live');
    expect(rows.filter((v) => v.status === 'live').length).toBe(1); // 只有一个 live
    const acts = (await env.DB.prepare('SELECT action FROM audit').all<{ action: string }>()).results.map((x) => x.action);
    expect(acts).toContain('config.publish');
    expect(acts).toContain('config.publish.live');
  });

  it('E2 门红:版本 failed + 线上保持旧版 + 草稿改动不丢 + 大白话原因', async () => {
    const cookie = await login();
    await makeChange(cookie, '门红测试用文案'); // 先触发种子化,再取基线
    const liveBefore = await env.DB.prepare("SELECT id, payload FROM config_versions WHERE status='live'").first<{ id: number; payload: string }>();
    expect(liveBefore, '种子化后应有 live 版本').not.toBeNull();
    const r = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    const job = await claim(cookie);
    await post(cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'materialize', status: 'running' });
    await post(cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'materialize', status: 'ok' });
    await post(cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'gates', status: 'running' });
    const fail = await post(cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'gates', status: 'failed', gate: 'render-fit', detail: 'x' });
    expect(fail.status).toBe(200);
    const st = await status(cookie);
    const v = (st.versions as Array<{ id: number; status: string; fail_reason: string }>).find((x) => x.id === r.versionId)!;
    expect(v.status).toBe('failed');
    expect(v.fail_reason).toContain('版面'); // 大白话:render-fit → 「新文案把版面挤破了」
    expect(v.fail_reason).toContain('render-fit'); // 同时保留门名原文
    const liveAfter = await env.DB.prepare("SELECT id, payload FROM config_versions WHERE status='live'").first<{ id: number; payload: string }>();
    expect(liveAfter!.id).toBe(liveBefore!.id); // 线上未变
    const draft = await env.DB.prepare('SELECT payload FROM config_draft WHERE id=1').first<{ payload: string }>();
    expect(draft!.payload).toContain('门红测试用文案'); // 草稿改动保留
    expect(st.activeVersion).toBeNull(); // 锁释放
  });

  it('E3 并发发布:第二次 409;锁过期后前一版自动标 failed 并可重新发起', async () => {
    const cookie = await login();
    await makeChange(cookie);
    const r1 = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    const second = await post(cookie, '/api/publish');
    expect(second.status).toBe(409);
    expect(((await second.json()) as any).error).toBe('publish-in-progress');
    // 把锁拨到过期 → 下一次发起应接管,并把 r1 标 failed
    await env.DB.prepare('UPDATE publish_lock SET expires_at = ?1').bind(Date.now() - 1000).run();
    await makeChange(cookie, '锁过期后的新改动');
    const r2 = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    expect(r2.versionId).not.toBe(r1.versionId);
    const v1 = await env.DB.prepare('SELECT status, fail_reason FROM config_versions WHERE id=?1').bind(r1.versionId).first<{ status: string; fail_reason: string }>();
    expect(v1!.status).toBe('failed');
    expect(v1!.fail_reason).toContain('超时');
  });

  it('E4 执行器不在线:可取消;已开跑则不可取消', async () => {
    const cookie = await login();
    await makeChange(cookie);
    const r = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    expect((await post(cookie, '/api/publish/cancel')).status).toBe(200);
    expect((await status(cookie)).activeVersion).toBeNull();
    // 再发一版并让第一步跑完,此时不可取消
    await makeChange(cookie, '第二轮');
    const r2 = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    const job2 = await claim(cookie);
    await post(cookie, '/api/publish/step', { versionId: r2.versionId, stamp: job2.stamp, step: 'materialize', status: 'running' });
    await post(cookie, '/api/publish/step', { versionId: r2.versionId, stamp: job2.stamp, step: 'materialize', status: 'ok' });
    expect((await post(cookie, '/api/publish/cancel')).status).toBe(409);
  });

  it('A2 回滚:以旧版内容发起新版本,同样走完整门链;须理由', async () => {
    const cookie = await login();
    await makeChange(cookie, '第一版文案');
    const r1 = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    await runPipeline(cookie, r1.versionId);
    await makeChange(cookie, '第二版文案');
    const r2 = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    await runPipeline(cookie, r2.versionId);
    // 回滚到 r1:无理由 → 400
    expect((await post(cookie, '/api/publish', { fromVersion: r1.versionId })).status).toBe(400);
    const rb = await post(cookie, '/api/publish', { fromVersion: r1.versionId, reason: '第二版文案有问题,回滚' });
    expect(rb.status).toBe(200);
    const rbId = ((await rb.json()) as { versionId: number; rollbackFrom: number }).versionId;
    expect(rbId).toBeGreaterThan(r2.versionId); // 回滚生成**新版本**,不是把旧版复活
    await runPipeline(cookie, rbId);
    const live = await env.DB.prepare("SELECT id, payload FROM config_versions WHERE status='live'").first<{ id: number; payload: string }>();
    expect(live!.id).toBe(rbId);
    expect(live!.payload).toContain('第一版文案'); // 内容回到 r1
    const acts = (await env.DB.prepare("SELECT action FROM audit WHERE action='config.rollback'").all()).results;
    expect(acts.length).toBe(1);
  });

  /* ══ 不变量:不跑门就上不了线 ══
     🔴 这一组断言的是**那条承诺本身**,不是某个修法的错误码。
     上一轮我写的三条回归测试全在验「跳步返 409」「不先报 running 返 409」「过期锁返 409」——
     即三种**畸形**序列。但伪造者根本不必畸形:老老实实按顺序把四步各报一遍就行,
     而那条路径当时一路 200,版本变 live,步骤记录与真发布完全同形。
     教训:**回归测试要钉承诺,不要钉修法**。钉修法的测试,在修法改一次形状后就什么也保不住。 */
  it('🔴🔴 不变量:把四步按合法顺序全报一遍,没有真搬运过产物就上不了线', async () => {
    const cookie = await login();
    await makeChange(cookie);
    const r = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    const liveBefore = await env.DB.prepare("SELECT id FROM config_versions WHERE status='live'").first<{ id: number }>();
    const job = await claim(cookie);
    // 完全合法的序列,一步不跳、每步先 running 再 ok
    for (const step of ['materialize', 'gates', 'build']) {
      expect((await post(cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step, status: 'running' })).status).toBe(200);
      expect((await post(cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step, status: 'ok' })).status).toBe(200);
    }
    expect((await post(cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'swap', status: 'running' })).status).toBe(200);
    const res = await post(cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'swap', status: 'ok' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toBe('live-verification-failed');
    // 线上指针纹丝不动,该版被判失败
    const liveAfter = await env.DB.prepare("SELECT id FROM config_versions WHERE status='live'").first<{ id: number }>();
    expect(liveAfter?.id).toBe(liveBefore?.id);
    const v = await env.DB.prepare('SELECT status, fail_reason FROM config_versions WHERE id=?1').bind(r.versionId).first<{ status: string; fail_reason: string }>();
    expect(v!.status).toBe('failed');
    expect(v!.fail_reason).toContain('上线核验未通过');
  });

  it('🔴🔴 不变量:印记指向别的版本 / 口令不对,一律上不了线', async () => {
    const cookie = await login();
    for (const [name, forge] of [
      ['版本号不符', (j: { versionId: number; stamp: string }) => ({ versionId: j.versionId + 999, stamp: j.stamp })],
      ['口令不符', (j: { versionId: number; stamp: string }) => ({ versionId: j.versionId, stamp: 'deadbeef'.repeat(4) })],
    ] as const) {
      await makeChange(cookie, `改动-${name}`);
      const r = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
      const job = await claim(cookie);
      const e = envWithStamp(forge(job));
      for (const step of ['materialize', 'gates', 'build']) {
        await postAs(e, cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step, status: 'running' });
        await postAs(e, cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step, status: 'ok' });
      }
      await postAs(e, cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'swap', status: 'running' });
      const res = await postAs(e, cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'swap', status: 'ok' });
      expect(res.status, name).toBe(409);
      const v = await env.DB.prepare('SELECT status FROM config_versions WHERE id=?1').bind(r.versionId).first<{ status: string }>();
      expect(v!.status, name).toBe('failed');
    }
  });

  it('P1 每一步只许声明一次:对已 ok 的步骤重复报 running 必须被拒(否则可无限续锁)', async () => {
    const cookie = await login();
    await makeChange(cookie);
    const r = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    const job = await claim(cookie);
    await post(cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'materialize', status: 'running' });
    await post(cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'materialize', status: 'ok' });
    const again = await post(cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'materialize', status: 'running' });
    expect(again.status).toBe(409);
    expect(((await again.json()) as any).error).toBe('step-already-started');
  });

  it('P1 执行器失联有出口:未失联不许强制中止,失联后带理由可中止', async () => {
    const cookie = await login();
    await makeChange(cookie);
    const r = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    const job = await claim(cookie);
    await post(cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'materialize', status: 'running' });
    const soon = await post(cookie, '/api/publish/cancel', { force: true, reason: '手滑' });
    expect(soon.status).toBe(409); // 刚有动静,不许中止
    expect(((await soon.json()) as any).error).toBe('runner-still-alive');
    // 把最后动静推到 13 分钟前 = 执行器失联
    await env.DB.prepare('UPDATE publish_steps SET started_at=?1, ended_at=NULL WHERE version_id=?2').bind(Date.now() - 13 * 60_000, r.versionId).run();
    expect((await post(cookie, '/api/publish/cancel', { force: true })).status).toBe(400); // 必须写理由
    const okRes = await post(cookie, '/api/publish/cancel', { force: true, reason: '执行器所在机器断电' });
    expect(okRes.status).toBe(200);
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM publish_lock').first<{ n: number }>())!.n).toBe(0); // 锁已释放,可以重发
  });

  it('P1 两个执行器同时领单只有一个拿到(原子占位,不是先后判定)', async () => {
    const cookie = await login();
    await makeChange(cookie);
    await post(cookie, '/api/publish');
    const next = async () => (await (await app.request('/api/publish/next', { method: 'POST', headers: J(cookie), body: '{}' }, env)).json()) as { job: unknown };
    const [a, b] = await Promise.all([next(), next()]);
    expect([a.job, b.job].filter(Boolean)).toHaveLength(1);
  });

  it('🔴 P0-1 步骤顺序不可跳:发起后直接报 swap ok 必须被拒,版本不得 live', async () => {
    const cookie = await login();
    await makeChange(cookie);
    const r = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    const job = await claim(cookie);
    // 形态①:一步不跑,直接收口最后一步
    const jump = await post(cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'swap', status: 'ok' });
    expect(jump.status).toBe(409);
    expect(((await jump.json()) as any).error).toBe('step-out-of-order');
    // 形态②:先声明 swap running 再 ok(绕开「必须先 running」那道)——前序缺失仍应拒
    expect((await post(cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'swap', status: 'running' })).status).toBe(409);
    // 形态③:跳过 gates(物化 ok 后直接 build)
    await post(cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'materialize', status: 'running' });
    await post(cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'materialize', status: 'ok' });
    const skipGates = await post(cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'build', status: 'running' });
    expect(skipGates.status).toBe(409);
    expect(((await skipGates.json()) as any).missing).toContain('gates');
    // 全程 live 未变
    const live = await env.DB.prepare("SELECT id FROM config_versions WHERE status='live'").first<{ id: number }>();
    expect(live!.id).not.toBe(r.versionId);
  });

  it('🔴 P0-1b 未先报 running 不得收口;同一步不得重复收口', async () => {
    const cookie = await login();
    await makeChange(cookie);
    const r = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    const job = await claim(cookie);
    const noRunning = await post(cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'materialize', status: 'ok' });
    expect(noRunning.status).toBe(409);
    expect(((await noRunning.json()) as any).error).toContain('step-not-running');
    await post(cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'materialize', status: 'running' });
    expect((await post(cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'materialize', status: 'ok' })).status).toBe(200);
    expect((await post(cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'materialize', status: 'ok' })).status).toBe(409); // 重复
  });

  it('🔴 P0-2 锁过期后 step 一律拒收(此前过期锁照收即可上线)', async () => {
    const cookie = await login();
    await makeChange(cookie);
    const r = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    const job = await claim(cookie);
    await post(cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'materialize', status: 'running' });
    await env.DB.prepare('UPDATE publish_lock SET expires_at = ?1').bind(Date.now() - 1000).run();
    const res = await post(cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'materialize', status: 'ok' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toContain('lock-expired');
  });

  it('P1 执行器租约:已被领取的任务不再派发给第二个执行器', async () => {
    const cookie = await login();
    await makeChange(cookie);
    const r = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    const job = await claim(cookie); // 第一个执行器领到
    expect(job.versionId).toBe(r.versionId);
    await post(cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'materialize', status: 'running' }); // 第一个执行器开工
    const second = (await (await app.request('/api/publish/next', { method: 'POST', headers: J(cookie), body: '{}' }, env)).json()) as { job: unknown; note?: string };
    expect(second.job).toBeNull();
    expect(second.note).toBe('already-claimed');
  });

  it('P1 失败态可取回步骤日志(此前只对进行中版本返回,失败后日志取不回)', async () => {
    const cookie = await login();
    await makeChange(cookie);
    const r = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    const job = await claim(cookie);
    await post(cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'materialize', status: 'running' });
    await post(cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'materialize', status: 'ok' });
    await post(cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'gates', status: 'running' });
    await post(cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'gates', status: 'failed', gate: 'render-fit', detail: '门日志尾部若干行' });
    const s = await status(cookie);
    expect(s.activeVersion).toBeNull();
    expect(s.stepsOfVersion).toBe(r.versionId);
    expect((s.steps as { status: string; detail: string | null }[]).find((x) => x.status === 'failed')?.detail).toContain('门日志尾部');
  });

  it('P1 取消仅限排队态:任何步骤开始后即不可取消', async () => {
    const cookie = await login();
    await makeChange(cookie);
    const r = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    const job = await claim(cookie);
    await post(cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'materialize', status: 'running' }); // 仅 running,未完成
    const res = await post(cookie, '/api/publish/cancel');
    expect(res.status).toBe(409);
  });


  it('🔴 P1-4 印记内容摘要对不上 → 拒绝上线(证明的不只是「有人落了个文件」)', async () => {
    const cookie = await login();
    await makeChange(cookie);
    const r = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    const job = await claim(cookie);
    // 版本号、口令都对,只有内容摘要是别的东西 —— 即「快照不是照这一版构建的」
    const e = envWithStamp({ versionId: r.versionId, stamp: job.stamp, configSha: 'f'.repeat(64) });
    for (const step of ['materialize', 'gates', 'build']) {
      await postAs(e, cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step, status: 'running' });
      await postAs(e, cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step, status: 'ok' });
    }
    await postAs(e, cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'swap', status: 'running' });
    const res = await postAs(e, cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'swap', status: 'ok' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).why).toContain('内容摘要对不上');
    const v = await env.DB.prepare('SELECT status FROM config_versions WHERE id=?1').bind(r.versionId).first<{ status: string }>();
    expect(v!.status).toBe('failed');
  });

  it('🔴 P1-1 并发被拒不留垃圾版本行(否则会造出一条成功发布也清不掉的假红条)', async () => {
    const cookie = await login();
    await makeChange(cookie);
    await post(cookie, '/api/publish');
    const before = (await env.DB.prepare('SELECT COUNT(*) n FROM config_versions').first<{ n: number }>())!.n;
    const rejected = await post(cookie, '/api/publish');
    expect(rejected.status).toBe(409);
    const after = (await env.DB.prepare('SELECT COUNT(*) n FROM config_versions').first<{ n: number }>())!.n;
    expect(after, '被拒的发布不该留下任何版本行').toBe(before);
    const o = (await (await app.request('/api/config', { headers: { cookie } }, env)).json()) as any;
    expect(o.lastPublishFailed, '也不该因此冒出一条假的失败红条').toBeNull();
  });

  it('🔴 P1-3 线上快照与系统记录劈叉时,状态里必须报出来', async () => {
    const cookie = await login();
    await makeChange(cookie);
    const r = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    await runPipeline(cookie, r.versionId); // v 已 live,快照印记 = v
    const ok = envWithStamp({ versionId: r.versionId, stamp: 'x' });
    const clean = (await (await app.request('/api/publish/status', { headers: { cookie } }, ok as unknown as typeof env)).json()) as any;
    expect(clean.drift, '印记与记录一致时不该报警').toBeNull();
    // 全新环境(种子版 + 快照无印记)也不该报——否则是永久噪音
    await env.DB.prepare("UPDATE config_versions SET status='archived' WHERE status='live'").run();
    await env.DB.prepare("UPDATE config_versions SET status='live' WHERE created_by='system'").run();
    const seeded = (await (await app.request('/api/publish/status', { headers: { cookie } }, env)).json()) as any;
    expect(seeded.drift, '初始种子 + 无印记 = 全新环境,不报').toBeNull();
    await env.DB.prepare("UPDATE config_versions SET status='archived' WHERE created_by='system'").run();
    await env.DB.prepare('UPDATE config_versions SET status=?2 WHERE id=?1').bind(r.versionId, 'live').run();
    // 模拟「切换已落盘、回报没送到」:快照印记指向一个比记录更新的版本
    const e = envWithStamp({ versionId: r.versionId + 7, stamp: 'x' });
    const drifted = (await (await app.request('/api/publish/status', { headers: { cookie } }, e as unknown as typeof env)).json()) as any;
    expect(drifted.drift).not.toBeNull();
    expect(drifted.drift.dbLive).toBe(r.versionId);
    expect(drifted.drift.snapshot).toBe(r.versionId + 7);
  });

  it('P2 上报必须来自领过单的执行器(不领单就上报应被拒)', async () => {
    const cookie = await login();
    await makeChange(cookie);
    const r = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    const res = await post(cookie, '/api/publish/step', { versionId: r.versionId, step: 'materialize', status: 'running' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toContain('not-the-claimed-runner');
  });

  it('④ 禁止动作:不存在绕过门链直接上新的路由', async () => {
    const cookie = await login();
    for (const p of ['/api/publish/live', '/api/publish/force', '/api/config/live', '/api/publish/swap']) {
      for (const method of ['POST', 'PUT'] as const) {
        const res = await app.request(p, { method, headers: J(cookie), body: '{}' }, env);
        expect([404, 405], `${method} ${p} 不该存在`).toContain(res.status);
      }
    }
    // step 接口只接受当前锁持有的版本,冒名顶替被拒
    await makeChange(cookie);
    const r = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    const spoof = await post(cookie, '/api/publish/step', { versionId: r.versionId + 999, step: 'swap', status: 'ok' });
    expect(spoof.status).toBe(409);
  });

  it('状态读时自愈:执行器死掉后「发布中」不会永远挂着(实景实测的假状态)', async () => {
    const cookie = await login();
    await makeChange(cookie);
    const r = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    const job = await claim(cookie);
    await post(cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'materialize', status: 'running' });
    await post(cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'materialize', status: 'ok' });
    // 模拟执行器猝死:锁过期,版本仍挂 publishing
    await env.DB.prepare('UPDATE publish_lock SET expires_at = ?1').bind(Date.now() - 1000).run();
    const st = await status(cookie);
    expect(st.activeVersion).toBeNull();
    const v = (st.versions as Array<{ id: number; status: string; fail_reason: string }>).find((x) => x.id === r.versionId)!;
    expect(v.status).toBe('failed'); // 不再显示「发布中」
    expect(v.fail_reason).toContain('中断');
    expect(await env.DB.prepare('SELECT COUNT(*) c FROM publish_lock').first<{ c: number }>()).toMatchObject({ c: 0 }); // 过期锁已清
    // 自愈后可以直接重新发布(不需要人工清理)
    expect((await post(cookie, '/api/publish')).status).toBe(200);
  });

  it('编码损坏字符入前置校验:U+FFFD 被拒(实景发布中挖出的缺口)', async () => {
    const cookie = await login();
    const o = (await (await app.request('/api/config', { headers: { cookie } }, env)).json()) as any;
    const p = structuredClone(o.draft.payload);
    p.copy.zh['hero.scrollHint'] = '连接手�闲置算力'; // 「手机」被编码损坏后的形态
    await app.request('/api/config/draft', { method: 'PUT', headers: J(cookie), body: JSON.stringify({ payload: p, baseRevision: o.draft.draftRev }) }, env);
    const pre = (await (await app.request('/api/publish/preflight', { headers: { cookie } }, env)).json()) as any;
    expect(pre.ready).toBe(false);
    expect(pre.errors.some((e: any) => e.rule === 'encoding-damage' && e.path.includes('hero.scrollHint'))).toBe(true);
    expect((await post(cookie, '/api/publish')).status).toBe(409); // 不进流水线
  });

  it('高敏改动须理由(下载 URL);非高敏不须', async () => {
    const cookie = await login();
    const o = (await (await app.request('/api/config', { headers: { cookie } }, env)).json()) as any;
    const p = structuredClone(o.draft.payload);
    p.downloads.android = { url: 'https://play.google.com/store/apps/details?id=x', enabled: true };
    await app.request('/api/config/draft', { method: 'PUT', headers: J(cookie), body: JSON.stringify({ payload: p, baseRevision: o.draft.draftRev }) }, env);
    const pre = (await (await app.request('/api/publish/preflight', { headers: { cookie } }, env)).json()) as any;
    expect(pre.reasonRequired).toBe(true);
    expect((await post(cookie, '/api/publish')).status).toBe(400);
    expect((await post(cookie, '/api/publish', { reason: '安卓商店已过审,开放下载' })).status).toBe(200);
  });
});
