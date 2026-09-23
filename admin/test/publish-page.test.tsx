// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({ api: vi.fn(), toast: vi.fn(), reload: vi.fn() }));
vi.mock('../src/api', () => ({ api: mocks.api, toast: mocks.toast, apiErrorHint: vi.fn(), ApiError: class extends Error {} }));
vi.mock('../src/shell', () => ({ useShell: () => ({ reload: mocks.reload }) }));
import PublishPage, { normalizeCheckTitle } from '../src/pages/publish';
import { encodePublishProgress, groupPublishChecks } from '../../schema/src/publish-feedback';
import { TranslationProvider } from '../src/lib/translations';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

it('keeps the last valid progress when a poll returns an incomplete success body', async () => {
  vi.useFakeTimers();
  let detail = '正在检查官网配置';
  let disconnected = false;
  mocks.api.mockImplementation(async (path: string) => {
    if (path.endsWith('/preflight')) return {
      ready: false, errors: [], warnings: [], changedPaths: [], changed: 0, sensitiveChanged: [], reasonRequired: false, draftRev: 1,
    };
    if (disconnected) return { versions: [], steps: [], executor: { ready: true } };
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

it('keeps the last valid preflight when refresh receives a partial success body', async () => {
  let incomplete = false;
  mocks.api.mockImplementation(async (path: string) => path.endsWith('/preflight')
    ? incomplete ? { errors: [], warnings: [] } : preflight()
    : status());
  await act(async () => { render(<MemoryRouter><PublishPage /></MemoryRouter>); });
  expect(screen.getByText('查看 1 个模块的改动摘要')).toBeTruthy();

  incomplete = true;
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重新检查' })); });
  expect(screen.getByText(/发布检查信息暂时无法刷新/)).toBeTruthy();
  expect(screen.getByText('查看 1 个模块的改动摘要')).toBeTruthy();
  expect((screen.getByRole('button', { name: '检查并发布' }) as HTMLButtonElement).disabled).toBe(true);

  incomplete = false;
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试' })); });
  expect(screen.queryByText(/发布检查信息暂时无法刷新/)).toBeNull();
  expect((screen.getByRole('button', { name: '检查并发布' }) as HTMLButtonElement).disabled).toBe(false);
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
  expect(screen.getAllByText('待核实').length).toBeGreaterThan(0);
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
  expect(screen.getByRole('heading', { name: '最近一次执行失败 · v2' })).toBeTruthy();
  expect(screen.getByText('执行失败')).toBeTruthy();
  const logButton = screen.getByRole('button', { name: '查看原始日志' });
  expect(logButton.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(logButton);
  expect(screen.getByRole('button', { name: '收起' }).getAttribute('aria-expanded')).toBe('true');
  expect(document.getElementById('publish-failure-log')?.textContent).toBe('Complete check output');
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
  const summary = await screen.findByText('查看 2 个模块的改动摘要');
  expect(summary.closest('details')?.open).toBe(false);
  fireEvent.click(summary);
  expect(screen.getByText('首屏 Hero')).toBeTruthy();
  expect(screen.getByText('34 处')).toBeTruthy();
  expect(screen.getByText(/另 31 处/)).toBeTruthy();
  const action = screen.getByRole('link', { name: '修复 2 项阻断问题' });
  expect(action.getAttribute('href')).toContain('downloads');
  expect(screen.getByText(/由发布服务处理配置兼容/)).toBeTruthy();
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
  await screen.findByText('发布准备');
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
  expect(document.querySelector('time[datetime="2026-09-10T04:05:06.000Z"]')).toBeTruthy();
  st.steps[1].detail = encodePublishProgress('检查布局', '第二行', '2026-09-10T04:05:11.000Z');
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(screen.getByText('检查布局')).toBeTruthy();
  expect(output.textContent).toBe('第二行');
  expect(document.querySelector('time[datetime="2026-09-10T04:05:11.000Z"]')).toBeTruthy();
});

it('stops showing waiting steps on failure and rechecks before confirming a fresh draft revision', async () => {
  vi.useFakeTimers();
  const st = status(); st.activeVersion = 2; st.steps[1].status = 'running';
  let revision = 8;
  mocks.api.mockImplementation(async (path: string) => path.endsWith('/preflight') ? preflight(revision) : { ...st });
  await act(async () => { render(<MemoryRouter><PublishPage /></MemoryRouter>); });
  expect(screen.getAllByText('等待')).toHaveLength(1);
  st.activeVersion = null; st.steps[1].status = 'failed';
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(screen.getByText('v2 发布已停止')).toBeTruthy();
  expect(screen.queryByText('等待')).toBeNull();
  expect(screen.getByText('本次任务已停止，不会继续执行后续步骤。')).toBeTruthy();
  expect(screen.getByText(/发布自检缺少文案检查依赖/)).toBeTruthy();
  expect(screen.getByText(/维护人员需补齐隔离测试副本/)).toBeTruthy();
  revision = 12;
  const recheckButton = screen.getByRole('button', { name: '重新检查并发布' });
  recheckButton.focus();
  await act(async () => { fireEvent.click(recheckButton); });
  expect(mocks.api.mock.calls.filter(([path]) => path === '/api/publish')).toHaveLength(0);
  const dialog = screen.getByRole('dialog', { name: '确认发布 1 处改动?' });
  expect(dialog).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: '确认发布 1 处改动?' }));
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(document.activeElement).toBe(recheckButton);
  await act(async () => { fireEvent.click(recheckButton); });
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

it('replaces a blocked publish button with one clear translation action and refreshes when work completes', async () => {
  vi.useFakeTimers();
  let missing = true;
  let revision = 8;
  mocks.api.mockImplementation(async (path: string, options?: RequestInit) => {
    if (path === '/api/translations') return options?.method === 'POST' ? { queued: 1 }
      : { draftRev: revision, counts: { pending: 2 }, states: [], items: [], nextCursor: null };
    if (path.endsWith('/preflight')) return { ...preflight(revision), ready: !missing,
      errors: missing ? [{ path: 'copy.vi.hero.line1', rule: 'untranslated', message: '缺少译文' }] : [] };
    return { ...status(), versions: [] };
  });
  await act(async () => { render(<MemoryRouter><TranslationProvider draftRevision={8} onDraftChanged={mocks.reload}><PublishPage /></TranslationProvider></MemoryRouter>); });
  const action = screen.getByRole('link', { name: '处理 1 项译文' });
  expect(action.getAttribute('href')).toBe('/ai#translation-tasks');
  expect(screen.getByText('当前 1 项阻断；队列另有 1 项待处理内容，共 2 项。')).toBeTruthy();
  expect(screen.getByRole('link', { name: '定位字段' }).getAttribute('href')).toContain('focus=copy.vi.hero.line1');
  expect(screen.queryByRole('button', { name: '检查并发布' })).toBeNull();
  expect(mocks.api.mock.calls.some(([path, options]) => path === '/api/translations' && options?.method === 'POST')).toBe(false);
  missing = false; revision = 9;
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect((screen.getByRole('button', { name: '检查并发布' }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.queryByText('缺少译文')).toBeNull();
  expect(mocks.api.mock.calls.filter(([path]) => path === '/api/publish')).toHaveLength(0);
  expect(mocks.reload).toHaveBeenCalled();
});

it('keeps the blocker repair action available during a transient status poll failure', async () => {
  vi.useFakeTimers();
  let statusOffline = false;
  mocks.api.mockImplementation(async (path: string) => {
    if (path === '/api/translations') return { draftRev: 8, counts: {}, states: [], items: [], nextCursor: null };
    if (path.endsWith('/preflight')) return { ...preflight(), ready: false,
      errors: [{ path: 'copy.vi.hero.line1', rule: 'translation-stale', message: '原文已更新，译文尚未更新' }] };
    if (statusOffline) throw new Error('network disconnected');
    return { ...status(), versions: [] };
  });
  await act(async () => { render(<MemoryRouter><TranslationProvider draftRevision={8} onDraftChanged={mocks.reload}><PublishPage /></TranslationProvider></MemoryRouter>); });
  statusOffline = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(screen.getByText(/暂时无法刷新发布状态/)).toBeTruthy();
  expect(screen.getByRole('link', { name: '处理 1 项译文' }).getAttribute('href')).toBe('/ai#translation-tasks');
  expect(screen.queryByRole('button', { name: '检查并发布' })).toBeNull();
});

it('collapses non-blocking reminders into rule groups instead of listing every field', async () => {
  const warnings = [
    ...Array.from({ length: 9 }, (_, i) => ({ path: `seo.home.title.${i % 2 ? 'vi' : 'en'}`, rule: 'seo-length', message: '标题过长' })),
    ...Array.from({ length: 8 }, (_, i) => ({ path: `copy.${i % 2 ? 'vi' : 'en'}.social.line${i}`, rule: 'newline-shape', message: '换行结构不同' })),
  ];
  mocks.api.mockImplementation(async (path: string) => path.endsWith('/preflight') ? { ...preflight(), warnings } : { ...status(), versions: [] });
  render(<MemoryRouter><PublishPage /></MemoryRouter>);
  const summary = await screen.findByText('非阻断提醒 · 17');
  const details = summary.closest('details')!;
  expect(details.open).toBe(false);
  expect(summary.parentElement?.textContent).toContain('SEO 长度 9');
  expect(summary.parentElement?.textContent).toContain('换行结构 8');
  expect(details.querySelectorAll('.publish-summary-row')).toHaveLength(2);
});

it('renders grouped check details with Chinese badges and collapsible failure output', async () => {
  const st = status(); st.activeVersion = 2; st.versions = [];
  (st as unknown as Record<string, unknown>).checksOfVersion = 2;
  (st as unknown as Record<string, unknown>).checks = [
    { version_id: 2, step: 'gates', seq: 3, title: 'jsonc-reader-红测', status: 'ok', output: null, started_at: 3, ended_at: 4 },
    { version_id: 2, step: 'gates', seq: 2, title: 'i18n-parity', status: 'ok', output: null, started_at: 2, ended_at: 3 },
    { version_id: 2, step: 'gates', seq: 1, title: 'forbidden-words', status: 'failed', output: '第 3 行有禁用词', started_at: 1, ended_at: 2 },
    { version_id: 2, step: 'materialize', seq: 0, title: '快照锁定', status: 'running', output: null, started_at: 1, ended_at: null },
    { version_id: 2, step: 'gates', seq: 4, title: 'canvas-geometry', status: 'running', output: null, started_at: 4, ended_at: null },
  ];
  mocks.api.mockImplementation(async (path: string) => path.endsWith('/preflight') ? preflight() : { ...st });
  render(<MemoryRouter><PublishPage /></MemoryRouter>);
  expect(await screen.findByRole('region', { name: '检查明细' })).toBeTruthy();
  expect(screen.getByRole('progressbar', { name: '检查完成进度' }).getAttribute('aria-valuenow')).toBe('3');
  expect(screen.getByText('已完成 3 / 5 项 · 2 通过 · 1 失败')).toBeTruthy();
  const window = screen.getByRole('region', { name: '当前检查窗口' });
  expect(window.querySelectorAll('[data-publish-check-row]')).toHaveLength(3);
  expect(window.textContent).toContain('画布几何检查');
  expect(window.textContent).not.toContain('合规禁用词检查');
  const all = screen.getByText('查看全部 5 项检查');
  fireEvent.click(all);
  expect(screen.getByText('合规禁用词检查')).toBeTruthy();
  expect(screen.queryByText('forbidden-words')).toBeNull();
  expect(screen.getAllByText('配置读取检查').length).toBeGreaterThan(0);
  expect(screen.queryByText('jsonc-reader-红测')).toBeNull();
  const summary = screen.getByText('查看失败原文');
  fireEvent.click(summary);
  expect(summary.closest('details')?.querySelector('pre')?.textContent).toBe('第 3 行有禁用词');
  expect(screen.getByRole('button', { name: '重新发布' })).toBeTruthy();
});

it('shows interrupted historical checks as stopped without counting them as complete', async () => {
  const st = status();
  st.stepsOfVersion = 33;
  st.steps = [{ step: 'gates', status: 'failed', detail: '执行器中断', started_at: 1, ended_at: 2 }];
  st.versions = [{ ...st.versions[0], id: 33, status: 'failed', fail_reason: '执行器中断', created_at: 33 }];
  const checks = [
    ...Array.from({ length: 17 }, (_, index) => ({ version_id: 33, step: 'gates', seq: index + 1,
      title: `检查 ${index + 1}`, status: 'ok', output: null, started_at: 1, ended_at: 2 })),
    { version_id: 33, step: 'gates', seq: 18, title: 'worker-types', status: 'running', output: null, started_at: 2, ended_at: null },
    { version_id: 33, step: 'gates', seq: 19, title: 'publisher-故障回归', status: 'running', output: null, started_at: 2, ended_at: null },
  ];
  mocks.api.mockImplementation(async (path: string) => path.endsWith('/preflight') ? preflight() :
    { ...st, checksOfVersion: 33, checks });
  render(<MemoryRouter><PublishPage /></MemoryRouter>);

  const progress = await screen.findByRole('progressbar', { name: '检查完成进度' });
  expect(progress.getAttribute('aria-valuenow')).toBe('17');
  expect(screen.getByText('已完成 17 / 19 项 · 17 通过')).toBeTruthy();
  const window = screen.getByRole('region', { name: '当前检查窗口' });
  const publisher = [...window.querySelectorAll('[data-publish-check-row]')].find(row => row.textContent?.includes('发布器回归检查'));
  expect(publisher?.getAttribute('data-state')).toBe('unknown');
  expect(publisher?.textContent).toContain('已停止/待核实');
  expect(window.textContent).not.toContain('进行中');
  fireEvent.click(screen.getByText('查看全部 19 项检查'));
  const allPublisher = [...document.querySelectorAll('.publisher-all-check-row')].find(row => row.textContent?.includes('发布器回归检查'));
  expect(allPublisher?.getAttribute('data-state')).toBe('unknown');
  expect(allPublisher?.textContent).toContain('已停止/待核实');
});

it('keeps matching checks running while their publication is live', async () => {
  const st = status(); st.activeVersion = 33; st.stepsOfVersion = 33;
  st.steps = [{ step: 'gates', status: 'running', detail: null, started_at: 1, ended_at: null }];
  st.versions = [{ ...st.versions[0], id: 33, status: 'publishing', fail_reason: null, created_at: 33 }];
  const checks = [{ version_id: 33, step: 'gates', seq: 1, title: 'publisher-故障回归', status: 'running',
    output: null, started_at: 1, ended_at: null }];
  mocks.api.mockImplementation(async (path: string) => path.endsWith('/preflight') ? preflight() :
    { ...st, checksOfVersion: 33, checks });
  render(<MemoryRouter><PublishPage /></MemoryRouter>);

  const window = await screen.findByRole('region', { name: '当前检查窗口' });
  const publisher = window.querySelector('[data-publish-check-row]');
  expect(publisher?.getAttribute('data-state')).toBe('running');
  expect(publisher?.textContent).toContain('进行中');
  expect(screen.queryByText('已停止/待核实')).toBeNull();
  expect(screen.getByRole('progressbar', { name: '检查完成进度' }).getAttribute('aria-valuenow')).toBe('0');
});

it('treats an unknown version as uncertain while its same-version lock and swap rows remain running', async () => {
  const st = status(); st.activeVersion = 33; st.stepsOfVersion = 33;
  st.steps = [{ step: 'swap', status: 'running', detail: null, started_at: 1, ended_at: null }];
  st.versions = [{ ...st.versions[0], id: 33, status: 'unknown', fail_reason: null, created_at: 33 }];
  let checks = [{ version_id: 33, step: 'swap', seq: 1, title: 'publisher-故障回归', status: 'running',
    output: null, started_at: 1, ended_at: null }];
  mocks.api.mockImplementation(async (path: string) => path.endsWith('/preflight') ? preflight() :
    { ...st, checksOfVersion: 33, checks });
  render(<MemoryRouter><PublishPage /></MemoryRouter>);

  expect(await screen.findByRole('heading', { name: '发布状态待核实 v33' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: '正在发布 v33' })).toBeNull();
  expect(screen.getByText('结果待核实')).toBeTruthy();
  expect(screen.queryByText(/服务持续报告运行状态/)).toBeNull();
  expect(screen.queryByRole('button', { name: '中止本次发布' })).toBeNull();
  expect(document.querySelector('[aria-label="切换新版并核验：待核实"]')?.getAttribute('data-state')).toBe('unknown');
  const row = screen.getByRole('region', { name: '当前检查窗口' }).querySelector('[data-publish-check-row]');
  expect(row?.getAttribute('data-state')).toBe('unknown');
  expect(row?.textContent).toContain('已停止/待核实');
  expect(screen.getByRole('progressbar', { name: '检查完成进度' }).getAttribute('aria-valuenow')).toBe('0');
  fireEvent.click(screen.getByText('查看全部 1 项检查'));
  expect(document.querySelector('.publisher-all-check-row')?.textContent).toContain('已停止/待核实');

  checks = [];
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '刷新发布状态' })); });
  const legacy = [...screen.getByRole('region', { name: '当前检查窗口' }).querySelectorAll('[data-publish-check-row]')]
    .find(row => row.textContent?.includes('切换新版并核验'));
  expect(legacy?.getAttribute('data-state')).toBe('unknown');
  expect(legacy?.textContent).toContain('待核实');
  expect(screen.queryByText(/检查明细稍后出现/)).toBeNull();

  st.activeVersion = null;
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '刷新发布状态' })); });
  expect(document.querySelector('[aria-label="切换新版并核验：待核实"]')?.getAttribute('data-state')).toBe('unknown');
  expect(screen.getByRole('region', { name: '当前检查窗口' }).textContent).toContain('待核实');
  expect(screen.queryByRole('heading', { name: '正在发布 v33' })).toBeNull();
});

