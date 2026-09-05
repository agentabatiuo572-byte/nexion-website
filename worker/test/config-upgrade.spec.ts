import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { SiteConfigSchema, validateConfig, type SiteConfig, type CopyManifest } from '../../schema/src/index.js';
import currentJson from '../seed/site-config.seed.json';
import legacyJson from '../seed/config-upgrade-legacy-v1.json';
import manifestJson from '../seed/copy-manifest.json';
import { adaptLegacyConfig, commitDraftUpgrade, CONFIG_UPGRADE_KEY, ensureDraftUpgrade, type UpgradeDraftSnapshot } from '../src/config-upgrade';
import { configRoutes, ensureInit } from '../src/config';

const current = SiteConfigSchema.parse(currentJson);
const manifest = manifestJson as unknown as CopyManifest;
const previous = legacyJson.copyDefaults as Record<'en' | 'vi' | 'zh', Record<string, string>>;
function legacy(): SiteConfig {
  const config = structuredClone(current);
  for (const locale of ['en', 'vi', 'zh'] as const) {
    config.copy[locale] = Object.fromEntries(legacyJson.copyKeys.map((key) => [key,
      Object.hasOwn(previous[locale], key) ? previous[locale][key] : current.copy[locale][key],
    ]));
  }
  config.faq = structuredClone(legacyJson.faq);
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
    input.faq.items.push({ ...structuredClone(input.faq.items[0]!), id: 'q10', a: { en: 'Custom', vi: 'Custom', zh: 'Custom' } });
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
    expect((await ensureInit(env.DB)).status).toBe('applied');
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
    edited.faq.items = edited.faq.items.filter((item) => item.id !== 'q10');
    await env.DB.prepare('UPDATE config_draft SET payload=?1,draft_rev=draft_rev+1 WHERE id=1').bind(JSON.stringify(edited)).run();
    const before = await draft();
    await ensureDraftUpgrade(env.DB);
    await ensureDraftUpgrade(env.DB);
    expect(await draft()).toEqual(before);
    expect(await count('config_draft_upgrades')).toBe(1);
    expect(await count('audit')).toBe(1);
    const adapted = adaptLegacyConfig(edited);
    expect(adapted).toEqual({ ok: true, config: edited, changed: false });
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

  it('无法解析的旧原文也可显式解决，仍按原字节备份', async () => {
    await storeDraft(current);
    await env.DB.prepare('UPDATE config_draft SET payload=?1 WHERE id=1').bind('invalid legacy JSON').run();
    const response = await configRoutes.request('/draft', { method: 'PUT', body: JSON.stringify({ payload: current, baseRevision: 7, resolveUpgrade: true }) }, env);
    expect(response.status).toBe(200);
    expect((await env.DB.prepare('SELECT original_payload FROM config_draft_upgrades').first<{ original_payload: string }>())!.original_payload).toBe('invalid legacy JSON');
  });
});
