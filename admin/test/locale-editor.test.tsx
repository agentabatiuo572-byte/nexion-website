// @vitest-environment jsdom
import { act, type ComponentType } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ENABLED_LOCALES, LOCALES } from '../../schema/src/locales';
import type { SiteConfigView, Tri } from '../src/lib/use-draft';
import { applyDraftPatch } from '../../schema/src/draft-fields';
import type { SiteConfig } from '../../schema/src/site-config';
import manifest from '../../worker/seed/copy-manifest.json';

const mocks = vi.hoisted(() => ({ api: vi.fn(), toast: vi.fn(), reload: vi.fn(), overview: { draft: { payload: {} as SiteConfigView, draftRev: 1 }, live: { payload: {} as SiteConfigView } } }));
vi.mock('../src/api', () => ({ api: mocks.api, toast: mocks.toast, ApiError: class extends Error {} }));
vi.mock('../src/shell', () => ({ useShell: () => ({ overview: mocks.overview, reload: mocks.reload, failed: false }), useUnsavedChanges: () => {} }));

import ContentPage from '../src/pages/content';
import FaqPage from '../src/pages/faq';
import SkusPage from '../src/pages/skus';
import AnnouncementPage from '../src/pages/announcement';
import SeoPage from '../src/pages/seo';
import LegalPage from '../src/pages/legal';
import LanguagesPage from '../src/pages/languages';
import { parseFieldTarget, fieldEditorLink } from '../src/lib/field-target';
import { humanPath } from '../src/lib/human-path';

const translated = (text: string): Tri => Object.fromEntries(LOCALES.map((locale) => [locale, `${locale} ${text}`])) as Tri;
const fixture = (): SiteConfigView => ({
  enabledLocales: [...DEFAULT_ENABLED_LOCALES],
  copy: Object.fromEntries(LOCALES.map((locale) => [locale, { 'hero.title': `${locale} hero`, 'why.title': `${locale} why` }])) as SiteConfigView['copy'],
  downloads: { ios: { url: '', enabled: false }, android: { url: '', enabled: false }, h5: { url: '', enabled: false } },
  stats: { activeDevices: 1, activeJobs: 1, nodes: 1, countries: 1, uptime: 99, asOf: '2026-09' },
  skus: [{ id: 'phone', name: 'Phone', tagline: translated('tagline'), priceUSD: 1, multiplier: 1, status: 'active', sort: 1, visible: true }],
  faq: { items: [1, 2, 3].map((n) => ({ id: `q${n}`, q: translated(`question ${n}`), a: translated(`answer ${n}`), sort: n, visible: true })) },
  announcement: { id: 'notice', enabled: false, text: translated('announcement') },
  seo: { pages: Object.fromEntries(['home', 'learn', 'nex', 'legal-privacy', 'legal-terms', 'legal-app-privacy'].map((page) => [page, { title: translated(`${page} title`), description: translated(`${page} description`) }])) },
  footer: { social: [], contactEmail: '' },
  legal: { terms: { md: translated('terms'), updatedAt: '' }, privacy: { md: translated('privacy'), updatedAt: '' }, appPrivacy: { md: translated('appPrivacy'), updatedAt: '' } },
});
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const payload = fixture();
  mocks.overview = { draft: { payload, draftRev: 1 }, live: { payload: structuredClone(payload) } };
  mocks.api.mockImplementation(async (path: string, init: RequestInit) => {
    expect(path).toBe('/api/config/draft'); expect(init.method).toBe('PATCH');
    const body = JSON.parse(String(init.body));
    expect(body.baseRevision).toBe(mocks.overview.draft.draftRev);
    const result = applyDraftPatch(mocks.overview.draft.payload as SiteConfig, body.operations, manifest);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('patch rejected');
    mocks.overview = { ...mocks.overview, draft: { payload: result.config, draftRev: body.baseRevision + 1 } };
    return { draftRev: mocks.overview.draft.draftRev };
  });
  mocks.reload.mockImplementation(async () => mocks.overview);
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const editors: Array<[string, ComponentType, (config: SiteConfigView) => Tri | Record<string, string>]> = [
  ['content', ContentPage, (config) => Object.fromEntries(LOCALES.map((locale) => [locale, config.copy[locale]['hero.title']!]))],
  ['faq', FaqPage, (config) => config.faq.items[0]!.q],
  ['skus', SkusPage, (config) => config.skus[0]!.tagline],
  ['announcement', AnnouncementPage, (config) => config.announcement.text],
  ['seo', SeoPage, (config) => config.seo.pages.home!.title],
  ['legal', LegalPage, (config) => config.legal.terms.md],
];
describe('one target language across every draft editor', () => {
  it.each(editors)('%s preserves hidden edits, keeps reference read-only and saves all targets', async (_name, Page, values) => {
    let view = render(<MemoryRouter initialEntries={['/?lang=fr']}><Page /></MemoryRouter>);
    const expand = screen.queryAllByRole('button', { name: '编辑', exact: true });
    if (expand.length) fireEvent.click(expand[0]!);
    const before = structuredClone(values(mocks.overview.draft.payload));
    expect(view.container.querySelector('.locale-reference input,.locale-reference textarea')).toBeNull();
    expect(view.container.querySelector('.locale-reference')?.textContent).toContain(before.zh);
    expect((screen.getByLabelText('编辑语言') as HTMLSelectElement).options).toHaveLength(9);
    const edit = () => view.container.querySelector<HTMLTextAreaElement>('.locale-target textarea')!;
    expect(edit().lang).toBe('fr');
    for (const label of view.container.querySelectorAll('.locale-target label, .locale-reference > .kv')) {
      expect(label.closest('[lang]')?.getAttribute('lang')).toBe('zh');
    }
    fireEvent.change(edit(), { target: { value: 'French draft' } });
    fireEvent.change(screen.getByLabelText('编辑语言'), { target: { value: 'zh' } });
    fireEvent.change(edit(), { target: { value: '中文草稿' } });
    fireEvent.change(screen.getByLabelText('参考语言（只读）'), { target: { value: 'ja' } });
    expect(view.container.querySelector('.locale-reference')?.textContent).toContain(before.ja);
    fireEvent.change(screen.getByLabelText('编辑语言'), { target: { value: 'en' } });
    fireEvent.change(edit(), { target: { value: 'English edited' } });
    fireEvent.change(screen.getByLabelText('编辑语言'), { target: { value: 'fr' } });
    expect(edit().value).toBe('French draft');
    fireEvent.click(screen.getByRole('button', { name: '保存草稿', exact: true }));
    await waitFor(() => expect((screen.getByRole('button', { name: '保存草稿', exact: true }) as HTMLButtonElement).disabled).toBe(true));
    expect(values(mocks.overview.draft.payload)).toEqual({ ...before, fr: 'French draft', zh: '中文草稿', en: 'English edited' });
    expect(values(mocks.overview.live.payload)).toEqual(before);
    view.unmount();
    view = render(<MemoryRouter initialEntries={['/?lang=zh']}><Page /></MemoryRouter>);
    const reopened = screen.queryAllByRole('button', { name: '编辑', exact: true });
    if (reopened.length) fireEvent.click(reopened[0]!);
    expect(edit().value).toBe('中文草稿');
  });
});