it('stops an unfinished check from a completed step while the next step runs', async () => {
  const st = status(); st.activeVersion = 33; st.stepsOfVersion = 33;
  st.steps = [
    { step: 'gates', status: 'ok', detail: null, started_at: 1, ended_at: 2 },
    { step: 'build', status: 'running', detail: null, started_at: 2, ended_at: null },
  ];
  st.versions = [{ ...st.versions[0], id: 33, status: 'publishing', fail_reason: null, created_at: 33 }];
  const checks = [
    { version_id: 33, step: 'gates', seq: 1, title: 'publisher-故障回归', status: 'running', output: null, started_at: 1, ended_at: null },
    { version_id: 33, step: 'build', seq: 2, title: 'site-build', status: 'running', output: null, started_at: 2, ended_at: null },
  ];
  mocks.api.mockImplementation(async (path: string) => path.endsWith('/preflight') ? preflight() :
    { ...st, checksOfVersion: 33, checks });
  render(<MemoryRouter><PublishPage /></MemoryRouter>);

  const window = await screen.findByRole('region', { name: '当前检查窗口' });
  const [finishedStepCheck, liveStepCheck] = window.querySelectorAll('[data-publish-check-row]');
  expect(finishedStepCheck.getAttribute('data-state')).toBe('unknown');
  expect(finishedStepCheck.textContent).toContain('已停止/待核实');
  expect(liveStepCheck.getAttribute('data-state')).toBe('running');
  expect(liveStepCheck.textContent).toContain('进行中');
});

