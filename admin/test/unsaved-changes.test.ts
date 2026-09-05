import { describe, expect, it } from 'vitest';
import { shouldBlockNavigation } from '../src/lib/unsaved-changes';

describe('unsaved navigation policy', () => {
  it('blocks leaving an edited page but allows staying on the same route', () => {
    expect(shouldBlockNavigation(true, '/content/seo', '/audit', false)).toBe(true);
    expect(shouldBlockNavigation(true, '/content/seo', '/content/seo', false)).toBe(false);
  });

  it('lets an authentication redirect bypass a stale edit blocker', () => {
    expect(shouldBlockNavigation(true, '/content/seo', '/login', true)).toBe(false);
  });
});
