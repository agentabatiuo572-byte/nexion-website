// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mocks = vi.hoisted(() => ({ api: vi.fn(), toast: vi.fn(), advanceAuthGeneration: vi.fn() }));
vi.mock('../src/api', () => {
  class ApiError extends Error {
    constructor(public status: number) { super(String(status)); }
  }
  return {
    ApiError,
    api: mocks.api,
    toast: mocks.toast,
    advanceAuthGeneration: mocks.advanceAuthGeneration,
  };
});

import Shell, { useShell, useUnsavedChanges } from '../src/shell';

let reloadFromPage: ReturnType<typeof useShell>['reload'];
function ConcurrentRefreshPage() {
  const shell = useShell();
  reloadFromPage = shell.reload;
  return <div>当前草稿 {shell.overview?.draft.draftRev}</div>;
}

const overview = {
  liveVersion: 1,
  livePublishedAt: Date.now(),
  geo: { enabled: false, countries: 0, degraded: false },
  drift: null,
  lastPublishFailed: null,
  draft: { payload: {}, draftRev: 1, updatedAt: Date.now() },
  dirty: 0,
  changedPaths: [],
  sensitiveChanged: [],
};

function EditedPage() {
  useUnsavedChanges(true);
  return <div>编辑页面</div>;
}

function PlainPage() {
  return <><Outlet /><div>审计页面</div></>;
}

function ReloadPage() {
  const { reload } = useShell();
  return <button onClick={() => void reload({ geo: { enabled: true, countries: 1, degraded: false } })}>刷新全局状态</button>;
}

const makeRouter = () => createMemoryRouter([
  {
    path: '/',
    element: <Shell />,
    children: [
      { index: true, element: <EditedPage /> },
      { path: 'audit', element: <PlainPage /> },
    ],
  },
  { path: '/login', element: <div>登录页面</div> },
]);

