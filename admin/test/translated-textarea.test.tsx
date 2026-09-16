// @vitest-environment jsdom
import { act, useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Locale } from '../../schema/src/locales';
const mocks = vi.hoisted(() => ({ api: vi.fn(), toast: vi.fn() }));
vi.mock('../src/api', () => ({ api: mocks.api, toast: mocks.toast, ApiError: class extends Error { constructor(public status: number, public body: Record<string, unknown>) { super(); } } }));
import { ApiError } from '../src/api';
import { TranslatedTextarea } from '../src/lib/translated-textarea';
import { getTextLimit } from '../src/lib/text-limits';

function Editor() {
  const [value, setValue] = useState('Saved translation'), [source, setSource] = useState('Current English'), [locale, setLocale] = useState<Locale>('fr');
  return <><label>English<input value={source} onChange={(event) => setSource(event.target.value)} /></label>
    <label>Locale<select value={locale} onChange={(event) => setLocale(event.target.value as Locale)}><option>fr</option><option>ja</option></select></label>
    <TranslatedTextarea id="target" label="Target" draftFieldId={`/copy/${locale}/hero.title`} targetLocale={locale} source={source} value={value} onValueChange={setValue} />
  </>;
}
beforeEach(() => { mocks.api.mockReset(); mocks.toast.mockReset(); });
afterEach(cleanup);
const target = () => screen.getByLabelText('Target') as HTMLTextAreaElement;

it('one click fills a local editable suggestion without calling the draft or task API', async () => {
  mocks.api.mockResolvedValue({ text: 'AI suggestion' });
  render(<Editor />);
  expect(mocks.api).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'AI 翻译' }));
  await waitFor(() => expect(target().value).toBe('AI suggestion'));
  expect(mocks.api).toHaveBeenCalledTimes(1);
  const [path, init] = mocks.api.mock.calls[0]!;
  expect(path).toBe('/api/ai/translate'); expect(JSON.parse(init.body)).toEqual({ source: 'Current English', targetLocale: 'fr' });
  fireEvent.change(target(), { target: { value: 'Human refined' } });
  expect(target().value).toBe('Human refined');
});

it.each(['target', 'source', 'locale'] as const)('drops a late result when %s changes, including a change back to the original', async (kind) => {
  let finish!: (result: { text: string }) => void;
  mocks.api.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  render(<Editor />);
  fireEvent.click(screen.getByRole('button', { name: 'AI 翻译' }));
  expect(target().disabled).toBe(false);
  const input = kind === 'target' ? target() : screen.getByLabelText(kind === 'source' ? 'English' : 'Locale');
  const original = (input as HTMLInputElement).value;
  fireEvent.change(input, { target: { value: kind === 'locale' ? 'ja' : 'Changed while waiting' } });
  fireEvent.change(input, { target: { value: original } });
  await act(async () => finish({ text: 'Late suggestion' }));
  expect(target().value).toBe('Saved translation');
  expect(screen.getByText('内容已修改，本次译文未填入，已保留当前输入。')).toBeTruthy();
});

it('keeps a deliberate empty target through failure and never restores English', async () => {
  mocks.api.mockRejectedValue(new ApiError(429, { message: '今日翻译额度已用完。' }));
  render(<Editor />); fireEvent.change(target(), { target: { value: '' } });
  expect(screen.getByRole('button', { name: '缺译' }).nextElementSibling?.textContent).toBe('AI 翻译');
  fireEvent.click(screen.getByRole('button', { name: 'AI 翻译' }));
  await screen.findByText('今日翻译额度已用完。');
  expect(target().value).toBe('');
  expect(mocks.api).toHaveBeenCalledTimes(1);
});

it('does not apply a result after changing the editing location', async () => {
  let finish!: (result: { text: string }) => void;
  const onValueChange = vi.fn();
  mocks.api.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const view = render(<TranslatedTextarea id="target" label="Target" draftFieldId="/copy/fr/hero.title" targetLocale="fr" source="Current English" value="" onValueChange={onValueChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'AI 翻译' }));
  view.unmount();
  await act(async () => finish({ text: 'Late suggestion' }));
  expect(onValueChange).not.toHaveBeenCalled();
  expect(mocks.toast).toHaveBeenCalledWith('编辑位置已切换，本次译文未填入。可在当前字段重新翻译。');
});

