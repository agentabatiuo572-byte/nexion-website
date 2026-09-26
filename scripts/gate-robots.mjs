/* AI 反爬声明层门(FEAT-ANTIBOT01 §3.1)
   ─────────────────────────────────────
   判据(Q1 决策:不保留搜索收录):
     ① 通配组必须 `Disallow: /`(默认全禁);
     ② 社交预览 UA 组必须 `Allow: /`(分享卡片需要;与闸的 L4 白名单同源);
     ③ 不得出现 `Sitemap:` 声明(无搜索收录需求);
     ④ 搜索引擎 UA 组不得 `Allow: /`(防回退到保留收录)。
   robots.txt 自身不进闸,这份声明必须真的按上述形状存在。

   判据是文本解析,必须有红测:`node scripts/gate-robots.mjs --self-test`。
   自检守卫:仅当以本文件为入口执行时才跑自检(复制/改名后静默不跑属预期)。 */

/* 社交预览名单与分类器同源(worker/src/aibot.ts):一边加 UA 另一边漏,这道门就会红。 */
import { SOCIAL_PREVIEW_AGENTS } from '../worker/src/aibot.ts';

export const SEARCH_ENGINE_AGENTS = [
  'Googlebot',
  'Bingbot',
  'bingbot',
  'DuckDuckBot',
  'YandexBot',
  'Baiduspider',
  'Applebot',
  'Sogou',
  '360Spider',
  'PetalBot',
];

/** 按 robots.txt 语义切组:连续 User-agent 行共组,规则行之后的下一个 User-agent 开新组,空行重置。 */
function parseGroups(text) {
  const groups = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) {
      current = null;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if ((key === 'allow' || key === 'disallow') && current) {
      current.rules.push({ type: key, value });
    }
  }
  return groups;
}

const groupFor = (groups, agent) => groups.find((group) => group.agents.includes(agent.toLowerCase())) ?? null;
const allowsAll = (group) => !!group && group.rules.some((rule) => rule.type === 'allow' && rule.value === '/');
const disallowsAll = (group) => !!group && group.rules.some((rule) => rule.type === 'disallow' && rule.value === '/');

export function robotsGate(text) {
  const detail = [];
  const groups = parseGroups(text);
  if (!disallowsAll(groupFor(groups, '*'))) detail.push('缺少 `User-agent: *` + `Disallow: /` 默认全禁');
  for (const bot of SOCIAL_PREVIEW_AGENTS) {
    const group = groupFor(groups, bot);
    if (!group) detail.push(`缺少社交预览放行组:${bot}`);
    else if (!allowsAll(group)) detail.push(`社交预览组未放行:${bot}`);
  }
  if (/^\s*Sitemap\s*:/im.test(text)) detail.push('Sitemap 声明应移除(无搜索收录需求)');
  for (const engine of SEARCH_ENGINE_AGENTS) {
    if (allowsAll(groupFor(groups, engine))) detail.push(`搜索引擎不应放行:${engine}`);
  }
  return { gate: 'ai-antibbot-robots(FEAT-ANTIBOT01)', pass: detail.length === 0, detail };
}

const GREEN = `User-agent: *\nDisallow: /\n\n${SOCIAL_PREVIEW_AGENTS.map((bot) => `User-agent: ${bot}`).join('\n')}\nAllow: /\n`;

const FIXTURES = [
  ['green', GREEN, true],
  ['red:no-wildcard-deny', `User-agent: *\nAllow: /\n\n${SOCIAL_PREVIEW_AGENTS.map((bot) => `User-agent: ${bot}`).join('\n')}\nAllow: /\n`, false],
  ['red:no-social', 'User-agent: *\nDisallow: /\n', false],
  ['red:sitemap', `${GREEN}\nSitemap: https://example.com/sitemap.xml\n`, false],
  ['red:search-allow', `${GREEN}\nUser-agent: Googlebot\nAllow: /\n`, false],
  ['red:social-without-allow', GREEN.replace('Allow: /', 'Disallow: /'), false],
];

if (process.argv.includes('--self-test') && import.meta.filename === process.argv[1]) {
  let pass = 0;
  let failed = 0;
  for (const [name, text, expected] of FIXTURES) {
    const result = robotsGate(text);
    const ok = result.pass === expected;
    if (ok) pass++;
    else failed++;
    console.log(`[gate-robots] ${ok ? 'PASS' : 'FAIL'} ${name} (expect ${expected ? 'green' : 'red'}, got ${result.pass ? 'green' : 'red'})`);
  }
  console.log(`[gate-robots] self-test: ${pass} pass / ${failed} fail`);
  process.exit(failed === 0 ? 0 : 1);
}
