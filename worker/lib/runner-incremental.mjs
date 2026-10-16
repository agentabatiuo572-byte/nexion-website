/* Reuse only successful checks tied to an immutable program image and exact inputs.
   Content never chooses a command, cache path, qualification or verification scope. */
import { createHash, randomUUID } from 'node:crypto';
import { constants, accessSync, lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rename, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileManifest, directoryDigest, assertDigest } from './runner-artifacts.mjs';

export const QUALIFICATION_VERSION = 1;
const SHA = /^[a-f0-9]{64}$/;
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

export function runtimeIdentity(site, env = process.env) {
  // Image ID covers actual installed dependencies and browser binaries, not only lockfiles.
  if (!/^sha256:[a-f0-9]{64}$/.test(env.PUBLISH_IMAGE_ID ?? '')) return null;
  const locks = ['package-lock.json', 'worker/package-lock.json', 'admin/package-lock.json', 'schema/package-lock.json'].map(rel => [rel, digest(readFileSync(path.join(site, rel), 'utf8'))]);
  return digest({ version: QUALIFICATION_VERSION, image: env.PUBLISH_IMAGE_ID, node: process.version,
    platform: process.platform, arch: process.arch,
    nodeOptions: env.NODE_OPTIONS ?? '', browserPath: env.PLAYWRIGHT_BROWSERS_PATH ?? '', locks });
}

export function artifactManifest(root) {
  const files = [];
  const walk = (base = '') => {
    for (const entry of readdirSync(path.join(root, base), { withFileTypes: true })) {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (rel === 'admin' || rel === '.publish-stamp.json') continue;
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile()) files.push(rel);
      else throw new Error('Website manifest cannot contain links');
    }
  };
  walk();
  return fileManifest(root, files);
}

export function validManifest(value) {
  return !!value && Array.isArray(value.manifest) && value.manifest.length > 0
    && value.manifest.every(f => typeof f.path === 'string' && !f.path.startsWith('/') && !f.path.includes('\\')
      && !f.path.split('/').some(p => !p || p === '.' || p === '..') && SHA.test(f.sha256) && Number.isSafeInteger(f.bytes) && f.bytes >= 0)
    && new Set(value.manifest.map(f => f.path)).size === value.manifest.length
    && value.files === value.manifest.length && digest(value.manifest) === value.sha256;
}

export function affectedRoutes(previous, current) {
  if (!validManifest(current)) throw new Error('Invalid current website manifest');
  const route = file => file === 'index.html' ? '/' : file.endsWith('/index.html') ? `/${file.slice(0, -10)}` : null;
  const all = current.manifest.map(f => route(f.path)).filter(Boolean).sort();
  if (!all.length || !all.includes('/')) throw new Error('Missing website homepage');
  const full = reason => ({ routes: all, full: true, reason });
  if (!validManifest(previous)) return full('没有有效的已验证页面基线');
  const before = new Map(previous.manifest.map(f => [f.path, f.sha256]));
  const after = new Map(current.manifest.map(f => [f.path, f.sha256]));
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter(f => before.get(f) !== after.get(f));
  // Conservative dependency closure: any non-document change includes all consumers,
  // including nested CSS URLs, module imports and font/image replacement under the same name.
  if (changed.some(f => !route(f))) return full('公共资源或非页面产物发生变化');
  if (changed.some(f => !after.has(f))) return full('页面删除，重新检查路由与语言覆盖');
  const routes = changed.map(route).sort();
  return { routes: routes.length ? routes : ['/'], full: false, reason: routes.length ? '检查本次变化的页面' : '页面未变化，保留首页上线前检查' };
}

export function qualificationMatches(q, sourceSha, runtimeKey) {
  return !!runtimeKey && SHA.test(sourceSha ?? '') && q?.schemaVersion === QUALIFICATION_VERSION
    && q.sourceSha === sourceSha && q.runtimeKey === runtimeKey && q.codePassed === true
    && q.websitePassed === true && q.adminPassed === true && validManifest(q.website)
    && validManifest(q.source) && q.source.sha256 === sourceSha
    && SHA.test(q.adminSha ?? '') && SHA.test(q.artifactSha ?? '') && SHA.test(q.configSha ?? '')
    && Array.isArray(q.enabledLocales) && q.enabledLocales.includes('en');
}

export function readQualification(root, sourceSha, runtimeKey) {
  try {
    if (!root || !path.isAbsolute(root) || realpathSync(root) !== path.resolve(root)) return null;
    const file = path.join(root, 'qualification.json');
    const info = lstatSync(file);
    if (!info.isFile() || info.nlink !== 1 || process.platform !== 'linux' || info.uid !== 0) return null;
    for (const target of [root, file]) {
      try { accessSync(target, constants.W_OK); return null; } catch (e) { if (!['EACCES', 'EROFS'].includes(e.code)) return null; }
    }
    const q = JSON.parse(readFileSync(file, 'utf8'));
    return qualificationMatches(q, sourceSha, runtimeKey) && qualificationArtifactsValid(root, q) ? { ...q, root } : null;
  } catch { return null; }
}

