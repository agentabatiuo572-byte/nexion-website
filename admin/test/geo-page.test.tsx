// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { cleanup, fireEvent, render as renderPage, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const render = (node: ReactNode) => renderPage(<MemoryRouter>{node}</MemoryRouter>);

const mocks = vi.hoisted(() => ({ api: vi.fn(), toast: vi.fn(), reloadShell: vi.fn() }));
vi.mock('../src/api', () => {
  class ApiError extends Error {
    constructor(public status: number, public body: Record<string, unknown>) { super(String(body.error ?? status)); }
  }
  return { ApiError, api: mocks.api, toast: mocks.toast };
});
vi.mock('../src/shell', () => ({
  useShell: () => ({ reload: mocks.reloadShell }),
  useUnsavedChanges: () => {},
}));

import GeoPage from '../src/pages/geo';

const rules = (enabled: boolean) => ({
  enabled,
  countries: ['CN'],
  blockPage: { title: { zh: '受限', en: 'Unavailable' }, body: { zh: '当前地区不可访问', en: 'Unavailable in this region' } },
  updatedAt: 1,
});
const state = (enabled: boolean, authority: Record<string, unknown> = {
  status: 'ready', source: 'd1', version: 1, currentFingerprint: 'ready-fingerprint-v1',
}) => ({
  rules: rules(enabled),
  degraded: false,
  bypassAvailable: false,
  authority,
  stats: { last7: [], todayLive: 0, blocked7: 0, shareOfRequests: 0 },
});

