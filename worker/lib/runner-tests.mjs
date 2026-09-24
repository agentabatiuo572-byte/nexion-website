import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, copyFile, cp, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promises as fsPromises } from 'node:fs';
import { LOCALES, MATERIALIZED_FILES } from '../../schema/src/locales.ts';
import { decodePublishProgress } from '../../schema/src/publish-feedback.ts';
import { parseOptions, acquireLock, createApi, startLease, runCommand, verifyExit, createWorkspace, processAlive, killProcessTree, childEnvironment, runnerSourceFingerprint } from './runner-core.mjs';
import { validateMaterialized, runGates, runNpm } from './runner-gates.mjs';
import * as gates from './runner-gates.mjs';
import { directoryDigest, assertDigest, redactEvidence } from './runner-artifacts.mjs';

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

test('AI credentials never enter a real publisher build child environment', async (t) => {
  const root = await scratch(t);
  const names = ['AI_CREDENTIAL_ENCRYPTION_KEY', 'AI_TICK_TOKEN', 'OPENAI_API_KEY', 'ai_future_secret'];
  const parent = { ...childEnvironment(), KEEP_AI_ISOLATION_TEST: 'retained' };
  for (const name of names) parent[name] = `sentinel-${name}-private`;
  const env = childEnvironment(parent);
  for (const name of names) { assert.equal(env[name], undefined); assert.ok(parent[name]); }
  const result = await runCommand(process.execPath, ['-e', "const names=Object.keys(process.env).filter(n=>/^(?:AI_|OPENAI_)/i.test(n));console.log(JSON.stringify({names,keep:process.env.KEEP_AI_ISOLATION_TEST}))"], { cwd: root, env });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(JSON.parse(result.output.trim()), { names: [], keep: 'retained' });
});

