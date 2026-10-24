import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/index';

const config = (iosUrl: unknown = 'https://packages.example/app.ipa', androidUrl = 'https://packages.example/app.apk') => ({
  code: 0, data: { share: { appDownload: { source: 'official', iosUrl, androidUrl } } },
});
afterEach(() => vi.restoreAllMocks());

describe('public A3 app downloads', () => {
  it('reads each platform from A3 and observes a changed URL without rebuilding', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json(config()))
      .mockResolvedValueOnce(Response.json(config()))
      .mockResolvedValueOnce(Response.json(config('https://install.example/new-version')));
    for (const [platform, target] of [
      ['ios', 'https://packages.example/app.ipa'],
      ['android', 'https://packages.example/app.apk'],
      ['ios', 'https://install.example/new-version'],
    ]) {
      const response = await app.request(`/api/app-download/${platform}`, {}, env);
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe(target);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('HEAD uses an upstream GET and does not forward credentials or a requested target', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(config()));
    const response = await app.request('/api/app-download/ios?url=https://untrusted.example', {
      method: 'HEAD', headers: { Cookie: 'private=value', Authorization: 'Bearer visitor', Origin: 'https://uvel.ai' },
    }, env);
    expect(response.status).toBe(302);
    expect(await response.text()).toBe('');
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.uvel.ai/api/config/platform?officialLinkFragments=true');
    expect(init).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store' });
    expect(new Headers(init?.headers).get('authorization')).toBeNull();
    expect(new Headers(init?.headers).get('cookie')).toBeNull();
    expect(new Headers(init?.headers).get('origin')).toBeNull();
    expect(init?.body).toBeUndefined();
  });

  it.each(['', null, 'http://packages.example/a.ipa', '//packages.example/a.ipa',
    'javascript:alert(1)', 'https://user:pass@packages.example/a.ipa', 'https://packages.example/\r\nbad'])
  ('rejects missing/unsafe package URLs: %s', async (url) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(config(url)));
    const response = await app.request('/api/app-download/ios', {}, env);
    expect(response.status).toBe(503);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('fails closed on upstream errors, malformed/non-official config and timeout, then recovers', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('upstream detail', { status: 500 }))
      .mockResolvedValueOnce(new Response('not-json'))
      .mockResolvedValueOnce(Response.json({ code: 0, data: { share: { appDownload: { source: 'fallback' } } } }))
      .mockResolvedValueOnce(Response.json({ ...config(), code: 1 }))
      .mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
      .mockResolvedValueOnce(Response.json(config()));
    for (let i = 0; i < 5; i++) {
      const response = await app.request('/api/app-download/ios', {}, env);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'download-unavailable' });
    }
    expect((await app.request('/api/app-download/ios', {}, env)).status).toBe(302);
  });

  it('rejects writes and unknown platforms without contacting A3', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    expect((await app.request('/api/app-download/ios', { method: 'POST', body: 'ignored' }, env)).status).toBe(405);
    expect((await app.request('/api/app-download/windows', {}, env)).status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
