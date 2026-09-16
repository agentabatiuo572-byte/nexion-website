// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { useFocusField } from '../src/lib/use-focus-field';

afterEach(cleanup);

it('focuses a reused control when its field path changes after the initial attempt', async () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  function Editor() {
    useFocusField();
    return <textarea data-field="seo.pages.home.description.fr" />;
  }
  const view = render(<MemoryRouter initialEntries={['/?focus=seo.learn.description.fr']}><Editor /></MemoryRouter>);
  const input = view.container.querySelector('textarea')!;
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(document.activeElement).not.toBe(input);
  input.dataset.field = 'seo.pages.learn.description.fr';
  await waitFor(() => expect(document.activeElement).toBe(input));
});
