// T21 验收(plan;继承 CON13-A1/A2/E1/E2/E3/E4 与 ④ 状态机/禁止动作)。
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { LOCALES, SiteConfigSchema, materializeI18n, materializeSiteJson } from '../../schema/src/index.js';
import manifestJson from '../seed/copy-manifest.json';

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
  const cfg = SiteConfigSchema.parse(JSON.parse(row!.payload));
  const files = ['src/i18n/en.json', 'src/i18n/vi.json', 'src/i18n/zh.json', 'src/config/site.json'];
  const parts = [...LOCALES.map((loc) => materializeI18n(cfg, manifestJson as never, loc)), materializeSiteJson(cfg)];
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(files.map((f, i) => f + '\0' + parts[i]).join('\0')));
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
    // 新转移表下:已 ok 的步骤再报 running 属于「改口」,归 step-already-done(语义比原来更准)
    expect(((await again.json()) as any).error).toBe('step-already-done');
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
    expect((await post(cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'materialize', status: 'ok' })).status).toBe(200); // 同结果重报=幂等
    expect((await post(cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'materialize', status: 'failed' })).status).toBe(409); // 改口非法
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
    /* 🔴 必须用「无印记」替身,不能用真实资产层(2026-09-01 第六轮 P1-2)。
       这里原来直接传 env,于是这条断言的成败取决于**仓外的构建产物 dist-live 里有没有印记文件**:
       没有印记(上一位验收方收尾清掉了)时 105/105 绿,有印记(任何一次成功发布之后的常态)时 104/105 红。
       也就是说我历次报的「机器门全绿」在真实状态下从没成立过——**测试依赖了不在版本管理里的东西**,
       它的绿就不是关于代码的结论。替身把「无印记」这个前提显式化,测试从此与产物无关。 */
    const seeded = (await (await app.request('/api/publish/status', { headers: { cookie } }, envWithStamp(null) as unknown as typeof env)).json()) as any;
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


  it('🔴 P1-2 同一步同一结果重报 = 幂等成功(否则「回报送到了但响应丢了」的重试会打死执行器)', async () => {
    const cookie = await login();
    await makeChange(cookie);
    const r = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    const job = await claim(cookie);
    const s1 = await post(cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'materialize', status: 'running' });
    expect(s1.status).toBe(200);
    const again = await post(cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'materialize', status: 'running' });
    expect(again.status, '重发同一条上报必须被当作已受理').toBe(200);
    expect(((await again.json()) as any).idempotent).toBe(true);
    await post(cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'materialize', status: 'ok' });
    const okAgain = await post(cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'materialize', status: 'ok' });
    expect(okAgain.status).toBe(200);
    // 但「改口」仍非法:已 ok 的步骤不许改报 failed
    expect((await post(cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'materialize', status: 'failed' })).status).toBe(409);
  });

  it('🔴 P1-5 取消记「已取消」不记「失败」:不该造出红条', async () => {
    const cookie = await login();
    await makeChange(cookie);
    const r = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    expect((await post(cookie, '/api/publish/cancel')).status).toBe(200);
    const v = await env.DB.prepare('SELECT status FROM config_versions WHERE id=?1').bind(r.versionId).first<{ status: string }>();
    expect(v!.status).toBe('cancelled');
    const o = (await (await app.request('/api/config', { headers: { cookie } }, env)).json()) as any;
    expect(o.lastPublishFailed, '正常取消不该换来一条红条').toBeNull();
  });

  it('🔴 P1-3 内容摘要必须覆盖文案:拿上一版的摘要来盖本版,必须被拒', async () => {
    const cookie = await login();
    await makeChange(cookie, '摘要覆盖-甲');
    const r1 = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    const shaA = await shaOfVersion(r1.versionId);
    await runPipeline(cookie, r1.versionId); // 甲 已上线

    await makeChange(cookie, '摘要覆盖-乙'); // 只改文案:site.json 一个字节都不变
    const r2 = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    const job = await claim(cookie);
    // 快照其实还是「甲」的内容,但印记谎称是「乙」——摘要若只覆盖 site.json,这里会放行
    const stale = envWithStamp({ versionId: r2.versionId, stamp: job.stamp, configSha: shaA });
    for (const step of ['materialize', 'gates', 'build']) {
      await postAs(stale, cookie, '/api/publish/step', { versionId: r2.versionId, stamp: job.stamp, step, status: 'running' });
      await postAs(stale, cookie, '/api/publish/step', { versionId: r2.versionId, stamp: job.stamp, step, status: 'ok' });
    }
    await postAs(stale, cookie, '/api/publish/step', { versionId: r2.versionId, stamp: job.stamp, step: 'swap', status: 'running' });
    const res = await postAs(stale, cookie, '/api/publish/step', { versionId: r2.versionId, stamp: job.stamp, step: 'swap', status: 'ok' });
    expect(res.status, '只改文案的两版摘要必须不同,否则拿旧摘要就能盖新版').toBe(409);
    expect(((await res.json()) as any).why).toContain('内容摘要对不上');
    const live = await env.DB.prepare("SELECT id FROM config_versions WHERE status='live'").first<{ id: number }>();
    expect(live!.id, '线上仍是甲').toBe(r1.versionId);
  });


  it('🔴 P1-4 线上快照被直接改动 → 标 live 前必须拒,且劈叉自查要报出来', async () => {
    const cookie = await login();
    await makeChange(cookie, '锚点核验用改动');
    const r = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    const job = await claim(cookie);
    const sha = await shaOfVersion(r.versionId);

    /* 替身扮演「印记说这个文件该是 A,而实物是 B」——即有人绕过发布流程直接改了线上文件。
       印记本身的版本号、口令、配置摘要**全都对**,只有实物对不上。 */
    const tampered = {
      ...env,
      ASSETS: {
        fetch: async (req: Request) => {
          const path = new URL(req.url).pathname;
          if (path === '/.publish-stamp.json') {
            return new Response(
              JSON.stringify({ versionId: r.versionId, stamp: job.stamp, configSha: sha, anchors: { '/index.html': 'a'.repeat(64) } }),
              { status: 200 },
            );
          }
          return new Response('被改过的内容', { status: 200 }); // 摘要必然不等于 'aaaa…'
        },
      },
    };

    for (const step of ['materialize', 'gates', 'build']) {
      await postAs(tampered, cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step, status: 'running' });
      await postAs(tampered, cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step, status: 'ok' });
    }
    await postAs(tampered, cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'swap', status: 'running' });
    const res = await postAs(tampered, cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'swap', status: 'ok' });
    expect(res.status, '实物与印记不符时不许上线').toBe(409);
    expect(((await res.json()) as { why?: string }).why).toContain('已被改动过');
  });

  it('🔴 P1-4 版本号对得上但内容被改 → 劈叉自查要点名是哪些文件', async () => {
    const cookie = await login();
    await makeChange(cookie, '锚点劈叉用改动');
    const r = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    await runPipeline(cookie, r.versionId); // 正常上线

    const okAnchor = await (async () => {
      const body = '一致的内容';
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
      return { body, sha: Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('') };
    })();

    const mk = (anchorSha: string) => ({
      ...env,
      ASSETS: {
        fetch: async (req: Request) => {
          const path = new URL(req.url).pathname;
          if (path === '/.publish-stamp.json') {
            return new Response(JSON.stringify({ versionId: r.versionId, stamp: 'x', anchors: { '/index.html': anchorSha } }), { status: 200 });
          }
          return new Response(okAnchor.body, { status: 200 });
        },
      },
    });

    const clean = (await (await app.request('/api/publish/status', { headers: { cookie } }, mk(okAnchor.sha) as unknown as typeof env)).json()) as {
      drift: unknown;
    };
    expect(clean.drift, '实物与印记一致时不该报警').toBeNull();

    const dirty = (await (await app.request('/api/publish/status', { headers: { cookie } }, mk('b'.repeat(64)) as unknown as typeof env)).json()) as {
      drift: { dbLive: number; tampered?: string[] } | null;
    };
    expect(dirty.drift, '实物被改过必须报出来').not.toBeNull();
    expect(dirty.drift!.tampered).toContain('/index.html');
    expect(dirty.drift!.dbLive).toBe(r.versionId);
  });


  it('🔴🔴 第五次组合故障:swap ok 的响应丢了,重发必须把上线事务真正做完', async () => {
    const cookie = await login();
    await makeChange(cookie, '重放收敛测试');
    const r = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    const job = await claim(cookie);
    const e = envWithStamp({ versionId: r.versionId, stamp: job.stamp, configSha: await shaOfVersion(r.versionId) });
    for (const step of ['materialize', 'gates', 'build']) {
      await postAs(e, cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step, status: 'running' });
      await postAs(e, cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step, status: 'ok' });
    }
    await postAs(e, cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'swap', status: 'running' });

    /* 模拟「服务端收到并处理了,但响应在回程丢了」:先把 swap 记成 ok 而**不触发上线事务**,
       这正是丢响应那一刻数据库的样子;然后执行器重发同一条回报。 */
    await env.DB.prepare("UPDATE publish_steps SET status='ok', ended_at=?2 WHERE version_id=?1 AND step='swap'").bind(r.versionId, Date.now()).run();
    /* 🔴 锁也要删掉才是真实形态(2026-09-01 第六轮,192 格表抓出我这条测试的失真):
       终态回报**本来就会释放锁**,所以「回报送到了、响应丢了」那一刻,库里是没有锁的。
       原来这条测试保留了锁,于是它测的是一个现实中不会出现的状态,重放路径里
       「口令从哪里读」这个关键分歧被它盖住了。 */
    await env.DB.prepare('DELETE FROM publish_lock').run();
    const beforeLive = await env.DB.prepare("SELECT id FROM config_versions WHERE status='live'").first<{ id: number }>();
    expect(beforeLive!.id, '这一刻这一版还没被标 live').not.toBe(r.versionId);

    const replay = await postAs(e, cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'swap', status: 'ok' });
    expect(replay.status, '重发不该被拒').toBe(200);
    const body = (await replay.json()) as { idempotent?: boolean; effectEnsured?: boolean };
    expect(body.idempotent).toBe(true);
    expect(body.effectEnsured, '重发必须把没做完的上线事务补上,而不是只回一句「已受理」').toBe(true);

    const live = await env.DB.prepare("SELECT id FROM config_versions WHERE status='live'").first<{ id: number }>();
    expect(live!.id, '重发之后这一版必须真的上线').toBe(r.versionId);
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM publish_lock').first<{ n: number }>())!.n, '锁必须已释放').toBe(0);

    // 再重发一次:收敛到同一终态,不叠加副作用
    const again = await postAs(e, cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'swap', status: 'ok' });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { effectEnsured?: boolean }).effectEnsured, '已经上线了就不该再"补"一次').toBe(false);
    const liveRows = await env.DB.prepare("SELECT COUNT(*) n FROM config_versions WHERE status='live'").first<{ n: number }>();
    expect(liveRows!.n, '只能有一个 live').toBe(1);
  });

  it('🔴 P1-5 上线核验那一刻资产层读不到 → 判为可重试,不判失败、不误诊成「被人改过」', async () => {
    const cookie = await login();
    await makeChange(cookie, '资产层不可用测试');
    const r = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    const job = await claim(cookie);
    const sha = await shaOfVersion(r.versionId);
    // 印记本身读得到,但锚点文件取不到(资产层抖动的形态)
    const flaky = {
      ...env,
      ASSETS: {
        fetch: async (req: Request) => {
          const path = new URL(req.url).pathname;
          if (path === '/.publish-stamp.json') {
            return new Response(JSON.stringify({ versionId: r.versionId, stamp: job.stamp, configSha: sha, anchors: { '/index.html': 'c'.repeat(64) } }), { status: 200 });
          }
          return new Response('upstream busy', { status: 503 });
        },
      },
    };
    for (const step of ['materialize', 'gates', 'build']) {
      await postAs(flaky, cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step, status: 'running' });
      await postAs(flaky, cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step, status: 'ok' });
    }
    await postAs(flaky, cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'swap', status: 'running' });
    const res = await postAs(flaky, cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step: 'swap', status: 'ok' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string; why?: string };
    expect(body.error, '读不到 ≠ 被改过').toBe('live-check-unavailable');
    expect(body.why).toContain('稍后重试');
    // 版本没被判死、锁还在 → 执行器重试还能接着走
    const v = await env.DB.prepare('SELECT status FROM config_versions WHERE id=?1').bind(r.versionId).first<{ status: string }>();
    expect(v!.status, '环境抖动不该把这一版判失败').toBe('publishing');
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM publish_lock').first<{ n: number }>())!.n, '锁不该被释放').toBe(1);
  });


  it('🔴 版本列表截断时:必须说出来,且当前线上那一行不许消失', async () => {
    const cookie = await login();
    await makeChange(cookie, '截断测试');
    const r = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    await runPipeline(cookie, r.versionId); // r 成为 live

    // 造 40 条更新的版本行,把 live 挤出「最近 30 条」之外
    for (let i = 0; i < 40; i++) {
      await env.DB
        .prepare("INSERT INTO config_versions (status, payload, created_by, created_at) VALUES ('failed', '{}', 'admin', ?1)")
        .bind(Date.now() + i)
        .run();
    }
    const s = await status(cookie);
    const rows = s.versions as Array<{ id: number; status: string }>;
    expect(s.versionsTruncated, '被截断了就要说出来').toBe(true);
    expect(rows.some((v) => v.id === r.versionId), '当前线上那一行不许被截断吞掉').toBe(true);
    expect(rows.filter((v) => v.status === 'live')).toHaveLength(1);
  });


  it('🔴 /status 报的「能不能取消」必须与 /cancel 的真实行为一致', async () => {
    const cookie = await login();

    // ① 没有进行中的发布
    expect((await status(cookie)).cancelable).toBe('none');

    // ② 排队态(领了单但一步没报)→ 可直接取消,且真取消得掉
    await makeChange(cookie, '取消能力-排队');
    const r1 = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    expect((await status(cookie)).cancelable).toBe('yes');
    expect((await post(cookie, '/api/publish/cancel')).status).toBe(200);

    // ③ 已开工且执行器仍活着 → 报 no,且真取消会被拒
    await makeChange(cookie, '取消能力-在跑');
    const r2 = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    const job = await claim(cookie);
    await post(cookie, '/api/publish/step', { versionId: r2.versionId, stamp: job.stamp, step: 'materialize', status: 'running' });
    expect((await status(cookie)).cancelable).toBe('no');
    expect((await post(cookie, '/api/publish/cancel')).status).toBe(409);

    // ④ 失联超阈值 → 报 force,且带理由能真中止
    await env.DB.prepare('UPDATE publish_steps SET started_at=?1, ended_at=NULL WHERE version_id=?2').bind(Date.now() - 13 * 60_000, r2.versionId).run();
    expect((await status(cookie)).cancelable).toBe('force');
    expect((await post(cookie, '/api/publish/cancel', { force: true, reason: '执行器所在机器断电' })).status).toBe(200);
    expect(r1.versionId).not.toBe(r2.versionId);
  });


  it('版本列表的「改动数」要算得对,算不出来就留空(不编一个数)', async () => {
    const cookie = await login();
    await makeChange(cookie, '改动数-第一版');
    const r1 = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    await runPipeline(cookie, r1.versionId);

    // 相对上一版只改一处文案 → 改动数应为 1
    await makeChange(cookie, '改动数-第二版');
    const r2 = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    await runPipeline(cookie, r2.versionId);

    const rows = (await status(cookie)).versions as Array<{ id: number; changed?: number }>;
    expect(rows.find((v) => v.id === r2.versionId)?.changed, '只改一处文案 → 1 处').toBe(1);

    // 空壳版本(payload='{}')算不出来 → 必须留空,而不是给 0 或别的数
    await env.DB.prepare("INSERT INTO config_versions (status, payload, created_by, created_at) VALUES ('failed', '{}', 'admin', ?1)").bind(Date.now() + 1000).run();
    const rows2 = (await status(cookie)).versions as Array<{ id: number; changed?: number; status: string }>;
    const shell = rows2.find((v) => v.status === 'failed' && v.changed === undefined);
    expect(shell, '算不出来的版本必须留空(undefined),不许编数').toBeDefined();
  });


  it('🔴🔴 产品卡的事实字段必须被判高敏(此前判据形状对不上,从上线起就没生效过)', async () => {
    const cookie = await login();
    const o = (await (await app.request('/api/config', { headers: { cookie } }, env)).json()) as {
      draft: { payload: Record<string, any>; draftRev: number };
    };
    const draft = structuredClone(o.draft.payload);
    draft.skus[0].priceUSD = Number(draft.skus[0].priceUSD) + 100; // 改一个事实字段:价格
    expect((await app.request('/api/config/draft', { method: 'PUT', headers: J(cookie), body: JSON.stringify({ payload: draft, baseRevision: o.draft.draftRev }) }, env)).status).toBe(200);

    const pre = (await (await app.request('/api/publish/preflight', { headers: { cookie } }, env)).json()) as {
      changedPaths: string[]; sensitiveChanged: string[]; reasonRequired: boolean;
    };
    /* 🔴 这条断言钉的是**承诺**:产品卡的事实字段改动要被判高敏、发布须理由。
       此前判据写的是 `skus.<键>.` 点号路径,而 diff 对数组产出 `skus[0].priceUSD` 方括号,
       两种写法从不相交——于是改价可以零理由直接上线,而页面上还标着「事实字段高敏」。
       测试同时断言「真实 diff 产物」确实是方括号形状,免得哪天 diff 改了口径而判据没跟上。 */
    expect(pre.changedPaths.some((x) => x.includes('priceUSD')), '改价必须出现在改动清单里').toBe(true);
    expect(pre.sensitiveChanged.some((x) => x.includes('priceUSD')), '改价必须被判高敏').toBe(true);
    expect(pre.reasonRequired, '含高敏改动时必须要求填理由').toBe(true);

    // 且服务端真的会拦:不给理由 → 400
    const noReason = await post(cookie, '/api/publish');
    expect(noReason.status).toBe(400);
    expect(((await noReason.json()) as { error?: string }).error).toBe('reason-required');
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

/* ══ 上报接口转移表:穷举 4(已记录)× 3(本次上报)× 4(锁状态)= 48 格 ══
   🔴 为什么必须穷举(2026-09-01 第五轮后的结构性反思,见
   `docs/changes/2026-09-01-publish-step-structural-reflection.md`):
   这个接口上的校验是四轮里一条条累加出来的否决清单,而「合法与否」从没有被完整表达过。
   四次组合故障全部落在交叉处——第四次就落在「已记录=ok × 上报=ok × 无锁」这一格:
   终态回报会先删锁,于是它的重发走不到幂等,一次**完全成功的发布**把执行器打死了。
   抽样测试 = 只测我想到的那几格,而想不到的那一格就够打死执行器。所以这里逐格断言。 */
describe('CON13 上报转移表(192 格穷举)', () => {
  type Recorded = 'none' | 'running' | 'ok' | 'failed';
  type Reported = 'running' | 'ok' | 'failed';
  type LockState = 'ours' | 'none' | 'other' | 'expired';
  type Step = 'materialize' | 'gates' | 'build' | 'swap';

  /* 期望结论。
     🔴 补上「哪一步」这个维度(第六轮 P1-6):原表只跑第一步,而**前序顺序**这条判据
     对第二步之后才会命中——换成 gates/build/swap 时三格全预测错,那张表其实只在 materialize 上成立。
     「穷举」的前提是维度取齐;少一维,穷举就变成了抽样。
     本表按 PRD CON13-④ 与两层结构独立推导,不照抄实现:
     第一层(与锁无关)先判幂等与改口;第二层才看授权与顺序。 */
  function expected(rec: Recorded, rep: Reported, lock: LockState, step: Step, priorDone: boolean): string {
    if (rec === rep) return rep === 'running' ? 'idempotent' : 'idempotent'; // 同结果重报:与锁、与顺序都无关
    if (rec === 'ok' || rec === 'failed') return 'step-already-done'; // 已收口不许改口,与锁、与顺序都无关
    // 到这里 rec ∈ {none, running},确实要改状态 → 才看授权
    if (lock === 'none' || lock === 'other') return 'not-current-job';
    if (lock === 'expired') return 'lock-expired';
    if (!priorDone) return 'step-out-of-order'; // 前序没跑完
    if (rec === 'none' && rep !== 'running') return 'step-not-running';
    return 'write';
  }

  const STEPS: Step[] = ['materialize', 'gates', 'build', 'swap'];
  const RECORDED: Recorded[] = ['none', 'running', 'ok', 'failed'];
  const REPORTED: Reported[] = ['running', 'ok', 'failed'];
  const LOCKS: LockState[] = ['ours', 'none', 'other', 'expired'];

  /** 造出「这一步之前的步骤都已 ok」的局面,再把本步与锁摆成指定状态 */
  async function setup(cookie: string, step: Step, rec: Recorded, lock: LockState, seq: number) {
    await makeChange(cookie, `表格用例-${step}-${rec}-${lock}-${seq}`);
    const r = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    const job = await claim(cookie);
    for (const prev of STEPS.slice(0, STEPS.indexOf(step))) {
      await env.DB
        .prepare("INSERT INTO publish_steps (version_id, step, status, started_at, ended_at) VALUES (?1, ?2, 'ok', ?3, ?3)")
        .bind(r.versionId, prev, Date.now())
        .run();
    }
    if (rec !== 'none') {
      await env.DB
        .prepare('INSERT INTO publish_steps (version_id, step, status, started_at, ended_at) VALUES (?1, ?2, ?3, ?4, ?5)')
        .bind(r.versionId, step, rec, Date.now(), rec === 'running' ? null : Date.now())
        .run();
    }
    if (lock === 'none') await env.DB.prepare('DELETE FROM publish_lock').run();
    if (lock === 'other') await env.DB.prepare('UPDATE publish_lock SET version_id = version_id + 1000').run();
    if (lock === 'expired') await env.DB.prepare('UPDATE publish_lock SET expires_at = ?1').bind(Date.now() - 1000).run();
    return { versionId: r.versionId, stamp: job.stamp };
  }

  it('192 格逐格与转移表一致', async () => {
    const cookie = await login();
    const bad: string[] = [];
    let n = 0;
    for (const step of STEPS) {
      for (const rec of RECORDED) {
        for (const rep of REPORTED) {
          for (const lk of LOCKS) {
            n++;
            const { versionId, stamp } = await setup(cookie, step, rec, lk, n);
            /* swap 的成功还要过上线核验;本表验的是**转移合法性**,不是核验本身,
               所以给一个能过核验的替身,让 swap 的 'write' 格不被核验结果污染。 */
            const e =
              step === 'swap'
                ? envWithStamp({ versionId, stamp, configSha: await shaOfVersion(versionId) })
                : env;
            const res = await postAs(e, cookie, '/api/publish/step', { versionId, stamp, step, status: rep });
            const body = (await res.json()) as { ok?: boolean; idempotent?: boolean; error?: string };
            const want = expected(rec, rep, lk, step, true); // setup 已把前序全铺成 ok
            const got = body.idempotent ? 'idempotent' : res.status === 200 ? 'write' : String(body.error ?? '').split('(')[0];
            if (got !== want) bad.push(`步=${step} 已记录=${rec} 上报=${rep} 锁=${lk} → 期望 ${want},实际 ${got}(HTTP ${res.status})`);
            await env.DB.prepare('DELETE FROM publish_steps').run();
            await env.DB.prepare('DELETE FROM publish_lock').run();
            await env.DB.prepare("UPDATE config_versions SET status='failed' WHERE status IN ('validating','publishing')").run();
          }
        }
      }
    }
    expect(n, '必须真的跑满 192 格').toBe(192);
    expect(bad, `\n${bad.join('\n')}`).toEqual([]);
  }, 300_000);

  it('前序未完成时,任何步的写入都必须被判顺序错(表的另一半)', async () => {
    const cookie = await login();
    const bad: string[] = [];
    for (const step of ['gates', 'build', 'swap'] as const) {
      await makeChange(cookie, `前序缺失-${step}`);
      const r = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
      const job = await claim(cookie);
      // 故意不铺前序
      const res = await post(cookie, '/api/publish/step', { versionId: r.versionId, stamp: job.stamp, step, status: 'running' });
      const body = (await res.json()) as { error?: string };
      const want = expected('none', 'running', 'ours', step, false);
      const got = String(body.error ?? '').split('(')[0];
      if (got !== want) bad.push(`步=${step} 前序缺失 → 期望 ${want},实际 ${got}`);
      await env.DB.prepare('DELETE FROM publish_steps').run();
      await env.DB.prepare('DELETE FROM publish_lock').run();
      await env.DB.prepare("UPDATE config_versions SET status='failed' WHERE status IN ('validating','publishing')").run();
    }
    expect(bad, `\n${bad.join('\n')}`).toEqual([]);
  }, 60_000);
});
