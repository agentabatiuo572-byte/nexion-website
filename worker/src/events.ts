import { z } from 'zod';
import { utf8ByteLength } from '../../schema/src/utf8';
import {
  METRIC_CTA_IDS,
  METRIC_CTA_SECTION_IDS,
  METRIC_SECTION_IDS,
  METRIC_TEXT_BYTES,
  isMetricFaqId,
} from '../../schema/src/event-contract';

/* 线上事件契约(官网后台 PRD §5.2)。短键=省 beacon 体积;此处是唯一权威,
   站侧 src/scripts/metrics.ts 按本表写字面量(端到端 parity 由 T18/T24 真链路 E2E 兜)。
   键名映射:t=type · loc=locale · dev=deviceClass(m/d) · ref=refClass · us/um/uc=utm 三参 ·
   sec=sectionId · cta=ctaId · faq=faqId · lcp/cls=vitals · h=错误哈希。 */

/* 跨 ingest/rollup 的单一字符串边界：按 UTF-8 字节计长，并拒绝 NUL。
   SQLite 对 TEXT 的 length() 按码点且遇 NUL 截断；rollup 改用 BLOB 字节长度与 X'00' 检查。 */
const boundedText = (minBytes: number, maxBytes: number) => z.string().refine((value) => {
  const bytes = utf8ByteLength(value);
  return !value.includes(String.fromCharCode(0)) && bytes >= minBytes && bytes <= maxBytes;
}, { message: `must be ${minBytes}-${maxBytes} UTF-8 bytes without NUL` });

const path = boundedText(1, METRIC_TEXT_BYTES.path);
const short = boundedText(0, METRIC_TEXT_BYTES.short);
const locale = z.enum(['en', 'vi', 'zh']);
const dev = z.enum(['m', 'd']);
const section = z.enum(METRIC_SECTION_IDS);
const cta = z.enum(METRIC_CTA_IDS);
const ctaSection = z.enum(METRIC_CTA_SECTION_IDS);
const faq = boundedText(1, METRIC_TEXT_BYTES.faq).refine(isMetricFaqId, { message: 'must be qN where N is positive' });

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
  z.object({ t: z.literal('sec'), sec: section, path }),
  z.object({ t: z.literal('cta'), cta, sec: ctaSection, loc: locale, path }),
  z.object({ t: z.literal('faq'), faq, loc: locale }),
  z.object({ t: z.literal('vit'), lcp: z.number().min(0).max(120_000), cls: z.number().min(0).max(10), path, dev }),
  z.object({ t: z.literal('err'), h: boundedText(1, 16), path }),
]);
export type BeaconEvent = z.infer<typeof EventSchema>;

export const BatchSchema = z.object({ events: z.array(EventSchema).min(1).max(10) });

/** 服务端注入事件(不走 beacon):区域屏蔽拦截(CON12,T15 写入;T6 已汇总其分桶) */
export interface BlockedEvent {
  t: 'blocked';
  c: string; // ISO 国家码
  p: string; // pathClass
  bot?: 0 | 1;
}
