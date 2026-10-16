/* Run once per immutable image, in the same non-root, read-only --init container
   and resource limits as the publisher. /qualification-output is a private staging
   mount; the host installs the completed directory root-owned and read-only. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createWorkspace, childEnvironment, runCommand } from '../../worker/lib/runner-core.mjs';
import { runGates, runNpm, runSourceBaseline, validateMaterialized } from '../../worker/lib/runner-gates.mjs';
import { runtimeIdentity, atomicJson, materializedDigest, artifactManifest, replaceQualifiedStage, QUALIFICATION_VERSION } from '../../worker/lib/runner-incremental.mjs';
import { assertDigest, directoryDigest } from '../../worker/lib/runner-artifacts.mjs';
import { LOCALES } from '../../schema/src/locales.ts';
import { materializeI18n, materializeSiteJson } from '../../schema/src/materialize.ts';

assert.equal(process.platform, 'linux');
assert.equal(process.getuid(), 10001);
assert.equal(readFileSync('/proc/1/comm', 'utf8').trim(), 'docker-init');
const output = '/qualification-output';
const runtimeKey = runtimeIdentity('/app');
assert.ok(runtimeKey, 'The host must provide the immutable Docker image ID');
const startedAt = new Date().toISOString();
const workspace = await createWorkspace('/app', path.join(process.env.HOME, 'qualification-jobs'));
const site = workspace.site, sourceSha = workspace.sourceSnapshot.sha256;
const options = { cwd: site, env: childEnvironment(), timeoutMs: 30 * 60_000, maxOutput: 20000,
  onProgress: detail => console.log(`[qualification] ${detail}`),
  onCheck: event => console.log(JSON.stringify({ at: new Date().toISOString(), ...event })),
};
const prior = async name => {
  try { const r = JSON.parse(await readFile(path.join(output, name), 'utf8')); return r.sourceSha === sourceSha && r.runtimeKey === runtimeKey && r.passed === true ? r : null; }
  catch { return null; }
};
const save = (name, data) => atomicJson(path.join(output, name), { sourceSha, runtimeKey, passed: true, at: new Date().toISOString(), ...data });
try {
  await mkdir(output, { recursive: true });
  const baseline = await runSourceBaseline(site, options); assert.equal(baseline.ok, true, baseline.tail);
  const config = JSON.parse(await readFile(path.join(site, 'worker/seed/site-config.seed.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(site, 'worker/seed/copy-manifest.json'), 'utf8'));
  for (const locale of LOCALES) await writeFile(path.join(site, `src/i18n/${locale}.json`), materializeI18n(config, manifest, locale));
  await writeFile(path.join(site, 'src/config/site.json'), materializeSiteJson(config));
  const materialized = await validateMaterialized(site, config); assert.equal(materialized.ok, true, materialized.tail);
  const configSha = await materializedDigest(site);
  // The actual deployment process policy is always checked, even when a previous stage passed.
  const deadline = await runCommand(process.execPath, ['--no-maglev', '--test', '--test-name-pattern=command absolute deadlines', 'worker/lib/runner-tests.mjs'], options);
  assert.equal(deadline.code, 0, deadline.output);
  let website = await prior('website.json');
  if (website) { try { assertDigest(path.join(output, 'site'), website.artifactSha); } catch { website = null; } }
  if (website) await cp(path.join(output, 'site'), path.join(site, 'dist'), { recursive: true });
  else {
    const gates = await runGates(site, 'aws', options, { codeAlreadyQualified: !!(await prior('code.json')), onCodeQualified: async () => save('code.json', {}) });
    assert.equal(gates.ok, true, gates.tail);
    await replaceQualifiedStage(output, 'site', path.join(site, 'dist'), gates.artifact.sha256);
    save('website.json', { artifactSha: gates.artifact.sha256 });
  }
  let admin = await prior('admin.json');
  if (admin) { try { assertDigest(path.join(output, 'admin'), admin.artifactSha); } catch { admin = null; } }
  if (admin) await cp(path.join(output, 'admin'), path.join(site, 'dist/admin'), { recursive: true });
  else {
    const built = await runNpm(['run', 'build:console'], options); assert.equal(built.code, 0, built.output);
    const adminSha = directoryDigest(path.join(site, 'dist/admin')).sha256;
    await replaceQualifiedStage(output, 'admin', path.join(site, 'dist/admin'), adminSha);
    save('admin.json', { artifactSha: adminSha });
  }
  const artifactSha = directoryDigest(path.join(site, 'dist')).sha256;
  await replaceQualifiedStage(output, 'artifact', path.join(site, 'dist'), artifactSha);
  const receipt = { schemaVersion: QUALIFICATION_VERSION, sourceSha, runtimeKey, source: workspace.sourceSnapshot,
    codePassed: true, websitePassed: true, adminPassed: true, website: artifactManifest(path.join(site, 'dist')),
    configSha, adminSha: directoryDigest(path.join(site, 'dist/admin')).sha256, artifactSha,
    enabledLocales: config.enabledLocales, startedAt, finishedAt: new Date().toISOString() };
  atomicJson(path.join(output, 'qualification.json'), receipt);
  console.log(`QUALIFIED ${sourceSha} ${receipt.finishedAt}`);
} finally { await workspace.cleanup(); }
