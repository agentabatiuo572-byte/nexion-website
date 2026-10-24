import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { enumerateTranslationFields, validateTranslationValue } from '../../schema/src/draft-fields.js';
import { SiteConfigSchema, validateConfig, type CopyManifest, type SiteConfig } from '../../schema/src/index.js';
import seed from '../seed/site-config.seed.json';
import manifestJson from '../seed/copy-manifest.json';
import { adaptLegacyConfig, CONFIG_UPGRADE_KEY, ensureDraftUpgrade } from '../src/config-upgrade';
import { configRoutes } from '../src/config';
import { app } from '../src/index';
import { legacyTokenCopyKey, renameLegacyTokenConfig } from '../src/token-rename';
import { createTranslationJob, hashTranslationText, prepareTranslationChanges, translationSourceHash, translationFreshness } from '../src/translation-state';
import { validateTranslationText } from '../src/ai-client';
import { EventSchema } from '../src/events';
import { runDailyRollup } from '../src/rollup';
import { dashRoutes } from '../src/dash';

const current = SiteConfigSchema.parse(seed), manifest = manifestJson as unknown as CopyManifest;
function oldConfig(): SiteConfig {
  const input = JSON.parse(JSON.stringify(current).replaceAll('UVT', 'NEX'));
  for (const locale of Object.keys(input.copy)) input.copy[locale] = Object.fromEntries(
    Object.entries(input.copy[locale]).map(([key, value]) => [legacyTokenCopyKey(key), value]));
  input.seo.pages.nex = input.seo.pages.uvt;
  delete input.seo.pages.uvt;
  return input;
}
async function store(input: unknown) {
  const payload = JSON.stringify(input);
  await env.DB.prepare('INSERT INTO config_draft(id,payload,base_revision,updated_at,draft_rev,write_nonce) VALUES(1,?1,1,1,7,?2)').bind(payload, 'old-draft').run();
  await env.DB.prepare("INSERT INTO config_versions(status,payload,created_by,created_at) VALUES('live',?1,'admin',1)").bind(payload).run();
  return payload;
}
beforeEach(async () => {
  await env.DB.batch(['translation_jobs', 'translation_state', 'config_draft_upgrades', 'config_draft', 'config_versions', 'audit', 'raw_events', 'daily_section'].map(table => env.DB.prepare(`DELETE FROM ${table}`)));
});

