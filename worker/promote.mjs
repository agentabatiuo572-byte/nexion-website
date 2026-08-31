#!/usr/bin/env node
/* 上线切换:把已过门的构建产物 dist/ 提升为线上快照 dist-live/(CON13 的 swap 步)。
   🔴 为什么要两个目录(2026-09-01 验收 P0-3):质检门内部会重建 dist,若线上直接伺服 dist,
   门还在跑时未过门的内容就已经对外了。分开后 dist=待验、dist-live=已上线,只有本脚本搬运。
   写法:先写入同级临时目录再整体改名替换,避免拷到一半被访客读到半成品。
   用法:node promote.mjs [--check](--check 只报告两者是否一致,不搬运) */
import { cpSync, existsSync, renameSync, rmSync, readdirSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, '..', 'dist');
const LIVE = path.join(here, '..', 'dist-live');
const TMP = path.join(here, '..', 'dist-live.staging');
const OLD = path.join(here, '..', 'dist-live.prev');

function fingerprint(dir) {
  if (!existsSync(dir)) return null;
  const files = [];
  const walk = (d, base = '') => {
    for (const n of readdirSync(d).sort()) {
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) walk(p, `${base}/${n}`);
      else files.push(`${base}/${n}:${statSync(p).size}`);
    }
  };
  walk(dir);
  let h = 5381;
  for (const s of files) for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return { count: files.length, hash: (h >>> 0).toString(16) };
}

if (!existsSync(SRC)) {
  console.error('✗ 缺 dist —— 先在站仓根 npm run build');
  process.exit(2);
}

if (process.argv.includes('--check')) {
  const a = fingerprint(SRC);
  const b = fingerprint(LIVE);
  console.log(`dist      : ${a.count} 文件 / ${a.hash}`);
  console.log(`dist-live : ${b ? `${b.count} 文件 / ${b.hash}` : '(不存在)'}`);
  const same = b && a.hash === b.hash && a.count === b.count;
  console.log(same ? '✓ 线上快照与构建产物一致' : '· 两者不同(构建产物尚未提升上线,这在门未通过时是正确状态)');
  process.exit(0);
}

/* 🔴 护栏:站上 13 门跑在**纯官网 dist** 上(astro build 会清空 dist,控制台不在里面),
   控制台要等 build:console 重新组装回 dist/admin。顺序颠倒时——例如有人手跑
   `npm run verify && npm run publish:promote`——这一提升会把线上的 /admin 整个抹掉,
   而站点本身一切正常,故障只表现为「后台打不开了」,不容易联想到是发布顺序的问题。
   执行器的顺序是对的(门 → build:console → swap),这道护栏管的是手工操作。 */
if (existsSync(path.join(LIVE, 'admin', 'index.html')) && !existsSync(path.join(SRC, 'admin', 'index.html'))) {
  if (!process.argv.includes('--allow-console-drop')) {
    console.error('✗ 拒绝提升:dist 里没有控制台(dist/admin),提升后线上后台会打不开');
    console.error('  多半是刚跑完门(astro build 清空了 dist)。先 npm run build:console 把控制台组装回去再提升。');
    console.error('  确实想让线上只剩官网:加 --allow-console-drop');
    process.exit(2);
  }
  console.log('· --allow-console-drop:本次提升会移除线上控制台');
}

/** 目录内全部文件的相对路径 */
function listFiles(dir, base = '') {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    const rel = base ? `${base}/${n}` : n;
    if (statSync(path.join(dir, n)).isDirectory()) out.push(...listFiles(path.join(dir, n), rel));
    else out.push(rel);
  }
  return out;
}

/* 就地同步:逐文件覆盖 + 删除已不存在的旧文件。
   原子性弱于换名(访客可能读到新旧混排的一瞬),但两边都是**已过门**的内容,
   而换名换来的强原子性在服务运行时根本拿不到(见下)。 */
function syncInPlace() {
  const want = new Set(listFiles(SRC));
  for (const rel of listFiles(LIVE)) {
    if (!want.has(rel)) rmSync(path.join(LIVE, rel), { force: true });
  }
  cpSync(SRC, LIVE, { recursive: true, force: true });
}

/* 换名换位:拷到 staging → 旧快照让路 → staging 上位 → 删旧。
   🔴 Windows 上服务运行时换不动(2026-09-01 实测):wrangler dev 持有 dist-live 的目录句柄,
   `rename` 直接 EBUSY —— 也就是「本地开着服务时 swap 必失败」,而那恰好是它唯一被用到的场合。
   故:能换名就换名(服务没起 / 部署机上,拿到强原子性);换不动就退回就地同步,并说明降级原因。
   生产环境不走这里——Cloudflare 的资产随 Worker 一起部署,平台自带原子性。 */
try {
  rmSync(TMP, { recursive: true, force: true });
  rmSync(OLD, { recursive: true, force: true });
  cpSync(SRC, TMP, { recursive: true });
  if (existsSync(LIVE)) renameSync(LIVE, OLD);
  renameSync(TMP, LIVE);
  rmSync(OLD, { recursive: true, force: true });
} catch (e) {
  if (!['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES'].includes(e.code)) throw e;
  // 换名失败后 LIVE 可能已被改名到 OLD,先把它放回去,再就地同步
  if (!existsSync(LIVE) && existsSync(OLD)) renameSync(OLD, LIVE);
  syncInPlace();
  rmSync(TMP, { recursive: true, force: true });
  rmSync(OLD, { recursive: true, force: true });
  console.log(`· 目录被占用(${e.code}),已改用就地同步(内容一致,少了换名那一瞬的原子性)`);
}

const f = fingerprint(LIVE);
const s = fingerprint(SRC);
if (f.hash !== s.hash || f.count !== s.count) {
  console.error(`✗ 提升后两者仍不一致:dist ${s.count}/${s.hash} vs dist-live ${f.count}/${f.hash}`);
  process.exit(1);
}
console.log(`✓ 已上线:dist-live ← dist(${f.count} 文件 / ${f.hash})`);
