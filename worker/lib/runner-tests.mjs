import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile, cp, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseOptions, acquireLock, createApi, startLease, runCommand, verifyExit, createWorkspace, processAlive, killProcessTree, childEnvironment } from './runner-core.mjs';
import { validateMaterialized, runGates, runNpm } from './runner-gates.mjs';
import * as gates from './runner-gates.mjs';

const token = 'test-runner-token-at-least-thirty-two-bytes';
const scratch = async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nexgrid-runner-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

async function snapshotDigest(root) {
  const hash = createHash('sha256');
  const walk = async (relative = '') => {
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(rel);
      else { assert.equal(entry.isFile(), true, 'snapshot must contain regular files'); hash.update(rel); hash.update(await readFile(path.join(root, rel))); }
    }
  };
  try { await walk(); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  return hash.digest('hex');
}

test('configuration rejects missing/short machine secret and cookie auth', () => {
  assert.throws(() => parseOptions([], {}), /PUBLISH_RUNNER_TOKEN/);
  assert.throws(() => parseOptions([], { PUBLISH_RUNNER_TOKEN: 'short' }), /PUBLISH_RUNNER_TOKEN/);
  assert.throws(() => parseOptions(['--cookie', 'nx_sid=x'], { PUBLISH_RUNNER_TOKEN: token }), /cookie|未知参数/);
});

test('publisher children disable Wrangler background requests even when parent flags explicitly enable them', async (t) => {
  const root = await scratch(t);
  const parent = { WRANGLER_HIDE_BANNER: 'false', WRANGLER_SEND_METRICS: 'true', PUBLISH_RUNNER_TOKEN: token, PUBLISH_STAMP: 'private-job-stamp', KEEP_PUBLISH_TEST: 'unchanged', NODE_ENV: 'test' };
  const inherited = childEnvironment(parent);
  assert.deepEqual(inherited, { WRANGLER_HIDE_BANNER: 'true', WRANGLER_SEND_METRICS: 'false', KEEP_PUBLISH_TEST: 'unchanged', NODE_ENV: 'test' });
  assert.equal(parent.WRANGLER_HIDE_BANNER, 'false');
  assert.equal(parent.WRANGLER_SEND_METRICS, 'true');
  const result = await runCommand(process.execPath, ['-e', "console.log(JSON.stringify({hide:process.env.WRANGLER_HIDE_BANNER,metrics:process.env.WRANGLER_SEND_METRICS,keep:process.env.KEEP_PUBLISH_TEST,hasToken:!!process.env.PUBLISH_RUNNER_TOKEN,hasStamp:!!process.env.PUBLISH_STAMP}))"], { cwd: root, env: { ...childEnvironment(), ...inherited } });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(JSON.parse(result.output.trim()), { hide: 'true', metrics: 'false', keep: 'unchanged', hasToken: false, hasStamp: false });
});

test('local mode is loopback-only; production requires HTTPS and explicit deployment config', () => {
  for (const api of ['http://example.com', 'https://127.0.0.1.evil.test', 'http://0.0.0.0']) {
    assert.throws(() => parseOptions(['--api', api], { PUBLISH_RUNNER_TOKEN: token }), /loopback/);
  }
  const o = parseOptions(['--api', 'http://[::1]:8787', '--once'], { PUBLISH_RUNNER_TOKEN: token });
  assert.equal(o.mode, 'local');
  assert.throws(() => parseOptions(['--once', '--version', '9'], { PUBLISH_RUNNER_TOKEN: token, PUBLISH_MODE: 'production', PUBLISH_API_URL: 'https://site.example' }), /PUBLISH_WRANGLER_CONFIG/);
  assert.throws(() => parseOptions(['--once', '--version', '9'], { PUBLISH_RUNNER_TOKEN: token, PUBLISH_MODE: 'production', PUBLISH_API_URL: 'http://site.example', PUBLISH_WRANGLER_CONFIG: 'worker/prod.jsonc' }), /HTTPS/);
});

test('lock refuses a second runner and unknown ownership, releases only its own lock', async (t) => {
  const dir = await scratch(t);
  const lock = await acquireLock(dir);
  await assert.rejects(acquireLock(dir), /已运行|活跃/);
  await lock.release();
  await writeFile(path.join(dir, 'runner.lock'), '{broken');
  await assert.rejects(acquireLock(dir), /无法确认|未知/);
});

