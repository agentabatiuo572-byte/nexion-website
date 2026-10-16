import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
await build({ entryPoints:[path.join(root, 'worker/src/index.ts')], outfile:path.join(root, 'worker/aws/dist/worker.mjs'), bundle:true, platform:'node', format:'esm', target:'node24', sourcemap:false });
