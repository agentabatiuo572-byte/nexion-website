import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { LOCALES, addLegacyLocaleFields, SiteConfigSchema, validateConfig, type SiteConfig, type CopyManifest } from '../../schema/src/index.js';
import currentJson from '../seed/site-config.seed.json';
import legacyJson from '../seed/config-upgrade-legacy-v1.json';
import manifestJson from '../seed/copy-manifest.json';
import realLocaleDraft from './fixtures/legacy-locale-draft.json';
import { adaptLegacyConfig, checkDraftUpgrade, commitDraftUpgrade, CONFIG_UPGRADE_KEY, ensureDraftUpgrade, type UpgradeDraftSnapshot } from '../src/config-upgrade';
import { configRoutes, ensureInit } from '../src/config';

const current = SiteConfigSchema.parse(currentJson);
const manifest = manifestJson as unknown as CopyManifest;
const whitepaperKeys = ['title', 'summary', 'details'].map((key) => `trust.whitepaper.${key}`);
const retiredWhitepaperKeys = ['trust.whitepaper.download', 'trust.whitepaper.coverAlt'];
const whitepaperDetailsV1 = {
  en: 'v{version} · Chinese edition · {pages} pages',
  vi: 'v{version} · Bản tiếng Trung · {pages} trang',
  zh: 'v{version} · 中文版 · {pages} 页',
  es: 'v{version} · Edición en chino · {pages} páginas',
  pt: 'v{version} · Edição em chinês · {pages} páginas',
  fr: 'v{version} · Édition chinoise · {pages} pages',
  de: 'v{version} · Chinesische Ausgabe · {pages} Seiten',
  ja: 'v{version} · 中国語版 · {pages} ページ',
  ko: 'v{version} · 중국어판 · {pages}페이지',
};
const previous = legacyJson.copyDefaults as Record<'en' | 'vi' | 'zh', Record<string, string>>;
function legacy(): SiteConfig {
  const config = structuredClone(current);
  for (const locale of ['en', 'vi', 'zh'] as const) {
    config.copy[locale] = Object.fromEntries(legacyJson.copyKeys.map((key) => [key,
      Object.hasOwn(previous[locale], key) ? previous[locale][key] : current.copy[locale][key],
    ]));
  }
  config.enabledLocales = ['en', 'vi'];
  config.faq = (addLegacyLocaleFields({ faq: legacyJson.faq }, manifest.editable) as SiteConfig).faq;
  return config;
}

