import { z } from 'zod';

/* 线上事件契约(官网后台 PRD §5.2)。短键=省 beacon 体积;此处是唯一权威,
   站侧 src/scripts/metrics.ts 按本表写字面量(端到端 parity 由 T18/T24 真链路 E2E 兜)。
   键名映射:t=type · loc=locale · dev=deviceClass(m/d) · ref=refClass · us/um/uc=utm 三参 ·
   sec=sectionId · cta=ctaId · faq=faqId · lcp/cls=vitals · h=错误哈希。 */

const path = z.string().min(1).max(200);
const short = z.string().max(64);
const locale = z.enum(['en', 'vi', 'zh']);
const dev = z.enum(['m', 'd']);

export const EventSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('pv'),
    path,
    loc: locale,
    dev,
    ref: z.enum(['direct', 'internal', 'search', 'social', 'referral']),
    us: short,
    um: short,
    uc: short,
  }),
  z.object({ t: z.literal('sec'), sec: z.string().min(1).max(32), path }),
  z.object({ t: z.literal('cta'), cta: z.string().min(1).max(32), sec: z.string().max(32), loc: locale, path }),
  z.object({ t: z.literal('faq'), faq: z.string().min(1).max(16), loc: locale }),
  z.object({ t: z.literal('vit'), lcp: z.number().min(0).max(120_000), cls: z.number().min(0).max(10), path, dev }),
  z.object({ t: z.literal('err'), h: z.string().min(1).max(16), path }),
]);
export type BeaconEvent = z.infer<typeof EventSchema>;

export const BatchSchema = z.object({ events: z.array(EventSchema).min(1).max(10) });

/** 服务端注入事件(不走 beacon):区域屏蔽拦截(CON12,T15 写入;T6 已汇总其分桶) */
export interface BlockedEvent {
  t: 'blocked';
  c: string; // ISO 国家码
  p: string; // pathClass
}
