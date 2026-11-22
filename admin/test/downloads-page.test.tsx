// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mocks = vi.hoisted(() => ({ save: vi.fn(), reload: vi.fn() }));
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

describe('download draft settings', () => {
  it('labels enabled draft settings separately from the published website', () => {
    render(<DownloadsPage />);
    expect(screen.getByText('草稿已开启')).toBeTruthy();
    expect(screen.queryByText('已上线')).toBeNull();
    expect((screen.getByLabelText('iOS 链接') as HTMLInputElement).value).toBe('https://saved.example/ios');
  });
});