it('keeps the legacy step window when checks are empty and shows a retry placeholder', async () => {
  const st = status(); st.activeVersion = 2; st.versions = [];
  (st as unknown as Record<string, unknown>).checksOfVersion = 2;
  (st as unknown as Record<string, unknown>).checks = [];
  mocks.api.mockImplementation(async (path: string) => path.endsWith('/preflight') ? preflight() : { ...st });
  render(<MemoryRouter><PublishPage /></MemoryRouter>);
  expect(await screen.findByText('已完成 1 / 4 个步骤')).toBeTruthy();
  expect(screen.getByRole('region', { name: '发布执行控制台' })).toBeTruthy();
  expect(screen.getByText('检查明细稍后出现。门级检查开始后，这里会按分组列出每一项结果。')).toBeTruthy();
  expect(screen.getByRole('button', { name: '重新加载明细' })).toBeTruthy();
  expect(screen.getByRole('region', { name: '检查明细' })).toBeTruthy();
});

it('counts skipped checks as complete and fills the progress bar', async () => {
  const st = status(); st.activeVersion = null;
  st.steps = st.stepNames.map((step, index) => ({ step, status: 'ok', detail: null, started_at: index + 1, ended_at: index + 2 }));
  st.versions = [{ ...st.versions[1], id: 2, status: 'live', created_at: 2, published_at: 2 }];
  (st as unknown as Record<string, unknown>).checksOfVersion = 2;
  (st as unknown as Record<string, unknown>).checks = [
    { version_id: 2, step: 'gates', seq: 1, title: 'site-build', status: 'ok', output: null, started_at: 1, ended_at: 2 },
    { version_id: 2, step: 'gates', seq: 2, title: 'canvas-geometry', status: 'skipped', output: null, started_at: 2, ended_at: 3 },
  ];
  mocks.api.mockImplementation(async (path: string) => path.endsWith('/preflight') ? preflight() : { ...st });
  render(<MemoryRouter><PublishPage /></MemoryRouter>);
  const progress = await screen.findByRole('progressbar', { name: '检查完成进度' });
  expect(progress.getAttribute('aria-valuenow')).toBe('2');
  expect(progress.getAttribute('aria-valuemax')).toBe('2');
  expect(progress.querySelector('span')?.getAttribute('style')).toContain('width: 100%');
  expect(screen.getByText('已完成 2 / 2 项 · 1 通过 · 1 跳过')).toBeTruthy();
});

