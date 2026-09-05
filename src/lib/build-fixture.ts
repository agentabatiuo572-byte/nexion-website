import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/* 仅供站内行为门构建隔离变体。正常构建不设置该变量，始终返回仓内物化产物。
   用目录而不是把整份 JSON 塞进环境变量，避免 Windows 环境变量长度截断。 */
export function loadBuildFixture<T>(name: string, fallback: T): T {
  const dir = process.env.NEXGRID_SITE_FIXTURE_DIR;
  if (!dir) return fallback;
  return JSON.parse(readFileSync(join(dir, name), 'utf8')) as T;
}
