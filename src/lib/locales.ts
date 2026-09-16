import { SITE_CONFIG } from './site-config';
import { resolveEnabledLocales } from './locale-policy';

/** Published, materialized configuration drives every public surface. */
export const activeLocales = resolveEnabledLocales(SITE_CONFIG.enabledLocales);
