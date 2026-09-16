// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({ api: vi.fn(), toast: vi.fn(), reload: vi.fn() }));
vi.mock('../src/api', () => ({ api: mocks.api, toast: mocks.toast, apiErrorHint: vi.fn(), ApiError: class extends Error {} }));
vi.mock('../src/shell', () => ({ useShell: () => ({ reload: mocks.reload }) }));
import PublishPage from '../src/pages/publish';
import { encodePublishProgress } from '../../schema/src/publish-feedback';
import { TranslationProvider } from '../src/lib/translations';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

it('refreshes current command progress and does not claim execution continues while polling fails', async () => {
  vi.useFakeTimers();
  let detail = '正在检查官网配置';
  let disconnected = false;
  mocks.api.mockImplementation(async (path: string) => {
    if (path.endsWith('/preflight')) return {
      ready: false, errors: [], warnings: [], changedPaths: [], changed: 0, sensitiveChanged: [], reasonRequired: false, draftRev: 1,
    };
    if (disconnected) throw new Error('network disconnected');
    return {
      activeVersion: 2, stepsOfVersion: 2,
      steps: [{ step: 'gates', status: 'running', detail, started_at: Date.now() - 5000, ended_at: null }],
      versions: [], stepNames: ['gates'], drift: null,
      executor: { ready: true, mode: 'local', reason: '', lastSeenAt: Date.now() },
    };
  });
  await act(async () => { render(<MemoryRouter><PublishPage /></MemoryRouter>); });
  expect(screen.getByText(detail)).toBeTruthy();
  detail = '正在检查页面布局';
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(screen.getByText(detail)).toBeTruthy();
  expect(screen.queryByText('正在检查官网配置')).toBeNull();
  disconnected = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(screen.getByText('暂时无法刷新发布状态，正在自动重试。恢复连接后将核实执行结果。')).toBeTruthy();
  expect(screen.queryByText(/发布任务继续在后台执行|服务持续报告运行状态/)).toBeNull();
  expect(screen.getByText(detail)).toBeTruthy();
  disconnected = false;
  detail = '正在核对页面链接';
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(screen.getByText(detail)).toBeTruthy();
  expect(screen.queryByText(/暂时无法刷新发布状态/)).toBeNull();
  expect(screen.getByText(/服务持续报告运行状态/)).toBeTruthy();
});

it('uses this job heartbeat for stale progress, refresh and recovery without writing or guessing cancellation', async () => {
  vi.useFakeTimers();
  let disconnected = false;
  let preflightUnavailable = false;
  let preflightPending: Promise<void> | undefined;
  const st = { ...status(), activeVersion: 2, silentMs: 0, cancelable: 'no', versions: [],
    executor: { ...status().executor, lastSeenAt: Date.now() } };
  st.steps[1] = { ...st.steps[1], status: 'running', ended_at: null,
    detail: encodePublishProgress('正在检查画布', '最后收到的输出', '2026-09-10T01:00:00.000Z') };
  st.executor.ready = false; // 草稿准备不代表本单失联。
  mocks.api.mockImplementation(async (path: string) => {
    if (path.endsWith('/preflight')) {
      if (preflightUnavailable) throw new Error('preflight temporarily unavailable');
      await preflightPending;
      return preflight();
    }
    if (disconnected) throw new Error('network disconnected');
    return { ...st };
  });
  await act(async () => { render(<MemoryRouter><PublishPage /></MemoryRouter>); });
  expect(screen.getByRole('heading', { name: '正在发布 v2' })).toBeTruthy();
  expect(screen.queryByText(/超过 1 分钟未报告心跳/)).toBeNull();
  st.executor.ready = true; st.executor.lastSeenAt = Date.now(); // 新空闲执行器不能掩盖旧单失联。
  st.silentMs = 60_000;
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(screen.getByRole('heading', { name: '发布状态待核实 v2' })).toBeTruthy();
  expect(screen.getByText(/超过 1 分钟未报告心跳/)).toBeTruthy();
  preflightUnavailable = true;
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '刷新状态' })); });
  expect(screen.getByText(/发布检查信息暂时无法刷新/)).toBeTruthy();
  expect(screen.getByRole('region', { name: '当前检查最近输出' }).textContent).toBe('最后收到的输出');
  expect(screen.getByRole('heading', { name: '发布状态待核实 v2' })).toBeTruthy();
  expect(screen.getByText('待核实')).toBeTruthy();
  expect(screen.queryByText(/服务持续报告运行状态/)).toBeNull();
  expect(screen.getByRole('region', { name: '当前检查最近输出' }).textContent).toBe('最后收到的输出');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '刷新状态' })); });
  expect(screen.getByText(/超过 1 分钟未报告心跳/)).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '中止本次发布' })); });
  expect(mocks.toast).toHaveBeenCalledWith('本次发布尚未满足安全中止条件，请等待状态核实后再试');
  st.cancelable = 'force';
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '中止本次发布' })); });
  expect(screen.getByText('强制中止 v2')).toBeTruthy();
  expect(mocks.api.mock.calls.every(call => !call[1]?.method)).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '返回' }));
  disconnected = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(screen.queryByText(/超过 1 分钟未报告心跳/)).toBeNull();
  expect(screen.getByText(/暂时无法刷新发布状态/)).toBeTruthy();
  disconnected = false; st.silentMs = 1000;
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(screen.getByRole('heading', { name: '正在发布 v2' })).toBeTruthy();
  expect(screen.queryByText(/超过 1 分钟未报告心跳|暂时无法刷新发布状态/)).toBeNull();
  preflightUnavailable = false;
  let finishPreflight!: () => void;
  preflightPending = new Promise<void>(resolve => { finishPreflight = resolve; });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试' })); });
  expect(screen.getByText(/发布检查信息暂时无法刷新/)).toBeTruthy();
  await act(async () => { finishPreflight(); });
  expect(screen.queryByText(/发布检查信息暂时无法刷新/)).toBeNull();
  expect(mocks.api.mock.calls.every(call => !call[1]?.method)).toBe(true);
});

