import { LOCALES, SiteConfigSchema, validateConfig, type CopyManifest, type Finding, type SiteConfig } from '../../schema/src/index.js';
import currentSeedJson from '../seed/site-config.seed.json';
import legacyJson from '../seed/config-upgrade-legacy-v1.json';
import manifestJson from '../seed/copy-manifest.json';
import { prepareAudit } from './audit';

export const CONFIG_UPGRADE_KEY = 'website-copy-2026-09-04-v1';
const CURRENT = SiteConfigSchema.parse(currentSeedJson);
const LEGACY = legacyJson as {
  copyKeys: string[];
  copyDefaults: Record<(typeof LOCALES)[number], Record<string, string>>;
  faq: SiteConfig['faq'];
};
const MISSING = Symbol('missing');
type Value = unknown | typeof MISSING;
export interface UpgradeConflict { path: string; reason: string }
export type ConfigUpgradeResult =
  | { ok: true; config: SiteConfig; changed: boolean }
  | { ok: false; conflicts: UpgradeConflict[] };
export type DraftUpgradeStatus =
  | { status: 'current' | 'applied' | 'retry' }
  | { status: 'blocked'; conflicts: UpgradeConflict[] };
export interface UpgradeDraftSnapshot { payload: string; draft_rev: number; updated_at: number }

const object = (value: Value): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value: Record<string, unknown>, key: string): Value => Object.hasOwn(value, key) ? value[key] : MISSING;

function equal(a: Value, b: Value): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => equal(value, b[index]));
  if (!object(a) || !object(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]));
}

const clone = (value: Value): Value => value === MISSING ? MISSING : structuredClone(value);

/** Explicit resolutions must be complete current configs; parsing must not silently strip authored fields. */
export function validateUpgradeResolution(input: unknown):
  | { ok: true; config: SiteConfig }
  | { ok: false; issues: Finding[] } {
  const parsed = SiteConfigSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.slice(0, 20).map((issue) => ({
    path: issue.path.join('.'), rule: 'structure', message: issue.message,
  })) };
  if (!equal(input, parsed.data)) return { ok: false, issues: [{
    path: 'draft', rule: 'structure', message: '解决稿包含当前结构不支持的额外字段，请明确处理后再提交；系统不会自动删除这些内容',
  }] };
  const { errors } = validateConfig(parsed.data, manifestJson as unknown as CopyManifest);
  return errors.length ? { ok: false, issues: errors } : { ok: true, config: parsed.data };
}

/** Supported fields retain edits; a removed field can disappear only when still equal to its old default. */
function merge(base: Value, target: Value, draft: Value, path: string, conflicts: UpgradeConflict[]): Value {
  if (equal(draft, base)) return clone(target);
  if (equal(target, base)) return clone(draft);
  if (target === MISSING) {
    if (draft !== MISSING) conflicts.push({ path, reason: '字段已从当前版本移除，但草稿中有修改；原内容已保留，需先处理冲突' });
    return clone(draft);
  }
  if (draft === MISSING) return MISSING; // An existing item/field was deliberately removed.
  if (object(target) && object(draft)) {
    const old = object(base) ? base : {};
    const out: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(old), ...Object.keys(target), ...Object.keys(draft)])) {
      const value = merge(own(old, key), own(target, key), own(draft, key), `${path}.${key}`, conflicts);
      if (value !== MISSING) Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  if (typeof target !== typeof draft || Array.isArray(target) !== Array.isArray(draft)) {
    conflicts.push({ path, reason: '字段结构已变化，草稿修改无法自动合并；原内容已保留' });
  }
  return clone(draft);
}

function mergeFaq(draft: SiteConfig['faq']['items'], conflicts: UpgradeConflict[]): SiteConfig['faq']['items'] {
  const old = new Map(LEGACY.faq.items.map((item) => [item.id, item]));
  const target = new Map(CURRENT.faq.items.map((item) => [item.id, item]));
  const local = new Map(draft.map((item) => [item.id, item]));
  if (local.size !== draft.length) {
    conflicts.push({ path: 'faq.items', reason: 'FAQ 标识重复，无法安全合并；原列表已保留' });
    return structuredClone(draft);
  }
  const result: SiteConfig['faq']['items'] = [];
  // Keep authored order; only new defaults are appended. The authored sort values remain authoritative.
  for (const id of new Set([...local.keys(), ...target.keys(), ...old.keys()])) {
    const before = old.get(id) ?? MISSING;
    const next = target.get(id) ?? MISSING;
    const item = local.get(id) ?? MISSING;
    if (before === MISSING && next !== MISSING && item !== MISSING && !equal(next, item)) {
      conflicts.push({ path: `faq.${id}`, reason: '新增 FAQ 标识与草稿中的自定义条目冲突；原条目已保留' });
      continue;
    }
    const value = merge(before, next, item, `faq.${id}`, conflicts);
    if (value !== MISSING) result.push(value as SiteConfig['faq']['items'][number]);
  }
  return result;
}

