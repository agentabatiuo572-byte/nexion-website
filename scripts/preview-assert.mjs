#!/usr/bin/env node
/* 核实「预览服务真的在我要的端口上、伺服的是刚构建的产物」。

   🔴 为什么需要它(2026-09-02 实录):astro 7 的 preview 是后台守护进程,
   三种失败都**长得像成功**:
     ① 端口被占 → 静默落到下一个端口,而我照打原端口,验到别人的产物;
     ② 已有守护进程 → 新命令被跳过,却返回 exit 0;
     ③ `astro preview status` 会说「没有服务在跑」而实际有。
   当天主人两次说「4399 还是旧内容」,第二次正是坑② —— 我重启了、命令返回 0、
   我以为成了,服务压根没换。

   判据不看命令退出码,只看**三件客观事实**:
     A 那个端口真的有人在监听且能回 200;
     B 回来的 HTML 里带着本次构建的指纹(拿 dist/index.html 比对);
     C 首页关键结构还在(不是回了个错误页/空壳)。

   用法:node scripts/preview-assert.mjs [端口]   默认 4399 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/* --self-test:起临时服务,证明这道检查**两向都真会响**。
   🔴 第一版红测造错了变异:我改了本地 dist 再查,期待「服务给的是旧的」——
   而 astro preview **实时读磁盘**,改完它立刻跟着变,变异根本打不到靶子上,
   于是红测「绿」了,看着像判据松了。真实的失败形态是**服务伺服的是另一个目录**
   (主人那次正是:4399 上跑的是另一条工作线的产物),照这个造才打得中。
   教训:变异要照**真实事故形态**造,不是照「我以为的失败方式」造。 */
async function selfTest() {
  const http = await import('node:http');
  let fails = 0;
  const say = (ok, m) => {
    console.log((ok ? '\u2713 ' : '\u2717 ') + m);
    if (!ok) fails++;
  };
  /* 🔴 必须用**异步**子进程(2026-09-02 踩到):自检在同一个进程里起临时服务,
     再用 `execFileSync` 同步等子进程 —— 同步调用把事件循环整个卡住,
     那个服务于是一个请求都处理不了,子进程三个地址全超时。
     表现是「服务明明在监听,却连不上」,和真实故障长得一模一样,极易误判成判据坏了。 */
  const { execFile } = await import('node:child_process');
  const run = (port) =>
    new Promise((resolve) => {
      execFile(process.execPath, [fileURLToPath(import.meta.url), String(port)], (err) => resolve(err ? (err.code ?? 1) : 0));
    });
  const serve = (port, html) =>
    new Promise((resolve) => {
      const srv = http.createServer((_q, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(html);
      });
      srv.listen(port, () => resolve(srv));
    });

  say(await run(4491) === 1, 'self-test:端口上没有任何服务 → 报红');

  const other = await serve(4492, '<!doctype html><html><body><div id="hero">another line</div></body></html>');
  say(await run(4492) === 1, 'self-test:服务伺服的是别的目录 → 报红(主人那次的真实形态)');
  other.close();

  const mine = await serve(4493, readFileSync(DIST, 'utf8'));
  say(await run(4493) === 0, 'self-test:服务伺服的就是当前 dist → 放行,不误报');
  mine.close();

  console.log('(自检 3 条)');
  process.exit(fails ? 1 : 0);
}


const PORT = Number(process.argv[2] || 4399);
const DIST = path.join(ROOT, 'dist', 'index.html');
if (process.argv.includes('--self-test')) await selfTest();
const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

if (!existsSync(DIST)) fail(`dist/index.html 不在 —— 先 npm run build(没有产物就没有可比的基准)`);
const local = readFileSync(DIST, 'utf8');
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);

/* 🔴 IPv4 / IPv6 两个都试(2026-09-02 实测踩到):
   `localhost` 在本机优先解析成 IPv6 `[::1]`,而不同服务监听面不一样 ——
   astro preview 只监听 `[::1]`,而 node 起的临时服务默认只监听 `0.0.0.0`(IPv4)。
   只试一个,就会把「服务好好跑着」误判成「连不上」;
   本轮排查里 `curl 127.0.0.1:4399` 返回 000 正是这么来的,差点据此断定服务没起来。 */
let res;
const tried = [];
for (const host of ['localhost', '127.0.0.1', '[::1]']) {
  try {
    res = await fetch(`http://${host}:${PORT}/`, { signal: AbortSignal.timeout(5000) });
    break;
  } catch (e) {
    tried.push(`${host}(${String(e.message).slice(0, 32)})`);
  }
}
if (!res) fail(`${PORT} 端口连不上 —— 试过 ${tried.join(' · ')};服务没起来,或者它静默漂到了别的端口`);
if (res.status !== 200) fail(`${PORT} 回的是 ${res.status},不是 200`);
const served = await res.text();

/* B:指纹比对。preview 可能对 HTML 做压缩/注入,所以不比整份字节,
   比**结构指纹**:去掉空白后的正文哈希。两边不等 = 伺服的不是这次构建的产物。 */
const norm = (s) => s.replace(/>\s+</g, '><').trim();
if (sha(norm(served)) !== sha(norm(local))) {
  fail(
    `${PORT} 伺服的不是当前 dist —— 线上指纹 ${sha(norm(served))} vs 本地 ${sha(norm(local))}。\n` +
      `  多半是:另一个工作台/另一条分支的守护进程占着这个端口(见 CLAUDE.md 那三个坑)。\n` +
      `  处置:按端口查进程杀掉(astro preview stop 可能会谎报「没有在跑」),再重启。`,
  );
}
// C:回的是真页面不是错误页
for (const [name, re] of [['站点壳', /<html/i], ['首屏', /id="hero"|class="hero/i]]) {
  if (!re.test(served)) fail(`${PORT} 回的内容里找不到${name} —— 像是错误页或空壳`);
}
console.log(`PASS preview-assert(:${PORT} 在跑,伺服的就是当前 dist,指纹 ${sha(norm(local))})`);
