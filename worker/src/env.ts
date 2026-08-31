/**
 * Env 结构单源 = wrangler.jsonc(`wrangler types` 生成 worker-configuration.d.ts,postinstall / npm run types)。
 * 此处只把 vars 字面量放宽为 string(ENVIRONMENT 要与 'preview'|'production' 比较——CON12-E4),
 * 并声明可选的部署期调节阀。
 */
export type Env = Omit<Cloudflare.Env, 'ENVIRONMENT' | 'SETUP_TOKEN'> & {
  ENVIRONMENT: string;
  SETUP_TOKEN: string;
  /** PBKDF2 迭代覆盖(默认 600k;Workers 免费档 CPU 上限的部署期调节阀 + 测试提速) */
  KDF_ITER?: string;
};
