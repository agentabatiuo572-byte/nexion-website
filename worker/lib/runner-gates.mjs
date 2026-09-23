import { existsSync } from 'node:fs';
import { rm, readFile, cp, lstat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCommand, verifyExit } from './runner-core.mjs';
import { directoryDigest, assertDigest } from './runner-artifacts.mjs';
import { LOCALES, isLocale } from '../../schema/src/locales.ts';

export async function assertPublishedHomepages(site) {
  const { enabledLocales } = JSON.parse(await readFile(path.join(site, 'src/config/site.json'), 'utf8'));
  if (!Array.isArray(enabledLocales) || !enabledLocales.includes('en') || enabledLocales.some((locale) => !isLocale(locale)) || new Set(enabledLocales).size !== enabledLocales.length) throw new Error('Invalid published language selection');
  for (const locale of LOCALES) {
    const folder = path.join(site, 'dist', locale === 'en' ? '' : locale);
    if (enabledLocales.includes(locale)) {
      if (!(await readFile(path.join(folder, 'index.html'), 'utf8')).trim()) throw new Error(`Empty published homepage: ${locale}`);
    } else if (existsSync(folder)) throw new Error(`Disabled language has published assets: ${locale}`);
  }
}

export function npmCommand() {
  const candidates = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
  const cli = candidates.find((candidate) => candidate && path.basename(candidate) === 'npm-cli.js' && existsSync(candidate));
  if (cli) return { command: process.execPath, prefix: [cli] };
  if (process.platform !== 'win32') return { command: 'npm', prefix: [] };
  throw new Error('找不到 npm-cli.js，无法以无 shell 的方式启动发布门链');
}