it.each([
  ['copy.ja.why.title', ContentPage, 'copy.ja.why.title'],
  ['faq.q2.a.ko', FaqPage, 'faq.items.q2.a.ko'],
  ['faq.items[1].a.es', FaqPage, 'faq.items.q2.a.es'],
  ['skus.phone.tagline.pt', SkusPage, 'skus.phone.tagline.pt'],
  ['seo.learn.description.fr', SeoPage, 'seo.pages.learn.description.fr'],
  ['legal.privacy.de', LegalPage, 'legal.privacy.md.de'],
  ['announcement.text.zh', AnnouncementPage, 'announcement.text.zh'],
  ['/copy/fr/why.title', ContentPage, 'copy.fr.why.title'],
  ['/faq/items/q2/a/fr', FaqPage, 'faq.items.q2.a.fr'],
  ['/seo/pages/home/title/fr', SeoPage, 'seo.pages.home.title.fr'],
] as const)('opens the exact translated field from %s', async (path, Page, expected) => {
  const view = render(<MemoryRouter initialEntries={[`/?focus=${encodeURIComponent(path)}`]}><Page /></MemoryRouter>);
  await waitFor(() => expect((document.activeElement as HTMLElement)?.closest('[data-field]')?.getAttribute('data-field')).toBe(expected));
  expect((screen.getByLabelText('编辑语言') as HTMLSelectElement).value).toBe(parseFieldTarget(path).locale);
  expect(view.container.querySelectorAll('.locale-target')).not.toHaveLength(9);
});