test('private launcher and Worker state cannot enter a publish workspace even when tracked', async (t) => {
  const root = await scratch(t);
  for (const privatePath of ['.local-start/ai-root.dpapi', 'worker/.dev.vars', 'worker/.dev.vars.production', 'worker/.wrangler/state/credentials.sqlite']) {
    const site = await mkdtemp(path.join(root, 'source-'));
    await mkdir(path.dirname(path.join(site, privatePath)), { recursive: true });
    await writeFile(path.join(site, privatePath), 'private-sentinel-never-copy');
    assert.equal((await runCommand('git', ['init', '--quiet'], { cwd: site })).code, 0);
    assert.equal((await runCommand('git', ['add', '--', privatePath], { cwd: site })).code, 0);
    const jobs = path.join(root, `jobs-${path.basename(site)}`);
    await assert.rejects(createWorkspace(site, jobs), /私有运行配置/);
    assert.deepEqual(await readdir(jobs), []);
  }
  const site = await mkdtemp(path.join(root, 'ignored-source-'));
  await mkdir(path.join(site, 'worker'));
  await writeFile(path.join(site, '.gitignore'), '.local-start/\nworker/.dev.vars\nworker/.wrangler/\n');
  await writeFile(path.join(site, 'worker/.dev.vars'), 'private-sentinel-never-copy');
  await writeFile(path.join(site, 'worker/.dev.vars.example'), 'EXAMPLE=placeholder');
  assert.equal((await runCommand('git', ['init', '--quiet'], { cwd: site })).code, 0);
  const workspace = await createWorkspace(site, path.join(root, 'safe-jobs'));
  try {
    assert.equal(await readFile(path.join(workspace.site, 'worker/.dev.vars.example'), 'utf8'), 'EXAMPLE=placeholder');
    await assert.rejects(readFile(path.join(workspace.site, 'worker/.dev.vars')));
  } finally { await workspace.cleanup(); }
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

test('stdout progress survives split UTF-8 lines and drains in order before command completion', async (t) => {
  const dir = await scratch(t);
  const events = [];
  const script = `
    const line = Buffer.from('[publish-progress] ' + JSON.stringify({detail:'文字检查 1/3'}) + '\\n');
    const split = line.indexOf(Buffer.from('文')) + 1;
    process.stdout.write(line.subarray(0, split));
    process.stderr.write('[publish-progress] ' + JSON.stringify({detail:'stderr is not progress'}) + '\\n');
    setTimeout(() => {
      process.stdout.write(line.subarray(split));
      process.stdout.write('ordinary output\\n[publish-progress] ' + JSON.stringify({detail:'弹窗检查 2/3'}));
    }, 20);
  `;
  const result = await runCommand(process.execPath, ['-e', script], {
    cwd: dir,
    onProgress: async detail => { events.push(`start:${detail}`); await delay(30); events.push(`saved:${detail}`); },
    onCommand: event => { if (event.phase === 'end') events.push('command:end'); },
  });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(events, ['start:文字检查 1/3', 'saved:文字检查 1/3', 'start:弹窗检查 2/3', 'saved:弹窗检查 2/3', 'command:end']);
  assert.match(result.output, /ordinary output/);
  assert.match(result.output, /stderr is not progress/);
});

test('invalid progress and asynchronous progress persistence failures stop the owned command', async (t) => {
  const dir = await scratch(t);
  for (const payload of ['{invalid', '{"detail":17}', '{"detail":"检查页面"}']) {
    const children = [];
    const result = await runCommand(process.execPath, ['-e', `
      console.log('[publish-progress] ' + ${JSON.stringify(payload)});
      setTimeout(()=>require('node:fs').writeFileSync('must-not-finish','unsafe'),1000);
    `], {
      cwd: dir, timeoutMs: 4000, onChild: pid => children.push(pid),
      onProgress: async () => { await delay(10); throw new Error('injected progress save failure'); },
    });
    assert.equal(result.code, null, result.output);
    assert.equal(result.timedOut, false);
    assert.equal(result.terminationUnconfirmed, false);
    assert.match(result.output, /命令进度未能持久化/);
    assert.equal(children.at(-1), null);
    assert.equal(processAlive(children[0]), false);
    await assert.rejects(readFile(path.join(dir, 'must-not-finish')));
  }
});

test('structured progress retains current and latest titles and validates discarded lines immediately', async (t) => {
  const dir = await scratch(t);
  const events = [];
  const result = await runCommand(process.execPath, ['-e', "for(const detail of ['older-1','older-2','latest-3'])console.log('[publish-progress] '+JSON.stringify({detail}))"], {
    cwd: dir, onProgress: async detail => { events.push(detail); await delay(150); },
  });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(events, ['older-1', 'latest-3']);
  const malformed = await runCommand(process.execPath, ['-e', "console.log('[publish-progress] '+JSON.stringify({detail:'first'}));console.log('[publish-progress] {invalid');console.log('[publish-progress] '+JSON.stringify({detail:'last'}));setInterval(()=>{},1000)"], {
    cwd: dir, timeoutMs: 2000, onProgress: () => new Promise(() => {}),
  });
  assert.equal(malformed.code, null);
  assert.equal(malformed.timedOut, false);
  assert.match(malformed.output, /命令进度未能持久化/);
});

test('command deadline still bounds an unfinished progress report after the child exits', async (t) => {
  const dir = await scratch(t);
  let reporting = false;
  const started = performance.now();
  const result = await runCommand(process.execPath, ['-e', `console.log('[publish-progress] ' + JSON.stringify({detail:'检查页面'}))`], {
    cwd: dir, timeoutMs: 1200,
    onProgress: () => { reporting = true; return new Promise(() => {}); },
  });
  assert.equal(reporting, true);
  assert.equal(result.code, null);
  assert.equal(result.timedOut, true);
  assert.equal(result.terminationUnconfirmed, false);
  assert.ok(performance.now() - started < 4000);
});

test('failed child exits before pending progress and ignores its late rejection', async (t) => {
  const dir = await scratch(t);
  const ended = [];
  let rejectProgress;
  const result = await runCommand(process.execPath, ['-e', "console.log('[publish-progress] '+JSON.stringify({detail:'checking'}));console.error('FIRST_GATE_FAILURE');process.exit(7)"], {
    cwd: dir, timeoutMs: 2000,
    onProgress: () => new Promise((_, reject) => { rejectProgress = reject; }),
    onCommand: event => { if (event.phase === 'end') ended.push(event); },
  });
  assert.equal(result.code, 7, result.output);
  assert.equal(result.timedOut, false);
  assert.match(result.output, /FIRST_GATE_FAILURE/);
  assert.equal(typeof rejectProgress, 'function');
  rejectProgress(new Error('LATE_PROGRESS_FAILURE'));
  await delay(20);
  assert.equal(ended.length, 1);
  assert.equal(ended[0].code, 7);
  assert.doesNotMatch(result.output, /LATE_PROGRESS_FAILURE/);
});

test('verify gates stream before exit while retaining complete stdout, stderr and failure status', async (t) => {
  const dir = await scratch(t);
  const stdout = 'gate-first-output\n' + 'x'.repeat(40000) + '\n# pass 19\n';
  const stderr = 'failure-start\n' + 'e'.repeat(40000) + '\nfailure-end\n';
  const fixture = `
    const fs = require('node:fs');
    process.stdout.write('gate-first-output\\n');
    const timer = setInterval(() => {
      if (!fs.existsSync('stream-observed')) return;
      clearInterval(timer);
      process.stdout.write(${JSON.stringify(stdout.slice('gate-first-output\n'.length))});
      process.stderr.write(${JSON.stringify(stderr)});
      process.exitCode = 7;
    }, 20);
  `;
  await writeFile(path.join(dir, 'gate-fixture.cjs'), fixture);
  await writeFile(path.join(dir, 'verify-fixture.mjs'), `
    import {writeFileSync} from 'node:fs';
    import {runGate} from ${JSON.stringify(new URL('../../scripts/verify.mjs', import.meta.url).href)};
    const full = await runGate('完整输出检查', process.execPath, ['gate-fixture.cjs'], {cwd:process.cwd(),encoding:'utf8'});
    const overflow = await runGate('缓冲溢出检查', process.execPath, ['-e', "process.stdout.write('x'.repeat(2000))"], {encoding:'utf8',maxBuffer:64});
    writeFileSync('gate-results.json', JSON.stringify({full,overflow}));
  `);
  let observed;
  const progress = [];
  const result = await runCommand(process.execPath, [path.join(dir, 'verify-fixture.mjs')], {
    cwd: dir, timeoutMs: 8000, onProgress: detail => progress.push(detail),
    onOutput: value => { if (!observed && value.includes('gate-first-output')) observed = writeFile(path.join(dir, 'stream-observed'), 'seen'); },
  });
  assert.equal(result.code, 0, result.output);
  assert.ok(observed, 'gate output must reach its parent before the gate can finish');
  await observed;
  const {full,overflow} = JSON.parse(await readFile(path.join(dir, 'gate-results.json'), 'utf8'));
  assert.equal(full.status, 7);
  assert.equal(full.stdout, stdout);
  assert.equal(full.stderr, stderr);
  assert.equal(overflow.status, null, 'maxBuffer failure must never become exit 0');
  assert.match(overflow.error.code, /MAXBUFFER/);
  assert.deepEqual(progress, ['正在检查：完整输出检查', '正在检查：缓冲溢出检查']);
});

test('command deadlines require finite timer values and report normal exits without retaining their timer', async (t) => {
  for (const timeoutMs of [0, -1, Infinity, NaN, 0.5, 2 ** 31]) {
    assert.throws(() => runCommand(process.execPath, ['-e', 'process.exit(0)'], { timeoutMs }), /timeoutMs/);
  }
  const dir = await scratch(t);
  const events = [];
  const children = [];
  const result = await runCommand(process.execPath, ['-e', "console.log('normal-exit')"], {
    cwd: dir, onCommand: event => events.push(event), onChild: pid => children.push(pid),
  });
  assert.equal(result.code, 0, result.output);
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, false);
  assert.equal(result.terminationUnconfirmed, false);
  assert.deepEqual(events.map(event => event.phase), ['start', 'end']);
  assert.equal(events[0].timeoutMs, 30 * 60 * 1000);
  assert.equal(events[1].startedAt, events[0].startedAt);
  assert.ok(events[1].durationMs >= 0);
  assert.equal(events[1].code, 0);
  assert.ok(children[0] > 0);
  assert.equal(children.at(-1), null);
  assert.equal(processAlive(children[0]), false);

  const shortEvents = [];
  const short = await runCommand(process.execPath, ['-e', 'process.exit(0)'], { cwd: dir, timeoutMs: 1000, onCommand: event => shortEvents.push(event) });
  assert.equal(short.code, 0, short.output);
  await delay(1050);
  assert.deepEqual(shortEvents.map(event => event.phase), ['start', 'end']);
  assert.equal(shortEvents[1].timedOut, false);
});

test('command absolute deadlines stop quiet and continuously printing descendants despite healthy leases; abort remains distinct', { timeout: 15000 }, async (t) => {
  const dir = await scratch(t);
  for (const mode of ['quiet', 'output', 'abort']) {
    let renewals = 0;
    const lease = startLease(async () => { renewals++; return { ok: true }; }, { intervalMs: 20, graceMs: 100, requestTimeoutMs: 30 });
    await lease.ready;
    const controller = new AbortController();
    const children = [];
    const events = [];
    let cancelTimer;
    const descendant = `require('node:fs').writeFileSync(${JSON.stringify(`${mode}-pid`)},String(process.pid)); console.log('DESCENDANT_READY'); setInterval(()=>${mode === 'output' ? "console.log('still-working')" : '{}'},20)`;
    const command = `const cp=require('node:child_process'); cp.spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit'],windowsHide:true}); setInterval(()=>{},1000)`;
    let result;
    const started = performance.now();
    try {
      result = await runCommand(process.execPath, ['-e', command], {
        cwd: dir, timeoutMs: 1200, signal: AbortSignal.any([lease.signal, controller.signal]),
        onChild: pid => children.push(pid), onCommand: event => events.push(event),
        onOutput: value => { if (mode === 'abort' && value.includes('DESCENDANT_READY')) cancelTimer = setTimeout(() => controller.abort(new Error('explicit stop')), 30); },
      });
    } finally {
      lease.stop(); clearTimeout(cancelTimer);
      t.after(async () => { if (processAlive(children[0]) === true) await killProcessTree(children[0]); });
    }
    assert.ok(renewals >= 2, 'healthy heartbeat was exercised while the command ran');
    assert.equal(lease.signal.aborted, false);
    assert.notEqual(result.code, 0, mode);
    assert.equal(result.timedOut, mode !== 'abort', result.output);
    assert.equal(result.aborted, mode === 'abort', result.output);
    assert.equal(result.terminationUnconfirmed, false, result.output);
    assert.ok(performance.now() - started < 8000, 'termination must settle within the bounded cleanup window');
    assert.deepEqual(events.map(event => event.phase), ['start', 'end']);
    assert.equal(events[1].timedOut, result.timedOut);
    assert.equal(children.at(-1), null);
    assert.equal(processAlive(children[0]), false, 'watchdog exited');
    const descendantPid = Number(await readFile(path.join(dir, `${mode}-pid`), 'utf8'));
    assert.equal(processAlive(descendantPid), false, 'actual grandchild exited before returning');
    if (mode !== 'abort') {
      assert.ok(events[1].durationMs >= 1200, 'deadline must not fire early');
      assert.match(result.output, /最长执行时间 1200ms/);
    }
    if (mode === 'output') assert.match(result.output, /still-working/);
  }
});

test('pre-aborted commands and failed command progress persistence never start work', async (t) => {
  const dir = await scratch(t);
  const command = "require('node:fs').writeFileSync('must-not-run','unsafe')";
  const preAborted = await runCommand(process.execPath, ['-e', command], { cwd: dir, signal: AbortSignal.abort() });
  assert.equal(preAborted.aborted, true);
  assert.equal(preAborted.timedOut, false);
  const events = [];
  const failed = await runCommand(process.execPath, ['-e', command], {
    cwd: dir, onCommand(event) { events.push(event.phase); if (event.phase === 'start') throw new Error('injected progress persistence failure'); },
  });
  assert.notEqual(failed.code, 0);
  assert.match(failed.output, /progress persistence failure/);
  assert.deepEqual(events, ['start', 'end']);
  await assert.rejects(readFile(path.join(dir, 'must-not-run')));
});

test('command output persistence failures stop the owned process and settle without crashing the runner', async (t) => {
  const dir = await scratch(t);
  const children = [];
  const result = await runCommand(process.execPath, ['-e', "console.log('started'); setTimeout(()=>require('node:fs').writeFileSync('must-not-finish','unsafe'),1000)"], {
    cwd: dir, timeoutMs: 2000, onChild: pid => children.push(pid),
    onOutput() { throw new Error('injected output persistence failure'); },
  });
  assert.equal(result.code, null, result.output);
  assert.equal(result.timedOut, false);
  assert.equal(result.terminationUnconfirmed, false);
  assert.match(result.output, /output persistence failure/);
  assert.equal(children.at(-1), null);
  assert.equal(processAlive(children[0]), false);
  await assert.rejects(readFile(path.join(dir, 'must-not-finish')));
});

async function injectWatchdogStopFailure(childFile, mode, control) {
  const original = await readFile(childFile, 'utf8');
  await writeFile(childFile, `
    import stopTestCp from 'node:child_process'; import stopTestFs from 'node:fs'; import {syncBuiltinESMExports as syncStopTest} from 'node:module';
    const stopTestSpawn=stopTestCp.spawn;let stopTestAttempts=0;
    if(${JSON.stringify(mode)}==='permanent')process.on('message',message=>{if(message==='stop'&&process.connected)process.send('stopped');});
    if(${JSON.stringify(mode)}==='no-ack'){const send=process.send;process.send=(message,callback)=>message==='stopped'?(callback?.(),true):send.call(process,message,callback);}
    stopTestCp.spawn=(command,args,options)=>{
      if(command==='taskkill.exe'){
        stopTestFs.appendFileSync(${JSON.stringify(control + '.attempts')},JSON.stringify({target:Number(args[1]),owner:process.pid})+'\\n');
        if((${JSON.stringify(mode)}==='permanent'&&!stopTestFs.existsSync(${JSON.stringify(control)}))||stopTestAttempts++===0)
          return stopTestSpawn(process.execPath,['-e',${JSON.stringify(mode)}==='hung-helper'?'setInterval(()=>{},1000)':'setTimeout(()=>process.exit(7),'+(${JSON.stringify(mode)}==='late'?5500:50)+')'],options);
      }
      return stopTestSpawn(command,args,options);
    };syncStopTest();
  ` + original);
}

test('Windows watchdog stops its command tree, preserves unconfirmed ownership and accepts late confirmation', { skip: process.platform !== 'win32', timeout: 50000 }, async (t) => {
  for (const mode of ['transient', 'late', 'permanent', 'no-ack', 'late-write-failure', 'hung-helper', 'failed-root-exit']) {
    const dir = await scratch(t);
    for (const file of ['runner-core.mjs', 'runner-child.mjs', 'runner-artifacts.mjs']) await copyFile(new URL(file, import.meta.url), path.join(dir, file));
    const control = path.join(dir, 'allow-stop');
    await injectWatchdogStopFailure(path.join(dir, 'runner-child.mjs'), mode === 'late-write-failure' ? 'late' : mode, control);
    const { runCommand: isolatedRun } = await import(pathToFileURL(path.join(dir, 'runner-core.mjs')).href);
    const pids = [];
    let clearAttempts = 0;
    const command = mode === 'failed-root-exit'
      ? "const fs=require('node:fs');const descendant=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true,detached:true});fs.writeFileSync('descendant.pid',String(descendant.pid));descendant.unref();fs.writeFileSync('command.pid',String(process.pid));setTimeout(()=>process.exit(0),400)"
      : "require('node:fs').writeFileSync('command.pid',String(process.pid));setInterval(()=>{},1000)";
    const result = await isolatedRun(process.execPath, ['-e', command], {
      cwd: dir, timeoutMs: 300, onChild: pid => {
        if (pid === null) { clearAttempts++; if (mode === 'late-write-failure') throw new Error('injected late confirmation persistence failure'); }
        pids.push(pid);
      },
    });
    try {
      assert.equal(result.code, null);
      assert.equal(result.timedOut, true);
      assert.equal(result.terminationUnconfirmed, mode !== 'transient', result.output);
      if (mode !== 'transient') {
        assert.equal(pids.length, 1, 'unconfirmed stop must retain the watchdog owner');
        assert.equal(processAlive(pids[0]), mode !== 'no-ack');
      }
      const attempts = (await readFile(control + '.attempts', 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      const commandPid = Number(await readFile(path.join(dir, 'command.pid'), 'utf8'));
      assert.ok(attempts.every(attempt => attempt.target === commandPid && attempt.owner === pids[0]), 'kill the command tree, never its watchdog first');
      if (mode === 'permanent') { await delay(100); assert.equal(pids.length, 1); }
      if (mode === 'failed-root-exit') {
        assert.equal(processAlive(commandPid), false);
        assert.equal(processAlive(Number(await readFile(path.join(dir, 'descendant.pid'), 'utf8'))), true);
        assert.equal(clearAttempts, 0, 'root close after failed taskkill must not acknowledge unknown descendants');
      }
    } finally {
      await writeFile(control, 'allow');
      if (mode === 'failed-root-exit') await killProcessTree(Number(await readFile(path.join(dir, 'descendant.pid'), 'utf8')));
      const confirmationSettled = () => mode === 'no-ack' ? processAlive(pids[0]) === false
        : mode === 'failed-root-exit' ? true
        : mode === 'late-write-failure' ? clearAttempts > 0 : pids.at(-1) === null;
      for (let i = 0; i < 120 && !confirmationSettled(); i++) await delay(50);
      if (processAlive(pids[0]) === true) await killProcessTree(pids[0]);
    }
    if (['no-ack', 'late-write-failure', 'failed-root-exit'].includes(mode)) {
      assert.equal(pids.length, 1, 'missing acknowledgement or failed persistence must retain ownership');
      assert.equal(clearAttempts, mode === 'late-write-failure' ? 1 : 0);
    } else {
      assert.equal(pids.at(-1), null, 'late confirmed close clears the owner exactly once');
      assert.equal(clearAttempts, 1);
    }
    assert.equal(processAlive(pids[0]), false);
  }
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

test('fresh lease confirmation cancellation bounds both active and new heartbeat waits', async () => {
  for (const activeHeartbeat of [false, true]) {
    let calls = 0;
    const lease = startLease(async () => {
      if (++calls === 1) return;
      await new Promise(() => {});
    }, { intervalMs: activeHeartbeat ? 10 : 5000, graceMs: 5000, requestTimeoutMs: 1000 });
    await lease.ready;
    if (activeHeartbeat) while (calls < 2) await delay(5);
    const controller = new AbortController();
    const pending = lease.check(controller.signal);
    const reason = new Error('confirmation window ended');
    const timer = setTimeout(() => controller.abort(reason), 20);
    const started = performance.now();
    try {
      await assert.rejects(pending, error => error === reason);
      assert.ok(performance.now() - started < 500);
      assert.equal(lease.signal.aborted, false, 'confirmation cancellation does not widen or replace the lease authority');
    } finally { clearTimeout(timer); lease.stop(); }
  }
});

test('API recovers transport and server outages within one deadline and replays the same payload', async (t) => {
  const bodies = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    bodies.push(body);
    if (bodies.length === 1) { req.socket.destroy(); return; }
    res.writeHead(bodies.length === 2 ? 503 : 200, { 'content-type': 'application/json' });
    if (bodies.length === 3) { res.write('{"ok":'); setTimeout(() => req.socket.destroy(), 20); return; }
    res.end('{"ok":true}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const api = createApi({ api: `http://127.0.0.1:${server.address().port}`, token, requestTimeoutMs: 3000 });
  assert.deepEqual(await api('/api/publish/step', { versionId: 41, step: 'gates', status: 'running' }), { ok: true });
  assert.equal(bodies.length, 4);
  assert.equal(new Set(bodies).size, 1);
});

test('API retries stay bounded, preserve the outage reason and stop on cancellation or rejection', async () => {
  let calls = 0;
  const failure = async () => { calls++; return new Response('{}', { status: 503 }); };
  const api = createApi({ api: 'http://127.0.0.1', token, requestTimeoutMs: 350 }, failure);
  const started = performance.now();
  await assert.rejects(api('/api/publish/step', {}), /HTTP 503/);
  assert.ok(calls >= 2);
  assert.ok(performance.now() - started < 1000, 'retry must not reset the request deadline');
  calls = 0;
  const stop = new AbortController();
  const pending = api('/api/publish/step', {}, stop.signal);
  stop.abort(new Error('operator stopped'));
  await assert.rejects(pending, /operator stopped/);
  assert.equal(calls, 1);
  for (const status of [400, 401, 403, 404, 409]) {
    calls = 0;
    const rejected = createApi({ api: 'http://127.0.0.1', token }, async () => { calls++; return new Response('{}', { status }); });
    await assert.rejects(rejected('/api/publish/step', {}), new RegExp(`HTTP ${status}`));
    assert.equal(calls, 1);
  }
  calls = 0;
  const invalid = createApi({ api: 'http://127.0.0.1', token }, async () => { calls++; return new Response('{invalid'); });
  await assert.rejects(invalid('/api/publish/step', {}), /无效 JSON/);
  assert.equal(calls, 1);
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
  assert.match(workspace.sourceSnapshot.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(workspace.sourceSnapshot.manifest.map(file => file.path), ['.gitignore', 'tracked.txt', 'untracked.txt']);
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
  const advisoryLimits = 'admin/src/lib/text-layout-limits.json';
  // Build a git origin from current source so this test also runs inside a publication snapshot without .git.
  for (const rel of ['worker/src', 'worker/test', 'worker/seed', 'schema/src']) {
    await cp(path.join(sourceRoot, rel), path.join(origin, rel), { recursive: true });
  }
  for (const rel of ['worker/package.json', 'worker/tsconfig.json', 'worker/wrangler.jsonc', 'worker/.gitignore', 'schema/package.json', 'scripts/forbidden-patterns.mjs', advisoryLimits]) {
    await mkdir(path.dirname(path.join(origin, rel)), { recursive: true });
    await copyFile(path.join(sourceRoot, rel), path.join(origin, rel));
  }
  // No trailing slash: the fixture uses dependency symlinks on Linux, not directories.
  await writeFile(path.join(origin, '.gitignore'), 'node_modules\n');
  for (const rel of ['node_modules', 'worker/node_modules']) {
    await symlink(path.join(sourceRoot, rel), path.join(origin, rel), process.platform === 'win32' ? 'junction' : 'dir');
  }
  const staleTypes = '// stale original declaration must never be consumed or overwritten\n';
  await writeFile(path.join(origin, 'worker/worker-configuration.d.ts'), staleTypes);
  const git = await runCommand('git', ['init', '--quiet'], { cwd: origin });
  assert.equal(git.code, 0, git.output);
  const workspace = await createWorkspace(origin, path.join(root, 'jobs'));
  try {
    assert.deepEqual(await readFile(path.join(workspace.site, advisoryLimits)), await readFile(path.join(sourceRoot, advisoryLimits)), 'real cross-package test data must survive the isolated snapshot');
    const generatedFile = path.join(workspace.site, 'worker/worker-configuration.d.ts');
    await assert.rejects(readFile(generatedFile), { code: 'ENOENT' });
    const before = await runNpm(['run', 'typecheck'], { cwd: path.join(workspace.site, 'worker') });
    assert.notEqual(before.code, 0, 'the missing generated declaration must reproduce the real failure');
    assert.doesNotMatch(before.output, /TS2307/, 'fixture source dependencies must resolve before binding generation');
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
  for (const rel of ['package.json', 'astro.config.mjs', 'tsconfig.json', 'worker/package.json', 'worker/tsconfig.json', 'worker/vitest.config.ts', 'worker/wrangler.jsonc', 'worker/gate-config-consistency.mjs', 'worker/gate-console-copy.mjs', 'worker/gate-beacon-size.mjs', 'worker/test-ai-runtime.mjs', 'worker/lib/read-jsonc.mjs', 'worker/lib/test-read-jsonc.mjs', 'worker/lib/test-exit-skips-finally.mjs', 'admin/package.json', 'admin/tsconfig.json']) {
    await mkdir(path.dirname(path.join(origin, rel)), { recursive: true });
    await copyFile(path.join(sourceRoot, rel), path.join(origin, rel));
  }
  const pkg = JSON.parse(await readFile(path.join(origin, 'package.json'), 'utf8'));
  pkg.scripts.typecheck = 'node -e "process.exit(0)"';
  pkg.scripts.verify = 'node verify-order.cjs';
  await writeFile(path.join(origin, 'package.json'), JSON.stringify(pkg));
  const workerPkg = JSON.parse(await readFile(path.join(origin, 'worker/package.json'), 'utf8'));
  workerPkg.scripts['test:publisher'] = 'node -e "process.exit(0)"';
  await writeFile(path.join(origin, 'worker/package.json'), JSON.stringify(workerPkg));
  // No trailing slash: the fixture uses dependency symlinks on Linux, not directories.
  await writeFile(path.join(origin, '.gitignore'), 'node_modules\ndist/\ndist-live/\n.astro/\nworker/worker-configuration.d.ts\n');
  for (const rel of ['node_modules', 'worker/node_modules', 'admin/node_modules']) await symlink(path.join(sourceRoot, rel), path.join(origin, rel), process.platform === 'win32' ? 'junction' : 'dir');
  const marker = 'Cold publication artifact proof';
  await writeFile(path.join(origin, 'verify-order.cjs'), `const fs=require('node:fs'); const assert=require('node:assert/strict'); assert.ok(fs.readFileSync('dist/index.html','utf8').includes(${JSON.stringify(marker)})); for(const locale of JSON.parse(fs.readFileSync('src/config/site.json','utf8')).enabledLocales.filter(l=>l!=='en')) assert.ok(fs.readFileSync('dist/'+locale+'/index.html','utf8').length>0); fs.writeFileSync('.verify-exit.code','2'); console.log('CURRENT_BUILD_PRECEDES_VERIFY'); process.exit(7);`);
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
    for (const locale of LOCALES) await writeFile(path.join(workspace.site, `src/i18n/${locale}.json`), materializeI18n(config, manifest, locale));
    await writeFile(path.join(workspace.site, 'src/config/site.json'), materializeSiteJson(config));
    const commands = [];
    const result = await runGates(workspace.site, 'local', { onCommand: (entry) => {
      if (entry.phase === 'end') commands.push({ args: entry.args, code: entry.code, aborted: entry.aborted, timedOut: entry.timedOut });
    } });
    assert.equal(result.gate, 'verify-process', result.tail + '\n' + JSON.stringify(commands));
    assert.match(result.tail, /CURRENT_BUILD_PRECEDES_VERIFY/);
    assert.equal(result.ok, false, 'the intentionally failed verification must still block publication');
    assert.equal(await readFile(path.join(workspace.site, 'dist-live/index.html'), 'utf8'), await readFile(path.join(workspace.site, 'dist/index.html'), 'utf8'));
    await rm(path.join(workspace.site, 'dist-live'), { recursive: true });
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
  await mkdir(path.join(root, 'src/config'), { recursive: true });
  await writeFile(path.join(root, 'src/config/site.json'), JSON.stringify({ enabledLocales: ['en', 'vi', 'zh'] }));
  for (const rel of ['worker', 'admin']) await mkdir(path.join(root, rel));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'node -e "process.exit(0)"', build: 'node build.cjs', verify: 'node verify.cjs' } }));
  await writeFile(path.join(root, 'build.cjs'), "const fs=require('node:fs'); for(const p of ['dist','dist/vi','dist/zh']){fs.mkdirSync(p,{recursive:true});fs.writeFileSync(p+'/index.html','current-verified-content');}");
  await writeFile(path.join(root, 'verify.cjs'), "const fs=require('node:fs');fs.writeFileSync('heavy-verify-ran','yes');fs.writeFileSync('.verify-exit.code','0')");
  await writeFile(path.join(root, 'worker/package.json'), JSON.stringify({ scripts: { types: 'node types.cjs', typecheck: 'node -e "process.exit(0)"', 'test:publisher': 'node worker-order.cjs' } }));
  await writeFile(path.join(root, 'worker/types.cjs'), "require('node:fs').writeFileSync('worker-configuration.d.ts','// fixture')");
  await writeFile(path.join(root, 'worker/worker-order.cjs'), "const fs=require('node:fs');require('node:assert/strict').equal(fs.readFileSync('../dist-live/index.html','utf8'),'current-verified-content'); console.log('PRIVATE_ASSETS_BEFORE_WORKER_GATES'); process.exit(7)");
  for (const rel of ['lib/test-read-jsonc.mjs', 'lib/test-exit-skips-finally.mjs', 'gate-config-consistency.mjs', 'gate-console-copy.mjs', 'gate-beacon-size.mjs', 'test-ai-runtime.mjs', 'node_modules/vitest/vitest.mjs']) {
    await mkdir(path.dirname(path.join(root, 'worker', rel)), { recursive: true });
    await writeFile(path.join(root, 'worker', rel), "console.log('1 pass');");
  }
  await writeFile(path.join(root, 'admin/package.json'), JSON.stringify({ scripts: { typecheck: 'node -e "process.exit(0)"' } }));
  const result = await runGates(root, 'local');
  assert.equal(result.ok, false, 'a subsequent worker gate failure must still stop publication');
  assert.equal(result.gate, 'publisher-故障回归');
  assert.match(result.tail, /PRIVATE_ASSETS_BEFORE_WORKER_GATES/);
  await assert.rejects(readFile(path.join(root, 'heavy-verify-ran')), { code: 'ENOENT' });
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
  const files = MATERIALIZED_FILES;
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

test('busy live directory keeps the stamp path while replacing its contents', async (t) => {
  const root = await scratch(t);
  const site = path.join(root, 'isolated');
  const live = path.join(root, 'target', 'dist-live');
  await mkdir(path.join(site, 'dist/admin'), { recursive: true });
  await mkdir(live, { recursive: true });
  await writeFile(path.join(site, 'dist/index.html'), 'new-version');
  await writeFile(path.join(site, 'dist/admin/index.html'), 'console');
  await writeFile(path.join(live, 'index.html'), 'old-version');
  await writeFile(path.join(live, '.publish-stamp.json'), '{"versionId":30}\n');
  for (const rel of MATERIALIZED_FILES) {
    await mkdir(path.dirname(path.join(site, rel)), { recursive: true });
    await writeFile(path.join(site, rel), '{}\n');
  }
  await writeFile(path.join(root, 'preload.mjs'), `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const rename = fs.renameSync, rm = fs.rmSync;
    fs.renameSync = (from, to) => { if (String(from) === ${JSON.stringify(live)}) throw Object.assign(new Error('busy'), {code:'EBUSY'}); return rename(from, to); };
    fs.rmSync = (file, ...args) => { if (String(file).endsWith('.publish-stamp.json')) throw new Error('stamp path removed'); return rm(file, ...args); };
    syncBuiltinESMExports();`);
  const result = await runCommand(process.execPath, ['--import', './preload.mjs', fileURLToPath(new URL('../promote.mjs', import.meta.url)), '--source', path.join(site, 'dist'), '--live', live, '--materialized-root', site, '--version', '31'], { cwd: root, env: { ...process.env, PUBLISH_STAMP: 'fixture-stamp' } });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /EBUSY/);
  assert.equal(await readFile(path.join(live, 'index.html'), 'utf8'), 'new-version');
  assert.equal(JSON.parse(await readFile(path.join(live, '.publish-stamp.json'), 'utf8')).versionId, 31);
});

test('published language gate rejects a missing enabled homepage and any disabled language asset directory', async (t) => {
  const root = await scratch(t);
  await mkdir(path.join(root, 'src/config'), { recursive: true });
  await mkdir(path.join(root, 'dist'), { recursive: true });
  await writeFile(path.join(root, 'src/config/site.json'), JSON.stringify({ enabledLocales: ['en', 'ja'] }));
  await writeFile(path.join(root, 'dist/index.html'), 'English');
  await assert.rejects(gates.assertPublishedHomepages(root), /ENOENT/);
  await mkdir(path.join(root, 'dist/ja')); await writeFile(path.join(root, 'dist/ja/index.html'), 'Japanese');
  await gates.assertPublishedHomepages(root);
  await mkdir(path.join(root, 'dist/zh')); await writeFile(path.join(root, 'dist/zh/old.html'), 'stale');
  await assert.rejects(gates.assertPublishedHomepages(root), /Disabled language/);
  await writeFile(path.join(root, 'src/config/site.json'), JSON.stringify({ enabledLocales: ['ja'] }));
  await assert.rejects(gates.assertPublishedHomepages(root), /Invalid published language/);
});

test('local and production gate chains check backend first, stop on its first failure, and bind one build to verify', async (t) => {
  for (const mode of ['local', 'production', 'tamper', 'console-self-test-failure', 'ai-runtime-failure']) {
    const root = await scratch(t);
    for (const rel of ['src/config', 'worker/lib', 'worker/node_modules/vitest', 'admin']) await mkdir(path.join(root, rel), { recursive: true });
    await writeFile(path.join(root, 'src/config/site.json'), JSON.stringify({ enabledLocales: ['en'] }));
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'node -e "process.exit(0)"', build: 'node build.cjs', verify: 'node verify.mjs local', 'verify:prod': 'node verify.mjs production' } }));
    await writeFile(path.join(root, 'build.cjs'), "const fs=require('node:fs');fs.appendFileSync('build-count','1');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/index.html','official');");
    await writeFile(path.join(root, 'verify.mjs'), `import assert from 'node:assert/strict';import{writeFileSync,readFileSync}from'node:fs';import{assertDigest}from ${JSON.stringify(new URL('./runner-artifacts.mjs', import.meta.url).href)};assert.equal(process.argv[3],'--built-dist-sha');assert.equal(process.argv.includes('--routes'),false,'published artifacts always need full-site browser gates');assertDigest('dist',process.argv[4]);assert.equal(readFileSync('build-count','utf8'),'1');writeFileSync('verified-mode',process.argv[2]);writeFileSync('.verify-exit.code','0');${mode === 'tamper' ? "writeFileSync('dist/index.html','modified');" : ''}`);
    await writeFile(path.join(root, 'worker/package.json'), JSON.stringify({ scripts: { types: 'node types.cjs', typecheck: 'node -e "process.exit(0)"', 'test:publisher': 'node publisher-order.cjs' } }));
    await writeFile(path.join(root, 'worker/types.cjs'), "require('node:fs').writeFileSync('worker-configuration.d.ts','generated')");
    await writeFile(path.join(root, 'worker/publisher-order.cjs'), "const fs=require('node:fs');require('node:assert/strict').equal(fs.readFileSync('early-checks','utf8').trim().split('\\n').length,9);fs.writeFileSync('../publisher-ran','yes');");
    // No Admin typecheck or duplicate CSS/render self-test fixture exists: reintroducing either fails this chain.
    for (const rel of ['lib/test-read-jsonc.mjs', 'lib/test-exit-skips-finally.mjs', 'gate-config-consistency.mjs', 'gate-console-copy.mjs', 'gate-beacon-size.mjs', 'node_modules/vitest/vitest.mjs']) {
      await writeFile(path.join(root, 'worker', rel), `import{appendFileSync}from'node:fs';appendFileSync('early-checks',${JSON.stringify(rel)}+' '+process.argv.slice(2).join(' ')+'\\n');${mode === 'console-self-test-failure' && rel === 'gate-console-copy.mjs' ? "if(process.argv.includes('--self-test')){console.error('injected console self-test failure');process.exit(7);}" : ''}console.log('1 pass');`);
    }
    await writeFile(path.join(root, 'worker/test-ai-runtime.mjs'), `import assert from 'node:assert/strict';import{appendFileSync}from'node:fs';assert.ok(process.execArgv.includes('--no-maglev'));appendFileSync('early-checks','test-ai-runtime.mjs\\n');${mode === 'ai-runtime-failure' ? "console.error('injected AI runtime failure');process.exit(7);" : ''}`);
    if (mode === 'tamper') await assert.rejects(runGates(root, 'local'), /产物内容已变化/);
    else if (mode === 'console-self-test-failure') {
      const result = await runGates(root, 'local');
      assert.equal(result.gate, 'console-copy-自检');
      assert.equal(result.ok, false);
      assert.match(result.tail, /injected console self-test failure/);
      assert.equal((await readFile(path.join(root, 'worker/early-checks'), 'utf8')).trim().split('\n').length, 4);
      for (const rel of ['publisher-ran', 'verified-mode']) await assert.rejects(readFile(path.join(root, rel)), { code: 'ENOENT' });
    }
    else if (mode === 'ai-runtime-failure') {
      const result = await runGates(root, 'local');
      assert.equal(result.gate, 'worker-AI-runtime');
      assert.equal(result.ok, false);
      assert.match(result.tail, /injected AI runtime failure/);
      assert.equal((await readFile(path.join(root, 'worker/early-checks'), 'utf8')).trim().split('\n').length, 8);
      for (const rel of ['publisher-ran', 'verified-mode']) await assert.rejects(readFile(path.join(root, rel)), { code: 'ENOENT' });
    }
    else {
      const verifyCommands = [];
      const result = await runGates(root, mode, { onCommand: event => {
        if (event.phase === 'start' && event.args.includes(mode === 'local' ? 'verify' : 'verify:prod')) verifyCommands.push(event);
      } });
      assert.equal(result.ok, true, result.tail);
      assert.equal(verifyCommands.length, 1);
      assert.equal(verifyCommands[0].timeoutMs, mode === 'local' ? 60 * 60_000 : 30 * 60_000);
      assert.deepEqual(result.artifact, directoryDigest(path.join(root, 'dist')));
      assert.equal(await readFile(path.join(root, 'verified-mode'), 'utf8'), mode);
      if (mode === 'local') {
        await rm(path.join(root, 'build-count'));
        const progress = [];
        const incremental = await runGates(root, 'local', { onProgress: async detail => { progress.push(detail); } }, {
          changeTier: 'content-only', sourceUnchanged: true, liveDist: path.join(root, 'dist'),
        });
        assert.equal(incremental.ok, true, incremental.tail);
        assert.match(incremental.tail, /版面门全量实测/);
        assert.ok(incremental.skipped.includes('worker-AI-runtime'));
        assert.ok(progress.some(detail => detail.startsWith('跳过检查:worker-AI-runtime')));
        const earlyChecks = (await readFile(path.join(root, 'worker/early-checks'), 'utf8')).trim().split('\n');
        assert.equal(earlyChecks.length, 12);
        assert.equal(earlyChecks.filter(check => check === 'test-ai-runtime.mjs').length, 1);
      }
    }
    assert.equal(await readFile(path.join(root, 'build-count'), 'utf8'), '1');
  }
});

test('actual verify entry builds before inspecting dist, reuses an explicit digest, and marks modified artifacts red', async (t) => {
  const { judge } = await import('../../.githooks/verify-before-push.mjs');
  const root = await scratch(t);
  const source = fileURLToPath(new URL('../..', import.meta.url));
  for (const rel of ['src', 'scripts', 'schema/src']) await cp(path.join(source, rel), path.join(root, rel), { recursive: true });
  await mkdir(path.join(root, 'worker/lib'), { recursive: true });
  await copyFile(path.join(source, 'worker/lib/runner-artifacts.mjs'), path.join(root, 'worker/lib/runner-artifacts.mjs'));
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  // Child gate bodies are fixtures here; this test executes verify's real ordering and artifact contract.
  await writeFile(path.join(root, 'preload.mjs'), `
    import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module'; import * as fs from 'node:fs';
    import assert from 'node:assert/strict'; import path from 'node:path'; import {PassThrough} from 'node:stream';
    cp.spawnSync=(cmd,args)=>{
      if(cmd==='git')return {status:0,stdout:'',stderr:''};
      assert.equal(cmd,'npm');assert.deepEqual(args,['run','build']);
      fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/index.html','<a href="mailto:hello@example.test">contact</a>');
      fs.appendFileSync('build-count','1');return {status:0,stdout:'',stderr:''};
    };
    cp.execFile=(cmd,args,options,callback)=>{
      assert.ok(fs.existsSync('dist/index.html'),'all child gates see a built artifact');
      if(path.basename(args[0])==='gate-canvas-geometry.mjs')assert.ok(args.includes('--no-build'));
      if(!args.includes('--self-test')&&['gate-canvas-geometry.mjs','gate-render-fit.mjs','gate-deck-clearance.mjs'].includes(path.basename(args[0]))) {
        const at=args.indexOf('--routes');fs.appendFileSync('geometry-scopes',JSON.stringify(at<0?null:args[at+1])+'\\n');
      }
      if(process.env.TEST_TAMPER==='1'&&path.basename(args[0])==='gate-deck-clearance.mjs')fs.writeFileSync('dist/index.html','changed');
      const stdout=new PassThrough(),stderr=new PassThrough();
      queueMicrotask(()=>{stdout.end('1 pass');stderr.end();callback(null,'1 pass','');});
      return {stdout,stderr};
    };syncBuiltinESMExports();
  `);
  const command = ['--import', './preload.mjs', 'scripts/verify.mjs'];
  const first = await runCommand(process.execPath, command, { cwd: root });
  assert.equal(first.code, 0, first.output);
  assert.equal(await readFile(path.join(root, 'build-count'), 'utf8'), '1');
  const artifact = directoryDigest(path.join(root, 'dist'));
  const reused = await runCommand(process.execPath, [...command, '--built-dist-sha', artifact.sha256], { cwd: root });
  assert.equal(reused.code, 0, reused.output);
  assert.equal(await readFile(path.join(root, 'build-count'), 'utf8'), '1');
  const cachePath = path.join(root, '.verify-cache/last-run.json');
  assert.equal(JSON.parse(await readFile(cachePath, 'utf8')).mode, 'full');
  for (const routes of ['/,/vi/', '']) {
    await rm(path.join(root, 'geometry-scopes'));
    const scoped = await runCommand(process.execPath, [...command, '--built-dist-sha', artifact.sha256, '--routes', routes], { cwd: root });
    assert.equal(scoped.code, 0, scoped.output);
    const evidence = JSON.parse(await readFile(cachePath, 'utf8'));
    assert.equal(evidence.mode, 'scoped', 'a requested route scope must never certify full verification');
    assert.equal(judge(root, evidence.headTree).ok, false);
    assert.match(judge(root, evidence.headTree).why, /scoped/);
    assert.deepEqual(evidence.routes, routes ? ['/', '/vi/'] : null);
    assert.deepEqual((await readFile(path.join(root, 'geometry-scopes'), 'utf8')).trim().split('\n').map(JSON.parse), Array(3).fill(routes || null));
    if (!routes) assert.match(scoped.output, /空路由范围.*全量.*scoped/);
  }
  for (const args of [['--routes'], ['--routes', '--fail-fast']]) {
    await rm(cachePath);
    const invalid = await runCommand(process.execPath, [...command, ...args], { cwd: root });
    assert.equal(invalid.code, 2, invalid.output);
    assert.match(invalid.output, /--routes.*缺少/);
    assert.equal(await readFile(path.join(root, '.verify-exit.code'), 'utf8'), '2');
    await assert.rejects(readFile(cachePath), { code: 'ENOENT' });
    await writeFile(cachePath, '{}');
  }
  const bad = await runCommand(process.execPath, [...command, '--built-dist-sha', artifact.sha256], { cwd: root, env: { ...childEnvironment(), TEST_TAMPER: '1' } });
  assert.equal(bad.code, 2, bad.output);
  assert.match(bad.output, /✗ artifact-unchanged/);
  assert.equal(await readFile(path.join(root, '.verify-exit.code'), 'utf8'), '2');
  const stale = await runCommand(process.execPath, [...command, '--built-dist-sha', artifact.sha256], { cwd: root });
  assert.equal(stale.code, 2, stale.output);
  assert.match(stale.output, /✗ site-build/);
});

test('copy fails closed on same-size source edits, added files, deleted files, or a changed copied byte', async (t) => {
  for (const mode of ['same-size-edit', 'add', 'delete', 'copy-tamper']) {
    const root = await scratch(t);
    const site = path.join(root, 'source');
    await mkdir(site);
    assert.equal((await runCommand('git', ['init', '--quiet'], { cwd: site })).code, 0);
    await writeFile(path.join(site, 'page.html'), 'before');
    const copy = fsPromises.copyFile;
    let changed = false;
    const injected = t.mock.method(fsPromises, 'copyFile', async (src, dest, ...args) => {
      await copy(src, dest, ...args);
      if (changed) return;
      changed = true;
      if (mode === 'same-size-edit') await writeFile(src, 'after!');
      if (mode === 'add') await writeFile(path.join(site, 'added.html'), 'new');
      if (mode === 'delete') await rm(src);
      if (mode === 'copy-tamper') await writeFile(dest, 'after!');
    });
    try { await assert.rejects(createWorkspace(site, path.join(root, 'jobs')), /源码内容或文件清单发生变化/); }
    finally { injected.mock.restore(); }
    assert.deepEqual(await readdir(path.join(root, 'jobs')), [], 'failed copies are not usable workspaces');
  }
});

test('artifact digest covers same-size asset edits and rejects links, while public digest ignores only admin', async (t) => {
  const root = await scratch(t);
  await mkdir(path.join(root, 'dist'));
  const dist = path.join(root, 'dist');
  await writeFile(path.join(dist, 'index.html'), 'page');
  await writeFile(path.join(dist, 'main.css'), 'aaaa');
  const before = directoryDigest(dist);
  assert.match(before.sha256, /^[a-f0-9]{64}$/);
  await writeFile(path.join(dist, 'main.css'), 'bbbb');
  assert.throws(() => assertDigest(dist, before.sha256), /产物内容已变化/);
  const publicDigest = directoryDigest(dist);
  await mkdir(path.join(dist, 'admin'));
  await writeFile(path.join(dist, 'admin/index.html'), 'console');
  assertDigest(dist, publicDigest.sha256, { exclude: ['admin', '.publish-stamp.json'] });
  assert.notEqual(directoryDigest(dist).sha256, publicDigest.sha256);
  await symlink(root, path.join(dist, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => directoryDigest(dist), /链接或特殊文件/);
});

test('evidence redacts explicit and labelled secrets without writing configuration bodies', () => {
  const safe = JSON.stringify({ output: redactEvidence('Bearer hidden-auth password=hidden-pass token="hidden-token" job known-job-secret', ['known-job-secret']) });
  for (const secret of ['hidden-auth', 'hidden-pass', 'hidden-token', 'known-job-secret']) assert.ok(!safe.includes(secret));
  assert.ok(JSON.parse(safe).output.includes('[REDACTED_SECRET]'));
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
  for (const rel of ['runner.mjs', 'register-ts-ext.mjs', 'ts-ext-resolver.mjs', 'lib/runner-core.mjs', 'lib/runner-gates.mjs', 'lib/runner-artifacts.mjs', 'lib/runner-child.mjs', 'lib/read-jsonc.mjs']) {
    const dest = path.join(root, 'worker', rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(path.join(source, rel), dest);
  }
  await mkdir(path.join(root, 'schema/src'), { recursive: true });
  await copyFile(fileURLToPath(new URL('../../schema/src/locales.ts', import.meta.url)), path.join(root, 'schema/src/locales.ts'));
  await copyFile(fileURLToPath(new URL('../../schema/src/publish-feedback.ts', import.meta.url)), path.join(root, 'schema/src/publish-feedback.ts'));
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

async function apiFixture(t, onNext, failureResult = { ok: true, status: 'failed' }, onRequest) {
  const calls = [];
  let activeVersion = null;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ url: req.url, body, authorization: req.headers.authorization });
    await onRequest?.({ url: req.url, body, response: res });
    if (res.writableEnded || res.destroyed) return;
    let response = { ok: true };
    if (req.url.startsWith('/api/publish/runner-state')) response = { environment: 'dev', activeVersion };
    if (req.url === '/api/publish/status') response = { drift: { snapshot: activeVersion } };
    if (req.url === '/api/publish/next') { activeVersion = 41; response = onNext ? await onNext() : { job: { versionId: 41, stamp: 'job-secret', config: { fixture: true } } }; }
    if (req.url === '/api/publish/runner-fail') { activeVersion = null; response = typeof failureResult === 'function' ? await failureResult() : failureResult; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(response));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { calls, url: `http://127.0.0.1:${server.address().port}` };
}

test('publish verify stops at the first blocking gate while manual verify still collects all gates', async (t) => {
  const workspace = { site: await scratch(t) };
  const source = fileURLToPath(new URL('../..', import.meta.url));
  // Verify orchestration needs source files, not Git; publication snapshots have no .git.
  for (const rel of ['src', 'scripts', 'schema/src']) await cp(path.join(source, rel), path.join(workspace.site, rel), { recursive: true });
  for (const rel of ['worker/lib/runner-artifacts.mjs', 'worker/register-ts-ext.mjs', 'worker/ts-ext-resolver.mjs']) {
    await mkdir(path.dirname(path.join(workspace.site, rel)), { recursive: true });
    await copyFile(path.join(source, rel), path.join(workspace.site, rel));
  }
  await writeFile(path.join(workspace.site, 'package.json'), '{"type":"module"}');
  await assert.rejects(fsPromises.lstat(path.join(workspace.site, '.git')), { code: 'ENOENT' });
  await mkdir(path.join(workspace.site, 'dist'), { recursive: true });
  await writeFile(path.join(workspace.site, 'dist/index.html'), '<main>isolated orchestration fixture</main>');
  for (const locale of LOCALES) for (const page of ['legal/privacy', 'legal/terms', 'legal/app-privacy']) {
    const folder = path.join(workspace.site, 'dist', locale === 'en' ? '' : locale, page);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'index.html'), '<main>fixture</main>');
  }
  // Only command orchestration is under test. No mocked result is publication evidence.
  await writeFile(path.join(workspace.site, 'preload-verify-test.mjs'), `
    import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module'; import {writeFileSync} from 'node:fs'; import {PassThrough} from 'node:stream';
    cp.execFile=(command,args,options,callback)=>{
      const stdout=new PassThrough(),stderr=new PassThrough();
      queueMicrotask(()=>{
        const failed=args.some(arg=>arg.endsWith('gate-site-behavior.mjs'));
        if(args.some(arg=>arg.endsWith('calibrate-copy-layout.mjs')))writeFileSync('early-gate-ran','yes');
        if(args.some(arg=>arg.endsWith('gate-css-shadowed.mjs')))writeFileSync('later-gate-ran','yes');
        const text=failed?'INJECTED_BEHAVIOR_FAILURE':'1 pass';
        stdout.end(text);stderr.end();callback(failed?{code:2}:null,text,'');
      });
      return {stdout,stderr};
    }; syncBuiltinESMExports();
  `);
  const artifact = directoryDigest(path.join(workspace.site, 'dist'));
  const args = ['--import', './preload-verify-test.mjs', '--import', './worker/register-ts-ext.mjs', 'scripts/verify.mjs', '--built-dist-sha', artifact.sha256];
  const fast = await runCommand(process.execPath, [...args, '--fail-fast'], { cwd: workspace.site });
  assert.equal(fast.code, 2, fast.output);
  assert.match(fast.output, /INJECTED_BEHAVIOR_FAILURE/);
  assert.match(fast.output, /后续检查未执行/);
  assert.equal((await readFile(path.join(workspace.site, '.verify-exit.code'), 'utf8')).trim(), '2');
  assert.equal(await readFile(path.join(workspace.site, 'early-gate-ran'), 'utf8'), 'yes');
  await assert.rejects(readFile(path.join(workspace.site, 'later-gate-ran')));
  const full = await runCommand(process.execPath, args, { cwd: workspace.site });
  assert.equal(full.code, 2, full.output);
  assert.equal(await readFile(path.join(workspace.site, 'later-gate-ran'), 'utf8'), 'yes');
  assert.match(full.output, /开始检查：画布几何/);
  assert.match(full.output, /结束检查：画布几何/);
});

test('runner fingerprint detects gate and schema changes, additions and deletions but ignores built assets', async (t) => {
  const { root } = await runnerFixture(t);
  const before = await runnerSourceFingerprint(root);
  await writeFile(path.join(root, 'dist-live/index.html'), 'new assets');
  assert.equal(await runnerSourceFingerprint(root), before);
  for (const rel of ['worker/lib/new-gate.mjs', 'schema/src/new-policy.ts', 'worker/package-lock.json']) {
    await writeFile(path.join(root, rel), 'version-one');
    const added = await runnerSourceFingerprint(root);
    assert.notEqual(added, before);
    await writeFile(path.join(root, rel), 'version-two');
    assert.notEqual(await runnerSourceFingerprint(root), added);
    await rm(path.join(root, rel));
    assert.equal(await runnerSourceFingerprint(root), before);
  }
});

test('full gate cache rejects legacy fingerprints and invalidates on every copied source family', async (t) => {
  const fixture = await runnerFixture(t);
  const paths = ['worker/src/publish.ts', 'scripts/verify.mjs', 'src/styles/tokens.css', 'admin/src/pages/publish.tsx', 'public/font.woff2'];
  for (const rel of paths) {
    await mkdir(path.dirname(path.join(fixture.root, rel)), { recursive: true });
    await writeFile(path.join(fixture.root, rel), 'before');
  }
  await writeFile(path.join(fixture.root, 'worker/lib/runner-gates.mjs'), `
    import {mkdir,writeFile} from 'node:fs/promises'; import path from 'node:path';
    import {directoryDigest} from './runner-artifacts.mjs';
    export const runSourceBaseline=async()=>({ok:true});
    export const validateMaterialized=async()=>({ok:true});
    export async function runGates(site,_mode,_commands,options){
      console.log('SOURCE_UNCHANGED:'+options.sourceUnchanged);
      await mkdir(path.join(site,'dist')); await writeFile(path.join(site,'dist/index.html'),'fixture');
      return {ok:true,artifact:directoryDigest(path.join(site,'dist')),skipped:options.sourceUnchanged?['fixture-source-check']:[]};
    }
    export const runNpm=async()=>({code:1,output:'stop after checking cache; do not publish'});
  `);
  const api = await apiFixture(t, async () => ({ job: { versionId: 41, stamp: 'job-secret', config: {}, changeTier: 'content-only' } }));
  const fingerprint = await runnerSourceFingerprint(fixture.root);
  const cachePath = path.join(fixture.state, 'last-full-gates.json');
  await mkdir(fixture.state, { recursive: true });
  await writeFile(cachePath, JSON.stringify({ sourceFingerprint: fingerprint }));
  const run = async (unchanged) => {
    const result = await runCommand(process.execPath, ['--import', './worker/register-ts-ext.mjs', 'worker/runner.mjs', '--once'], {
      cwd: fixture.root, env: { ...childEnvironment(), PUBLISH_MODE: 'local', PUBLISH_RUNNER_TOKEN: token, PUBLISH_API_URL: api.url },
    });
    assert.equal(result.code, 1, result.output);
    assert.ok(result.output.includes(`SOURCE_UNCHANGED:${unchanged}`), result.output);
  };
  await run(false);
  const evidenceName = (await readdir(path.join(fixture.state, 'evidence')))[0];
  const evidence = JSON.parse(await readFile(path.join(fixture.state, 'evidence', evidenceName), 'utf8'));
  assert.equal(JSON.parse(await readFile(cachePath, 'utf8')).sourceSha, evidence.source.sha256);
  await run(true);
  for (const rel of paths) {
    await writeFile(path.join(fixture.root, rel), 'edited');
    assert.equal(await runnerSourceFingerprint(fixture.root), fingerprint, `${rel} is outside the runner reload fingerprint`);
    await run(false);
    await run(true);
  }
});

test('Windows mutex does not depend on an available legacy TCP port and still refuses a second owner', async (t) => {
  const state = await scratch(t);
  const port = 30000 + createHash('sha256').update(path.resolve(state).toLowerCase()).digest().readUInt16BE(0) % 30000;
  const { createServer: createSocketServer } = await import('node:net');
  const occupied = createSocketServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    occupied.once('error', error => ['EADDRINUSE', 'EACCES'].includes(error.code) ? resolve() : reject(error));
    occupied.listen(port, '127.0.0.1', resolve);
  });
  t.after(() => occupied.listening ? new Promise(resolve => occupied.close(resolve)) : undefined);
  if (process.platform !== 'win32') {
    await assert.rejects(acquireLock(state), /拒绝双开/);
    return;
  }
  const lock = await acquireLock(state);
  try { await assert.rejects(acquireLock(state), /拒绝双开/); }
  finally { await lock.release(); }
  const reacquired = await acquireLock(state);
  await reacquired.release();
});

