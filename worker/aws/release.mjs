import { cp, mkdir, realpath, lstat, readFile, statfs } from 'node:fs/promises';
import { openSync, closeSync, fsyncSync, readdirSync, lstatSync, renameSync, symlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { assertDigest } from '../lib/runner-artifacts.mjs';

function syncTree(directory) {
  for (const entry of readdirSync(directory)) {
    const file = path.join(directory, entry); const info = lstatSync(file);
    if (info.isSymbolicLink()) throw new Error('Release must not contain symlinks');
    if (info.isDirectory()) syncTree(file);
    else { const fd = openSync(file, process.platform === 'win32' ? 'r+' : 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
  }
  if (process.platform !== 'win32') { const fd = openSync(directory, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
}

export async function activateRelease({ source, root, versionId, expectedSha, authorize, signal, minimumFreeBytes = 2 * 1024 ** 3 }) {
  if (!Number.isSafeInteger(versionId) || versionId < 1 || !path.isAbsolute(root) || !/^[a-f0-9]{64}$/.test(expectedSha)) throw new Error('Invalid release identity');
  const base = await realpath(root);
  if (base !== path.resolve(root)) throw new Error('Publication root must be a real directory');
  const releases = path.join(base, 'releases'); await mkdir(releases, { recursive:true, mode:0o755 });
  if ((await realpath(releases)) !== releases) throw new Error('Release directory escaped publication root');
  const current = path.join(base, 'current');
  const previous = await lstat(current).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  if (previous && (!previous.isSymbolicLink() || !(await realpath(current)).startsWith(releases + path.sep))) throw new Error('Current release is not a managed symlink');
  const space = await statfs(base);
  if (space.bavail * space.bsize < minimumFreeBytes) throw new Error('Insufficient release disk space');
  const stamp = JSON.parse(await readFile(path.join(source, '.publish-stamp.json'), 'utf8'));
  if (stamp.versionId !== versionId || !stamp.stamp || stamp.artifact?.sha256 !== expectedSha) throw new Error('Release stamp mismatch');
  assertDigest(source, expectedSha);
  const name = `v${versionId}-${randomUUID()}`;
  const staging = path.join(releases, '.' + name); const release = path.join(releases, name);
  await cp(source, staging, { recursive:true, dereference:false, errorOnExist:true, force:false, filter:() => { signal?.throwIfAborted(); return true; } });
  assertDigest(staging, expectedSha); syncTree(staging);
  renameSync(staging, release);
  if (process.platform !== 'win32') { const fd = openSync(releases, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
  // Check the current lease AFTER expensive copying/fsync. Nothing asynchronous occurs
  // between authorization and rename: the externally visible switch is one POSIX rename.
  await authorize(); signal?.throwIfAborted();
  const link = path.join(base, `.current-${randomUUID()}`);
  symlinkSync(path.join('releases', name), link, 'dir');
  renameSync(link, current);
  if (process.platform !== 'win32') { const fd = openSync(base, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
  return { release, versionId };
}
