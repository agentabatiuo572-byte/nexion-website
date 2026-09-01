/* 发布与版本(CON13 ⑤⑥):diff 摘要 + 前置校验红项(带去修复跳转)+ 确认弹窗(高敏须理由)
   + 流水线四步进度 + 失败面(大白话 + 门名 + 原始日志折叠)+ 版本历史与回滚。
   诚实:门红时明说「线上保持旧版未受影响」;执行器不在线时给排队态与取消出口,不吊死。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { ApiError, api, toast } from '../api';
import { splitFailReason } from '../lib/fail-reason';
import { useShell } from '../shell';

interface Finding { path: string; rule: string; message: string }
interface Preflight {
  ready: boolean; errors: Finding[]; warnings: Finding[];
  changedPaths: string[]; changed: number; sensitiveChanged: string[]; reasonRequired: boolean;
}
interface StepRow { step: string; status: string; detail: string | null; started_at: number; ended_at: number | null }
interface VersionRow { id: number; status: string; reason: string | null; fail_reason: string | null; created_by: string; created_at: number; published_at: number | null; changed?: number }
interface Status {
  activeVersion: number | null; stepsOfVersion: number | null; steps: StepRow[]; versions: VersionRow[]; stepNames: string[];
  /** 线上快照对不上:版本号不符,或版本号对但内容被直接改过(tampered 列出对不上的文件) */
  drift: { dbLive: number; snapshot: number | null; tampered?: string[] } | null;
  /** 版本列表被截断了(只回最近若干条)——界面必须说出来,别让人以为这就是全部 */
  versionsTruncated?: boolean;
  /** 服务端直接告诉界面能不能取消:none 无进行中 · yes 排队态可取消 · force 需失联+理由 · no 执行器仍在工作 */
  cancelable?: 'none' | 'yes' | 'force' | 'no';
  silentMs?: number;
}

const STEP_LABEL: Record<string, string> = { materialize: '物化配置(生成三语文案与站点配置)', gates: '站上全部机器门(13 门)', build: '生产构建', swap: '原子切换上新' };
const STATUS_LABEL: Record<string, string> = { live: '线上', archived: '历史', failed: '失败(未上线)', cancelled: '已取消', validating: '校验中', publishing: '发布中' };
/** 把校验规则译成人话;缺映射显规则名原文,不隐藏 */
const RULE_LABEL: Record<string, string> = {
  'forbidden-word': '合规禁用词', placeholder: '占位符缺失', untranslated: '缺译', 'unknown-key': '非法 key',
  'missing-key': '缺 key', 'enabled-empty-url': '开启的入口缺 URL', url: '链接格式', email: '邮箱格式',
  'all-hidden': '设备板块全隐藏', 'min-visible': 'FAQ 可见不足 3 条', 'dup-id': 'FAQ id 重复', window: '公告时间窗',
  structure: '数据结构', 'mock-anchor': '统计仍是演示值', 'seo-length': 'SEO 长度', 'pending-assets': '信任资料占位',
  'newline-shape': '换行结构', 'encoding-damage': '编码损坏字符',
};
// 本表必须与 schema/src/validators.ts 的规则集**双向**相等 —— 由 gate-config-consistency 断言。
// (曾出现凭空多一个 'all-hidden-sku':校验器从不产出,纯死键;真正的键叫 'all-hidden'。)
/* 字段路径 → 人话。
   🔴 实景走查 P2-11/12/13:diff 摘要、提醒行、红项表三处都在直印
   `announcement.text.en` / `downloads.ios.enabled` 这类内部路径。
   运营认不出这是「公告条的英文正文」还是别的什么,而 PRD 明写页面文案禁出现字段名。
   一处映射三处共用:再多一处直印,就是这张表该补而不是再写一遍。 */
const AREA: Array<[RegExp, string]> = [
  [/^copy\.(en|vi|zh)\./, '文案'],
  [/^downloads\./, '下载入口'],
  [/^stats\./, '平台数字'],
  [/^skus\b/, '产品卡'],
  [/^faq\b/, '常见问题'],
  [/^announcement\./, '公告条'],
  [/^seo\./, 'SEO'],
  [/^footer\./, '页脚'],
  [/^legal\./, 'Legal 文本'],
];
const LOCALE_NAME: Record<string, string> = { en: '英文', vi: '越南语', zh: '中文' };
/* 字段名 → 人话。
   🔴 第一版只剥掉了区域前缀,尾巴原样保留,于是:
   `产品卡 · skus[0].priceUSD` —— **人话行和下面的原文小字一模一样,等于没翻译**;
   `平台数字 · activeDevices` 也和页面上写的「活跃设备」对不上(第八轮走查我点名请它判,它判「不够」)。
   现在逐字段真映射;认不出的尾巴保留原样(不隐藏),但至少区域和已知字段是人话。 */