test('idle runner exits for supervisor reload before claiming again after its gate code changes', async (t) => {
  const fixture = await runnerFixture(t);
  const api = await apiFixture(t, async () => {
    await writeFile(path.join(fixture.root, 'worker/lib/new-gate.mjs'), '// updated gate');
    return { job: null };
  });
  const result = await runCommand(process.execPath, ['worker/runner.mjs'], {
    cwd: fixture.root, signal: AbortSignal.timeout(20000),
    env: { ...process.env, PUBLISH_MODE: 'local', PUBLISH_RUNNER_TOKEN: token, PUBLISH_API_URL: api.url },
  });
  assert.equal(result.code, 0, result.output);
  assert.equal(result.aborted, false);
  assert.match(result.output, /代码已更新/);
  assert.equal(api.calls.filter(call => call.url === '/api/publish/next').length, 1);
  assert.equal(api.calls.some(call => call.url === '/api/publish/step'), false);
  await assert.rejects(readFile(path.join(fixture.state, 'runner.lock')));
});

test('source update racing a claim closes the job before running cached gates or swapping assets', async (t) => {
  const fixture = await runnerFixture(t);
  const api = await apiFixture(t, async () => {
    await writeFile(path.join(fixture.root, 'worker/lib/new-gate.mjs'), '// update during claim');
    return { job: { versionId: 41, stamp: 'job-secret', config: { fixture: true } } };
  });
  const result = await runCommand(process.execPath, ['worker/runner.mjs', '--once'], {
    cwd: fixture.root, env: { ...process.env, PUBLISH_MODE: 'local', PUBLISH_RUNNER_TOKEN: token, PUBLISH_API_URL: api.url },
  });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /代码已更新/);
  assert.equal(api.calls.some(call => call.body?.step === 'gates' || call.body?.step === 'swap'), false);
  assert.ok(api.calls.some(call => call.url === '/api/publish/runner-fail'));
  assert.equal(await readFile(path.join(fixture.root, 'dist-live/index.html'), 'utf8'), 'old-live');
});