it('uses the latest edit handler for unrelated page changes while preserving one request', async () => {
  let finish!: (result: { text: string }) => void;
  const first = vi.fn(), latest = vi.fn();
  mocks.api.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const props = { id: 'target', label: 'Target', draftFieldId: '/copy/fr/hero.title', targetLocale: 'fr' as const, source: 'Current English', value: '' };
  const view = render(<TranslatedTextarea {...props} onValueChange={first} />);
  const button = screen.getByRole('button', { name: 'AI 翻译' });
  fireEvent.click(button); fireEvent.click(button);
  view.rerender(<TranslatedTextarea {...props} onValueChange={latest} />);
  await act(async () => finish({ text: 'Current suggestion' }));
  expect(first).not.toHaveBeenCalled(); expect(latest).toHaveBeenCalledWith('Current suggestion');
  expect(mocks.api).toHaveBeenCalledTimes(1);
});

it.each(['readOnly', 'disabled'] as const)('respects the textarea %s state for AI actions', (flag) => {
  const onValueChange = vi.fn();
  render(<TranslatedTextarea id="target" label="Target" draftFieldId="/copy/fr/hero.title" targetLocale="fr" source="Current English" value="Saved" onValueChange={onValueChange} {...{ [flag]: true }} />);
  const button = screen.getByRole('button', { name: 'AI 翻译' }) as HTMLButtonElement;
  expect(button.disabled).toBe(true); fireEvent.click(button);
  expect(mocks.api).not.toHaveBeenCalled(); expect(onValueChange).not.toHaveBeenCalled();
});

it('drops an in-flight result if its target becomes read-only', async () => {
  let finish!: (result: { text: string }) => void;
  const onValueChange = vi.fn();
  mocks.api.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const props = { id: 'target', label: 'Target', draftFieldId: '/copy/fr/hero.title', targetLocale: 'fr' as const, source: 'Current English', value: 'Saved', onValueChange };
  const view = render(<TranslatedTextarea {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'AI 翻译' }));
  view.rerender(<TranslatedTextarea {...props} readOnly />);
  await act(async () => finish({ text: 'Late suggestion' }));
  expect(onValueChange).not.toHaveBeenCalled(); expect(target().value).toBe('Saved');
});

it('shares advisory feedback for loaded text, input events and AI results without truncating or blocking editing', async () => {
  const rule = getTextLimit('/copy/fr/hero.title', 'fr');
  const specimenLength = (rule.limit ?? 80) + 1;
  render(<Editor />);
  const hint = document.getElementById('target-length')!;
  expect(target().getAttribute('aria-describedby')).toBe('target-length');
  expect(target().hasAttribute('maxlength')).toBe(false);
  const pasted = 'a\u0301'.repeat(specimenLength) + ' {name}\n[[GPU]]';
  fireEvent.change(target(), { target: { value: pasted } });
  expect(target().value).toBe(pasted);
  expect(hint.getAttribute('data-text-limit-over')).toBe(String(rule.limit !== undefined));
  expect(target().getAttribute('aria-invalid')).toBeNull();
  expect(target().disabled).toBe(false);
  const suggestion = 'a\u0301'.repeat(specimenLength + 1);
  mocks.api.mockResolvedValue({ text: suggestion });
  fireEvent.click(screen.getByRole('button', { name: 'AI 翻译' }));
  await waitFor(() => expect(target().value).toBe(suggestion));
  expect(hint.getAttribute('data-count')).toBe(String(specimenLength + 1));
  if (rule.limit !== undefined) expect(hint.textContent).toContain('仍可保存和发布');
  else {
    expect(rule.previewReason).toBeTruthy();
    expect(hint.textContent).toContain(rule.previewReason!);
    expect(hint.hasAttribute('data-limit')).toBe(false);
  }
  expect(mocks.api).toHaveBeenCalledTimes(1);
  fireEvent.change(target(), { target: { value: '' } });
  expect(hint.getAttribute('data-text-limit-over')).toBe('false');
});

