/* 同一套完整内容摘要用于隔离源码、门检产物、控制台组装和快照搬运。 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

export function fileManifest(root, files) {
  const manifest = [...new Set(files)].sort().map((rel) => {
    const file = path.resolve(root, rel);
    if (!file.startsWith(`${path.resolve(root)}${path.sep}`) || !lstatSync(file).isFile() || !realpathSync(file).startsWith(`${realpathSync(root)}${path.sep}`)) throw new Error(`摘要只接受边界内的普通文件：${rel}`);
    const body = readFileSync(file);
    return { path: rel.replaceAll(path.sep, '/'), bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') };
  });
  return { sha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'), files: manifest.length, manifest };
}

export function directoryDigest(root, { exclude = ['.publish-stamp.json'] } = {}) {
  const files = [];
  const walk = (base = '') => {
    for (const entry of readdirSync(path.join(root, base), { withFileTypes: true })) {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (exclude.includes(rel)) continue;
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile()) files.push(rel);
      else throw new Error(`产物不得包含链接或特殊文件：${rel}`);
    }
  };
  if (!lstatSync(root).isDirectory()) throw new Error('产物根必须是实体目录');
  walk();
  const { sha256, files: count } = fileManifest(root, files);
  if (!count) throw new Error('产物目录为空');
  return { sha256, files: count };
}

export function assertDigest(root, expected, options) {
  if (!/^[a-f0-9]{64}$/.test(expected || '')) throw new Error('缺少合法的完整 SHA-256 产物摘要');
  const actual = directoryDigest(root, options);
  if (actual.sha256 !== expected) throw new Error('产物内容已变化，拒绝使用另一份产物继续发布');
  return actual;
}

/** 不记录配置正文；命令输出及异常中的凭据必须在落盘之前脱敏。 */
export function redactEvidence(value, secrets = []) {
  let text = String(value);
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED_SECRET]');
  return text.replace(/\b(Bearer\s+)\S+/gi, '$1[REDACTED_SECRET]')
    .replace(/((?:token|password|secret|stamp|authorization|cookie|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s,"';}]+/gi, '$1[REDACTED_SECRET]');
}
