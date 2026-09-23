import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runCommand } from './runner-core.mjs';

const scratch = async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nexgrid-checks-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

test('[publish-check] lines parse in order and report all (no coalescing)', async (t) => {
  const dir = await scratch(t);
  const events = [];
  const script = `
    console.log('[publish-check] ' + JSON.stringify({ step: 'gates', title: 'gate-a', status: 'running' }));
    console.log('[publish-check] ' + JSON.stringify({ step: 'gates', title: 'gate-b', status: 'running' }));
    console.log('[publish-check] ' + JSON.stringify({ step: 'gates', title: 'gate-a', status: 'ok' }));
  `;
  const result = await runCommand(process.execPath, ['-e', script], {
    cwd: dir, onCheck: async (check) => { events.push(check); },
  });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(events, [
    { step: 'gates', title: 'gate-a', status: 'running' },
    { step: 'gates', title: 'gate-b', status: 'running' },
    { step: 'gates', title: 'gate-a', status: 'ok' },
  ]);
});

test('[publish-check] survives split UTF-8 lines; stderr is not parsed', async (t) => {
  const dir = await scratch(t);
  const events = [];
  const script = `
    const line = Buffer.from('[publish-check] ' + JSON.stringify({ step: 'gates', title: '文字门', status: 'running' }) + '\\n');
    process.stdout.write(line.subarray(0, 20));
    process.stderr.write('[publish-check] ' + JSON.stringify({ step: 'gates', title: 'stderr-gate', status: 'running' }) + '\\n');
    setTimeout(() => { process.stdout.write(line.subarray(20)); }, 20);
  `;
  const result = await runCommand(process.execPath, ['-e', script], {
    cwd: dir, onCheck: async (check) => { events.push(check); },
  });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(events, [{ step: 'gates', title: '文字门', status: 'running' }]);
  assert.match(result.output, /stderr-gate/);
});

test('invalid [publish-check] JSON or status stops the owned command', async (t) => {
  const dir = await scratch(t);
  for (const payload of ['{invalid', '{"title":"","status":"running"}', '{"title":"gate-x","status":"bogus"}']) {
    const children = [];
    const result = await runCommand(process.execPath, ['-e', `
      console.log('[publish-check] ' + ${JSON.stringify(payload)});
      setTimeout(()=>require('node:fs').writeFileSync('must-not-finish','unsafe'),1000);
    `], { cwd: dir, timeoutMs: 4000, onChild: (pid) => children.push(pid), onCheck: async () => {} });
    assert.equal(result.code, null, result.output);
    assert.match(result.output, /命令进度未能持久化/);
    assert.equal(children.at(-1), null);
  }
  await assert.rejects(async () => { const { readFile } = await import('node:fs/promises'); await readFile(path.join(dir, 'must-not-finish')); });
});

test('[publish-check] is independent from [publish-progress] coalescing', async (t) => {
  const dir = await scratch(t);
  const progress = [];
  const checks = [];
  const result = await runCommand(process.execPath, ['-e', `
    for (const d of ['older-1','older-2','latest-3']) console.log('[publish-progress] ' + JSON.stringify({ detail: d }));
    for (const g of ['ga','gb','gc']) console.log('[publish-check] ' + JSON.stringify({ step: 'gates', title: g, status: 'ok' }));
    setTimeout(()=>{},300);
  `], {
    cwd: dir,
    onProgress: async (detail) => { progress.push(detail); await delay(150); },
    onCheck: async (check) => { checks.push(check.title); },
  });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(checks, ['ga', 'gb', 'gc']);
});

test('failed child cancels pending checks instead of reporting them', async (t) => {
  const dir = await scratch(t);
  const checks = [];
  const result = await runCommand(process.execPath, ['-e', `
    console.log('[publish-check] ' + JSON.stringify({ step: 'gates', title: 'slow-gate', status: 'running' }));
    process.exit(7);
  `], {
    cwd: dir,
    onCheck: async () => new Promise(() => {}),
  });
  assert.equal(result.code, 7, result.output);
  assert.deepEqual(checks, []);
});

test('missing step defaults to gates', async (t) => {
  const dir = await scratch(t);
  const events = [];
  const result = await runCommand(process.execPath, ['-e', `
    console.log('[publish-check] ' + JSON.stringify({ title: 'no-step-gate', status: 'ok' }));
  `], { cwd: dir, onCheck: async (check) => { events.push(check); } });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(events, [{ step: 'gates', title: 'no-step-gate', status: 'ok' }]);
});