it('shows the latest three legacy steps after a terminal run', async () => {
  const st = status(); st.activeVersion = null;
  st.steps = st.stepNames.map((step, index) => ({ step, status: 'ok', detail: null, started_at: index + 1, ended_at: index + 2 }));
  st.versions = [{ ...st.versions[1], id: 2, status: 'live', created_at: 2, published_at: 2 }];
  mocks.api.mockImplementation(async (path: string) => path.endsWith('/preflight') ? preflight() : { ...st });
  render(<MemoryRouter><PublishPage /></MemoryRouter>);
  const window = await screen.findByRole('region', { name: '当前检查窗口' });
  expect(window.querySelectorAll('[data-publish-check-row]')).toHaveLength(3);
  expect(window.textContent).not.toContain('准备文案与站点配置');
  expect(window.textContent).toContain('切换新版并核验');
  expect(screen.getByRole('heading', { name: '最近一次执行 · v2' })).toBeTruthy();
  expect(screen.getByText('执行完成')).toBeTruthy();
});

it('maps runner-side gate titles to Chinese and never renders raw English identifiers', () => {
  // runner-gates suites（含增量后缀）与 verify 门名（含执行口径后缀）必须全部译成人话
  const cases: Array<[string, string]> = [
    ['jsonc-reader-红测', '配置读取检查'], ['exit-finally-红测', '中断收尾检查'],
    ['config-consistency-自检', '配置一致性检查'], ['console-copy-自检', '后台文案检查'],
    ['beacon-size', '上报体积检查'], ['worker-AI-runtime', '后台智能运行检查'],
    ['worker-单测', '后台检查'], ['publisher-故障回归', '发布器回归检查'],
    ['typecheck:worker', '类型检查'], ['typecheck:site', '类型检查'],
    ['source-equivalence', '源码基线检查'], ['site-build', '官网构建'],
    ['publish-config', '发布配置检查'], ['publish-materialization', '配置物化检查'],
    ['canvas-geometry(运行时)', '画布几何检查'], ['deploy-gate(warn-only)', '发布占位标记检查'],
  ];
  for (const [raw, expected] of cases) expect(normalizeCheckTitle(raw)).toBe(expected);
});

it('coalesces running+ok rows of the same gate to the latest seq', () => {
  const groups = groupPublishChecks([
    { version_id: 2, step: 'gates', seq: 1, title: '网站内容与交互', status: 'running', output: null, started_at: 1, ended_at: null },
    { version_id: 2, step: 'gates', seq: 2, title: '网站内容与交互', status: 'ok', output: 'ok', started_at: 1, ended_at: 2 },
    { version_id: 2, step: 'gates', seq: 3, title: 'forbidden-words', status: 'failed', output: 'bad', started_at: 1, ended_at: 2 },
    { version_id: 2, step: 'gates', seq: 4, title: '画布几何', status: 'running', output: null, started_at: 1, ended_at: null },
  ], ['materialize', 'gates', 'build', 'swap']);
  expect(groups).toHaveLength(1);
  expect(groups[0].items.map((i) => `${i.title}/${i.status}/#${i.seq}`)).toEqual([
    '网站内容与交互/ok/#2', 'forbidden-words/failed/#3', '画布几何/running/#4',
  ]);
});
