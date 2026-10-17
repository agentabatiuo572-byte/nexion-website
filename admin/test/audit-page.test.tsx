// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mocks = vi.hoisted(() => ({ api: vi.fn(), toast: vi.fn() }));
vi.mock('../src/api', () => ({ api: mocks.api, toast: mocks.toast }));

import AuditPage from '../src/pages/audit';
import { auditSummary, auditReason } from '../src/lib/audit-summary';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  delete (URL as typeof URL & { createObjectURL?: unknown }).createObjectURL;
});

const result = (action: string, id: number) => ({
  items: [{ id, ts: Date.now(), actor: 'admin', action, target: 'test', before_summary: null, after_summary: null, reason: null }],
  nextBefore: null,
});

describe('audit filter requests', () => {
  it('shows AI summaries in operator language and preserves result uncertainty', async () => {
    mocks.api.mockResolvedValue({ items: [
      { ...result('ai.connection.saved', 20).items[0], target: 'ai-connection', after_summary: 'credential 2; provider nvidia; model nvidia/riva-translate-4b-instruct-v2; status available' },
      { ...result('ai.connection.tested', 21).items[0], after_summary: 'operation 3; result invalid-key' },
      { ...result('ai.connection.tested', 22).items[0], after_summary: 'operation 4; result network-error' },
      { ...result('ai.settings', 23).items[0], after_summary: 'enabled 0; daily characters 50000' },
      { ...result('config.publish.failed', 24).items[0], after_summary: '门未通过(build): node /app/scripts/build.mjs exited 1' },
    ], nextBefore: null });
    render(<AuditPage />);
    expect(await screen.findByText(/密钥第 2 版；服务商：NVIDIA NIM；模型：.*；连接状态：可用/)).toBeTruthy();
    expect(screen.getByText(/第 3 次连接测试；测试结果：密钥无效/)).toBeTruthy();
    expect(screen.getByText(/连接中断，结果待确认/)).toBeTruthy();
    expect(screen.getByText(/自动翻译：关闭；每日翻译上限：50000 个字符/)).toBeTruthy();
    expect(screen.getByText('发布检查未通过，请到发布与版本查看详情')).toBeTruthy();
    expect(screen.queryByText(/credential|operation|invalid-key|network-error|node \/app/)).toBeNull();
  });

  it('formats other recorded AI, translation and geo summaries without modifying user reasons', () => {
    expect(auditSummary('credential 3', 'ai.connection.removed')).toBe('密钥第 3 版');
    expect(auditSummary('credential 4; provider zen; model deepseek-v4-flash-free; status model-unavailable', 'ai.connection.saved')).toBe('密钥第 4 版；服务商：OpenCode Zen；模型：deepseek-v4-flash-free；连接状态：模型不可用');
    expect(auditSummary('status future-status', 'ai.connection.saved')).toContain('待确认');
    expect(auditSummary('operation 5; provider gemini; model gemini-2.5-flash', 'ai.connection.attempt')).toContain('服务商：Google Gemini');
    expect(auditSummary('operation 6; result future-error', 'ai.connection.tested')).toContain('未完成');
    expect(auditSummary('enabled=true [US,CN] page=42B', 'geo.update.applied')).toBe('区域屏蔽：开启；地区：美国、中国；拦截页内容 42 字节');
    expect(auditReason('translation.apply', 'config.save')).toBe('应用 AI 翻译');
    expect(auditReason('locked', 'login.fail')).toBe('尝试次数过多，暂时无法登录');
    expect(auditReason('release operation 3 approved', 'config.publish')).toBe('release operation 3 approved');
  });

  it('exports original AI summaries and reasons for investigation', async () => {
    const original = 'operation 3; result invalid-key';
    mocks.api.mockResolvedValue({ items: [{ ...result('ai.connection.tested', 21).items[0], after_summary: original }], nextBefore: null });
    let blob: Blob | undefined;
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(value => { blob = value; return 'blob:audit'; }) });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    render(<AuditPage />);
    await screen.findByText(/测试结果：密钥无效/);
    fireEvent.click(screen.getByRole('button', { name: '导出 CSV' }));
    await waitFor(() => expect(blob).toBeDefined());
    const content = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsText(blob!); });
    expect(content).toContain(original);
    expect(content).toContain('ai.connection.tested');
  });
  it('provides a named native button to expand and collapse a long change', async () => {
    mocks.api.mockResolvedValue({ items: [{ ...result('config.save', 9).items[0], after_summary: '详细变更'.repeat(30) }], nextBefore: null });
    render(<AuditPage />);
    const button = await screen.findByRole('button', { name: '展开第 9 条变更' });
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(screen.getByRole('button', { name: '收起第 9 条变更' }).getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '收起第 9 条变更' }));
    expect(screen.getByRole('button', { name: '展开第 9 条变更' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('renders the indeterminate publish outcome as stable operator-facing copy', async () => {
    mocks.api.mockResolvedValue(result('config.publish.unknown', 1));

    render(<AuditPage />);

    expect(await screen.findByText('发布切换结果待核实')).toBeTruthy();
    expect(screen.queryByText('config.publish.unknown')).toBeNull();
  });

  it('distinguishes a geo update attempt from a confirmed applied update', async () => {
    mocks.api.mockResolvedValue({
      items: [result('geo.update.attempt', 1).items[0], result('geo.update.applied', 2).items[0]],
      nextBefore: null,
    });

    render(<AuditPage />);

    expect(await screen.findByText('尝试修改区域屏蔽规则')).toBeTruthy();
    expect(screen.getByText('区域屏蔽规则已应用')).toBeTruthy();
    expect(screen.queryByText('geo.update.attempt')).toBeNull();
    expect(screen.queryByText('geo.update.applied')).toBeNull();
  });

  it('names the saved language and field without exposing storage paths', async () => {
    mocks.api.mockResolvedValue({ items: [{ ...result('config.save', 10).items[0], target: 'draft', before_summary: 'r1', after_summary: '1 处改动:copy.en.hero.scrollHint; 来源 1; 待办 0' }], nextBefore: null });
    render(<AuditPage />);
    expect(await screen.findByText('网站草稿')).toBeTruthy();
    expect(screen.getByText(/草稿修订 1.*文案 · 英语 · 首屏 Hero · 滚动提示/)).toBeTruthy();
    expect(screen.queryByText(/copy\.en\.hero\.scrollHint/)).toBeNull();
    expect(screen.queryByText('config.save')).toBeNull();
  });

  it('names initialization, publish state and indexed language changes', async () => {
    mocks.api.mockResolvedValue({ items: [
      { ...result('auth.setup', 11).items[0], target: 'admin' },
      { ...result('config.publish', 12).items[0], target: 'v2', before_summary: 'live=v1', after_summary: '1 处改动' },
      { ...result('config.publish.unknown', 13).items[0], target: 'v2', before_summary: 'validating/publishing', after_summary: '结果待核实' },
      { ...result('config.save', 14).items[0], target: 'draft', after_summary: '1 处改动:enabledLocales[2]' },
    ], nextBefore: null });
    render(<AuditPage />);
    expect(await screen.findByText('管理员账户')).toBeTruthy();
    expect(screen.getByText(/线上版本 v1 → 1 处改动/)).toBeTruthy();
    expect(screen.getByText(/检查或发布进行中 → 结果待核实/)).toBeTruthy();
    expect(screen.getByText(/前台语言设置 · 第 3 项/)).toBeTruthy();
    expect(screen.queryByText(/live=v1|validating\/publishing|enabledLocales/)).toBeNull();
  });

  it('ignores an older filter response that arrives after the current filter response', async () => {
    let resolveContent!: (value: ReturnType<typeof result>) => void;
    let resolveSession!: (value: ReturnType<typeof result>) => void;
    mocks.api.mockImplementation((url: string) => {
      const group = new URL(url, 'http://console.test').searchParams.get('group');
      if (group === 'content') return new Promise((resolve) => { resolveContent = resolve; });
      if (group === 'session') return new Promise((resolve) => { resolveSession = resolve; });
      return Promise.resolve({ items: [], nextBefore: null });
    });

    render(<AuditPage />);
    fireEvent.click(screen.getByRole('button', { name: '内容改动' }));
    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith(expect.stringContaining('group=content')));
    fireEvent.click(screen.getByRole('button', { name: '登录与账号' }));
    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith(expect.stringContaining('group=session')));

    await act(async () => resolveSession(result('login.success', 2)));
    expect(await screen.findByText('登录成功')).toBeTruthy();
    await act(async () => resolveContent(result('config.save', 1)));

    expect(screen.queryByText('保存草稿')).toBeNull();
    expect(screen.getByText('登录成功')).toBeTruthy();
  });

  it('clears the old pagination cursor as soon as a new filter starts loading', async () => {
    let resolveFiltered!: (value: ReturnType<typeof result>) => void;
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      ...result('config.save', index + 1).items[0]!,
      id: index + 1,
    }));
    mocks.api.mockImplementation((url: string) => {
      const query = new URL(url, 'http://console.test').searchParams;
      if (query.get('group') === 'content') return new Promise((resolve) => { resolveFiltered = resolve; });
      return Promise.resolve({ items: firstPage, nextBefore: 123 });
    });

    render(<AuditPage />);
    expect(await screen.findByRole('button', { name: '加载更早 …' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '内容改动' }));
    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith(expect.stringContaining('group=content')));
    expect(screen.queryByRole('button', { name: '加载更早 …' })).toBeNull();
    expect(mocks.api.mock.calls.some(([url]) => String(url).includes('before=123'))).toBe(false);

    await act(async () => resolveFiltered(result('config.save', 99)));
    expect(await screen.findByText('保存草稿')).toBeTruthy();
    expect(mocks.api.mock.calls.some(([url]) => String(url).includes('before=123'))).toBe(false);
  });

  it('freezes one filter snapshot for every page of a CSV export', async () => {
    let resolveFirstExport!: (value: { items: ReturnType<typeof result>['items']; nextBefore: number | null }) => void;
    const exportQueries: URLSearchParams[] = [];
    mocks.api.mockImplementation((url: string) => {
      const query = new URL(url, 'http://console.test').searchParams;
      if (query.get('limit') !== '200') return Promise.resolve({ items: [], nextBefore: null });
      exportQueries.push(new URLSearchParams(query));
      if (exportQueries.length === 1) {
        return new Promise((resolve) => { resolveFirstExport = resolve; });
      }
      return Promise.resolve({ items: result('config.save', 100).items, nextBefore: null });
    });
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:audit') });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    render(<AuditPage />);
    fireEvent.click(screen.getByRole('button', { name: '内容改动' }));
    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith(expect.stringMatching(/group=content/)));

    fireEvent.click(screen.getByRole('button', { name: '导出 CSV' }));
    await waitFor(() => expect(exportQueries).toHaveLength(1));
    expect((screen.getByRole('button', { name: '登录与账号' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '登录与账号' }));

    const firstPage = Array.from({ length: 200 }, (_, index) => result('config.save', 300 - index).items[0]!);
    await act(async () => resolveFirstExport({ items: firstPage, nextBefore: 101 }));
    await waitFor(() => expect(exportQueries).toHaveLength(2));
    expect(exportQueries.every((query) => query.get('group') === 'content')).toBe(true);
    expect(exportQueries[1]!.get('before')).toBe('101');
    expect(await screen.findByText('已导出 201 行(筛选:内容改动)')).toBeTruthy();
  });
});
