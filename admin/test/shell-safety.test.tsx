// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
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
it('lays mobile navigation out in rows with 44px targets while preserving sidebar breakpoints', async () => {
  mocks.api.mockResolvedValue(overview);
  const { container } = render(<RouterProvider router={makeRouter()} />);
  await screen.findByText('编辑页面');
  const require = createRequire(resolve(process.cwd(), '../package.json'));
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');
    await page.setContent('<style>' + css + '</style>' + container.innerHTML);
    for (const width of [320, 375, 760, 761, 1023, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.getByRole('button', { name: '退出', exact: true }).count()).toBe(1);
      const result = await page.evaluate(() => {
        const aside = document.querySelector('aside')!;
        const links = [...aside.querySelectorAll<HTMLElement>('.nav')];
        return {
          direction: getComputedStyle(aside).flexDirection,
          asideWidth: aside.getBoundingClientRect().width,
          boxes: links.map((link) => { const b = link.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; }),
          labelsHidden: links.filter((link) => link.querySelector('.lbl')).every((link) => getComputedStyle(link.querySelector('.lbl')!).display === 'none'),
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      expect(result.boxes.length).toBeGreaterThan(1);
      if (width <= 760) {
        expect(result.direction).toBe('row');
        expect(result.boxes.every((b) => b.width >= 44 && b.height >= 44)).toBe(true);
        expect(new Set(result.boxes.map((b) => b.y)).size).toBeLessThan(result.boxes.length);
        expect(result.overflow).toBe(false);
      } else {
        expect(result.direction).toBe('column');
        expect(result.asideWidth).toBe(width < 1024 ? 64 : 216);
      }
      expect(result.labelsHidden).toBe(width < 1024);
    }
  } finally { await browser.close(); }
}, 20000);
