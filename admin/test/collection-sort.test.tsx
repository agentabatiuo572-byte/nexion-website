// @vitest-environment jsdom
import { cleanup, fireEvent, render as renderPage, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SiteConfigView } from '../src/lib/use-draft';
import type { SiteConfig } from '../../schema/src/site-config';
import { LOCALES } from '../../schema/src/locales';
import { applyDraftPatch } from '../../schema/src/draft-fields';
import manifest from '../../worker/seed/copy-manifest.json';
import seed from '../../worker/seed/site-config.seed.json';
const render = (node: ReactNode) => renderPage(<MemoryRouter>{node}</MemoryRouter>);

const mocks = vi.hoisted(() => ({
  api: vi.fn(), toast: vi.fn(), reload: vi.fn(),
  overview: { draft: { payload: {} as SiteConfigView, draftRev: 7 }, live: { payload: {} as SiteConfigView } },
}));
vi.mock('../src/api', () => ({ api: mocks.api, toast: mocks.toast, ApiError: class extends Error {} }));
vi.mock('../src/shell', () => ({
  useShell: () => ({ overview: mocks.overview, reload: mocks.reload, failed: false }),
  useUnsavedChanges: () => {},
}));
vi.mock('../src/lib/use-focus-field', () => ({ useFocusField: () => {} }));

import SkusPage from '../src/pages/skus';
import FaqPage from '../src/pages/faq';

const tri = (text: string) => Object.fromEntries(LOCALES.map((locale) => [locale, text]));

beforeEach(() => {
  const payload = {
    ...structuredClone(seed),
    skus: [1, 2, 3, 4].map((n) => ({ id: `sku-${n}`, name: `Product ${n}`, priceUSD: 20, multiplier: 1, status: 'active', tagline: tri(`tag ${n}`), sort: n, visible: true })),
    faq: { items: [1, 2, 3, 4, 5].map((n) => ({ id: `faq-${n}`, q: tri(`question ${n}`), a: tri(`answer ${n}`), sort: n, visible: true, ...(n === 5 ? { deleted: true } : {}) })) },
  } as SiteConfigView;
  mocks.overview = { draft: { payload, draftRev: 7 }, live: { payload: structuredClone(payload) } };
  mocks.api.mockImplementation(async (path: string, init: RequestInit) => {
    expect(path).toBe('/api/config/draft');
    expect(init.method).toBe('PATCH');
    const body = JSON.parse(String(init.body));
    expect(body.baseRevision).toBe(mocks.overview.draft.draftRev);
    const applied = applyDraftPatch(mocks.overview.draft.payload as SiteConfig, body.operations, manifest);
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error('patch rejected');
    mocks.overview = { ...mocks.overview, draft: { payload: applied.config, draftRev: body.baseRevision + 1 } };
    return { draftRev: mocks.overview.draft.draftRev };
  });
  mocks.reload.mockImplementation(async () => mocks.overview);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('collection sort buttons', () => {
  it('moves product cards in both directions, retains same-card focus at boundaries and saves the visible order', async () => {
    let view = render(<SkusPage />);
    const moveUp = screen.getByRole('button', { name: '上移 Product 3' });
    moveUp.focus();
    fireEvent.click(moveUp, { detail: 0 });
    expect(document.activeElement).toBe(moveUp);
    fireEvent.click(moveUp, { detail: 0 });
    expect((moveUp as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '下移 Product 3' }));
    const moveDown = screen.getByRole('button', { name: '下移 Product 3' });
    fireEvent.click(moveDown, { detail: 0 });
    fireEvent.click(moveDown, { detail: 0 });
    fireEvent.click(moveDown, { detail: 0 });
    expect((moveDown as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement).toBe(moveUp);
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect((screen.getByRole('button', { name: '保存草稿' }) as HTMLButtonElement).disabled).toBe(true));
    expect(mocks.overview.draft.payload.skus.map((sku) => [sku.id, sku.sort])).toEqual([
      ['sku-1', 1], ['sku-2', 2], ['sku-3', 4], ['sku-4', 3],
    ]);
    view.unmount();
    view = render(<SkusPage />);
    expect([...view.container.querySelectorAll('[draggable]')].map((card) => card.getAttribute('data-field'))).toEqual(['skus.sku-1', 'skus.sku-2', 'skus.sku-4', 'skus.sku-3']);
  });

  it('saves FAQ button order and retains the deleted item unchanged and restorable after reload', async () => {
    const deletedBefore = structuredClone(mocks.overview.draft.payload.faq.items[4]);
    let view = render(<FaqPage />);
    const card = view.container.querySelector('[data-field="faq.items.faq-3"]') as HTMLElement;
    const moveUp = within(card).getByRole('button', { name: '上移第 3 条问答' });
    const moveDown = within(card).getByRole('button', { name: '下移第 3 条问答' });
    moveUp.focus();
    fireEvent.click(moveUp, { detail: 0 });
    expect(document.activeElement).toBe(moveUp);
    fireEvent.click(moveUp, { detail: 0 });
    expect((moveUp as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement).toBe(moveDown);
    fireEvent.click(moveDown, { detail: 0 });
    fireEvent.click(moveDown, { detail: 0 });
    fireEvent.click(moveDown, { detail: 0 });
    expect((moveDown as HTMLButtonElement).disabled).toBe(true);
    expect(document.activeElement).toBe(moveUp);
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect((screen.getByRole('button', { name: '保存草稿' }) as HTMLButtonElement).disabled).toBe(true));
    expect(mocks.overview.draft.payload.faq.items.map((item) => [item.id, item.sort])).toEqual([
      ['faq-1', 1], ['faq-2', 2], ['faq-4', 3], ['faq-3', 4], ['faq-5', 5],
    ]);
    expect(mocks.overview.draft.payload.faq.items[4]).toEqual(deletedBefore);
    view.unmount();
    view = render(<FaqPage />);
    expect([...view.container.querySelectorAll('[draggable]')].map((item) => item.getAttribute('data-field'))).toEqual(['faq.items.faq-1', 'faq.items.faq-2', 'faq.items.faq-4', 'faq.items.faq-3']);
    fireEvent.click(screen.getByRole('button', { name: '恢复(回末位)' }));
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(2));
    expect(mocks.overview.draft.payload.faq.items[4]).toEqual({ ...deletedBefore, deleted: false });
  });
});
