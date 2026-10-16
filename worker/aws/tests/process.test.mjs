import test from 'node:test';
import assert from 'node:assert/strict';
import { processAlive, processIdentity } from '../../lib/runner-core.mjs';

test('process identity distinguishes a recycled Linux container PID from the former owner',()=>{
  assert.equal(processAlive(process.pid),true);
  assert.equal(processAlive(-1),null);
  const identity=processIdentity(process.pid);
  if(process.platform==='linux'){
    assert.match(identity,/^[a-f0-9-]+:\d+$/);
    assert.equal(processAlive(process.pid,identity),true);
    assert.equal(processAlive(process.pid,'another-boot:0'),false);
  } else assert.equal(identity,null);
});
