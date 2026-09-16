/** Local Admin uses the Worker live snapshot; deployed Admin stays on its own origin. */
export function publishedSiteUrl(path = '/', origin = window.location.origin): string {
  const base = new URL(origin);
  if (base.port === '5175' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) base.port = '8787';
  const target = new URL(path, base.origin);
  if (!['http:', 'https:'].includes(target.protocol) || target.origin !== base.origin || target.username || target.password) {
    throw new Error('invalid-published-site-url');
  }
  return target.href;
}