test('nonzero subprocess cannot pass verify even with an exit-code file containing zero', async (t) => {
  const dir = await scratch(t);
  await writeFile(path.join(dir, '.verify-exit.code'), '0');
  const result = await runCommand(process.execPath, ['-e', 'process.exit(7)'], { cwd: dir });
  assert.equal(result.code, 7);
  assert.equal((await verifyExit(dir, result)).ok, false);
  await rm(path.join(dir, '.verify-exit.code'));
  assert.equal((await verifyExit(dir, { code: 0, output: '' })).ok, false);
});

test('lease loss aborts a live subprocess before it can write its completion marker', async (t) => {
  const dir = await scratch(t);
  let renewals = 0;
  const lease = startLease(async () => {
    renewals++;
    if (renewals > 1) throw new Error('network unavailable');
    return { ok: true };
  }, { intervalMs: 20, graceMs: 65, requestTimeoutMs: 20 });
  await lease.ready;
  const child = runCommand(process.execPath, ['-e', "setTimeout(()=>require('node:fs').writeFileSync('should-not-exist','bad'),1200)"], { cwd: dir, signal: lease.signal });
  const result = await child;
  lease.stop();
  assert.equal(lease.signal.aborted, true);
  assert.notEqual(result.code, 0);
  await assert.rejects(readFile(path.join(dir, 'should-not-exist')));
});

test('authentication rejection aborts the lease immediately without waiting for network grace', async () => {
  const error = Object.assign(new Error('unauthorized'), { status: 401 });
  const lease = startLease(async () => { throw error; }, { intervalMs: 10, graceMs: 5000 });
  await assert.rejects(lease.ready, /unauthorized/);
  assert.equal(lease.signal.aborted, true);
  lease.stop();
});

