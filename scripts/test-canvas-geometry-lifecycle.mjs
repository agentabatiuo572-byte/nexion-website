import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const parent = join(root, '.verify-tmp');
mkdirSync(parent, { recursive: true });
const fixture = mkdtempSync(join(parent, 'canvas-lifecycle-'));
const external = createServer((_req, res) => res.end('external still running'));
try {
  mkdirSync(join(fixture, 'scripts'));
  writeFileSync(join(fixture, 'package.json'), '{}');
  for (const file of ['gate-canvas-geometry.mjs', 'gate-built-routes.mjs']) {
    copyFileSync(join(root, 'scripts', file), join(fixture, 'scripts', file));
  }
  await new Promise((done) => external.listen(0, '127.0.0.1', done));
  for (const args of [[], ['--reuse', String(external.address().port)]]) {
    const run = spawnSync(process.execPath, [join(fixture, 'scripts/gate-canvas-geometry.mjs'), '--no-build', ...args], {
      encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(run.error, undefined, 'early failure must exit without a leaked listener');
    assert.equal(run.status, 3);
    assert.match(run.stdout, /找不到 dist\/sitemap-0.xml/);
    assert.ok(!run.stdout.includes('构建产物'));
  }
  assert.equal(await (await fetch(`http://127.0.0.1:${external.address().port}`)).text(), 'external still running');
  console.log('[canvas-geometry:lifecycle] 3 pass');
} finally {
  await new Promise((done) => external.close(done));
  const target = realpathSync(fixture);
  assert.equal(dirname(target).toLowerCase(), realpathSync(parent).toLowerCase());
  rmSync(target, { recursive: true, force: true });
}
