// @ts-expect-error —— 站上门 1 的同一份词表(.mjs 单源,禁副本);类型由下方使用处收窄
import { FORBIDDEN_PATTERNS } from '../../scripts/forbidden-patterns.mjs';
import type { CopyManifest } from './manifest.js';
import { MOCK_STAT_ANCHORS, SENSITIVE_COPY_PREFIXES, SiteConfigSchema, type SiteConfig, LOCALES } from './site-config.js';

/* 校验器(CON04/05/06/07/08/09 各 E 条的发布级判据汇总,单源:控制台保存、发布前置校验、
   物化脚本三处同 import)。errors = 发布阻断;warnings = 软警告(可存草稿可发布,面上提示)。 */

export interface Finding {
  path: string;
  rule: string;
  message: string;
}
export interface ValidationResult {
  errors: Finding[];
  warnings: Finding[];
}

const PATTERNS = FORBIDDEN_PATTERNS as Array<[RegExp, string]>;

function scan(text: string): Array<{ label: string; match: string }> {
  const hits: Array<{ label: string; match: string }> = [];
  for (const [re, label] of PATTERNS) {
    const m = text.match(re);
    if (m) hits.push({ label, match: m[0]! });
  }
  return hits;
}

const PLACEHOLDER_RE = /\{[a-zA-Z][a-zA-Z0-9_]*\}/g;
const tokensOf = (s: string) => new Set(s.match(PLACEHOLDER_RE) ?? []);

/** 遍历配置里全部「会上站的人写文本」:文案树 + faq + sku 标语 + 公告 + seo + legal */
function* allProse(c: SiteConfig): Generator<[string, string]> {
  for (const loc of LOCALES) for (const [k, v] of Object.entries(c.copy[loc])) yield [`copy.${loc}.${k}`, v];
  for (const it of c.faq.items)
    for (const loc of LOCALES) {
      yield [`faq.${it.id}.q.${loc}`, it.q[loc]];
      yield [`faq.${it.id}.a.${loc}`, it.a[loc]];
    }
  for (const s of c.skus) for (const loc of LOCALES) yield [`skus.${s.id}.tagline.${loc}`, s.tagline[loc]];
  for (const loc of LOCALES) yield [`announcement.text.${loc}`, c.announcement.text[loc]];
  for (const [pid, p] of Object.entries(c.seo.pages))
    for (const loc of LOCALES) {
      yield [`seo.${pid}.title.${loc}`, p.title[loc]];
      yield [`seo.${pid}.description.${loc}`, p.description[loc]];
    }
  for (const doc of ['terms', 'privacy', 'appPrivacy'] as const)
    for (const loc of LOCALES) yield [`legal.${doc}.${loc}`, c.legal[doc].md[loc]];
}