const makeReloadRouter = () => createMemoryRouter([
  { path: '/', element: <Shell />, children: [{ index: true, element: <ReloadPage /> }] },
  { path: '/login', element: <div>登录页面</div> },
]);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('Shell safety flows', () => {
  async function setupConcurrentReads() {
    const pending: Array<{ resolve: (value: typeof overview) => void; reject: (error: Error) => void }> = [];
    let initialized = false;
    mocks.api.mockImplementation((path: string) => {
      if (path !== '/api/config') return Promise.resolve({});
      if (!initialized) { initialized = true; return Promise.resolve(overview); }
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    });
    render(<RouterProvider router={createMemoryRouter([{ path: '/', element: <Shell />, children: [{ index: true, element: <ConcurrentRefreshPage /> }] }])} />);
    await screen.findByText('当前草稿 1');
    return pending;
  }

  it.each(['old-first', 'new-first', 'old-rejected'])('a saved revision follows the newer poll without a false failure (%s)', async (order) => {
    const pending = await setupConcurrentReads();
    let saved!: ReturnType<typeof reloadFromPage>, polled!: ReturnType<typeof reloadFromPage>;
    act(() => { saved = reloadFromPage({ draftRev: 2 }); polled = reloadFromPage(); });
    const newest = { ...overview, draft: { ...overview.draft, draftRev: 3 } };
    let settled = false;
    void saved.then(() => { settled = true; });
    if (order === 'new-first') await act(async () => pending[1]!.resolve(newest));
    await act(async () => {
      if (order === 'old-rejected') pending[0]!.reject(new Error('old response lost'));
      else pending[0]!.resolve({ ...overview, draft: { ...overview.draft, draftRev: 2 } });
    });
    if (order !== 'new-first') {
      expect(settled).toBe(false);
      await act(async () => pending[1]!.resolve(newest));
    }
    expect(await saved).toEqual(newest);
    expect(await polled).toEqual(newest);
    expect(screen.getByText('当前草稿 3')).toBeTruthy();
    expect(screen.queryByText(/全局状态刷新失败/)).toBeNull();
  });

  it.each(['network-failure', 'stale-revision', 'geo-mismatch'])('a superseding poll must still confirm the write (%s)', async (failure) => {
    const pending = await setupConcurrentReads();
    let saved!: ReturnType<typeof reloadFromPage>;
    act(() => {
      saved = reloadFromPage({ draftRev: 2, ...(failure === 'geo-mismatch' ? { geo: { enabled: true, countries: 1, degraded: false } } : {}) });
      void reloadFromPage();
    });
    await act(async () => pending[0]!.resolve({ ...overview, draft: { ...overview.draft, draftRev: 2 } }));
    await act(async () => {
      if (failure === 'network-failure') pending[1]!.reject(new Error('offline'));
      else pending[1]!.resolve(failure === 'stale-revision' ? overview : { ...overview, draft: { ...overview.draft, draftRev: 2 } });
    });
    expect(await saved).toBeNull();
    expect(screen.getByText(/全局状态刷新失败，旧状态已隐藏/)).toBeTruthy();
    let retry!: ReturnType<typeof reloadFromPage>;
    act(() => { retry = reloadFromPage(); });
    const recovered = { ...overview, draft: { ...overview.draft, draftRev: 2 }, geo: { enabled: true, countries: 1, degraded: false } };
    await act(async () => pending[2]!.resolve(recovered));
    expect(await retry).toEqual(recovered);
    expect(screen.queryByText(/全局状态刷新失败/)).toBeNull();
  });

  it.each([null, { dbLive: 1, snapshot: 1, tampered: ['admin/index.html'] }])('reports failed publication without guaranteeing the live site is unaffected (drift=%j)', async (drift) => {
    mocks.api.mockImplementation((path: string) => Promise.resolve(path === '/api/config'
      ? { ...overview, drift, lastPublishFailed: { id: 2, reason: '发布服务中断或超时', at: Date.now() } }
      : {}));
    render(<RouterProvider router={makeRouter()} />);
    const banner = await screen.findByText(/上次发布失败\(v2\)/);
    expect(banner.textContent).not.toContain('未受影响');
    expect(banner.textContent).toContain(drift ? '线上内容需核查' : '当前记录的线上版本为 v1');
  });

  it('keeps the page open and reports an active session only after /api/me confirms it', async () => {
    mocks.api.mockImplementation((path: string) => {
      if (path === '/api/me') return Promise.resolve({});
      if (path === '/api/config') return Promise.resolve(overview);
      if (path === '/api/auth/logout') return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve({});
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const router = makeRouter();
    render(<RouterProvider router={router} />);
    await screen.findByText('编辑页面');
    expect(screen.getByRole('link', { name: /查看官网/ }).getAttribute('href')).toBe(window.location.origin + '/');

    fireEvent.click(screen.getByRole('button', { name: /退出/ }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('退出请求未完整成功；回读确认会话仍然有效，请重试'));

    expect(router.state.location.pathname).toBe('/');
    expect(screen.getByRole('status').textContent).toContain('回读确认会话仍然有效');
    expect(mocks.advanceAuthGeneration).not.toHaveBeenCalled();
    expect(mocks.api).toHaveBeenCalledWith('/api/me', undefined, { redirectUnauthorized: false });
  });

  it('goes to login when logout fails but /api/me returns 401', async () => {
    let meReads = 0;
    /* 使用模块 mock 暴露的 ApiError，保证走“会话已结束”分支。 */
    const ApiErrorCtor = (await import('../src/api')).ApiError;
    mocks.api.mockImplementation((path: string) => {
      if (path === '/api/me') return meReads++ === 0 ? Promise.resolve({}) : Promise.reject(new ApiErrorCtor(401));
      if (path === '/api/config') return Promise.resolve(overview);
      if (path === '/api/auth/logout') return Promise.reject(new TypeError('response lost'));
      return Promise.resolve({});
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const router = makeRouter();
    render(<RouterProvider router={router} />);
    await screen.findByText('编辑页面');

    fireEvent.click(screen.getByRole('button', { name: /退出/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(mocks.toast).toHaveBeenCalledWith('退出响应异常，但回读确认会话已经结束');
    expect(mocks.advanceAuthGeneration).toHaveBeenCalledTimes(1);
  });

  it('keeps edits and reports an unknown result when logout fails and /api/me returns 403', async () => {
    let meReads = 0;
    const ApiErrorCtor = (await import('../src/api')).ApiError;
    mocks.api.mockImplementation((path: string) => {
      if (path === '/api/me') return meReads++ === 0 ? Promise.resolve({}) : Promise.reject(new ApiErrorCtor(403));
      if (path === '/api/config') return Promise.resolve(overview);
      if (path === '/api/auth/logout') return Promise.reject(new TypeError('response lost'));
      return Promise.resolve({});
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const router = makeRouter();
    const view = render(<RouterProvider router={router} />);
    await screen.findByText('编辑页面');
    await waitFor(() => expect(view.container.querySelector('.shell')?.getAttribute('data-unsaved')).toBe('true'));

    fireEvent.click(screen.getByRole('button', { name: /退出/ }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('退出结果暂时未知，无法确认会话是否仍有效；请刷新页面核实'));

    expect(router.state.location.pathname).toBe('/');
    expect(screen.getByRole('status').textContent).toContain('退出结果暂时未知');
    expect(view.container.querySelector('.shell')?.getAttribute('data-unsaved')).toBe('true');
    expect(mocks.advanceAuthGeneration).not.toHaveBeenCalled();
  });

  it('keeps the page open and says the result is unknown when logout and /api/me both lose their responses', async () => {
    let meReads = 0;
    mocks.api.mockImplementation((path: string) => {
      if (path === '/api/me') return meReads++ === 0 ? Promise.resolve({}) : Promise.reject(new TypeError('offline'));
      if (path === '/api/config') return Promise.resolve(overview);
      if (path === '/api/auth/logout') return Promise.reject(new TypeError('response lost'));
      return Promise.resolve({});
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const router = makeRouter();
    render(<RouterProvider router={router} />);
    await screen.findByText('编辑页面');

    fireEvent.click(screen.getByRole('button', { name: /退出/ }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('退出结果暂时未知，无法确认会话是否仍有效；请刷新页面核实'));
    expect(router.state.location.pathname).toBe('/');
    expect(screen.getByRole('status').textContent).toContain('退出结果暂时未知');
    expect(mocks.advanceAuthGeneration).not.toHaveBeenCalled();
  });

  it('blocks side navigation until the operator confirms discarding unsaved edits', async () => {
    mocks.api.mockImplementation((path: string) => path === '/api/config' ? Promise.resolve(overview) : Promise.resolve({}));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const router = makeRouter();
    const view = render(<RouterProvider router={router} />);
    await screen.findByText('编辑页面');
    await waitFor(() => expect(view.container.querySelector('.shell')?.getAttribute('data-unsaved')).toBe('true'));

    fireEvent.click(screen.getByTitle('审计日志'));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(router.state.location.pathname).toBe('/');

    fireEvent.click(screen.getByTitle('审计日志'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/audit'));
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('does not let an older overview request overwrite a newer confirmed geo status', async () => {
    let finishOld!: (value: typeof overview) => void;
    let finishNew!: (value: typeof overview) => void;
    let configReads = 0;
    mocks.api.mockImplementation((path: string) => {
      if (path === '/api/me') return Promise.resolve({});
      if (path === '/api/config') {
        configReads += 1;
        return new Promise((resolve) => {
          if (configReads === 1) finishOld = resolve;
          else finishNew = resolve;
        });
      }
      return Promise.resolve({});
    });
    const router = makeReloadRouter();
    render(<RouterProvider router={router} />);
    await screen.findByRole('button', { name: '刷新全局状态' });
    fireEvent.click(screen.getByRole('button', { name: '刷新全局状态' }));
    await waitFor(() => expect(configReads).toBe(2));
    expect(screen.getByText('正在同步最新全局状态…')).toBeTruthy();
    expect(screen.queryByTitle('区域屏蔽(只读状态;点击进入规则面板)')).toBeNull();

    const newer = { ...overview, geo: { enabled: true, countries: 1, degraded: false } };
    await act(async () => finishNew(newer));
    expect(screen.getByText(/开启 · 1 个地区/)).toBeTruthy();
    await act(async () => finishOld(overview));
    expect(screen.getByText(/开启 · 1 个地区/)).toBeTruthy();
    expect(screen.queryByText(/屏蔽 未启用/)).toBeNull();
  });

  it('hides an old overview when a refresh fails instead of presenting it as current', async () => {
    let configReads = 0;
    mocks.api.mockImplementation((path: string) => {
      if (path === '/api/me') return Promise.resolve({});
      if (path === '/api/config') {
        configReads += 1;
        return configReads === 1 ? Promise.resolve(overview) : Promise.reject(new TypeError('offline'));
      }
      return Promise.resolve({});
    });
    const router = makeReloadRouter();
    render(<RouterProvider router={router} />);
    const staleChip = await screen.findByTitle('区域屏蔽(只读状态;点击进入规则面板)');
    expect(staleChip.textContent).toContain('未启用');

    fireEvent.click(screen.getByRole('button', { name: '刷新全局状态' }));
    expect(await screen.findByText(/全局状态刷新失败，旧状态已隐藏/)).toBeTruthy();
    expect(screen.queryByTitle('区域屏蔽(只读状态;点击进入规则面板)')).toBeNull();
  });
});

// Real Shell DOM + production CSS, measured in Chromium; jsdom cannot measure flex layout.
it('keeps navigation labels readable at every width and mobile targets at least 44px', async () => {
  mocks.api.mockResolvedValue(overview);
  const { container } = render(<RouterProvider router={makeRouter()} />);
  await screen.findByText('编辑页面');
  fireEvent.click(screen.getByRole('button', { name: '打开导航' }));
  expect(screen.getByRole('button', { name: '关闭导航' }).getAttribute('aria-expanded')).toBe('true');
  const repoRoot = existsSync(resolve(process.cwd(), 'admin/package.json')) ? process.cwd() : resolve(process.cwd(), '..');
  const require = createRequire(resolve(repoRoot, 'package.json'));
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const css = readFileSync(resolve(repoRoot, 'admin/src/styles.css'), 'utf8');
    await page.setContent('<style>' + css + '</style>' + container.innerHTML);
    for (const width of [320, 375, 760, 761, 1023, 1024, 1440, 1920, 2560, 3840]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.getByRole('button', { name: '退出', exact: true }).count()).toBe(1);
      const result = await page.evaluate(() => {
        const aside = document.querySelector('aside')!;
        const links = [...aside.querySelectorAll<HTMLElement>('.nav')];
        return {
          direction: getComputedStyle(aside).flexDirection,
          asideWidth: aside.getBoundingClientRect().width,
          labelsFit: links.every((link) => {
            const label = link.querySelector('.lbl');
            if (!label) return false;
            const range = document.createRange(); range.selectNodeContents(label);
            const text = range.getBoundingClientRect(), box = link.getBoundingClientRect();
            return text.left >= box.left && text.right <= box.right + 1 && text.top >= box.top && text.bottom <= box.bottom + 1;
          }),
          boxes: links.map((link) => { const b = link.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; }),
          labelsHidden: links.filter((link) => link.querySelector('.lbl')).every((link) => getComputedStyle(link.querySelector('.lbl')!).display === 'none'),
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      expect(result.boxes.length).toBeGreaterThan(1);
      if (width <= 760) {
        expect(result.direction).toBe('column');
        expect(result.boxes.every((b) => b.width >= 44 && b.height >= 44)).toBe(true);
        expect(result.overflow).toBe(false);
      } else {
        expect(result.direction).toBe('column');
        expect(result.asideWidth).toBeGreaterThanOrEqual(220);
        expect(result.asideWidth).toBeLessThan(width * .4);
        expect(result.labelsFit).toBe(true);
        expect(result.overflow).toBe(false);
      }
      expect(result.labelsHidden).toBe(false);
    }
  } finally { await browser.close(); }
}, 20000);