test('API sends Bearer identity without cookies and rejects redirects instead of leaking identity', async (t) => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.headers);
    if (req.url === '/redirect') { res.writeHead(302, { location: '/stolen' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const api = createApi({ api: `http://127.0.0.1:${server.address().port}`, token, requestTimeoutMs: 100 });
  await api('/normal', {});
  assert.equal(seen[0].authorization, `Bearer ${token}`);
  assert.equal(seen[0].cookie, undefined);
  await assert.rejects(api('/redirect', {}), /302/);
  assert.equal(seen.length, 2);
});

test('hung API request has a deadline', async (t) => {
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const api = createApi({ api: `http://127.0.0.1:${server.address().port}`, token, requestTimeoutMs: 30 });
  await assert.rejects(api('/hung', {}), /timeout|超时/i);
});

test('isolated workspace copies tracked and untracked source but never materializes the source checkout', async (t) => {
  const dir = await scratch(t);
  const site = path.join(dir, 'source');
  await mkdir(site);
  const git = async (...args) => { const r = await runCommand('git', args, { cwd: site }); assert.equal(r.code, 0, r.output); };
  await git('init', '--quiet');
  await writeFile(path.join(site, '.gitignore'), 'ignored.txt\nnode_modules/\n');
  await writeFile(path.join(site, 'tracked.txt'), 'original');
  await git('add', '.gitignore', 'tracked.txt');
  await writeFile(path.join(site, 'untracked.txt'), 'included');
  await writeFile(path.join(site, 'ignored.txt'), 'excluded');
  const workspace = await createWorkspace(site, path.join(dir, 'jobs'));
  t.after(() => workspace.cleanup());
  await writeFile(path.join(workspace.site, 'tracked.txt'), 'materialized');
  assert.equal(await readFile(path.join(site, 'tracked.txt'), 'utf8'), 'original');
  assert.equal(await readFile(path.join(workspace.site, 'untracked.txt'), 'utf8'), 'included');
  await assert.rejects(readFile(path.join(workspace.site, 'ignored.txt')));
  assert.ok(!workspace.site.startsWith(`${site}${path.sep}`));
});

test('isolated real worker regenerates ignored binding types before its full typecheck', async (t) => {
  const root = await scratch(t);
  const origin = path.join(root, 'source');
  const sourceRoot = fileURLToPath(new URL('../..', import.meta.url));
  // Build a git origin from current source so this test also runs inside a publication snapshot without .git.
  for (const rel of ['worker/src', 'worker/test', 'worker/seed', 'schema/src']) {
    await cp(path.join(sourceRoot, rel), path.join(origin, rel), { recursive: true });
  }
  for (const rel of ['worker/package.json', 'worker/tsconfig.json', 'worker/wrangler.jsonc', 'worker/.gitignore', 'schema/package.json', 'scripts/forbidden-patterns.mjs']) {
    await mkdir(path.dirname(path.join(origin, rel)), { recursive: true });
    await copyFile(path.join(sourceRoot, rel), path.join(origin, rel));
  }
  await writeFile(path.join(origin, '.gitignore'), 'node_modules/\n');
  for (const rel of ['node_modules', 'worker/node_modules']) {
    await symlink(path.join(sourceRoot, rel), path.join(origin, rel), process.platform === 'win32' ? 'junction' : 'dir');
  }
  const staleTypes = '// stale original declaration must never be consumed or overwritten\n';
  await writeFile(path.join(origin, 'worker/worker-configuration.d.ts'), staleTypes);
  const git = await runCommand('git', ['init', '--quiet'], { cwd: origin });
  assert.equal(git.code, 0, git.output);
  const workspace = await createWorkspace(origin, path.join(root, 'jobs'));
  try {
    const generatedFile = path.join(workspace.site, 'worker/worker-configuration.d.ts');
    await assert.rejects(readFile(generatedFile), { code: 'ENOENT' });
    const before = await runNpm(['run', 'typecheck'], { cwd: path.join(workspace.site, 'worker') });
    assert.notEqual(before.code, 0, 'the missing generated declaration must reproduce the real failure');
    assert.match(before.output, /CloudflareBindings|Property '(?:DB|KV)' does not exist/);
    assert.equal(typeof gates.generateWorkerTypes, 'function', 'the publishing gates must regenerate binding types');
    const generated = await gates.generateWorkerTypes(workspace.site);
    assert.equal(generated.ok, true, generated.tail);
    const types = await readFile(generatedFile, 'utf8');
    assert.match(types, /DB: D1Database/);
    assert.match(types, /KV: KVNamespace/);
    const after = await runNpm(['run', 'typecheck'], { cwd: path.join(workspace.site, 'worker') });
    assert.equal(after.code, 0, after.output);
    assert.equal(await readFile(path.join(origin, 'worker/worker-configuration.d.ts'), 'utf8'), staleTypes);
  } finally { await workspace.cleanup(); }
});

test('binding generation failure or missing output stops the gate chain before any typecheck', async (t) => {
  for (const mode of ['nonzero', 'missing-output']) {
    const root = await scratch(t);
    await mkdir(path.join(root, 'worker'));
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'node typecheck.cjs' } }));
    await writeFile(path.join(root, 'typecheck.cjs'), "require('node:fs').writeFileSync('must-not-run','bad')");
    await writeFile(path.join(root, 'worker/package.json'), JSON.stringify({ scripts: { types: 'node types.cjs' } }));
    await writeFile(path.join(root, 'worker/types.cjs'), mode === 'nonzero'
      ? "require('node:fs').writeFileSync('worker-configuration.d.ts','partial'); process.exit(7)"
      : 'process.exit(0)');
    await writeFile(path.join(root, 'worker/worker-configuration.d.ts'), 'stale');
    const result = await runGates(root, 'local');
    assert.equal(result.ok, false, mode);
    assert.equal(result.gate, 'worker-types', `${mode}: ${result.tail}`);
    await assert.rejects(readFile(path.join(root, 'must-not-run')), { code: 'ENOENT' });
    if (mode === 'missing-output') await assert.rejects(readFile(path.join(root, 'worker/worker-configuration.d.ts')), { code: 'ENOENT' });
  }
});