export function qualificationArtifactsValid(root, q) {
  try {
    const artifact = path.join(root, 'artifact');
    if (realpathSync(artifact) !== path.resolve(artifact)) return false;
    assertDigest(artifact, q.artifactSha);
    assertDigest(path.join(artifact, 'admin'), q.adminSha);
    if (!readFileSync(path.join(artifact, 'admin/index.html'), 'utf8').trim()) return false;
    return artifactManifest(artifact).sha256 === q.website.sha256;
  } catch { return false; }
}

// Replace a verified stage as a whole. Retry must never merge old extra files.
// Previous stages are retained in this qualification's private trash for recovery.
export async function replaceQualifiedStage(output, name, source, expectedSha) {
  if (!['site', 'admin', 'artifact'].includes(name)) throw new Error('Unknown qualification stage');
  if (realpathSync(output) !== path.resolve(output)) throw new Error('Qualification output escaped its directory');
  const staging = path.join(output, `.${name}-${randomUUID()}`);
  await cp(source, staging, { recursive: true, dereference: false });
  assertDigest(staging, expectedSha);
  const target = path.join(output, name);
  let exists = false;
  try { await lstat(target); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (exists) {
    if (realpathSync(target) !== path.resolve(target)) throw new Error('Qualification stage escaped its directory');
    const trash = path.join(output, '.trash');
    await mkdir(trash, { recursive: true, mode: 0o700 });
    if (realpathSync(trash) !== path.resolve(trash)) throw new Error('Qualification trash escaped its directory');
    await rename(target, path.join(trash, `${name}-${randomUUID()}`));
  }
  await rename(staging, target);
}

export function atomicJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, file);
}

export async function materializedDigest(site) {
  const { MATERIALIZED_FILES } = await import('../../schema/src/locales.ts');
  return digest((await Promise.all(MATERIALIZED_FILES.map(async rel => `${rel}\0${await readFile(path.join(site, rel), 'utf8')}`))).join('\0'));
}

export async function checkQualifiedSource(q, site) {
  const { MATERIALIZED_FILES } = await import('../../schema/src/locales.ts');
  const sourceFiles = q.source.manifest.filter(f => !MATERIALIZED_FILES.includes(f.path));
  const actual = fileManifest(site, sourceFiles.map(f => f.path));
  if (actual.sha256 !== digest(sourceFiles)) throw new Error('Program source no longer matches its qualification');
}

export function cachedWebsite(stateDir, q) {
  try {
    const record = JSON.parse(readFileSync(path.join(stateDir, 'verified-website.json'), 'utf8'));
    if (record.sourceSha === q.sourceSha && record.runtimeKey === q.runtimeKey && validManifest(record.website)) return record.website;
  } catch { /* No prior successful content check: use the image qualification baseline. */ }
  return q.website;
}

export async function reusableArtifact(stateDir, q, configSha) {
  const key = digest([q.sourceSha, q.runtimeKey, configSha]);
  const candidates = [{ root: path.join(q.root, 'artifact'), record: q }];
  const cached = path.join(stateDir, 'artifacts', key);
  try { candidates.unshift({ root: path.join(cached, 'dist'), record: JSON.parse(await readFile(path.join(cached, 'receipt.json'), 'utf8')) }); } catch { /* Cache miss. */ }
  for (const { root, record } of candidates) {
    if (record.sourceSha !== q.sourceSha || record.runtimeKey !== q.runtimeKey || record.configSha !== configSha || !SHA.test(record.artifactSha ?? '')) continue;
    try {
      if ((await lstat(root)).isSymbolicLink() || realpathSync(root) !== path.resolve(root)) continue;
      assertDigest(root, record.artifactSha);
      assertDigest(path.join(root, 'admin'), q.adminSha);
      if (!readFileSync(path.join(root, 'admin/index.html'), 'utf8').trim()) continue;
      return { root, artifact: directoryDigest(root), website: artifactManifest(root) };
    } catch { /* Damaged/expired artifact is never evidence of success. */ }
  }
  return null;
}

export async function saveArtifact(stateDir, q, configSha, dist, signal) {
  signal?.throwIfAborted();
  const root = path.join(stateDir, 'artifacts');
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (realpathSync(root) !== path.resolve(root)) throw new Error('Artifact cache escaped its state directory');
  const key = digest([q.sourceSha, q.runtimeKey, configSha]);
  const target = path.join(root, key);
  // Bounded cache: at most eight complete/staging entries, no unbounded version retention.
  // A full cache simply builds the next content again; it never weakens verification.
  const existing = await readdir(root);
  if (existing.includes(key) || existing.length >= 8) return;
  const artifact = directoryDigest(dist);
  const staging = path.join(root, `.${key}-${randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  await cp(dist, path.join(staging, 'dist'), { recursive: true, dereference: false, filter: () => { signal?.throwIfAborted(); return true; } });
  assertDigest(path.join(staging, 'dist'), artifact.sha256);
  atomicJson(path.join(staging, 'receipt.json'), { sourceSha: q.sourceSha, runtimeKey: q.runtimeKey, configSha, artifactSha: artifact.sha256, at: new Date().toISOString() });
  signal?.throwIfAborted();
  await rename(staging, target);
}
