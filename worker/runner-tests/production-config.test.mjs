import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createProductionConfig, writeProductionConfig } from '../production-config.mjs';

const env = {
  CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
  PUBLISH_D1_DATABASE_ID: '172c6a32-53c7-4e82-b273-4c8ff450e0ca',
  PUBLISH_KV_NAMESPACE_ID: 'abcdef0123456789abcdef0123456789',
  PUBLISH_API_URL: 'https://nexgrid-site-worker.nexgrid.workers.dev',
};
const base = {
  name: 'nexgrid-site-worker', main: 'src/index.ts', compatibility_date: '2026-04-01',
  assets: { directory: '../dist-live', binding: 'ASSETS', run_worker_first: true, not_found_handling: '404-page' },
  d1_databases: [{ binding: 'DB', database_name: 'nexgrid_site', database_id: '00000000-0000-0000-0000-000000000000', migrations_dir: 'migrations' }],
  kv_namespaces: [{ binding: 'KV', id: 'local-dev-placeholder' }],
  triggers: { crons: ['10 0 * * *', '0 */6 * * *', '* * * * *'] },
  vars: { ENVIRONMENT: 'dev', SETUP_TOKEN: 'do-not-copy-setup', BEACON_SALT: 'do-not-copy-salt', CUSTOM_TOKEN: 'do-not-copy-custom' },
  env: { preview: { vars: { PASSWORD: 'do-not-copy-nested' } } },
};

test('requires every production resource and API origin', () => {
  for (const key of Object.keys(env)) {
    const incomplete = { ...env };
    delete incomplete[key];
    assert.throws(() => createProductionConfig({ baseConfig: base, env: incomplete }), new RegExp(key));
  }
});

test('rejects placeholder IDs and malformed resource IDs without echoing their values', () => {
  for (const [key, values] of Object.entries({
    CLOUDFLARE_ACCOUNT_ID: ['00000000000000000000000000000000', 'local-dev-placeholder', 'secret-not-an-id'],
    PUBLISH_D1_DATABASE_ID: ['00000000-0000-0000-0000-000000000000', 'local-dev-placeholder'],
    PUBLISH_KV_NAMESPACE_ID: ['00000000000000000000000000000000', 'local-dev-placeholder'],
  })) {
    for (const value of values) {
      assert.throws(() => createProductionConfig({ baseConfig: base, env: { ...env, [key]: value } }), (error) => {
        assert.ok(error.message.includes(key));
        assert.ok(!error.message.includes(value));
        return true;
      });
    }
  }
});

test('rejects non-production API destinations and credential-bearing URLs', () => {
  for (const value of ['http://nexgrid.com', 'https://localhost', 'https://127.0.0.1', 'https://[::1]', 'https://example.com', 'https://api.example.org', 'https://api.example', 'https://api.local', 'https://api.test', 'https://name:password@nexgrid.com', 'https://nexgrid.com/api', 'https://nexgrid.com/?token=secret']) {
    assert.throws(() => createProductionConfig({ baseConfig: base, env: { ...env, PUBLISH_API_URL: value } }), /PUBLISH_API_URL/);
  }
});

test('fixes the production target, relocates all build paths and preserves bindings/crons', () => {
  const root = path.resolve(tmpdir(), 'nexgrid-isolated-job');
  const snapshot = structuredClone(base);
  const config = createProductionConfig({ baseConfig: base, env, projectRoot: root });
  assert.equal(config.name, 'nexgrid-site-worker');
  assert.equal(config.account_id, env.CLOUDFLARE_ACCOUNT_ID);
  assert.equal(config.vars.ENVIRONMENT, 'production');
  assert.equal(config.vars.PUBLISH_EXECUTION_MODE, 'github');
  assert.equal(config.vars.PUBLISH_GITHUB_REPOSITORY, 'agentabatiuo572-byte/nexion-website');
  assert.equal(config.vars.PUBLISH_GITHUB_WORKFLOW, 'publish-website.yml');
  assert.equal(config.vars.PUBLISH_GITHUB_REF, 'main');
  assert.equal(config.main, path.join(root, 'worker/src/index.ts'));
  assert.equal(config.assets.directory, path.join(root, 'dist-live'));
  assert.equal(config.assets.binding, 'ASSETS');
  assert.equal(config.assets.run_worker_first, true);
  assert.equal(config.assets.not_found_handling, '404-page');
  assert.equal(config.d1_databases[0].database_id, env.PUBLISH_D1_DATABASE_ID);
  assert.equal(config.d1_databases[0].migrations_dir, path.join(root, 'worker/migrations'));
  assert.equal(config.kv_namespaces[0].id, env.PUBLISH_KV_NAMESPACE_ID);
  assert.deepEqual(config.triggers, base.triggers);
  assert.deepEqual(base, snapshot);
});