it.each([
  'npm run verify:prod failed with exit code 2',
  `269.3814ms) ✔ 已完成检查\n${'✔ 发布器常规回归通过 (125.2345ms)\n'.repeat(100)}✖ 发布器故障回归\nError: 无法读取完整当前源码清单\n摘要: ac580e8ae673c542be0b3a498f5deab0d4c6290147e4855befde5bcce78cd7e5`,
])('keeps the last failure technical output collapsed without removing the full log or publish controls', async (raw) => {
  mocks.api.mockImplementation(async (path: string) => path.endsWith('/preflight') ? {
    ready: true, errors: [], warnings: [], changedPaths: [], changed: 0, sensitiveChanged: [], reasonRequired: false, draftRev: 1,
  } : {
    activeVersion: null, stepsOfVersion: 2, steps: [{ step: 'gates', status: 'failed', detail: 'Complete check output', started_at: 1, ended_at: 2 }],
    versions: [
      { id: 2, status: 'failed', fail_reason: raw, created_at: 2, created_by: 'admin', published_at: null, reason: null },
      { id: 1, status: 'live', fail_reason: null, created_at: 1, created_by: 'admin', published_at: 1, reason: null },
    ],
    stepNames: ['gates'], drift: null, executor: { ready: true, mode: 'local', reason: '', lastSeenAt: null },
  });
  render(<MemoryRouter><PublishPage /></MemoryRouter>);
  const oldFailure = await screen.findByText('v2 发布已停止');
  expect(oldFailure.closest('[role="alert"]')).toBeTruthy();
  expect(screen.getAllByText(/构建或检查未通过，请展开技术详情/)).toHaveLength(1);
  const logs = screen.getAllByText((_, element) => ['PRE', 'DIV'].includes(element?.tagName ?? '') && element?.textContent === raw);
  expect(logs).toHaveLength(1);
  for (const log of logs) expect(log.closest('details')?.open).toBe(false);
  const summary = await screen.findByText('查看失败技术详情');
  const details = summary.closest('details')!;
  const combinedRaw = `${raw}\nComplete check output`;
  expect(details.open).toBe(false);
  expect(details.querySelector('pre')?.textContent).toBe(combinedRaw);
  fireEvent.click(summary);
  expect(details.open).toBe(true);
  expect(details.querySelector('pre')?.textContent).toBe(combinedRaw);
  expect(screen.getByRole('button', { name: '查看原始日志' })).toBeTruthy();
  expect(screen.getByText(/当前能否发布以下方检查为准/)).toBeTruthy();
  expect(screen.getByRole('button', { name: '检查并发布' })).toBeTruthy();
});

