import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { activateRelease } from '../release.mjs';
import { directoryDigest } from '../../lib/runner-artifacts.mjs';
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(),'uvel-aws-release-'));const source=path.join(root,'dist-live');mkdirSync(source);
  writeFileSync(path.join(source,'index.html'),'Verified new site'); const digest=directoryDigest(source);
  writeFileSync(path.join(source,'.publish-stamp.json'),JSON.stringify({versionId:2,stamp:'private-lease',artifact:digest}));
  return {root,source,versionId:2,expectedSha:digest.sha256,minimumFreeBytes:0,authorize:async()=>{}};
}
test('a revoked lease cannot create or replace current',async()=>{const f=fixture();await assert.rejects(activateRelease({...f,authorize:async()=>{throw new Error('lease-lost')}}),/lease-lost/);assert.equal(existsSync(path.join(f.root,'current')),false);});
test('changed artifact cannot be activated',async()=>{const f=fixture();writeFileSync(path.join(f.source,'index.html'),'tampered');await assert.rejects(activateRelease(f),/产物内容已变化/);assert.equal(existsSync(path.join(f.root,'current')),false);});
test('mismatched stamp cannot be activated',async()=>{const f=fixture();await assert.rejects(activateRelease({...f,versionId:3}),/stamp mismatch/);});
test('low disk space fails before activation',async()=>{const f=fixture();await assert.rejects(activateRelease({...f,minimumFreeBytes:Number.MAX_SAFE_INTEGER}),/disk space/);});
test(process.platform === 'win32' ? 'Windows without symlink privilege refuses activation (Linux success is tested on AWS)' : 'activation atomically moves current and preserves previous complete releases',async()=>{
  if (process.platform === 'win32') { const f=fixture(); await assert.rejects(activateRelease(f), /EPERM/); assert.equal(existsSync(path.join(f.root,'current')),false); return; }
  const f=fixture();const first=await activateRelease(f);assert.equal(readFileSync(path.join(f.root,'current/index.html'),'utf8'),'Verified new site');
  writeFileSync(path.join(f.source,'index.html'),'Second verified site');const digest=directoryDigest(f.source);writeFileSync(path.join(f.source,'.publish-stamp.json'),JSON.stringify({versionId:3,stamp:'second-private',artifact:digest}));
  const second=await activateRelease({...f,versionId:3,expectedSha:digest.sha256});assert.notEqual(first.release,second.release);assert.equal(realpathSync(path.join(f.root,'current')),realpathSync(second.release));assert.equal(readFileSync(path.join(first.release,'index.html'),'utf8'),'Verified new site');
});
