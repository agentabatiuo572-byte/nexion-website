import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/index';
import type { Env } from '../src/env';
import { maintainPublishing } from '../src/publish';
import { LOCALES, MATERIALIZED_FILES, addLegacyLocaleFields, SiteConfigSchema, materializeI18n, materializeSiteJson, type SiteConfig } from '../../schema/src/index.js';
import manifestJson from '../seed/copy-manifest.json';
import currentSeedJson from '../seed/site-config.seed.json';
import legacyJson from '../seed/config-upgrade-legacy-v1.json';
import { CONFIG_UPGRADE_KEY } from '../src/config-upgrade';

const secret = 'test-service-secret-with-at-least-32-characters';
const local = () => ({ ...env, PUBLISH_RUNNER_TOKEN: secret, PUBLISH_EXECUTION_MODE: 'local' }) as Env;
const github = () => ({
  ...local(),
  ENVIRONMENT:'production',
  PUBLISH_EXECUTION_MODE:'github',
  PUBLISH_GITHUB_REPOSITORY:'agentabatiuo572-byte/nexion-website',
  PUBLISH_GITHUB_WORKFLOW:'publish-website.yml',
  PUBLISH_GITHUB_REF:'main',
  PUBLISH_GITHUB_TOKEN:'github-test-token-long-enough',
}) as Env;
const request = (path: string, body: unknown = {}, e = local(), headers: Record<string, string> = {}) =>
  app.request(`/api/publish${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}`, ...headers }, body: JSON.stringify(body) }, e);
let cookie = '';
async function change() {
  const response = await app.request('/api/config', {headers:{cookie}}, local());
  const state = await response.json() as {draft:{payload:{copy:{en:Record<string,string>}};draftRev:number}};
  state.draft.payload.copy.en['hero.scrollHint'] = '自动发布验证';
  const saved = await app.request('/api/config/draft', {method:'PUT',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({payload:state.draft.payload,baseRevision:state.draft.draftRev})},local());
  expect(saved.status).toBe(200);
}
const publish = async (e=local()) => {
  const preflight = await app.request('/api/publish/preflight',{headers:{cookie}},e);
  expect(preflight.status).toBe(200);
  const {draftRev} = await preflight.json() as {draftRev:number};
  return request('',{draftRev},e,{cookie});
};
async function swapJob() {
  await change(); await request('/heartbeat',{runnerId:'r1'});
  const {versionId} = await (await publish()).json() as {versionId:number};
  const {job} = await (await request('/next',{runnerId:'r1'})).json() as {job:{stamp:string}};
  const body = {versionId,stamp:job.stamp,runnerId:'r1'};
  for (const step of ['materialize','gates','build']) {
    expect((await request('/step',{...body,step,status:'running'})).status).toBe(200);
    expect((await request('/step',{...body,step,status:'ok'})).status).toBe(200);
  }
  expect((await request('/step',{...body,step:'swap',status:'running'})).status).toBe(200);
  return body;
}
async function snapshotFor(job:{versionId:number;stamp:string}, deliveredConfig?:SiteConfig) {
  const version = await env.DB.prepare('SELECT payload FROM config_versions WHERE id=?1').bind(job.versionId).first<{payload:string}>();
  const config = deliveredConfig ?? SiteConfigSchema.parse(JSON.parse(version!.payload));
  const files = MATERIALIZED_FILES;
  const contents = [...LOCALES.map(loc=>materializeI18n(config,manifestJson as never,loc)),materializeSiteJson(config)];
  const sha = async(text:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))), b=>b.toString(16).padStart(2,'0')).join('');
  const html = 'verified publication page';
  return {html,stamp:{...job,configSha:await sha(files.map((file,i)=>`${file}\0${contents[i]}`).join('\0')),anchors:{'/index.html':await sha(html)}}};
}
function legacyConfig(conflict = false) {
  const config = SiteConfigSchema.parse(structuredClone(currentSeedJson));
  for (const locale of ['en', 'vi', 'zh'] as const) {
    const defaults = legacyJson.copyDefaults[locale] as Record<string,string>;
    config.copy[locale] = Object.fromEntries(legacyJson.copyKeys.map(key=>[key,Object.hasOwn(defaults,key) ? defaults[key] : config.copy[locale][key]]));
  }
  config.enabledLocales = ['en', 'vi'];
  config.faq = (addLegacyLocaleFields({ faq: legacyJson.faq }, manifestJson.editable) as SiteConfig).faq;
  config.copy.en['hero.title'] = 'A carefully preserved authored title';
  if (conflict) config.copy.en['trust.card1'] = 'Authored historical trust text';
  return config;
}
async function storeLegacyDraft(conflict = false) {
  await app.request('/api/config',{headers:{cookie}},local());
  const payload = JSON.stringify(legacyConfig(conflict));
  // Historical drafts predate translation provenance; don't retain the fresh seed's ownership.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM translation_jobs'),
    env.DB.prepare('DELETE FROM translation_state'),
    env.DB.prepare('UPDATE config_draft SET payload=?1 WHERE id=1').bind(payload),
    env.DB.prepare('DELETE FROM config_draft_upgrades'),
  ]);
  return payload;
}
beforeEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await env.DB.prepare('DELETE FROM translation_jobs').run();
  await env.DB.prepare('DELETE FROM translation_state').run();
  await env.DB.prepare('DELETE FROM publish_runner').run();
  await env.DB.prepare('DELETE FROM publish_dispatch').run();
  for (const table of ['audit','sessions','login_throttle','auth_account','config_versions','config_draft','publish_lock','publish_steps']) await env.DB.prepare(`DELETE FROM ${table}`).run();
  await app.request('/api/auth/setup', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ token: env.SETUP_TOKEN, password: 'test-executor-password!' }) }, env);
  const r = await app.request('/api/auth/login', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({password:'test-executor-password!'}) }, env);
  cookie = (r.headers.get('set-cookie') ?? '').split(';')[0]!;
});

