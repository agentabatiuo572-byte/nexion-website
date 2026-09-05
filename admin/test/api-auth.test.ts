// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { advanceAuthGeneration, ApiError, api, apiErrorHint, setUnauthorizedRedirect } from '../src/api';

describe('API authentication lifecycle', () => {
  const originalFetch = globalThis.fetch;
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');

  beforeEach(() => {
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { hash: '', pathname: '/admin/audit', search: '', assign: vi.fn() },
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
    else Reflect.deleteProperty(globalThis, 'location');
    vi.restoreAllMocks();
  });

  it('redirects again on a second session expiry after login resets the guard', async () => {
    const redirects: string[] = [];
    setUnauthorizedRedirect((to) => redirects.push(to));
    globalThis.fetch = vi.fn(async () => new Response('{"error":"unauthorized"}', {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }));

    await expect(api('/api/audit')).rejects.toMatchObject({ status: 401 });
    advanceAuthGeneration();
    await expect(api('/api/audit')).rejects.toMatchObject({ status: 401 });

    expect(redirects).toHaveLength(2);
    expect(redirects[0]).toContain('/login?back=');
  });

  it('coalesces concurrent 401 responses within one session', async () => {
    const redirects: string[] = [];
    setUnauthorizedRedirect((to) => redirects.push(to));
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 401 }));

    await Promise.allSettled([api('/api/a'), api('/api/b')]);
    expect(redirects).toHaveLength(1);
  });

  it('ignores a late 401 from the previous session after a successful login advances the generation', async () => {
    const redirects: string[] = [];
    let finishOldRequest!: (response: Response) => void;
    setUnauthorizedRedirect((to) => redirects.push(to));
    globalThis.fetch = vi.fn((input: string | URL | Request) => {
      if (String(input) === '/api/old-session') {
        return new Promise<Response>((resolve) => { finishOldRequest = resolve; });
      }
      return Promise.resolve(new Response('{}', { status: 401 }));
    });

    const oldRequest = api('/api/old-session');
    advanceAuthGeneration();
    finishOldRequest(new Response('{}', { status: 401 }));
    await expect(oldRequest).rejects.toMatchObject({ status: 401 });
    expect(redirects).toEqual([]);

    await expect(api('/api/current-session')).rejects.toMatchObject({ status: 401 });
    expect(redirects).toHaveLength(1);
  });

  it('uses a safe fallback for network errors without ApiError.body', () => {
    expect(apiErrorHint(new TypeError('Failed to fetch'), '网络失败')).toBe('网络失败');
    expect(apiErrorHint(new ApiError(409, { hint: '稍后重试' }), '网络失败')).toBe('稍后重试');
  });
});