async function storeDraft(config: SiteConfig) {
  const payload = JSON.stringify(config);
  await env.DB.prepare('INSERT INTO config_draft (id,payload,base_revision,updated_at,draft_rev) VALUES (1,?1,1,100,7)').bind(payload).run();
  return payload;
}
async function draft() {
  return (await env.DB.prepare('SELECT payload,draft_rev,updated_at FROM config_draft WHERE id=1').first<UpgradeDraftSnapshot>())!;
}
async function count(table: 'config_draft_upgrades' | 'audit') {
  return (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
}

beforeEach(async () => {
  await env.DB.batch(['audit', 'config_draft_upgrades', 'config_versions', 'config_draft'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
});

describe('旧配置升级：保留人工内容且只写一次', () => {
  it.each(['v1', 'v2'])('白皮书%s已标记草稿升级九语旧默认并删除退休键，备份/历史/FAQ保持原样且幂等', async (version) => {
    const input = structuredClone(current);
    for (const locale of LOCALES) {
      input.copy[locale]['trust.whitepaper.details'] = whitepaperDetailsV1[locale];
      input.copy[locale]['trust.whitepaper.download'] = `Retired download ${locale}`;
      input.copy[locale]['trust.whitepaper.coverAlt'] = '';
    }
    input.copy.en['mission.lead'] = previous.en['mission.lead']!;
    input.faq.items = input.faq.items.filter((item) => item.id !== 'q10');
    const original = await storeDraft(input);
    const oldKey = `website-whitepaper-2026-09-09-${version}`;
    await env.DB.prepare('INSERT INTO config_draft_upgrades (draft_id,upgrade_key,original_payload,original_rev,upgraded_rev,applied_at,commit_nonce) VALUES (1,?1,?2,6,7,99,?3)').bind(oldKey, original, 'whitepaper-v1').run();
    await env.DB.batch(['live', 'archived'].map((status) => env.DB.prepare(
      'INSERT INTO config_versions (status,payload,created_by,created_at) VALUES (?1,?2,?3,1)',
    ).bind(status, original, 'admin')));
    const history = (await env.DB.prepare('SELECT id,status,payload FROM config_versions ORDER BY id').all()).results;
    const oldBackup = await env.DB.prepare('SELECT * FROM config_draft_upgrades WHERE upgrade_key=?1').bind(oldKey).first();

    expect(CONFIG_UPGRADE_KEY).not.toBe(oldKey);
    expect((await checkDraftUpgrade(env.DB)).status).toBe('retry');
    expect((await draft()).payload).toBe(original);
    expect(await count('config_draft_upgrades')).toBe(1);
    expect(await count('audit')).toBe(0);
    expect((await ensureDraftUpgrade(env.DB)).status).toBe('applied');
    const expected = structuredClone(input);
    for (const locale of LOCALES) {
      expect(current.copy[locale]['trust.whitepaper.details']).not.toBe(whitepaperDetailsV1[locale]);
      expected.copy[locale]['trust.whitepaper.details'] = current.copy[locale]['trust.whitepaper.details']!;
      for (const key of retiredWhitepaperKeys) delete expected.copy[locale][key];
    }
    const saved = await draft();
    expect(saved.draft_rev).toBe(8);
    expect(JSON.parse(saved.payload)).toEqual(expected);
    expect(validateConfig(expected, manifest).errors).toEqual([]);
    expect(await env.DB.prepare('SELECT original_payload,original_rev,upgraded_rev FROM config_draft_upgrades WHERE upgrade_key=?1').bind(CONFIG_UPGRADE_KEY).first()).toEqual({ original_payload: original, original_rev: 7, upgraded_rev: 8 });
    expect(await env.DB.prepare('SELECT * FROM config_draft_upgrades WHERE upgrade_key=?1').bind(oldKey).first()).toEqual(oldBackup);
    expect((await env.DB.prepare('SELECT id,status,payload FROM config_versions ORDER BY id').all()).results).toEqual(history);
    // Rollback uses this same pure adapter on a copy, without rewriting its stored source.
    expect(adaptLegacyConfig(JSON.parse(original))).toEqual({ ok: true, config: expected, changed: true });
    expect(adaptLegacyConfig(expected)).toEqual({ ok: true, config: expected, changed: false });
    expect(JSON.stringify(input)).toBe(original);
    expect((await ensureDraftUpgrade(env.DB)).status).toBe('current');
    expect(await draft()).toEqual(saved);
    expect(await count('config_draft_upgrades')).toBe(2);
    expect(await count('audit')).toBe(1);
  });

  it('九语自定义说明和空串保留，只精确匹配旧默认值，不因退休键触发旧FAQ合并', () => {
    for (const empty of [false, true]) {
      const input = structuredClone(current);
      for (const locale of LOCALES) {
        input.copy[locale]['trust.whitepaper.details'] = empty ? '' : `${whitepaperDetailsV1[locale]} `;
        input.copy[locale]['trust.whitepaper.title'] = '';
        input.copy[locale]['trust.whitepaper.summary'] = `Authored summary ${locale}`;
        for (const key of retiredWhitepaperKeys) input.copy[locale][key] = `Retired ${locale}`;
      }
      input.faq.items = input.faq.items.filter((item) => item.id !== 'q10');
      const original = JSON.stringify(input);
      const expected = structuredClone(input);
      for (const locale of LOCALES) for (const key of retiredWhitepaperKeys) delete expected.copy[locale][key];
      expect(adaptLegacyConfig(input)).toEqual({ ok: true, config: expected, changed: true });
      expect(JSON.stringify(input)).toBe(original);
    }
  });

  it('已有语言升级标记的草稿仍补九语白皮书，保留编辑/空值/FAQ及旧备份，重复执行不再写入', async () => {
    const input = structuredClone(current);
    for (const locale of LOCALES) {
      for (const key of whitepaperKeys) delete input.copy[locale][key];
      input.copy[locale]['trust.whitepaper.title'] = `Authored ${locale} title`;
    }
    input.copy.zh['trust.whitepaper.details'] = '';
    input.copy.en['mission.lead'] = previous.en['mission.lead']!;
    input.faq.items = input.faq.items.filter((item) => item.id !== 'q10');
    input.faq.items.push({ ...structuredClone(input.faq.items[0]!), id: 'faq-custom', sort: 42 });
    const original = await storeDraft(input);
    const oldKey = 'website-locales-2026-09-07-v2';
    const oldPayload = JSON.stringify(realLocaleDraft);
    await env.DB.prepare('INSERT INTO config_draft_upgrades (draft_id,upgrade_key,original_payload,original_rev,upgraded_rev,applied_at,commit_nonce) VALUES (1,?1,?2,6,7,99,?3)').bind(oldKey, oldPayload, 'previous-upgrade').run();
    await env.DB.prepare("INSERT INTO config_versions(status,payload,created_by,created_at) VALUES('live',?1,'admin',1)").bind(oldPayload).run();
    const oldBackup = await env.DB.prepare('SELECT * FROM config_draft_upgrades WHERE upgrade_key=?1').bind(oldKey).first();

    expect((await ensureDraftUpgrade(env.DB)).status).toBe('applied');
    const saved = await draft();
    const expected = structuredClone(input);
    for (const locale of LOCALES) for (const key of whitepaperKeys) {
      expect(current.copy[locale][key]?.length).toBeGreaterThan(0);
      if (!Object.hasOwn(expected.copy[locale], key)) expected.copy[locale][key] = current.copy[locale][key]!;
    }
    expect(JSON.parse(saved.payload)).toEqual(expected);
    expect(saved.draft_rev).toBe(8);
    // The archived draft keeps its authored values; publication flags target
    // placeholders absent from its intentionally blank Chinese source.
    expect(validateConfig(expected, manifest).errors).toEqual([
      expect.objectContaining({ path: 'copy.en.trust.whitepaper.details', rule: 'placeholder' }),
      expect.objectContaining({ path: 'copy.vi.trust.whitepaper.details', rule: 'placeholder' }),
    ]);
    expect(JSON.stringify(input)).toBe(original);
    expect(await env.DB.prepare('SELECT * FROM config_draft_upgrades WHERE upgrade_key=?1').bind(oldKey).first()).toEqual(oldBackup);
    expect(await env.DB.prepare('SELECT original_payload,original_rev,upgraded_rev FROM config_draft_upgrades WHERE upgrade_key=?1').bind(CONFIG_UPGRADE_KEY).first()).toEqual({ original_payload: original, original_rev: 7, upgraded_rev: 8 });
    expect((await env.DB.prepare('SELECT payload FROM config_versions').first<{ payload: string }>())!.payload).toBe(oldPayload);
    expect(await env.DB.prepare('SELECT actor,target FROM audit').first()).toEqual({ actor: 'system', target: `draft-upgrade:${CONFIG_UPGRADE_KEY}` });
    expect((await ensureDraftUpgrade(env.DB)).status).toBe('current');
    expect((await ensureDraftUpgrade(env.DB)).status).toBe('current');
    expect(await draft()).toEqual(saved);
    expect(await count('config_draft_upgrades')).toBe(2);
    expect(await count('audit')).toBe(1);
    expect(adaptLegacyConfig(expected)).toEqual({ ok: true, config: expected, changed: false });
  });

  it('原三语历史副本缺少新增语言槽时，白皮书九语使用种子且不改原件', () => {
    const input = structuredClone(current) as Omit<SiteConfig, 'copy'> & { copy: Partial<SiteConfig['copy']> };
    for (const locale of LOCALES) {
      if (['en', 'vi', 'zh'].includes(locale)) for (const key of whitepaperKeys) delete input.copy[locale]![key];
      else delete input.copy[locale];
    }
    const original = JSON.stringify(input);
    const result = adaptLegacyConfig(input);
    if (!result.ok) throw new Error('missing whitepaper keys must be upgraded');
    for (const locale of LOCALES) for (const key of whitepaperKeys) {
      expect(current.copy[locale][key]?.length).toBeGreaterThan(0);
      expect(result.config.copy[locale][key]).toBe(current.copy[locale][key]);
    }
    expect(JSON.stringify(input)).toBe(original);
  });

  it('真实旧草稿已有 q10 时，六语空槽不构成新编号冲突，升级后可保存且备份/历史原文不变', async () => {
    const original = await storeDraft(realLocaleDraft as SiteConfig);
    await env.DB.prepare("INSERT INTO config_versions(status,payload,created_by,created_at) VALUES('live',?1,'admin',1)").bind(original).run();
    expect((await ensureDraftUpgrade(env.DB)).status).toBe('applied');
    const upgraded = await draft();
    const config = SiteConfigSchema.parse(JSON.parse(upgraded.payload));
    expect(config.faq.items.find((item) => item.id === 'q10')).toEqual(realLocaleDraft.faq.items.find((item) => item.id === 'q10'));
    expect((await env.DB.prepare('SELECT original_payload FROM config_draft_upgrades WHERE upgrade_key=?1').bind(CONFIG_UPGRADE_KEY).first<{ original_payload: string }>())!.original_payload).toBe(original);
    expect((await env.DB.prepare('SELECT payload FROM config_versions').first<{ payload: string }>())!.payload).toBe(original);
    config.enabledLocales = ['en', 'vi', 'zh'];
    const saved = await configRoutes.request('/draft', { method: 'PUT', body: JSON.stringify({ payload: config, baseRevision: upgraded.draft_rev }) }, env);
    expect(saved.status).toBe(200);
    expect(JSON.parse((await draft()).payload).enabledLocales).toEqual(['en', 'vi', 'zh']);
  });

  it('已有 q10 的新语言人工内容保留，原三语或元数据真正不同的编号碰撞仍阻断', () => {
    const authored = structuredClone(realLocaleDraft);
    const item = authored.faq.items.find((entry) => entry.id === 'q10')!;
    item.q.ja = '保存済みの日本語の質問'; item.a.ja = '保存済みの日本語の回答';
    const adapted = adaptLegacyConfig(authored);
    expect(adapted.ok).toBe(true);
    if (!adapted.ok) throw new Error('existing FAQ translation must not be mistaken for an ID collision');
    expect(adapted.config.faq.items.find((entry) => entry.id === 'q10')).toEqual(item);
    for (const change of ['en', 'vi', 'zh', 'sort'] as const) {
      const conflict = structuredClone(authored);
      const changed = conflict.faq.items.find((entry) => entry.id === 'q10')!;
      if (change === 'sort') changed.sort += 1;
      else changed.a[change] += ' Authored collision';
      const original = JSON.stringify(conflict);
      const result = adaptLegacyConfig(conflict);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('real ID collision must remain blocked');
      expect(result.conflicts.some((entry) => entry.path === 'faq.q10')).toBe(true);
      expect(JSON.stringify(conflict)).toBe(original);
    }
  });

  it('三方合并保留真实 hero 编辑、更新未编辑旧默认、补全部新key与FAQ', () => {
    const input = legacy();
    input.copy.en['hero.title'] = 'Authored headline stays';
    const before = JSON.stringify(input);
    const result = adaptLegacyConfig(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unexpected conflict');
    expect(result.config.copy.en['hero.title']).toBe('Authored headline stays');
    expect(result.config.copy.en['mission.lead']).toBe(current.copy.en['mission.lead']);
    expect(result.config.copy.en['why.kicker']).toBe(current.copy.en['why.kicker']);
    expect(result.config.copy.en['trust.card1']).toBeUndefined();
    expect(result.config.faq.items).toHaveLength(10);
    expect(validateConfig(result.config, manifest).errors).toEqual([]);
    expect(JSON.stringify(input)).toBe(before);
    for (const key of ['downloads', 'stats', 'skus', 'announcement', 'seo', 'footer', 'legal'] as const) expect(result.config[key]).toEqual(input[key]);
  });

  it('FAQ 按id保留编辑、自定义、软删除和物理删除，不复活已删条目', () => {
    const input = legacy();
    input.faq.items[0]!.a.en = 'An authored FAQ answer';
    input.faq.items[1]!.deleted = true;
    const removed = input.faq.items.splice(2, 1)[0]!.id;
    input.faq.items.push({ ...structuredClone(input.faq.items[0]!), id: 'faq-custom', sort: 42, visible: false });
    const result = adaptLegacyConfig(input);
    if (!result.ok) throw new Error('unexpected conflict');
    expect(result.config.faq.items.find((item) => item.id === 'q1')?.a.en).toBe('An authored FAQ answer');
    expect(result.config.faq.items.find((item) => item.id === 'q2')?.deleted).toBe(true);
    expect(result.config.faq.items.some((item) => item.id === removed)).toBe(false);
    expect(result.config.faq.items.find((item) => item.id === 'faq-custom')).toEqual(input.faq.items.at(-1));
    expect(result.config.faq.items.find((item) => item.id === 'q10')).toEqual(current.faq.items.find((item) => item.id === 'q10'));
  });

  it('已编辑但移除的字段明确冲突，输入和数据库原文均不丢', async () => {
    const input = legacy();
    input.copy.en['trust.card1'] = 'Keep this removed-field edit';
    const payload = await storeDraft(input);
    const status = await ensureDraftUpgrade(env.DB);
    expect(status.status).toBe('blocked');
    if (status.status !== 'blocked') throw new Error('expected conflict');
    expect(status.conflicts.some((conflict) => conflict.path === 'copy.en.trust.card1')).toBe(true);
    expect((await draft()).payload).toBe(payload);
    expect((await draft()).draft_rev).toBe(7);
    expect(await count('config_draft_upgrades')).toBe(0);
    expect(await count('audit')).toBe(0);
    const validation = await configRoutes.request('/validate', { method: 'POST', body: '{}' }, env);
    expect(await validation.json()).toMatchObject({ errors: [{ rule: 'structure' }] });
  });

  it('新增FAQ id与既有自定义内容碰撞时阻断，不覆盖该条目', () => {
    const input = legacy();
    input.faq.items.push({ ...structuredClone(input.faq.items[0]!), id: 'q10', a: { ...input.faq.items[0]!.a, en: 'Custom', vi: 'Custom', zh: 'Custom' } });
    const before = JSON.stringify(input);
    const result = adaptLegacyConfig(input);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected conflict');
    expect(result.conflicts.some((conflict) => conflict.path === 'faq.q10')).toBe(true);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('备份原payload、CAS升rev、system审计同事务，所有历史payload保持字节原样', async () => {
    const input = legacy();
    input.copy.en['hero.title'] = 'Current operator headline';
    const original = await storeDraft(input);
    await env.DB.batch(['live', 'archived', 'failed'].map((status) => env.DB.prepare(
      'INSERT INTO config_versions (status,payload,created_by,created_at) VALUES (?1,?2,?3,1)',
    ).bind(status, JSON.stringify(legacy()), 'admin')));
    const before = (await env.DB.prepare('SELECT id,status,payload FROM config_versions ORDER BY id').all()).results;
    expect((await ensureInit(env.DB)).status).toBe('retry');
    expect((await draft()).payload).toBe(original);
    expect((await ensureDraftUpgrade(env.DB)).status).toBe('applied');
    expect((await draft()).draft_rev).toBe(8);
    const backup = await env.DB.prepare('SELECT original_payload,original_rev,upgraded_rev FROM config_draft_upgrades WHERE upgrade_key=?1').bind(CONFIG_UPGRADE_KEY).first();
    expect(backup).toEqual({ original_payload: original, original_rev: 7, upgraded_rev: 8 });
    expect((await env.DB.prepare('SELECT actor,action,target FROM audit').first())).toEqual({ actor: 'system', action: 'config.save', target: `draft-upgrade:${CONFIG_UPGRADE_KEY}` });
    expect((await env.DB.prepare('SELECT id,status,payload FROM config_versions ORDER BY id').all()).results).toEqual(before);
    const res = await configRoutes.request('/', {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ configUpgrade: { status: 'current' }, draft: { draftRev: 8 } });
  });

  it('刷新不重复升rev；升级后主动改回旧默认、删除新增FAQ也不会被改回', async () => {
    await storeDraft(legacy());
    await ensureDraftUpgrade(env.DB);
    const row = await draft();
    const edited = JSON.parse(row.payload) as SiteConfig;
    edited.copy.en['mission.lead'] = previous.en['mission.lead']!;
    edited.copy.en['trust.whitepaper.details'] = whitepaperDetailsV1.en;
    edited.faq.items = edited.faq.items.filter((item) => item.id !== 'q10');
    await env.DB.prepare('UPDATE config_draft SET payload=?1,draft_rev=draft_rev+1 WHERE id=1').bind(JSON.stringify(edited)).run();
    const before = await draft();
    await ensureDraftUpgrade(env.DB);
    await ensureDraftUpgrade(env.DB);
    expect(await draft()).toEqual(before);
    expect(await count('config_draft_upgrades')).toBe(1);
    expect(await count('audit')).toBe(1);
    expect((await checkDraftUpgrade(env.DB)).status).toBe('current');
  });

  it('新结构首次标记不升rev、不写虚假升级审计', async () => {
    await storeDraft(current);
    const before = await draft();
    expect((await ensureDraftUpgrade(env.DB)).status).toBe('current');
    expect((await ensureDraftUpgrade(env.DB)).status).toBe('current');
    expect(await draft()).toEqual(before);
    expect(await count('config_draft_upgrades')).toBe(1);
    expect(await count('audit')).toBe(0);
  });

  it('并发升级只提交一份备份、一条审计和一次revision', async () => {
    await storeDraft(legacy());
    await Promise.all([ensureDraftUpgrade(env.DB), ensureDraftUpgrade(env.DB), ensureDraftUpgrade(env.DB)]);
    expect((await draft()).draft_rev).toBe(8);
    expect(await count('config_draft_upgrades')).toBe(1);
    expect(await count('audit')).toBe(1);
  });

  it.each(['retired-key', 'missing-added-key', 'unknown-added-key', 'unknown-nested'])(
    '已有当前marker仍检查真实结构：%s不伪造兼容、不改原文', async (kind) => {
      await storeDraft(current);
      await ensureDraftUpgrade(env.DB);
      const invalid = structuredClone(current);
      if (kind === 'retired-key') invalid.copy.en['trust.whitepaper.download'] = 'Retired';
      if (kind === 'missing-added-key') delete invalid.copy.ja['hero.title'];
      if (kind === 'unknown-added-key') invalid.copy.ja['unknown.custom'] = 'Keep';
      if (kind === 'unknown-nested') Object.assign(invalid.footer, { customNote: 'Keep' });
      await env.DB.prepare('UPDATE config_draft SET payload=?1,draft_rev=draft_rev+1 WHERE id=1').bind(JSON.stringify(invalid)).run();
      const before = await draft();
      expect((await checkDraftUpgrade(env.DB)).status).toBe('blocked');
      expect((await ensureDraftUpgrade(env.DB)).status).toBe('blocked');
      expect(await draft()).toEqual(before);
      expect(await count('config_draft_upgrades')).toBe(1);
      expect(await count('audit')).toBe(0);
    },
  );

  it('适配器快速路径也验证新增语言的完整key树，commit拒绝不完整的升级结果', async () => {
    const invalid = structuredClone(current);
    delete invalid.copy.ko['hero.title'];
    expect(adaptLegacyConfig(invalid).ok).toBe(false);
    await storeDraft(legacy());
    const before = await draft();
    expect((await commitDraftUpgrade(env.DB, before, { ok: true, config: invalid, changed: true })).status).toBe('blocked');
    expect(await draft()).toEqual(before);
    expect(await count('config_draft_upgrades')).toBe(0);
    expect(await count('audit')).toBe(0);
  });

  it('CAS失败后不把并发写入的marker当成兼容证明', async () => {
    const input = legacy();
    await storeDraft(input);
    const before = await draft();
    const adapted = adaptLegacyConfig(input);
    if (!adapted.ok) throw new Error('fixture must adapt');
    await env.DB.prepare('INSERT INTO config_draft_upgrades(draft_id,upgrade_key,original_payload,original_rev,upgraded_rev,applied_at,commit_nonce) VALUES(1,?1,?2,7,7,1,?3)')
      .bind(CONFIG_UPGRADE_KEY, before.payload, 'stale-winner').run();
    expect((await commitDraftUpgrade(env.DB, before, adapted)).status).toBe('blocked');
    expect(await draft()).toEqual(before);
    expect(await count('audit')).toBe(0);
  });

  it('CAS快照过时不写备份/标记/审计，重读后保留并发编辑再升级', async () => {
    const input = legacy();
    await storeDraft(input);
    const snapshot = await draft();
    const upgrade = adaptLegacyConfig(input);
    if (!upgrade.ok) throw new Error('unexpected conflict');
    input.copy.en['hero.title'] = 'Saved during upgrade';
    await env.DB.prepare('UPDATE config_draft SET payload=?1,draft_rev=8 WHERE id=1').bind(JSON.stringify(input)).run();
    expect((await commitDraftUpgrade(env.DB, snapshot, upgrade)).status).toBe('retry');
    expect((await draft()).payload).toBe(JSON.stringify(input));
    expect(await count('config_draft_upgrades')).toBe(0);
    expect(await count('audit')).toBe(0);
    await ensureDraftUpgrade(env.DB);
    expect(JSON.parse((await draft()).payload).copy.en['hero.title']).toBe('Saved during upgrade');
    expect((await draft()).draft_rev).toBe(9);
  });

  it('删除草稿会清除对应marker，重建旧草稿仍可安全升级', async () => {
    await storeDraft(legacy());
    await ensureDraftUpgrade(env.DB);
    await env.DB.prepare('DELETE FROM config_draft WHERE id=1').run();
    expect(await count('config_draft_upgrades')).toBe(0);
    await storeDraft(legacy());
    expect((await ensureDraftUpgrade(env.DB)).status).toBe('applied');
  });

  it('审计写入失败时整批回滚，原草稿、revision和备份标记均不改变', async () => {
    const original = await storeDraft(legacy());
    await env.DB.prepare("CREATE TRIGGER fail_upgrade_audit BEFORE INSERT ON audit BEGIN SELECT RAISE(ABORT, 'injected-audit-failure'); END").run();
    try {
      await expect(ensureDraftUpgrade(env.DB)).rejects.toThrow();
      expect((await draft()).payload).toBe(original);
      expect((await draft()).draft_rev).toBe(7);
      expect(await count('config_draft_upgrades')).toBe(0);
      expect(await count('audit')).toBe(0);
    } finally { await env.DB.prepare('DROP TRIGGER fail_upgrade_audit').run(); }
  });

  it('未知自定义copy键和重复FAQ id都阻断，不能被合并器静默丢弃', () => {
    const unknown = legacy();
    unknown.copy.en['unknown.custom'] = 'Preserve this';
    const result = adaptLegacyConfig(unknown);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected conflict');
    expect(result.conflicts.some((conflict) => conflict.path === 'copy.en.unknown.custom')).toBe(true);
    const duplicate = legacy();
    duplicate.faq.items.push(structuredClone(duplicate.faq.items[0]!));
    expect(adaptLegacyConfig(duplicate).ok).toBe(false);
  });

  it('同revision的并发保存只能成功一次，失败方不增加审计也不覆盖胜者', async () => {
    await storeDraft(current);
    await ensureInit(env.DB);
    const row = await draft();
    const a = JSON.parse(row.payload) as SiteConfig;
    const b = structuredClone(a);
    a.copy.en['hero.title'] = 'Concurrent save A';
    b.copy.en['hero.title'] = 'Concurrent save B';
    const results = await Promise.all([a, b].map((payload) => configRoutes.request('/draft', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payload, baseRevision: row.draft_rev }),
    }, env)));
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const winner = results[0]!.status === 200 ? a : b;
    expect(JSON.parse((await draft()).payload).copy.en['hero.title']).toBe(winner.copy.en['hero.title']);
    expect((await draft()).draft_rev).toBe(row.draft_rev + 1);
    expect(await count('audit')).toBe(1);
  });

  it('显式解决稿通过候选校验后原子备份冲突原文、保存一次、记录明确审计，历史不动', async () => {
    const input = legacy();
    input.copy.en['trust.card1'] = 'A removed field edited by the operator';
    const original = await storeDraft(input);
    await env.DB.prepare("INSERT INTO config_versions (status,payload,created_by,created_at) VALUES ('live',?1,'admin',1)").bind(original).run();
    const history = (await env.DB.prepare('SELECT id,payload FROM config_versions').all()).results;
    const payload = structuredClone(current);
    payload.copy.en['hero.title'] = 'Explicitly resolved headline';
    const validation = await configRoutes.request('/validate', { method: 'POST', body: JSON.stringify({ payload }) }, env);
    expect(await validation.json()).toMatchObject({ errors: [] });
    expect((await draft()).payload).toBe(original);
    const response = await configRoutes.request('/draft', {
      method: 'PUT', body: JSON.stringify({ payload, baseRevision: 7, resolveUpgrade: true }),
    }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, resolvedUpgrade: true, draftRev: 8 });
    expect(JSON.parse((await draft()).payload).copy.en['hero.title']).toBe(payload.copy.en['hero.title']);
    expect(await env.DB.prepare('SELECT original_payload,original_rev,upgraded_rev FROM config_draft_upgrades').first()).toEqual({ original_payload: original, original_rev: 7, upgraded_rev: 8 });
    expect(await env.DB.prepare('SELECT actor,reason FROM audit').first()).toEqual({ actor: 'admin', reason: '显式解决旧草稿升级冲突；原冲突内容已备份，历史版本内容保持原样' });
    expect((await env.DB.prepare('SELECT id,payload FROM config_versions').all()).results).toEqual(history);
    const saved = await draft();
    expect((await ensureInit(env.DB)).status).toBe('current');
    expect(await draft()).toEqual(saved);
    expect(await count('audit')).toBe(1);
  });

  it.each([
    { name: '普通保存不能隐式解决', body: { baseRevision: 7 }, status: 409 },
    { name: '旧revision不能覆盖', body: { baseRevision: 6, resolveUpgrade: true }, status: 409 },
  ])('$name', async ({ body, status }) => {
    const input = legacy();
    input.copy.en['trust.card1'] = 'Keep the conflict untouched';
    const original = await storeDraft(input);
    const response = await configRoutes.request('/draft', { method: 'PUT', body: JSON.stringify({ payload: current, ...body }) }, env);
    expect(response.status).toBe(status);
    expect((await draft()).payload).toBe(original);
    expect((await draft()).draft_rev).toBe(7);
    expect(await count('config_draft_upgrades')).toBe(0);
    expect(await count('audit')).toBe(0);
  });

  it.each(['missing-key', 'unknown-copy', 'unknown-nested', 'unknown-root', 'bad-structure', 'invalid-url'])(
    '不合法解决稿 %s 在校验和保存都拦下，不剥键、不写备份或marker', async (kind) => {
      const input = legacy();
      input.copy.en['trust.card1'] = 'Keep the conflict untouched';
      const original = await storeDraft(input);
      const payload = structuredClone(current) as SiteConfig & { extra?: string };
      if (kind === 'missing-key') delete payload.copy.en['why.kicker'];
      if (kind === 'unknown-copy') payload.copy.en['unknown.key'] = 'Preserve';
      if (kind === 'unknown-nested') Object.assign(payload.faq.items[0]!, { customNote: 'Preserve' });
      if (kind === 'unknown-root') payload.extra = 'Preserve';
      if (kind === 'bad-structure') Object.assign(payload, { downloads: null });
      if (kind === 'invalid-url') payload.downloads.ios = { enabled: true, url: 'http://example.com/app' };
      const validation = await configRoutes.request('/validate', { method: 'POST', body: JSON.stringify({ payload }) }, env);
      expect((await validation.json() as { errors: unknown[] }).errors.length).toBeGreaterThan(0);
      const response = await configRoutes.request('/draft', { method: 'PUT', body: JSON.stringify({ payload, baseRevision: 7, resolveUpgrade: true }) }, env);
      expect(response.status).toBe(400);
      expect((await draft()).payload).toBe(original);
      expect((await draft()).draft_rev).toBe(7);
      expect(await count('config_draft_upgrades')).toBe(0);
      expect(await count('audit')).toBe(0);
    },
  );

  it('两个并发解决请求只接受一个，原文备份和审计均只有一条', async () => {
    const input = legacy();
    input.copy.en['trust.card1'] = 'Original conflict';
    const original = await storeDraft(input);
    const candidates = ['Resolved A', 'Resolved B'].map((headline) => {
      const payload = structuredClone(current);
      payload.copy.en['hero.title'] = headline;
      return payload;
    });
    const responses = await Promise.all(candidates.map((payload) => configRoutes.request('/draft', {
      method: 'PUT', body: JSON.stringify({ payload, baseRevision: 7, resolveUpgrade: true }),
    }, env)));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(JSON.parse((await draft()).payload).copy.en['hero.title']).toBe(candidates[responses[0]!.status === 200 ? 0 : 1]!.copy.en['hero.title']);
    expect((await draft()).draft_rev).toBe(8);
    expect((await env.DB.prepare('SELECT original_payload FROM config_draft_upgrades').first<{ original_payload: string }>())!.original_payload).toBe(original);
    expect(await count('config_draft_upgrades')).toBe(1);
    expect(await count('audit')).toBe(1);
  });

  it('已有当前marker的损坏修订可显式解决；并发只备份审计一次，再次损坏可再解决且原marker不改', async () => {
    await storeDraft(current);
    await ensureInit(env.DB);
    await ensureDraftUpgrade(env.DB);
    const originalMarker = await env.DB.prepare('SELECT * FROM config_draft_upgrades WHERE upgrade_key=?1').bind(CONFIG_UPGRADE_KEY).first();
    const history = (await env.DB.prepare('SELECT id,payload FROM config_versions').all()).results;
    for (const invalidRevision of [8, 10]) {
      const invalid = structuredClone(current);
      invalid.copy.en['unknown.custom'] = `Preserve damaged revision ${invalidRevision}`;
      const original = JSON.stringify(invalid);
      await env.DB.prepare('UPDATE config_draft SET payload=?1,draft_rev=?2 WHERE id=1').bind(original,invalidRevision).run();
      expect((await checkDraftUpgrade(env.DB)).status).toBe('blocked');
      const candidates = ['A', 'B'].map((suffix) => {
        const payload = structuredClone(current);
        payload.copy.en['hero.title'] = `Resolved revision ${invalidRevision} ${suffix}`;
        for (const locale of LOCALES) payload.copy[locale]['trust.whitepaper.details'] = whitepaperDetailsV1[locale];
        expect(validateConfig(payload, manifest).errors).toEqual([]);
        return payload;
      });
      const responses = await Promise.all(candidates.map((payload) => configRoutes.request('/draft', {
        method:'PUT',body:JSON.stringify({payload,baseRevision:invalidRevision,resolveUpgrade:true}),
      },env)));
      expect(responses.map((response) => response.status).sort()).toEqual([200,409]);
      const key = `${CONFIG_UPGRADE_KEY}:resolution:${invalidRevision}`;
      expect(await env.DB.prepare('SELECT original_payload,original_rev,upgraded_rev FROM config_draft_upgrades WHERE upgrade_key=?1').bind(key).first()).toEqual({original_payload:original,original_rev:invalidRevision,upgraded_rev:invalidRevision+1});
      expect(await env.DB.prepare('SELECT COUNT(*) n FROM audit WHERE target=?1').bind(`draft-upgrade:${key}`).first()).toEqual({n:1});
      const refreshed = await configRoutes.request('/',{},env);
      expect(await refreshed.json()).toMatchObject({configUpgrade:{status:'current'},draft:{draftRev:invalidRevision+1,payload:{copy:{en:{'trust.whitepaper.details':whitepaperDetailsV1.en}}}}});
      const saved = await draft();
      expect(JSON.parse(saved.payload).copy.en['hero.title']).toBe(candidates[responses[0]!.status === 200 ? 0 : 1]!.copy.en['hero.title']);
      expect((await ensureDraftUpgrade(env.DB)).status).toBe('current');
      expect(await draft()).toEqual(saved);
      expect(await env.DB.prepare('SELECT * FROM config_draft_upgrades WHERE upgrade_key=?1').bind(CONFIG_UPGRADE_KEY).first()).toEqual(originalMarker);
    }
    expect(await count('config_draft_upgrades')).toBe(3);
    expect(await count('audit')).toBe(2);
    expect((await env.DB.prepare('SELECT id,payload FROM config_versions').all()).results).toEqual(history);
  });

  it('无法解析的旧原文也可显式解决，仍按原字节备份', async () => {
    await storeDraft(current);
    await env.DB.prepare('UPDATE config_draft SET payload=?1 WHERE id=1').bind('invalid legacy JSON').run();
    const response = await configRoutes.request('/draft', { method: 'PUT', body: JSON.stringify({ payload: current, baseRevision: 7, resolveUpgrade: true }) }, env);
    expect(response.status).toBe(200);
    expect((await env.DB.prepare('SELECT original_payload FROM config_draft_upgrades').first<{ original_payload: string }>())!.original_payload).toBe('invalid legacy JSON');
  });
});
