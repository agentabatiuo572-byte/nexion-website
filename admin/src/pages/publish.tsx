/* 发布与版本(CON13 ⑤⑥):diff 摘要 + 前置校验红项(带去修复跳转)+ 确认弹窗(高敏须理由)
   + 流水线四步进度 + 失败面(大白话 + 门名 + 原始日志折叠)+ 版本历史与回滚。
   检查失败保留旧版；服务未就绪在提交前明示，切换不确定时暂停后续发布。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { ApiError, api, apiErrorHint, toast } from '../api';
import { splitFailReason } from '../lib/fail-reason';
import { changeGroup, humanPath } from '../lib/human-path';
import { fieldEditorLink } from '../lib/field-target';
import { publishRequestBody, type PublishConfirmation } from '../lib/publish-contract';
import { decodePublishProgress, groupPublishChecks, publishFailureAdvice, type PublishCheck } from '../../../schema/src/publish-feedback';
import { DefaultTranslationActions, useTranslations } from '../lib/translations';
import { useShell } from '../shell';

interface Finding { path: string; rule: string; message: string }
interface Preflight {
  ready: boolean; errors: Finding[]; warnings: Finding[];
  message?: string;
  changedPaths: string[]; changed: number; sensitiveChanged: string[]; reasonRequired: boolean;
  /** 确认页看到的草稿身份；普通发布必须把同一个 revision 带回服务端。 */
  draftRev: number;
}
interface StepRow { step: string; status: string; detail: string | null; started_at: number; ended_at: number | null }
interface VersionRow { id: number; status: string; reason: string | null; fail_reason: string | null; created_by: string; created_at: number; published_at: number | null; changed?: number }
interface Status {
  activeVersion: number | null; stepsOfVersion: number | null; steps: StepRow[]; versions: VersionRow[]; stepNames: string[];
  /** 检查明细(进度窗数据源)，与 steps 同属 checksOfVersion 标明的版本；缺席时沿用旧 steps 窗。 */
  checksOfVersion?: number | null; checks?: PublishCheck[];
  /** 线上快照对不上:版本号不符,或版本号对但内容被直接改过(tampered 列出对不上的文件) */
  drift: { dbLive: number; snapshot: number | null; tampered?: string[] } | null;
  /** 版本列表被截断了(只回最近若干条)——界面必须说出来,别让人以为这就是全部 */
  versionsTruncated?: boolean;
  /** 服务端直接告诉界面能不能取消:none 无进行中 · yes 排队态可取消 · force 需失联+理由 · no 执行器仍在工作 */
  cancelable?: 'none' | 'yes' | 'force' | 'no';
  silentMs?: number;
  executor: {mode:string;ready:boolean;reason:string;lastSeenAt:number|null};
}

const STEP_LABEL: Record<string, string> = { materialize: '准备文案与站点配置', gates: '构建并检查官网', build: '构建后台并组装发布包', swap: '切换新版并核验' };
/** 检查明细状态徽中文；未知状态兜底显“未知”，不直出英文枚举。 */
const CHECK_STATUS_LABEL: Record<string, string> = { running: '进行中', ok: '通过', failed: '失败', skipped: '跳过', unknown: '未知' };
const STATUS_LABEL: Record<string, string> = { live: '线上', archived: '历史', failed: '失败(未上线)', cancelled: '已取消', validating: '等待自动执行', publishing: '发布中', unknown: '切换结果待核实' };
const CHECK_TITLE_LABEL: Record<string, string> = {
  'forbidden-words': '合规禁用词检查', 'i18n-parity': '多语言完整性检查', 'deploy-gate': '发布占位标记检查',
  'launch-assets': '上线资产检查', 'state-hook-consumer': '页面状态检查', 'anchor-check': '页面锚点检查',
  'brand-parity': '品牌一致性检查', 'particle-hue': '背景色调检查', 'canvas-hazard': '画布单位检查',
  'css-shadowed': '样式有效性检查', 'canvas-geometry': '画布几何检查', 'render-fit': '页面布局检查',
  'deck-clearance': '设备叠卡检查', 'config-consistency': '配置一致性检查', 'console-copy': '后台文案检查',
  'regex-escape': '转义检查', 'site-behavior': '内容与交互检查', 'xbtn': '按钮状态检查',
  /* verify runGate 检查标题（中文操作名，直出即中文；归一化剥括号后查表译成规范名） */
  '网站内容与交互': '内容与交互检查', 'CSS 声明': '样式有效性检查', '画布几何': '画布几何检查',
  '各语言与屏幕尺寸的页面布局': '页面布局检查', '设备叠卡布局': '设备叠卡检查', '按钮轮廓与状态回归': '按钮状态检查',
  'artifact-unchanged': '产物一致性检查', 'gate-self-tests': '检查程序自测',
  /* runner-gates suites（verify 子进程门外、隔离副本里跑的前置门）：标题原文直出即英文，逐项译成人话。
     增量跳过（-自检/-红测后缀）与 typecheck:<包> 按归一化查表，缺映射显原文。 */
  'jsonc-reader': '配置读取检查', 'exit-finally': '中断收尾检查', 'beacon-size': '上报体积检查',
  'worker-AI-runtime': '后台智能运行检查', 'worker': '后台检查', 'publisher': '发布器回归检查',
  'worker-types': '后台类型检查', 'site-build': '官网构建', 'source-equivalence': '源码基线检查',
  'publish-config': '发布配置检查', 'publish-materialization': '配置物化检查', 'verify-process': '检查进程',
  'verify': '官网内容检查', 'verify-not-run': '官网检查未执行',
};
/* 检查门标题归一化：剥执行口径后缀 → 剥 -自检/-红测/-单测/-故障回归 → 取冒号前 → 查表。
   缺映射显原文（不隐藏），由直出扫描单测守新增英文。 */
