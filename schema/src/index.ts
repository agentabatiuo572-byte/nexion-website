/* nexgrid-site-schema —— SiteConfig 单源(结构/清单/校验/物化)。
   消费面:worker(校验+物化+种子)· 控制台表单 · 站上门(词表经 scripts/forbidden-patterns.mjs 双向共源)。 */
export * from './site-config.js';
export * from './manifest.js';
export * from './validators.js';
export * from './materialize.js';
export * from './diff.js';
