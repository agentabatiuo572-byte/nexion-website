import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, cp, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { artifactManifest, affectedRoutes, digest, validManifest, qualificationMatches, readQualification,
  checkQualifiedSource, reusableArtifact, saveArtifact, cachedWebsite, atomicJson, runtimeIdentity,
  qualificationArtifactsValid, replaceQualifiedStage } from './runner-incremental.mjs';
import { directoryDigest } from './runner-artifacts.mjs';
import { runGates } from './runner-gates.mjs';

const scratch = async t => { const root = await mkdtemp(path.join(tmpdir(), 'uvel-incremental-')); t.after(() => rm(root, { recursive: true, force: true })); return root; };
const manifest = entries => { const list = Object.entries(entries).sort(([a],[b]) => a.localeCompare(b, 'en')).map(([p,s]) => ({ path: p, bytes: Buffer.byteLength(s), sha256: digest(s) })); return { manifest: list, files: list.length, sha256: digest(list) }; };
const before = manifest({ 'index.html': 'home', 'learn/index.html': 'learn', 'vi/index.html': 'vi', 'site.css': 'old-css' });
test('one changed HTML limits checks to that page, preserving other languages', () => {
  const next = manifest({ 'index.html': 'new-home', 'learn/index.html': 'learn', 'vi/index.html': 'vi', 'site.css': 'old-css' });
  assert.deepEqual(affectedRoutes(before, next), { routes: ['/'], full: false, reason: '检查本次变化的页面' });
});
test('new pages are included; deleted pages require full route coverage', () => {
  const added = manifest({ 'index.html': 'home', 'new/index.html': 'new' });
  assert.deepEqual(affectedRoutes(manifest({ 'index.html': 'home' }), added).routes, ['/new/']);
  assert.equal(affectedRoutes(added, manifest({ 'index.html': 'home' })).full, true);
});
for (const resource of ['site.css', 'app.js', 'phone.webp', 'font.woff2', 'sitemap.xml']) {
  test(`same-name ${resource} replacement expands all indirect consumers`, () => {
    const a = manifest({ 'index.html': 'same', 'vi/index.html': 'same', [resource]: 'aaaa' });
    const b = manifest({ 'index.html': 'same', 'vi/index.html': 'same', [resource]: 'bbbb' });
    const scope = affectedRoutes(a, b); assert.equal(scope.full, true); assert.deepEqual(scope.routes, ['/', '/vi/']);
  });
}
test('missing/corrupt baseline falls back full; missing current homepage fails closed', () => {
  assert.equal(affectedRoutes(null, before).full, true);
  assert.equal(affectedRoutes({ ...before, sha256: '0'.repeat(64) }, before).full, true);
  assert.throws(() => affectedRoutes(before, manifest({ 'other/index.html': 'x' })), /homepage/);
});
test('unchanged artifact still receives a homepage smoke check', () => {
  assert.deepEqual(affectedRoutes(before, before).routes, ['/']);
  assert.equal(affectedRoutes(before, before).full, false);
});
test('manifest rejects duplicate paths, path escapes and altered receipts', () => {
  assert.equal(validManifest(before), true);
  for (const key of ['../escape', '/absolute', 'x\\y', 'x//y']) assert.equal(validManifest(manifest({ [key]: 'x' })), false);
  assert.equal(validManifest({ ...before, files: 123 }), false);
  assert.equal(validManifest({ ...before, manifest: [...before.manifest, before.manifest[0]] }), false);
});
const qualification = () => ({ schemaVersion: 1, source: before, sourceSha: before.sha256, runtimeKey: digest('runtime'), codePassed: true, websitePassed: true, adminPassed: true,
  website: before, adminSha: digest('admin'), artifactSha: digest('artifact'), configSha: digest('config'), enabledLocales: ['en'] });