it('locates an untranslated field outside the selected content group without dropping the work copy', async () => {
  mocks.overview.draft.payload.copy.ja['why.title'] = '';
  const view = render(<MemoryRouter initialEntries={['/?lang=ja']}><ContentPage /></MemoryRouter>);
  fireEvent.change(view.container.querySelector('textarea')!, { target: { value: '日本語の下書き' } });
  fireEvent.click(screen.getByRole('button', { name: '下一处待填写' }));
  await waitFor(() => expect(document.activeElement?.id).toBe('copy-why.title-ja'));
  fireEvent.change(screen.getByLabelText('选择文案板块'), { target: { value: 'hero' } });
  expect(screen.getByDisplayValue('日本語の下書き')).toBeTruthy();
});

it('saves public language selection only, keeps disabled translations and leaves the live state unchanged', async () => {
  let view = render(<MemoryRouter><LanguagesPage /></MemoryRouter>);
  const before = structuredClone(mocks.overview.draft.payload);
  expect((screen.getByLabelText(/英语/) as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByLabelText(/中文/) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByLabelText(/中文/));
  fireEvent.click(screen.getByLabelText(/日语/));
  fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
  await waitFor(() => expect(mocks.overview.draft.payload.enabledLocales).not.toContain('zh'));
  expect(mocks.overview.draft.payload.enabledLocales).not.toContain('ja');
  expect(mocks.overview.draft.payload.copy).toEqual(before.copy);
  expect(mocks.overview.live.payload).toEqual(before);
  view.unmount(); view = render(<MemoryRouter><LanguagesPage /></MemoryRouter>);
  expect((screen.getByLabelText(/中文/) as HTMLInputElement).checked).toBe(false);
  expect((screen.getByLabelText(/日语/) as HTMLInputElement).checked).toBe(false);
});

it('retains a language change made while an earlier selection is saving', async () => {
  let finish!: () => void;
  mocks.api.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
  render(<MemoryRouter><LanguagesPage /></MemoryRouter>);
  fireEvent.click(screen.getByLabelText(/中文/));
  fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
  fireEvent.click(screen.getByLabelText(/法语/));
  await act(async () => finish());
  expect((screen.getByLabelText(/法语/) as HTMLInputElement).checked).toBe(false);
  expect((screen.getByRole('button', { name: '保存草稿' }) as HTMLButtonElement).disabled).toBe(false);
});

it('names every language and routes language-setting findings to their owner', () => {
  for (const locale of LOCALES) expect(humanPath(`copy.${locale}.hero.title`)).not.toContain(`copy.${locale}`);
  expect(fieldEditorLink('enabledLocales')).toBe('/content/languages?focus=enabledLocales');
  expect(parseFieldTarget('faq.items').canonical).toBe('faq.items');
  expect(parseFieldTarget('seo.pages').canonical).toBe('seo.pages');
});

it('records same-value human intent after actual target editing', async () => {
  const view = render(<MemoryRouter initialEntries={['/?lang=fr']}><ContentPage /></MemoryRouter>);
  const input = view.container.querySelector<HTMLTextAreaElement>('.locale-target textarea')!;
  const original = input.value;
  fireEvent.change(input, { target: { value: 'Temporary edit' } });
  fireEvent.change(input, { target: { value: original } });
  fireEvent.click(screen.getByRole('button', { name: '保存草稿', exact: true }));
  await waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(1));
  expect(JSON.parse(mocks.api.mock.calls[0]![1].body).operations).toEqual([{ op: 'set', fieldId: '/copy/fr/hero.title', before: original, after: original }]);
});

it('keeps a blank target empty with an adjacent AI button without implicitly turning English into a save', async () => {
  mocks.overview.draft.payload.copy.fr['hero.title'] = '';
  const view = render(<MemoryRouter initialEntries={['/?lang=fr']}><ContentPage /></MemoryRouter>);
  expect(view.container.querySelector<HTMLTextAreaElement>('.locale-target textarea')!.value).toBe('');
  expect(screen.queryByText(/英语回退预览/)).toBeNull();
  expect(screen.getByRole('button', { name: 'AI 翻译' }).parentElement?.querySelector('label')?.textContent).toBe('法语');
  expect(mocks.api).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('选择文案板块'), { target: { value: 'why' } });
  fireEvent.change(view.container.querySelector('.locale-target textarea')!, { target: { value: 'French why edited' } });
  fireEvent.click(screen.getByRole('button', { name: '保存草稿', exact: true }));
  await waitFor(() => expect(mocks.overview.draft.payload.copy.fr['why.title']).toBe('French why edited'));
  expect(mocks.overview.draft.payload.copy.fr['hero.title']).toBe('');
  expect(JSON.parse(mocks.api.mock.calls[0]![1].body).operations.map((op: { fieldId: string }) => op.fieldId)).toEqual(['/copy/fr/why.title']);
});