it('keeps existing accessible descriptions and loaded text under numeric or preview-only advice', () => {
  const rule = getTextLimit('/copy/ja/hero.title', 'ja');
  const value = '字'.repeat((rule.limit ?? 80) + 1);
  const onValueChange = vi.fn();
  render(<><p id="help">Existing help</p><TranslatedTextarea id="target" label="Target" draftFieldId="/copy/ja/hero.title" targetLocale="ja" source="English" value={value} onValueChange={onValueChange} aria-describedby="help" /></>);
  expect(target().getAttribute('aria-describedby')).toBe('help target-length');
  expect(target().value).toBe(value);
  const hint = document.getElementById('target-length')!;
  expect(hint.getAttribute('data-text-limit-over')).toBe(String(rule.limit !== undefined));
  if (rule.limit === undefined) {
    expect(rule.previewReason).toBeTruthy();
    expect(hint.textContent).toContain(rule.previewReason!);
    expect(hint.hasAttribute('data-limit')).toBe(false);
  }
  expect(onValueChange).not.toHaveBeenCalled();
});

it('loads the approved English fixture with its newline intact and no false over-limit warning', () => {
  const value = 'NexGrid\nLet compute flow', onValueChange = vi.fn();
  const rule = getTextLimit('/copy/en/hero.title', 'en');
  render(<TranslatedTextarea id="target" label="Target" draftFieldId="/copy/en/hero.title" targetLocale="en" source={value} value={value} onValueChange={onValueChange} />);
  const hint = document.getElementById('target-length')!;
  expect(target().value).toBe(value);
  expect(hint.getAttribute('data-count')).toBe('24');
  expect(hint.getAttribute('data-text-limit-over')).toBe('false');
  if (rule.limit === undefined) {
    expect(rule.previewReason).toBeTruthy();
    expect(hint.textContent).toContain(rule.previewReason!);
    expect(hint.hasAttribute('data-limit')).toBe(false);
  } else {
    expect(rule.limit).toBeGreaterThanOrEqual(24);
    expect(hint.textContent).toContain('按默认断行建议约');
  }
  expect(hint.getAttribute('data-limit')).not.toBe('16');
  expect(onValueChange).not.toHaveBeenCalled();
});

it('keeps an unmeasured product editable with a neutral preview reason for manual and AI values', async () => {
  function NewSkuEditor() {
    const [value, setValue] = useState('New product');
    return <TranslatedTextarea id="target" label="Target" draftFieldId="/skus/not-measured/tagline/fr" targetLocale="fr" source="New product" value={value} onValueChange={setValue} />;
  }
  render(<NewSkuEditor />);
  const hint = document.getElementById('target-length')!;
  expect(hint.hasAttribute('data-limit')).toBe(false);
  expect(hint.textContent).toContain('这个产品尚无对应的排版测量结果');
  expect(hint.textContent).not.toContain('尚未校准');
  const value = 'a\u0301'.repeat(100) + '\n👩‍👩‍👧‍👦';
  fireEvent.change(target(), { target: { value } });
  expect(target().value).toBe(value);
  expect(hint.getAttribute('data-count')).toBe('102');
  expect(hint.getAttribute('data-text-limit-over')).toBe('false');
  expect(target().disabled).toBe(false);
  expect(target().hasAttribute('maxlength')).toBe(false);
  mocks.api.mockResolvedValue({ text: 'AI ' + value });
  fireEvent.click(screen.getByRole('button', { name: 'AI 翻译' }));
  await waitFor(() => expect(target().value).toBe('AI ' + value));
  expect(hint.getAttribute('data-count')).toBe('105');
  expect(hint.getAttribute('data-text-limit-over')).toBe('false');
  expect(mocks.api).toHaveBeenCalledTimes(1);
  expect(mocks.api.mock.calls[0]![0]).toBe('/api/ai/translate');
});
