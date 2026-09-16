import { expect, it } from 'vitest';
import { decodePublishProgress, encodePublishProgress, publishFailureAdvice } from '../../schema/src/publish-feedback';

const at = '2026-09-10T04:05:06.000Z';

it('round-trips progress while counting escaped JSON toward the existing storage limit', () => {
  const title = '检查'.repeat(400);
  const output = '\u0000\n"\\'.repeat(2000) + '最后一行';
  const encoded = encodePublishProgress(title, output, at);
  const result = decodePublishProgress(encoded)!;
  expect(encoded.length).toBeLessThanOrEqual(6000);
  expect(result.title).toBe(title.slice(0, 600));
  expect(result.output.length).toBeGreaterThan(0);
  expect(result.output.length).toBeLessThanOrEqual(4000);
  expect(output.endsWith(result.output)).toBe(true);
  expect(result.updatedAt).toBe(at);
  expect(decodePublishProgress(encodePublishProgress('当前检查', 'a'.repeat(5000), at))?.output).toBe('a'.repeat(4000));
  expect(decodePublishProgress(encodePublishProgress('', '', at))?.output).toBe('');
});

it('rejects invalid envelopes and preserves the old plain-text fallback', () => {
  const progress = JSON.parse(encodePublishProgress('检查', '<script>alert(1)</script>', at));
  for (const value of [null, undefined, '', '旧执行器正在检查', '{bad', 'null', '[]',
    JSON.stringify({ ...progress, version: 2 }), JSON.stringify({ ...progress, title: 123 }),
    JSON.stringify({ ...progress, output: null }), JSON.stringify({ ...progress, updatedAt: 'not-a-date' }),
    JSON.stringify({ ...progress, title: 'a'.repeat(601) }), JSON.stringify({ ...progress, output: 'a'.repeat(4001) })]) {
    expect(decodePublishProgress(value)).toBeNull();
  }
  expect(() => encodePublishProgress('检查', '', 'invalid')).toThrow(RangeError);
  expect(decodePublishProgress(JSON.stringify(progress))?.output).toBe('<script>alert(1)</script>');
});

it.each([
  ['test-dependency', "error TS2307: Cannot find module './text-layout-limits.json' in copy-advisory"],
  ['typecheck', 'error TS2345: Argument not assignable'],
  ['build', '控制台构建失败'], ['test', 'publisher 故障回归失败'],
  ['layout', '门未通过(render-fit): overflow'], ['copy', 'translation-stale 原文已更新'],
  ['timeout', 'command deadline exceeded'], ['network', 'fetch failed ECONNRESET'],
  ['identity', 'not-current-job'], ['unknown', 'something went wrong'],
])('gives bounded %s advice and retains the exact diagnostic text', (kind, raw) => {
  const advice = publishFailureAdvice(raw);
  expect(advice.kind).toBe(kind);
  expect(advice.reason).not.toBe(raw);
  expect(advice.suggestion.length).toBeGreaterThan(10);
  expect(advice.raw).toBe(raw);
});

it('does not mistake successful timeout and network tests for the failure cause', () => {
  const raw = '✔ command timeout leaves old live intact\n✓ network connection recovery passed\n# Subtest: command timeout\nok 4 - unauthorized retry\nerror TS2345: wrong argument type';
  expect(publishFailureAdvice(raw).kind).toBe('typecheck');
  expect(publishFailureAdvice(raw).raw).toBe(raw);
  expect(publishFailureAdvice('[verify] ✓ render-fit\n[verify] ✗ site-behavior\nmissing PDF link').kind).toBe('unknown');
  expect(publishFailureAdvice('命令超过最长执行时间 1800000ms，已停止本次发布').kind).toBe('timeout');
  for (const raw of ['发布服务中断或超时，草稿已保留，可重新发布。', 'The operation was aborted due to timeout']) {
    expect(publishFailureAdvice(raw).reason).toBe('发布执行中断或等待超时');
  }
});

it('separates progress and successful command records from terminal diagnostics', () => {
  const progress = '[verify] 开始检查：render-fit\n[publish-progress] {"detail":"正在检查：render-fit"}\n[verify] 结束检查：render-fit，耗时 3 秒，exit 0';
  const raw = `${progress}\n[verify] ✗ artifact-unchanged\nArtifact digest changed`;
  expect(publishFailureAdvice(raw).kind).toBe('unknown');
  expect(publishFailureAdvice(raw).raw).toBe(raw);
  expect(publishFailureAdvice('[verify] 结束检查：render-fit，耗时 3 秒，exit 2').kind).toBe('layout');
  expect(publishFailureAdvice(`${progress}\nerror TS2345: wrong argument type`).kind).toBe('typecheck');
  expect(publishFailureAdvice(encodePublishProgress('检查布局', 'network', at)).kind).toBe('unknown');
});

it.each(['执行器中断后恢复；原发布单不自动重跑', '执行器无响应'])('explains legacy interruption without assuming the live snapshot outcome: %s', raw => {
  const advice = publishFailureAdvice(raw);
  expect(advice.kind).toBe('interrupted');
  expect(advice.reason).toBe('发布执行器曾中断或失去响应');
  expect(advice.suggestion).toContain('连接恢复并核实本次执行结果');
  expect(advice.suggestion).toContain('重新检查并发布');
  expect(advice.suggestion).not.toMatch(/未切换|旧版未受影响|自动修改/);
  expect(advice.raw).toBe(raw);
});

it.each(['HTTP 500', 'HTTP 503', 'HTTP 599', 'fetch failed'])('keeps concrete network failures ahead of a legacy recovery note: %s', error => {
  const raw = `执行器中断后恢复；原发布单不自动重跑\n${error}`;
  const advice = publishFailureAdvice(raw);
  expect(advice.kind).toBe('network');
  expect(advice.suggestion).toContain('等待连接恢复并核实执行结果');
  expect(advice.raw).toBe(raw);
});
