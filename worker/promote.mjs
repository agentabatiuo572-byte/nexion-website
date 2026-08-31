#!/usr/bin/env node
/* 上线切换:把已过门的构建产物 dist/ 提升为线上快照 dist-live/(CON13 的 swap 步)。
   🔴 为什么要两个目录(2026-09-01 验收 P0-3):质检门内部会重建 dist,若线上直接伺服 dist,
   门还在跑时未过门的内容就已经对外了。分开后 dist=待验、dist-live=已上线,只有本脚本搬运。
   写法:先写入同级临时目录再整体改名替换,避免拷到一半被访客读到半成品。

   🔴 上线印记(2026-09-01 复验 P0-A):本脚本会往快照里写一枚 `.publish-stamp.json`。
   服务端在把版本标 live **之前**,会通过自己的资产绑定去读这枚印记来核实——
   为什么需要它:上一版的修法只封了三种畸形上报序列,而「老老实实把四步按顺序各报一遍」
   依然能让版本上线且一道门没跑,伪造出的痕迹与真发布完全同形。根因是**服务端信了汇报**。
   现在改成**服务端核实结果**:印记只有真跑过本脚本才会存在,纯 HTTP 调用者写不进文件系统。

   用法:node promote.mjs [--check] [--version <id> --stamp <token>]
     --check                只报告快照与产物是否一致,不搬运
     --version/--stamp      写上线印记(执行器从 /api/publish/next 拿到后原样透传) */
import { cpSync, existsSync, renameSync, rmSync, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, '..', 'dist');
const LIVE = path.join(here, '..', 'dist-live');
const TMP = path.join(here, '..', 'dist-live.staging');
const OLD = path.join(here, '..', 'dist-live.prev');
const STAMP = '.publish-stamp.json';
const argOf = (k) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : null;
};

/* 指纹 = 路径 + **内容摘要**。
   🔴 早先只算「路径 + 字节数」,对**等长改写**是瞎的(复验 P2:改掉同样长度的内容后
   `--check` 仍然报「✓ 一致」)。一个看不出内容变化的指纹,在「核实线上是不是这一版」
   这件事上等于没有。上线印记本身不参与指纹——它是搬运的产物,不是被搬运的内容。 */
function fingerprint(dir) {
  if (!existsSync(dir)) return null;
  const h = createHash('sha256');
  let count = 0;
  const walk = (d, base = '') => {
    for (const n of readdirSync(d).sort()) {
      if (base === '' && n === STAMP) continue;
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) walk(p, `${base}/${n}`);
      else {
        h.update(`${base}/${n}\0`);
        h.update(readFileSync(p));
        count++;
      }
    }
  };
  walk(dir);
  return { count, hash: h.digest('hex').slice(0, 16) };
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
/* 🔴 每次搬运都先把旧印记抹掉(2026-09-01 第四轮 P1-4)。
   此前就地同步分支会把上一版的印记原样留着,于是「内容换了、印记还是旧的」——
   而劈叉自查正是靠印记判断线上是哪一版,这一留就让它**永远报不出来**;
   报不报还取决于当时目录有没有被占用(走哪个分支),这种"看运气"的判据比没有更坏。
   规则:印记只在本次真的写了才存在;写不了(手工提升、没给版本号)就让它缺席——
   缺席会被判成劈叉,那是诚实的结果。 */
function dropStamp(dir) {
  rmSync(path.join(dir, STAMP), { force: true });
}

function syncInPlace() {
  const want = new Set(listFiles(SRC));
  for (const rel of listFiles(LIVE)) {
    if (!want.has(rel)) rmSync(path.join(LIVE, rel), { force: true });
  }
  cpSync(SRC, LIVE, { recursive: true, force: true });
  dropStamp(LIVE); // 内容已换 → 旧印记一定不再有效
}

/* 上线印记:服务端标 live 前会读它核实「线上快照确实是这一版」。见文件头注。
   除版本号与一次性口令外,还带上**本次构建所用的物化配置的摘要**。
   🔴 为什么要这一项(2026-09-01 复验 P1-4):只带版本号和口令,证明的是「有人落了个文件」,
   不是「落下的内容就是这一版」。服务端手里有同一个物化器,能自己算出这一版该物化成什么样,
   于是摘要一比就知道这份快照到底是不是照着这一版的配置构建的。 */
/* 摘要覆盖**全部物化产物**(三语文案 + 站点配置),不只是 site.json。
   🔴 只哈希 site.json 时,「只改文案」这个最常见的改动摘要完全不变,核验形同虚设(第四轮 P1-3)。
   拼接口径必须与服务端 expectedConfigSha 逐字节一致:路径 + NUL + 内容,以 NUL 相连,顺序固定。 */
const MATERIALIZED_FILES = ['src/i18n/en.json', 'src/i18n/vi.json', 'src/i18n/zh.json', 'src/config/site.json'];
function writeStamp(dir) {
  const versionId = Number(argOf('--version'));
  const stampToken = argOf('--stamp');
  if (!versionId || !stampToken) return null;
  const parts = [];
  for (const rel of MATERIALIZED_FILES) {
    const p = path.join(here, '..', rel);
    if (!existsSync(p)) {
      console.error(`✗ 缺 ${rel} —— 物化步没跑过?拒绝写上线印记(没有印记服务端不会放行上线)`);
      process.exit(2);
    }
    parts.push(`${rel}\0${readFileSync(p, 'utf8')}`);
  }
  const configSha = createHash('sha256').update(parts.join('\0'), 'utf8').digest('hex');
  const body = JSON.stringify({ versionId, stamp: stampToken, configSha, at: new Date().toISOString() }) + '\n';
  writeFileSync(path.join(dir, STAMP), body);
  return versionId;
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
  writeStamp(TMP); // 印记随 staging 一起上位,和内容同一瞬间可见
  if (existsSync(LIVE)) renameSync(LIVE, OLD);
  renameSync(TMP, LIVE);
  rmSync(OLD, { recursive: true, force: true });
} catch (e) {
  if (!['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES'].includes(e.code)) throw e;
  // 换名失败后 LIVE 可能已被改名到 OLD,先把它放回去,再就地同步
  if (!existsSync(LIVE) && existsSync(OLD)) renameSync(OLD, LIVE);
  syncInPlace();
  writeStamp(LIVE); // 内容同步完再落印记:印记在,就意味着内容已经就位
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
