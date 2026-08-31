/**
 * Env 结构单源 = wrangler.jsonc(`wrangler types` 生成 worker-configuration.d.ts,postinstall 自动跑)。
 * 此处只做一件事:把 vars 的字面量类型放宽(ENVIRONMENT 生成为 "dev" 字面量,
 * 代码里要与 'preview' | 'production' 比较——CON12-E4 的环境判断)。
 */
export type Env = Omit<Cloudflare.Env, 'ENVIRONMENT'> & { ENVIRONMENT: string };