it('preserves typing during FAQ save and carries only that new intent on the second save', async () => {
  let finish!: () => void;
  const normalApi = mocks.api.getMockImplementation()!;
  mocks.api.mockImplementationOnce(async (...args: unknown[]) => {
    await new Promise<void>((resolve) => { finish = resolve; });
    const response = await normalApi(...args);
    mocks.overview.draft.payload.faq.items[0]!.q.fr = 'Fresh AI French';
    mocks.overview.draft.draftRev++;
    return response;
  });
  const view = render(<MemoryRouter initialEntries={['/?lang=zh']}><FaqPage /></MemoryRouter>);
  fireEvent.click(screen.getAllByRole('button', { name: '编辑', exact: true })[0]!);
  const q = screen.getByLabelText('中文问题 · 源语言');
  fireEvent.change(q, { target: { value: 'First question edit' } });
  fireEvent.click(screen.getByRole('button', { name: '保存草稿', exact: true }));
  fireEvent.change(screen.getByLabelText('中文回答'), { target: { value: 'Typed during save' } });
  await act(async () => { finish(); });
  expect(screen.getByDisplayValue('Typed during save')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('编辑语言'), { target: { value: 'fr' } });
  expect(screen.getByDisplayValue('Fresh AI French')).toBeTruthy();
  // The request base remains the first submitted copy, while the server may be newer.
  mocks.api.mockImplementationOnce(async (_path: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    expect(body.operations).toEqual([{ op: 'set', fieldId: '/faq/items/q1/a/zh', before: 'zh answer 1', after: 'Typed during save' }]);
    const applied = applyDraftPatch(mocks.overview.draft.payload as SiteConfig, body.operations, manifest);
    expect(applied.ok).toBe(true);
    if (applied.ok) mocks.overview.draft.payload = applied.config;
    return { draftRev: ++mocks.overview.draft.draftRev };
  });
  fireEvent.click(screen.getByRole('button', { name: '保存草稿', exact: true }));
  await waitFor(() => expect((screen.getByRole('button', { name: '保存草稿', exact: true }) as HTMLButtonElement).disabled).toBe(true));
  expect(mocks.overview.draft.payload.faq.items[0]!.q.fr).toBe('Fresh AI French');
  expect(mocks.overview.draft.payload.faq.items[0]!.a.zh).toBe('Typed during save');
  view.unmount();
});

it.each([
  ['copy', ContentPage, 0, (d: SiteConfigView) => d.copy.fr['hero.title']],
  ['faq question', FaqPage, 0, (d: SiteConfigView) => d.faq.items[0]!.q.fr],
  ['faq answer', FaqPage, 1, (d: SiteConfigView) => d.faq.items[0]!.a.fr],
  ['sku tagline', SkusPage, 0, (d: SiteConfigView) => d.skus[0]!.tagline.fr],
  ['seo title', SeoPage, 0, (d: SiteConfigView) => d.seo.pages.home!.title.fr],
  ['seo description', SeoPage, 1, (d: SiteConfigView) => d.seo.pages.home!.description.fr],
  ['announcement', AnnouncementPage, 0, (d: SiteConfigView) => d.announcement.text.fr],
] as const)('%s translates current unsaved Chinese into its input and saves only after further human editing', async (_name, Page, index, valueOf) => {
  const view = render(<MemoryRouter initialEntries={['/?lang=zh']}><Page /></MemoryRouter>);
  const expand = screen.queryAllByRole('button', { name: '编辑', exact: true });
  if (expand.length) fireEvent.click(expand[0]!);
  const before = valueOf(mocks.overview.draft.payload);
  fireEvent.change(view.container.querySelectorAll('.locale-target textarea')[index]!, { target: { value: 'Current unsaved Chinese' } });
  fireEvent.change(screen.getByLabelText('编辑语言'), { target: { value: 'fr' } });
  const input = view.container.querySelectorAll<HTMLTextAreaElement>('.locale-target textarea')[index]!;
  const button = input.previousElementSibling!.querySelector<HTMLButtonElement>('button:last-of-type')!;
  expect(button.textContent).toBe('AI 翻译');
  expect(button.disabled).toBe(false);
  mocks.api.mockImplementationOnce(async (path: string, init: RequestInit) => {
    expect(path).toBe('/api/ai/translate'); expect(JSON.parse(String(init.body))).toEqual({ source: 'Current unsaved Chinese', targetLocale: 'fr' });
    return { text: 'French AI suggestion' };
  });
  fireEvent.click(button);
  await waitFor(() => expect(input.value).toBe('French AI suggestion'));
  expect(valueOf(mocks.overview.draft.payload)).toBe(before);
  expect(mocks.api.mock.calls.filter((call) => call[0] === '/api/config/draft')).toHaveLength(0);
  fireEvent.change(input, { target: { value: 'French refined by hand' } });
  fireEvent.click(screen.getByRole('button', { name: '保存草稿', exact: true }));
  await waitFor(() => expect(valueOf(mocks.overview.draft.payload)).toBe('French refined by hand'));
  expect(valueOf(mocks.overview.live.payload)).toBe(before);
});

