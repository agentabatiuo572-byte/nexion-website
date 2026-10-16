import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const types = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.ico':'image/x-icon', '.pdf':'application/pdf', '.woff2':'font/woff2', '.txt':'text/plain; charset=utf-8', '.xml':'application/xml' };
export function assetsBinding(livePath) {
  return { async fetch(input) {
    const request = input instanceof Request ? input : new Request(input);
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url).pathname); } catch { return new Response('Not found', { status:404 }); }
    if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(s => s === '..' || (s.startsWith('.') && s !== '.publish-stamp.json'))) return new Response('Not found', { status:404 });
    // Resolve current once per response, so a symlink switch cannot combine two releases.
    const root = await realpath(livePath);
    let file = path.resolve(root, '.' + pathname);
    if (file !== root && !file.startsWith(root + path.sep)) return new Response('Not found', { status:404 });
    let status = 200;
    try {
      if ((await stat(file)).isDirectory()) {
        if (!pathname.endsWith('/')) return new Response(null, { status:308, headers:{ location:new URL(pathname + '/' + new URL(request.url).search, request.url).href } });
        file = path.join(file, 'index.html');
      }
      const resolved = await realpath(file);
      if (!resolved.startsWith(root + path.sep)) throw new Error('Asset escaped release');
      file = resolved;
      if (!(await stat(file)).isFile()) throw new Error('Not a file');
    } catch {
      status = 404;
      file = path.join(root, pathname.startsWith('/vi/') ? 'vi/404.html' : '404.html');
    }
    let body;
    try { body = await readFile(file); } catch { return new Response('Not found', { status:404 }); }
    const admin = pathname === '/admin' || pathname.startsWith('/admin/');
    const headers = new Headers({ 'Content-Type':types[path.extname(file)] ?? 'application/octet-stream', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'strict-origin-when-cross-origin', 'Cache-Control':status !== 200 || admin || pathname === '/.publish-stamp.json' ? 'no-store' : pathname.startsWith('/_astro/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
    const etag = '"' + createHash('sha256').update(body).digest('hex') + '"';
    headers.set('ETag', etag);
    headers.set('Accept-Ranges', 'bytes');
    if (status === 200 && request.headers.get('if-none-match')?.split(',').some(t => t.trim().replace(/^W\//, '') === etag || t.trim() === '*')) return new Response(null, { status:304, headers });
    const range = request.headers.get('range');
    if (status === 200 && range && (!request.headers.has('if-range') || request.headers.get('if-range') === etag)) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match && (match[1] || match[2])) {
        const start = match[1] ? Number(match[1]) : Math.max(0, body.length - Number(match[2]));
        const end = match[1] && match[2] ? Math.min(Number(match[2]), body.length - 1) : body.length - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= body.length) {
          headers.set('Content-Range', `bytes */${body.length}`);
          return new Response(null, { status:416, headers });
        }
        headers.set('Content-Range', `bytes ${start}-${end}/${body.length}`);
        body = body.subarray(start, end + 1); status = 206;
      }
    }
    headers.set('Content-Length', String(body.length));
    return new Response(request.method === 'HEAD' ? null : body, { status, headers });
  } };
}
