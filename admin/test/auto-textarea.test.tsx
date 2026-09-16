// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AutoTextarea } from '../src/lib/auto-textarea';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('remeasures unchanged text after width or responsive font changes, caps scrolling, and cleans up', () => {
  let width = 400;
  let contentHeight = 80;
  let notify = () => {};
  const observe = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { notify = callback; }
    observe = observe;
    disconnect = disconnect;
  });
  vi.spyOn(HTMLTextAreaElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width } as DOMRect));
  const measure = vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockImplementation(() => contentHeight);
  const { unmount } = render(<AutoTextarea aria-label="正文" value="保持原文" readOnly />);
  const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
  expect(textarea.style.height).toBe('80px');

  // A narrower container reflows the same value into more lines.
  width = 200;
  contentHeight = 240;
  notify();
  expect(textarea.value).toBe('保持原文');
  expect(textarea.style.height).toBe('240px');
  expect(observe).toHaveBeenCalledWith(textarea);
  const measured = measure.mock.calls.length;
  notify();
  expect(measure).toHaveBeenCalledTimes(measured); // Our own height write must not loop.

  // Responsive fonts can change at the same capped container width.
  contentHeight = 560;
  fireEvent(window, new Event('resize'));
  expect(textarea.style.height).toBe('420px');
  expect(textarea.style.overflowY).toBe('auto');
  width = 800;
  contentHeight = 120;
  notify();
  expect(textarea.style.height).toBe('120px');
  expect(textarea.style.overflowY).toBe('hidden');

  unmount();
  expect(disconnect).toHaveBeenCalledOnce();
  const finalMeasurements = measure.mock.calls.length;
  fireEvent(window, new Event('resize'));
  expect(measure).toHaveBeenCalledTimes(finalMeasurements);
});