it('groups every changed field and separates system compatibility from editable content errors', async () => {
  const paths = [...Array.from({ length: 34 }, (_, i) => `copy.en.hero.line${i}`), 'downloads.ios.url'];
  mocks.api.mockImplementation(async (path: string) => path.endsWith('/preflight') ? {
    ready: false, errors: [
      { path: 'copy.en.trust.whitepaper.download', rule: 'unknown-key', message: '字段已经退役' },
      { path: 'downloads.ios.url', rule: 'url', message: '须为 HTTPS 链接' },
    ], warnings: [], changedPaths: paths, changed: paths.length, sensitiveChanged: ['downloads.ios.url'], reasonRequired: true, draftRev: 2,
  } : {
    activeVersion: null, stepsOfVersion: null, steps: [], versions: [], stepNames: [], drift: null,
    executor: { ready: true, mode: 'local', reason: '', lastSeenAt: null },
  });
  render(<MemoryRouter><PublishPage /></MemoryRouter>);
  const group = await screen.findByText('首屏 Hero · 34 处');
  expect(group.closest('details')?.open).toBe(false);
  fireEvent.click(group);
  for (const path of paths) expect(screen.getAllByText(path).length).toBeGreaterThan(0);
  const links = screen.getAllByRole('link', { name: '去修复' });
  expect(links).toHaveLength(1);
  expect(links[0].getAttribute('href')).toContain('downloads');
  expect(screen.getByText(/需要发布服务完成配置兼容处理/)).toBeTruthy();
});

it('keeps unknown outcomes blocked across publish, rollback and realignment', async () => {
  mocks.api.mockImplementation(async (path: string) => path.endsWith('/preflight') ? {
    ready: false, message: '草稿正在同步新版配置', errors: [{ path: '$', rule: 'structure', message: '等待准备' }], warnings: [], changedPaths: [], changed: 0,
    sensitiveChanged: [], reasonRequired: false, draftRev: 2,
  } : {
    activeVersion: null, stepsOfVersion: null, steps: [], stepNames: [], drift: { dbLive: 2, snapshot: 3 },
    versions: [{ id: 3, status: 'unknown' }, { id: 2, status: 'live' }, { id: 1, status: 'archived' }].map(v => ({ ...v, created_at: 1, published_at: 1, created_by: 'admin', reason: null, fail_reason: null })),
    executor: { ready: true, mode: 'local', reason: '', lastSeenAt: null },
  });
  render(<MemoryRouter><PublishPage /></MemoryRouter>);
  await screen.findByText('发布前检查');
  expect(screen.queryByText(/没有待发布的改动/)).toBeNull();
  for (const name of ['检查并发布', '回滚到此版', '重新发布 v2 以对齐']) {
    expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
  }
});

const preflight = (draftRev = 8) => ({ ready: true, errors: [] as { path: string; rule: string; message: string }[], warnings: [],
  changedPaths: ['copy.en.hero.line1'], changed: 1, sensitiveChanged: [], reasonRequired: false, draftRev });
const status = () => ({ activeVersion: null as number | null, stepsOfVersion: 2,
  steps: [{ step: 'materialize', status: 'ok', detail: null as string | null, started_at: 1, ended_at: 2 as number | null },
    { step: 'gates', status: 'failed', detail: "TS2307: Cannot find module 'text-layout-limits.json'", started_at: 2, ended_at: 3 as number | null }],
  versions: [{ id: 2, status: 'failed', fail_reason: '发布检查未通过', created_at: 2, created_by: 'admin', published_at: null as number | null, reason: null },
    { id: 1, status: 'live', fail_reason: null as string | null, created_at: 1, created_by: 'admin', published_at: 1 as number | null, reason: null }],
  stepNames: ['materialize', 'gates', 'build', 'swap'], drift: null,
  executor: { ready: true, mode: 'local', reason: '', lastSeenAt: null },
});

it('refreshes structured output and timestamp, counts completed steps, and renders log text safely', async () => {
  vi.useFakeTimers();
  const st = status(); st.activeVersion = 2; st.versions = [];
  st.steps[1] = { ...st.steps[1], status: 'running', ended_at: null,
    detail: encodePublishProgress('检查文案', '<img src=x onerror=alert(1)> 第一行', '2026-09-10T04:05:06.000Z') };
  mocks.api.mockImplementation(async (path: string) => path.endsWith('/preflight') ? preflight() : { ...st });
  await act(async () => { render(<MemoryRouter><PublishPage /></MemoryRouter>); });
  expect(screen.getByText('已完成 1 / 4 个步骤')).toBeTruthy();
  const output = screen.getByRole('region', { name: '当前检查最近输出' });
  expect(output.textContent).toContain('<img src=x onerror=alert(1)>');
  expect(output.querySelector('img')).toBeNull();
  expect(output.style.maxHeight).toBe('220px');
  expect(document.querySelector('time')?.dateTime).toBe('2026-09-10T04:05:06.000Z');
  st.steps[1].detail = encodePublishProgress('检查布局', '第二行', '2026-09-10T04:05:11.000Z');
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(screen.getByText('检查布局')).toBeTruthy();
  expect(output.textContent).toBe('第二行');
  expect(document.querySelector('time')?.dateTime).toBe('2026-09-10T04:05:11.000Z');
});