describe('UVT token migration', () => {
  it('renames all locales, keys and SEO while preserving authored text, brands, IDs, contacts and original bytes', () => {
    const input = oldConfig();
    input.copy.zh['nex.pageTitle'] = 'NEX的用途与 NexGrid、Nexion、Uvel';
    input.faq.items[0]!.a.ja = 'NEXを利用する';
    input.announcement.href = '/vi/learn/staking-nex/?from=nex';
    input.footer.contactEmail = 'NEX@example.com';
    const before = JSON.stringify(input), result = adaptLegacyConfig(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.conflicts));
    expect(result.config.copy.zh['uvt.pageTitle']).toBe('UVT的用途与 NexGrid、Nexion、Uvel');
    expect(result.config.copy.en['nav.uvt']).toBe('UVT');
    expect(result.config.copy.en['uvt.cmpTypeUvt']).toBeDefined();
    expect(result.config.copy.en['nex.cmpTypeNex']).toBeUndefined();
    expect(result.config.seo.pages.uvt).toBeDefined();
    expect(result.config.faq.items[0]!.a.ja).toBe('UVTを利用する');
    expect(result.config.faq.items.map(item => item.id)).toEqual(input.faq.items.map(item => item.id));
    expect(result.config.announcement.href).toBe('/vi/learn/staking-uvt/?from=nex');
    expect(result.config.footer.contactEmail).toBe('NEX@example.com');
    expect(JSON.stringify(input)).toBe(before);
    expect(adaptLegacyConfig(result.config)).toEqual({ ok: true, changed: false, config: result.config });
  });

  it('refuses conflicting old/new copy and SEO fields without discarding either value', () => {
    const input = oldConfig(); input.copy.en['uvt.pageTitle'] = 'Authored UVT title';
    const before = JSON.stringify(input), result = adaptLegacyConfig(input);
    expect(result).toMatchObject({ ok: false, conflicts: [expect.objectContaining({ path: 'copy.en.nex.pageTitle' })] });
    expect(JSON.stringify(input)).toBe(before);
    const seo = oldConfig(); seo.seo.pages.uvt = structuredClone(current.seo.pages.uvt!);
    seo.seo.pages.uvt.title.en = 'Conflicting title';
    expect(renameLegacyTokenConfig(seo)).toMatchObject({ ok: false, conflicts: [expect.objectContaining({ path: 'seo.pages.nex' })] });
  });

  it('upgrades already-marked drafts once, preserving historical snapshots and translation provenance while expiring old jobs', async () => {
    const input = oldConfig(), original = await store(input);
    await env.DB.prepare('INSERT INTO config_draft_upgrades(draft_id,upgrade_key,original_payload,original_rev,upgraded_rev,applied_at,commit_nonce) VALUES(1,?1,?2,6,7,1,?3)')
      .bind('website-download-distribution-2026-10-22-v1', original, 'previous-upgrade').run();
    const oldManifest = { editable: Object.keys(input.copy.en) };
    const field = enumerateTranslationFields(input, oldManifest).find(field => field.fieldId === '/copy/nav.nex' && field.targetLocale === 'en')!;
    const sourceHash = await translationSourceHash(field), valueHash = await hashTranslationText(field.target);
    const job = createTranslationJob(field, 3, sourceHash); job.status = 'running'; job.lease_token = 'old-lease';
    await env.DB.batch(prepareTranslationChanges(env.DB, { states: [{ field_id: field.fieldId, target_locale: 'en', origin: 'ai',
      source_hash: sourceHash, observed_source_hash: sourceHash, applied_value_hash: valueHash, generation: 3, deleted: 0, updated_at: 1 }], jobs: [job] }, 'old-draft', 7));
    expect((await ensureDraftUpgrade(env.DB)).status).toBe('applied');
    const saved = await env.DB.prepare('SELECT payload,draft_rev FROM config_draft WHERE id=1').first<{ payload: string; draft_rev: number }>();
    expect(saved!.draft_rev).toBe(8);
    expect(JSON.parse(saved!.payload)).toEqual(current);
    const next = enumerateTranslationFields(current, manifest).find(field => field.fieldId === '/copy/nav.uvt' && field.targetLocale === 'en')!;
    expect(await env.DB.prepare("SELECT origin,source_hash,applied_value_hash,deleted,generation FROM translation_state WHERE field_id='/copy/nav.uvt' AND target_locale='en'").first())
      .toEqual({ origin: 'ai', source_hash: await translationSourceHash(next), applied_value_hash: await hashTranslationText('UVT'), deleted: 0, generation: 4 });
    expect(await env.DB.prepare("SELECT deleted FROM translation_state WHERE field_id='/copy/nav.nex' AND target_locale='en'").first()).toEqual({ deleted: 1 });
    expect(await env.DB.prepare('SELECT status,lease_token FROM translation_jobs WHERE id=?1').bind(job.id).first()).toEqual({ status: 'obsolete', lease_token: null });
    expect(await translationFreshness(env.DB, current, manifest)).toEqual([]);
    expect((await env.DB.prepare('SELECT payload FROM config_versions').first<{ payload: string }>())!.payload).toBe(original);
    expect((await env.DB.prepare('SELECT original_payload FROM config_draft_upgrades WHERE upgrade_key=?1').bind(CONFIG_UPGRADE_KEY).first<{ original_payload: string }>())!.original_payload).toBe(original);
    expect((await ensureDraftUpgrade(env.DB)).status).toBe('current');
    expect(await env.DB.prepare('SELECT payload,draft_rev FROM config_draft WHERE id=1').first()).toEqual(saved);
    const overview = await (await configRoutes.request('/', {}, env)).json() as { live: { payload: SiteConfig } };
    expect(overview.live.payload.copy.en['nav.uvt']).toBe('UVT');
  });

  it('keeps historical and cached-page analytics under UVT without rewriting raw events or double-counting a visitor', async () => {
    expect(EventSchema.parse({ t: 'sec', sec: 'nex', path: '/' })).toEqual({ t: 'sec', sec: 'uvt', path: '/' });
    expect(EventSchema.parse({ t: 'cta', cta: 'ios', sec: 'nex', loc: 'en', path: '/' }).t).toBe('cta');
    const day = new Date(Date.now() - 86400000).toISOString().slice(0, 10), timestamp = Date.parse(day + 'T12:00:00Z');
    const entries = [['000000000000000a', 'nex'], ['000000000000000a', 'uvt'], ['000000000000000b', 'uvt']];
    for (const [uid, sec] of entries) await env.DB.prepare('INSERT INTO raw_events(ts,type,uid,payload) VALUES(?1,?2,?3,?4)')
      .bind(timestamp, 'sec', uid, JSON.stringify({ t: 'sec', sec, path: '/', country: 'US', bot: 0 })).run();
    const before = (await env.DB.prepare('SELECT * FROM raw_events ORDER BY id').all()).results;
    expect(await runDailyRollup(env.DB, day)).toMatchObject({ processedEvents: 3, rejectedEvents: 0 });
    expect((await env.DB.prepare('SELECT section_id,uniq FROM daily_section').all()).results).toEqual([{ section_id: 'uvt', uniq: 2 }]);
    expect((await env.DB.prepare('SELECT * FROM raw_events ORDER BY id').all()).results).toEqual(before);
    const older = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    await env.DB.prepare("INSERT INTO daily_section(date,section_id,uniq) VALUES(?1,'nex',3)").bind(older).run();
    const dashboard = await (await dashRoutes.request('/', {}, env)).json() as { content: { sections: unknown[] } };
    expect(dashboard.content.sections).toEqual([{ section_id: 'uvt', uniq: 5 }]);
  });

  it('rejects reintroduced old names in authored source, target translations and AI output, including CJK-adjacent names', async () => {
    for (const text of ['NEX', 'NEXの用途', '持有NEX', 'Use NEX.']) {
      expect(validateTranslationValue({ source: 'UVT', maxLength: 200 }, text)).toBe('stale-token');
    }
    for (const text of ['UVT', 'NexGrid', 'Nexion', 'NEXGRID_TOKEN']) expect(validateTranslationValue({ source: 'UVT', maxLength: 200 }, text)).toBeNull();
    expect(() => validateTranslationText('UVT', 'en', 'NEX')).toThrow();
    const input = structuredClone(current); input.copy.zh['uvt.pageTitle'] = 'NEX代币';
    expect(validateConfig(input, manifest).errors).toContainEqual(expect.objectContaining({ path: 'copy.zh.uvt.pageTitle', rule: 'stale-token' }));
    await store(current);
    const response = await configRoutes.request('/draft', { method: 'PUT', body: JSON.stringify({ payload: input, baseRevision: 7 }) }, env);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'stale-token' });
  });
});

