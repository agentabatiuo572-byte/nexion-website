// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mocks = vi.hoisted(() => ({ save: vi.fn() }));

vi.mock('../src/lib/use-focus-field', () => ({ useFocusField: () => {} }));
vi.mock('../src/lib/use-draft', () => ({
  useDraft: () => ({
    draft: {
      seo: {
        pages: {
          home: { title: { en: 'Home', vi: 'Home', zh: '首页' }, description: { en: 'Desc', vi: 'Desc', zh: '描述' } },
        },
      },
      footer: { contactEmail: '' },
    },
    saving: false,
    conflict: false,
    clearConflict: vi.fn(),
    save: mocks.save,
    reload: vi.fn(),
  }),
}));

import SeoPage from '../src/pages/seo';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SEO save race', () => {
  it('keeps text entered after the submitted snapshot while the save request is pending', async () => {
    let finishSave!: (ok: boolean) => void;
    mocks.save.mockReturnValueOnce(new Promise((resolve) => { finishSave = resolve; }));
    render(<MemoryRouter><SeoPage /></MemoryRouter>);
    const email = screen.getByPlaceholderText('例:ops@nexgrid.ai') as HTMLInputElement;

    fireEvent.change(email, { target: { value: 'first@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    fireEvent.change(email, { target: { value: 'second@example.com' } });
    await act(async () => finishSave(true));

    await waitFor(() => expect(email.value).toBe('second@example.com'));
    expect((screen.getByRole('button', { name: '保存草稿' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
