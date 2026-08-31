/* 发布与版本(CON13 ⑤⑥):diff 摘要 + 前置校验红项(带去修复跳转)+ 确认弹窗(高敏须理由)
   + 流水线四步进度 + 失败面(大白话 + 门名 + 原始日志折叠)+ 版本历史与回滚。
   诚实:门红时明说「线上保持旧版未受影响」;执行器不在线时给排队态与取消出口,不吊死。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { ApiError, api, toast } from '../api';
import { useShell } from '../shell';

interface Finding { path: string; rule: string; message: string }
interface Preflight {
  ready: boolean; errors: Finding[]; warnings: Finding[];
  changedPaths: string[]; changed: number; sensitiveChanged: string[]; reasonRequired: boolean;
}
interface StepRow { step: string; status: string; detail: string | null; started_at: number; ended_at: number | null }
interface VersionRow { id: number; status: string; reason: string | null; fail_reason: string | null; created_by: string; created_at: number; published_at: number | null }
interface Status { activeVersion: number | null; steps: StepRow[]; versions: VersionRow[]; stepNames: string[] }

const STEP_LABEL: Record<string, string> = { materialize: '物化配置(生成三语文案与站点配置)', gates: '站上全部机器门(13 门)', build: '生产构建', swap: '原子切换上新' };
const STATUS_LABEL: Record<string, string> = { live: '线上', archived: '历史', failed: '失败(未上线)', validating: '校验中', publishing: '发布中' };
/** 把校验规则译成人话;缺映射显规则名原文,不隐藏 */
const RULE_LABEL: Record<string, string> = {
  'forbidden-word': '合规禁用词', placeholder: '占位符缺失', untranslated: '缺译', 'unknown-key': '非法 key',
  'missing-key': '缺 key', 'enabled-empty-url': '开启的入口缺 URL', url: '链接格式', email: '邮箱格式',
  'all-hidden': '设备板块全隐藏', 'min-visible': 'FAQ 可见不足 3 条', 'dup-id': 'FAQ id 重复', window: '公告时间窗',
  structure: '数据结构', 'mock-anchor': '统计仍是演示值', 'seo-length': 'SEO 长度', 'pending-assets': '信任资料占位',
  'newline-shape': '换行结构',
};
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

  async function cancel() {
    try { await api('/api/publish/cancel', { method: 'POST' }); toast('已取消'); load(); }
    catch { toast('无法取消:已有步骤开始执行'); }
  }

  if (failed) return <section><h2>发布与版本</h2><div className="note bad">数据获取失败 <button className="btn ghost sm" onClick={load}>重试</button></div></section>;
  if (!pre || !st) return <section><h2>发布与版本</h2><div className="skl" style={{ height: 80 }} /></section>;

  const active = st.activeVersion;
  const lastFailed = st.versions.find((v) => v.status === 'failed');
  const stepDone = (name: string) => st.steps.find((s) => s.step === name);

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
                {s && secs > 2 && <span className="kv">已耗时 {secs}s</span>}
              </div>
            );
          })}
          {st.steps.length === 0 && (
            <div className="note warn">
              排队中——发布执行器尚未领取任务。本机开发下需另开一个终端运行执行器;若长时间无响应可取消。
              <button className="btn ghost sm" onClick={cancel}>取消本次发布</button>
            </div>
          )}
        </div>
      )}

      {/* 上次失败:大白话 + 门名 + 原始日志折叠 */}
      {!active && lastFailed && lastFailed.id === Math.max(...st.versions.map((v) => v.id)) && (
        <div className="note bad">
          <b>上次发布失败(v{lastFailed.id}):{lastFailed.fail_reason ?? '原因未记录'}</b>
          <div className="kv" style={{ marginTop: 4 }}>线上仍是上一版,未受影响;你的草稿改动也原样保留,修好后可再次发布。</div>
          {(() => {
            const detail = st.steps.find((s) => s.status === 'failed')?.detail;
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
                    <td className="mono" style={{ fontSize: 11.5 }}>{p}</td>
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
                    <td className="mono" style={{ fontSize: 11.5 }}>{e.path}</td>
                    <td>{e.message}</td>
                    <td><NavLink className="btn ghost sm" to={fixLink(e.path)}>去修复</NavLink></td>
                  </tr>
                ))}
              </tbody></table>
              {pre.errors.length > 15 && <div className="kv">…另有 {pre.errors.length - 15} 项</div>}
            </div>
          )}
          {pre.warnings.length > 0 && (
            <div className="note warn" style={{ marginTop: 8 }}>
              提醒({pre.warnings.length} 项,不阻断发布):{pre.warnings.slice(0, 4).map((w) => `${RULE_LABEL[w.rule] ?? w.rule}@${w.path}`).join(' · ')}
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
        <table>
          <thead><tr><th>版本</th><th>时间</th><th>状态</th><th>理由 / 失败原因</th><th></th></tr></thead>
          <tbody>
            {st.versions.map((v) => (
              <tr key={v.id}>
                <td className="mono"><b>v{v.id}</b></td>
                <td className="kv">{new Date(v.published_at ?? v.created_at).toLocaleString('zh-CN', { hour12: false })}</td>
                <td><span className={`pill ${v.status === 'live' ? 'brand' : v.status === 'failed' ? 'bad' : ''}`}>{STATUS_LABEL[v.status] ?? v.status}</span></td>
                <td>{v.fail_reason ?? v.reason ?? (v.created_by === 'system' ? <span className="kv">初始种子(非发布)</span> : '—')}</td>
                <td>
                  {v.status !== 'live' && v.status !== 'failed' && !active && (
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
