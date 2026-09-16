import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { SiteConfigSchema, LOCALES, type SiteConfig } from '../../schema/src/index.js';
import { createDraftPatch, enumerateTranslationFields, pointer, type DraftOperation } from '../../schema/src/draft-fields.js';
import { commitDraftWrite, DRAFT_MANIFEST, DraftWriteError, fillDraftDefaults, readDraftSnapshot, saveDraftPatch, saveDraftPut } from '../src/draft-write';
import { hashTranslationText, loadTranslationState, translationSourceHash, translationStateKey, type TranslationStateRow } from '../src/translation-state';
import seedJson from '../seed/site-config.seed.json';

const seed = () => SiteConfigSchema.parse(structuredClone(seedJson));
const read = async () => { const snapshot = await readDraftSnapshot(env.DB); return { snapshot, config: SiteConfigSchema.parse(JSON.parse(snapshot.payload)) }; };
const set = (fieldId: string, before: unknown, after: unknown): DraftOperation => ({ op: 'set', fieldId, before, after });
const save = async (operations: DraftOperation[], baseRevision = 1) => saveDraftPatch(env.DB, { baseRevision, operations });

beforeEach(async () => {
  await env.DB.batch(['translation_jobs', 'translation_state', 'audit', 'config_draft', 'config_versions'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
  const payload = JSON.stringify(seed()), now = Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO config_draft(id,payload,base_revision,updated_at,draft_rev) VALUES(1,?1,1,?2,1)').bind(payload, now),
    env.DB.prepare("INSERT INTO config_versions(status,payload,created_by,created_at,published_at) VALUES('live',?1,'test',?2,?2)").bind(payload, now),
  ]);
});

async function managed(fieldId = '/copy/hero.scrollHint', locale = 'fr') {
  const { snapshot, config } = await read();
  const field = enumerateTranslationFields(config, DRAFT_MANIFEST).find((entry) => entry.fieldId === fieldId && entry.targetLocale === locale)!;
  const sourceHash = await translationSourceHash(field);
  const state: TranslationStateRow = { field_id: fieldId, target_locale: locale, origin: 'ai', source_hash: sourceHash,
    observed_source_hash: sourceHash, applied_value_hash: await hashTranslationText(field.target), generation: 1, deleted: 0, updated_at: Date.now() };
  await commitDraftWrite(env.DB, { snapshot, payload: config, translation: { states: [state], jobs: [] }, reason: 'test-managed' });
  return { field, state };
}

