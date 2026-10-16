import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createWorkspace, runCommand, childEnvironment } from '../../worker/lib/runner-core.mjs';
import { runNpm, assertPublishedHomepages } from '../../worker/lib/runner-gates.mjs';

assert.equal(process.platform,'linux');
assert.equal(process.getuid(),10001);
assert.throws(()=>writeFileSync('/app/.readonly-probe','must not write'),/EROFS|EACCES/);
const workspace=await createWorkspace('/app',path.join(process.env.HOME,'preflight'));
try {
  const options={cwd:workspace.site,env:childEnvironment(),timeoutMs:180000,maxOutput:12000};
  const site=await runNpm(['run','build'],options);assert.equal(site.code,0,site.output);
  await assertPublishedHomepages(workspace.site);
  const admin=await runCommand(process.execPath,['node_modules/vite/bin/vite.js','build'],{...options,cwd:path.join(workspace.site,'admin')});assert.equal(admin.code,0,admin.output);
  console.log('PASS: non-root readonly container, isolated git workspace, real Astro content build and admin Vite build');
} finally { await workspace.cleanup(); }
