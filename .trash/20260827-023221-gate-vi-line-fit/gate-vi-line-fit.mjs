/* 门:变音符 / CJK 语言的多行正文,行距不能让上一行的墨压住下一行。
 *
 * 为什么要有这道门:同一族在 R44、R45 连续两轮被独立评审逐字量出来,两轮都是「治了几处、漏了同族其余处」。
 * 根因不是粗心,是**层放错了** —— zh 的行高例外写在 tokens.css 的型类层(一条覆盖全站),
 * vi 的却逐个组件写,于是每加一个新组件就漏一处;而静态检查、tsc、逐元素回归全看不出来
 * (行高「有值」只是值不够;版面也没溢出,只是字压在一起)。
 * 逐处打补丁封不住开放集合。第三轮改由本门跑真渲染逐元素量:人工扫 40 处只报出 3 处,
 * 本门同一份产物报出 17 处 —— 差的那 14 处几乎全在窄屏,那一面人工根本没扫。
 *
 * 判据:vi / zh 路由上,**正文档**文本元素若真的渲染成 ≥2 行,则 行高 / 字号 ≥ 1.3。
 *   1.3 的来历:Space Mono 的 vi 变音符字身(上伸 + 下伸)实测约 1.29 个字号 ——
 *   行距低于它,上一行的下点就进到下一行的帽子里。留 0.01 余量取整。
 *
 * 豁免与理由(写出来是为了让「放宽判据」这件事必须解释):
 *   · display 档(字号 > 20px 或带 .x-display* 型类)不判 —— 大字紧行距是参考站的版面语言、也是主人拍过板的
 *     既有值,它靠逐行手工断行避让,不靠行距;动它不属于「新增缺陷」那一类。
 *   · 单行元素不判:行距只在相邻行之间才有意义。
 *   · 元素级逃生阀:给元素加 class `line-fit-ok`(留在 DOM 里看得见,不像注释那样隐形)。
 *
 * 用法:node scripts/gate-vi-line-fit.mjs             自带静态服务直接伺服 dist/(verify 走这条)
 *      node scripts/gate-vi-line-fit.mjs <baseUrl>  打一个已在跑的服务(手工复验用)
 *      node scripts/gate-vi-line-fit.mjs --self-test 证明它对该红的会红、对该绿的不红
 *
 * 为什么自带服务而不用 astro preview:preview 是单例守护进程,已有实例时它拒绝起第二个,
 * 于是「门有没有真跑」会取决于本机当时有没有别的会话开着预览 —— 那种门等于没焊。
 * dist/ 是静态文件,起个二十行的 http 服务即可,确定性高且不占既有端口。
 */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
const require = createRequire('D:/WORKS/PLAN/Nexion-uniapp/package.json');
const { chromium } = require('playwright');
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const DIST = join(ROOT, 'dist');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};
/** 起一个只读 dist 的静态服务,返回 { url, close }。端口交给系统分配,不跟任何人抢。 */
const serveDist = async () => {
  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent((req.url || '/').split('?')[0]);
      let file = join(DIST, p);
      const st = await stat(file).catch(() => null);
      if (!st || st.isDirectory()) file = join(DIST, p, 'index.html');
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
};

const MIN_RATIO = 1.3;
// 显式给了地址就打那个(手工复验);没给就自建服务伺服 dist/
const EXPLICIT = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2].replace(/\/$/, '') : null;
const ROUTES = [
  '/vi/',
  '/vi/nex/',
  '/vi/learn/',
  '/vi/learn/getting-started/',
  '/vi/learn/buy-device/',
  '/vi/learn/phone-compute/',
  '/vi/learn/earnings-withdraw/',
  '/vi/legal/privacy/',
  '/vi/legal/terms/',
  '/zh/',
  '/zh/nex/',
  '/zh/learn/',
  '/zh/legal/privacy/',
];
// 窄屏会把更多单行文本压成多行,是这一族最容易露头的地方(人工那轮漏的 14 处几乎都在这一档)
const WIDTHS = [1440, 390];

/** 在页面里跑:返回所有「多行且行距不足」的正文元素。主路径与自检共用同一份判据。 */
const SCAN = (MIN) => {
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('.line-fit-ok')) continue;
    if (/^(SCRIPT|STYLE|CANVAS|IMG|BR|HR|NOSCRIPT|SELECT|OPTION)$/.test(el.tagName)) continue;
    if (el.namespaceURI && el.namespaceURI.indexOf('svg') >= 0) continue;
    // 只看自己直接持有文本的元素,避免把容器重复算一遍
    const texts = [];
    for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim().length > 1) texts.push(n);
    if (!texts.length) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const fs = parseFloat(cs.fontSize);
    if (!(fs > 0) || fs > 20) continue; // display 档豁免(见文件头)
    const cls = typeof el.className === 'string' ? el.className : '';
    if (cls.indexOf('x-display') >= 0) continue;
    if (cs.lineHeight === 'normal') continue; // 交给字体自身度量,本门不判
    const lh = parseFloat(cs.lineHeight);
    if (!(lh > 0)) continue;
    // 真的渲染成几行:按行盒顶端聚类,不看换行符也不靠宽度估算
    const tops = new Set();
    for (const t of texts) {
      const r = document.createRange();
      r.selectNodeContents(t);
      for (const rect of r.getClientRects()) if (rect.height > 0) tops.add(Math.round(rect.top));
    }
    if (tops.size < 2) continue;
    const ratio = lh / fs;
    if (ratio >= MIN) continue;
    const dot = cls.trim() ? '.' + cls.trim().split(/\s+/).join('.') : '';
    out.push({
      sel: el.tagName.toLowerCase() + dot,
      lines: tops.size,
      ratio: Math.round(ratio * 1000) / 1000,
      fs: Math.round(fs * 10) / 10,
      lh: Math.round(lh * 10) / 10,
      text: (el.textContent || '').trim().split(/\s+/).join(' ').slice(0, 40),
    });
  }
  return out;
};

