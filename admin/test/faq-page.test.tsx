// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, fireEvent, render as renderPage, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const render = (node: ReactNode) => renderPage(<MemoryRouter>{node}</MemoryRouter>);

const mocks = vi.hoisted(() => ({ api: vi.fn(), save: vi.fn() }));

vi.mock('../src/api', () => ({ api: mocks.api }));
vi.mock('../src/lib/use-focus-field', () => ({ useFocusField: () => {} }));
vi.mock('../src/lib/use-draft', () => ({
  pointer: (...parts: string[]) => '/' + parts.join('/'),
  useDraft: () => ({
    draft: {
      faq: {
        items: [1, 2, 3].map((n) => ({
          id: `faq-${n}`,
          q: { en: n === 1 ? 'before' : `question ${n}`, vi: `q vi ${n}`, zh: `问 ${n}` },
          a: { en: `answer ${n}`, vi: `a vi ${n}`, zh: `答 ${n}` },
          sort: n,
          visible: true,
        })),
      },
    },
    live: { faq: { items: [] } },
    saving: false,
    conflict: false,
    clearConflict: vi.fn(),
    save: mocks.save,
    reload: vi.fn(),
  }),
}));

import FaqPage from '../src/pages/faq';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('FAQ add flow', () => {
  it('keeps edits made while mint-id is pending and appends the new row to that latest copy', async () => {
    let resolveMint!: (value: { id: string }) => void;
    mocks.api.mockReturnValueOnce(new Promise((resolve) => { resolveMint = resolve; }));
    const view = render(<FaqPage />);

    fireEvent.click(screen.getByRole('button', { name: /新增条目/ }));
    fireEvent.click(screen.getAllByRole('button', { name: '编辑' })[0]!);
    const firstQuestion = view.container.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(firstQuestion, { target: { value: 'edited while waiting' } });

    await act(async () => resolveMint({ id: 'faq-new' }));

    expect(screen.getByText('edited while waiting')).toBeTruthy();
    expect(screen.getByText('(新条目,未填)')).toBeTruthy();
  });

  it('shows a retryable error instead of leaking an unhandled rejection', async () => {
    mocks.api.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<FaqPage />);
    fireEvent.click(screen.getByRole('button', { name: /新增条目/ }));

    expect((await screen.findByRole('alert')).textContent).toContain('现有编辑已保留');
    await waitFor(() => expect((screen.getByRole('button', { name: '重试新增' }) as HTMLButtonElement).disabled).toBe(false));
  });
});
