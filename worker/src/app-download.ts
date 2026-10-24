import { Hono } from 'hono';

// Fixed public upstream: never forward visitor cookies, authorization or query strings.
const CONFIG_URL = 'https://api.uvel.ai/api/config/platform?officialLinkFragments=true';
export const appDownloadRoutes = new Hono();

appDownloadRoutes.all('/:platform', async (c) => {
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    return c.json({ error: 'method-not-allowed' }, 405, { Allow: 'GET, HEAD' });
  }
  const platform = c.req.param('platform');
  if (platform !== 'ios' && platform !== 'android') return c.json({ error: 'not-found' }, 404);

  try {
    const response = await fetch(CONFIG_URL, {
      method: 'GET', headers: { Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(5000), cache: 'no-store',
    });
    if (!response.ok) throw new Error('config-unavailable');
    const payload = await response.json() as {
      code?: number;
      data?: { share?: { appDownload?: { source?: string; iosUrl?: unknown; androidUrl?: unknown } } };
    } | null;
    const config = payload?.code === 0 ? payload.data?.share?.appDownload : undefined;
    const value = platform === 'ios' ? config?.iosUrl : config?.androidUrl;
    if (config?.source !== 'official' || typeof value !== 'string' || /[\u0000-\u0020\\]/.test(value)) {
      throw new Error('download-unavailable');
    }
    const target = new URL(value);
    if (target.protocol !== 'https:' || target.username || target.password) throw new Error('invalid-download-url');
    return c.redirect(target.href, 302);
  } catch {
    // An unset or unavailable A3 value must never fall back to an obsolete package.
    return c.json({ error: 'download-unavailable' }, 503, { 'Retry-After': '5' });
  }
});
