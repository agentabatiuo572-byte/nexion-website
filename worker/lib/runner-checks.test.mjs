import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
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
