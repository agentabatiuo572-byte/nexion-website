// Local build preview used by the UI gate; API traffic stays on a loopback Worker.
import { preview } from '../admin/node_modules/vite/dist/node/index.js';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export async function startConsolePreview({ port = 4399, apiOrigin = 'http://127.0.0.1:8789' } = {}) {
  const target = new URL(apiOrigin);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) throw new Error('Console check requires a loopback API');
  return preview({
    root: resolve(fileURLToPath(new URL('..', import.meta.url)), 'admin'),
    preview: { port, strictPort: true, host: '127.0.0.1', proxy: { '^/(?!admin(?:/|$))': apiOrigin } },
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await startConsolePreview({ apiOrigin: process.env.CONSOLE_API_ORIGIN });
  server.printUrls();
}