test('a cold isolated site builds current content and supplies private assets to real worker static tests and final gates', async (t) => {
  await import('../register-ts-ext.mjs');
  const root = await scratch(t);
  const origin = path.join(root, 'source');
  const sourceRoot = fileURLToPath(new URL('../..', import.meta.url));
  const originalLiveDigest = await snapshotDigest(path.join(sourceRoot, 'dist-live'));
  for (const rel of ['src', 'public', 'schema/src', 'scripts', 'worker/src', 'worker/test', 'worker/seed', 'worker/migrations', 'admin/src']) await cp(path.join(sourceRoot, rel), path.join(origin, rel), { recursive: true });
  for (const rel of ['package.json', 'astro.config.mjs', 'tsconfig.json', 'worker/package.json', 'worker/tsconfig.json', 'worker/vitest.config.ts', 'worker/wrangler.jsonc', 'worker/gate-config-consistency.mjs', 'worker/gate-console-copy.mjs', 'worker/gate-beacon-size.mjs', 'worker/lib/read-jsonc.mjs', 'admin/package.json', 'admin/tsconfig.json']) {
    await mkdir(path.dirname(path.join(origin, rel)), { recursive: true });
    await copyFile(path.join(sourceRoot, rel), path.join(origin, rel));
  }
  const pkg = JSON.parse(await readFile(path.join(origin, 'package.json'), 'utf8'));
  pkg.scripts.typecheck = 'node -e "process.exit(0)"';
  pkg.scripts.verify = 'node verify-order.cjs';
  await writeFile(path.join(origin, 'package.json'), JSON.stringify(pkg));
  await writeFile(path.join(origin, '.gitignore'), 'node_modules/\ndist/\ndist-live/\n.astro/\nworker/worker-configuration.d.ts\n');
  for (const rel of ['node_modules', 'worker/node_modules', 'admin/node_modules']) await symlink(path.join(sourceRoot, rel), path.join(origin, rel), process.platform === 'win32' ? 'junction' : 'dir');
  const marker = 'Cold publication artifact proof';
  await writeFile(path.join(origin, 'verify-order.cjs'), `const fs=require('node:fs'); const assert=require('node:assert/strict'); assert.ok(fs.readFileSync('dist/index.html','utf8').includes(${JSON.stringify(marker)})); for(const locale of ['vi','zh']) assert.ok(fs.readFileSync('dist/'+locale+'/index.html','utf8').length>0); fs.writeFileSync('.verify-exit.code','2'); console.log('CURRENT_BUILD_PRECEDES_VERIFY'); process.exit(7);`);
  const git = await runCommand('git', ['init', '--quiet'], { cwd: origin });
  assert.equal(git.code, 0, git.output);
  const originalCopy = await readFile(path.join(origin, 'src/i18n/en.json'), 'utf8');
  const workspace = await createWorkspace(origin, path.join(root, 'jobs'));
  try {
    await assert.rejects(readFile(path.join(workspace.site, 'dist/index.html')), { code: 'ENOENT' });
    const config = JSON.parse(await readFile(path.join(sourceRoot, 'worker/seed/site-config.seed.json'), 'utf8'));
    config.copy.en['hero.subtitle'] = marker;
    const manifest = JSON.parse(await readFile(path.join(sourceRoot, 'worker/seed/copy-manifest.json'), 'utf8'));
    const { materializeI18n, materializeSiteJson } = await import(new URL('../../schema/src/materialize.ts', import.meta.url).href);
    for (const locale of ['en', 'vi', 'zh']) await writeFile(path.join(workspace.site, `src/i18n/${locale}.json`), materializeI18n(config, manifest, locale));
    await writeFile(path.join(workspace.site, 'src/config/site.json'), materializeSiteJson(config));
    const result = await runGates(workspace.site, 'local');
    assert.equal(result.gate, 'verify-process', result.tail);
    assert.match(result.tail, /CURRENT_BUILD_PRECEDES_VERIFY/);
    assert.equal(result.ok, false, 'the intentionally failed verification must still block publication');
    await assert.rejects(readFile(path.join(workspace.site, 'dist-live/index.html')), { code: 'ENOENT' });
    const worker = path.join(workspace.site, 'worker');
    const staticArgs = ['node_modules/vitest/vitest.mjs', 'run', 'test/static.spec.ts'];
    const missingAssets = await runCommand(process.execPath, staticArgs, { cwd: worker });
    assert.notEqual(missingAssets.code, 0, 'cold ASSETS must reproduce the original missing-live failure');
    assert.match(missingAssets.output, /2 failed/);
    assert.equal(typeof gates.prepareWorkerTestAssets, 'function');
    await gates.prepareWorkerTestAssets(workspace.site);
    const withAssets = await runCommand(process.execPath, staticArgs, { cwd: worker });
    assert.equal(withAssets.code, 0, withAssets.output);
    assert.match(withAssets.output, /10 passed/);
    for (const gate of ['gate-config-consistency.mjs', 'gate-console-copy.mjs', 'gate-beacon-size.mjs']) {
      const checked = await runCommand(process.execPath, [gate], { cwd: worker });
      assert.equal(checked.code, 0, `${gate}: ${checked.output}`);
    }
    await assert.rejects(readFile(path.join(workspace.site, 'dist-live/.publish-stamp.json')), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(workspace.site, 'dist-live/index.html'), 'utf8'), await readFile(path.join(workspace.site, 'dist/index.html'), 'utf8'));
    assert.equal(await readFile(path.join(origin, 'src/i18n/en.json'), 'utf8'), originalCopy);
    await assert.rejects(readFile(path.join(origin, 'dist/index.html')), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(origin, 'dist-live/index.html')), { code: 'ENOENT' });
    assert.equal(await snapshotDigest(path.join(sourceRoot, 'dist-live')), originalLiveDigest, 'real source live snapshot must not change');
    t.diagnostic(`original dist-live SHA256 unchanged: ${originalLiveDigest ?? 'absent'}`);
  } finally { await workspace.cleanup(); }
});

