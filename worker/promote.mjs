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
import { cpSync, existsSync, renameSync, rmSync, readdirSync, statSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const STAMP = '.publish-stamp.json';
const argOf = (k) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : null;
};
const SRC = path.resolve(argOf('--source') || path.join(here, '..', 'dist'));
const LIVE = path.resolve(argOf('--live') || path.join(here, '..', 'dist-live'));
const TMP = `${LIVE}.staging`;
const OLD = `${LIVE}.prev`;
const MATERIALIZED_ROOT = path.resolve(argOf('--materialized-root') || path.join(here, '..'));
if (path.basename(SRC) !== 'dist' || path.basename(LIVE) !== 'dist-live' || SRC === LIVE || SRC.startsWith(`${LIVE}${path.sep}`)) {
  throw new Error('拒绝不明确的快照目录：source 必须为 dist，live 必须为 dist-live，且两者分离');
}
for (const p of [SRC, LIVE, TMP, OLD]) {
  if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new Error('快照目录不能是链接，拒绝跨边界操作');
}

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
  dropStamp(LIVE); // 修改之前先撤掉旧凭证，绝不让混排内容带着旧上线印记。
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
  const stampToken = process.env.PUBLISH_STAMP || argOf('--stamp');
  if (!versionId || !stampToken) return null;
  const parts = [];
  for (const rel of MATERIALIZED_FILES) {
    const p = path.join(MATERIALIZED_ROOT, rel);
    if (!existsSync(p)) {
      throw new Error(`缺 ${rel}，拒绝写上线印记：隔离副本没有完整物化配置`);
    }
    parts.push(`${rel}\0${readFileSync(p, 'utf8')}`);
  }
  const configSha = createHash('sha256').update(parts.join('\0'), 'utf8').digest('hex');

  /* 锚点指纹:记下快照里几个关键文件**搬运那一刻**的内容摘要。
     🔴 为什么需要(2026-09-01 第五轮 P1-4):此前印记只带版本号,于是「有人直接改了线上快照」
     这件事完全报不出来——劈叉自查比的是版本号,而版本号没变。
     服务端读得到自己伺服的内容,所以它能拿这几个摘要**回核实物**。
     ⚠️ 明确边界:这是**抽查**不是全量——只覆盖下面列出的锚点文件,
     动了别的资产仍然看不见。全量核验要求服务端遍历整个快照,代价与收益不成比例;
     锚点选的是「改了就一定影响访客看到什么」的那几个。 */
  /* 锚点 = **全部 HTML 页面**(三语各页 + 404 + 控制台外壳)。
     🔴 第一版只记了 3 个文件(112 个里的 3 个、36 个页面里的 1 个),于是改中文首页、
     改全站样式表都照样 `drift=null`(第六轮 P1-3)。HTML 是访客真正读到的东西,
     全记下来也就几十条,代价可以忽略。
     ⚠️ 仍不是全量:非 HTML 资产(CSS/JS/图片)不在内——它们由页面按指纹文件名引用,
     换内容通常会换文件名、于是页面本身的摘要就变了;但**直接覆盖同名资产**这一种仍看不见。
     这个缺口在界面上常驻说明,不藏着。 */
  const anchors = {};
  const walkHtml = (d, base = '') => {
    for (const n of readdirSync(d).sort()) {
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) walkHtml(p, `${base}/${n}`);
      else if (n.endsWith('.html')) anchors[`${base}/${n}`] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walkHtml(dir);

  const body = JSON.stringify({ versionId, stamp: stampToken, configSha, anchors, at: new Date().toISOString() }) + '\n';
  writeFileSync(path.join(dir, STAMP), body);
  return versionId;
}

/* 换名换位:拷到 staging → 旧快照让路 → staging 上位 → 删旧。
   🔴 Windows 上服务运行时换不动(2026-09-01 实测):wrangler dev 持有 dist-live 的目录句柄,
   `rename` 直接 EBUSY —— 也就是「本地开着服务时 swap 必失败」,而那恰好是它唯一被用到的场合。
   故:能换名就换名(服务没起 / 部署机上,拿到强原子性);换不动就退回就地同步,并说明降级原因。
   生产环境不走这里——Cloudflare 的资产随 Worker 一起部署,平台自带原子性。 */
let staged = false;
const restorePrevious = () => {
  if (!existsSync(OLD)) return;
  if (!existsSync(LIVE)) { renameSync(OLD, LIVE); return; }
  dropStamp(LIVE);
  const previous = new Set(listFiles(OLD));
  for (const rel of listFiles(LIVE)) if (!previous.has(rel)) rmSync(path.join(LIVE, rel), { force: true });
  cpSync(OLD, LIVE, { recursive: true, force: true });
};
try {
  rmSync(TMP, { recursive: true, force: true });
  rmSync(OLD, { recursive: true, force: true });
  cpSync(SRC, TMP, { recursive: true });
  writeStamp(TMP); // 印记随 staging 一起上位,和内容同一瞬间可见
  staged = true;
  if (existsSync(LIVE)) renameSync(LIVE, OLD);
  renameSync(TMP, LIVE);
} catch (e) {
  if (!staged || !['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES'].includes(e.code)) {
    restorePrevious();
    throw e;
  }
  // 换名失败后 LIVE 可能已被改名到 OLD,先把它放回去,再就地同步
  if (!existsSync(LIVE) && existsSync(OLD)) renameSync(OLD, LIVE);
  // 就地覆盖前必须留下完整旧版；同步异常则把全部旧文件和印记还原。
  if (existsSync(LIVE) && !existsSync(OLD)) cpSync(LIVE, OLD, { recursive: true });
  try {
    syncInPlace();
    writeStamp(LIVE);
  } catch (failure) {
    restorePrevious();
    throw failure;
  }
  rmSync(TMP, { recursive: true, force: true });
  console.log(`· 目录被占用(${e.code}),已改用就地同步(内容一致,少了换名那一瞬的原子性)`);
}

const f = fingerprint(LIVE);
const s = fingerprint(SRC);
if (f.hash !== s.hash || f.count !== s.count) {
  restorePrevious();
  console.error(`✗ 提升后两者仍不一致:dist ${s.count}/${s.hash} vs dist-live ${f.count}/${f.hash}`);
  process.exit(1);
}
rmSync(OLD, { recursive: true, force: true });
console.log(`✓ 已上线:dist-live ← dist(${f.count} 文件 / ${f.hash})`);
