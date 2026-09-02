// 站内 TS = 打包器风格无后缀 import;schema TS = ESM 惯例 .js 后缀指向 .ts 源。
// node 直跑两种都解析不了 → 两条补救:①无后缀 → 试 +.ts;②.js 找不到 → 试换 .ts。
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (e) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND' && /^\.\.?\//.test(specifier)) {
      if (!/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context);
      if (specifier.endsWith('.js')) return next(specifier.replace(/\.js$/, '.ts'), context);
    }
    throw e;
  }
}