async function submitToggle() {
  const switchLabel = await screen.findByTitle('总开关');
  fireEvent.click(switchLabel.querySelector('input')!);
  fireEvent.click(screen.getByRole('button', { name: '应用变更(确认+理由)' }));
  fireEvent.change(screen.getByPlaceholderText('例:合规要求,上线前开启大陆屏蔽'), { target: { value: '这是足够长度的测试理由' } });
  fireEvent.click(screen.getByRole('button', { name: '确认应用' }));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Geo plain-language status', () => {
  it('opens the bypass exchange on the published site and preserves its token', async () => {
    mocks.api.mockImplementation(async (path: string) => path === '/api/geo/bypass-token'
      ? { url: '/api/bypass?t=synthetic%2Btoken%2Fvalue' }
      : { ...state(false), bypassAvailable: true });
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    try {
      render(<GeoPage />);
      fireEvent.click(await screen.findByRole('button', { name: '获取直通(从任何地区预览官网)' }));
      await waitFor(() => expect(open).toHaveBeenCalledWith(window.location.origin + '/api/bypass?t=synthetic%2Btoken%2Fvalue', '_blank', 'noopener'));
    } finally { open.mockRestore(); }
  });

  it('keeps every target language in the work copy and only requires Chinese fallback text', async () => {
    mocks.api.mockResolvedValue(state(false));
    const view = render(<GeoPage />);
    const target = await screen.findByLabelText('编辑语言');
    expect((target as HTMLSelectElement).options).toHaveLength(9);
    fireEvent.change(target, { target: { value: 'ja' } });
    fireEvent.change(screen.getByLabelText('日语标题'), { target: { value: '地域の制限' } });
    fireEvent.change(screen.getByLabelText(/日语正文/), { target: { value: 'この地域からは利用できません' } });
    expect(view.container.querySelector('.locale-reference input,.locale-reference textarea')).toBeNull();
    fireEvent.change(target, { target: { value: 'en' } });
    fireEvent.change(screen.getByLabelText('英语标题'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(/英语正文/), { target: { value: '' } });
    expect((screen.getByRole('button', { name: '应用变更(确认+理由)' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(target, { target: { value: 'zh' } });
    fireEvent.change(screen.getByLabelText('中文标题'), { target: { value: '' } });
    expect((screen.getByRole('button', { name: '应用变更(确认+理由)' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('中文标题'), { target: { value: '服务不可用' } });
    fireEvent.change(target, { target: { value: 'ja' } });
    expect((screen.getByLabelText('日语标题') as HTMLInputElement).value).toBe('地域の制限');
    expect((screen.getByLabelText(/日语正文/) as HTMLTextAreaElement).value).toBe('この地域からは利用できません');
    expect(mocks.api.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });
  it.each([
    {
      authority: { status: 'bootstrap-required', source: 'legacy-kv-candidate', candidateFingerprint: 'candidate-fp' },
      degraded: false, message: '首次使用，请先确认现有规则。', summary: '查看首次确认技术详情', technical: '旧 KV 的迁移候选', action: '确认并保存现有规则',
    },
    {
      authority: { status: 'pending', source: 'd1', kind: 'update', operationId: 'op-pending', version: 2, currentFingerprint: 'current-fp', targetFingerprint: 'target-fp', previousFingerprint: 'previous-fp', startedAt: 1 },
      degraded: false, message: '规则已保存，待确认同步完成。', summary: '查看待同步技术详情', technical: 'op-pending', action: '重新同步已保存规则',
    },
    {
      authority: { status: 'ready', source: 'd1', version: 2, currentFingerprint: 'current-fp' },
      degraded: true, message: '规则已保存，但暂时无法核对同步结果。', summary: '查看同步异常技术详情', technical: '边缘 KV 通道当前不可达', action: '重新同步当前规则',
    },
  ])('gives an actionable primary message and keeps $summary closed', async ({ authority, degraded, message, summary, technical, action }) => {
    mocks.api.mockResolvedValue({ ...state(false, authority), degraded });
    render(<GeoPage />);
    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.getByRole('button', { name: action })).toBeTruthy();
    const details = screen.getByText(summary).closest('details')!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain(technical);
    const mainNote = details.parentElement!.cloneNode(true) as HTMLElement;
    mainNote.querySelectorAll('details').forEach((item) => item.remove());
    expect(mainNote.textContent).not.toMatch(/D1|KV|op-pending|物化|权威/);
    expect((screen.getByRole('button', { name: '应用变更(确认+理由)' }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.api.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });
});

describe('Geo response-loss handling', () => {
  it('submits the displayed D1 authority token and a client-generated operation id', async () => {
    mocks.reloadShell.mockResolvedValue({});
    let submitted: Record<string, unknown> | null = null;
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/geo' && init?.method === 'PUT') {
        submitted = JSON.parse(String(init.body)) as Record<string, unknown>;
        const operationId = String(submitted.operationId);
        return Promise.resolve({
          ok: true,
          operationId,
          rules: { ...rules(true), updateOperationId: operationId },
          authority: { status: 'ready', source: 'd1', version: 2, currentFingerprint: 'ready-fingerprint-v2' },
        });
      }
      if (path === '/api/geo') return Promise.resolve(state(false));
      return Promise.resolve({});
    });
    render(<GeoPage />);
    await submitToggle();

    expect(submitted).toMatchObject({
      expectedVersion: 1,
      expectedFingerprint: 'ready-fingerprint-v1',
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  it('does not call an unchanged rule applied when the request failed before its operation id was committed', async () => {
    mocks.reloadShell.mockResolvedValue({});
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/geo' && init?.method === 'PUT') return Promise.reject(new TypeError('request not sent'));
      if (path === '/api/geo') return Promise.resolve(state(false));
      return Promise.resolve({});
    });
    render(<GeoPage />);
    const switchInput = (await screen.findByTitle('总开关')).querySelector('input')!;
    fireEvent.click(switchInput);
    fireEvent.click(switchInput);
    fireEvent.click(screen.getByRole('button', { name: '应用变更(确认+理由)' }));
    fireEvent.change(screen.getByPlaceholderText('例:合规要求,上线前开启大陆屏蔽'), { target: { value: '验证未提交操作不能冒充成功' } });
    fireEvent.click(screen.getByRole('button', { name: '确认应用' }));

    expect(await screen.findByText(/未确认由本次操作写入/)).toBeTruthy();
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.stringMatching(/规则已经生效/));
  });

  it('preserves a same-operation ready readback degraded state instead of forcing it healthy', async () => {
    mocks.reloadShell.mockResolvedValue({});
    let operationId = '';
    let reads = 0;
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/geo' && init?.method === 'PUT') {
        operationId = String((JSON.parse(String(init.body)) as { operationId?: string }).operationId ?? '');
        return Promise.reject(new TypeError('response lost'));
      }
      if (path === '/api/geo') {
        if (reads++ === 0) return Promise.resolve(state(false));
        return Promise.resolve({
          ...state(true, { status: 'ready', source: 'd1', version: 2, currentFingerprint: 'ready-fingerprint-v2' }),
          degraded: true,
          rules: { ...rules(true), updateOperationId: operationId },
        });
      }
      return Promise.resolve({});
    });
    render(<GeoPage />);
    await submitToggle();

    expect(await screen.findByText(/D1 权威规则可读，但边缘 KV 通道当前不可达/)).toBeTruthy();
    expect(mocks.reloadShell).toHaveBeenCalledWith({ geo: { enabled: true, countries: 1, degraded: true } });
  });

  it('binds a high-traffic acknowledgement to the challenged rules snapshot and operation id', async () => {
    const ApiErrorCtor = (await import('../src/api')).ApiError;
    mocks.reloadShell.mockResolvedValue({});
    const writes: Array<Record<string, unknown>> = [];
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/geo' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        writes.push(body);
        if (writes.length === 1) {
          return Promise.reject(new ApiErrorCtor(409, {
            error: 'need-confirm-high-traffic',
            hot: [{ country: 'CN', share: 0.9 }],
            operationId: body.operationId,
            confirmationFingerprint: 'a'.repeat(64),
          }));
        }
        const operationId = String(body.operationId);
        return Promise.resolve({
          ok: true,
          operationId,
          rules: { ...rules(true), updateOperationId: operationId },
          authority: { status: 'ready', source: 'd1', version: 2, currentFingerprint: 'ready-fingerprint-v2' },
        });
      }
      if (path === '/api/geo') return Promise.resolve(state(false));
      return Promise.resolve({});
    });
    render(<GeoPage />);
    await submitToggle();
    await screen.findByText(/误伤护栏/);
    const switchInput = screen.getByTitle('总开关').querySelector('input')!;
    fireEvent.click(switchInput); // 挑战返回后继续编辑草稿；旧确认不得改写目标快照
    fireEvent.click(screen.getByText('我知道这会拦截主要市场流量').closest('label')!.querySelector('input')!);
    fireEvent.click(screen.getByRole('button', { name: '仍然应用' }));
    await waitFor(() => expect(writes).toHaveLength(2));

    expect(writes[1]).toMatchObject({
      enabled: true,
      operationId: writes[0]!.operationId,
      highTrafficConfirmation: { operationId: writes[0]!.operationId, fingerprint: 'a'.repeat(64) },
    });
  });

  it('offers a version-bound rematerialization action for ready degraded authority', async () => {
    mocks.reloadShell.mockResolvedValue({});
    const degraded = {
      ...state(false, { status: 'ready', source: 'd1', version: 7, currentFingerprint: 'ready-fingerprint-v7' }),
      degraded: true,
    };
    let operationId = '';
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/geo/recovery' && init?.method === 'POST') {
        operationId = String((JSON.parse(String(init.body)) as { operationId?: string }).operationId ?? '');
        return Promise.resolve({
          ok: true,
          recovery: 'rematerialize-ready',
          operationId,
          rules: rules(false),
          authority: { status: 'ready', source: 'd1', version: 7, currentFingerprint: 'ready-fingerprint-v7' },
        });
      }
      if (path === '/api/geo') return Promise.resolve(degraded);
      return Promise.resolve({});
    });
    render(<GeoPage />);
    fireEvent.click(await screen.findByRole('button', { name: '重新同步当前规则' }));
    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('/api/geo/recovery', expect.objectContaining({ method: 'POST' })));
    const call = mocks.api.mock.calls.find(([path]) => path === '/api/geo/recovery')!;
    expect(JSON.parse(String(call[1]?.body))).toMatchObject({
      action: 'rematerialize-ready',
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      version: 7,
      currentFingerprint: 'ready-fingerprint-v7',
    });
  });

  it('ready 重物化响应丢失后只认本次 operationId 的 pending，不叠加伪失败或伪成功', async () => {
    const ApiErrorCtor = (await import('../src/api')).ApiError;
    const degraded = {
      ...state(false, { status: 'ready', source: 'd1', version: 7, currentFingerprint: 'ready-fingerprint-v7' }),
      degraded: true,
    };
    let operationId = '';
    let reads = 0;
    mocks.reloadShell.mockResolvedValue({});
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/geo/recovery' && init?.method === 'POST') {
        operationId = String((JSON.parse(String(init.body)) as { operationId?: string }).operationId ?? '');
        return Promise.reject(new ApiErrorCtor(503, { error: 'geo-update-recovery-required', operationId }));
      }
      if (path === '/api/geo') {
        if (reads++ === 0) return Promise.resolve(degraded);
        return Promise.resolve(state(false, {
          status: 'pending', source: 'd1', kind: 'update', operationId,
          version: 7, currentFingerprint: 'ready-fingerprint-v7', targetFingerprint: 'ready-fingerprint-v7',
          previousFingerprint: 'ready-fingerprint-v7', startedAt: 1,
        }));
      }
      return Promise.resolve({});
    });
    render(<GeoPage />);
    fireEvent.click(await screen.findByRole('button', { name: '重新同步当前规则' }));

    expect(await screen.findByText(/D1 权威操作处于待恢复状态，不能断言边缘物化与审计已经收口/)).toBeTruthy();
    expect(screen.queryByText('已保存的规则尚未确认同步完成。')).toBeNull();
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.stringMatching(/已重新同步|规则一致/));
    expect(mocks.reloadShell).toHaveBeenCalledWith({ geo: { enabled: false, countries: 1, degraded: true } });
  });

  it('ready 重物化响应丢失且首次回读失败时，延迟核验按原 version/fingerprint 识别已恢复', async () => {
    const degraded = {
      ...state(false, { status: 'ready', source: 'd1', version: 7, currentFingerprint: 'ready-fingerprint-v7' }),
      degraded: true,
    };
    let reads = 0;
    mocks.reloadShell.mockResolvedValue({});
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/geo/recovery' && init?.method === 'POST') return Promise.reject(new TypeError('response lost'));
      if (path === '/api/geo') {
        reads += 1;
        if (reads === 1) return Promise.resolve(degraded);
        if (reads === 2) return Promise.reject(new TypeError('first readback unavailable'));
        return Promise.resolve(state(false, {
          status: 'ready', source: 'd1', version: 7, currentFingerprint: 'ready-fingerprint-v7',
        }));
      }
      return Promise.resolve({});
    });
    render(<GeoPage />);
    fireEvent.click(await screen.findByRole('button', { name: '重新同步当前规则' }));
    fireEvent.click(await screen.findByRole('button', { name: '重新读取实际状态' }));

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('已重新读取：访问节点与已保存的规则一致'));
    expect(screen.queryByText(/D1 权威版本已经变化/)).toBeNull();
    expect(mocks.reloadShell).toHaveBeenCalledWith({ geo: { enabled: false, countries: 1, degraded: false } });
  });

  it('treats only need-confirm-high-traffic as the traffic guard and exposes a real conflict as reloadable', async () => {
    const ApiErrorCtor = (await import('../src/api')).ApiError;
    let reads = 0;
    mocks.reloadShell.mockResolvedValue({});
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/geo' && init?.method === 'PUT') {
        return Promise.reject(new ApiErrorCtor(409, { error: 'geo-update-conflict' }));
      }
      if (path === '/api/geo') {
        const next = state(false);
        return Promise.resolve(reads++ === 0 ? next : { ...next, degraded: true });
      }
      return Promise.resolve({});
    });
    render(<GeoPage />);
    await submitToggle();

    expect(await screen.findByText(/规则已被其他操作更新/)).toBeTruthy();
    expect(screen.queryByText(/误伤护栏/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '放弃并重新读取线上规则' }));
    await waitFor(() => expect(mocks.reloadShell).toHaveBeenCalledWith({
      geo: { enabled: false, countries: 1, degraded: true },
    }));
  });

  it.each([
    [409, 'geo-update-pending'],
    [503, 'geo-update-recovery-required'],
  ])('turns %s %s into the pending recovery UI instead of a traffic confirmation', async (status, error) => {
    const ApiErrorCtor = (await import('../src/api')).ApiError;
    const pendingAuthority = {
      status: 'pending', kind: 'update', operationId: 'op-from-write', version: 2,
      currentFingerprint: 'target-fp', targetFingerprint: 'target-fp', previousFingerprint: 'previous-fp', startedAt: 1,
    };
    let reads = 0;
    mocks.reloadShell.mockResolvedValue({});
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/geo' && init?.method === 'PUT') return Promise.reject(new ApiErrorCtor(status, { error }));
      if (path === '/api/geo') return Promise.resolve(reads++ === 0 ? state(false) : state(true, pendingAuthority));
      return Promise.resolve({});
    });
    render(<GeoPage />);
    await submitToggle();

    expect(await screen.findByRole('button', { name: '重新同步已保存规则' })).toBeTruthy();
    expect(screen.getByText(/D1 权威操作处于待恢复状态/)).toBeTruthy();
    expect(screen.queryByText(/误伤护栏/)).toBeNull();
  });

  it('renders explicit legacy bootstrap and sends the displayed candidate to the recovery endpoint', async () => {
    const bootstrap = state(false, { status: 'bootstrap-required', candidateFingerprint: 'candidate-fp' });
    let reads = 0;
    mocks.reloadShell.mockResolvedValue({});
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/geo/recovery' && init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          recovery: 'bootstrap',
          rules: rules(false),
          authority: { status: 'ready', source: 'd1', version: 1, currentFingerprint: 'candidate-fp' },
        });
      }
      if (path === '/api/geo' && reads++ === 0) return Promise.resolve(bootstrap);
      if (path === '/api/geo') return Promise.reject(new TypeError('readback unavailable'));
      return Promise.resolve({});
    });
    render(<GeoPage />);
    fireEvent.click(await screen.findByRole('button', { name: '确认并保存现有规则' }));

    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('/api/geo/recovery', expect.objectContaining({ method: 'POST' })));
    const recoveryCall = mocks.api.mock.calls.find(([path]) => path === '/api/geo/recovery')!;
    expect(JSON.parse(String(recoveryCall[1]?.body))).toMatchObject({
      action: 'bootstrap',
      candidateFingerprint: 'candidate-fp',
      rules: rules(false),
    });
    await waitFor(() => expect(screen.queryByRole('button', { name: '确认并保存现有规则' })).toBeNull());
    expect(mocks.reloadShell).toHaveBeenCalledWith({
      geo: { enabled: false, countries: 1, degraded: false },
    });
  });

  it('回读确认 bootstrap 已完成时，把丢失的响应按成功收口并同步 shell', async () => {
    const bootstrap = state(false, { status: 'bootstrap-required', candidateFingerprint: 'candidate-fp' });
    let reads = 0;
    mocks.reloadShell.mockResolvedValue({});
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/geo/recovery' && init?.method === 'POST') {
        return Promise.reject(new TypeError('bootstrap response lost'));
      }
      if (path === '/api/geo') return Promise.resolve(reads++ === 0 ? bootstrap : state(false));
      return Promise.resolve({});
    });
    render(<GeoPage />);
    fireEvent.click(await screen.findByRole('button', { name: '确认并保存现有规则' }));

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('未收到确认响应，但重新读取已确认：现有规则已保存'));
    expect(screen.getAllByText(/屏蔽未启用/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/迁移没有完成/)).toBeNull();
    expect(mocks.reloadShell).toHaveBeenCalledWith({
      geo: { enabled: false, countries: 1, degraded: false },
    });
  });

  it('bootstrap 返回 5xx 但回读仍 pending 时保留可恢复状态，不误报迁移失败', async () => {
    const ApiErrorCtor = (await import('../src/api')).ApiError;
    const bootstrap = state(false, { status: 'bootstrap-required', candidateFingerprint: 'candidate-fp' });
    const pending = state(false, {
      status: 'pending', kind: 'bootstrap', operationId: 'op-bootstrap-pending', version: 1,
      currentFingerprint: 'candidate-fp', targetFingerprint: 'candidate-fp', previousFingerprint: 'candidate-fp', startedAt: 1,
    });
    let reads = 0;
    mocks.reloadShell.mockResolvedValue({});
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/geo/recovery' && init?.method === 'POST') {
        return Promise.reject(new ApiErrorCtor(503, { error: 'geo-update-recovery-required' }));
      }
      if (path === '/api/geo') return Promise.resolve(reads++ === 0 ? bootstrap : pending);
      return Promise.resolve({});
    });
    render(<GeoPage />);
    fireEvent.click(await screen.findByRole('button', { name: '确认并保存现有规则' }));

    expect(await screen.findByRole('button', { name: '重新同步已保存规则' })).toBeTruthy();
    expect(screen.queryByText(/迁移没有完成/)).toBeNull();
    expect(mocks.reloadShell).toHaveBeenCalledWith({
      geo: { enabled: false, countries: 1, degraded: true },
    });
  });

  it('bootstrap 响应和权威回读都不可用时只报告结果未知', async () => {
    const bootstrap = state(false, { status: 'bootstrap-required', candidateFingerprint: 'candidate-fp' });
    let reads = 0;
    mocks.reloadShell.mockResolvedValue({});
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/geo/recovery' && init?.method === 'POST') return Promise.reject(new TypeError('offline'));
      if (path === '/api/geo' && reads++ === 0) return Promise.resolve(bootstrap);
      return Promise.reject(new TypeError('offline'));
    });
    render(<GeoPage />);
    fireEvent.click(await screen.findByRole('button', { name: '确认并保存现有规则' }));

    expect(await screen.findByText('首次确认结果暂时未知，请重新读取实际状态。')).toBeTruthy();
    expect(screen.queryByText('现有规则尚未完成首次确认。')).toBeNull();
    const details = screen.getByText('查看本次操作技术详情').closest('details')!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('geo-bootstrap-result-unknown');
    expect(screen.getByRole('button', { name: '重新读取实际状态' })).toBeTruthy();
  });

  it('bootstrap 候选冲突后回读并展示新的候选，明确保留为已知未迁移状态', async () => {
    const ApiErrorCtor = (await import('../src/api')).ApiError;
    const candidateA = state(false, { status: 'bootstrap-required', candidateFingerprint: 'candidate-a' });
    const candidateB = state(true, { status: 'bootstrap-required', candidateFingerprint: 'candidate-b' });
    let reads = 0;
    mocks.reloadShell.mockResolvedValue({});
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/geo/recovery' && init?.method === 'POST') {
        return Promise.reject(new ApiErrorCtor(409, { error: 'geo-bootstrap-candidate-changed' }));
      }
      if (path === '/api/geo') return Promise.resolve(reads++ === 0 ? candidateA : candidateB);
      return Promise.resolve({});
    });
    render(<GeoPage />);
    fireEvent.click(await screen.findByRole('button', { name: '确认并保存现有规则' }));

    expect(await screen.findByText(/旧 KV 候选已变化/)).toBeTruthy();
    expect((screen.getByTitle('总开关').querySelector('input') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('button', { name: '确认并保存现有规则' })).toBeTruthy();
  });

  it('shows one idempotent D1 materialization recovery action and sends the pending operation id', async () => {
    const pending = state(false, {
      status: 'pending', kind: 'update', operationId: 'op-pending', version: 1,
      currentFingerprint: 'current-fp', targetFingerprint: 'target-fp', startedAt: 1,
    });
    mocks.reloadShell.mockResolvedValue({});
    let reads = 0;
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/geo/recovery' && init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          recovery: 'target',
          observed: 'target',
          rules: rules(true),
          authority: { status: 'ready', source: 'd1', version: 2, currentFingerprint: 'target-fp' },
        });
      }
      if (path === '/api/geo' && reads++ === 0) return Promise.resolve(pending);
      if (path === '/api/geo') return Promise.reject(new TypeError('readback unavailable'));
      return Promise.resolve({});
    });
    render(<GeoPage />);
    expect(await screen.findByRole('button', { name: '重新同步已保存规则' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重新同步已保存规则' }));

    await waitFor(() => expect(mocks.api).toHaveBeenCalledWith('/api/geo/recovery', expect.objectContaining({ method: 'POST' })));
    const recoveryCall = mocks.api.mock.calls.find(([path]) => path === '/api/geo/recovery')!;
    expect(JSON.parse(String(recoveryCall[1]?.body))).toMatchObject({ action: 'reconcile', operationId: 'op-pending' });
    await waitFor(() => expect(screen.queryByRole('button', { name: '重新同步已保存规则' })).toBeNull());
    expect(mocks.reloadShell).toHaveBeenCalledWith({
      geo: { enabled: true, countries: 1, degraded: false },
    });
  });

  it.each([
    ['网络丢响应', () => new TypeError('reconcile response lost')],
    ['geo-recovery-not-pending', async () => new ((await import('../src/api')).ApiError)(409, { error: 'geo-recovery-not-pending' })],
  ])('%s 后 GET 回读到 ready 时按真实成功收口，不叠加失败文案', async (_label, makeError) => {
    const pending = state(true, {
      status: 'pending', kind: 'update', operationId: 'op-already-finished', version: 2,
      currentFingerprint: 'target-fp', targetFingerprint: 'target-fp', previousFingerprint: 'previous-fp', startedAt: 1,
    });
    let reads = 0;
    mocks.reloadShell.mockResolvedValue({});
    mocks.api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/geo/recovery' && init?.method === 'POST') throw await makeError();
      if (path === '/api/geo') return reads++ === 0 ? pending : state(true);
      return {};
    });
    render(<GeoPage />);
    fireEvent.click(await screen.findByRole('button', { name: '重新同步已保存规则' }));

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('未收到同步响应，但重新读取已确认：规则已恢复就绪'));
    expect(screen.queryByRole('button', { name: '重新同步已保存规则' })).toBeNull();
    expect(screen.queryByText(/恢复操作没有完成/)).toBeNull();
    expect(mocks.reloadShell).toHaveBeenCalledWith({
      geo: { enabled: true, countries: 1, degraded: false },
    });
  });

  it('reconcile 返回 5xx 且回读仍 pending 时保留同一恢复状态', async () => {
    const ApiErrorCtor = (await import('../src/api')).ApiError;
    const pending = state(true, {
      status: 'pending', kind: 'update', operationId: 'op-still-pending', version: 2,
      currentFingerprint: 'target-fp', targetFingerprint: 'target-fp', previousFingerprint: 'previous-fp', startedAt: 1,
    });
    mocks.reloadShell.mockResolvedValue({});
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/geo/recovery' && init?.method === 'POST') {
        return Promise.reject(new ApiErrorCtor(503, { error: 'geo-update-recovery-required' }));
      }
      if (path === '/api/geo') return Promise.resolve(pending);
      return Promise.resolve({});
    });
    render(<GeoPage />);
    fireEvent.click(await screen.findByRole('button', { name: '重新同步已保存规则' }));

    expect(await screen.findByRole('button', { name: '重新同步已保存规则' })).toBeTruthy();
    expect(screen.queryByText(/恢复操作没有完成/)).toBeNull();
    expect(mocks.reloadShell).toHaveBeenCalledWith({
      geo: { enabled: true, countries: 1, degraded: true },
    });
  });

  it('reconcile 响应和权威回读都不可用时保留结果未知，不能宣称恢复失败', async () => {
    const pending = state(true, {
      status: 'pending', kind: 'update', operationId: 'op-recovery-unknown', version: 2,
      currentFingerprint: 'target-fp', targetFingerprint: 'target-fp', previousFingerprint: 'previous-fp', startedAt: 1,
    });
    let reads = 0;
    mocks.reloadShell.mockResolvedValue({});
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/geo/recovery' && init?.method === 'POST') return Promise.reject(new TypeError('offline'));
      if (path === '/api/geo' && reads++ === 0) return Promise.resolve(pending);
      return Promise.reject(new TypeError('offline'));
    });
    render(<GeoPage />);
    fireEvent.click(await screen.findByRole('button', { name: '重新同步已保存规则' }));

    expect(await screen.findByText('恢复结果暂时未知，不能断言待处理操作仍未完成。')).toBeTruthy();
    expect(screen.queryByText(/恢复尚未完成/)).toBeNull();
    expect(screen.getByRole('button', { name: '重新读取实际状态' })).toBeTruthy();
  });

  it('awaits shell synchronization and exposes a persistent warning when the confirmed rule cannot reach the shell', async () => {
    let finishShell!: (value: null) => void;
    mocks.reloadShell.mockReturnValue(new Promise((resolve) => { finishShell = resolve; }));
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/geo' && init?.method === 'PUT') {
        const operationId = String((JSON.parse(String(init.body)) as { operationId: string }).operationId);
        return Promise.resolve({
          ok: true,
          operationId,
          rules: { ...rules(true), updateOperationId: operationId },
          authority: { status: 'ready', source: 'd1', version: 2, currentFingerprint: 'ready-fingerprint-v2' },
        });
      }
      if (path === '/api/geo') return Promise.resolve(state(false));
      return Promise.resolve({});
    });
    render(<GeoPage />);
    await submitToggle();

    await waitFor(() => expect(mocks.reloadShell).toHaveBeenCalledWith({
      geo: { enabled: true, countries: 1, degraded: false },
    }));
    expect(mocks.toast).not.toHaveBeenCalled();

    await act(async () => finishShell(null));
    expect(await screen.findByText(/顶部全局状态暂时无法同步/)).toBeTruthy();
    expect(screen.getByText(/屏蔽生效中/)).toBeTruthy();
    expect(mocks.toast).toHaveBeenCalledWith('规则已保存并确认同步 · 约 1 分钟内全球生效；顶部全局状态暂时无法刷新');
  });

  it('reads back the actual state, recognizes an applied write, and refreshes the shell status', async () => {
    let reads = 0;
    let operationId = '';
    mocks.reloadShell.mockResolvedValue({});
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/geo' && init?.method === 'PUT') {
        operationId = String((JSON.parse(String(init.body)) as { operationId: string }).operationId);
        return Promise.reject(new TypeError('response lost'));
      }
      if (path === '/api/geo') {
        const enabled = reads++ > 0;
        const next = state(enabled, enabled
          ? { status: 'ready', source: 'd1', version: 2, currentFingerprint: 'ready-fingerprint-v2' }
          : undefined);
        return Promise.resolve(enabled ? { ...next, rules: { ...next.rules, updateOperationId: operationId } } : next);
      }
      return Promise.resolve({});
    });
    render(<GeoPage />);
    await submitToggle();

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('写入响应丢失，但重新读取确认规则已由本次操作写入并生效'));
    expect(screen.getByText(/屏蔽生效中/)).toBeTruthy();
    expect(screen.queryByText(/线上仍是旧规则/)).toBeNull();
    expect(mocks.reloadShell).toHaveBeenCalled();
  });

  it('响应丢失且回读到不同的 degraded 权威状态时，shell 使用真实 degraded 值', async () => {
    let reads = 0;
    mocks.reloadShell.mockResolvedValue({});
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/geo' && init?.method === 'PUT') return Promise.reject(new TypeError('response lost'));
      if (path === '/api/geo') {
        const next = state(false);
        return Promise.resolve(reads++ === 0 ? next : { ...next, degraded: true });
      }
      return Promise.resolve({});
    });
    render(<GeoPage />);
    await submitToggle();

    expect(await screen.findByText(/重新读取后确认线上不是本次规则/)).toBeTruthy();
    expect(mocks.reloadShell).toHaveBeenCalledWith({
      geo: { enabled: false, countries: 1, degraded: true },
    });
  });

  it('keeps the edit and reports an unknown result when neither response nor readback is available', async () => {
    let firstRead = true;
    mocks.reloadShell.mockResolvedValue({});
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path !== '/api/geo') return Promise.resolve({});
      if (!init?.method && firstRead) { firstRead = false; return Promise.resolve(state(false)); }
      return Promise.reject(new TypeError('offline'));
    });
    render(<GeoPage />);
    await submitToggle();

    expect(await screen.findByText('应用结果暂时未知，不能断言线上仍是旧规则。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新读取实际状态' })).toBeTruthy();
    expect(screen.getByText('应用结果待核实')).toBeTruthy();
    expect(screen.queryByText('改动未应用')).toBeNull();
  });

  it('does not let an old GET that resolves after a newer PUT overwrite the confirmed rules', async () => {
    let finishOldRead!: (value: ReturnType<typeof state>) => void;
    let reads = 0;
    mocks.reloadShell.mockResolvedValue({});
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/geo' && init?.method === 'PUT') {
        const operationId = String((JSON.parse(String(init.body)) as { operationId: string }).operationId);
        return Promise.resolve({
          ok: true,
          operationId,
          rules: { ...rules(true), updateOperationId: operationId },
          authority: { status: 'ready', source: 'd1', version: 2, currentFingerprint: 'ready-fingerprint-v2' },
        });
      }
      if (path === '/api/geo') {
        reads += 1;
        if (reads === 1) return new Promise((resolve) => { finishOldRead = resolve; });
        return Promise.resolve(state(false));
      }
      return Promise.resolve({});
    });

    renderPage(<StrictMode><MemoryRouter><GeoPage /></MemoryRouter></StrictMode>);
    await submitToggle();
    await waitFor(() => expect(screen.getByText(/屏蔽生效中/)).toBeTruthy());

    await act(async () => finishOldRead(state(false)));
    expect(screen.getByText(/屏蔽生效中/)).toBeTruthy();
    expect(screen.queryByText(/屏蔽未启用/)).toBeNull();
  });

  it('closes the old form while an explicit reload is pending', async () => {
    let finishReload!: (value: ReturnType<typeof state>) => void;
    let reads = 0;
    const ApiErrorCtor = (await import('../src/api')).ApiError;
    mocks.reloadShell.mockResolvedValue({});
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/geo' && init?.method === 'PUT') {
        return Promise.reject(new ApiErrorCtor(400, { error: 'bad-request' }));
      }
      if (path === '/api/geo') {
        reads += 1;
        if (reads === 1) return Promise.resolve(state(false));
        return new Promise((resolve) => { finishReload = resolve; });
      }
      return Promise.resolve({});
    });

    render(<GeoPage />);
    await submitToggle();
    const reload = await screen.findByRole('button', { name: '放弃并重新读取线上规则' });
    fireEvent.click(reload);

    await waitFor(() => expect(screen.queryByTitle('总开关')).toBeNull());
    expect(screen.queryByRole('button', { name: '应用变更(确认+理由)' })).toBeNull();
    await act(async () => finishReload(state(false)));
    expect(await screen.findByTitle('总开关')).toBeTruthy();
  });
});
