/* 审计实景回归：复用 render-fit 的浏览器与产物服务，不另起构建或服务。 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { readBuiltPages } from './gate-built-routes.mjs';

function measureLayout(kind) {
  const failures = [];
  let samples = 0;
  const rect = (e) => e.getBoundingClientRect();
  const visible = (e) => {
    if (!e || rect(e).width <= 0 || rect(e).height <= 0) return false;
    for (let node = e; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) return false;
    }
    return true;
  };
  if (kind === 'hero') {
    for (const selector of ['.hero .dl-wrap', '.hero .note2']) {
      const e = document.querySelector(selector);
      if (!visible(e)) { failures.push(`${selector} 不可见或缺失`); continue; }
      samples++;
      if (rect(e).bottom > innerHeight + 1 || rect(e).top < 0) failures.push(`${selector} 首屏裁切`);
    }
  }
  if (kind === 'grid') {
    const required = location.pathname.endsWith('/nex/') ? '.mech > .mcard'
      : location.pathname.endsWith('/learn/') ? '.learn > .grid > .card' : null;
    if (required && !document.querySelector(required)) failures.push('预期卡片缺失');
    for (const child of document.querySelectorAll('.mech > .mcard, .learn > .grid > .card')) {
      if (!visible(child)) { failures.push('卡片不可见'); continue; }
      const parent = child.parentElement;
      const p = rect(parent), c = rect(child), style = getComputedStyle(parent);
      const zoom = Number(getComputedStyle(parent.closest('.x-canvas') || parent).zoom) || 1;
      const left = p.left + (parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth)) * zoom;
      const right = p.right - (parseFloat(style.paddingRight) + parseFloat(style.borderRightWidth)) * zoom;
      samples++;
      if (c.left < left - 1 || c.right > right + 1) failures.push(`${child.className} 超出栅格内容区`);
    }
  }
  if (kind === 'menu') {
    const menu = document.querySelector('.menu.open');
    if (visible(menu)) samples++;
    if (!visible(menu) || menu.scrollWidth > menu.clientWidth + 1) failures.push('展开菜单横向溢出或不可见');
    if (!menu?.querySelector('.links a')) failures.push('导航链接缺失');
    for (const link of menu?.querySelectorAll('.links a') || []) {
      if (!visible(link)) { failures.push('导航文字不可见'); continue; }
      const range = document.createRange();
      range.selectNodeContents(link);
      const r = range.getBoundingClientRect();
      if (r.right > rect(menu).right + 1 || r.left < rect(menu).left - 1) failures.push('导航文字越出菜单');
    }
  }
  if (kind === 'how') {
    const cards = [...document.querySelectorAll('#how .step')];
    if (cards.length !== 3) failures.push('How 三步骤不完整');
    const rows = new Map();
    for (const card of cards) {
      const img = card.querySelector('img');
      if (!visible(img)) { failures.push('How 图片不可见或缺失'); continue; }
      samples++;
      if (!img.complete || !img.naturalWidth) failures.push('How 图片加载失败');
      // 只比卡内偏移；各卡外部视差不同是既有编舞。
      const row = card.offsetTop;
      const offsets = rows.get(row) || [];
      offsets.push(rect(img).top - rect(card).top);
      rows.set(row, offsets);
    }
    for (const offsets of rows.values()) if (Math.max(...offsets) - Math.min(...offsets) > 1) failures.push('How 同行图片卡内偏移不一致');
  }
  if (kind === 'trust') {
    const cards = [...document.querySelectorAll('#trust .verification')];
    if (cards.length !== 2) failures.push('Trust 两张验证卡不完整');
    const bottomGaps = [];
    for (const card of cards) {
      const cta = card.querySelector('.vcta'), chip = card.querySelector('.vchip');
      if (![card, cta, chip].every(visible)) { failures.push('Trust 验证卡、编号或按钮不可见或缺失'); continue; }
      const c = rect(card), button = rect(cta), style = getComputedStyle(card);
      const zoom = Number(getComputedStyle(card.closest('.x-canvas') || card).zoom) || 1;
      const bottom = (parseFloat(style.paddingBottom) + parseFloat(style.borderBottomWidth)) * zoom;
      const right = (parseFloat(style.paddingRight) + parseFloat(style.borderRightWidth)) * zoom;
      const bottomGap = c.bottom - button.bottom;
      samples++;
      bottomGaps.push(bottomGap);
      if (Math.abs(bottomGap - bottom) > 1) failures.push('Trust 按钮未贴卡片内容区底边');
      if (Math.abs(c.right - button.right - right) > 1) failures.push('Trust 按钮未贴卡片内容区右边');
      if (Math.abs(rect(chip).right - button.right) > 1) failures.push('Trust 编号与按钮右沿不齐');
    }
    if (bottomGaps.length === 2 && Math.abs(bottomGaps[0] - bottomGaps[1]) > 1) failures.push('Trust 两按钮距卡底不一致');
  }
  return { samples, failures };
}

export async function checkUiLayout(browser, base, pages, onProgress) {
  const failures = [], samples = { hero: 0, grid: 0, menu: 0, how: 0, trust: 0 };
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  const check = async (kind, route, width, height) => {
    const result = await page.evaluate(measureLayout, kind);
    samples[kind] += result.samples;
    failures.push(...result.failures.map((message) => `${route} @${width}×${height} ${message}`));
  };
  try {
    for (const [index, entry] of pages.entries()) {
      onProgress?.(`页面布局：菜单与卡片 ${index + 1}/${pages.length}，当前 ${entry.route}`);
      for (const width of [320, 340, 360, 390]) {
        const height = 844;
        await page.setViewportSize({ width, height });
        const response = await page.goto(base + entry.route, { waitUntil: 'load' });
        assert(response?.ok(), `无法读取 ${entry.route}`);
        await page.evaluate(() => document.fonts.ready);
        await check('grid', entry.route, width, height);
        if (entry.home) await check('trust', entry.route, width, height);
        await page.locator('.menu-toggle').click();
        await check('menu', entry.route, width, height);
        await page.keyboard.press('Escape');
      }
      if (!entry.home) continue;
      for (const [width, height] of [[1024, 768], [1366, 768], [1440, 900], [1920, 1080], [2560, 1440]]) {
        await page.setViewportSize({ width, height });
        // 首页首载文案仍有淡入延迟；保留原等待，不能把动画起帧误判成文案缺失。
        const response = await page.goto(base + entry.route, { waitUntil: 'networkidle' });
        assert(response?.ok(), `无法读取 ${entry.route}`);
        await page.evaluate(() => document.fonts.ready);
        await check('hero', entry.route, width, height);
        for (const image of await page.locator('#how img').all()) {
          await image.scrollIntoViewIfNeeded();
        }
        await page.waitForFunction(() => [...document.querySelectorAll('#how img')].every((img) => img.complete), null, { timeout: 10000 });
        await check('how', entry.route, width, height);
        await check('trust', entry.route, width, height);
      }
    }
    for (const [kind, count] of Object.entries(samples)) if (!count) failures.push(`${kind} 无观测样本`);
    return { failures, samples };
  } finally { await context.close(); }
}

async function selfTest(browser) {
  const page = await browser.newPage({ viewport: { width: 320, height: 768 } });
  const pixel = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  let checks = 0;
  for (const [kind, good, bad] of [
    ['hero', '<div class="hero"><div class="dl-wrap">Download</div><p class="note2">Copy</p></div>', '.hero{padding-top:780px}'],
    ['grid', '<div class="mech" style="width:242px;display:grid"><article class="mcard">Card</article></div>', '.mcard{width:260px}'],
    ['menu', '<div class="menu open" style="width:280px;overflow:auto"><div class="links"><a>Long navigation item</a></div></div>', '.links{width:340px}'],
    ['how', '<div id="how" style="display:flex"><article class="step"><img width="100" height="100"></article><article class="step"><img width="100" height="100"></article><article class="step"><img width="100" height="100"></article></div>', '.step:nth-child(2) img{margin-top:37px}'],
    ['trust', `<style>
      .x-canvas{zoom:1.25} #trust{display:grid;grid-template-columns:1fr 1fr}
      .verification{display:flex;flex-direction:column;padding:12px 14px;border:1px solid}
      .cdesc{margin:0} .vrow{display:flex;flex-direction:column;align-items:flex-end;margin:auto 0 0}
      </style><div class="x-canvas"><section id="trust">
      <article class="verification"><p class="cdesc">Description</p><p class="vrow"><span class="vchip">ID 123</span><a class="vcta">Verify</a></p></article>
      <article class="verification"><p class="cdesc">Longer<br>registry<br>description</p><p class="vrow"><span class="vchip">MSB 456</span><a class="vcta">Search</a></p></article>
      </section></div>`, '.vrow{margin-top:0;align-items:flex-start}'],
  ]) {
    await page.setContent(good.replaceAll('<img ', `<img src="${pixel}" `));
    await page.evaluate(() => Promise.all([...document.images].map((img) => img.decode())));
    let result = await page.evaluate(measureLayout, kind);
    assert(result.samples > 0 && !result.failures.length, `${kind} 正例`); checks++;
    await page.addStyleTag({ content: bad });
    result = await page.evaluate(measureLayout, kind);
    assert(result.failures.length > 0, `${kind} 旧缺陷反例`); checks++;
    await page.addStyleTag({ content: 'body{display:none}' });
    result = await page.evaluate(measureLayout, kind);
    assert(result.failures.length > 0 && result.samples === 0, `${kind} 隐藏不能冒充已观测`); checks++;
  }
  await page.setContent('<div id="how"><article class="step"><img src="data:image/png;base64,broken" width="100" height="100"></article></div>');
  assert((await page.evaluate(measureLayout, 'how')).failures.includes('How 图片加载失败')); checks++;
  await page.setContent('<div class="menu open">Menu without links</div>');
  assert((await page.evaluate(measureLayout, 'menu')).failures.includes('导航链接缺失')); checks++;
  for (const html of ['', '<section id="trust"><article class="verification">Missing details</article><article class="verification">Missing details</article></section>']) {
    await page.setContent(html);
    const result = await page.evaluate(measureLayout, 'trust');
    assert(result.failures.length > 0 && result.samples === 0, 'Trust 缺失不能冒充已观测'); checks++;
  }
  await page.close();
  console.log(`[ui-layout] ${checks} pass`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const browser = await chromium.launch();
  try {
    if (process.argv.includes('--self-test')) await selfTest(browser);
    else {
      assert(process.argv[2], '需提供已核实的构建预览 URL');
      const result = await checkUiLayout(browser, process.argv[2], readBuiltPages(new URL('../dist/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')));
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.failures.length ? 1 : 0;
    }
  } finally { await browser.close(); }
}