it('preserves an intentional target clear after saving and reopening the editor', async () => {
  const view = render(<MemoryRouter initialEntries={['/?lang=fr']}><ContentPage /></MemoryRouter>);
  fireEvent.change(view.container.querySelector('.locale-target textarea')!, { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: '保存草稿', exact: true }));
  await waitFor(() => expect(mocks.overview.draft.payload.copy.fr['hero.title']).toBe(''));
  view.unmount();
  const reopened = render(<MemoryRouter initialEntries={['/?lang=fr']}><ContentPage /></MemoryRouter>);
  expect(reopened.container.querySelector<HTMLTextAreaElement>('.locale-target textarea')!.value).toBe('');
  expect(screen.getByRole('button', { name: 'AI 翻译' })).toBeTruthy();
  expect(mocks.api.mock.calls.every((call) => call[0] === '/api/config/draft')).toBe(true);
});

it('keeps another FAQ edit made while an AI suggestion for the question is pending', async () => {
  let finish!: (result: { text: string }) => void;
  const view = render(<MemoryRouter initialEntries={['/?lang=fr']}><FaqPage /></MemoryRouter>);
  fireEvent.click(screen.getAllByRole('button', { name: '编辑', exact: true })[0]!);
  mocks.api.mockImplementationOnce(async (path: string) => {
    expect(path).toBe('/api/ai/translate');
    return new Promise((resolve) => { finish = resolve; });
  });
  fireEvent.click(screen.getAllByRole('button', { name: 'AI 翻译' })[0]!);
  fireEvent.change(screen.getByLabelText('法语回答'), { target: { value: 'Answer typed while waiting' } });
  await act(async () => finish({ text: 'AI question suggestion' }));
  expect(screen.getByDisplayValue('Answer typed while waiting')).toBeTruthy();
  expect(screen.getByDisplayValue('AI question suggestion')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '保存草稿', exact: true }));
  await waitFor(() => expect(mocks.overview.draft.payload.faq.items[0]!.q.fr).toBe('AI question suggestion'));
  expect(mocks.overview.draft.payload.faq.items[0]!.a.fr).toBe('Answer typed while waiting');
  view.unmount();
});

it('merges two FAQ suggestions completed in the same React batch and saves both fields', async () => {
  const finish: Array<(result: { text: string }) => void> = [];
  const normalApi = mocks.api.getMockImplementation()!;
  mocks.api.mockImplementation(async (path: string, init: RequestInit) => {
    if (path !== '/api/ai/translate') return normalApi(path, init);
    return new Promise((resolve) => { finish.push(resolve); });
  });
  render(<MemoryRouter initialEntries={['/?lang=fr']}><FaqPage /></MemoryRouter>);
  fireEvent.click(screen.getAllByRole('button', { name: '编辑', exact: true })[0]!);
  const buttons = screen.getAllByRole('button', { name: 'AI 翻译' });
  fireEvent.click(buttons[0]!); fireEvent.click(buttons[1]!);
  expect(finish).toHaveLength(2);
  await act(async () => {
    finish[0]!({ text: 'Question suggestion' });
    finish[1]!({ text: 'Answer suggestion' });
  });
  expect((screen.getByLabelText('法语问题') as HTMLTextAreaElement).value).toBe('Question suggestion');
  expect((screen.getByLabelText('法语回答') as HTMLTextAreaElement).value).toBe('Answer suggestion');
  fireEvent.click(screen.getByRole('button', { name: '保存草稿', exact: true }));
  await waitFor(() => expect(mocks.overview.draft.payload.faq.items[0]!.q.fr).toBe('Question suggestion'));
  expect(mocks.overview.draft.payload.faq.items[0]!.a.fr).toBe('Answer suggestion');
});