export function validateConfig(c: SiteConfig, manifest: CopyManifest): ValidationResult {
  const errors: Finding[] = [];
  const warnings: Finding[] = [];

  // 0) 结构(通常入口已 parse 过;此处兜底幂等)
  const parsed = SiteConfigSchema.safeParse(c);
  if (!parsed.success) {
    for (const iss of parsed.error.issues.slice(0, 20))
      errors.push({ path: iss.path.join('.'), rule: 'structure', message: iss.message });
    return { errors, warnings };
  }

  // 1) key 树=代码所有(CON04-③):copy 键集必须与可编辑清单精确相等
  const editable = new Set(manifest.editable);
  for (const loc of LOCALES) {
    const keys = Object.keys(c.copy[loc]);
    for (const k of keys) if (!editable.has(k)) errors.push({ path: `copy.${loc}.${k}`, rule: 'unknown-key', message: '非法 key(后台不可增删 key)' });
    for (const k of manifest.editable) if (!(k in c.copy[loc])) errors.push({ path: `copy.${loc}.${k}`, rule: 'missing-key', message: '缺 key' });
  }

  // 2) 禁用词(§1.4;拦截页文案豁免条款不在 SiteConfig 内,无需豁免面)
  for (const [path, text] of allProse(c))
    for (const h of scan(text)) errors.push({ path, rule: 'forbidden-word', message: `合规拦截 [${h.label}]:「${h.match}」` });

  // 3) 占位符守恒 + 换行结构软警(CON04-E2)
  for (const k of manifest.editable) {
    const en = c.copy.en[k] ?? '';
    const enTokens = tokensOf(en);
    for (const loc of ['vi', 'zh'] as const) {
      const v = c.copy[loc][k] ?? '';
      if (!v) continue; // 缺译由 4) 报
      for (const t of enTokens) if (!tokensOf(v).has(t)) errors.push({ path: `copy.${loc}.${k}`, rule: 'placeholder', message: `占位符 ${t} 缺失` });
      if (en.includes('\n') && en.split('\n').length !== v.split('\n').length)
        warnings.push({ path: `copy.${loc}.${k}`, rule: 'newline-shape', message: '换行结构与源语言不同(站上分行契约,请人工确认)' });
    }
  }

  // 4) 三语 parity/缺译(CON04-E4:发布级)
  for (const k of manifest.editable)
    for (const loc of LOCALES) if (!(c.copy[loc][k] ?? '').trim()) errors.push({ path: `copy.${loc}.${k}`, rule: 'untranslated', message: '缺译' });
  for (const it of c.faq.items)
    for (const loc of LOCALES) {
      if (!it.q[loc].trim()) errors.push({ path: `faq.${it.id}.q.${loc}`, rule: 'untranslated', message: '缺译' });
      if (!it.a[loc].trim()) errors.push({ path: `faq.${it.id}.a.${loc}`, rule: 'untranslated', message: '缺译' });
    }
  for (const s of c.skus)
    for (const loc of LOCALES) if (!s.tagline[loc].trim()) errors.push({ path: `skus.${s.id}.tagline.${loc}`, rule: 'untranslated', message: '缺译' });

  // 5) 下载入口(CON05-E1/E3)
  for (const [k, d] of Object.entries(c.downloads)) {
    if (d.enabled && !d.url) errors.push({ path: `downloads.${k}`, rule: 'enabled-empty-url', message: '开启的入口必须有 URL,或关闭改 coming-soon' });
    if (d.url && !/^https:\/\/.+/.test(d.url)) errors.push({ path: `downloads.${k}.url`, rule: 'url', message: '须为 https 完整链接' });
  }

  // 6) 统计数字(CON06-E1 锚值软警;范围硬校验已在 zod)
  const anchorHits = Object.entries(MOCK_STAT_ANCHORS).filter(([k, v]) => (c.stats as Record<string, unknown>)[k] === v);
  for (const [k] of anchorHits)
    warnings.push({ path: `stats.${k}`, rule: 'mock-anchor', message: '与旧演示值相同——生产上线门(R49-F1)将拦截' });

  // 7) 产品卡(CON07-E2)与 FAQ 门槛(CON08-E1)
  if (!c.skus.some((s) => s.visible)) errors.push({ path: 'skus', rule: 'all-hidden', message: '设备板块不可为空(至少 1 个可见)' });
  if (c.faq.items.filter((i) => i.visible).length < 3) errors.push({ path: 'faq', rule: 'min-visible', message: 'FAQ 可见条目须 ≥3' });
  const ids = new Set<string>();
  for (const it of c.faq.items) {
    if (ids.has(it.id)) errors.push({ path: `faq.${it.id}`, rule: 'dup-id', message: 'FAQ id 重复' });
    ids.add(it.id);
  }

  // 8) 公告(CON09-E1/E2)
  const a = c.announcement;
  if (a.enabled) {
    for (const loc of LOCALES) if (!a.text[loc].trim()) errors.push({ path: `announcement.text.${loc}`, rule: 'untranslated', message: '启用的公告三语必填' });
    if (!a.startsAt || !a.endsAt) errors.push({ path: 'announcement', rule: 'window', message: '启用的公告须有起止时间' });
    else if (Date.parse(a.endsAt) <= Date.parse(a.startsAt)) errors.push({ path: 'announcement.endsAt', rule: 'window', message: '结束时间须晚于开始' });
    if (a.href && !/^(https:\/\/|\/)/.test(a.href)) errors.push({ path: 'announcement.href', rule: 'url', message: '须为 https 或站内路径' });
  }

  // 9) 页脚(CON10-E2)与 SEO 长度软警(CON10-E1)
  for (const s of c.footer.social)
    if (s.enabled && !/^https:\/\/.+/.test(s.url)) errors.push({ path: `footer.social.${s.id}`, rule: 'url', message: '启用的社媒须有合法链接(零死链)' });
  if (c.footer.contactEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.footer.contactEmail))
    errors.push({ path: 'footer.contactEmail', rule: 'email', message: '邮箱格式不合法' });
  for (const [pid, p] of Object.entries(c.seo.pages)) {
    for (const loc of LOCALES) {
      if (p.title[loc].length > 60) warnings.push({ path: `seo.${pid}.title.${loc}`, rule: 'seo-length', message: `title ${p.title[loc].length} 字符(>60,搜索可能截断)` });
      if (p.description[loc].length > 160) warnings.push({ path: `seo.${pid}.description.${loc}`, rule: 'seo-length', message: `description 超 160 字符` });
    }
  }

  // 10) Legal 占位标记(CON11-E1:生产门会拦,前置警告)
  for (const doc of ['terms', 'privacy', 'appPrivacy'] as const)
    for (const loc of LOCALES)
      if (c.legal[doc].md[loc].includes('PENDING-TRUST-ASSETS'))
        warnings.push({ path: `legal.${doc}.${loc}`, rule: 'pending-assets', message: '仍含 PENDING-TRUST-ASSETS,生产门(verify:prod)将拦截' });

  return { errors, warnings };
}

/** 高敏字段判定(CON04-③/CON05/CON06/CON07-E1/CON11:发布须理由) */
export function sensitivePaths(changedPaths: string[]): string[] {
  return changedPaths.filter(
    (p) =>
      SENSITIVE_COPY_PREFIXES.some((pre) => p.startsWith(`copy.en.${pre}`) || p.startsWith(`copy.vi.${pre}`) || p.startsWith(`copy.zh.${pre}`)) ||
      p.startsWith('downloads.') ||
      p.startsWith('stats.') ||
      p.startsWith('legal.') ||
      /^skus\.[^.]+\.(name|priceUSD|multiplier|status)/.test(p),
  );
}