/** Pure adapter for drafts and historical rollback copies. Never rewrites a stored version. */
export function adaptLegacyConfig(input: unknown): ConfigUpgradeResult {
  const parsed = SiteConfigSchema.safeParse(input);
  if (!parsed.success) return {
    ok: false,
    conflicts: parsed.error.issues.slice(0, 20).map((issue) => ({ path: issue.path.join('.'), reason: '旧配置结构无法安全识别，原内容已保留' })),
  };
  // Clone the original object, not Zod's stripped result: an upgrade must not silently drop extra data.
  const draft = structuredClone(input) as SiteConfig;
  const hasLegacyShape = LOCALES.some((locale) => {
    const actual = Object.keys(draft.copy[locale]);
    return actual.length !== Object.keys(CURRENT.copy[locale]).length || actual.some((key) => !Object.hasOwn(CURRENT.copy[locale], key));
  });
  if (!hasLegacyShape) return { ok: true, config: draft, changed: false };

  const conflicts: UpgradeConflict[] = [];
  for (const locale of LOCALES) {
    const old = Object.fromEntries(LEGACY.copyKeys.map((key) => [key,
      Object.hasOwn(LEGACY.copyDefaults[locale], key) ? LEGACY.copyDefaults[locale][key] : CURRENT.copy[locale][key],
    ]));
    for (const key of Object.keys(draft.copy[locale])) {
      if (!Object.hasOwn(old, key) && !Object.hasOwn(CURRENT.copy[locale], key)) {
        conflicts.push({ path: `copy.${locale}.${key}`, reason: '字段不属于旧版或当前文案清单，无法安全迁移；原内容已保留' });
      }
    }
    draft.copy[locale] = merge(old, CURRENT.copy[locale], draft.copy[locale], `copy.${locale}`, conflicts) as Record<string, string>;
  }
  draft.faq.items = mergeFaq(draft.faq.items, conflicts);
  if (conflicts.length) return { ok: false, conflicts };
  return { ok: true, config: draft, changed: !equal(input, draft) };
}

/** Backup, CAS, marker and audit are one D1 transaction; a stale snapshot cannot write any of them. */
export async function commitDraftUpgrade(
  db: D1Database,
  snapshot: UpgradeDraftSnapshot,
  upgrade: Extract<ConfigUpgradeResult, { ok: true }>,
  options: { explicitResolution?: boolean } = {},
): Promise<DraftUpgradeStatus> {
  const now = Date.now();
  const nonce = crypto.randomUUID();
  const nextRev = snapshot.draft_rev + (upgrade.changed ? 1 : 0);
  const statements = [db.prepare(
    `INSERT INTO config_draft_upgrades (draft_id, upgrade_key, original_payload, original_rev, upgraded_rev, applied_at, commit_nonce)
     SELECT id, ?1, payload, draft_rev, ?2, ?3, ?4 FROM config_draft
      WHERE id=1 AND draft_rev=?5 AND payload=?6
        AND NOT EXISTS (SELECT 1 FROM config_draft_upgrades WHERE draft_id=1 AND upgrade_key=?1)`,
  ).bind(CONFIG_UPGRADE_KEY, nextRev, now, nonce, snapshot.draft_rev, snapshot.payload)];
  if (upgrade.changed) {
    statements.push(db.prepare(
      `UPDATE config_draft SET payload=?1, draft_rev=?2, updated_at=?3
        WHERE id=1 AND draft_rev=?4 AND payload=?5
          AND EXISTS (SELECT 1 FROM config_draft_upgrades WHERE draft_id=1 AND upgrade_key=?6 AND commit_nonce=?7)`,
    ).bind(JSON.stringify(upgrade.config), nextRev, now, snapshot.draft_rev, snapshot.payload, CONFIG_UPGRADE_KEY, nonce));
    statements.push(prepareAudit(db, {
      action: 'config.save', actor: options.explicitResolution ? 'admin' : 'system', target: `draft-upgrade:${CONFIG_UPGRADE_KEY}`,
      before: `draft revision ${snapshot.draft_rev}; original payload backed up`,
      after: options.explicitResolution
        ? `draft revision ${nextRev}; explicit conflict resolution; original conflicting payload backed up`
        : `draft revision ${nextRev}; current fields merged; authored edits preserved`,
      reason: options.explicitResolution
        ? '显式解决旧草稿升级冲突；原冲突内容已备份，历史版本内容保持原样'
        : '站点配置格式升级；历史版本内容保持原样',
    }, { configUpgradeKey: CONFIG_UPGRADE_KEY, configUpgradeNonce: nonce }));
  }
  const results = await db.batch(statements);
  if ((results[0]?.meta.changes ?? 0) > 0) return { status: upgrade.changed ? 'applied' : 'current' };
  const winner = await db.prepare('SELECT upgrade_key FROM config_draft_upgrades WHERE draft_id=1 AND upgrade_key=?1').bind(CONFIG_UPGRADE_KEY).first();
  return { status: winner ? 'current' : 'retry' };
}

export async function ensureDraftUpgrade(db: D1Database): Promise<DraftUpgradeStatus> {
  const marked = await db.prepare('SELECT upgrade_key FROM config_draft_upgrades WHERE draft_id=1 AND upgrade_key=?1').bind(CONFIG_UPGRADE_KEY).first();
  if (marked) return { status: 'current' };
  const draft = await db.prepare('SELECT payload, draft_rev, updated_at FROM config_draft WHERE id=1').first<UpgradeDraftSnapshot>();
  if (!draft) return { status: 'retry' };
  let input: unknown;
  try { input = JSON.parse(draft.payload); } catch {
    return { status: 'blocked', conflicts: [{ path: 'draft', reason: '旧草稿无法解析，原内容已保留' }] };
  }
  const upgrade = adaptLegacyConfig(input);
  if (!upgrade.ok) return { status: 'blocked', conflicts: upgrade.conflicts };
  return commitDraftUpgrade(db, draft, upgrade);
}