test('runner uses the isolated gate even when a previous gate was cached before its startup fingerprint', async (t) => {
  const fixture = await runnerFixture(t);
  const api = await apiFixture(t);
  const gatePath = path.join(fixture.root, 'worker/lib/runner-gates.mjs');
  const stub = (marker) => `export const runSourceBaseline = async () => ({ok:false,tail:${JSON.stringify(marker)}}); export const runGates = () => {}; export const runNpm = () => {}; export const validateMaterialized = () => {};`;
  await writeFile(gatePath, stub('STALE_CACHED_GATE'));
  const preload = path.join(fixture.root, 'preload.mjs');
  await writeFile(preload, `import './worker/lib/runner-gates.mjs'; import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(gatePath)},${JSON.stringify(stub('CURRENT_ISOLATED_GATE'))});`);
  const result = await runCommand(process.execPath, ['--import', './preload.mjs', 'worker/runner.mjs', '--once'], {
    cwd: fixture.root, env: { ...process.env, PUBLISH_MODE: 'local', PUBLISH_RUNNER_TOKEN: token, PUBLISH_API_URL: api.url },
  });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /CURRENT_ISOLATED_GATE/);
  assert.doesNotMatch(result.output, /STALE_CACHED_GATE/);
  assert.equal(api.calls.some(call => call.body?.step === 'swap'), false);
});

