// T21 验收(plan;继承 CON13-A1/A2/E1/E2/E3/E4 与 ④ 状态机/禁止动作)。
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index';

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

/** 走完整一轮成功发布(模拟执行器逐步回报) */
async function runPipeline(cookie: string, versionId: number) {
  for (const step of ['materialize', 'gates', 'build', 'swap']) {
    expect((await post(cookie, '/api/publish/step', { versionId, step, status: 'running' })).status).toBe(200);
    expect((await post(cookie, '/api/publish/step', { versionId, step, status: 'ok' })).status).toBe(200);
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
    await post(cookie, '/api/publish/step', { versionId: r.versionId, step: 'materialize', status: 'running' });
    await post(cookie, '/api/publish/step', { versionId: r.versionId, step: 'materialize', status: 'ok' });
    await post(cookie, '/api/publish/step', { versionId: r.versionId, step: 'gates', status: 'running' });
    const fail = await post(cookie, '/api/publish/step', { versionId: r.versionId, step: 'gates', status: 'failed', gate: 'render-fit', detail: 'x' });
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
    await post(cookie, '/api/publish/step', { versionId: r2.versionId, step: 'materialize', status: 'running' });
    await post(cookie, '/api/publish/step', { versionId: r2.versionId, step: 'materialize', status: 'ok' });
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

  it('🔴 P0-1 步骤顺序不可跳:发起后直接报 swap ok 必须被拒,版本不得 live', async () => {
    const cookie = await login();
    await makeChange(cookie);
    const r = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    // 形态①:一步不跑,直接收口最后一步
    const jump = await post(cookie, '/api/publish/step', { versionId: r.versionId, step: 'swap', status: 'ok' });
    expect(jump.status).toBe(409);
    expect(((await jump.json()) as any).error).toBe('step-out-of-order');
    // 形态②:先声明 swap running 再 ok(绕开「必须先 running」那道)——前序缺失仍应拒
    expect((await post(cookie, '/api/publish/step', { versionId: r.versionId, step: 'swap', status: 'running' })).status).toBe(409);
    // 形态③:跳过 gates(物化 ok 后直接 build)
    await post(cookie, '/api/publish/step', { versionId: r.versionId, step: 'materialize', status: 'running' });
    await post(cookie, '/api/publish/step', { versionId: r.versionId, step: 'materialize', status: 'ok' });
    const skipGates = await post(cookie, '/api/publish/step', { versionId: r.versionId, step: 'build', status: 'running' });
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
    const noRunning = await post(cookie, '/api/publish/step', { versionId: r.versionId, step: 'materialize', status: 'ok' });
    expect(noRunning.status).toBe(409);
    expect(((await noRunning.json()) as any).error).toContain('step-not-running');
    await post(cookie, '/api/publish/step', { versionId: r.versionId, step: 'materialize', status: 'running' });
    expect((await post(cookie, '/api/publish/step', { versionId: r.versionId, step: 'materialize', status: 'ok' })).status).toBe(200);
    expect((await post(cookie, '/api/publish/step', { versionId: r.versionId, step: 'materialize', status: 'ok' })).status).toBe(409); // 重复
  });

  it('🔴 P0-2 锁过期后 step 一律拒收(此前过期锁照收即可上线)', async () => {
    const cookie = await login();
    await makeChange(cookie);
    const r = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    await post(cookie, '/api/publish/step', { versionId: r.versionId, step: 'materialize', status: 'running' });
    await env.DB.prepare('UPDATE publish_lock SET expires_at = ?1').bind(Date.now() - 1000).run();
    const res = await post(cookie, '/api/publish/step', { versionId: r.versionId, step: 'materialize', status: 'ok' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).error).toContain('lock-expired');
  });

  it('P1 执行器租约:已被领取的任务不再派发给第二个执行器', async () => {
    const cookie = await login();
    await makeChange(cookie);
    const r = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    const first = (await (await app.request('/api/publish/next', { headers: { cookie } }, env)).json()) as { job: { versionId: number } | null };
    expect(first.job!.versionId).toBe(r.versionId);
    await post(cookie, '/api/publish/step', { versionId: r.versionId, step: 'materialize', status: 'running' }); // 第一个执行器开工
    const second = (await (await app.request('/api/publish/next', { headers: { cookie } }, env)).json()) as { job: unknown; note?: string };
    expect(second.job).toBeNull();
    expect(second.note).toBe('already-claimed');
  });

  it('P1 失败态可取回步骤日志(此前只对进行中版本返回,失败后日志取不回)', async () => {
    const cookie = await login();
    await makeChange(cookie);
    const r = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    await post(cookie, '/api/publish/step', { versionId: r.versionId, step: 'materialize', status: 'running' });
    await post(cookie, '/api/publish/step', { versionId: r.versionId, step: 'materialize', status: 'ok' });
    await post(cookie, '/api/publish/step', { versionId: r.versionId, step: 'gates', status: 'running' });
    await post(cookie, '/api/publish/step', { versionId: r.versionId, step: 'gates', status: 'failed', gate: 'render-fit', detail: '门日志尾部若干行' });
    const s = await status(cookie);
    expect(s.activeVersion).toBeNull();
    expect(s.stepsOfVersion).toBe(r.versionId);
    expect((s.steps as { status: string; detail: string | null }[]).find((x) => x.status === 'failed')?.detail).toContain('门日志尾部');
  });

  it('P1 取消仅限排队态:任何步骤开始后即不可取消', async () => {
    const cookie = await login();
    await makeChange(cookie);
    const r = (await (await post(cookie, '/api/publish')).json()) as { versionId: number };
    await post(cookie, '/api/publish/step', { versionId: r.versionId, step: 'materialize', status: 'running' }); // 仅 running,未完成
    const res = await post(cookie, '/api/publish/cancel');
    expect(res.status).toBe(409);
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
    await post(cookie, '/api/publish/step', { versionId: r.versionId, step: 'materialize', status: 'running' });
    await post(cookie, '/api/publish/step', { versionId: r.versionId, step: 'materialize', status: 'ok' });
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
