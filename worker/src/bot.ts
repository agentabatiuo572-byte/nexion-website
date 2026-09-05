/** Shared edge classification for every server and beacon producer. */
const BOT_USER_AGENT = /bot|crawl|spider|slurp|headless|python|curl|wget|monitor|preview|scan|lighthouse/i;

export function isBotUserAgent(userAgent: string): boolean {
  return BOT_USER_AGENT.test(userAgent);
}