test('fails closed when required bindings or the fixed Worker target drift', () => {
  for (const change of [
    { name: 'another-worker' }, { d1_databases: [] }, { kv_namespaces: [] },
    { d1_databases: [...base.d1_databases, ...base.d1_databases] },
    { assets: { ...base.assets, binding: 'OTHER' } }, { triggers: { crons: [] } },
  ]) assert.throws(() => createProductionConfig({ baseConfig: { ...base, ...change }, env }));
});

test('preserves additional bindings while removing preview resource IDs', () => {
  const expanded = structuredClone(base);
  expanded.d1_databases.push({ binding: 'SECOND_DB', database_name: 'second', database_id: env.PUBLISH_D1_DATABASE_ID, preview_database_id: 'preview-only' });
  expanded.kv_namespaces.push({ binding: 'SECOND_KV', id: env.PUBLISH_KV_NAMESPACE_ID, preview_id: 'preview-only' });
  expanded.services = [{ binding: 'SERVICE', service: 'website-helper' }];
  const config = createProductionConfig({ baseConfig: expanded, env });
  assert.equal(config.d1_databases[1].database_name, 'second');
  assert.equal(config.d1_databases[1].database_id, env.PUBLISH_D1_DATABASE_ID);
  assert.equal(config.kv_namespaces[1].id, env.PUBLISH_KV_NAMESPACE_ID);
  assert.deepEqual(config.services, expanded.services);
  assert.ok(!JSON.stringify(config).includes('preview-only'));
  expanded.kv_namespaces[1].id = 'local-dev-placeholder';
  assert.throws(() => createProductionConfig({ baseConfig: expanded, env }), /All production KV bindings/);
  expanded.kv_namespaces[1].id = env.PUBLISH_KV_NAMESPACE_ID;
  expanded.d1_databases[1].database_id = '00000000-0000-0000-0000-000000000000';
  assert.throws(() => createProductionConfig({ baseConfig: expanded, env }), /All production D1 bindings/);
});

test('the real repository configuration retains all registered crons and binding counts', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const source = readFileSync(path.join(root, 'worker/wrangler.jsonc'), 'utf8');
  assert.ok(source.includes('"nexgrid-site-worker"'));
  const destination = mkdtempSync(path.join(tmpdir(), 'nexgrid-real-production-'));
  try {
    const { config } = writeProductionConfig({ outputFile: path.join(destination, 'production.json'), env, projectRoot: root });
    assert.ok(config.triggers.crons.includes('10 0 * * *'));
    assert.ok(config.triggers.crons.includes('0 */6 * * *'));
    assert.equal(config.d1_databases.filter((row) => row.binding === 'DB').length, 1);
    assert.equal(config.kv_namespaces.filter((row) => row.binding === 'KV').length, 1);
  } finally { rmSync(destination, { recursive: true, force: true }); }
});

test('writes a re-readable production file without any environment or development secrets', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'nexgrid-production-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'worker'));
  writeFileSync(path.join(root, 'worker/wrangler.jsonc'), JSON.stringify(base));
  const secretEnv = { ...env, CLOUDFLARE_API_TOKEN: 'do-not-copy-cloudflare', PUBLISH_RUNNER_TOKEN: 'do-not-copy-runner', PUBLISH_GITHUB_TOKEN: 'do-not-copy-github' };
  const outputFile = path.join(root, 'private/wrangler.production.json');
  const written = writeProductionConfig({ outputFile, env: secretEnv, projectRoot: root });
  const text = readFileSync(outputFile, 'utf8');
  assert.deepEqual(JSON.parse(text), written.config);
  assert.ok(!text.includes('do-not-copy'));
  assert.ok(!text.includes('TOKEN'));
  assert.ok(!text.includes('SALT'));
  assert.ok(!text.includes('PASSWORD'));
  assert.equal(JSON.parse(text).env, undefined);
});

test('CLI rejects missing deployment configuration and never prints token values', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'nexgrid-production-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../production-config.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--output', path.join(root, 'production.json')], {
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: '', PUBLISH_RUNNER_TOKEN: 'never-print-this-token' }, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CLOUDFLARE_ACCOUNT_ID is required/);
  assert.ok(!`${result.stdout}${result.stderr}`.includes('never-print-this-token'));
});
