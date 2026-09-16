// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../src/lib/use-draft', () => ({
  pointer: (...parts: string[]) => '/' + parts.join('/'),
  tokensOf: () => [],
  useDraft: () => ({
    draft: { copy: Object.fromEntries(['en', 'vi', 'zh'].map((locale) => [locale, {
      'hero.title': `${locale} hero`, 'why.title': `${locale} industry`, 'future.title': `${locale} new section`,
    }])) },
    live: null, saving: false, conflict: false,
  }),
}));
vi.mock('../src/lib/use-focus-field', () => ({ useFocusField: () => {} }));

import ContentPage from '../src/pages/content';
afterEach(cleanup);

it('exposes every actual copy group and lets the compact picker open a newly added group', () => {
  render(<MemoryRouter><ContentPage /></MemoryRouter>);
  const picker = screen.getByRole('combobox', { name: '选择文案板块' });
  expect(Array.from((picker as HTMLSelectElement).options, (option) => option.value)).toEqual(['hero', 'why', 'future']);
  fireEvent.change(picker, { target: { value: 'why' } });
  expect(screen.getByDisplayValue('zh industry')).toBeTruthy();
  fireEvent.change(picker, { target: { value: 'future' } });
  expect(screen.getByDisplayValue('zh new section')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('编辑语言'), { target: { value: 'vi' } });
  expect(screen.getByDisplayValue('vi new section')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('编辑语言'), { target: { value: 'en' } });
  expect(screen.getByDisplayValue('en new section')).toBeTruthy();
});
