import { DEFAULT_ENABLED_LOCALES, LEGACY_ENABLED_LOCALES, isLocale, type Locale } from '../../schema/src/locales';
import type { Env } from './env';

/** Public responses use the committed live version, never the editable draft. */
export async function publishedLocales(env: Env): Promise<readonly Locale[]> {
  try {
    const row = await env.DB.prepare("SELECT payload FROM config_versions WHERE status='live' ORDER BY id DESC LIMIT 1").first<{ payload: string }>();
    if (!row) return DEFAULT_ENABLED_LOCALES; // A fresh installation serves the repository's initial snapshot.
    const config = JSON.parse(row.payload) as { enabledLocales?: unknown };
    if (config.enabledLocales === undefined) return LEGACY_ENABLED_LOCALES;
    const enabled = config.enabledLocales;
    if (Array.isArray(enabled) && enabled.includes('en') && enabled.every((locale) => typeof locale === 'string' && isLocale(locale)) && new Set(enabled).size === enabled.length) return enabled;
  } catch { /* English remains available when published configuration cannot be read. */ }
  return ['en'];
}

export function pathLocale(path: string): Locale {
  let decoded = path;
  try { decoded = decodeURIComponent(path); } catch { return 'en'; }
  const segment = decoded.split('/').filter(Boolean)[0]?.toLowerCase() ?? '';
  return isLocale(segment) ? segment : 'en';
}
