import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { LOCALES, MATERIALIZED_FILES, SENSITIVE_COPY_PREFIXES, SiteConfigSchema, addLegacyLocaleFields, diffPaths, materializeAll, sensitivePaths, validateConfig, type CopyManifest, type SiteConfig } from '../../schema/src/index.js';
import seed from '../seed/site-config.seed.json';
import manifestJson from '../seed/copy-manifest.json';
import { adaptLegacyConfig, ensureDraftUpgrade, CONFIG_UPGRADE_KEY } from '../src/config-upgrade';
import { configRoutes } from '../src/config';
import { EventSchema } from '../src/events';
import { ingestRoutes, resetRateLimiter } from '../src/ingest';
import { runDailyRollup } from '../src/rollup';
import { publishedLocales } from '../src/published-locales';
import { app } from '../src/index';
import { loadRules, resetGeoCache, resetGeoLimiters } from '../src/geo';

const manifest = manifestJson as unknown as CopyManifest;
const current = () => SiteConfigSchema.parse(addLegacyLocaleFields(seed, manifest.editable));
const added = LOCALES.filter((locale) => !['en', 'vi', 'zh'].includes(locale));
function threeLanguageVersion(): unknown {
  const source = structuredClone(current()) as Record<string, unknown>;
  delete source.enabledLocales;
  const strip = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(strip); return; }
    const object = value as Record<string, unknown>;
    if (Object.hasOwn(object, 'en') && Object.hasOwn(object, 'vi') && Object.hasOwn(object, 'zh')) for (const locale of added) delete object[locale];
    Object.values(object).forEach(strip);
  };
  strip(source);
  return source;
}
const overview = async () => {
  const response = await configRoutes.request('/', {}, env);
  expect(response.status).toBe(200);
  return response.json() as Promise<{ draft: { payload: SiteConfig; draftRev: number }; live: { payload: SiteConfig }; dirty: number; changedPaths: string[] }>;
};
const save = (payload: unknown, baseRevision: number) => configRoutes.request('/draft', {
  method: 'PUT', body: JSON.stringify({ payload, baseRevision }),
}, env);

