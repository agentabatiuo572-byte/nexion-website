import { describe, expect, it } from 'vitest';
import { splitFailReason, failReasonLine } from '../src/lib/fail-reason';

describe('publish failure summaries', () => {
  it('keeps executor command logs out of all summary surfaces while preserving full details', () => {
    const reason = '门未通过(publisher-故障回归): > nexgrid-site-worker@0.1.0 test:publisher > node --test runner-tests/production-config.test.mjs';
    const result = splitFailReason(reason);
    expect(result.raw).toBe(true);
    expect(result.tech).toBe(reason);
    expect(failReasonLine(reason)).toBe('发布检查未通过，请查看详情中的失败原因');
  });
  it('preserves actionable content errors and their gate detail', () => {
    expect(splitFailReason('文案里有合规禁用词(门:forbidden-words)')).toEqual({ human: '文案里有合规禁用词', tech: 'forbidden-words', raw: false });
  });
  it('does not assume an English build error is unrelated to content', () => {
    const reason = 'Expected whitepaper title to match';
    expect(splitFailReason(reason)).toEqual({ human: '构建或检查未通过，请展开技术详情', tech: reason, raw: true });
  });
  it.each([
    '269.3814ms) ✔ 已完成检查\n✖ 发布器故障回归\nError: 无法读取完整当前源码清单\n摘要: ac580e8ae673c542be0b3a498f5deab0d4c6290147e4855befde5bcce78cd7e5',
    '269.3814ms) ✔ 已完成检查\r✖ 发布器故障回归\rError: 无法读取完整当前源码清单',
    `检查失败 ${'已完成检查 '.repeat(50)}(门:publisher)`,
  ])('keeps truncated, mixed-language or oversized logs out of shared summary surfaces', (reason) => {
    expect(splitFailReason(reason)).toEqual({ human: '构建或检查未通过，请展开技术详情', tech: reason, raw: true });
    expect(failReasonLine(reason)).toBe('构建或检查未通过，请展开技术详情');
  });
  it('preserves short Chinese reasons and extracts their hash details', () => {
    const reason = '内容摘要对不上:期望 ac580e8ae673c542,实际 80e1f4a84ab04567';
    expect(splitFailReason(reason)).toEqual({ human: '内容摘要对不上:期望 …,实际 …', tech: 'ac580e8ae673c542 · 80e1f4a84ab04567', raw: false });
    expect(failReasonLine('无法读取完整当前源码清单')).toBe('无法读取完整当前源码清单');
  });
});
