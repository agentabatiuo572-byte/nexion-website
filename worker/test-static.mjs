#!/usr/bin/env node
/* T3-AC 字节级验收:worker 伺服的响应体 == 伺服目录里对应文件的字节(≥10 条路由,枚举不手写);
   另验 /api/health 直通与未知路径 404。
   🔴 对照物 = wrangler.jsonc 里 assets.directory 声明的那个目录,不写死(2026-09-01):
   伺服目录已从 dist 改成 dist-live(见 wrangler.jsonc 注释),门若自带一份路径,改配置时它会静静
   对着旧目录报绿——这类「门守的不是被守物」踩过多次,所以让门去读配置,配置改了门跟着改。
   用法:node test-static.mjs(需先 npm run build && npm run publish:promote 造出伺服目录)。
   退出码:0 全对;非 0 有差异。收尾杀净自起进程并回读端口(孤儿教训 2026-08-31)。 */
import { spawn, execSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const wranglerSrc = readFileSync(path.join(here, 'wrangler.jsonc'), 'utf8');
const declared = /"assets"\s*:\s*\{[\s\S]*?"directory"\s*:\s*"([^"]+)"/.exec(wranglerSrc)?.[1];
if (!declared) {
  console.error('✗ wrangler.jsonc 里读不到 assets.directory —— 无法确定该拿哪个目录做对照(拒绝猜)');
  process.exit(3);
}
const DIST = path.resolve(here, declared);
const PORT = 8788;
const BASE = `http://127.0.0.1:${PORT}`;

if (!existsSync(DIST)) {
  console.error(`✗ 缺伺服目录 ${DIST}(wrangler 声明 ${declared})`);
  console.error('  先在站仓根 npm run build,再 npm --prefix worker run publish:promote(造环境,不读码顶账)');
  process.exit(3);
}

// 从伺服目录枚举路由(构造性,不手写清单)
function collectRoutes(dir, base = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...collectRoutes(p, `${base}/${name}`));
    else if (name === 'index.html') out.push({ route: `${base}/` || '/', file: p });
  }
  return out;
}
const routes = collectRoutes(DIST);
if (routes.length < 10) {
  console.error(`✗ ${declared} 只枚举到 ${routes.length} 条路由(<10),产物可疑`);
  process.exit(3);
}

const child = spawn('npx', ['wrangler', 'dev', '--port', String(PORT)], {
  cwd: here, shell: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let devLog = '';
child.stdout.on('data', (d) => (devLog += d));
child.stderr.on('data', (d) => (devLog += d));

function killTree() {
  try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch {}
  // 回读端口确认无孤儿(教训:杀完必须回读)
  try {
    const left = execSync(
      `powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count"`,
      { encoding: 'utf8' },
    ).trim();
    if (left !== '0') {
      execSync(
        `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${PORT} -State Listen | %% { Stop-Process -Id $_.OwningProcess -Force }"`,
        { stdio: 'ignore' },
      );
    }
  } catch {}
}

async function waitReady(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

let fails = 0;
const say = (ok, msg) => { console.log(`${ok ? '✓' : '✗'} ${msg}`); if (!ok) fails++; };

try {
  if (!(await waitReady())) {
    console.error('✗ wrangler dev 起服超时;日志尾部:\n' + devLog.split('\n').slice(-15).join('\n'));
    process.exit(2);
  }

  // 1) API 直通
  const health = await fetch(`${BASE}/api/health`);
  say(health.status === 200, 'API 直通:/api/health 200');

  // 2) 字节级对比(全部 index.html 路由)
  let mismatches = 0;
  for (const { route, file } of routes) {
    const res = await fetch(`${BASE}${route}`);
    const got = Buffer.from(await res.arrayBuffer());
    const want = readFileSync(file);
    if (res.status !== 200 || !got.equals(want)) {
      mismatches++;
      console.log(`  ✗ ${route} status=${res.status} bytes ${got.length} vs ${want.length}`);
    }
  }
  say(mismatches === 0, `字节级一致:${routes.length - mismatches}/${routes.length} 条路由(含三语)`);

  // 3) 404 托底
  const nf = await fetch(`${BASE}/definitely-not-a-page-xyz`);
  say(nf.status === 404, `未知路径 404(实测 ${nf.status})`);
} finally {
  killTree();
}

console.log(fails === 0 ? `PASS test-static(${routes.length} 路由)` : `FAIL test-static(${fails} 项)`);
process.exit(fails === 0 ? 0 : 1);