test('failed child drains its failed row before finishing (no lone running)', async (t) => {
  const dir = await scratch(t);
  const events = [];
  const result = await runCommand(process.execPath, ['-e', `
    console.log('[publish-check] ' + JSON.stringify({ step: 'gates', title: 'red-gate', status: 'running' }));
    console.log('[publish-check] ' + JSON.stringify({ step: 'gates', title: 'red-gate', status: 'failed', output: 'boom' }));
    process.exit(7);
  `], { cwd: dir, onCheck: async (check) => { events.push(check); } });
  assert.equal(result.code, 7, result.output);
  assert.deepEqual(events.map((e) => `${e.title}/${e.status}`), ['red-gate/running', 'red-gate/failed']);
});

test('runner reports a failed gate check after a nonzero command exit', async (t) => {
  const root = await scratch(t);
  const source = fileURLToPath(new URL('../..', import.meta.url));
  for (const rel of [
    'worker/runner.mjs', 'worker/register-ts-ext.mjs', 'worker/ts-ext-resolver.mjs',
    'worker/lib/runner-core.mjs', 'worker/lib/runner-artifacts.mjs',
    'worker/lib/runner-child.mjs', 'worker/lib/read-jsonc.mjs',
    'schema/src/locales.ts', 'schema/src/publish-feedback.ts',
  ]) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await copyFile(path.join(source, rel), path.join(root, rel));
  }
  await mkdir(path.join(root, 'worker/seed'), { recursive: true });
  await mkdir(path.join(root, 'src/i18n'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(root, 'worker/package.json'), '{"type":"module"}');
  await writeFile(path.join(root, 'schema/src/materialize.ts'), 'export const materializeI18n=()=>"{}";export const materializeSiteJson=()=>"{}";');
  await writeFile(path.join(root, 'worker/seed/copy-manifest.json'), '{}');
  await writeFile(path.join(root, 'src/i18n/en.json'), '{}');
  await writeFile(path.join(root, 'worker/lib/runner-gates.mjs'), `
    import { runCommand } from './runner-core.mjs';
    export const runSourceBaseline = async () => ({ ok: true });
    export const validateMaterialized = async () => ({ ok: true });
    export async function runGates(_site, _mode, options) {
      await options.onCheck({ step: 'gates', title: 'red-gate', status: 'running' });
      const result = await runCommand(process.execPath, ['-e', 'process.stderr.write("forced gate failure");process.exit(7)'], options);
      if (result.code !== 0 || result.aborted) return { ok: false, gate: 'red-gate', tail: result.output };
      throw new Error('fixture command unexpectedly passed');
    }
    export const runNpm = () => { throw new Error('later build must not run'); };
  `);
  const git = await runCommand('git', ['init', '--quiet'], { cwd: root });
  assert.equal(git.code, 0, git.output);
  const state = path.join(tmpdir(), `nexgrid-publisher-${createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 20)}`);
  t.after(() => rm(state, { recursive: true, force: true }));

  const calls = [];
  let activeVersion = null;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ url: req.url, body });
    let response = { ok: true };
    if (req.url.startsWith('/api/publish/runner-state')) response = { environment: 'dev', activeVersion };
    if (req.url === '/api/publish/next') { activeVersion = 41; response = { job: { versionId: 41, stamp: 'fixture-stamp', config: {} } }; }
    if (req.url === '/api/publish/runner-fail') { activeVersion = null; response = { ok: true, status: 'failed' }; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const result = await runCommand(process.execPath, ['--import', './worker/register-ts-ext.mjs', 'worker/runner.mjs', '--once'], {
    cwd: root, timeoutMs: 30000,
    env: { ...process.env, PUBLISH_MODE: 'local', PUBLISH_RUNNER_TOKEN: 'fixture-token-abcdefghijklmnopqrstuvwxyz', PUBLISH_API_URL: `http://127.0.0.1:${server.address().port}` },
  });
  assert.equal(result.code, 1, result.output);
  const gateChecks = calls.filter(call => call.url === '/api/publish/check' && call.body?.title === 'red-gate').map(call => call.body.status);
  assert.deepEqual(gateChecks, ['running', 'failed']);
  assert.deepEqual(calls.filter(call => call.url === '/api/publish/check' && call.body?.title === '构建并检查官网').map(call => call.body.status), ['running', 'failed']);
  assert.ok(calls.some(call => call.url === '/api/publish/runner-fail'));
  assert.equal(calls.some(call => call.url === '/api/publish/step' && ['build', 'swap'].includes(call.body?.step)), false);
  const evidenceDir = path.join(state, 'evidence');
  assert.match(await readFile(path.join(evidenceDir, (await readdir(evidenceDir))[0]), 'utf8'), /forced gate failure/);
});