test('real runner closes a failed gate through machine API and never writes source or live snapshot', async (t) => {
  const fixture = await runnerFixture(t);
  const api = await apiFixture(t);
  const result = await runCommand(process.execPath, ['worker/runner.mjs', '--once'], { cwd: fixture.root, env: { ...process.env, PUBLISH_MODE: 'local', PUBLISH_RUNNER_TOKEN: token, PUBLISH_API_URL: api.url } });
  assert.equal(result.code, 1, result.output);
  assert.equal(await readFile(path.join(fixture.root, 'src/i18n/en.json'), 'utf8'), 'original-source');
  assert.equal(await readFile(path.join(fixture.root, 'dist-live/index.html'), 'utf8'), 'old-live');
  assert.ok(api.calls.some((call) => call.body?.step === 'gates' && call.body.status === 'running'), result.output);
  assert.ok(api.calls.some((call) => call.url === '/api/publish/runner-fail'));
  assert.equal(api.calls.some((call) => call.body?.step === 'swap'), false);
  assert.equal(api.calls.every((call) => call.authorization === `Bearer ${token}`), true);
  assert.equal(result.output.includes(token) || result.output.includes('job-secret'), false);
  await assert.rejects(readFile(path.join(fixture.state, 'job.json')));
  const evidence = await readFile(path.join(fixture.state, 'evidence', (await readdir(path.join(fixture.state, 'evidence')))[0]), 'utf8');
  const stored = JSON.parse(evidence);
  assert.equal(stored.status, 'failed');
  assert.match(stored.source.sha256, /^[a-f0-9]{64}$/);
  assert.match(stored.configSha, /^[a-f0-9]{64}$/);
  assert.equal(stored.mode, 'local');
  assert.deepEqual(stored.runtime, { node: process.version, maglevDisabled: false });
  assert.ok(!evidence.includes(token) && !evidence.includes('job-secret'));
  assert.deepEqual(await readdir(path.join(fixture.state, 'jobs')), [], 'evidence survives workspace cleanup');
});

