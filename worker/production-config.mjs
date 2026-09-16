#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonc } from './lib/read-jsonc.mjs';

export const PRODUCTION_WORKER_NAME = 'nexgrid-site-worker';
const DEFAULT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const HEX_ID = /^[a-f0-9]{32}$/i;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function required(env, key) {
  const value = env[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
}

function resourceId(env, key, pattern) {
  const value = required(env, key);
  if (!pattern.test(value) || /^0+$/.test(value.replaceAll('-', ''))) {
    throw new Error(`${key} must be a real Cloudflare resource ID, not a placeholder`);
  }
  return value;
}

export function validateProductionApiUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('PUBLISH_API_URL must be an HTTPS origin'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !host.includes('.') || host === 'localhost' || host.endsWith('.localhost') ||
      ['example.com', 'example.net', 'example.org'].some((domain) => host === domain || host.endsWith(`.${domain}`)) ||
      ['.example', '.test', '.invalid', '.local'].some((suffix) => host.endsWith(suffix)) ||
      host.includes(':') || /^[0-9.]+$/.test(host)) {
    throw new Error('PUBLISH_API_URL must be a public HTTPS origin without credentials, path, query or fragment');
  }
  return url.origin;
}

function onlyBinding(rows, binding, label) {
  if (!Array.isArray(rows) || rows.filter((row) => row.binding === binding).length !== 1) {
    throw new Error(`${label} must contain exactly one ${binding} binding`);
  }
}

/** The production target is fixed; account/resource IDs are explicit deployment inputs. */
export function createProductionConfig({ baseConfig, env = process.env, projectRoot = DEFAULT_ROOT }) {
  if (!baseConfig || baseConfig.name !== PRODUCTION_WORKER_NAME) throw new Error('Production Worker name does not match the fixed website target');
  const accountId = resourceId(env, 'CLOUDFLARE_ACCOUNT_ID', HEX_ID);
  const databaseId = resourceId(env, 'PUBLISH_D1_DATABASE_ID', UUID);
  const namespaceId = resourceId(env, 'PUBLISH_KV_NAMESPACE_ID', HEX_ID);
  validateProductionApiUrl(required(env, 'PUBLISH_API_URL'));
  onlyBinding(baseConfig.d1_databases, 'DB', 'd1_databases');
  onlyBinding(baseConfig.kv_namespaces, 'KV', 'kv_namespaces');
  if (baseConfig.assets?.binding !== 'ASSETS' || !Array.isArray(baseConfig.triggers?.crons) || !baseConfig.triggers.crons.length) {
    throw new Error('Production requires the ASSETS binding and registered cron jobs');
  }
  const root = path.resolve(projectRoot);
  const workerRoot = path.join(root, 'worker');
  const config = structuredClone(baseConfig);
  // Do not copy development vars or nested environments: secrets are provisioned separately.
  delete config.env;
  config.name = PRODUCTION_WORKER_NAME;
  config.account_id = accountId;
  config.main = path.join(workerRoot, 'src/index.ts');
  config.assets = { ...config.assets, directory: path.join(root, 'dist-live'), run_worker_first: true };
  config.d1_databases = config.d1_databases.map((binding) => {
    const result = { ...binding };
    if (binding.binding === 'DB') result.database_id = databaseId;
    if (!UUID.test(result.database_id ?? '') || /^0+$/.test(result.database_id.replaceAll('-', ''))) {
      throw new Error('All production D1 bindings require real database IDs');
    }
    if (result.migrations_dir) result.migrations_dir = path.resolve(workerRoot, result.migrations_dir);
    delete result.preview_database_id;
    return result;
  });
  config.kv_namespaces = config.kv_namespaces.map((binding) => {
    const result = { ...binding };
    if (binding.binding === 'KV') result.id = namespaceId;
    if (!HEX_ID.test(result.id ?? '') || /^0+$/.test(result.id)) throw new Error('All production KV bindings require real namespace IDs');
    delete result.preview_id;
    return result;
  });
  // Deliberate allowlist: no token, password, salt or local development value is serialized.
  config.vars = {
    ENVIRONMENT: 'production',
    PUBLISH_EXECUTION_MODE: 'github',
    PUBLISH_GITHUB_REPOSITORY: 'agentabatiuo572-byte/nexion-website',
    PUBLISH_GITHUB_WORKFLOW: 'publish-website.yml',
    PUBLISH_GITHUB_REF: 'main',
  };
  return config;
}

export function writeProductionConfig({ outputFile, env = process.env, projectRoot = DEFAULT_ROOT }) {
  if (typeof outputFile !== 'string' || !outputFile.trim()) throw new Error('Production configuration output path is required');
  const baseFile = path.join(projectRoot, 'worker/wrangler.jsonc');
  const baseConfig = parseJsonc(readFileSync(baseFile, 'utf8'), 'worker/wrangler.jsonc');
  const config = createProductionConfig({ baseConfig, env, projectRoot });
  const destination = path.resolve(outputFile);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return { config, outputFile: destination };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--output') throw new Error('Usage: node worker/production-config.mjs --output <private temporary path>');
    writeProductionConfig({ outputFile: args[1] });
    console.log('Production configuration validated and written; credentials were not included.');
  } catch (error) {
    console.error(`Production configuration rejected: ${error.message}`);
    process.exitCode = 1;
  }
}
