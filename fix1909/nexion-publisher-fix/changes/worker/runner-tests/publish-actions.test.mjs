import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createPublishRequestGate, preparePublishConfirmation, publishBlockReason } from '../../admin/src/lib/publish-actions.ts';
import { publishRequestBody } from '../../admin/src/lib/publish-contract.ts';

const pre = (fields = {}) => ({ ready: true, changed: 1, errors: [], draftRev: 7, ...fields });
const status = (fields = {}) => ({ activeVersion: null, executor: { ready: true, reason: '' }, versions: [{ id: 3, status: 'live' }], ...fields });

test('normal confirmation pins the freshly checked draft revision', () => {
  const confirmation = preparePublishConfirmation(pre({ draftRev: 23 }), status());
  assert.deepEqual(publishRequestBody(confirmation), { reason: '', draftRev: 23 });
});

test('zero content changes stay blocked on the normal publication path', () => {
  assert.match(publishBlockReason(pre({ ready: false, changed: 0 }), status()), /没有内容改动/);
  assert.throws(() => preparePublishConfirmation(pre({ ready: false, changed: 0 }), status()), /没有内容改动/);
});

test('zero changes allow an explicitly confirmed, fully checked snapshot rebuild', () => {
  const confirmation = preparePublishConfirmation(pre({ ready: false, changed: 0 }), status(), 'rebuild');
  assert.equal(confirmation.rebuild, true);
  assert.equal(confirmation.rollbackFrom, 3);
  assert(confirmation.reason.trim().length >= 8);
  assert.deepEqual(publishRequestBody(confirmation), { reason: confirmation.reason, fromVersion: 3 });
  assert.equal('draftRev' in publishRequestBody(confirmation), false);
  assert.equal('rebuild' in publishRequestBody(confirmation), false);
});

test('confirmation cannot silently change to a later live version', () => {
  const s = status();
  const confirmation = preparePublishConfirmation(pre({ ready: false, changed: 0 }), s, 'rebuild');
  s.versions[0].id = 50;
  assert.equal(publishRequestBody(confirmation).fromVersion, 3);
});

for (const intent of ['draft', 'rebuild']) {
  for (const [name, s, p, expected] of [
    ['active publication', status({ activeVersion: 9 }), pre(), /正在进行/],
    ['unverified switch', status({ versions: [{ id: 2, status: 'unknown' }] }), pre(), /尚未核实/],
    ['unready executor', status({ executor: { ready: false, reason: '服务配置未完成' } }), pre(), /服务配置未完成/],
    ['validation errors', status(), pre({ errors: [{ rule: 'missing-key' }] }), /前置检查问题/],
    ['config compatibility preparation', status(), pre({ message: '配置正在升级' }), /配置正在升级/],
  ]) {
    test(`${intent}: ${name} remains blocked`, () => {
      assert.match(publishBlockReason(p, s, intent), expected);
      assert.throws(() => preparePublishConfirmation(p, s, intent), expected);
    });
  }
}

test('rebuild cannot silently ignore nonempty draft changes', () => {
  assert.throws(() => preparePublishConfirmation(pre(), status(), 'rebuild'), /待发布的内容改动/);
});

test('rebuild without a live snapshot is rejected', () => {
  assert.throws(() => preparePublishConfirmation(pre({ ready: false, changed: 0 }), status({ versions: [] }), 'rebuild'), /没有可重新构建/);
});

test('normal publication without a draft revision still throws', () => {
  assert.throws(() => publishRequestBody({ reason: '' }), /missing-draft-revision/);
});

test('a newer snapshot request supersedes a stale load and an earlier status poll', () => {
  const gate = createPublishRequestGate();
  const poll = gate.current();
  const first = gate.begin();
  const second = gate.begin();
  assert.equal(gate.isCurrent(poll), false);
  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);
  gate.finish(first);
  assert.equal(gate.pending(), true);
  gate.finish(second);
  assert.equal(gate.pending(), false);
});

test('a full refresh blocks starting a poll until the current pair completes', () => {
  const gate = createPublishRequestGate();
  const ticket = gate.begin();
  assert.equal(gate.pending(), true);
  gate.finish(ticket);
  assert.equal(gate.pending(), false);
});

test('unmount or submit invalidates pending responses', () => {
  const gate = createPublishRequestGate();
  const ticket = gate.begin();
  gate.invalidate();
  assert.equal(gate.isCurrent(ticket), false);
  assert.equal(gate.pending(), false);
});

test('late asynchronous success and failure do not overwrite the latest pair', async () => {
  const gate = createPublishRequestGate();
  let settle;
  const oldResponse = new Promise(resolve => { settle = resolve; });
  let current;
  const oldTicket = gate.begin();
  const oldLoad = oldResponse.then(value => { if (gate.isCurrent(oldTicket)) current = value; });
  const newTicket = gate.begin();
  current = { draftRev: 9 };
  gate.finish(newTicket);
  settle({ draftRev: 2 });
  await oldLoad;
  assert.deepEqual(current, { draftRev: 9 });
  assert.equal(gate.isCurrent(oldTicket), false);
});

// Integration wiring assertions supplement (not replace) actual helper execution above.
test('main action rechecks, independent refresh exists, and stale confirmations cannot submit', () => {
  const page = readFileSync(new URL('../../admin/src/pages/publish.tsx', import.meta.url), 'utf8');
  assert.match(page, /disabled=\{unavailable \|\| !!blocked\} onClick=\{\(\) => void recheckAndConfirm\(\)\}/);
  assert.match(page, /disabled=\{busy \|\| refreshing\} onClick=\{load\}/);
  assert.match(page, /if \(!confirm \|\| acting.current \|\| refreshing \|\| failed \|\| pollFailed/);
  assert.match(page, /if \(requests.current.pending\(\)\) \{ retry\(\); return; \}/);
});