test('site build failure and missing output cannot pass using a stale dist', async (t) => {
  for (const exitCode of [7, 0]) {
    const root = await scratch(t);
    await mkdir(path.join(root, 'dist'), { recursive: true });
    await writeFile(path.join(root, 'dist/index.html'), 'stale');
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { build: `node -e "process.exit(${exitCode})"` } }));
    assert.equal(typeof gates.buildSiteForGates, 'function');
    const result = await gates.buildSiteForGates(root);
    assert.equal(result.ok, false);
    assert.equal(result.gate, 'site-build');
    await assert.rejects(readFile(path.join(root, 'dist/index.html')), { code: 'ENOENT' });
  }
});

test('verified site assets reach worker gates as a private copy, and checkout paths are refused', async (t) => {
  const root = await scratch(t);
  for (const rel of ['worker', 'admin']) await mkdir(path.join(root, rel));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'node -e "process.exit(0)"', build: 'node build.cjs', verify: 'node verify.cjs' } }));
  await writeFile(path.join(root, 'build.cjs'), "const fs=require('node:fs'); for(const p of ['dist','dist/vi','dist/zh']){fs.mkdirSync(p,{recursive:true});fs.writeFileSync(p+'/index.html','current-verified-content');}");
  await writeFile(path.join(root, 'verify.cjs'), "require('node:fs').writeFileSync('.verify-exit.code','0')");
  await writeFile(path.join(root, 'worker/package.json'), JSON.stringify({ scripts: { types: 'node types.cjs', typecheck: 'node -e "process.exit(0)"', 'test:publisher': 'node worker-order.cjs' } }));
  await writeFile(path.join(root, 'worker/types.cjs'), "require('node:fs').writeFileSync('worker-configuration.d.ts','// fixture')");
  await writeFile(path.join(root, 'worker/worker-order.cjs'), "const fs=require('node:fs');require('node:assert/strict').equal(fs.readFileSync('../dist-live/index.html','utf8'),'current-verified-content'); console.log('PRIVATE_ASSETS_BEFORE_WORKER_GATES'); process.exit(7)");
  await writeFile(path.join(root, 'admin/package.json'), JSON.stringify({ scripts: { typecheck: 'node -e "process.exit(0)"' } }));
  const result = await runGates(root, 'local');
  assert.equal(result.ok, false, 'a subsequent worker gate failure must still stop publication');
  assert.equal(result.gate, 'publisher-故障回归');
  assert.match(result.tail, /PRIVATE_ASSETS_BEFORE_WORKER_GATES/);
  await assert.rejects(readFile(path.join(root, 'dist-live/.publish-stamp.json')), { code: 'ENOENT' });
  await mkdir(path.join(root, '.git'));
  await assert.rejects(gates.prepareWorkerTestAssets(root), /私有隔离副本/);
  assert.equal(await readFile(path.join(root, 'dist-live/index.html'), 'utf8'), 'current-verified-content');
});