describe('legacy token URL redirects', () => {
  it.each(['GET', 'HEAD'])('%s redirects exact old token paths, preserves search, and canonicalizes the English prefix', async method => {
    await store({ ...current, enabledLocales: [...current.enabledLocales, 'zh'] });
    for (const [path, location] of [['/nex', '/uvt/'], ['/nex/', '/uvt/'], ['/vi/nex/', '/vi/uvt/'],
      ['/en/nex/', '/uvt/'], ['/zh/learn/staking-nex/', '/zh/learn/staking-uvt/'], ['/learn/staking-nex', '/learn/staking-uvt/']]) {
      const response = await app.request(`${path}?campaign=old`, { method }, env);
      expect(response.status, path).toBe(301);
      expect(response.headers.get('location')).toBe(`${location}?campaign=old`);
    }
  });
  it('keeps disabled and unknown language paths unavailable and never rewrites brand paths', async () => {
    await store({ ...current, enabledLocales: ['en', 'vi'] });
    expect((await app.request('/zh/nex/', {}, env)).status).toBe(404);
    for (const path of ['/xx/nex/', '/nexgrid/', '/nexion/', '/learn/staking-nex-extra/']) {
      const response = await app.request(path, {}, env);
      expect(response.status, path).toBe(404);
      expect(response.headers.get('location')).toBeNull();
    }
    expect((await app.request('/nex/', { method: 'POST', body: 'test' }, env)).status).toBe(405);
  });
});
