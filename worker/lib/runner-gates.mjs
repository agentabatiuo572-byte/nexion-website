import { existsSync } from 'node:fs';
import { rm, readFile, cp, lstat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCommand, verifyExit } from './runner-core.mjs';

export function npmCommand() {
  const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
  const cli = candidates.find((candidate) => candidate && path.basename(candidate) === 'npm-cli.js' && existsSync(candidate));
  if (cli) return { command: process.execPath, prefix: [cli] };
  if (process.platform !== 'win32') return { command: 'npm', prefix: [] };
  throw new Error('找不到 npm-cli.js，无法以无 shell 的方式启动发布门链');
}

export async function runNpm(args, options) {
  const npm = npmCommand();
  return runCommand(npm.command, [...npm.prefix, ...args], options);
}

/** 绑定类型来自当前隔离配置；不可依赖被 git 忽略的历史生成物。 */
export async function generateWorkerTypes(site, commandOptions = {}) {
  const worker = path.join(site, 'worker');
  const generated = path.join(worker, 'worker-configuration.d.ts');
  await rm(generated, { force: true });
  const result = await runNpm(['run', 'types'], { ...commandOptions, cwd: worker });
  if (result.code !== 0 || result.aborted) return { ok: false, gate: 'worker-types', tail: result.output };
  try {
    if (!(await readFile(generated, 'utf8')).trim()) throw new Error('empty binding types');
  } catch {
    return { ok: false, gate: 'worker-types', tail: `${result.output}\n绑定类型生成物缺失或为空；停止发布` };
  }
  return { ok: true, gate: null, tail: result.output };
}

/** launch-assets 等门先读 dist；冷副本必须先构建本次物化内容，不能借用旧产物。 */
export async function buildSiteForGates(site, commandOptions = {}) {
  const root = path.resolve(site);
  const dist = path.join(root, 'dist');
  if (path.dirname(dist) !== root) throw new Error('构建产物目录越过隔离边界');
  await rm(dist, { recursive: true, force: true });
  const result = await runNpm(['run', 'build'], { ...commandOptions, cwd: root });
  if (result.code !== 0 || result.aborted) return { ok: false, gate: 'site-build', tail: result.output };
  try {
    for (const rel of ['index.html', 'vi/index.html', 'zh/index.html']) {
      if (!(await readFile(path.join(dist, rel), 'utf8')).trim()) throw new Error('empty built page');
    }
  } catch {
    return { ok: false, gate: 'site-build', tail: `${result.output}\n三语首页构建产物缺失或为空；停止发布` };
  }
  return { ok: true, gate: null, tail: result.output };
}

/** worker 的 ASSETS 仍指 dist-live；这里只给无 .git 的私有副本准备实体测试夹具。 */
export async function prepareWorkerTestAssets(site, commandOptions = {}) {
  const root = path.resolve(site);
  const dist = path.join(root, 'dist');
  const fixture = path.join(root, 'dist-live');
  if (path.dirname(fixture) !== root || existsSync(path.join(root, '.git'))) throw new Error('测试资产只能准备在私有隔离副本中');
  const existing = await lstat(fixture).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing?.isSymbolicLink()) throw new Error('测试资产目录不得链接到其他目录');
  commandOptions.signal?.throwIfAborted();
  for (const rel of ['index.html', 'vi/index.html', 'zh/index.html']) {
    if (!(await readFile(path.join(dist, rel), 'utf8')).trim()) throw new Error('测试资产缺少本次三语构建产物');
  }
  await rm(fixture, { recursive: true, force: true });
  await cp(dist, fixture, { recursive: true, filter: () => { commandOptions.signal?.throwIfAborted(); return true; } });
  // 测试夹具不是已发布版本；实际 build/swap 后仍必须由 promote 写本次印记。
  await rm(path.join(fixture, '.publish-stamp.json'), { force: true });
  commandOptions.signal?.throwIfAborted();
}

