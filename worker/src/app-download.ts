import { Hono } from 'hono';
import { DownloadEntry } from '../../schema/src/site-config';
import { resolveDownloadUrl } from '../../src/lib/download-policy';
import type { Env } from './env';

export const appDownloadRoutes = new Hono<{ Bindings: Env }>();

appDownloadRoutes.all('/:platform', async (c) => {
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    return c.json({ error: 'method-not-allowed' }, 405, { Allow: 'GET, HEAD' });
  }
  const platform = c.req.param('platform');
  if (platform !== 'ios' && platform !== 'android') return c.json({ error: 'not-found' }, 404);

  try {
    const live = await c.env.DB.prepare("SELECT payload FROM config_versions WHERE status='live' ORDER BY id DESC LIMIT 1")
      .first<string>('payload');
    if (live) {
      const entry = DownloadEntry.parse(JSON.parse(live).downloads?.[platform]);
      const target = resolveDownloadUrl(entry);
      if (target) return c.redirect(target, 302);
    }
  } catch {
    // Missing or unreadable published configuration has the same public response as a disabled download.
  }
  return c.json({ error: 'download-unavailable' }, 503, { 'Retry-After': '5' });
});