test('promotion consumes isolated materialized files and writes verifiable content/stamp without changing source', async (t) => {
  const root = await scratch(t);
  const site = path.join(root, 'isolated');
  const live = path.join(root, 'target', 'dist-live');
  await mkdir(path.join(site, 'dist/admin'), { recursive: true });
  await mkdir(live, { recursive: true });
  await writeFile(path.join(site, 'dist/index.html'), 'new-version');
  await writeFile(path.join(site, 'dist/admin/index.html'), 'console');
  await writeFile(path.join(live, 'index.html'), 'old-version');
  const files = ['src/i18n/en.json', 'src/i18n/vi.json', 'src/i18n/zh.json', 'src/config/site.json'];
  for (const rel of files) { await mkdir(path.dirname(path.join(site, rel)), { recursive: true }); await writeFile(path.join(site, rel), `${JSON.stringify({ rel })}\n`); }
  const result = await runCommand(process.execPath, [fileURLToPath(new URL('../promote.mjs', import.meta.url)), '--source', path.join(site, 'dist'), '--live', live, '--materialized-root', site, '--version', '31'], { cwd: root, env: { ...process.env, PUBLISH_STAMP: 'fixture-stamp' } });
  assert.equal(result.code, 0, result.output);
  assert.equal(await readFile(path.join(live, 'index.html'), 'utf8'), 'new-version');
  const stamp = JSON.parse(await readFile(path.join(live, '.publish-stamp.json'), 'utf8'));
  const parts = await Promise.all(files.map(async (rel) => `${rel}\0${await readFile(path.join(site, rel), 'utf8')}`));
  assert.equal(stamp.configSha, createHash('sha256').update(parts.join('\0')).digest('hex'));
  assert.equal(stamp.versionId, 31);
  assert.equal(stamp.anchors['/index.html'], createHash('sha256').update('new-version').digest('hex'));
  assert.equal(result.output.includes('fixture-stamp'), false);
});

test('promotion refuses missing materialized evidence and preserves previous live bytes', async (t) => {
  const root = await scratch(t);
  await mkdir(path.join(root, 'dist'), { recursive: true });
  await mkdir(path.join(root, 'dist-live'), { recursive: true });
  await writeFile(path.join(root, 'dist/index.html'), 'new-version');
  await writeFile(path.join(root, 'dist-live/index.html'), 'old-version');
  const result = await runCommand(process.execPath, [fileURLToPath(new URL('../promote.mjs', import.meta.url)), '--source', path.join(root, 'dist'), '--live', path.join(root, 'dist-live'), '--materialized-root', path.join(root, 'missing'), '--version', '32'], { cwd: root, env: { ...process.env, PUBLISH_STAMP: 'fixture-stamp' } });
  assert.notEqual(result.code, 0);
  assert.equal(await readFile(path.join(root, 'dist-live/index.html'), 'utf8'), 'old-version');
});