/** 源码种子是仓库基线，只能在发布配置物化之前比较。 */
export async function runSourceBaseline(site, commandOptions = {}) {
  const result = await runCommand(process.execPath, ['--import', './register-ts-ext.mjs', 'gate-equivalence.mjs'], { ...commandOptions, cwd: path.join(site, 'worker') });
  return { ok: result.code === 0 && !result.aborted, gate: 'source-equivalence', tail: result.output };
}

/** 真发布配置是物化后的权威；逐字节检查全部四份消费物，不改仓库种子来迎合基线门。 */
export async function validateMaterialized(site, config) {
  const manifest = JSON.parse(await readFile(path.join(site, 'worker/seed/copy-manifest.json'), 'utf8'));
  const { validateConfig } = await import(pathToFileURL(path.join(site, 'schema/src/validators.ts')).href);
  const { materializeI18n, materializeSiteJson } = await import(pathToFileURL(path.join(site, 'schema/src/materialize.ts')).href);
  const validation = validateConfig(config, manifest);
  if (validation.errors.length) return { ok: false, gate: 'publish-config', tail: JSON.stringify(validation.errors).slice(0, 5000) };
  const expected = new Map([['src/config/site.json', materializeSiteJson(config)], ...['en', 'vi', 'zh'].map((locale) => [`src/i18n/${locale}.json`, materializeI18n(config, manifest, locale)])]);
  for (const [rel, body] of expected) {
    if (await readFile(path.join(site, rel), 'utf8') !== body) return { ok: false, gate: 'publish-materialization', tail: `${rel} 与本次发布配置的物化结果不一致` };
  }
  return { ok: true, gate: null, tail: '本次发布配置校验通过，全部物化文件逐字节一致' };
}

/** 原执行器全部门保留；增加类型检查和执行器自身失败路径测试。 */
export async function runGates(site, mode, commandOptions = {}) {
  const worker = path.join(site, 'worker');
  const bindings = await generateWorkerTypes(site, commandOptions);
  if (!bindings.ok) return bindings;
  for (const cwd of [site, worker, path.join(site, 'admin')]) {
    const result = await runNpm(['run', 'typecheck'], { ...commandOptions, cwd });
    if (result.code !== 0 || result.aborted) return { ok: false, gate: `typecheck:${path.basename(cwd)}`, tail: result.output };
  }
  const built = await buildSiteForGates(site, commandOptions);
  if (!built.ok) return built;
  await rm(path.join(site, '.verify-exit.code'), { force: true });
  const verified = await runNpm(['run', mode === 'production' ? 'verify:prod' : 'verify'], { ...commandOptions, cwd: site });
  const verdict = await verifyExit(site, verified);
  if (!verdict.ok) return verdict;
  await prepareWorkerTestAssets(site, commandOptions);
  const publisher = await runNpm(['run', 'test:publisher'], { ...commandOptions, cwd: worker });
  if (publisher.code !== 0 || publisher.aborted) return { ok: false, gate: 'publisher-故障回归', tail: publisher.output };
  const suites = [
    ['jsonc-reader-红测', ['lib/test-read-jsonc.mjs'], worker],
    ['exit-finally-红测', ['lib/test-exit-skips-finally.mjs'], worker],
    ['config-consistency-自检', ['gate-config-consistency.mjs', '--self-test'], worker],
    ['console-copy-自检', ['gate-console-copy.mjs', '--self-test'], worker],
    ['css-shadowed-红测', ['scripts/test-css-shadowed.mjs'], site],
    ['render-fit-自检', ['scripts/gate-render-fit.mjs', '--self-test'], site],
    ['worker-单测', ['node_modules/vitest/vitest.mjs', 'run'], worker],
    ['config-consistency', ['gate-config-consistency.mjs'], worker],
    ['console-copy', ['gate-console-copy.mjs'], worker],
    ['beacon-size', ['gate-beacon-size.mjs'], worker],
  ];
  for (const [gate, args, cwd] of suites) {
    const result = await runCommand(process.execPath, args, { ...commandOptions, cwd });
    if (result.code !== 0 || result.aborted) return { ok: false, gate, tail: result.output };
  }
  return { ok: true, gate: null, tail: '所有发布门已通过' };
}
