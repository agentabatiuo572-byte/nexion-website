// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import seedJson from '../../worker/seed/site-config.seed.json';
import type { SiteConfigView } from '../src/lib/use-draft';

const mocks = vi.hoisted(() => ({ api: vi.fn(), reload: vi.fn(), overview: null as any }));
vi.mock('../src/api', () => ({ api: mocks.api, toast: vi.fn(), ApiError: class ApiError extends Error { constructor(public status: number, public body: any) { super(); } } }));
vi.mock('../src/shell', () => ({ useShell: () => ({ overview: mocks.overview, reload: mocks.reload, failed: false }), useUnsavedChanges: vi.fn() }));
import { useDraft } from '../src/lib/use-draft';
import { mergeWorkingValue } from '../src/lib/async-state';

beforeEach(() => {
  mocks.overview = { draft: { payload: structuredClone(seedJson), draftRev: 1 }, live: { payload: structuredClone(seedJson) } };
  mocks.api.mockResolvedValue({ draftRev: 3 });
  mocks.reload.mockImplementation(async () => mocks.overview);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const edits: Array<[string, (draft: SiteConfigView) => void, string]> = [
  ['content', (d) => { d.copy.fr['hero.scrollHint'] = 'new copy'; }, '/copy/fr/hero.scrollHint'],
  ['languages', (d) => { d.enabledLocales = ['en', 'fr']; }, '/enabledLocales'],
  ['downloads', (d) => { d.downloads.ios.url = 'https://example.com/new'; }, '/downloads/ios/url'],
  ['stats', (d) => { d.stats.activeJobs++; }, '/stats/activeJobs'],
  ['skus', (d) => { d.skus[0]!.tagline.fr = 'new tagline'; }, `/skus/${seedJson.skus[0]!.id}/tagline/fr`],
  ['faq', (d) => { d.faq.items[0]!.q.fr = 'new question'; }, `/faq/items/${seedJson.faq.items[0]!.id}/q/fr`],
  ['announcement', (d) => { d.announcement.text.fr = 'new announcement'; }, '/announcement/text/fr'],
  ['seo', (d) => { d.seo.pages.home!.title.fr = 'new title'; }, '/seo/pages/home/title/fr'],
  ['legal', (d) => { d.legal.terms.md.fr = '# New terms'; }, '/legal/terms/md/fr'],
];

describe('every useDraft consumer carries edit-start intent', () => {
  it.each(edits)('%s saves PATCH from its frozen baseline while another field is updated', async (_page, mutate, fieldId) => {
    const hook = renderHook(({ dirty }) => useDraft(dirty), { initialProps: { dirty: false } });
    hook.rerender({ dirty: true });
    mocks.overview = structuredClone(mocks.overview);
    mocks.overview.draft.payload.copy.de['hero.scrollHint'] = 'AI increment';
    mocks.overview.draft.draftRev = 2;
    hook.rerender({ dirty: true });
    await act(async () => { expect(await hook.result.current.save(mutate)).toBe(true); });
    const [url, request] = mocks.api.mock.calls[0]!;
    expect(url).toBe('/api/config/draft'); expect(request.method).toBe('PATCH');
    const body = JSON.parse(request.body);
    expect(body.baseRevision).toBe(1);
    expect(body.operations).toHaveLength(1);
    expect(body.operations[0].fieldId).toBe(fieldId);
    expect(body.operations.some((operation: any) => operation.fieldId === '/copy/de/hero.scrollHint')).toBe(false);
  });

  it('a retained FAQ whole-array copy has only post-submit edits on the second save', async () => {
    const hook = renderHook(({ dirty }) => useDraft(dirty), { initialProps: { dirty: false } });
    const initial = structuredClone(mocks.overview.draft.payload) as SiteConfigView;
    const submitted = structuredClone(initial.faq.items);
    submitted[0]!.q.en = 'submitted question';
    hook.rerender({ dirty: true });
    let complete!: (response: { draftRev: number }) => void;
    mocks.api.mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
    let first!: Promise<boolean>;
    act(() => { first = hook.result.current.save((d) => { d.faq.items = submitted; }); });
    const later = structuredClone(submitted); later[0]!.a.en = 'typed while saving';
    mocks.overview = structuredClone(mocks.overview);
    mocks.overview.draft.payload.faq.items = structuredClone(submitted);
    mocks.overview.draft.payload.faq.items[0].a.fr = 'AI added French answer';
    mocks.overview.draft.draftRev = 3;
    await act(async () => { complete({ draftRev: 2 }); expect(await first).toBe(true); });
    hook.rerender({ dirty: true });
    await act(async () => { expect(await hook.result.current.save((d) => { d.faq.items = later; })).toBe(true); });
    const second = JSON.parse(mocks.api.mock.calls[1]![1].body);
    expect(second.baseRevision).toBe(2);
    expect(second.operations).toEqual([{ op: 'set', fieldId: `/faq/items/${initial.faq.items[0]!.id}/a/en`, before: initial.faq.items[0]!.a.en, after: 'typed while saving' }]);
  });

  it('working FAQ display shows fresh untouched AI text without relabelling it as an edit', () => {
    const baseline = structuredClone(seedJson.faq.items), working = structuredClone(baseline), latest = structuredClone(baseline);
    working[0]!.q.en = 'local typing'; latest[0]!.a.fr = 'fresh AI';
    const shown = mergeWorkingValue(baseline, working, latest);
    expect(shown[0]!.q.en).toBe('local typing'); expect(shown[0]!.a.fr).toBe('fresh AI');
    expect(working[0]!.a.fr).toBe(baseline[0]!.a.fr);
  });
});