/* ── 自检:跑一页现造的样例,证明这门 ① 对行距不足的多行 vi 文本会红 ② 对达标的不红
   ③ display 档豁免真的生效 ④ 逃生阀认得出 ⑤ 单行不判。
   没有这段,门只是「今天恰好绿」——以后谁把判据改松了也不会有人知道。 */
const FIXTURE = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><style>
  body { margin: 0; width: 300px; font-family: monospace; }
  p { font-size: 16px; }
  .bad { line-height: 1.2; }
  .good { line-height: 1.45; }
  .big { font-size: 28px; line-height: 1.05; }
  .esc { line-height: 1.2; }
  .oneline { line-height: 1.2; }
</style></head><body>
  <p class="bad">Nhà cung cấp dịch vụ chia sẻ năng lực tính toán cho mạng lưới AI phân tán</p>
  <p class="good">Nhà cung cấp dịch vụ chia sẻ năng lực tính toán cho mạng lưới AI phân tán</p>
  <p class="big">Nhà cung cấp dịch vụ chia sẻ năng lực tính toán cho mạng lưới AI</p>
  <p class="esc line-fit-ok">Nhà cung cấp dịch vụ chia sẻ năng lực tính toán cho mạng lưới AI phân tán</p>
  <p class="oneline">Ngắn</p>
</body></html>`;

if (process.argv.includes('--self-test')) {
  const b = await chromium.launch();
  const c = await b.newContext({ viewport: { width: 320, height: 700 }, deviceScaleFactor: 1 });
  const p = await c.newPage();
  await p.setContent(FIXTURE, { waitUntil: 'load' });
  const found = await p.evaluate(SCAN, MIN_RATIO);
  await b.close();
  const names = found.map((f) => f.sel).join(' ');
  const expect = [
    ['① 行距不足的多行 vi 文本 → 抓到', names.indexOf('bad') >= 0],
    ['② 达标的不抓', names.indexOf('good') < 0],
    ['③ display 档(>20px)豁免', names.indexOf('big') < 0],
    ['④ 逃生阀 line-fit-ok 生效', names.indexOf('esc') < 0],
    ['⑤ 单行不判', names.indexOf('oneline') < 0],
  ];
  let bad = 0;
  for (const [name, ok] of expect) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) bad++;
  }
  console.log(`gate-vi-line-fit 自检: ${expect.length - bad} pass / ${bad} fail`);
  if (bad) console.log('  实际抓到:', names || '(空)');
  process.exit(bad ? 1 : 0);
}

let server = null;
let BASE = EXPLICIT;
if (!BASE) {
  if (!(await stat(join(DIST, 'index.html')).catch(() => null))) {
    // 跑不起来 ≠ 放行:退 3,由 verify 判 NOT-RUN(而 NOT-RUN 一律算红)
    console.log('[vi-line-fit] NOT-RUN:找不到 dist/index.html,先 npm run build');
    process.exit(3);
  }
  server = await serveDist();
  BASE = server.url;
}

const browser = await chromium.launch();
const hits = [];
for (const width of WIDTHS) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  for (const route of ROUTES) {
    const res = await page.goto(BASE + route, { waitUntil: 'networkidle' }).catch(() => null);
    if (!res || !res.ok()) {
      hits.push(`${route} @${width}  路由取不到(${res ? res.status() : '无响应'})`);
      continue;
    }
    await page.evaluate(() => document.fonts.ready);
    const bad = await page.evaluate(SCAN, MIN_RATIO);
    for (const b of bad) {
      hits.push(
        `${route} @${width}  ${b.sel}  行高/字号 = ${b.lh}/${b.fs} = ${b.ratio}(要 ≥ ${MIN_RATIO},实渲 ${b.lines} 行)  「${b.text}」`,
      );
    }
  }
  await ctx.close();
}
await browser.close();
if (server) await server.close();

if (hits.length) {
  // 同一条规则会在多条路由上重复命中,去重后仍全列(不合并、不截断)
  const uniq = [...new Set(hits)];
  console.log(`[vi-line-fit] ✘ ${uniq.length} 处多行文本行距不足(上一行的墨会压住下一行):`);
  for (const h of uniq) console.log('  - ' + h);
  console.log('  修法:优先在 tokens.css 的型类层加 :lang(vi)/:lang(zh) 例外(与已有的 .x-mono:lang(zh) 同层);');
  console.log('  组件里的同形规则常有多份副本(.q 就在三个组件里各一份),补要一起补。');
  console.log('  确系有意:给元素加 class line-fit-ok。');
  process.exit(1);
}
console.log('[vi-line-fit] ✓ vi/zh 多行正文行距全部达标');