const FIELD_NAME: Record<string, string> = {
  // 产品卡
  name: '名称', priceUSD: '价格', multiplier: '算力倍数', status: '状态', tagline: '标语', visible: '是否展示', sort: '排序',
  free: '是否免费档',
  // 下载入口(平台键也要译:`下载入口 · ios · 链接` 里那个 ios 是配置键,不是给人看的写法)
  url: '链接', enabled: '开关', ios: 'iOS 版', android: '安卓版', h5: '网页版',
  // 公告条 / SEO / 页脚
  text: '正文', startsAt: '开始时间', endsAt: '结束时间', title: '标题', description: '描述',
  social: '社媒链接', contactEmail: '联系邮箱', id: '编号',
  // 平台数字(与各页面上的标签一致)。走查实景抓到过「平台数字 · nodes」漏在这里
  activeDevices: '活跃设备', activeJobs: '运行中任务', countries: '覆盖国家', uptime: '在线率',
  nodes: '节点数', asOf: '数据截至',
  // FAQ / Legal
  items: '条目', q: '问题', a: '答案', md: '正文', updatedAt: '最后更新', href: '跳转链接',
  terms: '服务条款', privacy: '隐私政策', appPrivacy: 'App 隐私政策',
  // SEO 的页面 id(seo.pages 下的键就是路由名,直接摆出来运营对不上是哪一页)
  pages: '页面', home: '首页', learn: '学习页', nex: 'NEX 页',
  'legal-privacy': '隐私政策页', 'legal-terms': '服务条款页', 'legal-app-privacy': 'App 隐私政策页',
};
/** 例:`skus[0].priceUSD` → 「产品卡 · 第 1 张 · 价格」;认不出的部分保留原样,不隐藏 */
export function humanPath(path: string): string {
  const area = AREA.find(([re]) => re.test(path))?.[1];
  if (!area) return path;
  const loc = Object.keys(LOCALE_NAME).find((l) => path.startsWith(`copy.${l}.`) || path.endsWith(`.${l}`));
  const parts = path
    .replace(/^(copy\.(en|vi|zh)|[a-z]+)\.?/i, '') // 去区域前缀(含 copy.<语言>)
    .replace(/\.(en|vi|zh)$/, '') // 去尾部语言
    .split('.')
    .flatMap((seg) => {
      const m = /^([a-zA-Z_$][\w$]*)?\[(\d+)\]$/.exec(seg);
      if (m) return [m[1] ? (FIELD_NAME[m[1]] ?? m[1]) : null, `第 ${Number(m[2]) + 1} 项`].filter(Boolean) as string[];
      return seg ? [FIELD_NAME[seg] ?? seg] : [];
    });
  return [area, loc && LOCALE_NAME[loc], ...parts].filter(Boolean).join(' · ');
}

/** 红项 → 该去哪个页面修 */
function fixLink(path: string): string {
  if (path.startsWith('copy.')) return '/content';
  if (path.startsWith('downloads')) return '/content/downloads';
  if (path.startsWith('stats')) return '/content/stats';
  if (path.startsWith('skus')) return '/content/skus';
  if (path.startsWith('faq')) return '/content/faq';
  if (path.startsWith('announcement')) return '/content/announcement';
  if (path.startsWith('seo') || path.startsWith('footer')) return '/content/seo';
  if (path.startsWith('legal')) return '/content/legal';
  return '/content';
}