async function runnerFixture(t) {
  const root = await scratch(t);
  const source = fileURLToPath(new URL('..', import.meta.url));
  for (const rel of ['runner.mjs', 'register-ts-ext.mjs', 'ts-ext-resolver.mjs', 'lib/runner-core.mjs', 'lib/runner-gates.mjs', 'lib/runner-child.mjs', 'lib/read-jsonc.mjs']) {
    const dest = path.join(root, 'worker', rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(path.join(source, rel), dest);
  }
  await mkdir(path.join(root, 'schema/src'), { recursive: true });
  await mkdir(path.join(root, 'worker/seed'), { recursive: true });
  await mkdir(path.join(root, 'src/i18n'), { recursive: true });
  await mkdir(path.join(root, 'dist-live'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: { typecheck: 'node -e "process.exit(7)"' } }));
  await writeFile(path.join(root, 'worker/package.json'), JSON.stringify({ type: 'module', scripts: { types: 'node types.mjs' } }));
  await writeFile(path.join(root, 'worker/types.mjs'), "import {writeFileSync} from 'node:fs'; writeFileSync('worker-configuration.d.ts','// fixture bindings');");
  await writeFile(path.join(root, '.gitignore'), 'dist-live/\n');
  await writeFile(path.join(root, 'schema/src/materialize.ts'), 'export const materializeI18n = () => "materialized"; export const materializeSiteJson = () => "{}";');
  await writeFile(path.join(root, 'schema/src/validators.ts'), 'export const validateConfig = () => ({errors:[]});');
  await writeFile(path.join(root, 'worker/gate-equivalence.mjs'), 'console.log("fixture source baseline");');
  await writeFile(path.join(root, 'worker/seed/copy-manifest.json'), '{}');
  await writeFile(path.join(root, 'src/i18n/en.json'), 'original-source');
  await writeFile(path.join(root, 'dist-live/index.html'), 'old-live');
  const git = await runCommand('git', ['init', '--quiet'], { cwd: root });
  assert.equal(git.code, 0, git.output);
  const hash = createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 20);
  const state = path.join(tmpdir(), `nexgrid-publisher-${hash}`);
  t.after(() => rm(state, { recursive: true, force: true }));
  return { root, state };
}

async function apiFixture(t) {
  const calls = [];
  let activeVersion = null;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ url: req.url, body, authorization: req.headers.authorization });
    let response = { ok: true };
    if (req.url.startsWith('/api/publish/runner-state')) response = { environment: 'dev', activeVersion };
    if (req.url === '/api/publish/next') { activeVersion = 41; response = { job: { versionId: 41, stamp: 'job-secret', config: { fixture: true } } }; }
    if (req.url === '/api/publish/runner-fail') activeVersion = null;
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(response));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { calls, url: `http://127.0.0.1:${server.address().port}` };
}

test('real runner closes a failed gate through machine API and never writes source or live snapshot', async (t) => {
  const fixture = await runnerFixture(t);
  const api = await apiFixture(t);
  const result = await runCommand(process.execPath, ['worker/runner.mjs', '--once'], { cwd: fixture.root, env: { ...process.env, PUBLISH_MODE: 'local', PUBLISH_RUNNER_TOKEN: token, PUBLISH_API_URL: api.url } });
  assert.equal(result.code, 1, result.output);
  assert.equal(await readFile(path.join(fixture.root, 'src/i18n/en.json'), 'utf8'), 'original-source');
  assert.equal(await readFile(path.join(fixture.root, 'dist-live/index.html'), 'utf8'), 'old-live');
  assert.ok(api.calls.some((call) => call.body?.step === 'gates' && call.body.status === 'running'));
  assert.ok(api.calls.some((call) => call.url === '/api/publish/runner-fail'));
  assert.equal(api.calls.some((call) => call.body?.step === 'swap'), false);
  assert.equal(api.calls.every((call) => call.authorization === `Bearer ${token}`), true);
  assert.equal(result.output.includes(token) || result.output.includes('job-secret'), false);
  await assert.rejects(readFile(path.join(fixture.state, 'job.json')));
});

test('restart closes a persisted interrupted job without claiming or executing it again', async (t) => {
  const fixture = await runnerFixture(t);
  const api = await apiFixture(t);
  await mkdir(fixture.state, { recursive: true });
  await writeFile(path.join(fixture.state, 'identity'), 'test-persisted-runner-identity');
  await writeFile(path.join(fixture.state, 'job.json'), JSON.stringify({ versionId: 40, stamp: 'old-stamp', runnerId: 'test-persisted-runner-identity', step: 'gates', phase: 'running', childPid: null }));
  const result = await runCommand(process.execPath, ['worker/runner.mjs', '--once'], { cwd: fixture.root, env: { ...process.env, PUBLISH_MODE: 'local', PUBLISH_RUNNER_TOKEN: token, PUBLISH_API_URL: api.url } });
  assert.equal(result.code, 1, result.output);
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].url, '/api/publish/runner-fail');
  assert.equal(api.calls[0].body.versionId, 40);
  await assert.rejects(readFile(path.join(fixture.state, 'job.json')));
});

