// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mocks = vi.hoisted(() => ({ api: vi.fn(), save: vi.fn(), reload: vi.fn(), toast: vi.fn() }));
vi.mock('../src/api', () => {
  class ApiError extends Error {
    constructor(public status: number, public body: Record<string, unknown>) { super(String(body.error ?? status)); }
  }
  return { ApiError, api: mocks.api, toast: mocks.toast };
});
vi.mock('../src/lib/use-focus-field', () => ({ useFocusField: () => {} }));
vi.mock('../src/lib/use-draft', () => ({
  useDraft: () => ({
    draft: {
      downloads: {
        ios: { url: 'https://saved.example/ios', enabled: true },
        android: { url: '', enabled: false },
        h5: { url: '', enabled: false },
      },
    },
    draftRev: 7,
    saving: false,
    conflict: false,
    save: mocks.save,
    reload: mocks.reload,
  }),
}));

import DownloadsPage from '../src/pages/downloads';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('download probe identity', () => {
  it('labels enabled draft settings separately from the published website', () => {
    render(<DownloadsPage />);
    expect(screen.getByText('草稿已开启')).toBeTruthy();
    expect(screen.queryByText('已上线')).toBeNull();
    expect((screen.getByLabelText('iOS 链接') as HTMLInputElement).value).toBe('https://saved.example/ios');
  });

  it('labels results as the saved draft and hides them as soon as local input diverges', async () => {
    mocks.api.mockResolvedValue({ ios: { ok: true, status: 200 }, android: { skipped: true }, h5: { skipped: true }, at: 1, draftRev: 7 });
    render(<DownloadsPage />);
    const probeButton = screen.getByRole('button', { name: '立即探活（已保存草稿）' }) as HTMLButtonElement;

    fireEvent.click(probeButton);
    expect(await screen.findByText('可达 200')).toBeTruthy();
    expect(mocks.api).toHaveBeenCalledWith('/api/config/probe-downloads', {
      method: 'POST',
      body: JSON.stringify({ expectedDraftRev: 7 }),
    });
    expect(screen.getByText(/已保存草稿 r7/)).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('App Store URL(https://…)'), { target: { value: 'https://new.example/ios' } });
    await waitFor(() => expect(screen.queryByText('可达 200')).toBeNull());
    expect(probeButton.disabled).toBe(true);
    expect(probeButton.title).toContain('探活检查的是已保存草稿');
  });

  it('discards a probe response whose server revision differs and refreshes the draft', async () => {
    mocks.api.mockResolvedValue({ ios: { ok: true, status: 200 }, at: 1, draftRev: 8 });
    mocks.reload.mockResolvedValue({});
    render(<DownloadsPage />);

    fireEvent.click(screen.getByRole('button', { name: '立即探活（已保存草稿）' }));
    await waitFor(() => expect(mocks.reload).toHaveBeenCalledTimes(1));

    expect(screen.queryByText('可达 200')).toBeNull();
    expect(mocks.toast).toHaveBeenCalledWith('探活结果属于草稿 r8，不是当前看到的 r7；已丢弃并刷新');
  });
});
