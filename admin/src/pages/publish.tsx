/* 发布与版本(CON13 ⑤⑥):diff 摘要 + 前置校验红项(带去修复跳转)+ 确认弹窗(高敏须理由)
   + 流水线四步进度 + 失败面(大白话 + 门名 + 原始日志折叠)+ 版本历史与回滚。
   检查失败保留旧版；服务未就绪在提交前明示，切换不确定时暂停后续发布。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { ApiError, api, apiErrorHint, toast } from '../api';
import { splitFailReason } from '../lib/fail-reason';
import { changeGroup, humanPath, LOCALE_NAME } from '../lib/human-path';
import { fieldEditorLink, parseFieldTarget } from '../lib/field-target';
import { publishRequestBody, type PublishConfirmation } from '../lib/publish-contract';
import { createPublishRequestGate, preparePublishConfirmation, publishBlockReason, type PublishIntent } from '../lib/publish-actions';
import { decodePublishProgress, groupPublishChecks, publishFailureAdvice, type PublishCheck } from '../../../schema/src/publish-feedback';
import { useTranslations } from '../lib/translations';
import { useShell } from '../shell';

interface Finding { path: string; rule: string; message: string }
interface FindingGroup { key: string; label: string; message: string; items: Finding[]; locales: Array<[string, number]> }
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

function PublishStateIcon({ status }: { status: string }) {
  const state = ['running', 'ok', 'failed', 'skipped', 'unknown'].includes(status) ? status : 'unknown';
  return <span className={`publisher-state-icon ${state}`} aria-hidden="true">
    <svg viewBox="0 0 32 32" focusable="false">
      {state === 'running' && <circle cx="16" cy="16" r="11" />}
      {state === 'ok' && <><circle cx="16" cy="16" r="11" /><path className="publisher-check-stroke" d="m10 16 4 4 8-9" /></>}
      {state === 'failed' && <><circle cx="16" cy="16" r="11" /><path d="m11 11 10 10m0-10L11 21" /></>}
      {state === 'skipped' && <><circle cx="12" cy="16" r="7" /><circle cx="20" cy="16" r="7" /></>}
      {state === 'unknown' && <><circle cx="16" cy="16" r="11" /><path d="M12 12a4 4 0 0 1 8 0c0 3-4 3-4 6m0 5v.1" /></>}
    </svg>
  </span>;
}
/** 把校验规则译成人话;缺映射显规则名原文,不隐藏 */
const RULE_LABEL: Record<string, string> = {
  'forbidden-word': '合规禁用词', placeholder: '占位符缺失', untranslated: '缺译', 'unknown-key': '非法 key',
  'missing-key': '缺 key', 'enabled-empty-url': '开启的入口缺 URL', url: '链接格式', email: '邮箱格式',
  'all-hidden': '设备板块全隐藏', 'min-visible': 'FAQ 可见不足 3 条', 'dup-id': 'FAQ id 重复', window: '公告时间窗',
  structure: '数据结构', 'seo-length': 'SEO 长度', 'pending-assets': '信任资料占位',
  'translation-stale': '译文待更新', 'newline-shape': '换行结构', 'encoding-damage': '编码损坏字符',
  'too-long': '译文超长', 'translation-envelope': 'AI 格式包装', 'stale-brand': '旧品牌名',
  link: '译文链接不一致', markup: '译文标记结构不一致',
  'growth-noop': '自动增长没配增量', 'growth-future': '自动增长起算日在未来', 'growth-too-fast': '自动增长过快',
};
// 本表必须与发布预检实际产出的规则集**双向**相等 —— 由 gate-config-consistency 断言。
// (曾出现凭空多一个 'all-hidden-sku':校验器从不产出,纯死键;真正的键叫 'all-hidden'。)
/** 红项 → 该去哪个页面修 */

/** 同一根因只显示一次；路径仍保留少量定位样本。 */
export function groupFindings(findings: Finding[]): FindingGroup[] {
  const groups = new Map<string, FindingGroup>();
  for (const finding of findings) {
    const key = finding.rule;
    const group = groups.get(key) ?? { key, label: RULE_LABEL[finding.rule] ?? finding.message, message: finding.message, items: [], locales: [] };
    group.items.push(finding);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const locales = new Map<string, number>();
    for (const finding of group.items) {
      const locale = parseFieldTarget(finding.path).locale;
      if (locale) locales.set(locale, (locales.get(locale) ?? 0) + 1);
    }
    group.locales = [...locales].sort((a, b) => b[1] - a[1]);
  }
  return [...groups.values()].sort((a, b) => b.items.length - a.items.length);
}