test('killing the runner disconnects its watchdog and removes the actual command process', async (t) => {
  const root = await scratch(t);
  const driver = path.join(root, 'driver.mjs');
  const pidFile = path.join(root, 'child-pid');
  const command = "require('node:fs').writeFileSync('child-pid',String(process.pid)); setInterval(()=>{},1000)";
  await writeFile(driver, `import {runCommand} from ${JSON.stringify(new URL('./runner-core.mjs', import.meta.url).href)}; await runCommand(process.execPath, ['-e', ${JSON.stringify(command)}], {cwd:${JSON.stringify(root)}});`);
  const parent = spawn(process.execPath, [driver], { cwd: root, stdio: 'ignore', windowsHide: true });
  t.after(() => { if (processAlive(parent.pid) === true) parent.kill(); });
  let commandPid;
  for (let i = 0; i < 60; i++) {
    try { commandPid = Number(await readFile(pidFile, 'utf8')); break; } catch { await delay(25); }
  }
  assert.ok(commandPid > 0, 'command started and wrote PID');
  t.after(async () => { if (processAlive(commandPid) === true) await killProcessTree(commandPid); });
  parent.kill('SIGKILL');
  for (let i = 0; i < 80 && processAlive(commandPid) === true; i++) await delay(25);
  assert.equal(processAlive(commandPid), false, 'orphan command terminated after IPC disconnect');
});

test('failed child identity persistence starts no command, clears safely, and always settles', async (t) => {
  const root = await scratch(t);
  const result = await runCommand(process.execPath, ['-e', "require('node:fs').writeFileSync('must-not-run','unsafe')"], {
    cwd: root,
    onChild() { throw new Error('injected state-write failure'); },
  });
  assert.notEqual(result.code, 0);
  assert.match(result.output, /state-write failure/);
  await delay(150);
  await assert.rejects(readFile(path.join(root, 'must-not-run')));
});

test('a real non-seed configuration passes publishing equivalence; tampered materialized bytes fail', async (t) => {
  await import('../register-ts-ext.mjs');
  const root = await scratch(t);
  const sourceRoot = fileURLToPath(new URL('../..', import.meta.url));
  await mkdir(path.join(root, 'schema'), { recursive: true });
  await mkdir(path.join(root, 'worker/seed'), { recursive: true });
  await cp(path.join(sourceRoot, 'schema/src'), path.join(root, 'schema/src'), { recursive: true });
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await copyFile(path.join(sourceRoot, 'scripts/forbidden-patterns.mjs'), path.join(root, 'scripts/forbidden-patterns.mjs'));
  await symlink(path.join(sourceRoot, 'node_modules'), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await copyFile(path.join(sourceRoot, 'worker/seed/copy-manifest.json'), path.join(root, 'worker/seed/copy-manifest.json'));
  const originalSeed = await readFile(path.join(sourceRoot, 'worker/seed/site-config.seed.json'), 'utf8');
  const config = JSON.parse(originalSeed);
  config.copy.en['hero.subtitle'] = 'Explore connected infrastructure with NexGrid.';
  const manifest = JSON.parse(await readFile(path.join(root, 'worker/seed/copy-manifest.json'), 'utf8'));
  const { materializeI18n, materializeSiteJson } = await import(new URL('../../schema/src/materialize.ts', import.meta.url).href);
  for (const locale of ['en', 'vi', 'zh']) {
    await mkdir(path.join(root, 'src/i18n'), { recursive: true });
    await writeFile(path.join(root, `src/i18n/${locale}.json`), materializeI18n(config, manifest, locale));
  }
  await mkdir(path.join(root, 'src/config'), { recursive: true });
  await writeFile(path.join(root, 'src/config/site.json'), materializeSiteJson(config));
  assert.equal((await validateMaterialized(root, config)).ok, true);
  await writeFile(path.join(root, 'src/i18n/en.json'), '{}');
  const bad = await validateMaterialized(root, config);
  assert.equal(bad.ok, false);
  assert.equal(bad.gate, 'publish-materialization');
  assert.equal(await readFile(path.join(sourceRoot, 'worker/seed/site-config.seed.json'), 'utf8'), originalSeed);
});
