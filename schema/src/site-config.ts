import { z } from 'zod';

/* SiteConfig zod 单源(官网后台 PRD §5.1)。三消费面:worker 校验/物化 · 控制台表单 · 发布流水线。
   业务规则校验(https/时间窗/≥3 可见 FAQ 等)在 validators.ts;此处只管结构与类型。 */

export const LOCALES = ['en', 'vi', 'zh'] as const;
export type Locale = (typeof LOCALES)[number];

const L = <T extends z.ZodTypeAny>(v: T) => z.object({ en: v, vi: v, zh: v });
const copyMap = z.record(z.string(), z.string());

export const DownloadEntry = z.object({ url: z.string().max(500), enabled: z.boolean() });

export const SkuSchema = z.object({
  id: z.string().min(1).max(32), // 不可改(站侧渲染锚,CON07-③)
  name: z.string().min(1).max(64),
  priceUSD: z.number().min(0),
  multiplier: z.number().min(1),
  status: z.enum(['active', 'legacy', 'coming']),
  free: z.boolean().optional(),
  tagline: L(z.string().max(200)),
  sort: z.number().int(),
  visible: z.boolean(),
});

export const FaqItem = z.object({
  id: z.string().min(1).max(24),
  q: L(z.string().max(300)),
  a: L(z.string().max(2000)),
  sort: z.number().int(),
  visible: z.boolean(),
  /** 回收区(CON08-④/E3):草稿态可恢复;物化/发布不含;发布流水线在出版时物理剪除 */
  deleted: z.boolean().optional(),
});

export const SEO_PAGE_IDS = ['home', 'learn', 'nex', 'legal-privacy', 'legal-terms', 'legal-app-privacy'] as const;

export const SiteConfigSchema = z.object({
  copy: z.object({ en: copyMap, vi: copyMap, zh: copyMap }),
  downloads: z.object({ ios: DownloadEntry, android: DownloadEntry, h5: DownloadEntry }),
  stats: z.object({
    activeDevices: z.number().int().positive(),
    activeJobs: z.number().int().positive(),
    nodes: z.number().int().positive(),
    countries: z.number().int().positive(),
    uptime: z.number().gt(0).max(100),
    asOf: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), // 月份 01-12(T11/12 验收观察项收紧)
  }),
  skus: z.array(SkuSchema).min(1),
  faq: z.object({ items: z.array(FaqItem) }),
  announcement: z.object({
    id: z.string().max(24),
    enabled: z.boolean(),
    text: L(z.string().max(120)),
    href: z.string().max(300).optional(),
    startsAt: z.string().optional(), // ISO UTC
    endsAt: z.string().optional(),
  }),
  seo: z.object({
    pages: z.record(z.enum(SEO_PAGE_IDS), z.object({ title: L(z.string().max(120)), description: L(z.string().max(300)) })),
  }),
  footer: z.object({
    social: z.array(z.object({ id: z.string().max(24), url: z.string().max(300), enabled: z.boolean() })),
    contactEmail: z.string().max(120),
  }),
  legal: z.object({
    terms: z.object({ md: L(z.string().max(200_000)), updatedAt: z.string() }),
    privacy: z.object({ md: L(z.string().max(200_000)), updatedAt: z.string() }),
    appPrivacy: z.object({ md: L(z.string().max(200_000)), updatedAt: z.string() }),
  }),
});

export type SiteConfig = z.infer<typeof SiteConfigSchema>;

/** 旧演示锚值(R49-A2/F1:统计五数字仍等于它们时,保存软警告、生产门拦截) */
export const MOCK_STAT_ANCHORS = { activeDevices: 28_432, activeJobs: 4_812, nodes: 156, countries: 47, uptime: 99.7 } as const;

/** 高敏命名空间(CON04-③:发布须理由) */
export const SENSITIVE_COPY_PREFIXES = ['trust.', 'footer.legalLine', 'legal.'] as const;

/** schema 版本:物化脚本与 worker 比对,漂移拒绝执行(CON16-E2) */
export const SCHEMA_VERSION = 1;