test('qualification binds all stages, source manifest, runtime and artifact identities', () => {
  const q = qualification(); assert.equal(qualificationMatches(q, q.sourceSha, q.runtimeKey), true);
  for (const field of ['codePassed','websitePassed','adminPassed']) assert.equal(qualificationMatches({ ...q, [field]: false }, q.sourceSha, q.runtimeKey), false);
  for (const field of ['sourceSha','runtimeKey','adminSha','artifactSha','configSha']) assert.equal(qualificationMatches({ ...q, [field]: 'changed' }, q.sourceSha, q.runtimeKey), false);
  assert.equal(qualificationMatches(q, q.sourceSha, null), false);
});
test('writable qualification cannot authorize skipping program checks', async t => {
  const root = await scratch(t), q = qualification(); atomicJson(path.join(root, 'qualification.json'), q);
  assert.equal(readQualification(root, q.sourceSha, q.runtimeKey), null);
  assert.equal(runtimeIdentity(root, {}), null);
});
test('qualified source check detects real implementation changes', async t => {
  const root = await scratch(t); await mkdir(path.join(root, 'worker'));
  await writeFile(path.join(root, 'worker/code.mjs'), 'original');
  const q = { source: manifest({ 'worker/code.mjs': 'original', 'src/i18n/en.json': 'original-copy' }) };
  await checkQualifiedSource(q, root); // content materialization is separately validated on every job
  await writeFile(path.join(root, 'worker/code.mjs'), 'modified');
  await assert.rejects(checkQualifiedSource(q, root), /no longer matches/);
});
async function artifacts(t) {
  const root = await scratch(t), dist = path.join(root, 'dist'), state = path.join(root, 'state'), qualified = path.join(root, 'qualified');
  await mkdir(path.join(dist, 'admin'), { recursive: true });
  await writeFile(path.join(dist, 'index.html'), 'verified-content'); await writeFile(path.join(dist, 'admin/index.html'), 'verified-admin');
  const q = { ...qualification(), root: qualified, website: artifactManifest(dist), adminSha: directoryDigest(path.join(dist, 'admin')).sha256, artifactSha: directoryDigest(dist).sha256 };
  return { root, dist, state, q };
}
test('successful artifact round trip requires exact content/source/runtime and preserves bytes', async t => {
  const { dist, state, q } = await artifacts(t);
  await saveArtifact(state, q, q.configSha, dist);
  const cached = await reusableArtifact(state, q, q.configSha); assert.ok(cached);
  assert.equal(await readFile(path.join(cached.root, 'index.html'), 'utf8'), 'verified-content');
  assert.equal(await reusableArtifact(state, q, digest('other-content')), null);
  assert.equal(await reusableArtifact(state, { ...q, runtimeKey: digest('other-runtime') }, q.configSha), null);
  assert.equal(await reusableArtifact(state, { ...q, sourceSha: digest('other-source') }, q.configSha), null);
});
test('artifact and admin tampering force rebuild instead of quick rollback', async t => {
  const { dist, state, q } = await artifacts(t); await saveArtifact(state, q, q.configSha, dist);
  const cached = await reusableArtifact(state, q, q.configSha);
  await writeFile(path.join(cached.root, 'admin/index.html'), 'damaged');
  assert.equal(await reusableArtifact(state, q, q.configSha), null);
});
test('missing or damaged qualification artifacts invalidate qualification before any gates are skipped', async t => {
  const { dist, q } = await artifacts(t);
  assert.equal(qualificationArtifactsValid(q.root, q), false);
  await cp(dist, path.join(q.root, 'artifact'), { recursive: true });
  assert.equal(qualificationArtifactsValid(q.root, q), true);
  assert.equal(qualificationArtifactsValid(q.root, { ...q, website: before }), false);
  await rename(path.join(q.root, 'artifact/admin'), path.join(q.root, 'removed-admin'));
  assert.equal(qualificationArtifactsValid(q.root, q), false);
  await rename(path.join(q.root, 'removed-admin'), path.join(q.root, 'artifact/admin'));
  await writeFile(path.join(q.root, 'artifact/admin/index.html'), 'damaged');
  assert.equal(qualificationArtifactsValid(q.root, q), false);
});
test('qualification stage retry replaces stale files and preserves the previous stage', async t => {
  const { root, dist } = await artifacts(t), output = path.join(root, 'output');
  await mkdir(path.join(output, 'artifact'), { recursive: true });
  await writeFile(path.join(output, 'artifact/stale.js'), 'leftover');
  await replaceQualifiedStage(output, 'artifact', dist, directoryDigest(dist).sha256);
  assert.deepEqual(await readdir(path.join(output, 'artifact')), ['admin', 'index.html']);
  const saved = await readdir(path.join(output, '.trash'));
  assert.equal(await readFile(path.join(output, '.trash', saved[0], 'stale.js'), 'utf8'), 'leftover');
  await assert.rejects(replaceQualifiedStage(output, 'artifact', dist, digest('incorrect')), /产物内容已变化/);
  assert.equal(directoryDigest(path.join(output, 'artifact')).sha256, directoryDigest(dist).sha256);
});
test('cache is bounded and cancellation never creates a reusable record', async t => {
  const { dist, state, q } = await artifacts(t);
  await assert.rejects(saveArtifact(state, q, q.configSha, dist, AbortSignal.abort()), /abort/i);
  for (let i = 0; i < 10; i++) await saveArtifact(state, q, digest(`content-${i}`), dist);
  assert.equal((await readdir(path.join(state, 'artifacts'))).length, 8);
});
test('verified website receipt is isolated by source and runtime and rejects corrupt manifests', async t => {
  const { state, q } = await artifacts(t), changed = manifest({ 'index.html': 'new' });
  const file = path.join(state, 'verified-website.json');
  atomicJson(file, { sourceSha: q.sourceSha, runtimeKey: q.runtimeKey, website: changed });
  assert.deepEqual(cachedWebsite(state, q), changed);
  assert.deepEqual(cachedWebsite(state, { ...q, runtimeKey: 'changed' }), q.website);
  atomicJson(file, { sourceSha: q.sourceSha, runtimeKey: q.runtimeKey, website: { ...changed, sha256: 'bad' } });
  assert.deepEqual(cachedWebsite(state, q), q.website);
});
test('symlink cache roots are rejected before any artifact write', async t => {
  const { root, dist, state, q } = await artifacts(t), outside = path.join(root, 'outside');
  await mkdir(state); await mkdir(outside);
  await symlink(outside, path.join(state, 'artifacts'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(saveArtifact(state, q, q.configSha, dist), /escaped/);
  assert.deepEqual(await readdir(outside), []);
});

test('qualified content still builds and runs content gates, scopes layout, and never invokes code suites', async t => {
  const root = await scratch(t), events = [];
  for (const dir of ['src/config', 'worker']) await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(path.join(root, 'src/config/site.json'), JSON.stringify({ enabledLocales: ['en'] }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: { build: 'node build.mjs', 'verify:prod': 'node verify.mjs' } }));
  await writeFile(path.join(root, 'build.mjs'), "import{mkdirSync,writeFileSync}from'node:fs';mkdirSync('dist/learn',{recursive:true});writeFileSync('dist/index.html','new');writeFileSync('dist/learn/index.html','same');");
  await writeFile(path.join(root, 'verify.mjs'), "import{writeFileSync}from'node:fs';writeFileSync('verify-args.json',JSON.stringify(process.argv.slice(2)));writeFileSync('.verify-exit.code','0');");
  await writeFile(path.join(root, 'worker/package.json'), '{"type":"module"}');
  for (const name of ['gate-config-consistency.mjs','gate-console-copy.mjs','gate-beacon-size.mjs']) await writeFile(path.join(root, 'worker', name), 'console.log("content checked");');
  const result = await runGates(root, 'aws', { onCheck: e => events.push(e) }, {
    qualification: { root: '/qualified-program' }, previousWebsite: manifest({ 'index.html': 'old', 'learn/index.html': 'same' }),
    onCodeQualified: () => assert.fail('already qualified code must not issue another code pass'),
  });
  assert.equal(result.ok, true, result.tail); assert.deepEqual(result.impact.routes, ['/']);
  const args = JSON.parse(await readFile(path.join(root, 'verify-args.json'), 'utf8'));
  assert.equal(args[args.indexOf('--routes') + 1], '/'); assert.equal(args[args.indexOf('--qualified-code') + 1], '/qualified-program');
  assert.equal(events.filter(e => e.title === 'site-build' && e.status === 'ok').length, 1);
  for (const title of ['config-consistency','console-copy','beacon-size']) assert.ok(events.some(e => e.title === title && e.status === 'ok'));
  for (const title of ['worker-types','worker-单测','publisher-故障回归']) assert.ok(events.some(e => e.title === title && e.status === 'skipped'));
});