export async function runNpm(args, options) {
  const npm = npmCommand();
  const script = args[0] === 'run' ? args[1] : args[0];
  const labels = { types: '生成后台接口类型', typecheck: path.basename(options?.cwd || '') === 'worker' ? '检查后台类型' : '检查官网类型', build: '构建官网页面', verify: '检查官网内容、交互和页面布局', 'verify:prod': '检查官网内容、交互、页面布局和上线条件', 'test:publisher': '检查发布器故障恢复', 'build:console': '构建后台并组装发布包' };
  await options?.onProgress?.(labels[script] || `执行检查：${script}`);
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
    await assertPublishedHomepages(root);
  } catch {
    return { ok: false, gate: 'site-build', tail: `${result.output}\n构建产物与显示语言选择不一致；停止发布` };
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
  await assertPublishedHomepages(root);
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

/** 真发布配置是物化后的权威；逐字节检查全部消费物，不改仓库种子来迎合基线门。 */
export async function validateMaterialized(site, config) {
  const manifest = JSON.parse(await readFile(path.join(site, 'worker/seed/copy-manifest.json'), 'utf8'));
  const { validateConfig } = await import(pathToFileURL(path.join(site, 'schema/src/validators.ts')).href);
  const { materializeI18n, materializeSiteJson } = await import(pathToFileURL(path.join(site, 'schema/src/materialize.ts')).href);
  const { LOCALES, MATERIALIZED_FILES } = await import(pathToFileURL(path.join(site, 'schema/src/locales.ts')).href);
  const validation = validateConfig(config, manifest);
  if (validation.errors.length) return { ok: false, gate: 'publish-config', tail: JSON.stringify(validation.errors).slice(0, 5000) };
  const bodies = [...LOCALES.map((locale) => materializeI18n(config, manifest, locale)), materializeSiteJson(config)];
  const expected = new Map(MATERIALIZED_FILES.map((file, index) => [file, bodies[index]]));
  for (const [rel, body] of expected) {
    if (await readFile(path.join(site, rel), 'utf8') !== body) return { ok: false, gate: 'publish-materialization', tail: `${rel} 与本次发布配置的物化结果不一致` };
  }
  return { ok: true, gate: null, tail: '本次发布配置校验通过，全部物化文件逐字节一致' };
}

/** 源码静态门:只验源码/门脚本自身,与本次配置正文无关。纯文案改动且源码指纹未变时可跳,
   上一次全量跑过即留结论。配置相关门(config-consistency/console-copy/beacon-size)永远跑:
   文案变长/链接变化会真实影响它们。 */
const SOURCE_STATIC_SUITES = new Set([
  'jsonc-reader-红测',
  'exit-finally-红测',
  'config-consistency-自检',
  'console-copy-自检',
  'worker-AI-runtime',
  'worker-单测',
]);
const INCREMENTAL_SKIPPED_PUBLISHER_TEST = 'publisher-故障回归';

/** 原执行器全部门保留；增加类型检查和执行器自身失败路径测试。
   options.changeTier='content-only' 且 options.sourceUnchanged 时走增量:跳过源码静态门,
   返回的 skipped 如实记录跳过的门(审计/证据可查,不冒充通过)。缺省全量。 */
export async function runGates(site, mode, commandOptions = {}, options = {}) {
  const incremental = options.changeTier === 'content-only' && options.sourceUnchanged === true;
  const skipped = [];
  const worker = path.join(site, 'worker');
  await commandOptions.onCheck?.({ step: 'gates', title: 'worker-types', status: 'running' });
  const bindings = await generateWorkerTypes(site, commandOptions);
  if (!bindings.ok) return bindings;
  await commandOptions.onCheck?.({ step: 'gates', title: 'worker-types', status: 'ok' });
  // Admin build 自带 typecheck + test；相同输入只检查一次。
  // worker 类型只与 worker 源码有关,增量时源码未变可跳；官网侧保留(物化 i18n 落进 src)。
  for (const cwd of [site, worker]) {
    const gate = `typecheck:${path.basename(cwd)}`;
    if (incremental && cwd === worker) { skipped.push(gate); await commandOptions.onCheck?.({ step: 'gates', title: gate, status: 'skipped' }); continue; }
    await commandOptions.onCheck?.({ step: 'gates', title: gate, status: 'running' });
    const result = await runNpm(['run', 'typecheck'], { ...commandOptions, cwd });
    if (result.code !== 0 || result.aborted) return { ok: false, gate, tail: result.output };
    await commandOptions.onCheck?.({ step: 'gates', title: gate, status: 'ok' });
  }
  await commandOptions.onCheck?.({ step: 'gates', title: 'site-build', status: 'running' });
  const built = await buildSiteForGates(site, commandOptions);
  if (!built.ok) return built;
  await commandOptions.onCheck?.({ step: 'gates', title: 'site-build', status: 'ok' });
  const artifact = directoryDigest(path.join(site, 'dist'));
  // 先检查后台与执行器，确定性错误不必等九语浏览器检查结束才暴露。
  await prepareWorkerTestAssets(site, commandOptions);
  const suites = [
    ['jsonc-reader-红测', ['lib/test-read-jsonc.mjs'], worker],
    ['exit-finally-红测', ['lib/test-exit-skips-finally.mjs'], worker],
    ['config-consistency-自检', ['gate-config-consistency.mjs', '--self-test'], worker],
    ['console-copy-自检', ['gate-console-copy.mjs', '--self-test'], worker],
    ['config-consistency', ['gate-config-consistency.mjs'], worker],
    ['console-copy', ['gate-console-copy.mjs'], worker],
    ['beacon-size', ['gate-beacon-size.mjs'], worker],
    ['worker-AI-runtime', ['--no-maglev', 'test-ai-runtime.mjs'], worker],
    ['worker-单测', ['node_modules/vitest/vitest.mjs', 'run'], worker],
  ];
  for (const [gate, args, cwd] of suites) {
    if (incremental && SOURCE_STATIC_SUITES.has(gate)) {
      skipped.push(gate);
      await commandOptions.onProgress?.(`跳过检查:${gate}(文案改动且源码未变,复用上次全量结论)`);
      await commandOptions.onCheck?.({ step: 'gates', title: gate, status: 'skipped' });
      continue;
    }
    await commandOptions.onCheck?.({ step: 'gates', title: gate, status: 'running' });
    await commandOptions.onProgress?.(`执行检查:${gate}`);
    const result = await runCommand(process.execPath, args, { ...commandOptions, cwd });
    if (result.code !== 0 || result.aborted) return { ok: false, gate, tail: result.output };
    /* 同门 running 后必有终态 ok：/check 只增不改，终态靠终态行覆盖 running 行展示；
       否则 live 版本永远残留“进行中”。 */
    await commandOptions.onCheck?.({ step: 'gates', title: gate, status: 'ok' });
  }
  assertDigest(path.join(site, 'dist'), artifact.sha256);
  if (incremental) {
    skipped.push(INCREMENTAL_SKIPPED_PUBLISHER_TEST);
    await commandOptions.onProgress?.(`跳过检查:${INCREMENTAL_SKIPPED_PUBLISHER_TEST}(文案改动且源码未变,复用上次全量结论)`);
    await commandOptions.onCheck?.({ step: 'gates', title: INCREMENTAL_SKIPPED_PUBLISHER_TEST, status: 'skipped' });
  } else {
    await commandOptions.onCheck?.({ step: 'gates', title: 'publisher-故障回归', status: 'running' });
    const publisher = await runNpm(['run', 'test:publisher'], { ...commandOptions, cwd: worker });
    if (publisher.code !== 0 || publisher.aborted) return { ok: false, gate: 'publisher-故障回归', tail: publisher.output };
    await commandOptions.onCheck?.({ step: 'gates', title: 'publisher-故障回归', status: 'ok' });
  }
  assertDigest(path.join(site, 'dist'), artifact.sha256);
  // 源码缓存不证明线上快照通过当前门；每次发布都对本次产物全站实测。
  await rm(path.join(site, '.verify-exit.code'), { force: true });
  const verifyArgs = ['run', mode === 'production' ? 'verify:prod' : 'verify', '--', '--built-dist-sha', artifact.sha256, '--fail-fast'];
  const verified = await runNpm(verifyArgs, { ...commandOptions, cwd: site, timeoutMs: mode === 'local' ? 60 * 60_000 : commandOptions.timeoutMs });
  const verdict = await verifyExit(site, verified);
  if (!verdict.ok) return verdict;
  assertDigest(path.join(site, 'dist'), artifact.sha256);
  return { ok: true, gate: null, tail: incremental ? `发布门已通过(增量:跳过 ${skipped.length} 项源码静态门,版面门全量实测)` : '所有发布门已通过', artifact, skipped };
}