export default function PublishPage() {
  const { reload: reloadShell } = useShell();
  const [pre, setPre] = useState<Preflight | null>(null);
  const [st, setSt] = useState<Status | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ reason: string; rollbackFrom?: number } | null>(null);
  const [forcing, setForcing] = useState(false);
  const [forceReason, setForceReason] = useState('');
  const [openLog, setOpenLog] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const load = useCallback(() => {
    setFailed(false);
    Promise.all([api<Preflight>('/api/publish/preflight'), api<Status>('/api/publish/status')])
      .then(([p, s]) => { setPre(p); setSt(s); })
      .catch(() => setFailed(true));
  }, []);
  useEffect(load, [load]);

  // 发布进行中轮询(2s);结束即停并刷新壳状态条
  useEffect(() => {
    if (st?.activeVersion) {
      timer.current = window.setTimeout(() => {
        api<Status>('/api/publish/status').then((s) => {
          setSt(s);
          if (!s.activeVersion) { load(); reloadShell(); }
        }).catch(() => {});
      }, 2000);
    }
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [st, load, reloadShell]);

  async function doPublish(rollbackFrom?: number) {
    if (!confirm) return;
    setBusy(true);
    try {
      await api('/api/publish', { method: 'POST', body: JSON.stringify({ reason: confirm.reason, fromVersion: rollbackFrom }) });
      toast(rollbackFrom ? '回滚已发起,同样要过全部机器门' : '发布已发起');
      setConfirm(null);
      load();
    } catch (e) {
      const err = e instanceof ApiError ? String(e.body.error ?? '') : '';
      toast(err.includes('reason') ? '需要填写理由(≥8 字)' : err.includes('in-progress') ? '已有发布正在进行' : err.includes('preflight') ? '前置校验未通过' : '发起失败,请重试');
    } finally { setBusy(false); }
  }

  /* 取消两档:排队态直接取消;已开工则要执行器失联满 12 分钟 + 写明理由才允许强制中止。
     🔴 上一轮只做了服务端、界面上没有入口,运营遇到执行器崩掉时依旧只能干等锁超时(复验 P1-2)。 */
  /* 能不能取消由服务端在 /status 里直说,界面不再靠**发一个注定失败的请求**去试探——
     那种试探行为正确,但正常操作路径每次都会在浏览器控制台留一条红(实景走查 P2-10)。 */
  async function cancel() {
    if (st?.cancelable === 'force') { setForcing(true); return; }
    if (st?.cancelable === 'no') {
      toast('执行器仍在工作(最近还有步骤动静),现在中止会留下没人收口的中间态');
      return;
    }
    try {
      await api('/api/publish/cancel', { method: 'POST', body: JSON.stringify({}) });
      toast('已取消'); load();
    } catch (e) {
      toast(((e as ApiError).body as { hint?: string }).hint ?? '无法取消,请刷新后重试');
    }
  }
  async function forceCancel() {
    if (forceReason.trim().length < 4) { toast('请写明中止理由(至少 4 个字)'); return; }
    try {
      await api('/api/publish/cancel', { method: 'POST', body: JSON.stringify({ force: true, reason: forceReason.trim() }) });
      toast('已强制中止,可以重新发起'); setForcing(false); setForceReason(''); load();
    } catch (e) {
      toast(((e as ApiError).body as { hint?: string }).hint ?? '仍无法中止(执行器可能又有动静了)');
    }
  }

  if (failed) return <section><h2>发布与版本</h2><div className="note bad">数据获取失败 <button className="btn ghost sm" onClick={load}>重试</button></div></section>;
  if (!pre || !st) return <section><h2>发布与版本</h2><div className="skl" style={{ height: 80 }} /></section>;

  const active = st.activeVersion;
  const lastFailed = st.versions.find((v) => v.status === 'failed');
  // 步骤只认「本次进行中版本」的日志,防把上一次的步骤画进这一次(stepsOfVersion 由服务端标明)
  const stepDone = (name: string) => (st.stepsOfVersion === active ? st.steps.find((s) => s.step === name) : undefined);

  return (
    <section>
      <h2>发布与版本</h2>

      {/* 进行中:四步进度 */}
      {active && (
        <div className="card" style={{ marginBottom: 12 }}>
          <h3>正在发布 v{active}</h3>
          {st.stepNames.map((name) => {
            const s = stepDone(name);
            const cls = s?.status === 'ok' ? 'ok' : s?.status === 'failed' ? 'bad' : s?.status === 'running' ? 'warn' : '';
            const secs = s?.started_at ? Math.round(((s.ended_at ?? Date.now()) - s.started_at) / 1000) : 0;
            return (
              <div className="row" key={name} style={{ padding: '6px 0' }}>
                <span className={`pill ${cls}`} style={{ minWidth: 58, textAlign: 'center' }}>
                  {s?.status === 'ok' ? '完成' : s?.status === 'failed' ? '失败' : s?.status === 'running' ? '进行中' : '等待'}
                </span>
                <span style={{ color: s ? 'var(--ink)' : 'var(--ink4)' }}>{STEP_LABEL[name] ?? name}</span>
                {/* 「已耗时 881s」对运营是机器单位;门链本来就要跑十几分钟(实景走查 P2-7) */}
                {s && secs > 2 && <span className="kv">已耗时 {secs < 60 ? `${secs} 秒` : `${Math.floor(secs / 60)} 分 ${secs % 60} 秒`}</span>}
              </div>
            );
          })}
          {st.steps.length === 0 && (
            <div className="note warn">
              排队中——发布执行器尚未领取任务。本机开发下需另开一个终端运行执行器;若长时间无响应可取消。
              <button className="btn ghost sm" onClick={cancel}>取消本次发布</button>
            </div>
          )}
          {/* 已开工但执行器可能已经死了:给出口。服务端只在失联满 12 分钟时才放行,理由必填、记审计。 */}
          {st.steps.length > 0 && !forcing && (
            <div className="note" style={{ marginTop: 8 }}>
              执行器没反应了?<button className="btn ghost sm" onClick={cancel}>中止本次发布</button>
              <span className="kv">执行器超过 12 分钟没有动静才允许中止;门链本身要跑约 6 分钟,属正常。</span>
            </div>
          )}
          {forcing && (
            <div className="note bad" style={{ marginTop: 8 }}>
              <b>强制中止 v{active}</b>
              {/* 口径要与列表和审计一致:中止后列表显示「已取消」,这里就不能写「记为失败」(第五轮 P1-7) */}
              {/* JSX 里 `**…**` 就是两个星号,会原样印在界面上;要加重用 <b>(gate-console-copy 守) */}
              <div className="kv">执行器已失联。中止后这一版记为<b>已取消</b>、线上保持不变,可以重新发起。理由会记进审计。</div>
              <div className="kv">⚠️ 中止只在系统里放开这次发布,<b>并不会去停掉那个执行器进程</b>。若它其实还活着,请先把它关掉再重新发起。</div>
              <div className="row" style={{ marginTop: 6, gap: 8 }}>
                <input className="inp" style={{ flex: 1 }} placeholder="中止理由(至少 4 个字)" value={forceReason} onChange={(e) => setForceReason(e.target.value)} />
                <button className="btn" onClick={forceCancel}>确认中止</button>
                <button className="btn ghost" onClick={() => { setForcing(false); setForceReason(''); }}>返回</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 线上快照与系统记录对不上:切换已落盘、回报没送到时会这样,必须让人看见而不是静默 */}
      {st.drift && (
        <div className="note bad">
          <b>线上内容与系统记录对不上</b>
          {st.drift.tampered?.length ? (
            <div className="kv">
              版本号对得上(v{st.drift.dbLive}),但线上这些文件的内容<b>与发布那一刻不一样</b>了:
              <span className="mono"> {st.drift.tampered.join('、')}</span>。
              说明有人绕过发布流程直接改了线上文件。请重新发布一次把线上恢复成系统记录的版本。
              <br />
              (核查范围见下方常驻说明。)
            </div>
          ) : (
            <div className="kv">
              系统记录的线上版本是 v{st.drift.dbLive},而线上实际伺服的快照
              {st.drift.snapshot ? `来自 v${st.drift.snapshot}` : '没有上线标记(可能是首次部署,或被手工替换过)'}。
              多半是上一次发布的切换已经落盘、但回报没送达。
            </div>
          )}
          {/* 🔴 出路必须是**当下真能点的**:草稿零改动时「发布」按钮是灰的,劝人「重新发起」等于没说(第四轮 P1-6)。
              回滚到当前记录的线上版本会走完整门链并重新搬运快照,正好把两边对齐。 */}
          <div className="row" style={{ marginTop: 6, gap: 8 }}>
            <button className="btn" disabled={!!active} onClick={() => setConfirm({ reason: '线上快照与系统记录不一致,重新发布当前线上版本以对齐', rollbackFrom: st.drift!.dbLive })}>
              重新发布 v{st.drift.dbLive} 以对齐
            </button>
            <span className="kv">会走完整门链,门红则线上保持现状。</span>
          </div>
        </div>
      )}

      {/* 🔴 核查范围**常驻**,不是只在报警时才说(第六轮 P1-3:告知写在检出分支里,
          等于「只有已经出事时才告诉你我能查到什么」)。诚实的边界要在平时就看得见。 */}
      <div className="note" style={{ marginBottom: 12 }}>
        <b>线上内容核查的范围</b>
        <div className="kv">
          每次发布会记下<b>全部网页文件</b>的指纹,系统在上线前和每次打开本页时回头核对一遍——
          有人绕过发布流程改了网页,这里会报出来并点名文件。
          <br />
          范围之外:样式表、脚本、图片等资源不逐个核对(它们换内容通常会换文件名、从而带动网页本身变化,
          但<b>直接覆盖同名资源文件</b>这一种查不到)。
        </div>
      </div>

      {/* 上次失败:大白话 + 门名 + 原始日志折叠 */}
      {/* 🔴 判据是「线上之后没有再成功发布过」,不是「失败的那版恰好号最大」(第五轮 P1-5):
          取消一次就会占掉最大号,失败面**整块消失**,而壳顶红条还在指人来这一页看详情。
          与服务端 lastPublishFailed 同口径:失败版本比线上新即显示。 */}
      {!active && lastFailed && lastFailed.id > (st.versions.find((v) => v.status === 'live')?.id ?? 0) && (
        <div className="note bad">
          {(() => {
            const f = splitFailReason(lastFailed.fail_reason ?? '原因未记录');
            return (
              <>
                <b>上次发布失败(v{lastFailed.id}):{f.human}</b>
                {f.tech && <div className="kv mono" style={{ marginTop: 2, wordBreak: 'break-all' }}>{f.tech}</div>}
              </>
            );
          })()}
          <div className="kv" style={{ marginTop: 4 }}>线上仍是上一版,未受影响(线上伺服的是已发布快照,失败的构建产物不会对外);你的草稿改动也原样保留,修好后可再次发布。</div>
          {(() => {
            // 失败态下 steps 来自「最近一次」版本,需确认就是这一版的日志(验收 P1:此前失败态取不到日志)
            const detail = st.stepsOfVersion === lastFailed.id ? st.steps.find((s) => s.status === 'failed')?.detail : null;
            return detail ? (
              <>
                <button className="btn ghost sm" onClick={() => setOpenLog(openLog ? null : 'x')}>{openLog ? '收起' : '查看原始日志'}</button>
                {openLog && <pre className="mono" style={{ fontSize: 11, whiteSpace: 'pre-wrap', marginTop: 6, maxHeight: 220, overflow: 'auto' }}>{detail}</pre>}
              </>
            ) : null;
          })()}
        </div>
      )}

      {/* 本次发布:diff + 前置校验 */}
      {!active && (
        <div className="card" style={{ marginBottom: 12 }}>
          <h3>本次发布 · {pre.changed} 处改动{pre.reasonRequired && <span className="pill warn" style={{ marginLeft: 6 }}>含高敏字段,须填理由</span>}</h3>
          {pre.changed === 0 ? (
            <p className="kv">没有待发布的改动(草稿与线上一致)。</p>
          ) : (
            <table>
              <thead><tr><th>改动位置</th><th>说明</th></tr></thead>
              <tbody>
                {pre.changedPaths.slice(0, 30).map((p) => (
                  <tr key={p}>
                    <td>{humanPath(p)}<div className="kv mono" style={{ fontSize: 11 }}>{p}</div></td>
                    <td>{pre.sensitiveChanged.includes(p) ? <span className="pill warn">高敏</span> : <span className="kv">普通</span>}</td>
                  </tr>
                ))}
                {pre.changedPaths.length > 30 && <tr><td colSpan={2} className="kv">…另有 {pre.changedPaths.length - 30} 处</td></tr>}
              </tbody>
            </table>
          )}
          {pre.errors.length > 0 && (
            <div className="note bad" style={{ marginTop: 10 }}>
              <b>前置校验未通过({pre.errors.length} 项),不会进入发布流程:</b>
              <table><tbody>
                {pre.errors.slice(0, 15).map((e, i) => (
                  <tr key={i}>
                    <td>{RULE_LABEL[e.rule] ?? e.rule}</td>
                    <td>{humanPath(e.path)}<div className="kv mono" style={{ fontSize: 11 }}>{e.path}</div></td>
                    <td>{e.message}</td>
                    {/* 「去修复」带上要定位的字段:目标页据此高亮/滚动到那一处(PRD ⑥「定位到红字段」) */}
                    <td><NavLink className="btn ghost sm" to={`${fixLink(e.path)}?focus=${encodeURIComponent(e.path)}`}>去修复</NavLink></td>
                  </tr>
                ))}
              </tbody></table>
              {pre.errors.length > 15 && <div className="kv">…另有 {pre.errors.length - 15} 项</div>}
            </div>
          )}
          {pre.warnings.length > 0 && (
            <div className="note warn" style={{ marginTop: 8 }}>
              提醒({pre.warnings.length} 项,不阻断发布):{pre.warnings.slice(0, 4).map((w) => `${RULE_LABEL[w.rule] ?? w.rule}(${humanPath(w.path)})`).join(' · ')}
              {pre.warnings.length > 4 && ' …'}
            </div>
          )}
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn primary" disabled={!pre.ready || busy} onClick={() => setConfirm({ reason: '' })}>
              发布(过全部机器门)
            </button>
            <span className="kv">{!pre.ready && (pre.changed === 0 ? '无改动可发布' : '先修完上面的红项')}</span>
          </div>
        </div>
      )}

      {/* 确认弹窗 */}
      {confirm && (
        <div className="card" style={{ marginBottom: 12, outline: '2px solid var(--brand)' }}>
          <h3>{confirm.rollbackFrom ? `确认回滚到 v${confirm.rollbackFrom}?` : `确认发布 ${pre.changed} 处改动?`}</h3>
          <p className="kv">
            {confirm.rollbackFrom
              ? '回滚 = 以该版内容发起一次新发布,同样要过全部机器门(不绕道);成功后线上是一个新版本号,内容与该版一致。'
              : '发布将依次执行:物化配置 → 站上 13 道机器门 → 生产构建 → 原子切换。任一步失败则线上保持旧版。'}
          </p>
          {(pre.reasonRequired || confirm.rollbackFrom) && (
            <div className="field"><label>理由(必填,≥8 字)</label>
              <textarea value={confirm.reason} onChange={(e) => setConfirm({ ...confirm, reason: e.target.value })} placeholder="例:Google Play 过审,开放安卓下载" /></div>
          )}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn ghost" onClick={() => setConfirm(null)}>取消</button>
            <button className="btn primary" disabled={busy} onClick={() => void doPublish(confirm.rollbackFrom)}>{busy ? '发起中…' : '确认'}</button>
          </div>
        </div>
      )}

      {/* 版本历史 */}
      <div className="card">
        <h3>版本历史(只增不删;回滚也走全部机器门)</h3>
        {/* 🔴 截断必须说出来:此前静默只渲染最近 30 条,46 个版本时线上那一行直接消失,
            而标题写着「只增不删」——界面在说一句它自己正在违反的话(实景走查 P1)。 */}
        {st.versionsTruncated && (
          <div className="note info" style={{ marginBottom: 8 }}>
            只显示最近 {st.versions.filter((v) => v.status !== 'live').length + 1} 条(更早的版本仍在,未删除)。当前线上那一版已单独固定显示在列表里。
          </div>
        )}
        <table>
          <thead><tr><th>版本</th><th>时间</th><th>状态</th><th>改动数</th><th>理由 / 失败原因</th><th>操作</th></tr></thead>
          <tbody>
            {st.versions.map((v) => (
              <tr key={v.id}>
                <td className="mono"><b>v{v.id}</b></td>
                <td className="kv">{new Date(v.published_at ?? v.created_at).toLocaleString('zh-CN', { hour12: false })}</td>
                <td><span className={`pill ${v.status === 'live' ? 'brand' : v.status === 'failed' ? 'bad' : ''}`}>{STATUS_LABEL[v.status] ?? v.status}</span></td>
                {/* 改动数:算不出来就留空,不编一个数(PRD ⑤;实景走查 P2-1) */}
                <td className="mono kv">{typeof v.changed === 'number' ? `${v.changed} 处` : '—'}</td>
                <td>
                  {v.fail_reason ? (() => {
                    const f = splitFailReason(v.fail_reason);
                    return (
                      <>
                        {f.human}
                        {/* 门名 / 原始报错留在小字里:历史表是排查入口,信息不能删,但也不该占主视线 */}
                        {f.tech && <div className="kv mono" style={{ wordBreak: 'break-all', maxWidth: 360 }}>{f.raw ? f.tech.slice(0, 160) : `门:${f.tech}`}</div>}
                      </>
                    );
                  })() : v.reason ?? (v.created_by === 'system' ? <span className="kv">初始种子(非发布)</span> : '—')}
                </td>
                <td>
                  {/* 只有**真上线过**的版本能当回滚源(服务端同判据)。此前用「不是 live 也不是 failed」反着写,
                      于是 cancelled 行也长出按钮,点了必 404 —— 界面给的每个按钮都该是能点通的。 */}
                  {v.status === 'archived' && !active && (
                    <button className="btn ghost sm" onClick={() => setConfirm({ reason: '', rollbackFrom: v.id })}>回滚到此版</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