describe('draft foundation: real D1 persistence and atomic intent', () => {
  it('enumerates stable FAQ/SKU IDs and only current manifest copy keys', () => {
    const config = seed(), before = enumerateTranslationFields(config, DRAFT_MANIFEST);
    config.faq.items.reverse(); config.skus.reverse();
    expect(enumerateTranslationFields(config, DRAFT_MANIFEST).map((field) => field.fieldId).sort()).toEqual(before.map((field) => field.fieldId).sort());
    expect(before.some((field) => field.fieldId.includes('coverAlt') || field.fieldId.endsWith('whitepaper.download'))).toBe(false);
    expect(pointer('faq', 'items', 'a/b~c', 'q', 'ja')).toBe('/faq/items/a~1b~0c/q/ja');
  });

  it('fills 1,482 defaults in one revision/audit, leaves history intact and is rerunnable', async () => {
    const config = seed();
    const addedLocales = ['es', 'pt', 'fr', 'de', 'ja', 'ko'] as const;
    for (const locale of addedLocales) {
      for (const key of DRAFT_MANIFEST.editable) if (!key.startsWith('trust.whitepaper.')) config.copy[locale][key] = '';
      for (const item of config.faq.items) { item.q[locale] = ''; item.a[locale] = ''; }
      for (const sku of config.skus) sku.tagline[locale] = '';
    }
    await env.DB.prepare('UPDATE config_draft SET payload=?1 WHERE id=1').bind(JSON.stringify(config)).run();
    const history = await env.DB.prepare('SELECT payload FROM config_versions').first<{ payload: string }>();
    const started = Date.now(), result = await fillDraftDefaults(env.DB);
    expect(result.applied).toBe(1482);
    expect(result.draftRev).toBe(2);
    expect((await read()).config).toEqual(seed());
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM translation_state').first<{ n: number }>())!.n).toBe(1482);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM audit').first<{ n: number }>())!.n).toBe(1);
    expect((await env.DB.prepare('SELECT payload FROM config_versions').first<{ payload: string }>())!.payload).toBe(history!.payload);
    expect(await fillDraftDefaults(env.DB)).toMatchObject({ applied: 0, draftRev: 2 });
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);

  it('does not fill custom-source defaults or manual nonempty/empty values', async () => {
    const config = seed(); config.copy.fr['hero.scrollHint'] = ''; config.copy.de['hero.scrollHint'] = '';
    config.copy.zh['final.title'] = '新撰写的中文标题'; config.copy.fr['final.title'] = '';
    await env.DB.prepare('UPDATE config_draft SET payload=?1 WHERE id=1').bind(JSON.stringify(config)).run();
    await save([set('/copy/fr/hero.scrollHint', '', '')]);
    await fillDraftDefaults(env.DB);
    const current = await read();
    expect(current.config.copy.fr['hero.scrollHint']).toBe('');
    expect(current.config.copy.fr['final.title']).toBe('');
    expect(current.config.copy.de['hero.scrollHint']).toBe(seed().copy.de['hero.scrollHint']);
    expect((await loadTranslationState(env.DB)).get(translationStateKey('/copy/hero.scrollHint', 'fr'))?.origin).toBe('manual');
  });

  it('reuses an exactly matched approved default with intentional localized line breaks', async () => {
    const config = seed(); config.copy.fr['hero.subtitle2'] = '';
    await env.DB.prepare('UPDATE config_draft SET payload=?1 WHERE id=1').bind(JSON.stringify(config)).run();
    expect((await fillDraftDefaults(env.DB)).applied).toBe(1);
    expect((await read()).config.copy.fr['hero.subtitle2']).toBe(seed().copy.fr['hero.subtitle2']);
  });

  it('same-value manual takeover changes revision/state once, then source changes preserve it', async () => {
    const { field } = await managed();
    const takeover = await save([set(field.draftFieldId, 'editor earlier text', field.target)]);
    expect(takeover.draftRev).toBe(3); expect(takeover.changedFromPrev).toBe(0);
    const state = (await loadTranslationState(env.DB)).get(translationStateKey(field.fieldId, field.targetLocale))!;
    expect(state.origin).toBe('manual'); expect(state.generation).toBe(2);
    expect((await save([set(field.draftFieldId, 'editor earlier text', field.target)])).draftRev).toBe(3);
    await save([set('/copy/zh/hero.scrollHint', seed().copy.zh['hero.scrollHint'], 'New source text')]);
    const after = (await loadTranslationState(env.DB)).get(translationStateKey(field.fieldId, field.targetLocale))!;
    expect(after.source_hash).toBe(state.source_hash); expect(after.observed_source_hash).not.toBe(state.source_hash);
    expect((await read()).config.copy.fr['hero.scrollHint']).toBe(field.target);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM translation_jobs WHERE target_locale=?1').bind('fr').first<{ n: number }>())!.n).toBe(0);
  });

  it('merges two stale-baseline edits on different fields without clobbering either', async () => {
    const original = seed();
    const results = await Promise.all([
      save([set('/copy/fr/hero.scrollHint', original.copy.fr['hero.scrollHint'], 'Texte A')]),
      save([set('/copy/de/hero.scrollHint', original.copy.de['hero.scrollHint'], 'Text B')]),
    ]);
    expect(results.map((r) => r.draftRev).sort()).toEqual([2, 3]);
    expect((await read()).config.copy.fr['hero.scrollHint']).toBe('Texte A');
    expect((await read()).config.copy.de['hero.scrollHint']).toBe('Text B');
  });

  it('rejects the entire human patch on a real same-field conflict', async () => {
    const original = seed();
    await save([set('/copy/fr/hero.scrollHint', original.copy.fr['hero.scrollHint'], 'First editor')]);
    await expect(save([set('/copy/fr/hero.scrollHint', original.copy.fr['hero.scrollHint'], 'Second editor'), set('/copy/de/hero.scrollHint', original.copy.de['hero.scrollHint'], 'Must not save')])).rejects.toMatchObject({ status: 409, body: { error: 'field-conflict' } });
    expect((await read()).config.copy.de['hero.scrollHint']).toBe(original.copy.de['hero.scrollHint']);
    expect((await read()).snapshot.draft_rev).toBe(2);
  });

  it('rejects unknown/duplicate fields, illegal locales and absent collection identities', async () => {
    for (const operations of [
      [set('/copy/fr/trust.whitepaper.download', '', 'bad')], [set('/copy/xx/hero.scrollHint', '', 'bad')],
      [set('/faq/items/missing/q/fr', '', 'bad')], [set('/footer/contactEmail', '', 'one'), set('/footer/contactEmail', '', 'two')],
    ]) await expect(save(operations)).rejects.toMatchObject({ status: 400 });
    await expect(saveDraftPatch(env.DB, { baseRevision: 1, operations: [{ op: 'set', fieldId: '/footer/contactEmail', after: 'bad' }] })).rejects.toMatchObject({ status: 400 });
    expect((await read()).snapshot.draft_rev).toBe(1);
  });

  it('FAQ sort based on IDs preserves a concurrent translated answer', async () => {
    const baseline = seed(), edited = structuredClone(baseline), first = edited.faq.items[0]!;
    first.sort += 50; edited.faq.items.reverse();
    const operations = createDraftPatch(baseline, edited, DRAFT_MANIFEST);
    await save([set(pointer('faq', 'items', first.id, 'a', 'fr'), first.a.fr, 'Réponse conservée')]);
    await save(operations);
    const latest = (await read()).config.faq.items.find((item) => item.id === first.id)!;
    expect(latest.a.fr).toBe('Réponse conservée'); expect(latest.sort).toBe(first.sort);
  });

  it('PUT keeps strict edit-start revision and Legal/announcement normalization', async () => {
    const original = seed(), edited = structuredClone(original);
    edited.legal.terms.md.en = '# Terms\n<script>evil()</script><a onclick="evil()">ok</a>';
    edited.announcement.text.en = 'New announcement';
    const result = await saveDraftPut(env.DB, { payload: edited, baseRevision: 1 });
    expect(result.sanitized).toBe(1); expect(result.payload.legal.terms.md.en).not.toContain('script');
    expect(result.payload.legal.terms.md.en).not.toContain('onclick'); expect(result.payload.announcement.id).not.toBe(original.announcement.id);
    await expect(saveDraftPut(env.DB, { payload: original, baseRevision: 1 })).rejects.toMatchObject({ status: 409 });
  });

  it('source A→B→A increments generations while applied source hash is preserved', async () => {
    const { field, state } = await managed();
    await save([set('/copy/zh/hero.scrollHint', field.source, 'Source B')]);
    let current = (await loadTranslationState(env.DB)).get(translationStateKey(field.fieldId, 'fr'))!;
    expect(current.generation).toBe(2); expect(current.source_hash).toBe(state.source_hash);
    await save([set('/copy/zh/hero.scrollHint', 'Source B', field.source)]);
    current = (await loadTranslationState(env.DB)).get(translationStateKey(field.fieldId, 'fr'))!;
    expect(current.generation).toBe(3); expect(current.source_hash).toBe(state.source_hash);
    const jobs = await env.DB.prepare('SELECT generation,status FROM translation_jobs WHERE field_id=?1 AND target_locale=?2').bind(field.fieldId, 'fr').all<{ generation: number; status: string }>();
    expect(jobs.results).toEqual([{ generation: 2, status: 'obsolete' }]);
  });

  it('deleting/restoring a stable ID keeps a tombstone and invalidates earlier work', async () => {
    const config = seed(), item = config.faq.items[0]!;
    const { field } = await managed(pointer('faq', 'items', item.id, 'q'));
    await save([set(pointer('faq', 'items', item.id, 'q', 'zh'), item.q.zh, 'A different question')]);
    await save([set(pointer('faq', 'items', item.id, 'deleted'), null, true)]);
    const deleted = (await loadTranslationState(env.DB)).get(translationStateKey(field.fieldId, 'fr'))!;
    expect(deleted.deleted).toBe(1);
    await save([set(pointer('faq', 'items', item.id, 'deleted'), true, false)]);
    const restored = (await loadTranslationState(env.DB)).get(translationStateKey(field.fieldId, 'fr'))!;
    expect(restored.generation).toBeGreaterThan(deleted.generation); expect(restored.deleted).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM translation_jobs WHERE generation < ?1 AND status='pending'").bind(restored.generation).first<{ n: number }>())!.n).toBe(0);
  });

  it('two direct CAS writers produce only the winning state and audit', async () => {
    const { snapshot, config } = await read();
    const a = structuredClone(config), b = structuredClone(config);
    a.copy.fr['hero.scrollHint'] = 'Winner A'; b.copy.de['hero.scrollHint'] = 'Winner B';
    const results = await Promise.allSettled([commitDraftWrite(env.DB, { snapshot, payload: a }), commitDraftWrite(env.DB, { snapshot, payload: b })]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await loadTranslationState(env.DB)).size).toBe(1);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM audit').first<{ n: number }>())!.n).toBe(1);
  });

  it('an audit insert failure rolls back payload, revision, state and queued jobs together', async () => {
    await managed();
    const before = await read(), oldStates = Array.from((await loadTranslationState(env.DB)).values());
    await env.DB.prepare("CREATE TRIGGER draft_test_abort BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT,'test audit failure'); END").run();
    try {
      await expect(save([set('/copy/en/hero.scrollHint', before.config.copy.en['hero.scrollHint'], 'Must roll back')])).rejects.toThrow();
    } finally { await env.DB.prepare('DROP TRIGGER draft_test_abort').run(); }
    expect((await read()).snapshot).toEqual(before.snapshot);
    expect(Array.from((await loadTranslationState(env.DB)).values())).toEqual(oldStates);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM translation_jobs').first<{ n: number }>())!.n).toBe(0);
  });

  it('a fixed executor SQL guard rejects a cancelled lease even with an unchanged draft', async () => {
    const { snapshot, config } = await read(), next = structuredClone(config);
    next.copy.fr['hero.scrollHint'] = 'Must not apply';
    await expect(commitDraftWrite(env.DB, { snapshot, payload: next,
      guard: { sql: "EXISTS (SELECT 1 FROM translation_jobs WHERE id=? AND status='running' AND lease_token=?)", bindings: ['cancelled-task', 'old-lease'] },
    })).rejects.toBeInstanceOf(DraftWriteError);
    expect((await read()).snapshot).toEqual(snapshot); expect((await loadTranslationState(env.DB)).size).toBe(0);
  });
});
