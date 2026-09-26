/**
 * AI 爬虫 / 搜索引擎 / 社交预览分类器(规格 FEAT-ANTIBOT01 §3.2)。
 *
 * 本模块只做「判定 + 命名」,不做拦截:拦截动作由 gate 中间件按策略执行。
 * 名单是基线(规格附录 A),不是全集;厂商会改 UA,上线前按公开文档逐条复核,
 * 之后由策略配置维护覆盖项。本模块不内置厂商 IP 段——没有核实来源的数据不编造,
 * IP / ASN 维度的提档由 gate 的策略输入处理。
 *
 * 匹配顺序敏感:先具体后泛化,避免把 `Claude-User` 误判进 `ClaudeBot` 族、
 * 把 `Applebot-Extended`(AI 训练 token)误当 `Applebot`(搜索)。
 */

export type CrawlerClass =
  | 'ai_training'
  | 'ai_search'
  | 'ai_user'
  | 'search_engine'
  | 'social_preview'
  | 'none';

export interface CrawlerMatch {
  klass: CrawlerClass;
  /** 名单名(观测与日志用;未命中为 null) */
  name: string | null;
}

interface Pattern {
  name: string;
  klass: Exclude<CrawlerClass, 'none'>;
  re: RegExp;
}

/** 顺序 = 匹配优先级(先具体后泛化)。 */
const PATTERNS: readonly Pattern[] = [
  // AI 浏览(用户触发,常带渲染)——先于同族训练爬虫
  { name: 'ChatGPT-User', klass: 'ai_user', re: /ChatGPT-User/i },
  { name: 'Claude-User', klass: 'ai_user', re: /Claude-User/i },
  { name: 'Perplexity-User', klass: 'ai_user', re: /Perplexity-User/i },
  // AI 搜索 / 索引
  { name: 'OAI-SearchBot', klass: 'ai_search', re: /OAI-SearchBot/i },
  { name: 'Claude-SearchBot', klass: 'ai_search', re: /Claude-SearchBot/i },
  { name: 'PerplexityBot', klass: 'ai_search', re: /PerplexityBot/i },
  { name: 'DuckAssistBot', klass: 'ai_search', re: /DuckAssistBot/i },
  // AI 训练
  { name: 'GPTBot', klass: 'ai_training', re: /GPTBot/i },
  { name: 'ClaudeBot', klass: 'ai_training', re: /ClaudeBot/i },
  { name: 'anthropic-ai', klass: 'ai_training', re: /anthropic-ai/i },
  { name: 'Google-Extended', klass: 'ai_training', re: /Google-Extended/i },
  { name: 'Applebot-Extended', klass: 'ai_training', re: /Applebot-Extended/i },
  { name: 'CCBot', klass: 'ai_training', re: /CCBot/i },
  { name: 'Bytespider', klass: 'ai_training', re: /Bytespider/i },
  { name: 'Amazonbot', klass: 'ai_training', re: /Amazonbot/i },
  { name: 'cohere-ai', klass: 'ai_training', re: /cohere-ai/i },
  { name: 'meta-externalagent', klass: 'ai_training', re: /meta-externalagent/i },
  { name: 'meta-webindexer', klass: 'ai_training', re: /meta-webindexer/i },
  { name: 'FacebookBot', klass: 'ai_training', re: /FacebookBot/i },
  { name: 'Diffbot', klass: 'ai_training', re: /Diffbot/i },
  { name: 'Omgilibot', klass: 'ai_training', re: /Omgilibot/i },
  { name: 'ImagesiftBot', klass: 'ai_training', re: /ImagesiftBot/i },
  { name: 'Timpibot', klass: 'ai_training', re: /Timpibot/i },
  { name: 'YouBot', klass: 'ai_training', re: /YouBot/i },
  { name: 'AI2Bot', klass: 'ai_training', re: /AI2Bot/i },
  { name: 'PanguBot', klass: 'ai_training', re: /PanguBot/i },
  // 搜索引擎(Q1:不保留收录 → 与 AI 同规则拦截;单独分类只为观测)
  { name: 'Googlebot', klass: 'search_engine', re: /Googlebot/i },
  { name: 'GoogleOther', klass: 'search_engine', re: /GoogleOther/i },
  { name: 'Google-InspectionTool', klass: 'search_engine', re: /Google-InspectionTool/i },
  { name: 'bingbot', klass: 'search_engine', re: /bingbot/i },
  { name: 'BingPreview', klass: 'search_engine', re: /BingPreview/i },
  { name: 'DuckDuckBot', klass: 'search_engine', re: /DuckDuckBot/i },
  { name: 'YandexBot', klass: 'search_engine', re: /YandexBot/i },
  { name: 'Baiduspider', klass: 'search_engine', re: /Baiduspider/i },
  { name: 'Applebot', klass: 'search_engine', re: /Applebot/i },
  { name: 'Sogou', klass: 'search_engine', re: /Sogou/i },
  { name: '360Spider', klass: 'search_engine', re: /360Spider/i },
  { name: 'PetalBot', klass: 'search_engine', re: /PetalBot/i },
  // 社交预览(Q3:放行 + 记录);Telegram 的真实 UA 是 `TelegramBot (like TwitterBot)`,
  // 必须先于 Twitterbot 匹配。
  { name: 'TelegramBot', klass: 'social_preview', re: /TelegramBot/i },
  { name: 'Twitterbot', klass: 'social_preview', re: /Twitterbot/i },
  { name: 'facebookexternalhit', klass: 'social_preview', re: /facebookexternalhit/i },
  { name: 'WhatsApp', klass: 'social_preview', re: /WhatsApp/i },
  { name: 'Slackbot', klass: 'social_preview', re: /Slackbot/i },
  { name: 'Discordbot', klass: 'social_preview', re: /Discordbot/i },
  { name: 'LinkedInBot', klass: 'social_preview', re: /LinkedInBot/i },
  { name: 'Pinterest', klass: 'social_preview', re: /Pinterest/i },
  { name: 'Embedly', klass: 'social_preview', re: /Embedly/i },
  { name: 'SkypeUriPreview', klass: 'social_preview', re: /SkypeUriPreview/i },
  { name: 'Iframely', klass: 'social_preview', re: /Iframely/i },
];

export function classifyCrawler(userAgent: string): CrawlerMatch {
  for (const pattern of PATTERNS) {
    if (pattern.re.test(userAgent)) return { klass: pattern.klass, name: pattern.name };
  }
  return { klass: 'none', name: null };
}

/** 社交预览名单(robots 声明门与分类器同源):新增 UA 只改 PATTERNS。 */
export const SOCIAL_PREVIEW_AGENTS = PATTERNS.filter((pattern) => pattern.klass === 'social_preview').map((pattern) => pattern.name);

/** AI 训练 / 索引 / 浏览 + 搜索引擎:Q1 后一律进名单拦截。 */
export function isBlockedClass(klass: CrawlerClass): boolean {
  return klass === 'ai_training' || klass === 'ai_search' || klass === 'ai_user' || klass === 'search_engine';
}