describe('automatic publishing service boundary', () => {
  it('persists current command progress without adding steps, resetting start time or renewing the lease', async () => {
    await change(); await request('/heartbeat',{runnerId:'r1'});
    const {versionId} = await (await publish()).json() as {versionId:number};
    const {job} = await (await request('/next',{runnerId:'r1'})).json() as {job:{stamp:string}};
    const report = {versionId,stamp:job.stamp,runnerId:'r1',step:'materialize',status:'running'};
    expect((await request('/step',{...report,detail:'准备站点配置'})).status).toBe(200);
    const step = await env.DB.prepare('SELECT * FROM publish_steps WHERE version_id=?1').bind(versionId).first();
    const lock = await env.DB.prepare('SELECT * FROM publish_lock WHERE version_id=?1').bind(versionId).first();
    expect(step).toMatchObject({detail:'准备站点配置',status:'running',ended_at:null});
    for (const detail of ['正在检查中文页面','正在检查中文页面','x'.repeat(6100)+'检查结束']) {
      expect((await request('/step',{...report,detail})).status).toBe(200);
      expect((await env.DB.prepare('SELECT * FROM publish_steps WHERE version_id=?1').bind(versionId).all()).results)
        .toEqual([{...step,detail:detail.slice(-6000)}]);
      expect(await env.DB.prepare('SELECT * FROM publish_lock WHERE version_id=?1').bind(versionId).first()).toEqual(lock);
      const poll = await app.request('/api/publish/status',{headers:{cookie}},local());
      expect(await poll.json()).toMatchObject({activeVersion:versionId,steps:[{detail:detail.slice(-6000)}]});
    }
    expect((await request('/step',report)).status).toBe(200);
    expect(await env.DB.prepare('SELECT status FROM config_versions WHERE id=?1').bind(versionId).first()).toEqual({status:'publishing'});
  });
  it('rejects invalid progress details, wrong owners, expired leases and closed steps or versions', async () => {
    await change(); await request('/heartbeat',{runnerId:'r1'});
    const {versionId} = await (await publish()).json() as {versionId:number};
    const {job} = await (await request('/next',{runnerId:'r1'})).json() as {job:{stamp:string}};
    const report = {versionId,stamp:job.stamp,runnerId:'r1',step:'materialize',status:'running'};
    expect((await request('/step',{...report,detail:'可信进度'})).status).toBe(200);
    for (const detail of [123,[],{}]) expect((await request('/step',{...report,detail})).status).toBe(400);
    for (const wrong of [{runnerId:'r2'},{stamp:'wrong'}]) {
      expect((await request('/step',{...report,...wrong,detail:'不应写入'})).status).toBe(409);
    }
    const lock = await env.DB.prepare('SELECT expires_at FROM publish_lock WHERE version_id=?1').bind(versionId).first<{expires_at:number}>();
    for (const wrong of ["claimed_by='r2'", "claim_nonce='wrong'", 'claimed_at=NULL', 'expires_at=0']) {
      await env.DB.prepare(`UPDATE publish_lock SET ${wrong} WHERE version_id=?1`).bind(versionId).run();
      expect((await request('/step',{...report,detail:'不应写入'})).status).toBe(409);
      await env.DB.prepare('UPDATE publish_lock SET claimed_by=?2,claim_nonce=?3,claimed_at=?4,expires_at=?5 WHERE version_id=?1')
        .bind(versionId,'r1',job.stamp,Date.now(),lock!.expires_at).run();
    }
    for (const status of ['failed','cancelled','unknown','archived']) {
      await env.DB.prepare('UPDATE config_versions SET status=?2 WHERE id=?1').bind(versionId,status).run();
      expect((await request('/step',{...report,detail:'不应写入'})).status).toBe(409);
    }
    expect(await env.DB.prepare('SELECT detail FROM publish_steps WHERE version_id=?1').bind(versionId).first()).toEqual({detail:'可信进度'});
    await env.DB.prepare("UPDATE config_versions SET status='publishing' WHERE id=?1").bind(versionId).run();
    expect((await request('/step',{...report,status:'ok',detail:'准备成功'})).status).toBe(200);
    expect((await request('/step',{...report,detail:'迟到的进度'})).status).toBe(409);
    expect(await env.DB.prepare('SELECT status,detail FROM publish_steps WHERE version_id=?1').bind(versionId).first()).toEqual({status:'ok',detail:'准备成功'});
  });
  it('normalizes historical object key order at claim without rewriting the snapshot, then verifies all four steps live', async () => {
    await change(); await request('/heartbeat',{runnerId:'r1'});
    const {versionId} = await (await publish()).json() as {versionId:number};
    const version = await env.DB.prepare('SELECT payload FROM config_versions WHERE id=?1').bind(versionId).first<{payload:string}>();
    const historical = JSON.parse(version!.payload) as SiteConfig;
    historical.announcement.text = Object.fromEntries([...LOCALES].reverse().map(locale=>[locale,historical.announcement.text[locale]])) as typeof historical.announcement.text;
    const payload = JSON.stringify(historical);
    await env.DB.prepare('UPDATE config_versions SET payload=?2 WHERE id=?1').bind(versionId,payload).run();
    const claimed = await request('/next',{runnerId:'r1'});
    expect(claimed.status).toBe(200);
    const {job} = await claimed.json() as {job:{versionId:number;stamp:string;config:SiteConfig}};
    const identity = {versionId,stamp:job.stamp,runnerId:'r1'};
    // Runner materializes the exact API config; only the independent server expectation parses storage.
    const delivered = await snapshotFor(identity,job.config);
    const raw = await snapshotFor(identity,historical);
    const expected = await snapshotFor(identity);
    expect(raw.stamp.configSha).not.toBe(expected.stamp.configSha);
    expect(delivered.stamp.configSha).toBe(expected.stamp.configSha);
    const served = {...local(),ASSETS:{fetch:async(req:Request)=>new URL(req.url).pathname==='/.publish-stamp.json'
      ? new Response(JSON.stringify(delivered.stamp)) : new Response(delivered.html)}} as unknown as Env;
    for (const step of ['materialize','gates','build','swap']) {
      expect((await request('/step',{...identity,step,status:'running'},served)).status).toBe(200);
      expect((await request('/step',{...identity,step,status:'ok'},served)).status).toBe(200);
    }
    expect(await env.DB.prepare('SELECT status,payload,fail_reason FROM config_versions WHERE id=?1').bind(versionId).first()).toEqual({status:'live',payload,fail_reason:null});
    expect((await env.DB.prepare('SELECT step,status FROM publish_steps WHERE version_id=?1 ORDER BY id').bind(versionId).all()).results).toEqual(
      ['materialize','gates','build','swap'].map(step=>({step,status:'ok'})),
    );
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM publish_lock').first()).toEqual({n:0});
    const status = await app.request('/api/publish/status',{headers:{cookie}},served);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({activeVersion:null,drift:null,versions:expect.arrayContaining([expect.objectContaining({id:versionId,status:'live'})])});
  });
  it('machine bearer can heartbeat without a browser session', async () => {
    const r = await request('/heartbeat', {runnerId:'test-runner'});
    expect(r.status).toBe(200);
    const state = await app.request('/api/publish/runner-state?runnerId=test-runner', {headers:{authorization:`Bearer ${secret}`}}, local());
    expect(await state.json()).toMatchObject({environment:'dev', executor:{ready:true,mode:'local'}});
  });
  it('browser cookie cannot claim or report execution; bearer cannot publish or edit', async () => {
    for (const p of ['/next','/heartbeat','/step','/runner-fail']) {
      expect((await request(p, {}, local(), {authorization:'',cookie})).status).toBe(401);
    }
    expect((await request('', {})).status).toBe(401);
    expect((await app.request('/api/config', {headers:{authorization:`Bearer ${secret}`}}, local())).status).toBe(401);
    expect((await request('/heartbeat', {runnerId:'test'}, local(), {authorization:'Bearer wrong'})).status).toBe(401);
  });
  it('production cannot fall back to a local or unconfigured executor', async () => {
    const e = {...local(), ENVIRONMENT:'production'};
    const r = await app.request('/api/publish/executor', {headers:{cookie}}, e);
    expect(await r.json()).toMatchObject({ready:false});
  });
  it('offline service rejects before a version is queued; heartbeat makes publishing available', async () => {
    await change();
    expect((await publish()).status).toBe(503);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM publish_lock').first()).toMatchObject({n:0});
    await request('/heartbeat',{runnerId:'r1'});
    const started = await publish();
    expect(started.status).toBe(200);
    const {versionId} = await started.json() as {versionId:number};
    expect(await (await request('/next',{runnerId:'r1',versionId:versionId+1})).json()).toMatchObject({job:null});
    const {job} = await (await request('/next',{runnerId:'r1',versionId})).json() as {job:{versionId:number;stamp:string}};
    expect(job.versionId).toBe(versionId);
    expect(await (await request('/next',{runnerId:'r2',versionId})).json()).toMatchObject({job:null});
    expect((await request('/heartbeat',{...job,runnerId:'r2'})).status).toBe(409);
    expect(await (await request('/next',{runnerId:'r1',versionId})).json()).toMatchObject({job:{versionId,stamp:job.stamp}});
    expect((await request('/heartbeat',{runnerId:'r1',...job,stamp:'wrong'})).status).toBe(409);
    expect((await request('/heartbeat',{...job,runnerId:'r1'})).status).toBe(200);
    expect((await request('/step',{...job,runnerId:'r2',step:'materialize',status:'running'})).status).toBe(409);
    expect((await request('/step',{...job,runnerId:'r1',step:'materialize',status:'running'})).status).toBe(200);
    expect((await request('/runner-fail',{...job,runnerId:'r1',detail:'服务重启'})).status).toBe(200);
    expect(await env.DB.prepare('SELECT status FROM config_versions WHERE id=?1').bind(versionId).first()).toMatchObject({status:'failed'});
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM publish_lock').first()).toMatchObject({n:0});
    expect(await env.DB.prepare("SELECT actor FROM audit WHERE target=?1 AND action='config.publish.failed'").bind(`v${versionId}`).first()).toEqual({actor:'system'});
  });
  it.each([
    ['short', '发布构建中断'],
    ['runner limit', 'build output\n'.repeat(600).slice(0,5900) + 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'],
    ['over limit', 'build output\n'.repeat(1000) + 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'],
    ['omitted', undefined],
  ])('runner-fail persists and returns the diagnostic tail (%s)', async (_label, detail) => {
    await change(); await request('/heartbeat',{runnerId:'r1'});
    const {versionId} = await (await publish()).json() as {versionId:number};
    const {job} = await (await request('/next',{runnerId:'r1'})).json() as {job:{stamp:string}};
    const identity = {versionId,stamp:job.stamp,runnerId:'r1'};
    expect((await request('/step',{...identity,step:'materialize',status:'running'})).status).toBe(200);
    const failure = await request('/runner-fail',{...identity,detail});
    expect(failure.status).toBe(200);
    expect(await failure.json()).toMatchObject({terminal:true,live:false});
    const expected = (detail ?? '发布服务已重启，本次构建中断，草稿保留，可重新发布。').slice(-6000);
    expect(await env.DB.prepare('SELECT status,fail_reason FROM config_versions WHERE id=?1').bind(versionId).first()).toEqual({status:'failed',fail_reason:expected});
    expect(await env.DB.prepare('SELECT status,detail FROM publish_steps WHERE version_id=?1').bind(versionId).first()).toEqual({status:'failed',detail:expected});
    expect(await env.DB.prepare("SELECT after_summary FROM audit WHERE target=?1 AND action='config.publish.failed'").bind(`v${versionId}`).first()).toEqual({after_summary:expected});
    const status = await app.request('/api/publish/status',{headers:{cookie}},local());
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      activeVersion:null,
      stepsOfVersion:versionId,
      steps:[{status:'failed',detail:expected}],
      versions:expect.arrayContaining([expect.objectContaining({id:versionId,status:'failed',fail_reason:expected})]),
    });
  });
  it('runner-fail rejects malformed details and another job identity without closing the active job', async () => {
    await change(); await request('/heartbeat',{runnerId:'r1'});
    const {versionId} = await (await publish()).json() as {versionId:number};
    const {job} = await (await request('/next',{runnerId:'r1'})).json() as {job:{stamp:string}};
    const identity = {versionId,stamp:job.stamp,runnerId:'r1'};
    for (const detail of [123,[],{}]) expect((await request('/runner-fail',{...identity,detail})).status).toBe(400);
    for (const wrong of [{runnerId:'r2'},{stamp:'wrong'}]) {
      expect((await request('/runner-fail',{...identity,...wrong,detail:'untrusted report'})).status).toBe(409);
    }
    expect(await env.DB.prepare('SELECT status,fail_reason FROM config_versions WHERE id=?1').bind(versionId).first()).toEqual({status:'validating',fail_reason:null});
    expect(await env.DB.prepare('SELECT version_id FROM publish_lock').first()).toEqual({version_id:versionId});
  });
  it('machine runner-fail returns archived status without rewriting a previously published version', async () => {
    const job = await swapJob();
    const snapshot = await snapshotFor(job);
    const served = {...local(),ASSETS:{fetch:async(req:Request)=>new URL(req.url).pathname==='/.publish-stamp.json'
      ? new Response(JSON.stringify(snapshot.stamp)) : new Response(snapshot.html)}} as unknown as Env;
    expect((await request('/step',{...job,step:'swap',status:'ok'},served)).status).toBe(200);
    await env.DB.prepare("UPDATE config_versions SET status='archived' WHERE id=?1").bind(job.versionId).run();
    const original = await env.DB.prepare('SELECT * FROM config_versions WHERE id=?1').bind(job.versionId).first();
    const audits = (await env.DB.prepare('SELECT * FROM audit').all()).results;
    const steps = (await env.DB.prepare('SELECT * FROM publish_steps WHERE version_id=?1').bind(job.versionId).all()).results;
    const response = await request('/runner-fail',{...job,detail:'Late process cleanup failure'});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ok:true,terminal:true,live:false,status:'archived'});
    expect(await env.DB.prepare('SELECT * FROM config_versions WHERE id=?1').bind(job.versionId).first()).toEqual(original);
    expect((await env.DB.prepare('SELECT * FROM audit').all()).results).toEqual(audits);
    expect((await env.DB.prepare('SELECT * FROM publish_steps WHERE version_id=?1').bind(job.versionId).all()).results).toEqual(steps);
  });
  it('/next renews a near-expiry claim so its first job heartbeat survives the old lease boundary', async () => {
    await change(); await request('/heartbeat',{runnerId:'r1'});
    const {versionId} = await (await publish()).json() as {versionId:number};
    const oldExpiry = Date.now()+1_000;
    await env.DB.prepare('UPDATE publish_lock SET expires_at=?2 WHERE version_id=?1').bind(versionId,oldExpiry).run();
    const claimAt = oldExpiry-1;
    const clock = vi.spyOn(Date,'now').mockReturnValue(claimAt);

    const {job} = await (await request('/next',{runnerId:'r1',versionId})).json() as {job:{versionId:number;stamp:string}};
    expect(job).toMatchObject({versionId});
    expect(await env.DB.prepare('SELECT claimed_at,expires_at FROM publish_lock WHERE version_id=?1').bind(versionId).first()).toEqual({
      claimed_at:claimAt,
      expires_at:claimAt+15*60_000,
    });

    clock.mockReturnValue(oldExpiry+1);
    expect((await request('/heartbeat',{...job,runnerId:'r1'})).status).toBe(200);
  });
  it('/next renews a same-runner response-loss retry without letting a competing runner extend the lease', async () => {
    await change(); await request('/heartbeat',{runnerId:'r1'});
    const {versionId} = await (await publish()).json() as {versionId:number};
    const {job:firstJob} = await (await request('/next',{runnerId:'r1',versionId})).json() as {job:{versionId:number;stamp:string}};
    const firstClaim = await env.DB.prepare('SELECT claimed_at FROM publish_lock WHERE version_id=?1').bind(versionId).first<{claimed_at:number}>();
    const oldExpiry = Date.now()+1_000;
    await env.DB.prepare('UPDATE publish_lock SET expires_at=?2 WHERE version_id=?1').bind(versionId,oldExpiry).run();
    const retryAt = oldExpiry-1;
    const clock = vi.spyOn(Date,'now').mockReturnValue(retryAt);

    expect(await (await request('/next',{runnerId:'r2',versionId})).json()).toMatchObject({job:null});
    expect(await env.DB.prepare('SELECT claimed_at,claimed_by,expires_at FROM publish_lock WHERE version_id=?1').bind(versionId).first()).toEqual({
      claimed_at:firstClaim!.claimed_at,
      claimed_by:'r1',
      expires_at:oldExpiry,
    });

    const {job:retriedJob} = await (await request('/next',{runnerId:'r1',versionId})).json() as {job:{versionId:number;stamp:string}};
    expect(retriedJob).toMatchObject({versionId,stamp:firstJob.stamp});
    expect(await env.DB.prepare('SELECT claimed_at,claimed_by,expires_at FROM publish_lock WHERE version_id=?1').bind(versionId).first()).toEqual({
      claimed_at:firstClaim!.claimed_at,
      claimed_by:'r1',
      expires_at:retryAt+15*60_000,
    });

    clock.mockReturnValue(oldExpiry+1);
    expect((await request('/heartbeat',{...retriedJob,runnerId:'r1'})).status).toBe(200);
  });
  it('concurrent clicks create one active version, not a second failed history row', async () => {
    await change();
    await request('/heartbeat',{runnerId:'r1'});
    const responses = await Promise.all([publish(),publish()]);
    expect(responses.map(r=>r.status).sort()).toEqual([200,409]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM config_versions WHERE status='validating'").first()).toMatchObject({n:1});
  });
  it('a late running report cannot revive a version closed by a real runner-fail request', async () => {
    await change(); await request('/heartbeat',{runnerId:'r1'});
    const {versionId} = await (await publish()).json() as {versionId:number};
    const {job} = await (await request('/next',{runnerId:'r1'})).json() as {job:{stamp:string}};
    const identity = {versionId,stamp:job.stamp,runnerId:'r1'};
    let interrupted = false;
    const racing = {...local(),DB:{
      prepare:env.DB.prepare.bind(env.DB),
      batch:async(statements:D1PreparedStatement[])=>{
        if (!interrupted) {
          interrupted = true;
          expect(await (await request('/runner-fail',{...identity,detail:'concurrent interruption'})).json()).toMatchObject({terminal:true,live:false});
        }
        return env.DB.batch(statements);
      },
    } as D1Database};
    const result = await request('/step',{...identity,step:'materialize',status:'running'},racing);
    expect(interrupted).toBe(true);
    expect(result.status).toBe(409);
    expect(await env.DB.prepare('SELECT status FROM config_versions WHERE id=?1').bind(versionId).first()).toMatchObject({status:'failed'});
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM publish_steps WHERE version_id=?1').bind(versionId).first()).toMatchObject({n:0});
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM publish_lock').first()).toMatchObject({n:0});
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE target=?1 AND action='config.publish.failed'").bind(`v${versionId}`).first()).toMatchObject({n:1});
  });
  it('a real status poll never observes an initial version without its lock and dispatch record', async () => {
    await change();
    const e = {...local(),ENVIRONMENT:'production',PUBLISH_EXECUTION_MODE:'github',PUBLISH_GITHUB_REPOSITORY:'agentabatiuo572-byte/nexion-website',PUBLISH_GITHUB_WORKFLOW:'publish-website.yml',PUBLISH_GITHUB_REF:'main',PUBLISH_GITHUB_TOKEN:'github-test-token-long-enough'};
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(null,{status:204})));
    let observations = 0;
    let observed: unknown;
    const pollAfterInsert = async()=>{
      const inserted = await env.DB.prepare("SELECT id FROM config_versions WHERE created_by='admin' ORDER BY id DESC LIMIT 1").first<{id:number}>();
      if (!inserted || observations) return;
      observations++;
      expect((await app.request('/api/publish/status',{headers:{cookie}},e)).status).toBe(200);
      observed = await env.DB.prepare(`SELECT v.status,l.version_id AS locked,d.version_id AS dispatched
        FROM config_versions v LEFT JOIN publish_lock l ON l.version_id=v.id
        LEFT JOIN publish_dispatch d ON d.version_id=v.id WHERE v.id=?1`).bind(inserted.id).first();
    };
    const originals = new WeakMap<D1PreparedStatement,D1PreparedStatement>();
    const racing = {...e,DB:{
      prepare(sql:string){
        const statement = env.DB.prepare(sql);
        if (!/^INSERT INTO config_versions\b/.test(sql)) return statement;
        return {bind(...values:unknown[]){
          const bound = statement.bind(...values);
          const wrapped = {first:async()=>{const result=await bound.first(); await pollAfterInsert(); return result;}} as D1PreparedStatement;
          originals.set(wrapped,bound);
          return wrapped;
        }};
      },
      batch:async(statements:D1PreparedStatement[])=>{
        const result = await env.DB.batch(statements.map(statement=>originals.get(statement) ?? statement));
        await pollAfterInsert();
        return result;
      },
    } as unknown as D1Database};
    const started = await publish(racing);
    expect(started.status).toBe(200);
    const {versionId} = await started.json() as {versionId:number};
    expect(observations).toBe(1);
    expect(observed).toEqual({status:'validating',locked:versionId,dispatched:versionId});
    expect(await (await request('/next',{runnerId:'ci',versionId},e)).json()).toMatchObject({job:{versionId}});
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM config_versions WHERE status='failed'").first()).toMatchObject({n:0});
  });
  it.each([
    {
      name:'version owner write',
      trigger:`CREATE TRIGGER fail_claim_owner BEFORE UPDATE OF runner_id ON config_versions
        WHEN NEW.runner_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'injected-claim-owner-failure'); END`,
      drop:'fail_claim_owner',
    },
    {
      name:'dispatch state write',
      trigger:`CREATE TRIGGER fail_claim_dispatch BEFORE UPDATE OF state ON publish_dispatch
        WHEN NEW.state='claimed' BEGIN SELECT RAISE(ABORT, 'injected-claim-dispatch-failure'); END`,
      drop:'fail_claim_dispatch',
    },
  ])('/next rolls back the whole claim when $name fails, then a retry can claim', async ({trigger,drop}) => {
    await change();
    const e = github();
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(null,{status:204})));
    const started = await publish(e);
    expect(started.status).toBe(200);
    const {versionId} = await started.json() as {versionId:number};
    await env.DB.prepare(trigger).run();
    try {
      vi.spyOn(console,'error').mockImplementation(()=>{});
      expect((await request('/next',{runnerId:'ci',versionId},e)).status).toBe(500);
      expect(await env.DB.prepare('SELECT claimed_at,claimed_by FROM publish_lock WHERE version_id=?1').bind(versionId).first()).toEqual({claimed_at:null,claimed_by:null});
      expect(await env.DB.prepare('SELECT runner_id FROM config_versions WHERE id=?1').bind(versionId).first()).toEqual({runner_id:null});
      expect(await env.DB.prepare('SELECT state FROM publish_dispatch WHERE version_id=?1').bind(versionId).first()).toEqual({state:'waiting'});
    } finally {
      await env.DB.prepare(`DROP TRIGGER ${drop}`).run();
    }
    expect(await (await request('/next',{runnerId:'ci',versionId},e)).json()).toMatchObject({job:{versionId,runnerId:'ci'}});
    expect(await env.DB.prepare('SELECT claimed_by FROM publish_lock WHERE version_id=?1').bind(versionId).first()).toEqual({claimed_by:'ci'});
    expect(await env.DB.prepare('SELECT runner_id FROM config_versions WHERE id=?1').bind(versionId).first()).toEqual({runner_id:'ci'});
    expect(await env.DB.prepare('SELECT state FROM publish_dispatch WHERE version_id=?1').bind(versionId).first()).toEqual({state:'claimed'});
  });
  it('/next repairs a historical same-runner partial claim in one retry', async () => {
    await change();
    const e = github();
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(null,{status:204})));
    const started = await publish(e);
    expect(started.status).toBe(200);
    const {versionId} = await started.json() as {versionId:number};
    await env.DB.prepare('UPDATE publish_lock SET claimed_at=?2,claimed_by=?3 WHERE version_id=?1').bind(versionId,Date.now(),'ci').run();
    expect(await env.DB.prepare('SELECT runner_id FROM config_versions WHERE id=?1').bind(versionId).first()).toEqual({runner_id:null});
    expect(await env.DB.prepare('SELECT state FROM publish_dispatch WHERE version_id=?1').bind(versionId).first()).toEqual({state:'waiting'});

    expect(await (await request('/next',{runnerId:'ci',versionId},e)).json()).toMatchObject({job:{versionId,runnerId:'ci'}});
    expect(await env.DB.prepare('SELECT runner_id FROM config_versions WHERE id=?1').bind(versionId).first()).toEqual({runner_id:'ci'});
    expect(await env.DB.prepare('SELECT state FROM publish_dispatch WHERE version_id=?1').bind(versionId).first()).toEqual({state:'claimed'});
  });
  it('a status poll that read an empty lock cannot fail a publication committed before its orphan scan', async () => {
    await change(); await request('/heartbeat',{runnerId:'r1'});
    let versionId = 0;
    const racing = {...local(),DB:{
      prepare(sql:string){
        const statement = env.DB.prepare(sql);
        if (sql !== 'SELECT version_id, expires_at FROM publish_lock WHERE id = 1') return statement;
        return {first:async()=>{
          const previous = await statement.first();
          expect(previous).toBeNull();
          const started = await publish();
          expect(started.status).toBe(200);
          versionId = (await started.json() as {versionId:number}).versionId;
          return previous;
        }};
      },
      batch:env.DB.batch.bind(env.DB),
    } as unknown as D1Database};
    expect((await app.request('/api/publish/status',{headers:{cookie}},racing)).status).toBe(200);
    expect(versionId).toBeGreaterThan(0);
    expect(await env.DB.prepare('SELECT status FROM config_versions WHERE id=?1').bind(versionId).first()).toMatchObject({status:'validating'});
    expect(await (await request('/next',{runnerId:'r1'})).json()).toMatchObject({job:{versionId}});
  });
  it('production dispatch is automatic, durable and scoped to the submitted version', async () => {
    await change();
    const e = {...local(),ENVIRONMENT:'production',PUBLISH_EXECUTION_MODE:'github',PUBLISH_GITHUB_REPOSITORY:'agentabatiuo572-byte/nexion-website',PUBLISH_GITHUB_WORKFLOW:'publish-website.yml',PUBLISH_GITHUB_REF:'main',PUBLISH_GITHUB_TOKEN:'github-test-token-long-enough'};
    const send = vi.fn().mockResolvedValue(new Response(null,{status:204}));
    vi.stubGlobal('fetch',send);
    const started = await publish(e);
    expect(started.status).toBe(200);
    const {versionId} = await started.json() as {versionId:number};
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe('https://api.github.com/repos/agentabatiuo572-byte/nexion-website/actions/workflows/publish-website.yml/dispatches');
    expect(JSON.parse(send.mock.calls[0]![1].body)).toEqual({ref:'main',inputs:{versionId:String(versionId)}});
    expect(await env.DB.prepare('SELECT state,attempts FROM publish_dispatch WHERE version_id=?1').bind(versionId).first()).toMatchObject({state:'waiting',attempts:1});
    expect((await request('/next',{runnerId:'ci'},e)).status).toBe(400);
    // Simulate delivery ambiguity. State survives and retry does not create another version.
    await env.DB.prepare('UPDATE publish_dispatch SET next_attempt_at=0 WHERE version_id=?1').bind(versionId).run();
    send.mockRejectedValue(new Error('network reset'));
    await app.request('/api/publish/status',{headers:{cookie}},e);
    expect(await env.DB.prepare('SELECT state,attempts FROM publish_dispatch WHERE version_id=?1').bind(versionId).first()).toMatchObject({state:'pending',attempts:2});
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM publish_lock').first()).toMatchObject({n:1});
  });
  it('expired swap cannot be replaced by a direct publish before a status poll', async () => {
    await change(); await request('/heartbeat',{runnerId:'r1'});
    const {versionId} = await (await publish()).json() as {versionId:number};
    const {job} = await (await request('/next',{runnerId:'r1'})).json() as {job:{stamp:string}};
    for (const step of ['materialize','gates','build']) {
      await request('/step',{versionId,stamp:job.stamp,runnerId:'r1',step,status:'running'});
      await request('/step',{versionId,stamp:job.stamp,runnerId:'r1',step,status:'ok'});
    }
    await request('/step',{versionId,stamp:job.stamp,runnerId:'r1',step:'swap',status:'running'});
    await env.DB.prepare('UPDATE publish_lock SET expires_at=0').run();
    await env.DB.prepare("UPDATE publish_runner SET last_seen_at=0 WHERE runner_id='r1'").run();
    await request('/heartbeat',{runnerId:'r2'}); // 新发布入口可用，但旧 r1 的租约与心跳均已过期。
    expect((await publish()).status).toBe(409);
    expect(await env.DB.prepare('SELECT status FROM config_versions WHERE id=?1').bind(versionId).first()).toMatchObject({status:'unknown'});
  });
  it('a late recovery read cannot replace a committed live version with unknown', async () => {
    await change(); await request('/heartbeat',{runnerId:'r1'});
    const {versionId} = await (await publish()).json() as {versionId:number};
    const {job} = await (await request('/next',{runnerId:'r1'})).json() as {job:{stamp:string}};
    await env.DB.prepare("INSERT INTO publish_steps(version_id,step,status,started_at) VALUES(?1,'swap','running',0)").bind(versionId).run();
    const racing = {...local(),ASSETS:{fetch:async()=>{
      await env.DB.prepare("UPDATE config_versions SET status='live' WHERE id=?1").bind(versionId).run();
      return new Response('not yet available',{status:404});
    }}} as unknown as Env;
    await request('/runner-fail',{versionId,stamp:job.stamp,runnerId:'r1'},racing);
    expect(await env.DB.prepare('SELECT status FROM config_versions WHERE id=?1').bind(versionId).first()).toMatchObject({status:'live'});
  });
  it('an audit failure atomically rejects a production job and its durable dispatch', async () => {
    await change();
    const e = {...local(),ENVIRONMENT:'production',PUBLISH_EXECUTION_MODE:'github',PUBLISH_GITHUB_REPOSITORY:'agentabatiuo572-byte/nexion-website',PUBLISH_GITHUB_WORKFLOW:'publish-website.yml',PUBLISH_GITHUB_REF:'main',PUBLISH_GITHUB_TOKEN:'github-test-token-long-enough'};
    await env.DB.prepare("CREATE TRIGGER fail_publish_audit BEFORE INSERT ON audit WHEN NEW.action='config.publish' BEGIN SELECT RAISE(ABORT, 'injected-audit-failure'); END").run();
    try {
      vi.spyOn(console,'error').mockImplementation(()=>{});
      expect((await publish(e)).status).toBe(500);
      expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM publish_dispatch').first()).toMatchObject({n:0});
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM config_versions WHERE status<>'live'").first()).toMatchObject({n:0});
      expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM publish_lock').first()).toMatchObject({n:0});
      const send=vi.fn().mockResolvedValue(new Response(null,{status:204})); vi.stubGlobal('fetch',send);
      await maintainPublishing(e);
      expect(send).not.toHaveBeenCalled();
    } finally {
      await env.DB.prepare('DROP TRIGGER fail_publish_audit').run();
    }
  });
  it('recovery cannot rewrite a concurrently failed step or claim that version is live', async () => {
    const job = await swapJob();
    const snapshot = await snapshotFor(job);
    let interrupted = false;
    const racing = {...local(),ASSETS:{fetch:async(req:Request)=>{
      if (!interrupted) {
        interrupted = true;
        await env.DB.batch([
          env.DB.prepare("UPDATE config_versions SET status='failed',fail_reason='concurrent failure' WHERE id=?1").bind(job.versionId),
          env.DB.prepare("UPDATE publish_steps SET status='failed',detail='concurrent failure' WHERE version_id=?1 AND step='swap'").bind(job.versionId),
        ]);
      }
      return new Response(new URL(req.url).pathname==='/.publish-stamp.json' ? JSON.stringify(snapshot.stamp) : snapshot.html);
    }}} as unknown as Env;
    const result = await (await request('/runner-fail',job,racing)).json() as {live?:boolean};
    expect(await env.DB.prepare('SELECT status FROM config_versions WHERE id=?1').bind(job.versionId).first()).toMatchObject({status:'failed'});
    expect(await env.DB.prepare("SELECT status,detail FROM publish_steps WHERE version_id=?1 AND step='swap'").bind(job.versionId).first()).toMatchObject({status:'failed',detail:'concurrent failure'});
    expect(result.live).not.toBe(true);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE target=?1 AND action IN ('config.publish.live','config.publish.failed')").bind(`v${job.versionId}`).first()).toMatchObject({n:0});
  });
  it('a newer committed publication cannot turn an archived successful swap into a failure', async () => {
    const job = await swapJob();
    const snapshot = await snapshotFor(job);
    let stampReads = 0;
    let newerVersion = 0;
    const racing = {...local(),ASSETS:{fetch:async(req:Request)=>{
      if (new URL(req.url).pathname==='/.publish-stamp.json') {
        stampReads++;
        if (stampReads>1) return new Response(JSON.stringify({...snapshot.stamp,versionId:newerVersion,stamp:'newer-stamp'}));
        return new Response(JSON.stringify(snapshot.stamp));
      }
      if (!newerVersion) {
        await env.DB.batch([
          env.DB.prepare("UPDATE config_versions SET status='archived' WHERE status='live' OR id=?1").bind(job.versionId),
          env.DB.prepare("UPDATE publish_steps SET status='ok',detail='committed before newer publication' WHERE version_id=?1 AND step='swap'").bind(job.versionId),
          env.DB.prepare("INSERT INTO config_versions(status,payload,created_at,claim_nonce,runner_id) SELECT 'live',payload,?2,'newer-stamp','r2' FROM config_versions WHERE id=?1").bind(job.versionId,Date.now()),
        ]);
        newerVersion = (await env.DB.prepare("SELECT id FROM config_versions WHERE status='live'").first<{id:number}>())!.id;
      }
      return new Response(snapshot.html);
    }}} as unknown as Env;
    const result = await (await request('/runner-fail',job,racing)).json() as {live?:boolean};
    expect(await env.DB.prepare('SELECT status FROM config_versions WHERE id=?1').bind(job.versionId).first()).toMatchObject({status:'archived'});
    expect(await env.DB.prepare("SELECT status,detail FROM publish_steps WHERE version_id=?1 AND step='swap'").bind(job.versionId).first()).toMatchObject({status:'ok',detail:'committed before newer publication'});
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE target=?1 AND action='config.publish.failed'").bind(`v${job.versionId}`).first()).toMatchObject({n:0});
    expect(result).toMatchObject({status:'archived',terminal:true,live:false});
  });
  it('automatic unknown recovery verifies assets once, commits version and step together, and audits as system once', async () => {
    const job = await swapJob();
    const snapshot = await snapshotFor(job);
    await env.DB.prepare("UPDATE config_versions SET status='unknown' WHERE id=?1").bind(job.versionId).run();
    let stampReads = 0;
    const served = {...local(),ASSETS:{fetch:async(req:Request)=>{
      const isStamp = new URL(req.url).pathname==='/.publish-stamp.json';
      if (isStamp) stampReads++;
      return new Response(isStamp ? JSON.stringify(snapshot.stamp) : snapshot.html);
    }}} as unknown as Env;
    await maintainPublishing(served);
    expect(stampReads).toBe(1);
    expect(await env.DB.prepare("SELECT status FROM publish_steps WHERE version_id=?1 AND step='swap'").bind(job.versionId).first()).toMatchObject({status:'ok'});
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM config_versions WHERE status='live'").first()).toMatchObject({n:1});
    await maintainPublishing(served);
    expect(stampReads).toBe(1);
    expect(await env.DB.prepare("SELECT actor,COUNT(*) AS n FROM audit WHERE target=?1 AND action='config.publish.live'").bind(`v${job.versionId}`).first()).toEqual({actor:'system',n:1});
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM publish_lock').first()).toMatchObject({n:0});
  });
  it('unknown recovery with unavailable page evidence keeps the fence without recording failure', async () => {
    const job = await swapJob();
    const snapshot = await snapshotFor(job);
    await env.DB.prepare("UPDATE config_versions SET status='unknown' WHERE id=?1").bind(job.versionId).run();
    const unavailable = {...local(),ASSETS:{fetch:async(req:Request)=>new URL(req.url).pathname==='/.publish-stamp.json'
      ? new Response(JSON.stringify(snapshot.stamp)) : new Response('unavailable',{status:503})}} as unknown as Env;
    expect(await (await request('/runner-fail',job,unavailable)).json()).toMatchObject({terminal:false,live:false,unknown:true});
    expect(await env.DB.prepare("SELECT status FROM publish_steps WHERE version_id=?1 AND step='swap'").bind(job.versionId).first()).toMatchObject({status:'running'});
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE target=?1 AND action='config.publish.failed'").bind(`v${job.versionId}`).first()).toMatchObject({n:0});
    expect(await env.DB.prepare('SELECT version_id FROM publish_lock').first()).toMatchObject({version_id:job.versionId});
  });
  it('a status poll of a lost-lock swap records uncertainty without a false failure audit', async () => {
    const job = await swapJob();
    await env.DB.prepare('DELETE FROM publish_lock WHERE version_id=?1').bind(job.versionId).run();
    const unavailable = {...local(),ASSETS:{fetch:async()=>new Response('not available',{status:404})}} as unknown as Env;
    expect((await app.request('/api/publish/status',{headers:{cookie}},unavailable)).status).toBe(200);
    expect(await env.DB.prepare('SELECT status FROM config_versions WHERE id=?1').bind(job.versionId).first()).toMatchObject({status:'unknown'});
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE target=?1 AND action='config.publish.failed'").bind(`v${job.versionId}`).first()).toMatchObject({n:0});
    expect(await env.DB.prepare("SELECT actor,action,target,before_summary,after_summary,reason FROM audit WHERE target=?1 AND action='config.publish.unknown'").bind(`v${job.versionId}`).first()).toEqual({
      actor:'system',
      action:'config.publish.unknown',
      target:`v${job.versionId}`,
      before_summary:'validating/publishing',
      after_summary:'切换结果待核实，系统会继续核对已发布内容；核实前暂停新发布。',
      reason:'恢复阶段无法确认线上快照与本次发布一致',
    });
    expect((await app.request('/api/publish/status',{headers:{cookie}},unavailable)).status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE target=?1 AND action='config.publish.unknown'").bind(`v${job.versionId}`).first()).toMatchObject({n:1});
  });
  it('an uncertainty audit failure rolls back the unknown state transition', async () => {
    const job = await swapJob();
    const unavailable = {...local(),ASSETS:{fetch:async()=>new Response('not available',{status:404})}} as unknown as Env;
    await env.DB.prepare("CREATE TRIGGER fail_unknown_audit BEFORE INSERT ON audit WHEN NEW.action='config.publish.unknown' BEGIN SELECT RAISE(ABORT, 'injected-unknown-audit-failure'); END").run();
    try {
      vi.spyOn(console,'error').mockImplementation(()=>{});
      expect((await request('/runner-fail',job,unavailable)).status).toBe(500);
      expect(await env.DB.prepare('SELECT status FROM config_versions WHERE id=?1').bind(job.versionId).first()).toMatchObject({status:'publishing'});
      expect(await env.DB.prepare("SELECT status FROM publish_steps WHERE version_id=?1 AND step='swap'").bind(job.versionId).first()).toMatchObject({status:'running'});
      expect(await env.DB.prepare('SELECT version_id FROM publish_lock WHERE id=1').first()).toMatchObject({version_id:job.versionId});
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE target=?1 AND action='config.publish.unknown'").bind(`v${job.versionId}`).first()).toMatchObject({n:0});
    } finally {
      await env.DB.prepare('DROP TRIGGER fail_unknown_audit').run();
    }
  });
  it('a job heartbeat and force-cancel linearize on one lease/freshness commit', async () => {
    await change(); await request('/heartbeat',{runnerId:'r1'});
    const {versionId} = await (await publish()).json() as {versionId:number};
    const {job} = await (await request('/next',{runnerId:'r1'})).json() as {job:{stamp:string}};
    const identity = {versionId,stamp:job.stamp,runnerId:'r1'};
    expect((await request('/step',{...identity,step:'materialize',status:'running'})).status).toBe(200);
    const stale = Date.now()-13*60_000;
    await env.DB.prepare('UPDATE publish_steps SET started_at=?1 WHERE version_id=?2').bind(stale,versionId).run();
    await env.DB.prepare('UPDATE publish_lock SET expires_at=?2 WHERE version_id=?1').bind(versionId,stale+15*60_000).run();
    await env.DB.prepare('UPDATE publish_runner SET last_seen_at=?1 WHERE runner_id=?2').bind(stale,'r1').run();

    let cancelResponse: Response | null = null;
    const originals = new WeakMap<D1PreparedStatement,D1PreparedStatement>();
    const cancelAfterLeaseWrite = async () => {
      if (cancelResponse) return;
      cancelResponse = await app.request('/api/publish/cancel',{
        method:'POST',headers:{cookie,'content-type':'application/json'},
        body:JSON.stringify({force:true,reason:'确定性复现心跳与取消交错'}),
      },local());
    };
    const racing = {...local(),DB:{
      prepare(sql:string) {
        const statement = env.DB.prepare(sql);
        if (!sql.includes('UPDATE publish_lock SET expires_at=')) return statement;
        return {bind(...values:unknown[]) {
          const bound = statement.bind(...values);
          const wrapped = {run:async()=>{const result=await bound.run(); await cancelAfterLeaseWrite(); return result;}} as D1PreparedStatement;
          originals.set(wrapped,bound);
          return wrapped;
        }} as D1PreparedStatement;
      },
      batch:async(statements:D1PreparedStatement[])=>{
        const result = await env.DB.batch(statements.map(statement=>originals.get(statement) ?? statement));
        await cancelAfterLeaseWrite();
        return result;
      },
    } as unknown as D1Database};

    const heartbeat = await request('/heartbeat',identity,racing);
    expect(heartbeat.status).toBe(200);
    expect(cancelResponse).not.toBeNull();
    expect(cancelResponse!.status).toBe(409);
    expect(await env.DB.prepare('SELECT status FROM config_versions WHERE id=?1').bind(versionId).first()).toMatchObject({status:'publishing'});
    expect(await env.DB.prepare('SELECT version_id FROM publish_lock WHERE id=1').first()).toMatchObject({version_id:versionId});
  });
  it('timeout recovery rechecks a renewed job lease before committing failure', async () => {
    await change(); await request('/heartbeat',{runnerId:'r1'});
    const {versionId} = await (await publish()).json() as {versionId:number};
    const {job} = await (await request('/next',{runnerId:'r1'})).json() as {job:{stamp:string}};
    const identity = {versionId,stamp:job.stamp,runnerId:'r1'};
    expect((await request('/step',{...identity,step:'materialize',status:'running'})).status).toBe(200);
    await env.DB.prepare('UPDATE publish_lock SET expires_at=0 WHERE version_id=?1').bind(versionId).run();

    let injected = false;
    const racing = {...local(),DB:{
      prepare:env.DB.prepare.bind(env.DB),
      batch:async(statements:D1PreparedStatement[])=>{
        if (!injected) {
          injected = true;
          const now=Date.now();
          await env.DB.prepare('UPDATE publish_lock SET expires_at=?2 WHERE version_id=?1').bind(versionId,now+15*60_000).run();
        }
        return env.DB.batch(statements);
      },
    } as unknown as D1Database};

    await maintainPublishing(racing);
    expect(injected).toBe(true);
    expect(await env.DB.prepare('SELECT status FROM config_versions WHERE id=?1').bind(versionId).first()).toMatchObject({status:'publishing'});
    expect(await env.DB.prepare('SELECT version_id FROM publish_lock WHERE id=1').first()).toMatchObject({version_id:versionId});
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE target=?1 AND action='config.publish.failed'").bind(`v${versionId}`).first()).toMatchObject({n:0});
  });
  it('an idle heartbeat cannot keep an expired claimed job alive during automatic recovery', async () => {
    await change(); await request('/heartbeat',{runnerId:'r1'});
    const {versionId} = await (await publish()).json() as {versionId:number};
    const {job} = await (await request('/next',{runnerId:'r1'})).json() as {job:{stamp:string}};
    const identity = {versionId,stamp:job.stamp,runnerId:'r1'};
    expect((await request('/step',{...identity,step:'materialize',status:'running'})).status).toBe(200);
    await env.DB.prepare('UPDATE publish_lock SET expires_at=0 WHERE version_id=?1').bind(versionId).run();

    let injected = false;
    const racing = {...local(),DB:{
      prepare:env.DB.prepare.bind(env.DB),
      batch:async(statements:D1PreparedStatement[])=>{
        if (!injected) {
          injected = true;
          expect((await request('/heartbeat',{runnerId:'r1'})).status).toBe(200);
        }
        return env.DB.batch(statements);
      },
    } as unknown as D1Database};

    await maintainPublishing(racing);
    expect(injected).toBe(true);
    expect(await env.DB.prepare('SELECT status FROM config_versions WHERE id=?1').bind(versionId).first()).toMatchObject({status:'failed'});
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM publish_lock').first()).toMatchObject({n:0});
    expect(await env.DB.prepare("SELECT actor FROM audit WHERE target=?1 AND action='config.publish.failed'").bind(`v${versionId}`).first()).toEqual({actor:'system'});
  });
  it('an idle heartbeat cannot block force-cancel after the claimed job goes silent', async () => {
    await change(); await request('/heartbeat',{runnerId:'r1'});
    const {versionId} = await (await publish()).json() as {versionId:number};
    const {job} = await (await request('/next',{runnerId:'r1'})).json() as {job:{stamp:string}};
    const identity = {versionId,stamp:job.stamp,runnerId:'r1'};
    expect((await request('/step',{...identity,step:'materialize',status:'running'})).status).toBe(200);
    const stale = Date.now()-13*60_000;
    await env.DB.prepare('UPDATE publish_steps SET started_at=?2 WHERE version_id=?1').bind(versionId,stale).run();
    await env.DB.prepare('UPDATE publish_lock SET claimed_at=?2,expires_at=?3 WHERE version_id=?1').bind(versionId,stale,stale+15*60_000).run();
    expect((await request('/heartbeat',{runnerId:'r1'})).status).toBe(200);

    const state = await app.request('/api/publish/status',{headers:{cookie}},local());
    expect(await state.json()).toMatchObject({activeVersion:versionId,cancelable:'force'});
    const cancelled = await app.request('/api/publish/cancel',{
      method:'POST',headers:{cookie,'content-type':'application/json'},
      body:JSON.stringify({force:true,reason:'任务心跳已停止，执行器仅处于空闲轮询'}),
    },local());
    expect(cancelled.status).toBe(200);
    expect(await env.DB.prepare('SELECT status FROM config_versions WHERE id=?1').bind(versionId).first()).toEqual({status:'cancelled'});
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM publish_lock').first()).toMatchObject({n:0});
  });
  it('upgrade conflicts stay readable and cannot advertise a ready executor', async () => {
    const payload = await storeLegacyDraft(true);
    const preflight = await app.request('/api/publish/preflight',{headers:{cookie}},local());
    expect(preflight.status).toBe(200);
    expect(await preflight.json()).toMatchObject({ready:false,errors:[{rule:'structure',path:'copy.en.trust.card1'}]});
    const rejected = await publish();
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({error:'config-upgrade-conflict',message:expect.stringContaining('冲突字段'),paths:['copy.en.trust.card1']});
    const heartbeat = await request('/heartbeat',{runnerId:'blocked-during-conflict'});
    expect(heartbeat.status).toBe(409);
    expect(await heartbeat.json()).toMatchObject({error:'config-upgrade-conflict',configUpgrade:{status:'blocked'}});
    expect(await (await app.request('/api/publish/executor',{headers:{cookie}},local())).json()).toMatchObject({ready:false});
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM publish_runner').first()).toEqual({n:0});
    expect((await app.request('/api/publish/status',{headers:{cookie}},local())).status).toBe(200);
    expect(await env.DB.prepare('SELECT payload FROM config_draft WHERE id=1').first()).toMatchObject({payload});
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM publish_lock').first()).toMatchObject({n:0});
  });
  it('reads and publish only inspect legacy drafts; preparation CAS races give retry guidance', async () => {
    await storeLegacyDraft();
    const racingDb = {
      prepare:env.DB.prepare.bind(env.DB),
      batch:async(statements:D1PreparedStatement[])=>{
        await env.DB.prepare('UPDATE config_draft SET draft_rev=draft_rev+1 WHERE id=1').run();
        return env.DB.batch(statements);
      },
    } as unknown as D1Database;
    const racing = {...local(),DB:racingDb};
    const before = await env.DB.prepare('SELECT payload,draft_rev,updated_at FROM config_draft').first();
    for (const path of ['/api/config','/api/publish/status','/api/publish/executor','/api/publish/runner-state?runnerId=r1']) {
      expect((await app.request(path,{headers:{cookie,authorization:`Bearer ${secret}`}},racing)).status).toBe(200);
    }
    expect(await (await app.request('/api/publish/preflight',{headers:{cookie}},racing)).json()).toMatchObject({ready:false,errors:[{rule:'structure',message:expect.stringContaining('稍后重试')}]});
    const response = await publish(racing);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({error:'config-upgrade-retry',message:expect.stringContaining('稍后重试')});
    expect(await env.DB.prepare('SELECT payload,draft_rev,updated_at FROM config_draft').first()).toEqual(before);
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM config_draft_upgrades').first()).toEqual({n:0});
    expect((await request('/heartbeat',{runnerId:'r1'},racing)).status).toBe(503);
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM publish_runner').first()).toEqual({n:0});
    expect(await env.DB.prepare('SELECT COUNT(*) n FROM config_draft_upgrades').first()).toEqual({n:0});
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM publish_lock').first()).toMatchObject({n:0});
  });
  it('idle heartbeat upgrades a stale v2 marker once before readiness and preserves historical bytes', async () => {
    await app.request('/api/config',{headers:{cookie}},local());
    const config = structuredClone(currentSeedJson);
    for (const locale of ['en','vi','zh'] as const) {
      Object.assign(config.copy[locale], {'trust.whitepaper.download':'Old download','trust.whitepaper.coverAlt':'Old cover'});
    }
    config.copy.en['hero.title'] = 'Authored title survives preparation';
    const payload = JSON.stringify(config);
    await env.DB.prepare('UPDATE config_draft SET payload=?1,draft_rev=8 WHERE id=1').bind(payload).run();
    await env.DB.prepare('INSERT INTO config_draft_upgrades(draft_id,upgrade_key,original_payload,original_rev,upgraded_rev,applied_at,commit_nonce) VALUES(1,?1,?2,7,8,1788926361300,?3)')
      .bind('website-whitepaper-2026-09-09-v2',payload,'old-v2').run();
    const history = (await env.DB.prepare('SELECT id,payload FROM config_versions').all()).results;
    expect(await (await app.request('/api/publish/executor',{headers:{cookie}},local())).json()).toMatchObject({ready:false});
    expect((await request('/heartbeat',{runnerId:'prepared-runner'})).status).toBe(200);
    const upgraded = await env.DB.prepare('SELECT payload,draft_rev FROM config_draft').first<{payload:string;draft_rev:number}>();
    expect(upgraded!.draft_rev).toBe(9);
    const result = JSON.parse(upgraded!.payload);
    expect(result.copy.en['hero.title']).toBe(config.copy.en['hero.title']);
    for (const locale of ['en','vi','zh']) {
      expect(result.copy[locale]['trust.whitepaper.download']).toBeUndefined();
      expect(result.copy[locale]['trust.whitepaper.coverAlt']).toBeUndefined();
    }
    expect(await env.DB.prepare('SELECT original_payload,original_rev,upgraded_rev FROM config_draft_upgrades WHERE upgrade_key=?1').bind(CONFIG_UPGRADE_KEY).first()).toEqual({original_payload:payload,original_rev:8,upgraded_rev:9});
    expect(await (await app.request('/api/publish/executor',{headers:{cookie}},local())).json()).toMatchObject({ready:true});
    expect((await request('/heartbeat',{runnerId:'prepared-runner'})).status).toBe(200);
    expect(await env.DB.prepare('SELECT payload,draft_rev FROM config_draft').first()).toEqual(upgraded);
    expect((await env.DB.prepare('SELECT id,payload FROM config_versions').all()).results).toEqual(history);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM audit WHERE target=?1").bind(`draft-upgrade:${CONFIG_UPGRADE_KEY}`).first()).toEqual({n:1});
  });
  it('job heartbeats only renew the lease while an incompatible draft makes readiness false', async () => {
    await change(); await request('/heartbeat',{runnerId:'r1'});
    const {versionId} = await (await publish()).json() as {versionId:number};
    const {job} = await (await request('/next',{runnerId:'r1'})).json() as {job:{stamp:string}};
    await env.DB.prepare('UPDATE config_draft SET payload=?1 WHERE id=1').bind(JSON.stringify(legacyConfig())).run();
    const before = await env.DB.prepare('SELECT payload,draft_rev,updated_at FROM config_draft').first();
    const markers = (await env.DB.prepare('SELECT * FROM config_draft_upgrades').all()).results;
    const audits = (await env.DB.prepare('SELECT * FROM audit').all()).results;
    expect((await request('/heartbeat',{runnerId:'r1',versionId,stamp:job.stamp})).status).toBe(200);
    await maintainPublishing(github());
    expect(await env.DB.prepare('SELECT payload,draft_rev,updated_at FROM config_draft').first()).toEqual(before);
    expect((await env.DB.prepare('SELECT * FROM config_draft_upgrades').all()).results).toEqual(markers);
    expect((await env.DB.prepare('SELECT * FROM audit').all()).results).toEqual(audits);
    expect(await (await app.request('/api/publish/executor',{headers:{cookie}},local())).json()).toMatchObject({ready:false});
  });
  it('production minute maintenance prepares legacy drafts before readiness and subsequent dispatch', async () => {
    await storeLegacyDraft();
    const fetcher = vi.fn(async () => new Response(null,{status:204}));
    vi.stubGlobal('fetch', fetcher);
    expect(await (await app.request('/api/publish/executor',{headers:{cookie}},github())).json()).toMatchObject({ready:false});
    await maintainPublishing(github());
    expect(await (await app.request('/api/publish/executor',{headers:{cookie}},github())).json()).toMatchObject({ready:true});
    const result = await request('',{draftRev:1,reason:'发布已核实的旧版配置兼容升级'},github(),{cookie});
    // The service upgrade advanced revision 1 to 2; a pre-preparation request cannot publish it.
    expect(result.status).toBe(409);
    const draft = await env.DB.prepare('SELECT draft_rev FROM config_draft').first<{draft_rev:number}>();
    const accepted = await request('',{draftRev:draft!.draft_rev,reason:'发布已核实的旧版配置兼容升级'},github(),{cookie});
    expect(accepted.status, await accepted.text()).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await env.DB.prepare('SELECT state FROM publish_dispatch').first()).toEqual({state:'waiting'});
  });
  it('an existing queued snapshot still dispatches and can be claimed while the current draft is incompatible', async () => {
    await change();
    const fetcher = vi.fn(async () => new Response(null,{status:204}));
    vi.stubGlobal('fetch', fetcher);
    const published = await publish(github());
    expect(published.status).toBe(200);
    const {versionId} = await published.json() as {versionId:number};
    const original = await env.DB.prepare('SELECT payload FROM config_versions WHERE id=?1').bind(versionId).first<{payload:string}>();
    const legacy = JSON.stringify(legacyConfig(true));
    await env.DB.prepare('UPDATE config_draft SET payload=?1 WHERE id=1').bind(legacy).run();
    await env.DB.prepare("UPDATE publish_dispatch SET state='pending',next_attempt_at=0 WHERE version_id=?1").bind(versionId).run();
    const draft = await env.DB.prepare('SELECT payload,draft_rev FROM config_draft').first();
    const markers = (await env.DB.prepare('SELECT * FROM config_draft_upgrades').all()).results;
    await maintainPublishing(github());
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await (await app.request('/api/publish/executor',{headers:{cookie}},github())).json()).toMatchObject({ready:false});
    expect((await request('/heartbeat',{runnerId:'ci-existing'},github())).status).toBe(200);
    expect(await (await request('/next',{runnerId:'ci-existing',versionId},github())).json()).toMatchObject({job:{versionId,config:JSON.parse(original!.payload)}});
    expect(await env.DB.prepare('SELECT payload,draft_rev FROM config_draft').first()).toEqual(draft);
    expect((await env.DB.prepare('SELECT * FROM config_draft_upgrades').all()).results).toEqual(markers);
    expect(await env.DB.prepare('SELECT payload FROM config_versions WHERE id=?1').bind(versionId).first()).toEqual(original);
  });
  it('an incompatible queued snapshot is rejected before claiming and never silently adapted in place', async () => {
    await change(); await request('/heartbeat',{runnerId:'r1'});
    const {versionId} = await (await publish()).json() as {versionId:number};
    const payload = JSON.stringify(legacyConfig());
    await env.DB.prepare('UPDATE config_versions SET payload=?1 WHERE id=?2').bind(payload,versionId).run();
    const result = await request('/next',{runnerId:'r1'});
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({error:'config-upgrade-conflict',message:expect.stringContaining('排队版本')});
    expect(await env.DB.prepare('SELECT payload,runner_id FROM config_versions WHERE id=?1').bind(versionId).first()).toEqual({payload,runner_id:null});
    expect(await env.DB.prepare('SELECT claimed_by,claimed_at FROM publish_lock').first()).toEqual({claimed_by:null,claimed_at:null});
  });
  it('failed production preparation does not prevent an expired job from reaching a terminal result', async () => {
    await change(); await request('/heartbeat',{runnerId:'r1'});
    const {versionId} = await (await publish()).json() as {versionId:number};
    await request('/next',{runnerId:'r1'});
    await env.DB.prepare('UPDATE publish_lock SET expires_at=?1').bind(Date.now()-1000).run();
    await env.DB.prepare('UPDATE config_draft SET payload=?1 WHERE id=1').bind(JSON.stringify(legacyConfig())).run();
    await env.DB.prepare('DELETE FROM config_draft_upgrades').run();
    const before = await env.DB.prepare('SELECT payload,draft_rev FROM config_draft').first();
    await env.DB.prepare("CREATE TRIGGER fail_preparation_audit BEFORE INSERT ON audit WHEN NEW.target LIKE 'draft-upgrade:%' BEGIN SELECT RAISE(ABORT, 'preparation-audit-failure'); END").run();
    const logged = vi.spyOn(console,'error').mockImplementation(() => {});
    try {
      await expect(maintainPublishing(github())).resolves.toBeUndefined();
      expect(await env.DB.prepare('SELECT status FROM config_versions WHERE id=?1').bind(versionId).first()).toEqual({status:'failed'});
      expect(await env.DB.prepare('SELECT COUNT(*) n FROM publish_lock').first()).toEqual({n:0});
      expect(await env.DB.prepare('SELECT payload,draft_rev FROM config_draft').first()).toEqual(before);
      expect(await env.DB.prepare('SELECT COUNT(*) n FROM config_draft_upgrades').first()).toEqual({n:0});
      expect(await (await app.request('/api/publish/executor',{headers:{cookie}},github())).json()).toMatchObject({ready:false});
      expect(logged).toHaveBeenCalledWith('Configuration preparation failed; the original draft was retained.');
    } finally { await env.DB.prepare('DROP TRIGGER fail_preparation_audit').run(); }
  });
  it('publication draft revision is captured atomically and does not drift with later saves', async () => {
    await change(); await request('/heartbeat',{runnerId:'r1'});
    const source = await env.DB.prepare('SELECT draft_rev FROM config_draft').first<{draft_rev:number}>();
    const {versionId} = await (await publish()).json() as {versionId:number};
    await env.DB.prepare('UPDATE config_draft SET draft_rev=draft_rev+1 WHERE id=1').run();
    expect(await env.DB.prepare('SELECT source_draft_rev FROM config_versions WHERE id=?1').bind(versionId).first()).toEqual({source_draft_rev:source!.draft_rev});
    expect(await (await request('/next',{runnerId:'r1'})).json()).toMatchObject({job:{versionId,draftRev:source!.draft_rev,source:'draft'}});
  });
  it('rollback upgrades only the new publication copy and still queues the complete gate chain', async () => {
    await app.request('/api/config',{headers:{cookie}},local());
    await request('/heartbeat',{runnerId:'r1'});
    const historicalPayload = JSON.stringify(legacyConfig());
    const historical = await env.DB.prepare("INSERT INTO config_versions(status,payload,created_at,published_at) VALUES('archived',?1,?2,?2) RETURNING id").bind(historicalPayload,Date.now()).first<{id:number}>();
    const result = await request('',{fromVersion:historical!.id,reason:'恢复经过核实的历史内容并保留修改'},local(),{cookie});
    expect(result.status).toBe(200);
    const body = await result.json() as {versionId:number;steps:string[]};
    expect(body.steps).toEqual(['materialize','gates','build','swap']);
    const created = await env.DB.prepare('SELECT status,payload FROM config_versions WHERE id=?1').bind(body.versionId).first<{status:string;payload:string}>();
    expect(created!.status).toBe('validating');
    const adapted = JSON.parse(created!.payload);
    expect(adapted.copy.en['hero.title']).toBe('A carefully preserved authored title');
    expect(adapted.copy.en['why.kicker']).toBe(currentSeedJson.copy.en['why.kicker']);
    expect(adapted.copy.en['trust.card1']).toBeUndefined();
    expect(await env.DB.prepare('SELECT payload,status FROM config_versions WHERE id=?1').bind(historical!.id).first()).toMatchObject({payload:historicalPayload,status:'archived'});
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM publish_steps WHERE version_id=?1').bind(body.versionId).first()).toMatchObject({n:0});
    expect(await (await request('/next',{runnerId:'r1'})).json()).toMatchObject({job:{versionId:body.versionId,draftRev:null,source:'snapshot'}});
  });
  it('rollback with authored removed fields identifies conflicts without rewriting history or creating a job', async () => {
    await app.request('/api/config',{headers:{cookie}},local());
    const payload = JSON.stringify(legacyConfig(true));
    const historical = await env.DB.prepare("INSERT INTO config_versions(status,payload,created_at) VALUES('archived',?1,?2) RETURNING id").bind(payload,Date.now()).first<{id:number}>();
    const result = await request('',{fromVersion:historical!.id,reason:'检查历史版本中的明确配置冲突'},local(),{cookie});
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({error:'config-upgrade-conflict',paths:['copy.en.trust.card1'],message:expect.stringContaining('冲突字段')});
    expect(await env.DB.prepare('SELECT payload FROM config_versions WHERE id=?1').bind(historical!.id).first()).toMatchObject({payload});
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM publish_lock').first()).toMatchObject({n:0});
  });
  it('interrupted gates fail only the running step and preserve already completed materialization', async () => {
    await change(); await request('/heartbeat',{runnerId:'r1'});
    const {versionId} = await (await publish()).json() as {versionId:number};
    const {job} = await (await request('/next',{runnerId:'r1'})).json() as {job:{stamp:string}};
    const body = {versionId,stamp:job.stamp,runnerId:'r1'};
    await request('/step',{...body,step:'materialize',status:'running'});
    await request('/step',{...body,step:'materialize',status:'ok'});
    await request('/step',{...body,step:'gates',status:'running'});
    expect(await (await request('/runner-fail',{...body,detail:'gate process interrupted'})).json()).toMatchObject({terminal:true,live:false});
    const steps = await env.DB.prepare('SELECT step,status FROM publish_steps WHERE version_id=?1 ORDER BY id').bind(versionId).all();
    expect(steps.results).toEqual([{step:'materialize',status:'ok'},{step:'gates',status:'failed'}]);
  });
});