it('stops showing waiting steps on failure and rechecks before confirming a fresh draft revision', async () => {
  vi.useFakeTimers();
  const st = status(); st.activeVersion = 2; st.steps[1].status = 'running';
  let revision = 8;
  mocks.api.mockImplementation(async (path: string) => path.endsWith('/preflight') ? preflight(revision) : { ...st });
  await act(async () => { render(<MemoryRouter><PublishPage /></MemoryRouter>); });
  expect(screen.getAllByText('等待')).toHaveLength(2);
  st.activeVersion = null; st.steps[1].status = 'failed';
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(screen.getByText('v2 发布已停止')).toBeTruthy();
  expect(screen.queryByText('等待')).toBeNull();
  expect(screen.getByText('本次任务已停止，不会继续执行后续步骤。')).toBeTruthy();
  expect(screen.getByText(/发布自检缺少文案检查依赖/)).toBeTruthy();
  expect(screen.getByText(/维护人员需补齐隔离测试副本/)).toBeTruthy();
  revision = 12;
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重新检查并发布' })); });
  expect(mocks.api.mock.calls.filter(([path]) => path === '/api/publish')).toHaveLength(0);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '确认', exact: true })); });
  const call = mocks.api.mock.calls.find(([path]) => path === '/api/publish')!;
  expect(JSON.parse(call[1].body)).toEqual({ reason: '', draftRev: 12 });
});

it('hides the old failure after a newer success while retaining its history log', async () => {
  const st = status();
  st.versions.unshift({ ...st.versions[1], id: 3, created_at: 3, published_at: 3 });
  st.versions[2].status = 'archived';
  mocks.api.mockImplementation(async (path: string) => path.endsWith('/preflight') ? preflight() : st);
  render(<MemoryRouter><PublishPage /></MemoryRouter>);
  await screen.findByRole('button', { name: '检查并发布' });
  expect(screen.queryByText('v2 发布已停止')).toBeNull();
  expect(screen.queryByRole('button', { name: '重新检查并发布' })).toBeNull();
  expect(screen.getByText('发布检查未通过')).toBeTruthy();
});

it('uses the existing one-click missing translation action without publishing', async () => {
  vi.useFakeTimers();
  let missing = true;
  let revision = 8;
  mocks.api.mockImplementation(async (path: string, options?: RequestInit) => {
    if (path === '/api/translations') return options?.method === 'POST' ? { queued: 1 }
      : { draftRev: revision, counts: {}, states: [], items: [], nextCursor: null };
    if (path.endsWith('/preflight')) return { ...preflight(revision), ready: !missing,
      errors: missing ? [{ path: 'copy.vi.hero.line1', rule: 'untranslated', message: '缺少译文' }] : [] };
    return { ...status(), versions: [] };
  });
  await act(async () => { render(<MemoryRouter><TranslationProvider draftRevision={8} onDraftChanged={mocks.reload}><PublishPage /></TranslationProvider></MemoryRouter>); });
  const button = screen.getByRole('button', { name: '一键补译缺项' });
  const link = screen.getByRole('link', { name: '去修复' });
  expect(link.getAttribute('href')).toContain('focus=copy.vi.hero.line1');
  await act(async () => { fireEvent.click(button); });
  const call = mocks.api.mock.calls.find(([path, options]) => path === '/api/translations' && options?.method === 'POST')!;
  expect(JSON.parse(call[1].body)).toEqual({ mode: 'missing' });
  expect((screen.getByRole('button', { name: '检查并发布' }) as HTMLButtonElement).disabled).toBe(true);
  missing = false; revision = 9;
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect((screen.getByRole('button', { name: '检查并发布' }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.queryByText('缺少译文')).toBeNull();
  expect(mocks.api.mock.calls.filter(([path]) => path === '/api/publish')).toHaveLength(0);
  expect(mocks.reload).toHaveBeenCalled();
});