test('canonical runner script disables Maglev only for its process and persists runtime proof', async (t) => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const [command, ...args] = pkg.scripts['publish:runner'].split(' ');
  assert.equal(command, 'node');
  assert.deepEqual(args, ['--no-maglev', '--import', './register-ts-ext.mjs', 'runner.mjs']);
  const fixture = await runnerFixture(t);
  const api = await apiFixture(t);
  await writeFile(path.join(fixture.root, 'worker/lib/runner-gates.mjs'), `
    import {runCommand} from './runner-core.mjs';
    export async function runSourceBaseline(site,options){
      const result=await runCommand(process.execPath,['-e',"console.log('child-maglev-disabled='+process.execArgv.includes('--no-maglev'))"],{...options,cwd:site});
      return{ok:false,tail:result.output};
    }
    export const runGates=()=>{};export const runNpm=()=>{};export const validateMaterialized=()=>{};
  `);
  const result = await runCommand(process.execPath, [...args, '--once'], {
    cwd: path.join(fixture.root, 'worker'),
    env: { ...childEnvironment(), PUBLISH_MODE: 'local', PUBLISH_RUNNER_TOKEN: token, PUBLISH_API_URL: api.url },
  });
  assert.equal(result.code, 1, result.output);
  const files = await readdir(path.join(fixture.state, 'evidence'));
  const stored = JSON.parse(await readFile(path.join(fixture.state, 'evidence', files[0]), 'utf8'));
  assert.deepEqual(stored.runtime, { node: process.version, maglevDisabled: true });
  assert.match(stored.output, /child-maglev-disabled=false/);
  assert.equal(stored.status, 'failed');
  assert.equal(api.calls.some(call => call.body?.step === 'swap'), false);
  assert.equal(await readFile(path.join(fixture.root, 'dist-live/index.html'), 'utf8'), 'old-live');
});

test('late watchdog confirmation cannot resurrect a sticky flag before or after runner failure handling', { skip: process.platform !== 'win32', timeout: 35000 }, async (t) => {
  for (const mode of ['after-catch', 'before-catch', 'write-failure']) {
    const beforeCatch = mode === 'before-catch';
    const fixture = await runnerFixture(t);
    const api = await apiFixture(t);
    await injectWatchdogStopFailure(path.join(fixture.root, 'worker/lib/runner-child.mjs'), 'late', path.join(fixture.root, 'allow-stop'));
    await writeFile(path.join(fixture.root, 'worker/lib/runner-gates.mjs'), `
      import {runCommand} from './runner-core.mjs'; import {setTimeout as delay} from 'node:timers/promises';
      export async function runSourceBaseline(site,options){
        const result=await runCommand(process.execPath,['-e',"console.log('OWNED_COMMAND');setInterval(()=>{},1000)"],{...options,cwd:site,timeoutMs:300});
        await delay(${beforeCatch ? 2000 : 0});return{ok:false,tail:result.output};
      }
      export const runGates=()=>{};export const runNpm=()=>{};export const validateMaterialized=()=>{};
    `);
    const args = ['worker/runner.mjs', '--once'];
    if (mode === 'write-failure') {
      await writeFile(path.join(fixture.root, 'preload-late-save-failure.mjs'), `
        import fs from 'node:fs'; import path from 'node:path'; import {syncBuiltinESMExports} from 'node:module';
        const rename=fs.renameSync;
        fs.renameSync=(source,destination)=>{
          if(path.basename(destination)==='job.json'){
            const next=JSON.parse(fs.readFileSync(source,'utf8'));
            if(next.phase==='interrupted'&&next.childPid===null&&next.terminationUnconfirmed===false)throw Object.assign(new Error('late confirmation disk failure'),{code:'EPERM'});
          }
          return rename(source,destination);
        };syncBuiltinESMExports();
      `);
      args.unshift('--import', './preload-late-save-failure.mjs');
    }
    const options = { cwd: fixture.root, timeoutMs: 16000, env: { ...childEnvironment(), PUBLISH_MODE: 'local', PUBLISH_RUNNER_TOKEN: token, PUBLISH_API_URL: api.url } };
    const running = runCommand(process.execPath, args, options);
    if (!beforeCatch) {
      let unconfirmed;
      for (let i = 0; i < 160; i++) {
        try { unconfirmed = JSON.parse(await readFile(path.join(fixture.state, 'job.json'), 'utf8')); } catch {}
        if (unconfirmed?.terminationUnconfirmed) break;
        await delay(50);
      }
      assert.equal(unconfirmed?.terminationUnconfirmed, true);
      assert.equal(processAlive(unconfirmed.childPid), true);
      assert.equal(api.calls.some(call => call.url === '/api/publish/runner-fail'), false);
    }
    const result = await running;
    assert.equal(result.code, 1, result.output);
    assert.equal(result.timedOut, false);
    const evidenceFile = (await readdir(path.join(fixture.state, 'evidence')))[0];
    const before = JSON.parse(await readFile(path.join(fixture.state, 'evidence', evidenceFile), 'utf8'));
    assert.match(before.error, /300ms/);
    if (mode === 'write-failure') {
      assert.match(result.output, /退出确认未能持久化/);
      const rawRecord = await readFile(path.join(fixture.state, 'job.json'), 'utf8');
      const record = JSON.parse(rawRecord);
      assert.equal(record.terminationUnconfirmed, true);
      assert.ok(record.childPid > 0);
      assert.equal(processAlive(record.childPid), false);
      const calls = api.calls.length;
      const recovery = await runCommand(process.execPath, ['worker/runner.mjs', '--once'], options);
      assert.equal(recovery.code, 1, recovery.output);
      assert.match(recovery.output, /尚未确认退出/);
      assert.equal(api.calls.length, calls, 'missing durable confirmation must not close or reclaim the job');
      assert.equal(await readFile(path.join(fixture.state, 'job.json'), 'utf8'), rawRecord);
      assert.equal(api.calls.some(call => ['gates', 'build', 'swap'].includes(call.body?.step)), false);
      assert.equal(await readFile(path.join(fixture.root, 'dist-live/index.html'), 'utf8'), 'old-live');
      continue;
    }
    if (!beforeCatch) {
      assert.match(result.output, /停止处理中/);
      assert.match(result.output, /命令树已确认退出/);
      const record = JSON.parse(await readFile(path.join(fixture.state, 'job.json'), 'utf8'));
      assert.equal(record.childPid, null);
      assert.equal(record.terminationUnconfirmed, false);
      const calls = api.calls.length;
      const recovered = await runCommand(process.execPath, ['worker/runner.mjs', '--once'], options);
      assert.equal(recovered.code, 1, recovered.output);
      assert.deepEqual(api.calls.slice(calls).map(call => call.url), ['/api/publish/runner-fail']);
    }
    await assert.rejects(readFile(path.join(fixture.state, 'job.json')));
    const failure = api.calls.find(call => call.url === '/api/publish/runner-fail');
    assert.equal(failure.body.detail, before.error);
    assert.equal(api.calls.filter(call => call.url === '/api/publish/next').length, 1);
    assert.equal(api.calls.some(call => ['gates', 'build', 'swap'].includes(call.body?.step)), false);
    assert.equal(await readFile(path.join(fixture.root, 'dist-live/index.html'), 'utf8'), 'old-live');
  }
});

test('real runner saves progress before reporting and flushes its last output while the command stays silent', async (t) => {
  const fixture = await runnerFixture(t);
  await writeFile(path.join(fixture.root, 'preload-busy-evidence.mjs'), `
    import fs from 'node:fs'; import path from 'node:path'; import {syncBuiltinESMExports} from 'node:module';
    const rename=fs.renameSync; let injected=false;
    fs.renameSync=(from,to)=>{
      if(process.platform==='win32'&&!injected&&path.basename(path.dirname(to))==='evidence'){
        injected=true;throw Object.assign(new Error('reader briefly holds evidence'),{code:'EPERM'});
      }
      return rename(from,to);
    };syncBuiltinESMExports();
  `);
  const evidenceDir = path.join(fixture.state, 'evidence');
  let atReport;
  const api = await apiFixture(t, undefined, undefined, async ({ url, body }) => {
    if (url === '/api/publish/step' && decodePublishProgress(body?.detail)?.title === '文字检查 1/3') {
      try { atReport = JSON.parse(await readFile(path.join(evidenceDir, (await readdir(evidenceDir)).find(file => file.endsWith('.json'))), 'utf8')); }
      catch (error) { atReport = { error: error.message }; }
    }
  });
  const release = path.join(fixture.root, 'release-baseline');
  await writeFile(path.join(fixture.root, 'worker/lib/runner-gates.mjs'), `
    import {existsSync} from 'node:fs'; import {setTimeout as delay} from 'node:timers/promises';
    export async function runSourceBaseline(site, options) {
      await options.onProgress('文字检查 1/3');
      options.onOutput('tail-marker');
      while (!existsSync(${JSON.stringify(release)})) { options.signal.throwIfAborted(); await delay(25); }
      return {ok:false,tail:'fixture stopped after live evidence observation'};
    }
    export const runGates=()=>{}; export const runNpm=()=>{}; export const validateMaterialized=()=>{};
  `);
  let ended = false;
  let endedResult;
  const running = runCommand(process.execPath, ['--import', './preload-busy-evidence.mjs', 'worker/runner.mjs', '--once'], {
    cwd: fixture.root, timeoutMs: 18000,
    env: { ...process.env, PUBLISH_MODE: 'local', PUBLISH_RUNNER_TOKEN: token, PUBLISH_API_URL: api.url },
  }).then(result => { endedResult = result; ended = true; return result; });
  let result;
  try {
    const deadline = Date.now() + 13000;
    let saved;
    while (Date.now() < deadline && !ended) {
      const files = (await readdir(evidenceDir).catch(() => [])).filter(file => file.endsWith('.json'));
      if (files.length) saved = JSON.parse(await readFile(path.join(evidenceDir, files[0]), 'utf8'));
      if (saved?.output?.includes('tail-marker') && api.calls.some(call => decodePublishProgress(call.body?.detail)?.output.includes('tail-marker'))) break;
      await delay(30);
    }
    assert.equal(ended, false, `output must be durable before command completion: ${endedResult?.output ?? ''}`);
    assert.match(saved?.output ?? '', /tail-marker/);
    assert.ok(api.calls.some(call => decodePublishProgress(call.body?.detail)?.output.includes('tail-marker')), 'quiet output must reach the API before command completion');
    assert.equal(atReport?.progress, '文字检查 1/3', 'API received progress before its evidence was saved');
    assert.equal(api.calls.some(call => call.body?.step === 'swap'), false);
  } finally { await writeFile(release, 'continue'); result = await running; }
  assert.equal(result.code, 1, result.output);
  assert.equal(result.timedOut, false);
  assert.equal(await readFile(path.join(fixture.root, 'dist-live/index.html'), 'utf8'), 'old-live');
  const closed = api.calls.findIndex(call => call.url === '/api/publish/runner-fail');
  assert.ok(closed > 0);
  assert.equal(api.calls.slice(closed + 1).some(call => call.url === '/api/publish/step' && call.body?.status === 'running'), false, 'no late progress after terminal failure');
});

test('real runner bounds permanent progress failure despite healthy heartbeats and stops before later stages', async (t) => {
  const fixture = await runnerFixture(t);
  const api = await apiFixture(t, undefined, undefined, ({ url, body, response }) => {
    if (url === '/api/publish/step' && decodePublishProgress(body?.detail)?.output.includes('ordinary check output')) {
      response.writeHead(503, { 'content-type': 'application/json' }); response.end('{}');
    }
  });
  await writeFile(path.join(fixture.root, 'worker/lib/runner-gates.mjs'), `
    import {runCommand} from './runner-core.mjs';
    export async function runSourceBaseline(site, options) {
      const result = await runCommand(process.execPath, ['-e', "console.log('ordinary check output');setInterval(()=>{},1000)"], {...options,cwd:site});
      return {ok:result.code===0,tail:result.output};
    }
    export const runGates=()=>{}; export const runNpm=()=>{}; export const validateMaterialized=()=>{};
  `);
  const startedAt = Date.now();
  const result = await runCommand(process.execPath, ['worker/runner.mjs', '--once'], {
    cwd: fixture.root, timeoutMs: 45000,
    env: { ...process.env, PUBLISH_MODE: 'local', PUBLISH_RUNNER_TOKEN: token, PUBLISH_API_URL: api.url },
  });
  assert.equal(result.code, 1, result.output);
  assert.equal(result.timedOut, false);
  assert.ok(Date.now() - startedAt < 42000, 'healthy heartbeats cannot extend the progress confirmation deadline');
  assert.ok(api.calls.filter(call => call.url === '/api/publish/heartbeat' && call.body?.versionId).length >= 2);
  const failure = api.calls.find(call => call.url === '/api/publish/runner-fail');
  assert.match(failure?.body?.detail ?? '', /publish\/step HTTP 503/);
  assert.equal(api.calls.some(call => call.body?.step === 'swap'), false);
  assert.equal(await readFile(path.join(fixture.root, 'dist-live/index.html'), 'utf8'), 'old-live');
  const evidenceFile = (await readdir(path.join(fixture.state, 'evidence')))[0];
  const evidence = JSON.parse(await readFile(path.join(fixture.state, 'evidence', evidenceFile), 'utf8'));
  assert.match(evidence.error, /publish\/step HTTP 503/);
});