export const normalizeCheckTitle = (raw: string): string => {
  const noScope = raw.replace(/\(.*?\)/g, '').replace(/-(自检|红测|单测|故障回归)$/, '').trim();
  const base = noScope.split(':')[0].trim();
  if (base === 'typecheck') return '类型检查';
  return CHECK_TITLE_LABEL[base] ?? (raw.startsWith('检查程序自测') ? '检查程序自测' : raw);
};
/** 把校验规则译成人话;缺映射显规则名原文,不隐藏 */
const RULE_LABEL: Record<string, string> = {
  'forbidden-word': '合规禁用词', placeholder: '占位符缺失', untranslated: '缺译', 'unknown-key': '非法 key',
  'missing-key': '缺 key', 'enabled-empty-url': '开启的入口缺 URL', url: '链接格式', email: '邮箱格式',
  'all-hidden': '设备板块全隐藏', 'min-visible': 'FAQ 可见不足 3 条', 'dup-id': 'FAQ id 重复', window: '公告时间窗',
  structure: '数据结构', 'seo-length': 'SEO 长度', 'pending-assets': '信任资料占位',
  'newline-shape': '换行结构', 'encoding-damage': '编码损坏字符',
  'growth-noop': '自动增长没配增量', 'growth-future': '自动增长起算日在未来', 'growth-too-fast': '自动增长过快',
};
// 本表必须与 schema/src/validators.ts 的规则集**双向**相等 —— 由 gate-config-consistency 断言。
// (曾出现凭空多一个 'all-hidden-sku':校验器从不产出,纯死键;真正的键叫 'all-hidden'。)
/** 红项 → 该去哪个页面修 */

