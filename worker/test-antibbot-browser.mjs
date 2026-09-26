/**
 * AI 反爬闸运行时验收(真浏览器):FEAT-ANTIBOT01 §5.2。
 *
 * 前置:本机 wrangler dev 已在 ANTIBOT_BASE 上运行,KV `gate:policy` = enforce 且 bindMode=ua。
 * 用法:node --import ./worker/register-ts-ext.mjs worker/test-antibbot-browser.mjs
 *
 * 三条场景:
 *  1. 完整挑战闭环(真 Turnstile + 官方测试密钥,必过):挑战页 → Turnstile 通过 → verify 签发 cookie → 回原页 → 首页渲染。
 *  2. Turnstile 域不可达(确定性):挑战壳可见,站点导航/正文不可见。
 *  3. 持有效通行证:首页真实内容渲染。
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { signGateCookie } from './src/gate.ts';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = process.env.ANTIBOT_BASE ?? 'http://127.0.0.1:8790';
const UA = process.env.ANTIBOT_UA ?? 'antibbot-browser-acceptance/1.0';
const SECRET = process.env.GATE_SECRET ?? 'dev-gate-secret';
const OUT = process.env.ANTIBOT_SHOTS ?? '/tmp/antibbot-acceptance';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
try {
  // 1) 完整 Turnstile 闭环(不拦截任何域;测试密钥必过)
  {
    const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('text=Verifying your browser', { timeout: 10_000 });
    await page.waitForFunction(() => document.title.includes('Distributed AI compute'), { timeout: 30_000 });
    await page.screenshot({ path: `${OUT}/turnstile-e2e.png` });
    console.log('[antibbot-runtime] PASS turnstile-e2e: 真 Turnstile(测试密钥)完整闭环 → 首页渲染');
    await context.close();
  }

  // 2) 无通行证 + Turnstile 不可达:挑战壳无站点内容(拦截 Turnstile 域保持确定性)
  {
    const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.route('https://challenges.cloudflare.com/**', (route) => route.abort());
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('text=Verifying your browser', { timeout: 10_000 });
    if ((await page.locator('nav').count()) !== 0) throw new Error('挑战壳不得渲染站点导航');
    await page.screenshot({ path: `${OUT}/challenge.png` });
    console.log('[antibbot-runtime] PASS challenge-shell: 无通行证只看到验证页,无站点内容');
    await context.close();
  }

  // 3) 持有效通行证:首页正常渲染
  {
    const context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const cookie = await signGateCookie(SECRET, { ua: UA, ip: 'unknown', bindMode: 'ua', ttlMs: 3_600_000 });
    await context.addCookies([{ name: 'ng_gate', value: cookie, url: `${BASE}/` }]);
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('h1', { timeout: 10_000 });
    const title = await page.title();
    if (!/Distributed AI compute/.test(title)) throw new Error(`持通行证应渲染首页,实际标题:${title}`);
    await page.screenshot({ path: `${OUT}/passed.png` });
    console.log(`[antibbot-runtime] PASS cookie-passed: 真浏览器持通行证正常浏览(${title})`);
    await context.close();
  }
} finally {
  await browser.close();
}