test('real runner keeps a healthy gate through an API outage or hung first request and promotes exactly once after confirmation', async (t) => {
  for (const outage of ['disconnect', 'mixed-recovery', 'hung-first-request']) await t.test(outage, async (t) => {
  const fixture = await runnerFixture(t);
  const completed = path.join(fixture.root, 'gate-completed');
  let outageStarted;
  let recoveredOutput;
  const api = await apiFixture(t, undefined, undefined, async ({ url, body, response }) => {
    const progress = decodePublishProgress(body?.detail);
    if (url === '/api/publish/step' && progress?.output.includes('gate-first-frame') && !outageStarted) {
      outageStarted = Date.now();
      if (outage === 'hung-first-request') { await delay(9500); return; }
    }
    if (outage === 'disconnect' && outageStarted && Date.now() - outageStarted < 35000) { response.destroy(); return; }
    if (outage === 'mixed-recovery' && outageStarted) {
      const elapsed = Date.now() - outageStarted;
      if (elapsed < 16000) { response.destroy(); return; }
      if (elapsed < 32000) { response.writeHead(503, { 'content-type': 'application/json' }); response.end('{}'); return; }
    }
    if (outageStarted && progress?.output.includes('gate-final-frame')) {
      recoveredOutput = progress.output;
      assert.equal(await readFile(completed, 'utf8'), 'done', 'gate work finishes while reporting is unavailable');
    }
  });
  await copyFile(fileURLToPath(new URL('../promote.mjs', import.meta.url)), path.join(fixture.root, 'worker/promote.mjs'));
  await writeFile(path.join(fixture.root, 'worker/lib/runner-gates.mjs'), `
    import {mkdir,writeFile} from 'node:fs/promises'; import path from 'node:path';
    import {runCommand} from './runner-core.mjs'; import {directoryDigest} from './runner-artifacts.mjs';
    export const runSourceBaseline=async()=>({ok:true}); export const validateMaterialized=async()=>({ok:true});
    export async function runGates(site,_mode,options) {
      const code="console.log('gate-first-frame');setTimeout(()=>console.log('gate-middle-frame'),7000);setTimeout(()=>{require('node:fs').writeFileSync("+JSON.stringify(${JSON.stringify(completed)})+",'done');console.log('gate-final-frame')},13000)";
      const result=await runCommand(process.execPath,['-e',code],{...options,cwd:site});
      if(result.code!==0)return{ok:false,gate:'fixture',tail:result.output};
      await mkdir(path.join(site,'dist'),{recursive:true});await writeFile(path.join(site,'dist/index.html'),'new-public-page');
      return{ok:true,artifact:directoryDigest(path.join(site,'dist'))};
    }
    export async function runNpm(_args,options){for(const rel of ['admin/dist','dist/admin']){await mkdir(path.join(options.cwd,rel),{recursive:true});await writeFile(path.join(options.cwd,rel,'index.html'),'new-console');}return{code:0,output:''};}
  `);
  const result = await runCommand(process.execPath, ['--import', './worker/register-ts-ext.mjs', 'worker/runner.mjs', '--once'], {
    cwd: fixture.root, timeoutMs: 60000, env: { ...process.env, PUBLISH_MODE: 'local', PUBLISH_RUNNER_TOKEN: token, PUBLISH_API_URL: api.url },
  });
  assert.equal(result.code, 0, result.output);
  assert.equal(result.timedOut, false);
  assert.ok(outageStarted, 'fixture must interrupt a real progress request');
  assert.ok(recoveredOutput?.includes('gate-final-frame'), 'latest durable output reaches the API after recovery');
  assert.equal(result.output.match(/开始：[^\n]*promote\.mjs/g)?.length, 1);
  assert.equal(api.calls.filter(call => call.url === '/api/publish/next').length, 1);
  assert.equal(api.calls.some(call => call.url === '/api/publish/runner-fail'), false);
  const done = api.calls.findIndex(call => call.body?.step === 'swap' && call.body.status === 'ok');
  assert.ok(done > 0);
  assert.equal(api.calls.slice(done + 1).some(call => call.body?.status === 'running'), false);
  assert.equal(await readFile(path.join(fixture.root, 'dist-live/index.html'), 'utf8'), 'new-public-page');
  });
});

test('real runner rejects progress identity failures immediately without the connectivity grace', async (t) => {
  for (const status of [400, 401, 403, 404, 409]) {
    const fixture = await runnerFixture(t);
    const api = await apiFixture(t, undefined, undefined, ({ url, body, response }) => {
      if (url === '/api/publish/step' && body?.step === 'materialize' && decodePublishProgress(body.detail)) {
        response.writeHead(status, { 'content-type': 'application/json' }); response.end('{}');
      }
    });
    const startedAt = Date.now();
    const result = await runCommand(process.execPath, ['worker/runner.mjs', '--once'], {
      cwd: fixture.root, timeoutMs: 8000, env: { ...process.env, PUBLISH_MODE: 'local', PUBLISH_RUNNER_TOKEN: token, PUBLISH_API_URL: api.url },
    });
    assert.equal(result.code, 1, result.output);
    assert.ok(Date.now() - startedAt < 6000);
    assert.equal(api.calls.filter(call => call.url === '/api/publish/step' && decodePublishProgress(call.body?.detail)).length, 1);
    assert.equal(api.calls.some(call => ['gates', 'build', 'swap'].includes(call.body?.step)), false);
    assert.equal(await readFile(path.join(fixture.root, 'dist-live/index.html'), 'utf8'), 'old-live');
  }
});

test('real runner retains the first gate error while an earlier periodic progress report is pending', async (t) => {
  const fixture = await runnerFixture(t);
  const api = await apiFixture(t, undefined, undefined, ({ url, body, response }) => {
    if (url === '/api/publish/step' && decodePublishProgress(body?.detail)?.output.includes('pending-output')) {
      response.writeHead(503, { 'content-type': 'application/json' }); response.end('{}');
    }
  });
  await writeFile(path.join(fixture.root, 'worker/lib/runner-gates.mjs'), `
    import {setTimeout as delay} from 'node:timers/promises';
    export async function runSourceBaseline(site,options){options.onOutput('pending-output');await delay(6000);return{ok:false,tail:'FIRST_GATE_FAILURE'};}
    export const runGates=()=>{};export const runNpm=()=>{};export const validateMaterialized=()=>{};
  `);
  const result = await runCommand(process.execPath, ['worker/runner.mjs', '--once'], {
    cwd: fixture.root, timeoutMs: 12000, env: { ...process.env, PUBLISH_MODE: 'local', PUBLISH_RUNNER_TOKEN: token, PUBLISH_API_URL: api.url },
  });
  assert.equal(result.code, 1, result.output);
  assert.equal(result.timedOut, false);
  const failure = api.calls.find(call => call.url === '/api/publish/runner-fail');
  assert.match(failure?.body?.detail ?? '', /FIRST_GATE_FAILURE/);
  assert.doesNotMatch(failure.body.detail, /HTTP 503/);
  assert.equal(api.calls.some(call => ['gates', 'build', 'swap'].includes(call.body?.step)), false);
  assert.equal(await readFile(path.join(fixture.root, 'dist-live/index.html'), 'utf8'), 'old-live');
});

test('real runner retains a real child exit failure while structured progress is still pending', async (t) => {
  const fixture = await runnerFixture(t);
  const api = await apiFixture(t, undefined, undefined, async ({ url, body, response }) => {
    if (url === '/api/publish/step' && decodePublishProgress(body?.detail)?.title === 'pending-child-progress') {
      await delay(1700);
      response.writeHead(401, { 'content-type': 'application/json' }); response.end('{}');
    }
  });
  await writeFile(path.join(fixture.root, 'worker/lib/runner-gates.mjs'), `
    import fs from 'node:fs/promises'; import {setTimeout as delay} from 'node:timers/promises';
    import {runCommand,verifyExit} from './runner-core.mjs';
    export async function runSourceBaseline(site,options){
      const code="console.log('[publish-progress] '+JSON.stringify({detail:'pending-child-progress'}));setTimeout(()=>{console.error('FIRST_GATE_FAILURE');process.exit(1)},1000)";
      const result=await runCommand(process.execPath,['-e',code],{...options,cwd:site});
      const read=fs.readFile;
      fs.readFile=async(file,...args)=>{if(String(file).endsWith('.verify-exit.code')){await delay(2000);return '1';}return read(file,...args);};
      try{return await verifyExit(site,result);}finally{fs.readFile=read;}
    }
    export const runGates=()=>{};export const runNpm=()=>{};export const validateMaterialized=()=>{};
  `);
  const result = await runCommand(process.execPath, ['worker/runner.mjs', '--once'], {
    cwd: fixture.root, timeoutMs: 12000, env: { ...process.env, PUBLISH_MODE: 'local', PUBLISH_RUNNER_TOKEN: token, PUBLISH_API_URL: api.url },
  });
  assert.equal(result.code, 1, result.output);
  assert.equal(result.timedOut, false);
  const failureAt = api.calls.findIndex(call => call.url === '/api/publish/runner-fail');
  assert.match(api.calls[failureAt]?.body?.detail ?? '', /FIRST_GATE_FAILURE/);
  assert.doesNotMatch(api.calls[failureAt].body.detail, /HTTP 401/);
  assert.equal(api.calls.slice(failureAt + 1).some(call => call.body?.status === 'running'), false);
  assert.equal(api.calls.some(call => ['gates', 'build', 'swap'].includes(call.body?.step)), false);
  assert.equal(await readFile(path.join(fixture.root, 'dist-live/index.html'), 'utf8'), 'old-live');
});

test('real runner aborts on trailing evidence flush failure without reaching swap or changing live bytes', async (t) => {
  const fixture = await runnerFixture(t);
  const api = await apiFixture(t);
  await writeFile(path.join(fixture.root, 'worker/lib/runner-gates.mjs'), `
    export async function runSourceBaseline(site, options) {
      options.onOutput('tail-marker');
      await new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
      return {ok:true};
    }
    export const runGates=()=>{}; export const runNpm=()=>{}; export const validateMaterialized=()=>{};
  `);
  await writeFile(path.join(fixture.root, 'preload-evidence-failure.mjs'), `
    import fs from 'node:fs'; import path from 'node:path'; import {syncBuiltinESMExports} from 'node:module';
    const rename=fs.renameSync;
    fs.renameSync=(from,to)=>{
      if(path.basename(path.dirname(to))==='evidence'&&fs.readFileSync(from,'utf8').includes('tail-marker')){
        throw Object.assign(new Error('injected trailing evidence write failure'),{code:'EPERM'});
      }
      return rename(from,to);
    };syncBuiltinESMExports();
  `);
  const result = await runCommand(process.execPath, ['--import', './preload-evidence-failure.mjs', 'worker/runner.mjs', '--once'], {
    cwd: fixture.root, timeoutMs: 16000,
    env: { ...process.env, PUBLISH_MODE: 'local', PUBLISH_RUNNER_TOKEN: token, PUBLISH_API_URL: api.url },
  });
  assert.equal(result.code, 1, result.output);
  assert.equal(result.timedOut, false);
  assert.match(result.output, /injected trailing evidence write failure/);
  assert.equal(api.calls.some(call => call.body?.step === 'swap'), false);
  assert.ok(api.calls.some(call => call.url === '/api/publish/runner-fail'));
  assert.equal(await readFile(path.join(fixture.root, 'dist-live/index.html'), 'utf8'), 'old-live');
});