export default function PublishPage() {
  const { reload: reloadShell } = useShell();
  const { data: translations } = useTranslations();
  const [pre, setPre] = useState<Preflight | null>(null);
  const [st, setSt] = useState<Status | null>(null);
  const [failed, setFailed] = useState(false);
  const [pollFailed, setPollFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<PublishConfirmation | null>(null);
  const [forcing, setForcing] = useState(false);
  const [forceReason, setForceReason] = useState('');
  const [openLog, setOpenLog] = useState<string | null>(null);
  const [showAllErrors, setShowAllErrors] = useState(false);
  const [showAllWarnings, setShowAllWarnings] = useState(false);
  const timer = useRef<number | null>(null);

  const load = useCallback(() => {
    Promise.all([api<Preflight>('/api/publish/preflight'), api<Status>('/api/publish/status')])
      .then(([p, s]) => { setPre(p); setSt(s); setFailed(false); setPollFailed(false); })
      .catch(() => setFailed(true));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    if (translations && pre && translations.draftRev > pre.draftRev) load();
  }, [translations?.draftRev, pre?.draftRev, load]);

  // 发布时每2秒更新，空闲时每5秒更新服务就绪状态；结束刷新壳和前置检查。
  useEffect(() => {
    let stopped = false;
    if (st) {
      const poll = () => {
        api<Status>('/api/publish/status').then((s) => {
          if (stopped) return;
          setPollFailed(false);
          setSt(s);
          if ((st.activeVersion && !s.activeVersion) || (!st.executor.ready && s.executor.ready)) { load(); reloadShell(); }
        }).catch(() => {
          if (stopped) return;
          setPollFailed(true);
          timer.current = window.setTimeout(poll, st.activeVersion ? 2000 : 5000);
        });
      };
      timer.current = window.setTimeout(poll, st.activeVersion ? 2000 : 5000);
    }
    return () => { stopped = true; if (timer.current) window.clearTimeout(timer.current); };
  }, [st, load, reloadShell]);

  async function doPublish() {
    if (!confirm) return;
    setBusy(true);
    try {
      await api('/api/publish', { method: 'POST', body: JSON.stringify(publishRequestBody(confirm)) });
      toast(confirm.rollbackFrom ? '回滚已发起,同样要过全部机器门' : '发布已发起');
      setConfirm(null);
      load();
    } catch (e) {
      const err = e instanceof ApiError ? String(e.body.error ?? '') : '';
      if (e instanceof ApiError && e.status === 409 && err === 'draft-changed') {
        setConfirm(null);
        toast('草稿在确认后发生了变化；已刷新检查，请重新核对并确认');
        load();
        return;
      }
      const serviceMessage = e instanceof ApiError && ['executor-unavailable', 'config-upgrade-conflict', 'config-upgrade-retry'].includes(err)
        ? String(e.body.message ?? e.body.hint ?? '配置升级尚未完成，请刷新查看具体原因') : null;
      toast(serviceMessage ?? (err.includes('reason') ? '需要填写理由(≥8 字)' : err.includes('in-progress') ? '已有发布正在进行或等待核实' : err.includes('preflight') ? '前置校验未通过' : '发起失败,请重试'));
    } finally { setBusy(false); }
  }

  async function recheckAndConfirm() {
    setBusy(true);
    setConfirm(null);
    try {
      const [p, s] = await Promise.all([api<Preflight>('/api/publish/preflight'), api<Status>('/api/publish/status')]);
      setPre(p); setSt(s);
      if (p.ready && !s.activeVersion && s.executor.ready && !s.versions.some(v => v.status === 'unknown')) {
        setConfirm({ reason: '', draftRev: p.draftRev });
      } else toast('检查结果已刷新，请先处理当前问题或等待发布服务恢复');
    } catch { toast('检查结果暂时无法刷新，请稍后重试'); }
    finally { setBusy(false); }
  }

  /* 取消两档:排队态直接取消;已开工则要执行器失联满 12 分钟 + 写明理由才允许强制中止。
     🔴 上一轮只做了服务端、界面上没有入口,运营遇到执行器崩掉时依旧只能干等锁超时(复验 P1-2)。 */
  /* 能不能取消由服务端在 /status 里直说,界面不再靠**发一个注定失败的请求**去试探——
     那种试探行为正确,但正常操作路径每次都会在浏览器控制台留一条红(实景走查 P2-10)。 */
  async function cancel() {
    if (st?.cancelable === 'force') { setForcing(true); return; }
    if (st?.cancelable === 'no') {
      toast('本次发布尚未满足安全中止条件，请等待状态核实后再试');
      return;
    }
    try {
      await api('/api/publish/cancel', { method: 'POST', body: JSON.stringify({}) });
      toast('已取消'); load();
    } catch (e) {
      toast(apiErrorHint(e, '无法取消,请刷新后重试'));
    }
  }
  async function forceCancel() {
    if (forceReason.trim().length < 4) { toast('请写明中止理由(至少 4 个字)'); return; }
    try {
      await api('/api/publish/cancel', { method: 'POST', body: JSON.stringify({ force: true, reason: forceReason.trim() }) });
      toast('已强制中止,可以重新发起'); setForcing(false); setForceReason(''); load();
    } catch (e) {
      toast(apiErrorHint(e, '仍无法中止(执行器可能又有动静了)'));
    }
  }

  if (failed && (!pre || !st)) return <section><h2>发布与版本</h2><div className="note bad">数据获取失败 <button className="btn ghost sm" onClick={load}>重试</button></div></section>;
  if (!pre || !st) return <section><h2>发布与版本</h2><div className="skl" style={{ height: 80 }} /></section>;

  const active = st.activeVersion;
  // 当前任务心跳与输出更新时间不同；安静的长检查仍会续租。
  const taskDisconnected = !!active && !pollFailed && st.stepsOfVersion === active && st.steps.length > 0
    && typeof st.silentMs === 'number' && Number.isFinite(st.silentMs) && st.silentMs >= 60_000;
  const lastFailed = st.versions.find((v) => v.status === 'failed');
  const unknown = st.versions.some((v) => v.status === 'unknown');
  const showFailure = !active && lastFailed && lastFailed.id > (st.versions.find(v => v.status === 'live')?.id ?? 0);
  const failedStep = st.stepsOfVersion === lastFailed?.id ? st.steps.find(s => s.status === 'failed') : undefined;
  const failureAdvice = publishFailureAdvice([lastFailed?.fail_reason, failedStep?.detail].filter(Boolean).join('\n'));
  const changedGroups = new Map<string, string[]>();
  for (const path of pre.changedPaths) {
    const group = changeGroup(path);
    if (!changedGroups.has(group)) changedGroups.set(group, []);
    changedGroups.get(group)!.push(path);
  }
  // 步骤只认「本次进行中版本」的日志,防把上一次的步骤画进这一次(stepsOfVersion 由服务端标明)
  const stepDone = (name: string) => (st.stepsOfVersion === active ? st.steps.find((s) => s.step === name) : undefined);
  const activeStarts = active ? st.steps.filter((s) => s.started_at > 0).map((s) => s.started_at) : [];
  // 检查明细只认与 steps 同版本的落库行；checks 为空不覆盖旧 steps 窗（向后兼容）。
  const statusChecks = st.checksOfVersion === st.stepsOfVersion ? st.checks ?? [] : [];
  const checkGroups = statusChecks.length
    ? groupPublishChecks(statusChecks, st.stepNames.length ? st.stepNames : ['materialize', 'gates', 'build', 'swap'])
    : [];
  const failedChecks = checkGroups.flatMap((group) => group.items.filter((item) => item.status === 'failed'));
  /* 进度按收口后计数：groupPublishChecks 已按 (step,title) 留最新 seq，running+ok 双行不虚高。 */
  const coalescedChecks = checkGroups.flatMap((group) => group.items);
  const doneChecks = coalescedChecks.filter((item) => item.status === 'ok').length;
  const activeElapsed = activeStarts.length ? Math.max(0, Math.round((Date.now() - Math.min(...activeStarts)) / 1000)) : 0;
  return (
    <section className="editor-page">
      <header className="page-heading">
        <span className="eyebrow">网站发布</span>
        <h2>发布与版本</h2>
        <p className="page-description">核对已保存的草稿，让修改在官网生效。发布前自动检查，历史版本可随时查看。</p>
      </header>
      <ol className="publish-steps" aria-label="发布流水线进度">
        {(st.stepNames.length ? st.stepNames : ['materialize', 'gates', 'build', 'swap']).map((name, i) => {
          const s = active ? stepDone(name) : undefined;
          const state = !active ? 'idle' : s?.status === 'ok' ? 'done' : s?.status === 'failed' ? 'failed' : s?.status === 'running' ? 'doing' : 'todo';
          const stateWord = !active ? '空闲' : s?.status === 'ok' ? '完成' : s?.status === 'failed' ? '失败' : s?.status === 'running' ? '进行中' : '未开始';
          return (
            <li key={name} data-state={state} aria-label={`${STEP_LABEL[name] ?? name}：${stateWord}`}>
              <span>{String(i + 1).padStart(2, '0')}</span>
              <div><b>{STEP_LABEL[name] ?? name}</b></div>
            </li>
          );
        })}
      </ol>
      {pollFailed && <div className="note warn" role="status">暂时无法刷新发布状态，正在自动重试。恢复连接后将核实执行结果。</div>}
      {failed && <div className="note warn" role="status">发布检查信息暂时无法刷新，已保留上次结果。<button className="btn ghost sm" onClick={load}>重试</button></div>}
      {unknown ? <div className="note warn" role="status">切换结果正在核实，核实前暂停新发布。草稿已保留。</div>
        : !active && !st.executor.ready && <div className="note warn" role="status">{st.executor.reason}</div>}

      {showFailure && <div className="note bad" role="alert" style={{ marginBottom: 12 }}>
        <h3>v{lastFailed.id} 发布已停止</h3>
        <p>{failedStep && `${STEP_LABEL[failedStep.step] ?? failedStep.step}：`}{failureAdvice.reason}</p>
        <p>本次任务已停止，不会继续执行后续步骤。</p>
        <p>{failureAdvice.suggestion}</p>
        <p className="kv">草稿改动已保留。{failedStep && failedStep.step !== 'swap' && !st.drift && !unknown
          ? '未切换新版，官网保留原先版本。' : '线上状态以当前核验结果为准。'}当前能否发布以下方检查为准。</p>
        <button className="btn" disabled={busy || unknown || !st.executor.ready} onClick={() => void recheckAndConfirm()}>重新检查并发布</button>
        <details className="inline-help"><summary>查看失败技术详情</summary>
          <pre className="kv mono" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 220, overflow: 'auto' }}>{failureAdvice.raw || '原因未记录'}</pre>
        </details>
        {failedStep?.detail && <>
          <button className="btn ghost sm" onClick={() => setOpenLog(openLog ? null : 'failure')}>{openLog ? '收起' : '查看原始日志'}</button>
          {openLog && <pre className="mono" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 220, overflow: 'auto' }}>{failedStep.detail}</pre>}
        </>}
      </div>}

      {/* 进行中:四步进度 */}
      {active && (
        <div className="card" style={{ marginBottom: 12 }}>
          <h3>{taskDisconnected || pollFailed ? '发布状态待核实' : '正在发布'} v{active}</h3>
          {taskDisconnected && <div className="note warn" role="status">
            <p>本次执行器已超过 1 分钟未报告心跳，发布结果待核实。</p>
            <p>系统会继续刷新状态。请等待确认停止后再重新检查并发布，最后收到的检查内容保留在下方。</p>
            <button className="btn ghost sm" onClick={load}>刷新状态</button>
          </div>}
          {checkGroups.length ? (
            <div style={{ background: '#0c1912', border: '1px solid #314239', borderRadius: 8, padding: '12px 14px', marginTop: 8 }} role="region" aria-label="检查明细">
              <p className="kv" style={{ color: '#e4ece6' }}>已通过 {doneChecks} / {coalescedChecks.length} 项检查</p>
              <div role="progressbar" aria-label="检查完成进度" aria-valuemin={0} aria-valuemax={coalescedChecks.length} aria-valuenow={doneChecks} style={{ height: 6, background: '#405147', borderRadius: 5, marginTop: 8, overflow: 'hidden' }}>
                <span style={{ display: 'block', height: '100%', width: `${coalescedChecks.length ? Math.round((doneChecks / coalescedChecks.length) * 100) : 0}%`, background: '#9edc1d', borderRadius: 5 }} />
              </div>
              {activeElapsed > 2 && <p className="kv" style={{ color: '#9eafa3' }}>本次已用 {activeElapsed < 60 ? `${activeElapsed} 秒` : `${Math.floor(activeElapsed / 60)} 分 ${activeElapsed % 60} 秒`}</p>}
              {checkGroups.map((group) => (
                <section key={group.step} style={{ marginTop: 12 }} aria-label={`${STEP_LABEL[group.step] ?? '检查分组'}`}>
                  <h4 style={{ color: '#e4ece6', fontSize: 'var(--text-sm)', margin: '0 0 6px' }}>{STEP_LABEL[group.step] ?? '检查分组'} · {group.items.filter((item) => item.status === 'ok').length}/{group.items.length} 通过</h4>
                  {group.items.map((item) => (
                    <div className="row" key={item.seq} style={{ padding: '6px 0', borderTop: '1px solid #314239' }}>
                      <span className={`pill ${item.status === 'ok' ? 'ok' : item.status === 'failed' ? 'bad' : item.status === 'running' ? 'warn' : ''}`} style={{ minWidth: '3.625rem', textAlign: 'center' }}>
                        {CHECK_STATUS_LABEL[item.status] ?? '未知'}
                      </span>
                      <div style={{ color: '#e4ece6', minWidth: 0, flex: 1 }}>
                        {normalizeCheckTitle(item.title)}
                        {item.status === 'failed' && item.output && <details style={{ marginTop: 4 }}>
                          <summary style={{ cursor: 'pointer' }}>查看原文</summary>
                          <pre className="mono" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 220, overflow: 'auto', margin: '6px 0', fontSize: 'var(--text-sm)' }}>{item.output}</pre>
                        </details>}
                      </div>
                    </div>
                  ))}
                </section>
              ))}
              {failedChecks.length > 0 && <div className="row" style={{ marginTop: 8 }}>
                <span className="kv" style={{ color: '#ef8077' }}>有 {failedChecks.length} 项检查未通过，本次任务停止后可在下方重新发布。</span>
                <button className="btn ghost sm" disabled={busy || unknown || !st.executor.ready} onClick={() => void recheckAndConfirm()}>重新发布</button>
              </div>}
            </div>
          ) : (
          <>
          <p className="kv">已完成 {st.stepNames.filter(name => stepDone(name)?.status === 'ok').length} / {st.stepNames.length} 个步骤</p>
          {activeElapsed > 2 && <p className="kv">本次已用 {activeElapsed < 60 ? `${activeElapsed} 秒` : `${Math.floor(activeElapsed / 60)} 分 ${activeElapsed % 60} 秒`}</p>}
          {st.stepNames.map((name) => {
            const s = stepDone(name);
            const progress = decodePublishProgress(s?.detail);
            const cls = s?.status === 'ok' ? 'ok' : s?.status === 'failed' ? 'bad' : s?.status === 'running' ? 'warn' : '';
            const secs = s?.started_at ? Math.round(((s.ended_at ?? Date.now()) - s.started_at) / 1000) : 0;
            return (
              <div className="row" key={name} style={{ padding: '6px 0' }}>
                <span className={`pill ${cls}`} style={{ minWidth: '3.625rem', textAlign: 'center' }}>
                  {s?.status === 'ok' ? '完成' : s?.status === 'failed' ? '失败' : s?.status === 'running' ? taskDisconnected || pollFailed ? '待核实' : '进行中' : '等待'}
                </span>
                <div style={{ color: s ? 'var(--ink)' : 'var(--ink4)', minWidth: 0, flex: 1 }}>
                  {STEP_LABEL[name] ?? name}
                  {s?.status === 'running' && s.detail && <span className="kv" style={{ display: 'block', overflowWrap: 'anywhere' }}>{progress?.title ?? s.detail}</span>}
                  {s?.status === 'running' && progress && <>
                    <span className="kv" style={{ display: 'block' }}>最后更新：<time dateTime={progress.updatedAt}>{new Date(progress.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}</time></span>
                    {progress.output && <pre className="mono" tabIndex={0} role="region" aria-label="当前检查最近输出" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 220, overflow: 'auto', margin: '6px 0', fontSize: 'var(--text-sm)' }}>{progress.output}</pre>}
                  </>}
                </div>
                {/* 「已耗时 881s」对运营是机器单位;门链本来就要跑十几分钟(实景走查 P2-7) */}
                {s && secs > 2 && <span className="kv">已耗时 {secs < 60 ? `${secs} 秒` : `${Math.floor(secs / 60)} 分 ${secs % 60} 秒`}</span>}
              </div>
            );
          })}
          {st.steps.length > 0 && (
            <div className="note" role="status">
              检查明细稍后出现。门级检查开始后，这里会按分组列出每一项结果。
              <button className="btn ghost sm" onClick={load}>重新加载明细</button>
            </div>
          )}
          </>
          )}
          {st.steps.length === 0 && (
            <div className="note warn">
              已提交，系统正在自动安排发布。接单后会依次执行全部检查；关闭本页不会中断发布。
              <button className="btn ghost sm" onClick={cancel}>取消本次发布</button>
            </div>
          )}
          {/* 已开工但执行器可能已经死了:给出口。服务端只在失联满 12 分钟时才放行,理由必填、记审计。 */}
          {st.steps.length > 0 && !forcing && (
            <div className="note" style={{ marginTop: 8 }}>
              执行器没反应了?<button className="btn ghost sm" onClick={cancel}>中止本次发布</button>
              {!pollFailed && !taskDisconnected && <span className="kv">服务持续报告运行状态；检查可能需要数分钟。</span>}
            </div>
          )}
          {forcing && (
            <div className="note bad" style={{ marginTop: 8 }}>
              <b>强制中止 v{active}</b>
              {/* 口径要与列表和审计一致:中止后列表显示「已取消」,这里就不能写「记为失败」(第五轮 P1-7) */}
              {/* JSX 里 `**…**` 就是两个星号,会原样印在界面上;要加重用 <b>(gate-console-copy 守) */}
              <div className="kv">执行器已失联。中止后这一版记为<b>已取消</b>、线上保持不变,可以重新发起。理由会记进审计。</div>
              <div className="kv">中止后系统会撤销本次执行权限；发布服务确认权限失效后停止操作。</div>
              <div className="row" style={{ marginTop: 6, gap: 8 }}>
                <input aria-label="中止理由（至少 4 个字）" className="inp" style={{ flex: 1 }} placeholder="中止理由(至少 4 个字)" value={forceReason} onChange={(e) => setForceReason(e.target.value)} />
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
            <button className="btn" disabled={!!active || unknown || !st.executor.ready} onClick={() => setConfirm({ reason: '线上快照与系统记录不一致,重新发布当前线上版本以对齐', rollbackFrom: st.drift!.dbLive })}>
              重新发布 v{st.drift.dbLive} 以对齐
            </button>
            <span className="kv">会走完整门链,门红则线上保持现状。</span>
          </div>
        </div>
      )}

      {/* 🔴 核查范围**常驻**,不是只在报警时才说(第六轮 P1-3:告知写在检出分支里,
          等于「只有已经出事时才告诉你我能查到什么」)。诚实的边界要在平时就看得见。 */}
      <details className="note info" style={{ marginBottom: 12 }}>
        <summary>线上内容核查范围：全部网页文件</summary>
        <p className="kv">发布时记录网页指纹，上线前及打开本页时再次比对。样式、脚本和图片不逐个回读，直接覆盖同名资源无法检出。</p>
      </details>

      {/* 本次发布:diff + 前置校验 */}
      {!active && (
        <div className="card" style={{ marginBottom: 12 }}>
          <h3>{pre.message ? '发布前检查' : `本次发布 · ${pre.changed} 处改动`}{pre.reasonRequired && <span className="pill warn" style={{ marginLeft: 6 }}>含高敏字段,须填理由</span>}</h3>
          {pre.message ? <p className="kv">{pre.message} 配置兼容准备完成后显示改动摘要。</p> : pre.changed === 0 ? (
            <p className="kv">没有待发布的改动(草稿与线上一致)。</p>
          ) : (
            [...changedGroups].map(([group, paths]) => <details key={group} style={{ marginTop: 8 }}>
              <summary>{group} · {paths.length} 处</summary>
              <div className="table-scroll" tabIndex={0} role="region" aria-label={`${group}发布改动，可左右滚动`}><table>
              <thead><tr><th>改动位置</th><th>说明</th></tr></thead>
              <tbody>
                {paths.map((p) => (
                  <tr key={p}>
                    <td>{humanPath(p)}<div className="kv mono" style={{ fontSize: 'var(--text-sm)' }}>{p}</div></td>
                    <td>{pre.sensitiveChanged.includes(p) ? <span className="pill warn">高敏</span> : <span className="kv">普通</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table></div></details>)
          )}
          {pre.errors.length > 0 && (
            <div className="note bad" style={{ marginTop: 10 }}>
              <b>前置校验未通过({pre.errors.length} 项),不会进入发布流程:</b>
              <div className="table-scroll" tabIndex={0} role="region" aria-label="待修复问题，可左右滚动"><table><tbody>
                {(showAllErrors ? pre.errors : pre.errors.slice(0, 15)).map((e, i) => (
                  <tr key={i}>
                    <td>{RULE_LABEL[e.rule] ?? e.rule}</td>
                    <td>{humanPath(e.path)}<div className="kv mono" style={{ fontSize: 'var(--text-sm)' }}>{e.path}</div></td>
                    <td>{e.message}</td>
                    {/* 「去修复」带上要定位的字段:目标页据此高亮/滚动到那一处(PRD ⑥「定位到红字段」) */}
                    <td>{['structure', 'unknown-key', 'missing-key'].includes(e.rule)
                      ? <span className="kv">需要发布服务完成配置兼容处理；持续出现时查看服务日志。</span>
                      : <NavLink className="btn ghost sm" to={fieldEditorLink(e.path)}>去修复</NavLink>}</td>
                  </tr>
                ))}
              </tbody></table></div>
              {/* 所有问题都可展开；只有可编辑内容提供字段定位。 */}
              {pre.errors.length > 15 && (
                <button className="btn ghost sm" style={{ marginTop: 6 }} onClick={() => setShowAllErrors((v) => !v)}>
                  {showAllErrors ? '只看前 15 项' : `展开全部 ${pre.errors.length} 项`}
                </button>
              )}
            </div>
          )}
          {pre.errors.some(e => ['untranslated', 'translation-stale'].includes(e.rule)) && <DefaultTranslationActions disabled={busy || unknown} onChanged={async () => { load(); await reloadShell(); }} />}
          {pre.warnings.length > 0 && (() => {
            /* 🔴 按**规则**归并,而不是取前四条(2026-09-01 第十轮独立验收 P2-1):
               上一版四个位置被**同一条规则**重复占满(实录:四次「SEO 长度(SEO · 英文 · 首页 · 标题)」),
               另外 15 条可能是完全不同的问题,一条都看不到、也没有展开入口。
               归并后每种问题至少露一次脸,数量写在括号里,再给展开看全部。 */
            const byRule = new Map<string, string[]>();
            for (const w of pre.warnings) {
              const key = RULE_LABEL[w.rule] ?? w.rule;
              byRule.set(key, [...(byRule.get(key) ?? []), humanPath(w.path)]);
            }
            return (
              <div className="note warn" style={{ marginTop: 8 }}>
                <b>提醒({pre.warnings.length} 项,不阻断发布)</b>
                {[...byRule].map(([rule, paths]) => (
                  <div key={rule} style={{ marginTop: 4 }}>
                    {rule}({paths.length} 处):
                    <span className="kv"> {(showAllWarnings ? paths : paths.slice(0, 3)).join(' · ')}{!showAllWarnings && paths.length > 3 ? ` …另 ${paths.length - 3} 处` : ''}</span>
                  </div>
                ))}
                {pre.warnings.length > byRule.size && (
                  <button className="btn ghost sm" style={{ marginTop: 6 }} onClick={() => setShowAllWarnings((v) => !v)}>
                    {showAllWarnings ? '收起' : '展开全部位置'}
                  </button>
                )}
              </div>
            );
          })()}
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn primary" disabled={!pre.ready || busy || !st.executor.ready || st.versions.some(v=>v.status==='unknown')} onClick={() => setConfirm({ reason: '', draftRev: pre.draftRev })}>
              检查并发布
            </button>
            <span className="kv">{!pre.ready && (pre.errors.length ? '处理上方问题后再发布' : '无改动可发布')}</span>
          </div>
        </div>
      )}

      {/* 确认弹窗 */}
      {confirm && (
        <div className="card" style={{ marginBottom: 12, outline: '2px solid var(--brand)' }}>
          <h3>{confirm.rollbackFrom ? `确认回滚到 v${confirm.rollbackFrom}?` : `确认发布 ${pre.changed} 处改动?`}</h3>
          <p className="kv">
            {confirm.rollbackFrom
              ? '回滚会按当前网站结构恢复该版内容，并发起一次新发布、执行全部检查。旧版格式会自动转换；已修改内容存在兼容冲突时会停止并提示。成功后生成新版本号。'
              : '确认后系统锁定本次草稿，构建官网并执行全部检查，再组装后台、切换和核验。检查失败时保留旧版。'}
          </p>
          {(pre.reasonRequired || confirm.rollbackFrom) && (
            <div className="field"><label htmlFor="publish-reason">理由（必填，至少 8 字）</label>
              <textarea id="publish-reason" value={confirm.reason} onChange={(e) => setConfirm({ ...confirm, reason: e.target.value })} placeholder="例:Google Play 过审,开放安卓下载" /></div>
          )}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn ghost" onClick={() => setConfirm(null)}>取消</button>
            <button className="btn primary" disabled={busy} onClick={() => void doPublish()}>{busy ? '发起中…' : '确认'}</button>
          </div>
        </div>
      )}

      {/* 版本历史 */}
      <div className="card">
        <h3>版本历史</h3>
        <p className="kv">版本记录只增不删。回滚会重新执行全部发布检查，成功后生成一个新版本。</p>
        {/* 号会跳空:并发发布拿不到锁时,那个刚建的号会被撤销(不留半个版本行,
            也就不会造出清不掉的假红条)。但从运营那边看,一张写着「只增不删」的表里
            少了个号而界面一句话不说,只会让人以为丢了东西(第十轮 P2-17)。 */}
        {(() => {
          const ids = st.versions.map((v) => v.id).sort((a, b) => a - b);
          const gaps = ids.length > 1 && ids[ids.length - 1] - ids[0] + 1 > ids.length;
          return gaps && !st.versionsTruncated ? (
            <p className="kv" style={{ margin: '0 0 8px' }}>
              版本号中间的空号是正常的:同时有人在发布时,后发起的那次会连号一起撤销(审计里记作「发布被拒」),不会留下半个版本。
            </p>
          ) : null;
        })()}
        {/* 🔴 截断必须说出来:此前静默只渲染最近 30 条,46 个版本时线上那一行直接消失,
            而标题写着「只增不删」——界面在说一句它自己正在违反的话(实景走查 P1)。 */}
        {st.versionsTruncated && (
          <div className="note info" style={{ marginBottom: 8 }}>
            只显示最近 {st.versions.filter((v) => v.status !== 'live').length + 1} 条(更早的版本仍在,未删除)。当前线上那一版已单独固定显示在列表里。
          </div>
        )}
        <div className="table-scroll" tabIndex={0} role="region" aria-label="版本历史，可左右滚动"><table>
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
                        {/* 🔴 截断要给出口(第十轮 P2-3):上一版硬切 160 字,断在半个词上、
                            无展开无折叠,既读不完也用不上,还把服务器目录结构摆在页面上。
                            现在默认折起,点开才显示完整原文。 */}
                        {f.tech && (
                          f.raw ? (
                            <details style={{ maxWidth: '22.5rem' }}>
                              <summary className="kv" style={{ cursor: 'pointer' }}>查看原始报错</summary>
                              <div className="kv mono" style={{ wordBreak: 'break-all', whiteSpace: 'pre-wrap', marginTop: 4 }}>{f.tech}</div>
                            </details>
                          ) : (
                            <div className="kv mono" style={{ wordBreak: 'break-all', maxWidth: '22.5rem' }}>门:{f.tech}</div>
                          )
                        )}
                      </>
                    );
                  })() : v.reason ?? (v.created_by === 'system' ? <span className="kv">初始种子(非发布)</span> : '—')}
                </td>
                <td>
                  {/* 只有**真上线过**的版本能当回滚源(服务端同判据)。此前用「不是 live 也不是 failed」反着写,
                      于是 cancelled 行也长出按钮,点了必 404 —— 界面给的每个按钮都该是能点通的。 */}
                  {v.status === 'archived' && !active && (
                    <button className="btn ghost sm" disabled={unknown || !st.executor.ready} onClick={() => setConfirm({ reason: '', rollbackFrom: v.id })}>回滚到此版</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </div>
    </section>
  );
}