beforeEach(async () => {
  await env.DB.batch(['audit', 'config_draft_upgrades', 'config_versions', 'config_draft', 'geo_rule_state', 'geo_rule_operations', 'raw_events'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
  await env.KV.delete('geo:rules'); resetGeoCache(); resetGeoLimiters(); resetRateLimiter();
});

describe('Nine content languages and published selection', () => {
  it('selection accepts Chinese, rejects missing English, duplicates and unsupported locales', () => {
    const config = current();
    expect(SiteConfigSchema.safeParse({ ...config, enabledLocales: ['en', 'zh'] }).success).toBe(true);
    for (const enabledLocales of [[], ['zh'], ['en', 'en'], ['en', 'xx']]) {
      expect(SiteConfigSchema.safeParse({ ...config, enabledLocales }).success).toBe(false);
    }
  });

  it('upgrades raw three-language drafts once, preserving authored values and exact immutable history', async () => {
    const input = threeLanguageVersion() as { copy: { en: Record<string, string> } };
    input.copy.en['hero.title'] = 'Authored before language expansion';
    const original = JSON.stringify(input);
    await env.DB.prepare("INSERT INTO config_versions(status,payload,created_by,created_at) VALUES('live',?1,'admin',1)").bind(original).run();
    await env.DB.prepare('INSERT INTO config_draft(id,payload,base_revision,updated_at,draft_rev) VALUES(1,?1,1,1,7)').bind(original).run();
    expect((await ensureDraftUpgrade(env.DB)).status).toBe('applied');
    const first = await overview();
    expect(first.live.payload.enabledLocales).toEqual(['en', 'vi']);
    expect(first.live.payload.copy.ja['hero.title']).toBe('');
    expect(first.live.payload.legal.appPrivacy.md.ko).toBe('');
    const whitepaperPaths = added.flatMap((locale) => ['title', 'summary', 'details'].map((key) => `copy.${locale}.trust.whitepaper.${key}`));
    expect(first.dirty).toBe(whitepaperPaths.length);
    expect(first.changedPaths.sort()).toEqual(whitepaperPaths.sort());
    expect(first.draft.payload.enabledLocales).toEqual(['en', 'vi']);
    expect(first.draft.payload.copy.en['hero.title']).toBe(input.copy.en['hero.title']);
    for (const locale of added) {
      for (const [key, text] of Object.entries(first.draft.payload.copy[locale])) {
        expect(text).toBe(key.startsWith('trust.whitepaper.') ? current().copy[locale][key] : '');
      }
      expect(first.draft.payload.faq.items.every((item) => item.q[locale] === '' && item.a[locale] === '')).toBe(true);
      expect(first.draft.payload.skus.every((item) => item.tagline[locale] === '')).toBe(true);
    }
    expect((await ensureDraftUpgrade(env.DB)).status).toBe('current');
    expect((await overview()).draft.draftRev).toBe(8);
    expect((await env.DB.prepare('SELECT payload FROM config_versions').first<{ payload: string }>())!.payload).toBe(original);
    expect(await env.DB.prepare('SELECT original_payload,original_rev,upgraded_rev FROM config_draft_upgrades WHERE upgrade_key=?1').bind(CONFIG_UPGRADE_KEY).first()).toEqual({ original_payload: original, original_rev: 7, upgraded_rev: 8 });
    const restored = adaptLegacyConfig(JSON.parse(original));
    expect(restored.ok).toBe(true);
    if (restored.ok) expect(restored.config.copy.en['hero.title']).toBe(input.copy.en['hero.title']);
  });

  it('restores the original announcement id after editing and reverting a three-language live announcement', async () => {
    const original = JSON.stringify(threeLanguageVersion());
    await env.DB.prepare("INSERT INTO config_versions(status,payload,created_by,created_at) VALUES('live',?1,'admin',1)").bind(original).run();
    await env.DB.prepare('INSERT INTO config_draft(id,payload,base_revision,updated_at,draft_rev) VALUES(1,?1,1,1,7)').bind(original).run();
    await ensureDraftUpgrade(env.DB);
    const first = await overview();
    const edited = structuredClone(first.draft.payload);
    edited.announcement.text.en = 'A temporary announcement edit';
    expect((await save(edited, first.draft.draftRev)).status).toBe(200);
    const changed = await overview();
    expect(changed.draft.payload.announcement.id).not.toBe(first.live.payload.announcement.id);
    const restored = structuredClone(changed.draft.payload);
    restored.announcement.text = structuredClone(first.live.payload.announcement.text);
    expect((await save(restored, changed.draft.draftRev)).status).toBe(200);
    const result = await overview();
    expect(result.draft.payload.announcement.id).toBe(first.live.payload.announcement.id);
    expect(result.changedPaths).toEqual(first.changedPaths);
    expect((await env.DB.prepare('SELECT payload FROM config_versions').first<{ payload: string }>())!.payload).toBe(original);
  });

  it('unknown nested and root data are rejected without touching draft bytes or revision', async () => {
    const first = await overview();
    for (const extra of [
      { ...first.draft.payload, futureField: { keep: 'original' } },
      { ...first.draft.payload, footer: { ...first.draft.payload.footer, futureField: 'original' } },
      { ...first.draft.payload, stats: { ...first.draft.payload.stats, growth: { ...first.draft.payload.stats.growth, futureField: 'original' } } },
    ]) {
      expect((await save(extra, first.draft.draftRev)).status).toBe(400);
      expect((await overview()).draft).toEqual(first.draft);
      expect(adaptLegacyConfig(extra).ok).toBe(false);
    }
  });

  it('saves new-language content and Chinese selection; disabling retains fields and never updates live selection', async () => {
    const first = await overview(), payload = structuredClone(first.draft.payload);
    const liveBefore = await publishedLocales(env);
    payload.enabledLocales = ['en', 'zh'];
    payload.copy.ja['hero.scrollHint'] = 'ネットワークを見る';
    payload.legal.privacy.md.ja = '# 文書\n<script>discard()</script>本文';
    const response = await save(payload, first.draft.draftRev);
    expect(response.status).toBe(200);
    const saved = await overview();
    expect(saved.draft.payload.copy.ja['hero.scrollHint']).toBe('ネットワークを見る');
    expect(saved.draft.payload.legal.privacy.md.ja).toContain('本文');
    expect(saved.draft.payload.legal.privacy.md.ja).not.toContain('<script>');
    expect(saved.draft.payload.enabledLocales).toEqual(['en', 'zh']);
    expect(await publishedLocales(env)).toEqual(liveBefore);
    const blank = structuredClone(saved.draft.payload);
    blank.copy.de = Object.fromEntries(manifest.editable.map((key) => [key, '']));
    expect(validateConfig(blank, manifest).errors.some((error) => error.path.startsWith('copy.de.'))).toBe(false);
    blank.enabledLocales.push('de');
    expect(validateConfig(blank, manifest).errors.some((error) => error.path.startsWith('copy.de.') && error.rule === 'untranslated')).toBe(true);
  });

  it('checks already authored disabled-language placeholders and preserves SEO/Legal empty fallback', () => {
    const config = current(); config.enabledLocales = ['en'];
    config.copy.es['social.scaleLine'] = 'Missing required placeholders';
    expect(validateConfig(config, manifest).errors.some((error) => error.path === 'copy.es.social.scaleLine' && error.rule === 'placeholder')).toBe(true);
    config.copy.es['social.scaleLine'] = '';
    config.seo.pages.home!.title.en = ''; config.legal.terms.md.en = '';
    expect(validateConfig(config, manifest).errors).toEqual([]);
  });

  it('blocks stored protocol output and an old brand in enabled translations', () => {
    const config = current(); config.enabledLocales = ['en', 'fr'];
    config.copy.zh['hero.title'] = 'Uvel\n让算力流动';
    config.copy.en['hero.title'] = 'NexGrid\nLet compute flow';
    config.copy.fr['hero.title'] = '{«translations»:[{«id»:«/copy/hero.title»,«text»:«Uvel\nFaites circuler la puissance»}]}';
    const issues = validateConfig(config, manifest).errors;
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'copy.en.hero.title', rule: 'stale-brand' }),
      expect.objectContaining({ path: 'copy.fr.hero.title', rule: 'translation-envelope' }),
    ]));
  });

  it('every locale retains the same sensitive-copy reason requirement for real emitted diff paths', () => {
    const original = current();
    for (const locale of LOCALES) for (const prefix of SENSITIVE_COPY_PREFIXES) {
      const key = manifest.editable.find((candidate) => candidate.startsWith(prefix));
      expect(key, `${prefix} must exercise a real editable copy key`).toBeDefined();
      const edited = structuredClone(original);
      edited.copy[locale][key!] += ' edited';
      const paths = diffPaths(original, edited);
      expect(paths).toEqual([`copy.${locale}.${key}`]);
      expect(sensitivePaths(paths)).toEqual(paths);
    }
    expect(sensitivePaths(['copy.ja.hero.scrollHint'])).toEqual([]);
  });

  it('materializes and hashes every retained dictionary, including disabled Chinese', async () => {
    const config = current(); config.enabledLocales = ['en'];
    const fingerprint = async (value: SiteConfig) => {
      const output = materializeAll(value, manifest);
      const bodies = [...LOCALES.map((locale) => output.i18n[locale]), output.siteJson];
      const bytes = new TextEncoder().encode(MATERIALIZED_FILES.map((file, index) => `${file}\0${bodies[index]}`).join('\0'));
      return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].join(',');
    };
    expect(MATERIALIZED_FILES).toHaveLength(10);
    const baseline = await fingerprint(config);
    for (const locale of LOCALES) {
      const edited = structuredClone(config); edited.copy[locale]['hero.scrollHint'] += ' changed';
      expect(await fingerprint(edited)).not.toBe(baseline);
      expect(JSON.parse(materializeAll(edited, manifest).i18n[locale]).hero.scrollHint).toBe(edited.copy[locale]['hero.scrollHint']);
    }
  });

  it('accepts all nine metric locales while rejecting unknown codes', () => {
    for (const loc of LOCALES) expect(EventSchema.safeParse({ t: 'faq', faq: 'q1', loc }).success).toBe(true);
    expect(EventSchema.safeParse({ t: 'faq', faq: 'q1', loc: 'xx' }).success).toBe(false);
  });

  it('all nine locales travel through real ingestion and daily SQL including Learn prefix normalization', async () => {
    const day = new Date().toISOString().slice(0, 10);
    for (const loc of LOCALES) {
      const path = `${loc === 'en' ? '' : '/' + loc}/learn/language-contract/`;
      const response = await ingestRoutes.request('/', { method: 'POST', headers: { 'cf-connecting-ip': '203.0.113.82', 'user-agent': 'Mozilla/5.0 locale test', 'cf-ipcountry': 'US' }, body: JSON.stringify({ events: [
        { t: 'pv', path, loc, dev: 'd', ref: 'direct', us: '', um: '', uc: '' },
        { t: 'cta', cta: 'ios', sec: 'download', loc, path },
        { t: 'faq', faq: 'q1', loc },
      ] }) }, env);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    }
    expect((await runDailyRollup(env.DB, day)).rejectedEvents).toBe(0);
    const traffic = await env.DB.prepare('SELECT locale,pv,uv FROM daily_traffic WHERE date=?1 ORDER BY locale').bind(day).all<{ locale: string; pv: number; uv: number }>();
    expect(traffic.results.map((row) => row.locale)).toEqual([...LOCALES].sort());
    expect(traffic.results.every((row) => row.pv === 1 && row.uv === 1)).toBe(true);
    expect((await env.DB.prepare("SELECT reads FROM daily_learn WHERE date=?1 AND slug='language-contract'").bind(day).first<{ reads: number }>())!.reads).toBe(9);
    expect((await env.DB.prepare("SELECT COUNT(*) n FROM daily_dimensions WHERE date=?1 AND dimension='locale'").bind(day).first<{ n: number }>())!.n).toBe(9);
    expect((await env.DB.prepare('SELECT COUNT(*) n FROM daily_cta WHERE date=?1').bind(day).first<{ n: number }>())!.n).toBe(9);
    await runDailyRollup(env.DB, day);
    expect((await env.DB.prepare('SELECT SUM(pv) n FROM daily_traffic WHERE date=?1').bind(day).first<{ n: number }>())!.n).toBe(9);
  });

  it('public paths and Geo use live selection, support zh when enabled and fall back to Chinese for missing Geo translation', async () => {
    const config = current(); config.enabledLocales = ['en', 'zh', 'ja'];
    await env.DB.prepare("INSERT INTO config_versions(status,payload,created_by,created_at) VALUES('live',?1,'admin',1)").bind(JSON.stringify(config)).run();
    const rules = { enabled: true, countries: ['CN'], blockPage: {
      title: { en: 'Unavailable', zh: '地区不可用', ja: '利用できません' },
      body: { en: 'English region message', zh: '中文正文', ja: 'この地域では利用できません' },
    } };
    await env.KV.put('geo:rules', JSON.stringify(rules));
    const headers = { accept: 'text/html', 'x-geo-sim': 'CN' };
    const zh = await app.request('/zh/', { headers }, env); expect(zh.status).toBe(451); expect(await zh.text()).toContain('lang="zh"');
    const ja = await app.request('/ja/', { headers }, env); expect(ja.status).toBe(451); expect(await ja.text()).toContain('利用できません');
    expect((await app.request('/de/', { headers }, env)).status).toBe(404);
    config.enabledLocales = ['en', 'ja'];
    await env.DB.prepare("UPDATE config_versions SET payload=?1 WHERE status='live'").bind(JSON.stringify(config)).run();
    for (const path of ['/zh/', '/zh/index.html', '/%7Ah/', '/zh%2Flegal/privacy/']) expect((await app.request(path, { headers }, env)).status).toBe(404);
    delete (rules.blockPage.title as Partial<typeof rules.blockPage.title>).ja;
    delete (rules.blockPage.body as Partial<typeof rules.blockPage.body>).ja;
    await env.KV.put('geo:rules', JSON.stringify(rules)); resetGeoCache();
    const fallback = await app.request('/ja/', { headers }, env); expect(fallback.status).toBe(451);
    const fallbackText = await fallback.text(); expect(fallbackText).toContain('lang="zh"');
    expect(fallbackText).toContain('地区不可用');
    delete (rules.blockPage.title as Partial<typeof rules.blockPage.title>).zh;
    delete (rules.blockPage.body as Partial<typeof rules.blockPage.body>).zh;
    await env.KV.put('geo:rules', JSON.stringify(rules)); resetGeoCache();
    const legacy = await app.request('/ja/', { headers }, env); expect(legacy.status).toBe(451); expect(await legacy.text()).toContain('lang="en"');
  });

  it('retains the exact legacy Geo language property order so existing D1/KV fingerprints remain valid', async () => {
    const legacy = { enabled: true, countries: ['CN'], blockPage: {
      title: { zh: '不可用', en: 'Unavailable' }, body: { zh: '地区正文', en: 'Region message' },
    } };
    const original = JSON.stringify(legacy);
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(original)))].map((value) => value.toString(16).padStart(2, '0')).join('');
    await env.DB.prepare("INSERT INTO geo_rule_state(id,status,current_rules,current_fingerprint,version) VALUES(1,'ready',?1,?2,1)").bind(original, digest).run();
    await env.KV.put('geo:rules:v1', original);
    const loaded = await loadRules(env);
    expect(loaded.degraded).toBe(false);
    expect(JSON.stringify(loaded.rules)).toBe(original);
  });
});
