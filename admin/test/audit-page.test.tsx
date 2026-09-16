// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mocks = vi.hoisted(() => ({ api: vi.fn(), toast: vi.fn() }));
vi.mock('../src/api', () => ({ api: mocks.api, toast: mocks.toast }));

import AuditPage from '../src/pages/audit';

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
    expect(screen.getByText('config.publish.unknown')).toBeTruthy();
  });

  it('distinguishes a geo update attempt from a confirmed applied update', async () => {
    mocks.api.mockResolvedValue({
      items: [result('geo.update.attempt', 1).items[0], result('geo.update.applied', 2).items[0]],
      nextBefore: null,
    });

    render(<AuditPage />);

    expect(await screen.findByText('尝试修改区域屏蔽规则')).toBeTruthy();
    expect(screen.getByText('区域屏蔽规则已应用')).toBeTruthy();
    expect(screen.getByText('geo.update.attempt')).toBeTruthy();
    expect(screen.getByText('geo.update.applied')).toBeTruthy();
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
