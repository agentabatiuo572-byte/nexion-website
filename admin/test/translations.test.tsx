// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ api: vi.fn(), changed: vi.fn() }));
vi.mock('../src/api', () => ({ api: mocks.api, ApiError: class extends Error { constructor(public status: number, public body: Record<string, unknown>) { super(); } } }));
import { DefaultTranslationActions, TranslationProvider, TranslationTasks, type TranslationOverview } from '../src/lib/translations';
import { TranslatedTextarea } from '../src/lib/translated-textarea';

const fixture = (): TranslationOverview => ({ draftRev: 9, counts: { missing: 1, manualReview: 1 }, nextCursor: null, items: [], states: [{
  fieldId: '/copy/hero.title', targetLocale: 'fr', draftFieldId: '/copy/fr/hero.title', origin: 'manual', generation: 3,
  stale: false, reviewNeeded: true, missing: false, sourceHash: 'current-source-hash', targetValue: 'French text', required: true,
}] });
let overview: TranslationOverview;
beforeEach(() => { overview = fixture(); mocks.api.mockImplementation(async (_path: string, init?: RequestInit) => { if (init?.method) throw new Error('unexpected mutation'); return overview; }); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const wrap = (children: React.ReactNode) => <MemoryRouter><TranslationProvider draftRevision={9} onDraftChanged={mocks.changed}>{children}</TranslationProvider></MemoryRouter>;

it('renders the saved default directly in the input without implicit filling or confirmation controls', async () => {
  overview.states[0]!.origin = 'seed';
  const view = render(wrap(<TranslatedTextarea id="target" label="法语" targetLocale="fr" draftFieldId="/copy/fr/hero.title" value="French text" source="New English" onValueChange={vi.fn()} />));
  await screen.findByText('默认译文');
  expect((screen.getByLabelText('法语') as HTMLTextAreaElement).value).toBe('French text');
  expect(screen.queryByRole('button', { name: '保留现译' })).toBeNull();
  view.rerender(wrap(<TranslatedTextarea id="target" label="法语" targetLocale="fr" draftFieldId="/copy/fr/hero.title" value="" source="New English" onValueChange={vi.fn()} />));
  expect((screen.getByLabelText('法语') as HTMLTextAreaElement).value).toBe('');
  expect(screen.queryByText(/英语回退预览/)).toBeNull();
  expect(mocks.api.mock.calls.filter((call) => call[1]?.method)).toHaveLength(0);
});

it('previews defaults without applying and applies on one explicit click then refreshes', async () => {
  render(wrap(<DefaultTranslationActions onChanged={mocks.changed} />));
  await waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(1));
  mocks.api.mockImplementationOnce(async (path: string, init: RequestInit) => {
    expect(path).toBe('/api/translations/defaults'); expect(JSON.parse(String(init.body))).toEqual({ dryRun: true });
    return { applied: 1482, skipped: 0, draftRev: 9 };
  });
  fireEvent.click(screen.getByRole('button', { name: '查看可补齐默认文案' }));
  const apply = await screen.findByRole('button', { name: '补齐默认文案', exact: true });
  expect(mocks.changed).not.toHaveBeenCalled();
  mocks.api.mockImplementationOnce(async (_path: string, init: RequestInit) => {
    expect(JSON.parse(String(init.body))).toEqual({ dryRun: false }); return { applied: 1482, skipped: 0, draftRev: 10 };
  });
  fireEvent.click(apply);
  expect(await screen.findByText('已补齐 1482 项默认译文 · 草稿 r10 · 未发布')).toBeTruthy();
  await waitFor(() => expect(mocks.changed).toHaveBeenCalledTimes(1));
  expect(mocks.api.mock.calls.filter((call) => call[1]?.method)).toHaveLength(2);
});

it('queues one bounded language batch without mixing other languages', async () => {
  overview.enabledLocales = ['zh', 'fr', 'ja']; overview.batchLimit = 50;
  overview.states = [
    ...overview.states,
    { fieldId: '/copy/hero.note', targetLocale: 'fr', draftFieldId: '/copy/fr/hero.note', origin: 'none', generation: 0,
      stale: false, missing: true, sourceHash: 'fr-note', targetValue: '', required: true },
    { fieldId: '/copy/hero.body', targetLocale: 'fr', draftFieldId: '/copy/fr/hero.body', origin: 'none', generation: 0,
      stale: false, missing: true, sourceHash: 'fr-body', targetValue: '', required: true },
    { fieldId: '/copy/hero.note', targetLocale: 'ja', draftFieldId: '/copy/ja/hero.note', origin: 'none', generation: 0,
      stale: false, missing: true, sourceHash: 'ja-note', targetValue: '', required: true },
  ];
  render(wrap(<DefaultTranslationActions onChanged={mocks.changed} />));
  const action = await screen.findByRole('button', { name: '为法语建立本批，共 2 项' });
  mocks.api.mockImplementationOnce(async (path: string, init: RequestInit) => {
    expect(path).toBe('/api/translations');
    expect(JSON.parse(String(init.body))).toEqual({ mode: 'missing', targetLocale: 'fr', limit: 50 });
    return { queued: 2, targetLocale: 'fr' };
  });
  fireEvent.click(action);
  expect(await screen.findByText('已为法语建立本批 2 项；后台按语种逐批处理，译文写入草稿后仍需发布。')).toBeTruthy();
  await waitFor(() => expect(mocks.changed).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('button', { name: '为日语建立本批，共 1 项' })).toBeTruthy();
});

it('names each language action and keeps an active language to one queued batch', async () => {
  overview.enabledLocales = ['zh', 'fr']; overview.batchLimit = 50;
  overview.states = [
    { fieldId: '/copy/hero.note', targetLocale: 'fr', draftFieldId: '/copy/fr/hero.note', origin: 'none', generation: 1,
      stale: false, missing: true, sourceHash: 'fr-note', targetValue: '', required: true, jobStatus: 'pending' },
    { fieldId: '/copy/hero.body', targetLocale: 'fr', draftFieldId: '/copy/fr/hero.body', origin: 'none', generation: 0,
      stale: false, missing: true, sourceHash: 'fr-body', targetValue: '', required: true },
  ];
  render(wrap(<DefaultTranslationActions />));
  const action = await screen.findByRole('button', { name: '法语：已入队，等待处理' });
  expect((action as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('待补 2 · 排队 1 · 处理中 0')).toBeTruthy();
});

it('uses exact retry baseline and readable task errors', async () => {
  overview.items = [{ id: 'task-a', status: 'failed', fieldId: '/copy/hero.title', targetLocale: 'fr', intent: 'manual', errorCode: 'connection-changed', sourceHash: 'current-source-hash', targetValue: 'French text', createdAt: 0, updatedAt: 0, attempts: 1, canRetry: true }];
  render(wrap(<TranslationTasks />));
  expect(await screen.findByText('连接已切换，旧结果失效')).toBeTruthy();
  expect(decodeURIComponent(screen.getByRole('link').getAttribute('href')!)).toBe('/content?focus=/copy/fr/hero.title');
  mocks.api.mockImplementationOnce(async (path: string, init: RequestInit) => {
    expect(path).toBe('/api/translations/retry'); expect(JSON.parse(String(init.body))).toEqual({ items: [{ id: 'task-a', sourceHash: 'current-source-hash', targetValue: 'French text' }] }); return { queued: 1 };
  });
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  await waitFor(() => expect(mocks.api.mock.calls.filter((call) => call[1]?.method)).toHaveLength(1));
});

it('shows the current field failure even outside the first job page and ignores older failed jobs', async () => {
  overview.states[0]!.jobStatus = 'failed'; overview.states[0]!.jobErrorCode = 'invalid-result';
  const view = render(wrap(<><TranslatedTextarea id="target" label="法语" targetLocale="fr" draftFieldId="/copy/fr/hero.title" value="French text" source="New English" onValueChange={vi.fn()} /><TranslationTasks /></>));
  expect(await screen.findByText('自动翻译失败，可重试')).toBeTruthy();
  overview = structuredClone(overview); overview.states[0]!.jobStatus = null; overview.states[0]!.jobErrorCode = null;
  overview.items = [{ id: 'old-task', status: 'failed', fieldId: '/copy/hero.title', targetLocale: 'fr', intent: 'auto', errorCode: 'invalid-result', sourceHash: 'current-source-hash', targetValue: 'French text', createdAt: 0, updatedAt: 0, attempts: 1, canRetry: false }];
  fireEvent.click(screen.getByRole('button', { name: '刷新任务' }));
  await waitFor(() => expect(view.container.querySelector('.translation-input-label')!.textContent).not.toContain('翻译失败'));
});
