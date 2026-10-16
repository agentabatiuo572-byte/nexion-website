import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { SqliteDatabase, migrate, persistentKv } from '../storage.mjs';
import { assetsBinding } from '../assets.mjs';
import { createHttpServer, validateEnvironment, startScheduler } from '../server.mjs';
import { createLimiter } from '../../src/ratelimit.ts';

const temp = mkdtempSync(path.join(tmpdir(),'uvel-aws-runtime-'));
const bundle = path.join(temp,'worker.mjs');
await build({ entryPoints:[fileURLToPath(new URL('../../src/index.ts',import.meta.url))],outfile:bundle,bundle:true,platform:'node',format:'esm',target:'node24' });
const { default: worker } = await import(pathToFileURL(bundle));
const secret = randomBytes(32).toString('hex');
function fixture() {
  const db = new SqliteDatabase(':memory:'); migrate(db,fileURLToPath(new URL('../../migrations/',import.meta.url)));
  const assets = path.join(temp,randomBytes(4).toString('hex')); mkdirSync(path.join(assets,'admin'),{recursive:true});
  writeFileSync(path.join(assets,'index.html'),'<h1>Original</h1>'); writeFileSync(path.join(assets,'404.html'),'Not found');
  writeFileSync(path.join(assets,'admin/index.html'),'<h1>Admin</h1>'); writeFileSync(path.join(assets,'.publish-stamp.json'),'{"private":true}');
  const env = {ENVIRONMENT:'production',PUBLISH_EXECUTION_MODE:'aws',PUBLIC_ORIGIN:'https://uvel.ai',SETUP_TOKEN:secret,PUBLISH_RUNNER_TOKEN:secret,BEACON_SALT:secret,BYPASS_SECRET:secret,GATE_SECRET:secret,AI_CREDENTIAL_ENCRYPTION_KEY:secret,DB:db,KV:persistentKv(db),ASSETS:assetsBinding(assets)};
  const call = (url,body,cookie,extra={},method) => worker.fetch(new Request('https://uvel.ai'+url,{method:method ?? (body ? 'POST':'GET'),headers:{'content-type':'application/json',origin:'https://uvel.ai','cf-connecting-ip':'203.0.113.10',...(cookie ? {cookie}:{}),...extra},...(body ? {body:JSON.stringify(body)}:{})}),env,{waitUntil(){}});
  return {db,env,call,assets};
}
test('real auth setup/login/logout and machine/admin separation', async () => {
  const {db,call} = fixture(); const password = randomBytes(24).toString('hex');
  assert.equal((await call('/api/me')).status,401);
  assert.equal((await call('/api/auth/setup',{token:secret,password})).status,200);
  assert.equal((await call('/api/auth/setup',{token:secret,password})).status,410);
  assert.equal((await call('/api/auth/login',{password:'incorrect-password'})).status,401);
  const login = await call('/api/auth/login',{password}); assert.equal(login.status,200);
  const cookie = login.headers.get('set-cookie'); assert.match(cookie,/HttpOnly/i); assert.match(cookie,/Secure/i); assert.match(cookie,/SameSite=Lax/i);
  const sid = cookie.split(';')[0]; assert.equal((await call('/api/me',null,sid)).status,200);
  assert.equal((await call('/api/publish/runner-state',null,sid)).status,401);
  for (const route of ['/api/publish/%6eext','/api/publish/%73tep','/api/publish/%63heck','/api/publish/%68eartbeat','/api/publish/%72unner-fail']) {
    assert.equal((await call(route,{},sid)).status,401,route);
  }
  assert.equal((await call('/api/publish/%72unner-state',null,sid)).status,401);
  assert.equal((await call('/api/config/draft',null,null,{authorization:'Bearer '+secret})).status,401);
  assert.equal((await call('/api/auth/logout',{},sid)).status,200); assert.equal((await call('/api/me',null,sid)).status,401); db.close();
});
test('real login lockout remains active in production', async () => {
  const {db,call} = fixture(); const password = 'valid-password-for-test-only'; await call('/api/auth/setup',{token:secret,password});
  for (let i=0;i<5;i++) await call('/api/auth/login',{password:'incorrect-password'});
  assert.equal((await call('/api/auth/login',{password})).status,429);
  db.close();
});
test('HTTP adapter protects encoded stamps, admin deep links, methods and canonical origin', async t => {
  const {db,env} = fixture(); const service = createHttpServer(worker,env,{port:0}); await service.listen();
  t.after(async () => { await new Promise(r=>service.server.close(r));db.close(); });
  const base = 'http://127.0.0.1:'+service.server.address().port;
  for (const route of ['/.publish-stamp.json','/%2epublish-stamp.json','/.env','/_headers']) assert.equal((await fetch(base+route)).status,404);
  const admin = await fetch(base+'/admin/config'); assert.equal(admin.status,200); assert.match(await admin.text(),/Admin/); assert.equal(admin.headers.get('cache-control'),'no-store');
  assert.equal((await fetch(base+'/api/unknown')).headers.get('content-type'),'application/json');
  assert.equal((await fetch(base+'/',{method:'POST',body:'hi'})).status,405);
  assert.equal((await fetch(base+'/api/auth/login',{method:'POST',headers:{origin:'https://attacker.invalid','content-type':'application/json'},body:'{}'})).status,403);
  for (const route of ['/api/%63onfig/draft','/%61pi/config/draft','/api/publish/%6eext','/api/%70ublish/next','/%61dmin/config']) {
    assert.equal((await fetch(base+route,{method:'POST',headers:{origin:'https://attacker.invalid','content-type':'text/plain'},body:'{}'})).status,400,route);
  }
});
test('asset response supports 304, ranges, HEAD and immutable path cache', async () => {
  const {db,env,assets} = fixture(); writeFileSync(path.join(assets,'paper.pdf'),'0123456789');
  const read = headers=>env.ASSETS.fetch(new Request('https://uvel.ai/paper.pdf',{headers}));
  const full = await read({}); const partial = await read({range:'bytes=2-5'});
  assert.equal(partial.status,206); assert.equal(await partial.text(),'2345'); assert.equal(partial.headers.get('content-range'),'bytes 2-5/10');
  assert.equal((await read({'if-none-match':full.headers.get('etag')})).status,304);
  assert.equal((await read({range:'bytes=99-'})).status,416);
  const head = await env.ASSETS.fetch(new Request('https://uvel.ai/paper.pdf',{method:'HEAD'})); assert.equal(await head.text(),''); assert.equal(head.headers.get('content-length'),'10'); db.close();
});
test('production startup rejects default secrets and noncanonical HTTP origin', () => {
  const {db,env}=fixture(); const good = {...env,AWS_DATABASE_PATH:path.join(temp,'db.sqlite'),AWS_LIVE_PATH:temp};
  assert.doesNotThrow(()=>validateEnvironment(good)); assert.throws(()=>validateEnvironment({...good,SETUP_TOKEN:'dev-setup-token'})); assert.throws(()=>validateEnvironment({...good,PUBLIC_ORIGIN:'http://uvel.ai'}));db.close();
});
test('limiter remains bounded without clearing active lock buckets', () => { const limiter=createLimiter(100,1,2); assert.equal(limiter.hit('a',1),false); assert.equal(limiter.hit('b',1),false); assert.equal(limiter.hit('c',1),true); assert.equal(limiter.hit('a',2),true); assert.equal(limiter.hit('c',102),false); });
test('scheduler catches up daily/probe after startup and awaits jobs on shutdown', async () => {
  const jobs=[];const stop=startScheduler({async scheduled(event,_env,ctx){ctx.waitUntil(Promise.resolve().then(()=>jobs.push(event.cron)));}}, {}, {}, ()=>new Date('2026-10-16T12:15:00Z'));
  await stop();assert.deepEqual(jobs.sort(),['* * * * *','0 */6 * * *','10 0 * * *'].sort());
});
test('real draft save/CAS, AWS readiness, single claim and failed publication preserve live', async () => {
  const {db,call}=fixture();const password=randomBytes(24).toString('hex');await call('/api/auth/setup',{token:secret,password});
  const login=await call('/api/auth/login',{password});const sid=login.headers.get('set-cookie').split(';')[0];
  const original=await (await call('/api/config',null,sid)).json();assert.ok(original.draft?.payload);
  const payload=structuredClone(original.draft.payload);payload.stats.activeDevices+=1;
  const save=await call('/api/config/draft',{payload,baseRevision:original.draft.draftRev},sid,{},'PUT');assert.equal(save.status,200,await save.text());
  assert.equal((await call('/api/config/draft',{payload,baseRevision:original.draft.draftRev},sid,{},'PUT')).status,409);
  const loaded=await (await call('/api/config',null,sid)).json();assert.equal(loaded.draft.payload.stats.activeDevices,payload.stats.activeDevices);assert.equal(loaded.live.payload.stats.activeDevices,original.live.payload.stats.activeDevices);
  const machine={authorization:'Bearer '+secret};assert.equal((await call('/api/publish/heartbeat',{runnerId:'aws-test-runner'},null,machine)).status,200);
  const executor=await (await call('/api/publish/executor',null,sid)).json();assert.equal(executor.ready,true);assert.equal(executor.mode,'aws');
  const publish=await call('/api/publish',{draftRev:loaded.draft.draftRev,reason:'AWS integration acceptance'},sid);assert.equal(publish.status,200);const {versionId}=await publish.json();
  assert.equal((await call('/api/publish',{draftRev:loaded.draft.draftRev,reason:'Concurrent publication test'},sid)).status,409);
  const claim=await (await call('/api/publish/next',{runnerId:'aws-test-runner'},null,machine)).json();assert.equal(claim.job.versionId,versionId);
  assert.equal((await (await call('/api/publish/next',{runnerId:'other-runner'},null,machine)).json()).job,null);
  assert.equal((await call('/api/publish/runner-fail',{versionId,stamp:claim.job.stamp,runnerId:'aws-test-runner',detail:'Intentional pre-swap interruption'},null,machine)).status,200);
  const after=await (await call('/api/config',null,sid)).json();assert.equal(after.liveVersion,original.liveVersion);assert.equal(after.draft.payload.stats.activeDevices,payload.stats.activeDevices);
  const rollback=await call('/api/publish',{fromVersion:original.liveVersion,reason:'Restore initial approved content'},sid);assert.equal(rollback.status,200);const rv=await rollback.json();assert.ok(rv.versionId>versionId);db.close();
});
