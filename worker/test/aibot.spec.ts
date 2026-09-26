// FEAT-ANTIBOT01 §3.2 分类器验收:AI 训练/索引/浏览、搜索引擎、社交预览、普通流量。
import { describe, expect, it } from 'vitest';
import { classifyCrawler, isBlockedClass, SOCIAL_PREVIEW_AGENTS } from '../src/aibot';

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CASES: ReadonlyArray<readonly [string, string, string]> = [
  // AI 浏览(用户触发)
  [`Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${CHROME}; ChatGPT-User/1.0; +https://openai.com/bot`, 'ai_user', 'ChatGPT-User'],
  ['Mozilla/5.0 (compatible; Claude-User/1.0; +Claude-User@anthropic.com)', 'ai_user', 'Claude-User'],
  ['Mozilla/5.0 (compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)', 'ai_user', 'Perplexity-User'],
  // AI 搜索 / 索引
  ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot', 'ai_search', 'OAI-SearchBot'],
  ['Mozilla/5.0 (compatible; Claude-SearchBot/1.0; +Claude-SearchBot@anthropic.com)', 'ai_search', 'Claude-SearchBot'],
  ['Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)', 'ai_search', 'PerplexityBot'],
  ['Mozilla/5.0 (compatible; DuckAssistBot/1.0; +https://duckduckgo.com/duckassistbot)', 'ai_search', 'DuckAssistBot'],
  // AI 训练
  ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot', 'ai_training', 'GPTBot'],
  ['Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)', 'ai_training', 'ClaudeBot'],
  ['anthropic-ai/1.0', 'ai_training', 'anthropic-ai'],
  ['Mozilla/5.0 (compatible; Google-Extended/1.0)', 'ai_training', 'Google-Extended'],
  ['Mozilla/5.0 (compatible; Applebot-Extended/0.1)', 'ai_training', 'Applebot-Extended'],
  ['CCBot/2.0 (https://commoncrawl.org/faq/)', 'ai_training', 'CCBot'],
  ['Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com)', 'ai_training', 'Bytespider'],
  ['Mozilla/5.0 (compatible; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot)', 'ai_training', 'Amazonbot'],
  ['cohere-ai/1.0', 'ai_training', 'cohere-ai'],
  ['meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)', 'ai_training', 'meta-externalagent'],
  ['meta-webindexer/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)', 'ai_training', 'meta-webindexer'],
  ['FacebookBot/1.0', 'ai_training', 'FacebookBot'],
  ['Mozilla/5.0 (compatible; Diffbot/1.0; +http://www.diffbot.com)', 'ai_training', 'Diffbot'],
  ['Mozilla/5.0 (compatible; Omgilibot/1.0)', 'ai_training', 'Omgilibot'],
  ['Mozilla/5.0 (compatible; ImagesiftBot/1.0)', 'ai_training', 'ImagesiftBot'],
  ['Mozilla/5.0 (compatible; Timpibot/0.1)', 'ai_training', 'Timpibot'],
  ['Mozilla/5.0 (compatible; YouBot/1.0)', 'ai_training', 'YouBot'],
  ['Mozilla/5.0 (compatible; AI2Bot/1.0)', 'ai_training', 'AI2Bot'],
  ['Mozilla/5.0 (compatible; PanguBot/1.0)', 'ai_training', 'PanguBot'],
  // 搜索引擎(Q1:与 AI 同规则拦截,分类只为观测)
  ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'search_engine', 'Googlebot'],
  ['Mozilla/5.0 (compatible; GoogleOther/2.1; +http://www.google.com/bot.html)', 'search_engine', 'GoogleOther'],
  ['Mozilla/5.0 (compatible; Google-InspectionTool/1.0)', 'search_engine', 'Google-InspectionTool'],
  ['Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)', 'search_engine', 'bingbot'],
  ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 BingPreview/1.0b', 'search_engine', 'BingPreview'],
  ['DuckDuckBot/1.0; (+http://duckduckgo.com/duckduckbot.html)', 'search_engine', 'DuckDuckBot'],
  ['Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)', 'search_engine', 'YandexBot'],
  ['Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)', 'search_engine', 'Baiduspider'],
  ['Mozilla/5.0 (compatible; Applebot/0.3; +http://www.apple.com/go/applebot)', 'search_engine', 'Applebot'],
  ['Sogou web spider/4.0(+http://www.sogou.com/docs/help/webmasters.htm#07)', 'search_engine', 'Sogou'],
  ['Mozilla/5.0 (compatible; 360Spider/1.0)', 'search_engine', '360Spider'],
  ['Mozilla/5.0 (compatible; PetalBot/3.0; +https://webmaster.petalsearch.com/site/petalbot)', 'search_engine', 'PetalBot'],
  // 社交预览(Q3:放行)
  ['Twitterbot/1.0', 'social_preview', 'Twitterbot'],
  ['facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)', 'social_preview', 'facebookexternalhit'],
  ['WhatsApp/2.23.20.0', 'social_preview', 'WhatsApp'],
  ['TelegramBot (like TwitterBot)', 'social_preview', 'TelegramBot'],
  ['Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)', 'social_preview', 'Slackbot'],
  ['Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)', 'social_preview', 'Discordbot'],
  ['LinkedInBot/1.0 (compatible; Mozilla/5.0; +http://www.linkedin.com)', 'social_preview', 'LinkedInBot'],
  ['Pinterest/0.2 (+https://www.pinterest.com/bot.html)', 'social_preview', 'Pinterest'],
  ['Embedly/0.2 (+http://support.embed.ly/)', 'social_preview', 'Embedly'],
  ['SkypeUriPreview Preview/0.5', 'social_preview', 'SkypeUriPreview'],
  ['Iframely/1.3.1 (+https://iframely.com/docs/about)', 'social_preview', 'Iframely'],
  // 普通流量
  [CHROME, 'none', ''],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 'none', ''],
  ['curl/8.5.0', 'none', ''],
  ['', 'none', ''],
];

describe('classifyCrawler', () => {
  it.each(CASES)('%s', (ua, klass, name) => {
    const match = classifyCrawler(ua);
    expect(match.klass).toBe(klass);
    expect(match.name ?? '').toBe(name);
  });

  it('is case-insensitive and matches inside a longer UA string', () => {
    expect(classifyCrawler('gptbot/9.9').klass).toBe('ai_training');
    expect(classifyCrawler('Mozilla/5.0 (compatible; BINGBOT/2.0)').klass).toBe('search_engine');
  });

  it('resolves same-family patterns to the specific entry first', () => {
    expect(classifyCrawler('Claude-User/1.0').name).toBe('Claude-User');
    expect(classifyCrawler('ClaudeBot/1.0').name).toBe('ClaudeBot');
    expect(classifyCrawler('Applebot-Extended/0.1').name).toBe('Applebot-Extended');
    expect(classifyCrawler('Applebot/0.3').name).toBe('Applebot');
  });
});

describe('policy mapping', () => {
  it('blocks AI and search-engine classes, allows social preview', () => {
    for (const klass of ['ai_training', 'ai_search', 'ai_user', 'search_engine'] as const) {
      expect(isBlockedClass(klass)).toBe(true);
    }
    expect(isBlockedClass('social_preview')).toBe(false);
    expect(isBlockedClass('none')).toBe(false);
  });

  it('exposes the social preview list for the robots declaration gate', () => {
    expect(SOCIAL_PREVIEW_AGENTS).toContain('Twitterbot');
    expect(SOCIAL_PREVIEW_AGENTS).toContain('facebookexternalhit');
    expect(SOCIAL_PREVIEW_AGENTS).toContain('TelegramBot');
  });
});