export default function PublishPage() {
  const { reload: reloadShell } = useShell();
  const { data: translations } = useTranslations();
  const [pre, setPre] = useState<Preflight | null>(null);
  const [st, setSt] = useState<Status | null>(null);
  const [failed, setFailed] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [pollFailed, setPollFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<PublishConfirmation | null>(null);
  const [forcing, setForcing] = useState(false);
  const [forceReason, setForceReason] = useState('');
  const [openLog, setOpenLog] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const requests = useRef(createPublishRequestGate());
  const acting = useRef(false);
  const confirmHeading = useRef<HTMLHeadingElement | null>(null);
  const confirmTrigger = useRef<HTMLElement | null>(null);
  const confirmVisible = confirm !== null;

  const refresh = useCallback(async () => {
    const ticket = requests.current.begin();
    setRefreshing(true);
    setConfirm(null);
    try {
      const [p, s] = await Promise.all([api<Preflight>('/api/publish/preflight'), api<Status>('/api/publish/status')]);
      if (!requests.current.isCurrent(ticket)) return null;
      setPre(p); setSt(s); setFailed(false); setPollFailed(false); setLoadError('');
      return { p, s, ticket };
    } catch (error) {
      if (requests.current.isCurrent(ticket)) {
        setFailed(true);
        setLoadError(apiErrorHint(error, '发布检查暂时无法刷新，请稍后重试。'));
      }
      return null;
    } finally {
      if (requests.current.isCurrent(ticket)) { requests.current.finish(ticket); setRefreshing(false); }
    }
  }, []);
  // Keep an effect-safe, void-returning entry point for existing refresh buttons.
  const load = useCallback(() => { void refresh(); }, [refresh]);
  useEffect(() => { load(); return () => requests.current.invalidate(); }, [load]);
  useEffect(() => {
    if (confirmVisible) confirmHeading.current?.focus();
  }, [confirmVisible]);
  useEffect(() => {
    if (translations && pre && translations.draftRev > pre.draftRev) load();
  }, [translations?.draftRev, pre?.draftRev, load]);

  // 发布时每2秒更新，空闲时每5秒更新服务就绪状态；结束刷新壳和前置检查。
  useEffect(() => {
    let stopped = false;
    if (st) {
      const poll = () => {
        const retry = () => { if (!stopped) timer.current = window.setTimeout(poll, st.activeVersion ? 2000 : 5000); };
        if (requests.current.pending()) { retry(); return; }
        const ticket = requests.current.current();
        api<Status>('/api/publish/status').then((s) => {
          if (stopped) return;
          if (!requests.current.isCurrent(ticket)) { retry(); return; }
          setPollFailed(false);
          setSt(s);
          // Never leave a confirmation enabled after another publisher acquired the job.
          if (s.activeVersion || !s.executor.ready || s.versions.some(v => v.status === 'unknown')) setConfirm(null);
          if ((st.activeVersion && !s.activeVersion) || (!st.executor.ready && s.executor.ready)) { load(); void reloadShell(); }
        }).catch(() => {
          if (stopped) return;
          if (requests.current.isCurrent(ticket)) setPollFailed(true);
          retry();
        });
      };
      timer.current = window.setTimeout(poll, st.activeVersion ? 2000 : 5000);
    }
    return () => { stopped = true; if (timer.current) window.clearTimeout(timer.current); };
  }, [st, load, reloadShell]);

  async function doPublish() {
    if (!confirm || acting.current || refreshing || failed || pollFailed || !st || st.activeVersion
      || !st.executor.ready || st.versions.some(v => v.status === 'unknown')) return;
    if ((pre?.reasonRequired || confirm.rollbackFrom !== undefined) && confirm.reason.trim().length < 8) {
      toast('需要填写理由（至少 8 字）'); return;
    }
    acting.current = true;
    requests.current.invalidate();
    setBusy(true);
    try {
      await api('/api/publish', { method: 'POST', body: JSON.stringify(publishRequestBody(confirm)) });
      toast(confirm.rebuild ? '版本重建已发起，将执行全部发布检查' : confirm.rollbackFrom ? '回滚已发起,同样要过全部机器门' : '发布已发起');
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
      const serviceMessage = e instanceof ApiError && ['executor-unavailable', 'config-upgrade-conflict', 'config-upgrade-retry', 'publish-schema-upgrade-required'].includes(err)
        ? String(e.body.message ?? e.body.hint ?? '配置升级尚未完成，请刷新查看具体原因') : null;
      toast(serviceMessage ?? (err.includes('reason') ? '需要填写理由(≥8 字)' : err.includes('in-progress') ? '已有发布正在进行或等待核实' : err.includes('preflight') ? '前置校验未通过' : '发起失败,请重试'));
    } finally { acting.current = false; setBusy(false); }
  }

  async function recheckAndConfirm(intent: PublishIntent = 'draft') {
    if (acting.current) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    acting.current = true;
    setBusy(true);
    try {
      const result = await refresh();
      if (!result || !requests.current.isCurrent(result.ticket)) return;
      const { p, s } = result;
      const blocked = publishBlockReason(p, s, intent);
      if (blocked) { toast(blocked); return; }
      confirmTrigger.current = trigger;
      setConfirm(preparePublishConfirmation(p, s, intent));
    } finally { acting.current = false; setBusy(false); }
  }

  function closeConfirmation() {
    setConfirm(null);
    confirmTrigger.current?.focus();
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

  if (failed && (!pre || !st)) return <section><h2>发布与版本</h2><div className="note bad">{loadError || '数据获取失败'} <button className="btn ghost sm" disabled={refreshing || busy} onClick={load}>重新检查</button></div></section>;
  if (!pre || !st) return <section><h2>发布与版本</h2><div className="skl" style={{ height: 80 }} /></section>;

  const active = st.activeVersion;
  const blocked = publishBlockReason(pre, st);
  const rebuildBlocked = publishBlockReason(pre, st, 'rebuild');
  const liveVersion = st.versions.find(v => v.status === 'live');
  const snapshotStale = failed || pollFailed;
  const unavailable = busy || refreshing || snapshotStale || !!active || !st.executor.ready || st.versions.some(v => v.status === 'unknown');
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
  const errorGroups = groupFindings(pre.errors);
  const warningGroups = groupFindings(pre.warnings);
  const translationOnly = pre.errors.length > 0 && pre.errors.every((finding) => ['translation-stale', 'untranslated'].includes(finding.rule));
  const editableFinding = pre.errors.find((finding) => !['structure', 'unknown-key', 'missing-key'].includes(finding.rule));
  const pendingTranslations = translations?.counts.pending ?? 0;
  const issueAction = translationOnly ? { to: '/ai#translation-tasks', label: `处理 ${pre.errors.length} 项译文` }
    : editableFinding ? { to: fieldEditorLink(editableFinding.path), label: `修复 ${pre.errors.length} 项阻断问题` } : null;
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
  const passedChecks = coalescedChecks.filter((item) => item.status === 'ok').length;
  const skippedChecks = coalescedChecks.filter((item) => item.status === 'skipped').length;
  const completedChecks = passedChecks + skippedChecks + failedChecks.length;
  const activeElapsed = activeStarts.length ? Math.max(0, Math.round((Date.now() - Math.min(...activeStarts)) / 1000)) : 0;
  const phaseNames = st.stepNames.length ? st.stepNames : ['materialize', 'gates', 'build', 'swap'];
  const consoleVersion = active ?? st.checksOfVersion ?? st.stepsOfVersion ?? liveVersion?.id ?? null;
  const phaseStep = (name: string) => st.stepsOfVersion === consoleVersion ? st.steps.find((step) => step.step === name) : undefined;
  const displayedStep = (name: string) => active ? stepDone(name) : phaseStep(name);
  const visibleChecks = coalescedChecks.slice(-3);
  const legacyCandidates = active ? phaseNames : phaseNames.filter((name) => displayedStep(name));
  const legacyCurrentIndex = legacyCandidates.findIndex((name) => ['running', 'failed', 'unknown'].includes(displayedStep(name)?.status ?? ''));
  const legacyWindowStart = legacyCurrentIndex < 0
    ? Math.max(0, legacyCandidates.length - 3)
    : Math.max(0, Math.min(legacyCurrentIndex - 1, legacyCandidates.length - 3));
  const legacyWindow = legacyCandidates.slice(legacyWindowStart, legacyWindowStart + 3);
  const completedPhaseCount = phaseNames.filter(name => displayedStep(name)?.status === 'ok').length;
  const hasHistoricalSteps = !active && !!consoleVersion && st.steps.length > 0;
  const historicalFailed = hasHistoricalSteps && phaseNames.some(name => displayedStep(name)?.status === 'failed');
  const historicalComplete = hasHistoricalSteps && phaseNames.every(name => displayedStep(name)?.status === 'ok');
  const consoleHeading = active
    ? taskDisconnected || pollFailed ? `发布状态待核实 v${active}` : `正在发布 v${active}`
    : consoleVersion && coalescedChecks.length ? `最近一次检查 · v${consoleVersion}`
    : hasHistoricalSteps ? `${historicalFailed ? '最近一次执行失败' : '最近一次执行'} · v${consoleVersion}` : '发布器待命';
  const consoleDescription = active
    ? '完成项自动向上移出，当前窗口只保留最近三项真实检查。'
    : coalescedChecks.length ? '显示最近一次真实检查记录；新发布开始后会自动切换到实时进度。' : '发起发布后，这里会显示真实检查进度、失败位置和最终核验结果。';
  const consoleState = active ? taskDisconnected || pollFailed ? 'unknown' : 'running'
    : unknown ? 'unknown' : historicalFailed ? 'failed' : historicalComplete ? 'ok' : 'idle';
  const consoleStateText = active ? taskDisconnected || pollFailed ? '结果待核实' : '执行中'
    : unknown ? '结果待核实' : historicalFailed ? '执行失败' : historicalComplete ? '执行完成' : hasHistoricalSteps ? '最近记录' : '等待任务';
  return (
    <section className="editor-page">
      <header className="page-heading">
        <span className="eyebrow">网站发布</span>
        <h2>发布与版本</h2>
        <p className="page-description">核对已保存的草稿，让修改在官网生效。发布前自动检查，历史版本可随时查看。</p>
      </header>
      <section className="publisher-console" role="region" aria-label="发布执行控制台">
        <header className="publisher-console-heading">
          <div>
            <span className="publisher-console-kicker">实际发布状态</span>
            <h3>{consoleHeading}</h3>
            <p>{consoleDescription}</p>
          </div>
          <span className={`publisher-live-state ${consoleState}`}>{consoleStateText}</span>
        </header>

        <ol className="publisher-phases" aria-label="发布流水线进度">
          {phaseNames.map((name, i) => {
            const step = phaseStep(name);
            const state = step?.status === 'ok' ? 'done' : step?.status === 'failed' ? 'failed'
              : step?.status === 'running' ? taskDisconnected || pollFailed ? 'unknown' : 'doing' : active ? 'todo' : 'idle';
            const stateWord = state === 'done' ? '完成' : state === 'failed' ? '失败' : state === 'doing' ? '进行中'
              : state === 'unknown' ? '待核实' : state === 'todo' ? '未开始' : '待命';
            return <li key={name} data-state={state} aria-label={`${STEP_LABEL[name] ?? name}：${stateWord}`}>
              <span className="publisher-phase-number">{String(i + 1).padStart(2, '0')}</span>
              <div><b>{STEP_LABEL[name] ?? name}</b><small>{stateWord}</small></div>
            </li>;
          })}
        </ol>

        <section className="publisher-check-panel" role="region" aria-label="检查明细">
          <div className="publisher-progress-copy">
            <div>
              <span>{coalescedChecks.length ? '真实检查进度' : '发布阶段进度'}</span>
              <b>{coalescedChecks.length ? `已完成 ${completedChecks} / ${coalescedChecks.length} 项 · ${passedChecks} 通过${skippedChecks ? ` · ${skippedChecks} 跳过` : ''}${failedChecks.length ? ` · ${failedChecks.length} 失败` : ''}`
                : `已完成 ${completedPhaseCount} / ${phaseNames.length} 个步骤`}</b>
            </div>
            {activeElapsed > 2 && <time>本次已用 {activeElapsed < 60 ? `${activeElapsed} 秒` : `${Math.floor(activeElapsed / 60)} 分 ${activeElapsed % 60} 秒`}</time>}
          </div>
          <div className="publisher-progress-track" role="progressbar" aria-label="检查完成进度" aria-valuemin={0}
            aria-valuemax={coalescedChecks.length || phaseNames.length}
            aria-valuenow={coalescedChecks.length ? completedChecks : completedPhaseCount}>
            <span style={{ width: `${coalescedChecks.length
              ? Math.round((completedChecks / coalescedChecks.length) * 100)
              : Math.round((completedPhaseCount / phaseNames.length) * 100)}%` }} />
          </div>

          <div className="publisher-check-window" role="region" aria-label="当前检查窗口" aria-live="polite">
            {visibleChecks.map((item) => <div className="publisher-check-row" data-publish-check-row="" data-state={item.status} key={item.seq}>
              <PublishStateIcon status={item.status} />
              <span className="publisher-check-copy">
                <span className="publisher-check-title"><span>{String(Math.max(1, coalescedChecks.indexOf(item) + 1)).padStart(2, '0')}</span>{normalizeCheckTitle(item.title)}</span>
                <small>{STEP_LABEL[item.step] ?? item.step}</small>
              </span>
              <span className="publisher-check-state">{CHECK_STATUS_LABEL[item.status] ?? '未知'}</span>
            </div>)}
            {!coalescedChecks.length && legacyWindow.map((name) => {
              const step = displayedStep(name);
              const progress = decodePublishProgress(step?.detail);
              const status = step?.status === 'ok' ? 'ok' : step?.status === 'failed' ? 'failed'
                : step?.status === 'running' ? taskDisconnected || pollFailed ? 'unknown' : 'running' : 'unknown';
              const secs = step?.started_at ? Math.round(((step.ended_at ?? Date.now()) - step.started_at) / 1000) : 0;
              return <div className="publisher-check-row legacy" data-publish-check-row="" data-state={status} key={name}>
                <PublishStateIcon status={status} />
                <span className="publisher-check-copy">
                  <span className="publisher-check-title">{STEP_LABEL[name] ?? name}</span>
                  {step?.status === 'running' && step.detail && <small>{progress?.title ?? step.detail}</small>}
                  {step?.status === 'running' && progress && <>
                    <small>最后更新：<time dateTime={progress.updatedAt}>{new Date(progress.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}</time></small>
                    {progress.output && <pre className="mono" tabIndex={0} role="region" aria-label="当前检查最近输出" style={{ maxHeight: 220, overflow: 'auto' }}>{progress.output}</pre>}
                  </>}
                </span>
                <span className="publisher-check-state">
                  {step?.status === 'ok' ? '完成' : step?.status === 'failed' ? '失败' : step?.status === 'running' ? taskDisconnected || pollFailed ? '待核实' : '进行中' : '等待'}
                  {step && secs > 2 && <small>{secs < 60 ? `${secs} 秒` : `${Math.floor(secs / 60)} 分 ${secs % 60} 秒`}</small>}
                </span>
              </div>;
            })}
            {!active && !coalescedChecks.length && st.steps.length === 0 && <div className="publisher-console-empty">暂无执行中的发布任务</div>}
          </div>

          {coalescedChecks.length > 0 && <details className="publisher-all-checks">
            <summary>查看全部 {coalescedChecks.length} 项检查</summary>
            <div className="publisher-all-checks-list">
              {checkGroups.map((group) => <section key={group.step} aria-label={STEP_LABEL[group.step] ?? group.step}>
                <h4>{STEP_LABEL[group.step] ?? group.step} · {group.items.filter((item) => item.status === 'ok').length}/{group.items.length} 通过</h4>
                {group.items.map((item) => <div className="publisher-all-check-row" data-state={item.status} key={item.seq}>
                  <PublishStateIcon status={item.status} />
                  <div><b>{normalizeCheckTitle(item.title)}</b><small>{CHECK_STATUS_LABEL[item.status] ?? '未知'}</small>
                    {item.status === 'failed' && item.output && <details>
                      <summary>查看失败原文</summary>
                      <pre className="mono">{item.output}</pre>
                    </details>}
                  </div>
                </div>)}
              </section>)}
            </div>
          </details>}
          {!coalescedChecks.length && active && st.steps.length > 0 && <div className="publisher-console-notice" role="status">
            检查明细稍后出现。门级检查开始后，这里会按分组列出每一项结果。
            <button className="publisher-console-link" onClick={load}>重新加载明细</button>
          </div>}
          {failedChecks.length > 0 && active && <div className="publisher-console-result failed">
            <span>有 {failedChecks.length} 项检查未通过，本次任务停止后可重新发布。</span>
            <button className="publisher-console-link" disabled={unavailable} onClick={() => void recheckAndConfirm()}>重新发布</button>
          </div>}
        </section>
        <footer className="publisher-console-footer">
          <span><i className="running" />进行中</span><span><i className="ok" />通过</span><span><i className="skipped" />跳过</span><span><i className="unknown" />待核实</span>
          <button className="publisher-console-link" disabled={busy || refreshing} onClick={load}>{refreshing ? '检查中…' : '刷新发布状态'}</button>
        </footer>
      </section>
      {pollFailed && <div className="note warn" role="status">暂时无法刷新发布状态，正在自动重试。恢复连接后将核实执行结果。</div>}
      {failed && <div className="note warn" role="status">{loadError || '发布检查信息暂时无法刷新，已保留上次结果。'}<button className="btn ghost sm" onClick={load}>重试</button></div>}
      {unknown ? <div className="note warn" role="status">切换结果正在核实，核实前暂停新发布。草稿已保留。</div>
        : !active && !st.executor.ready && <div className="note warn" role="status">{st.executor.reason}</div>}

      {showFailure && <div className="note bad" role="alert" style={{ marginBottom: 12 }}>
        <h3>v{lastFailed.id} 发布已停止</h3>
        <p>{failedStep && `${STEP_LABEL[failedStep.step] ?? failedStep.step}：`}{failureAdvice.reason}</p>
        <p>本次任务已停止，不会继续执行后续步骤。</p>
        <p>{failureAdvice.suggestion}</p>
        <p className="kv">草稿改动已保留。{failedStep && failedStep.step !== 'swap' && !st.drift && !unknown
          ? '未切换新版，官网保留原先版本。' : '线上状态以当前核验结果为准。'}当前能否发布以下方检查为准。</p>
        <button className="btn" disabled={unavailable} onClick={() => void recheckAndConfirm()}>重新检查并发布</button>
        <details className="inline-help"><summary>查看失败技术详情</summary>
          <pre className="kv mono" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 220, overflow: 'auto' }}>{failureAdvice.raw || '原因未记录'}</pre>
        </details>
        {failedStep?.detail && <>
          <button className="btn ghost sm" aria-expanded={openLog === 'failure'} aria-controls="publish-failure-log" onClick={() => setOpenLog(openLog ? null : 'failure')}>{openLog ? '收起' : '查看原始日志'}</button>
          {openLog && <pre id="publish-failure-log" className="mono" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 220, overflow: 'auto' }}>{failedStep.detail}</pre>}
        </>}
      </div>}

      {active && taskDisconnected && <div className="note warn" role="status">
        <p>本次执行器已超过 1 分钟未报告心跳，发布结果待核实。</p>
        <p>系统会继续刷新状态。请等待确认停止后再重新检查并发布，最后收到的检查内容已保留。</p>
        <button className="btn ghost sm" onClick={load}>刷新状态</button>
      </div>}
      {active && st.steps.length === 0 && <div className="note warn">
        已提交，系统正在自动安排发布。接单后会依次执行全部检查；关闭本页不会中断发布。
        <button className="btn ghost sm" onClick={cancel}>取消本次发布</button>
      </div>}
      {active && st.steps.length > 0 && !forcing && <div className="note">
        执行器没反应了?<button className="btn ghost sm" onClick={cancel}>中止本次发布</button>
        {!pollFailed && !taskDisconnected && <span className="kv">服务持续报告运行状态；检查可能需要数分钟。</span>}
      </div>}
      {active && forcing && <div className="note bad">
        <b>强制中止 v{active}</b>
        <div className="kv">执行器已失联。中止后这一版记为<b>已取消</b>、线上保持不变,可以重新发起。理由会记进审计。</div>
        <div className="kv">中止后系统会撤销本次执行权限；发布服务确认权限失效后停止操作。</div>
        <div className="row" style={{ marginTop: 6, gap: 8 }}>
          <input aria-label="中止理由（至少 4 个字）" className="inp" style={{ flex: 1 }} placeholder="中止理由(至少 4 个字)" value={forceReason} onChange={(e) => setForceReason(e.target.value)} />
          <button className="btn" onClick={forceCancel}>确认中止</button>
          <button className="btn ghost" onClick={() => { setForcing(false); setForceReason(''); }}>返回</button>
        </div>
      </div>}

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
            <button className="btn" disabled={unavailable} onClick={() => setConfirm({ reason: '线上快照与系统记录不一致,重新发布当前线上版本以对齐', rollbackFrom: st.drift!.dbLive })}>
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

      {/* 发布准备：默认只给结论和下一步，逐字段内容按需展开。 */}
      {!active && (
        <div className="card publish-readiness" id="publish-readiness" style={{ marginBottom: 12 }}>
          <header className="publish-readiness-heading">
            <div><span className="eyebrow">发布准备</span><h3>{pre.errors.length ? '还有内容需要处理' : pre.changed ? '可以进入发布检查' : '当前没有内容改动'}</h3>
              <p>{pre.errors.length ? `${pre.errors.length} 项阻断已归并为 ${errorGroups.length} 个处理任务。` : '确认摘要后，系统会锁定草稿并自动完成检查、构建、切换和核验。'}</p></div>
            <button className="btn ghost sm" disabled={busy || refreshing} onClick={load}>{refreshing ? '检查中…' : '重新检查'}</button>
          </header>
          <dl className="publish-readiness-metrics" aria-label="本次发布摘要">
            <div><dt>待发布改动</dt><dd><b>{pre.changed}</b><small>{changedGroups.size} 个模块</small></dd></div>
            <div data-tone={pre.errors.length ? 'bad' : 'ok'}><dt>阻断问题</dt><dd><b>{pre.errors.length}</b><small>{pre.errors.length ? '处理后可发布' : '已经通过'}</small></dd></div>
            <div data-tone={pre.warnings.length ? 'warn' : 'ok'}><dt>非阻断提醒</dt><dd><b>{pre.warnings.length}</b><small>不影响发布</small></dd></div>
          </dl>
          {pre.reasonRequired && <p className="publish-sensitive-note"><span className="pill warn">含高敏字段</span> 发布确认时需要填写理由。</p>}
          {pre.message ? <p className="kv">{pre.message} 配置兼容准备完成后显示改动摘要。</p> : pre.changed === 0 ? (
            <p className="kv">没有待发布的改动(草稿与线上一致)。</p>
          ) : (
            <details className="publish-disclosure">
              <summary>查看 {changedGroups.size} 个模块的改动摘要</summary>
              <div className="publish-summary-list">
                {[...changedGroups].map(([group, paths]) => {
                  const sensitive = paths.filter((path) => pre.sensitiveChanged.includes(path)).length;
                  return <div className="publish-summary-row" key={group}><div><b>{group}</b><p>{paths.slice(0, 3).map(humanPath).join(' · ')}{paths.length > 3 ? ` · 另 ${paths.length - 3} 处` : ''}</p></div>
                    <span className={`pill ${sensitive ? 'warn' : ''}`}>{paths.length} 处{sensitive ? ` · ${sensitive} 高敏` : ''}</span></div>;
                })}
              </div>
            </details>
          )}
          {pre.errors.length > 0 && (
            <section className="publish-blockers" aria-labelledby="publish-blockers-title">
              <div className="publish-section-title"><div><span>发布前需要处理</span><h4 id="publish-blockers-title">{pre.errors.length} 项问题 · {errorGroups.length} 个根因</h4></div></div>
              <div className="publish-finding-list">{errorGroups.map((group) => <div className="publish-finding" key={group.key}>
                <span className="publish-finding-mark" aria-hidden="true">!</span><div><b>{group.label}</b><p>{group.message}</p>
                  {group.locales.length > 0 && <div className="publish-locale-counts">{group.locales.map(([locale, count]) => <span className="pill" key={locale}>{LOCALE_NAME[locale] ?? locale} {count}</span>)}</div>}
                </div><strong>{group.items.length}</strong>
              </div>)}</div>
              <details className="publish-disclosure compact"><summary>查看定位示例</summary>
                <div className="publish-example-list">{errorGroups.flatMap((group) => group.items.slice(0, 5)).map((finding) => <div key={`${finding.rule}:${finding.path}`}><span>{humanPath(finding.path)}</span>
                  {['structure', 'unknown-key', 'missing-key'].includes(finding.rule) ? <small>由发布服务处理配置兼容</small> : <NavLink to={fieldEditorLink(finding.path)}>定位字段</NavLink>}</div>)}</div>
              </details>
            </section>
          )}
          {pre.warnings.length > 0 && <details className="publish-reminders">
            <summary><span>非阻断提醒 · {pre.warnings.length}</span><small>{warningGroups.map((group) => `${group.label} ${group.items.length}`).join(' · ')}</small></summary>
            <div className="publish-summary-list">{warningGroups.map((group) => <div className="publish-summary-row" key={group.key}><div><b>{group.label}</b><p>{group.items.slice(0, 3).map((finding) => humanPath(finding.path)).join(' · ')}{group.items.length > 3 ? ` · 另 ${group.items.length - 3} 处` : ''}</p></div><span className="pill warn">{group.items.length} 处</span></div>)}</div>
          </details>}
          <div className="publish-primary-action">
            {pre.errors.length > 0 && issueAction ? <NavLink className="btn primary" to={issueAction.to}>{issueAction.label}</NavLink>
              : <button className="btn primary" disabled={unavailable || !!blocked} onClick={() => void recheckAndConfirm()}>检查并发布</button>}
            <span className="kv" role="status">{translationOnly && pendingTranslations > 0
              ? `当前 ${pre.errors.length} 项阻断；队列另有 ${Math.max(0, pendingTranslations - pre.errors.length)} 项待处理内容，共 ${pendingTranslations} 项。`
              : snapshotStale ? '连接恢复并重新检查成功前，暂停提交发布。' : blocked}</span>
          </div>
          {pre.changed === 0 && liveVersion && <div className="note info" style={{ marginTop: 12 }}>
            <p>代码升级不会计入草稿改动。可使用当前发布器代码重新构建 v{liveVersion.id}，同时更新官网和后台静态页面。</p>
            <p className="kv">内容取自确认的版本，不覆盖草稿；仍须经过全部检查、切换和核验。不会更新正在运行的发布器进程。</p>
            <button className="btn" disabled={unavailable || !!rebuildBlocked} onClick={() => void recheckAndConfirm('rebuild')}>重新构建 v{liveVersion.id}（使用当前代码）</button>
            {rebuildBlocked && <p className="kv">{rebuildBlocked}</p>}
          </div>}
        </div>
      )}

      {/* 确认弹窗 */}
      {confirm && (
        <div className="card" role="dialog" aria-modal="false" aria-labelledby="publish-confirm-title" style={{ marginBottom: 12, outline: '2px solid var(--brand)' }}>
          <h3 id="publish-confirm-title" ref={confirmHeading} tabIndex={-1}>{confirm.rebuild ? `确认使用当前代码重新构建 v${confirm.rollbackFrom}?` : confirm.rollbackFrom ? `确认回滚到 v${confirm.rollbackFrom}?` : `确认发布 ${pre.changed} 处改动?`}</h3>
          <p className="kv">
            {confirm.rebuild
              ? '本次使用所确认版本的内容和执行器当前代码重新构建，仍执行全部发布检查。草稿不会覆盖该版本内容，也不会被重建操作改写。确认的是具体版本，不会自动改成稍后出现的其他版本。成功后生成新版本号。'
              : confirm.rollbackFrom
              ? '回滚会按当前网站结构恢复该版内容，并发起一次新发布、执行全部检查。旧版格式会自动转换；已修改内容存在兼容冲突时会停止并提示。成功后生成新版本号。'
              : '确认后系统锁定本次草稿，构建官网并执行全部检查，再组装后台、切换和核验。检查失败时保留旧版。'}
          </p>
          {(pre.reasonRequired || confirm.rollbackFrom) && (
            <div className="field"><label htmlFor="publish-reason">理由（必填，至少 8 字）</label>
              <textarea id="publish-reason" value={confirm.reason} onChange={(e) => setConfirm({ ...confirm, reason: e.target.value })} placeholder="例:Google Play 过审,开放安卓下载" /></div>
          )}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn ghost" onClick={closeConfirmation}>取消</button>
            <button className="btn primary" disabled={unavailable || ((pre.reasonRequired || confirm.rollbackFrom !== undefined) && confirm.reason.trim().length < 8)} onClick={() => void doPublish()}>{busy ? '发起中…' : '确认'}</button>
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
                    <button className="btn ghost sm" disabled={unavailable} onClick={() => setConfirm({ reason: '', rollbackFrom: v.id })}>回滚到此版</button>
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
