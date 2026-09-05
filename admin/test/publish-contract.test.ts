import { describe, expect, it } from 'vitest';
import { publishRequestBody } from '../src/lib/publish-contract';

describe('publish request identity', () => {
  it('binds a normal publish to the draft revision shown at confirmation', () => {
    expect(publishRequestBody({ reason: '发布新版内容', draftRev: 17 })).toEqual({ reason: '发布新版内容', draftRev: 17 });
  });

  it('keeps rollback independent of the current draft revision', () => {
    expect(publishRequestBody({ reason: '恢复稳定版本', rollbackFrom: 8 })).toEqual({ reason: '恢复稳定版本', fromVersion: 8 });
  });

  it('fails closed when a normal publish has no draft identity', () => {
    expect(() => publishRequestBody({ reason: '缺少版本' })).toThrow('missing-draft-revision');
  });
});
