#!/usr/bin/env node
/* 部署组装:admin/dist → dist/admin(worker 单资产目录伺服两面)。
   顺序铁则:站 13 门跑在【纯官网 dist】上(astro build 产物,不含本目录拷入物);
   组装发生在门之后、起服/部署之前。astro build 会清空 dist → 每次站构建后须重跑本脚本。 */
import { cpSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'admin', 'dist');
const dst = path.join(here, '..', 'dist', 'admin');
if (!existsSync(src)) {
  console.error('✗ 缺 admin/dist —— 先 npm --prefix admin run build');
  process.exit(2);
}
if (!existsSync(path.join(here, '..', 'dist'))) {
  console.error('✗ 缺站 dist —— 先站仓根 npm run build');
  process.exit(2);
}
cpSync(src, dst, { recursive: true });
console.log('✓ 已组装 dist/admin(控制台)');