test('real runner preserves confirmed success and readable evidence when workspace cleanup throws', async (t) => {
  const fixture = await runnerFixture(t);
  let swapProgress = 0;
  let outageStarted;
  let preparationRetries = 0;
  const api = await apiFixture(t, async () => ({ job: { versionId: 41, draftRev: 17, source: 'draft', stamp: 'job-secret', config: { fixture: true } } }), undefined, ({ url, body, response }) => {
    if (url === '/api/publish/step' && body?.step === 'materialize' && decodePublishProgress(body.detail)) {
      outageStarted ??= Date.now();
      if (Date.now() - outageStarted < 4000) {
        preparationRetries++;
        response.writeHead(503, { 'content-type': 'application/json' }); response.end('{}'); return;
      }
    }
    if (url === '/api/publish/step' && body?.step === 'swap' && decodePublishProgress(body.detail) && ++swapProgress === 2) {
      response.writeHead(503, { 'content-type': 'application/json' }); response.end('{}');
    }
  });
  await copyFile(fileURLToPath(new URL('../promote.mjs', import.meta.url)), path.join(fixture.root, 'worker/promote.mjs'));
  await writeFile(path.join(fixture.root, 'worker/lib/runner-gates.mjs'), `import{mkdir,writeFile}from'node:fs/promises';import path from'node:path';import{directoryDigest}from'./runner-artifacts.mjs';export const runSourceBaseline=async()=>({ok:true});export const validateMaterialized=async()=>({ok:true});export async function runGates(site){await mkdir(path.join(site,'dist'),{recursive:true});await writeFile(path.join(site,'dist/index.html'),'new-public-page');return{ok:true,artifact:directoryDigest(path.join(site,'dist'))};}export async function runNpm(_args,options){for(const rel of ['admin/dist','dist/admin']){await mkdir(path.join(options.cwd,rel),{recursive:true});await writeFile(path.join(options.cwd,rel,'index.html'),'new-console');}return{code:0,output:''};}`);
  await writeFile(path.join(fixture.root, 'preload.mjs'), `import{promises as fs}from'node:fs';import path from'node:path';const rm=fs.rm;fs.rm=async(file,...args)=>{if(path.basename(String(file)).startsWith('job-')&&path.basename(path.dirname(String(file)))==='jobs')throw new Error('injected cleanup error token=hidden-token');return rm(file,...args);};`);
  const result = await runCommand(process.execPath, ['--import', './preload.mjs', '--import', './worker/register-ts-ext.mjs', 'worker/runner.mjs', '--once'], { cwd: fixture.root, env: { ...process.env, PUBLISH_MODE: 'local', PUBLISH_RUNNER_TOKEN: token, PUBLISH_API_URL: api.url } });
  assert.equal(result.code, 0, result.output);
  assert.ok(preparationRetries >= 5, 'survive the observed four-second API recovery before starting checks');
  assert.ok(swapProgress >= 3, 'retry transient reporting outage after promotion');
  assert.equal(result.output.match(/开始：[^\n]*promote\.mjs/g)?.length, 1, 'never repeat the actual switch to recover reporting');
  assert.equal(api.calls.some(call => call.url === '/api/publish/runner-fail'), false);
  assert.ok(api.calls.some(call => call.body?.step === 'swap' && decodePublishProgress(call.body?.detail)?.title === '切换新版并核验'), 'swap must announce its own content before switching');
  const swapDone = api.calls.findIndex(call => call.body?.step === 'swap' && call.body.status === 'ok');
  assert.ok(swapDone > 0);
  assert.equal(api.calls.slice(swapDone + 1).some(call => call.body?.status === 'running'), false, 'successful terminal state cannot receive late progress');
  assert.equal(await readFile(path.join(fixture.root, 'dist-live/index.html'), 'utf8'), 'new-public-page');
  const text = await readFile(path.join(fixture.state, 'evidence', (await readdir(path.join(fixture.state, 'evidence')))[0]), 'utf8');
  const evidence = JSON.parse(text);
  assert.equal(evidence.status, 'published');
  assert.equal(evidence.progressReportError, undefined, 'transient outage was recovered within the API deadline');
  assert.equal(evidence.draftRev, 17);
  assert.equal(evidence.sourceKind, 'draft');
  assert.match(evidence.cleanupError, /injected cleanup error/);
  assert.ok(!text.includes('hidden-token') && !text.includes('job-secret') && !text.includes(token));
  assert.deepEqual(evidence.finalArtifact, directoryDigest(path.join(fixture.root, 'dist-live')));
  assert.match(evidence.websiteArtifact.sha256, /^[a-f0-9]{64}$/);
  const snapshot = path.join(fixture.state, 'jobs', (await readdir(path.join(fixture.state, 'jobs')))[0], 'site');
  assertDigest(path.join(snapshot, 'dist'), evidence.websiteArtifact.sha256, { exclude: ['admin', '.publish-stamp.json'] });
});

test('runner evidence follows authoritative recovery instead of labelling live or unknown outcomes failed', async (t) => {
  for (const status of ['published', 'unknown']) {
    const fixture = await runnerFixture(t);
    const api = await apiFixture(t, undefined, { ok: true, ...(status === 'published' ? { live: true } : { unknown: true }) });
    const result = await runCommand(process.execPath, ['worker/runner.mjs', '--once'], { cwd: fixture.root, env: { ...process.env, PUBLISH_MODE: 'local', PUBLISH_RUNNER_TOKEN: token, PUBLISH_API_URL: api.url } });
    assert.equal(result.code, status === 'published' ? 0 : 1, result.output);
    const evidence = JSON.parse(await readFile(path.join(fixture.state, 'evidence', (await readdir(path.join(fixture.state, 'evidence')))[0]), 'utf8'));
    assert.equal(evidence.status, status);
    assert.equal(evidence.recovered, true);
  }
});

test('promotion keeps a verified snapshot successful when old-directory cleanup fails', async (t) => {
  const root = await scratch(t);
  await mkdir(path.join(root, 'dist'));
  await mkdir(path.join(root, 'dist-live'));
  await writeFile(path.join(root, 'dist/index.html'), 'new-version');
  await writeFile(path.join(root, 'dist-live/index.html'), 'old-version');
  await writeFile(path.join(root, 'preload.mjs'), `import fs from'node:fs';import{syncBuiltinESMExports}from'node:module';const rm=fs.rmSync;let calls=0;fs.rmSync=(file,...args)=>{if(String(file).endsWith('dist-live.prev')&&++calls===2)throw Object.assign(new Error('injected cleanup failure'),{code:'EPERM'});return rm(file,...args);};syncBuiltinESMExports();`);
  const args = ['--import', './preload.mjs', fileURLToPath(new URL('../promote.mjs', import.meta.url)), '--source', path.join(root, 'dist'), '--live', path.join(root, 'dist-live'), '--expected-sha', directoryDigest(path.join(root, 'dist')).sha256];
  const result = await runCommand(process.execPath, args, { cwd: root });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /残留目录清理待恢复/);
  assert.equal(await readFile(path.join(root, 'dist-live/index.html'), 'utf8'), 'new-version');
  assert.equal(await readFile(path.join(root, 'dist-live.prev/index.html'), 'utf8'), 'old-version');
  const stale = await runCommand(process.execPath, [fileURLToPath(new URL('../promote.mjs', import.meta.url)), '--source', path.join(root, 'dist'), '--live', path.join(root, 'dist-live'), '--expected-sha', 'a'.repeat(64)], { cwd: root });
  assert.notEqual(stale.code, 0);
  assert.equal(await readFile(path.join(root, 'dist-live/index.html'), 'utf8'), 'new-version');
});

test('restart closes a persisted interrupted job without claiming or executing it again', async (t) => {
  const fixture = await runnerFixture(t);
  const api = await apiFixture(t);
  await mkdir(fixture.state, { recursive: true });
  await writeFile(path.join(fixture.state, 'identity'), 'test-persisted-runner-identity');
  await writeFile(path.join(fixture.state, 'job.json'), JSON.stringify({ versionId: 40, stamp: 'old-stamp', runnerId: 'test-persisted-runner-identity', step: 'gates', phase: 'running', childPid: null }));
  const result = await runCommand(process.execPath, ['worker/runner.mjs', '--once'], { cwd: fixture.root, env: { ...process.env, PUBLISH_MODE: 'local', PUBLISH_RUNNER_TOKEN: token, PUBLISH_API_URL: api.url } });
  assert.equal(result.code, 1, result.output);
  assert.equal(api.calls.length, 1, result.output);
  assert.equal(api.calls[0].url, '/api/publish/runner-fail');
  assert.equal(api.calls[0].body.versionId, 40);
  await assert.rejects(readFile(path.join(fixture.state, 'job.json')));
});

test('real runner restart updates its original evidence from authoritative recovery without replaying the job', async (t) => {
  for (const [serverStatus, status, terminal] of [
    ['live', 'published', true], ['archived', 'published', true], ['unknown', 'unknown', false],
    ['failed', 'failed', true], ['cancelled', 'cancelled', true], ['publishing', 'unresolved', false],
    [undefined, 'unresolved', true], [undefined, 'unresolved', false], [null, 'unresolved', true],
  ]) {
    const fixture = await runnerFixture(t);
    let recovering = false;
    const api = await apiFixture(t, undefined, () => recovering ? { ok: true, status: serverStatus, terminal, live: serverStatus === 'live', unknown: serverStatus === 'unknown' } : { ok: false });
    const options = { cwd: fixture.root, env: { ...process.env, PUBLISH_MODE: 'local', PUBLISH_RUNNER_TOKEN: token, PUBLISH_API_URL: api.url } };
    const first = await runCommand(process.execPath, ['worker/runner.mjs', '--once'], options);
    assert.equal(first.code, 1, first.output);
    const record = JSON.parse(await readFile(path.join(fixture.state, 'job.json'), 'utf8'));
    assert.match(record.evidenceFile, /^v41-[a-f0-9-]+\.json$/);
    const file = path.join(fixture.state, 'evidence', record.evidenceFile);
    const before = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(before.status, 'unresolved');
    const calls = api.calls.length;
    recovering = true;
    const second = await runCommand(process.execPath, ['worker/runner.mjs', '--once'], options);
    assert.equal(second.code, status === 'published' ? 0 : 1, second.output);
    assert.deepEqual(api.calls.slice(calls).map(call => call.url), ['/api/publish/runner-fail']);
    assert.equal(api.calls[calls].body.detail, before.error, 'recovery preserves the original failure instead of a generic interruption');
    const after = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(after.status, status);
    assert.equal(after.serverStatus, serverStatus ?? null);
    assert.equal(after.recovered, true);
    assert.equal(after.source.sha256, before.source.sha256);
    assert.equal(after.configSha, before.configSha);
    assert.match(after.recoveredAt, /^\d{4}-/);
    assert.deepEqual(await readdir(path.join(fixture.state, 'evidence')), [record.evidenceFile]);
    if (status === 'unresolved') assert.ok(await readFile(path.join(fixture.state, 'job.json')));
    else await assert.rejects(readFile(path.join(fixture.state, 'job.json')));
  }
});

test('restart recovery refuses unsafe or wrong-version evidence pointers and does not create missing legacy evidence', async (t) => {
  for (const mode of ['traversal', 'wrong-version', 'wrong-body', 'linked-directory', 'linked-temp', 'dangling-temp', 'missing', 'legacy']) {
    const fixture = await runnerFixture(t);
    const api = await apiFixture(t, undefined, { ok: true, live: true });
    await mkdir(path.join(fixture.state, 'evidence'), { recursive: true });
    const name = 'v40-00000000-0000-4000-8000-000000000000.json';
    const other = 'v41-00000000-0000-4000-8000-000000000000.json';
    const file = mode === 'traversal' ? path.join(fixture.state, 'outside.json') : path.join(fixture.state, 'evidence', mode === 'wrong-version' ? other : name);
    const original = JSON.stringify({ versionId: mode === 'wrong-body' ? 41 : 40, status: 'unresolved' });
    if (mode === 'linked-directory') {
      const outside = path.join(fixture.state, 'outside');
      await mkdir(outside);
      await rm(path.join(fixture.state, 'evidence'), { recursive: true });
      await symlink(outside, path.join(fixture.state, 'evidence'), process.platform === 'win32' ? 'junction' : 'dir');
    }
    if (!['missing', 'legacy'].includes(mode)) await writeFile(file, original);
    if (mode === 'linked-temp') await fsPromises.link(file, `${file}.tmp`);
    if (mode === 'dangling-temp') {
      const target = path.join(fixture.state, 'gone');
      await mkdir(target);
      await symlink(target, `${file}.tmp`, process.platform === 'win32' ? 'junction' : 'dir');
      await rm(target, { recursive: true });
    }
    await writeFile(path.join(fixture.state, 'identity'), 'test-persisted-runner-identity');
    const evidenceFile = mode === 'legacy' ? undefined : mode === 'traversal' ? '../outside.json' : mode === 'wrong-version' ? other : name;
    await writeFile(path.join(fixture.state, 'job.json'), JSON.stringify({ versionId: 40, stamp: 'old-stamp', runnerId: 'test-persisted-runner-identity', step: 'swap', phase: 'interrupted', childPid: null, evidenceFile }));
    const result = await runCommand(process.execPath, ['worker/runner.mjs', '--once'], { cwd: fixture.root, env: { ...process.env, PUBLISH_MODE: 'local', PUBLISH_RUNNER_TOKEN: token, PUBLISH_API_URL: api.url } });
    if (['missing', 'legacy'].includes(mode)) {
      assert.equal(result.code, 0, result.output);
      assert.deepEqual(await readdir(path.join(fixture.state, 'evidence')), [], 'do not invent evidence for old jobs');
      assert.equal(api.calls.length, 1);
    } else {
      assert.equal(result.code, 1, result.output);
      assert.equal(await readFile(file, 'utf8'), original);
      assert.equal(api.calls.length, 0, 'invalid evidence ownership must stop before recovery');
      assert.ok(await readFile(path.join(fixture.state, 'job.json')));
    }
  }
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
  for (const locale of LOCALES) {
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
