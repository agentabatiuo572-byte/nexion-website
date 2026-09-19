// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { toast } from '../src/api';

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

it('announces toast messages as one polite status update', () => {
  vi.useFakeTimers();
  toast('发布已发起');
  const el = document.getElementById('toast');
  expect(el?.getAttribute('role')).toBe('status');
  expect(el?.getAttribute('aria-live')).toBe('polite');
  expect(el?.getAttribute('aria-atomic')).toBe('true');
  expect(el?.textContent).toBe('发布已发起');
});
