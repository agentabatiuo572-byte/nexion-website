/* 区域屏蔽(CON12 ⑤⑥):规则区(开关/国家多选/拦截页文案/直通/生效状态)+ 统计区。
   即时生效通道:应用=确认(理由 ≥8 字)→ D1 权威提交 → KV 边缘物化;失败态不装成功。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, toast } from '../api';
import { AutoTextarea } from '../lib/auto-textarea';
import { TextLimitHint } from '../lib/text-limit-hint';
import { sameGeoRules } from '../lib/geo-rules';
import { ISO_COUNTRIES, countryName } from '../lib/iso-countries';
import { useShell, useUnsavedChanges } from '../shell';
import { LOCALES, LOCALE_NAMES, LocalePair, LocaleToolbar, SOURCE_LOCALE, useLocaleWorkspace } from '../lib/locale-editor';
import { useFocusField } from '../lib/use-focus-field';
import { publishedSiteUrl } from '../lib/published-site';
import type { SiteConfigView, Tri } from '../lib/use-draft';

interface Rules {
  enabled: boolean;
  countries: string[];
  blockPage: { title: Partial<Tri>; body: Partial<Tri> };
  updatedAt?: number;
  updatedBy?: string;
  updateOperationId?: string;
}
type GeoAuthority =
  | { status: 'ready'; source: 'd1'; version: number; currentFingerprint: string }
  | { status: 'bootstrap-required'; source: 'legacy-kv-candidate'; candidateFingerprint: string | null }
  | {
      status: 'pending'; source: 'd1'; kind: 'bootstrap' | 'update'; operationId: string;
      version: number; currentFingerprint: string; targetFingerprint: string;
      previousFingerprint: string; startedAt: number;
    };
type ReadyGeoAuthority = Extract<GeoAuthority, { status: 'ready' }>;
interface GeoState {
  rules: Rules;
  degraded: boolean;
  authority: GeoAuthority;
  bypassAvailable: boolean;
  stats: { last7: Array<{ country: string; hits: number }>; todayLive: number; blocked7: number; shareOfRequests: number };
}

/* 写入失败的原因 → 人话。服务端的错误码不该出现在运营的屏幕上;
   缺映射时显示一句通用说明,而不是吐原始码(gate-console-copy 判据②同源)。 */
const WRITE_FAIL_REASON: Record<string, string> = {
  'kv-readback-mismatch(线上仍为旧规则)': '写进去之后回读对不上,规则没有真正生效',
  'bad-request': '这份规则本身不合法(国家代码或拦截页文案有问题)',
};

type WriteFailure = {
  status: 'known' | 'unknown';
  why: string;
  code: string;
  attempted: Rules;
  kind?: 'update' | 'bootstrap' | 'recovery' | 'ready-recovery';
  operationId?: string;
  expectedVersion?: number;
  expectedFingerprint?: string;
};

type ConfirmBox = {
  reason: string;
  hot: Array<{ country: string; share: number }> | null;
  ack: boolean;
  rules: Rules;
  operationId: string;
  expectedVersion: number;
  expectedFingerprint: string;
  highTrafficConfirmation?: { operationId: string; fingerprint: string };
};

export default function GeoPage() {
  const language = useLocaleWorkspace();
  const { reload: reloadShell, overview: shellOverview, failed: shellFailed } = useShell();
  const [st, setSt] = useState<GeoState | null>(null);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState<Rules | null>(null); // 待应用改动(未写 KV)
  const [applying, setApplying] = useState(false);
  const [writeFail, setWriteFail] = useState<WriteFailure | null>(null);
  const [shellSyncFail, setShellSyncFail] = useState(false);
  const [confirmBox, setConfirmBox] = useState<ConfirmBox | null>(null);
  const [addSel, setAddSel] = useState('');
  const stateReadGeneration = useRef(0);

  useUnsavedChanges(draft !== null);

  useEffect(() => {
    if (
      shellSyncFail
      && !shellFailed
      && st
      && shellOverview?.geo?.enabled === st.rules.enabled
      && shellOverview.geo.countries === st.rules.countries.length
      && shellOverview.geo.degraded === st.degraded
    ) setShellSyncFail(false);
  }, [shellFailed, shellOverview, shellSyncFail, st]);

  const load = useCallback(async () => {
    const generation = ++stateReadGeneration.current;
    /* 显式重读等同放弃本页草稿。旧规则在请求期间不可继续编辑或确认，避免随后
       返回的 GET 把操作者正在提交的状态覆盖掉。 */
    setFailed(false);
    setSt(null);
    setDraft(null);
    setWriteFail(null);
    setConfirmBox(null);
    setShellSyncFail(false);
    try {
      const next = await api<GeoState>('/api/geo');
      if (generation !== stateReadGeneration.current) return null;
      setSt(next);
      return next;
    } catch {
      if (generation === stateReadGeneration.current) setFailed(true);
      return null;
    }
  }, []);
  useEffect(() => {
    void load();
    return () => { stateReadGeneration.current += 1; };
  }, [load]);
  useFocusField(undefined, !!st);

  if (failed) return <section><h2>区域屏蔽</h2><div className="note bad">状态获取失败 <button className="btn ghost sm" onClick={() => void load()}>重试</button></div></section>;
  if (!st) return <section><h2>区域屏蔽</h2><div className="skl" style={{ height: 80 }} /></section>;

  const r = draft ?? st.rules;
  const dirty = draft !== null;
  const writable = st.authority.status === 'ready' && !st.degraded;
  /* 拦截页文案的长度约束(CON12-③ ≤300)在**界面这一层**就拦住,
     而不是放行到最后再由服务端回一句错误码。 */
  const textErrors = LOCALES.flatMap((locale) => (['title', 'body'] as const).flatMap((field) => {
    const length = (r.blockPage[field][locale] ?? '').length;
    const limit = field === 'title' ? 120 : 300;
    if (locale === SOURCE_LOCALE && !r.blockPage[field][locale]?.trim()) return [`中文${field === 'title' ? '标题' : '正文'}必填，其它语言留空时会使用它`];
    return length > limit ? [`${LOCALE_NAMES[locale]}${field === 'title' ? '标题' : '正文'}超出 ${length - limit} 字(上限 ${limit})`] : [];
  }));
  const set = (patch: Partial<Rules>) => setDraft({ ...structuredClone(r), ...patch });

  function openApplyConfirmation(rules: Rules, authority: ReadyGeoAuthority): void {
    setConfirmBox({
      reason: '',
      hot: null,
      ack: false,
      rules: structuredClone(rules),
      operationId: crypto.randomUUID(),
      expectedVersion: authority.version,
      expectedFingerprint: authority.currentFingerprint,
    });
  }

  async function readBack(attempted: Rules, operationId?: string): Promise<
    | { outcome: 'applied' | 'different' | 'pending' | 'bootstrap-required'; state: GeoState }
    | { outcome: 'unavailable' }
  > {
    const generation = ++stateReadGeneration.current;
    try {
      const next = await api<GeoState>('/api/geo');
      if (generation !== stateReadGeneration.current) return { outcome: 'unavailable' };
      if (next.authority.status === 'pending') {
        return {
          outcome: !operationId || next.authority.operationId === operationId ? 'pending' : 'different',
          state: next,
        };
      }
      if (next.authority.status === 'bootstrap-required') return { outcome: 'bootstrap-required', state: next };
      const exactAttempt = sameGeoRules(next.rules, attempted)
        && (!operationId || next.rules.updateOperationId === operationId);
      return { outcome: exactAttempt ? 'applied' : 'different', state: next };
    } catch {
      return { outcome: 'unavailable' };
    }
  }

  async function syncShell(rules: Rules, degraded = false): Promise<boolean> {
    const synced = await reloadShell({
      geo: { enabled: rules.enabled, countries: rules.countries.length, degraded },
    });
    const ok = synced !== null;
    setShellSyncFail(!ok);
    return ok;
  }

  async function acceptApplied(attempted: Rules, rules: Rules, message: string, authority?: GeoAuthority): Promise<void> {
    stateReadGeneration.current += 1;
    const shellSynced = await syncShell(rules);
    setSt((current) => current ? { ...current, rules, degraded: false, authority: authority ?? current.authority } : current);
    setFailed(false);
    setDraft((current) => sameGeoRules(current, attempted) ? null : current);
    setWriteFail(null);
    setConfirmBox(null);
    toast(shellSynced ? message : `${message}；顶部全局状态暂时无法刷新`);
  }

  async function acceptDifferent(writeFailure: WriteFailure, state: GeoState): Promise<void> {
    stateReadGeneration.current += 1;
    await syncShell(state.rules, state.degraded);
    setSt(state);
    setFailed(false);
    setWriteFail(writeFailure);
  }

  async function acceptReadyReadback(attempted: Rules, state: GeoState, message: string): Promise<void> {
    stateReadGeneration.current += 1;
    const shellSynced = await syncShell(state.rules, state.degraded);
    setSt(state);
    setFailed(false);
    setDraft((current) => sameGeoRules(current, attempted) ? null : current);
    setWriteFail(null);
    setConfirmBox(null);
    toast(shellSynced ? message : `${message}；顶部全局状态暂时无法刷新`);
  }

  async function acceptPending(attempted: Rules, state: GeoState): Promise<void> {
    stateReadGeneration.current += 1;
    await syncShell(state.rules, true);
    setSt(state);
    setFailed(false);
    setDraft((current) => sameGeoRules(current, state.rules) || sameGeoRules(attempted, state.rules) ? null : current);
    setWriteFail(null);
    setConfirmBox(null);
  }

  async function refreshPreservingDraft(): Promise<GeoState | null> {
    const generation = ++stateReadGeneration.current;
    try {
      const next = await api<GeoState>('/api/geo');
      if (generation !== stateReadGeneration.current) return null;
      setSt(next);
      setFailed(false);
      setDraft((current) => sameGeoRules(current, next.rules) ? null : current);
      return next;
    } catch {
      return null;
    }
  }

  async function bootstrapAuthority(): Promise<void> {
    const currentState = st;
    if (!currentState || currentState.authority.status !== 'bootstrap-required' || !currentState.authority.candidateFingerprint) return;
    setApplying(true);
    try {
      const result = await api<{ ok: true; rules: Rules; authority: ReadyGeoAuthority }>('/api/geo/recovery', {
        method: 'POST',
        body: JSON.stringify({
          action: 'bootstrap',
          rules: currentState.rules,
          candidateFingerprint: currentState.authority.candidateFingerprint,
          reason: '确认现有旧 KV 候选并建立 D1 权威版本',
        }),
      });
      if (result.authority?.status !== 'ready') throw new Error('bootstrap response missing ready authority');
      await acceptApplied(
        currentState.rules,
        result.rules,
        '现有规则已确认并保存，访问节点已同步',
        result.authority,
      );
    } catch (ex) {
      const code = ex instanceof ApiError ? String(ex.body.error ?? '') : 'network';
      /* POST 的 5xx 或网络异常不能证明事务没发生。以新的 GET 权威状态收口，
         避免把“响应丢了”显示成“迁移失败”。候选变化类 409 也统一回读，
         让页面展示服务端刚确认过的候选。 */
      const outcome = await readBack(currentState.rules);
      if (outcome.outcome === 'applied') {
        await acceptReadyReadback(currentState.rules, outcome.state, '未收到确认响应，但重新读取已确认：现有规则已保存');
      } else if (outcome.outcome === 'different') {
        await acceptReadyReadback(currentState.rules, outcome.state, '重新读取已确认：其他操作已保存规则，内容与刚才显示的不同');
      } else if (outcome.outcome === 'pending') {
        await acceptPending(currentState.rules, outcome.state);
      } else if (outcome.outcome === 'bootstrap-required') {
        await syncShell(outcome.state.rules, outcome.state.degraded);
        setSt(outcome.state);
        setFailed(false);
        setWriteFail({
          status: 'known',
          why: sameGeoRules(outcome.state.rules, currentState.rules)
            ? '重新读取确认 D1 权威尚未建立，可继续确认当前候选'
            : '旧 KV 候选已变化；页面已载入新候选，确认内容后才能重新迁移',
          code: code || 'geo-bootstrap-not-applied',
          attempted: currentState.rules,
          kind: 'bootstrap',
        });
      } else {
        setWriteFail({
          status: 'unknown',
          why: '当前无法读取 D1 权威状态',
          code: 'geo-bootstrap-result-unknown',
          attempted: currentState.rules,
          kind: 'bootstrap',
        });
      }
    } finally {
      setApplying(false);
    }
  }

  async function reconcilePending(): Promise<void> {
    const currentState = st;
    if (!currentState || currentState.authority.status !== 'pending') return;
    const operationId = currentState.authority.operationId;
    setApplying(true);
    try {
      const result = await api<{
        observed: 'target' | 'current' | 'unknown' | 'unavailable';
        rules: Rules;
        authority: ReadyGeoAuthority;
      }>('/api/geo/recovery', {
        method: 'POST',
        body: JSON.stringify({ action: 'reconcile', operationId, reason: '重新物化 D1 权威规则并完成待处理操作' }),
      });
      if (result.authority?.status !== 'ready') throw new Error('recovery response missing ready authority');
      const observation = result.observed === 'target' ? '访问节点已是最新规则'
        : result.observed === 'current' ? '访问节点原为旧规则，现已同步为已保存的规则'
          : result.observed === 'unavailable' ? '未能读取访问节点原有规则，现已重新同步已保存的规则'
            : '访问节点原有规则不一致，现已重新同步已保存的规则';
      await acceptApplied(currentState.rules, result.rules, `同步完成：${observation}`, result.authority);
    } catch (ex) {
      const code = ex instanceof ApiError ? String(ex.body.error ?? '') : 'network';
      const outcome = await readBack(currentState.rules);
      if (outcome.outcome === 'applied') {
        await acceptReadyReadback(currentState.rules, outcome.state, '未收到同步响应，但重新读取已确认：规则已恢复就绪');
      } else if (outcome.outcome === 'different') {
        await acceptReadyReadback(currentState.rules, outcome.state, '重新读取已确认：待处理操作已结束，规则随后又被其他操作更新');
      } else if (outcome.outcome === 'pending') {
        await acceptPending(currentState.rules, outcome.state);
      } else if (outcome.outcome === 'bootstrap-required') {
        await syncShell(outcome.state.rules, outcome.state.degraded);
        setSt(outcome.state);
        setFailed(false);
        setWriteFail({
          status: 'known',
          why: '重新读取确认 D1 权威行不存在，需要先按上方候选完成迁移',
          code: code || 'geo-recovery-authority-missing',
          attempted: currentState.rules,
          kind: 'recovery',
        });
      } else {
        setWriteFail({
          status: 'unknown',
          why: '当前无法读取 D1 权威状态，不能判断恢复是否完成',
          code: 'geo-recovery-result-unknown',
          attempted: currentState.rules,
          kind: 'recovery',
        });
      }
    } finally {
      setApplying(false);
    }
  }

  async function rematerializeReady(): Promise<void> {
    const currentState = st;
    if (!currentState || !currentState.degraded || currentState.authority.status !== 'ready') return;
    const { version, currentFingerprint } = currentState.authority;
    const operationId = crypto.randomUUID();
    setApplying(true);
    try {
      const result = await api<{
        ok: true;
        recovery: 'rematerialize-ready';
        operationId: string;
        rules: Rules;
        authority: ReadyGeoAuthority;
      }>('/api/geo/recovery', {
        method: 'POST',
        body: JSON.stringify({
          action: 'rematerialize-ready',
          operationId,
          version,
          currentFingerprint,
          reason: '按当前 D1 权威版本重新物化边缘规则',
        }),
      });
      if (
        result.authority?.status !== 'ready'
        || result.operationId !== operationId
        || result.authority.version !== version
        || result.authority.currentFingerprint !== currentFingerprint
      ) throw new Error('ready rematerialization response changed authority');
      await acceptApplied(currentState.rules, result.rules, '已保存的规则已重新同步到访问节点', result.authority);
    } catch (ex) {
      const code = ex instanceof ApiError ? String(ex.body.error ?? '') : 'network';
      const next = await refreshPreservingDraft();
      if (
        next
        && next.authority.status === 'pending'
        && next.authority.operationId === operationId
        && next.authority.version === version
        && next.authority.currentFingerprint === currentFingerprint
      ) {
        await acceptPending(currentState.rules, next);
      } else if (
        next
        && next.authority.status === 'ready'
        && next.authority.version === version
        && next.authority.currentFingerprint === currentFingerprint
        && !next.degraded
      ) {
        await acceptReadyReadback(
          currentState.rules,
          next,
          '未收到同步响应，但重新读取已确认：访问节点与已保存的规则一致',
        );
      } else if (next) {
        await syncShell(next.rules, next.degraded);
        setWriteFail({
          status: 'known',
          why: next.authority.status === 'ready' && next.degraded
            ? '重新读取确认边缘 KV 仍未与当前 D1 权威版本一致，可再次执行重新物化'
            : 'D1 权威状态已变化；页面已载入当前状态，请按新的恢复入口处理',
          code: code || 'geo-ready-rematerialization-not-applied',
          attempted: currentState.rules,
          kind: 'ready-recovery',
          operationId,
          expectedVersion: version,
          expectedFingerprint: currentFingerprint,
        });
      } else {
        setWriteFail({
          status: 'unknown',
          why: '没有收到恢复响应，也暂时读不到 D1 权威与边缘物化状态',
          code: 'geo-ready-rematerialization-result-unknown',
          attempted: currentState.rules,
          kind: 'ready-recovery',
          operationId,
          expectedVersion: version,
          expectedFingerprint: currentFingerprint,
        });
      }
    } finally {
      setApplying(false);
    }
  }

  async function verifyUnknown(): Promise<void> {
    if (!writeFail || writeFail.status !== 'unknown') return;
    setApplying(true);
    if (
      writeFail.kind === 'ready-recovery'
      && writeFail.expectedVersion !== undefined
      && writeFail.expectedFingerprint
    ) {
      const next = await refreshPreservingDraft();
      if (!next) {
        setWriteFail({ ...writeFail, why: '仍无法读取实际规则；请稍后再次核实，当前不能断言是否恢复' });
      } else if (
        next.authority.status === 'pending'
        && next.authority.operationId === writeFail.operationId
        && next.authority.version === writeFail.expectedVersion
        && next.authority.currentFingerprint === writeFail.expectedFingerprint
      ) {
        await acceptPending(writeFail.attempted, next);
      } else if (
        next.authority.status === 'ready'
        && next.authority.version === writeFail.expectedVersion
        && next.authority.currentFingerprint === writeFail.expectedFingerprint
      ) {
        if (next.degraded) {
          await syncShell(next.rules, true);
          setWriteFail({
            ...writeFail,
            status: 'known',
            why: '重新读取确认边缘 KV 仍未与当前 D1 权威版本一致，可再次执行重新物化',
            code: 'geo-ready-rematerialization-not-applied',
          });
        } else {
          await acceptReadyReadback(
            writeFail.attempted,
            next,
            '已重新读取：访问节点与已保存的规则一致',
          );
        }
      } else {
        await syncShell(next.rules, next.degraded);
        setSt(next);
        setWriteFail({
          ...writeFail,
          status: 'known',
          why: 'D1 权威版本已经变化；页面已载入当前状态，请按新的恢复入口处理',
          code: 'geo-ready-rematerialization-conflict',
        });
      }
      setApplying(false);
      return;
    }
    const outcome = await readBack(writeFail.attempted, writeFail.operationId);
    if (outcome.outcome === 'applied' && writeFail.kind === 'ready-recovery' && outcome.state.degraded) {
      await syncShell(outcome.state.rules, true);
      setSt(outcome.state);
      setWriteFail({
        ...writeFail,
        status: 'known',
        why: '重新读取确认边缘 KV 仍未与当前 D1 权威版本一致，可再次执行重新物化',
        code: 'geo-ready-rematerialization-not-applied',
      });
    } else if (outcome.outcome === 'applied') {
      await acceptReadyReadback(
        writeFail.attempted,
        outcome.state,
        writeFail.kind === 'bootstrap'
          ? '已重新读取：现有规则确实已经保存'
          : writeFail.kind === 'recovery'
            ? '已重新读取：待恢复操作确实已经完成'
            : writeFail.kind === 'ready-recovery'
              ? '已重新读取：访问节点与已保存的规则一致'
            : '已重新读取：本次规则确实已经生效',
      );
    } else if (outcome.outcome === 'pending') {
      await acceptPending(writeFail.attempted, outcome.state);
    } else if (outcome.outcome === 'different') {
      if (writeFail.kind === 'bootstrap' || writeFail.kind === 'recovery') {
        await acceptReadyReadback(writeFail.attempted, outcome.state, '已重新读取：规则已就绪，当前内容已由其他操作更新');
      } else if (writeFail.kind === 'ready-recovery') {
        await syncShell(outcome.state.rules, outcome.state.degraded);
        setSt(outcome.state);
        setWriteFail({
          ...writeFail,
          status: 'known',
          why: 'D1 权威版本已经变化；页面已载入当前状态，请按新的恢复入口处理',
          code: 'geo-ready-rematerialization-conflict',
        });
      } else {
        await acceptDifferent(
          {
            ...writeFail,
            status: 'known',
            why: sameGeoRules(outcome.state.rules, writeFail.attempted)
              ? '重新读取到相同规则，但未确认由本次操作写入；本页改动仍保留，可再次应用'
              : '重新读取后确认线上不是本次规则；本页改动仍保留，可再次应用',
            code: 'readback-different',
          },
          outcome.state,
        );
      }
    } else if (outcome.outcome === 'bootstrap-required') {
      await syncShell(outcome.state.rules, outcome.state.degraded);
      setSt(outcome.state);
      setFailed(false);
      setWriteFail({
        ...writeFail,
        status: 'known',
        why: '重新读取确认 D1 权威尚未建立；请核对当前候选后再确认迁移',
        code: 'geo-bootstrap-not-applied',
        kind: 'bootstrap',
      });
    } else {
      setWriteFail({ ...writeFail, why: '仍无法读取实际规则；请稍后再次核实，当前不能断言是否生效' });
    }
    setApplying(false);
  }

  async function apply(): Promise<void> {
    if (!confirmBox) return;
    const attempt = confirmBox;
    if (attempt.reason.trim().length < 8) return toast('理由至少 8 字');
    const attempted = attempt.rules;
    stateReadGeneration.current += 1;
    setApplying(true);
    try {
      const result = await api<{
        ok: true;
        operationId: string;
        superseded?: boolean;
        rules: Rules;
        authority: ReadyGeoAuthority;
      }>('/api/geo', {
        method: 'PUT',
        body: JSON.stringify({
          enabled: attempted.enabled,
          countries: attempted.countries,
          blockPage: attempted.blockPage,
          reason: attempt.reason,
          operationId: attempt.operationId,
          expectedVersion: attempt.expectedVersion,
          expectedFingerprint: attempt.expectedFingerprint,
          highTrafficConfirmation: attempt.ack ? attempt.highTrafficConfirmation : undefined,
        }),
      });
      if (
        result.superseded === true
        || result.operationId !== attempt.operationId
        || result.rules.updateOperationId !== attempt.operationId
        || result.authority?.status !== 'ready'
        || result.authority.version !== attempt.expectedVersion + 1
        || !sameGeoRules(result.rules, attempted)
      ) throw new Error('geo update response does not identify this operation');
      await acceptApplied(attempted, result.rules, '规则已保存并确认同步 · 约 1 分钟内全球生效', result.authority);
    } catch (ex) {
      const code = ex instanceof ApiError ? String(ex.body.error ?? '') : 'network';
      if (ex instanceof ApiError && ex.status === 409 && code === 'need-confirm-high-traffic') {
        const challenge = ex.body as {
          hot?: Array<{ country: string; share: number }>;
          operationId?: unknown;
          confirmationFingerprint?: unknown;
        };
        const fingerprint = typeof challenge.confirmationFingerprint === 'string'
          ? challenge.confirmationFingerprint
          : '';
        const hot = Array.isArray(challenge.hot) ? challenge.hot : null;
        if (
          challenge.operationId !== attempt.operationId
          || !/^[0-9a-f]{64}$/.test(fingerprint)
          || !hot
        ) {
          setWriteFail({
            status: 'known',
            why: '服务端返回的高流量确认凭据与本次操作不匹配，不能继续应用',
            code: 'geo-high-traffic-challenge-invalid',
            attempted,
            operationId: attempt.operationId,
          });
          setConfirmBox(null);
        } else {
          setConfirmBox((current) => current?.operationId === attempt.operationId ? {
            ...current,
            hot,
            ack: false,
            highTrafficConfirmation: { operationId: attempt.operationId, fingerprint },
          } : current); // E2 二次确认
        }
      } else if (
        ex instanceof ApiError
        && ex.status === 409
        && (code === 'geo-update-conflict' || code === 'geo-operation-id-conflict')
      ) {
        setWriteFail({
          status: 'known',
          why: '规则已被其他操作更新；请重新读取 D1 权威版本，再决定是否重做本页改动',
          code,
          attempted,
          operationId: attempt.operationId,
        });
        setConfirmBox(null);
      } else if (ex instanceof ApiError && ex.status === 409 && code === 'geo-bootstrap-required') {
        await refreshPreservingDraft();
        setWriteFail(null);
        setConfirmBox(null);
      } else if (
        ex instanceof ApiError
        && ex.status === 400
      ) {
        /* 🔴 写入失败必须**留在屏幕上 + 给重试**(CON12-⑤ 逐字要求「+重试」;第十轮独立验收 P1)。
           上一版只有一条 2.6 秒就消失的浮层,而且把服务端的错误码原样印给运营。
           这是合规开关:「以为已经生效、其实没有」的代价是屏蔽规则形同虚设,
           而人一转头那句提示就没了,连自己看到过什么都记不住。 */
        setWriteFail({
          status: 'known',
          why: WRITE_FAIL_REASON[code] ?? '服务端拒绝了这次写入',
          code,
          attempted,
          operationId: attempt.operationId,
        });
      } else {
        // 网络失败或服务端非确定性错误都不能证明“没写入”。先 GET 回读；只有读到事实后才能下结论。
        const outcome = await readBack(attempted, attempt.operationId);
        if (outcome.outcome === 'applied') {
          await acceptReadyReadback(
            attempted,
            outcome.state,
            outcome.state.degraded
              ? '未收到保存响应，但重新读取已确认：本次规则已保存，访问节点仍在同步或暂时异常'
              : '写入响应丢失，但重新读取确认规则已由本次操作写入并生效',
          );
        } else if (outcome.outcome === 'pending') {
          await acceptPending(attempted, outcome.state);
        } else if (outcome.outcome === 'different') {
          await acceptDifferent(
            {
              status: 'known',
              why: sameGeoRules(outcome.state.rules, attempted)
                ? '没有收到写入响应；重新读取到相同规则，但未确认由本次操作写入；本页改动仍保留'
                : '没有收到写入响应；重新读取后确认线上不是本次规则，本页改动仍保留',
              code: 'readback-different',
              attempted,
              operationId: attempt.operationId,
            },
            outcome.state,
          );
        } else if (outcome.outcome === 'bootstrap-required') {
          await syncShell(outcome.state.rules, outcome.state.degraded);
          setSt(outcome.state);
          setFailed(false);
          setWriteFail({
            status: 'known',
            why: '重新读取确认 D1 权威尚未建立；页面已显示当前迁移候选',
            code: 'geo-bootstrap-required',
            attempted,
            kind: 'bootstrap',
            operationId: attempt.operationId,
          });
          setConfirmBox(null);
        } else {
          setWriteFail({
            status: 'unknown',
            why: '没有收到写入响应，也暂时读不到实际规则；本页改动已保留',
            code: 'result-unknown',
            attempted,
            kind: 'update',
            operationId: attempt.operationId,
          });
        }
      }
    } finally {
      setApplying(false);
    }
  }

  async function getBypass() {
    try {
      const { url } = await api<{ url: string }>('/api/geo/bypass-token', { method: 'POST' });
      window.open(publishedSiteUrl(url), '_blank', 'noopener');
      toast('已在新标签兑换 30 天直通并打开官网(从任何地区可预览;直通访问不计统计)');
    } catch {
      toast('直通签发失败,请重试');
    }
  }

  return (
    <section className="editor-page">
      <header className="page-heading">
        <span className="eyebrow">网站访问管理</span>
        <h2>区域屏蔽 <span className="pill warn">即时生效 · 变更须理由</span></h2>
        <p className="page-description">选择限制访问的国家和地区，并设置拦截页文案。控制台始终可访问。</p>
      </header>
      <div className="note warn"><b>本页应用后直接生效，不经过内容发布。</b> 确认并填写理由后提交，约 1 分钟内在全球生效。</div>
      {shellSyncFail && (
        <div className="note bad" role="status">
          规则状态已经在本页确认，但顶部全局状态暂时无法同步；旧的顶部状态已隐藏。
          <button
            className="btn ghost sm"
            disabled={applying}
            onClick={async () => {
              setApplying(true);
              const ok = await syncShell(st.rules, st.degraded);
              setApplying(false);
              if (ok) toast('顶部全局状态已同步');
            }}
          >重新同步顶部状态</button>
        </div>
      )}
      {st.authority.status === 'bootstrap-required' && (
        <div className="note warn" role="status" style={{ marginBottom: 12 }}>
          <b>首次使用，请先确认现有规则。</b>
          <div className="kv" style={{ marginTop: 4 }}>
            下方是读取到的原有规则，尚未保存到当前管理系统。核对无误后确认保存，再应用新改动；读取失败时请先联系维护人员恢复读取。
          </div>
          <details className="inline-help"><summary>查看首次确认技术详情</summary><p className="kv">下方内容只是旧 KV 的迁移候选，尚不是权威版本。确认内容无误后，D1 插入事务会成为首次权威版本；候选读取失败时不能确认。</p></details>
          <button
            className="btn sm"
            style={{ marginTop: 8 }}
            disabled={applying || !st.authority.candidateFingerprint}
            onClick={() => void bootstrapAuthority()}
          >{applying ? '确认中…' : '确认并保存现有规则'}</button>
        </div>
      )}
      {st.authority.status === 'pending' && (
        <div className="note bad" role="status" style={{ marginBottom: 12 }}>
          <b>规则已保存，待确认同步完成。</b>
          <div className="kv" style={{ marginTop: 4 }}>
            访问节点可能已收到规则，但同步及操作记录尚未全部确认。请重新同步，完成后才能应用新改动。
          </div>
          <details className="inline-help"><summary>查看待同步技术详情</summary><p className="kv">D1 权威操作处于待恢复状态，不能断言边缘物化与审计已经收口。操作 {st.authority.operationId} · 版本 {st.authority.version}。边缘 KV 可能尚未写入，也可能已写入但 applied 审计未完成；恢复会按同一个 D1 权威目标安全重放。</p></details>
          <button className="btn sm" style={{ marginTop: 8 }} disabled={applying} onClick={() => void reconcilePending()}>
            {applying ? '同步中…' : '重新同步已保存规则'}
          </button>
        </div>
      )}
      {st.degraded && st.authority.status === 'bootstrap-required' && (
        <div className="note bad">无法读取原有规则。下方仅显示默认名单（中国大陆），不能据此确认保存；请联系维护人员恢复读取。
          <details className="inline-help"><summary>查看读取异常技术详情</summary><p className="kv">旧 KV 候选读取失败，下方仅为安全兜底名单(仅 CN)；不能用它建立权威版本。</p></details>
        </div>
      )}
      {st.degraded && st.authority.status === 'ready' && (
        <div className="note bad">
          <b>规则已保存，但暂时无法核对同步结果。</b>
          <div className="kv">可尝试重新同步；确认恢复后才能应用新改动。持续异常时，请联系维护人员并提供技术详情。</div>
          <details className="inline-help"><summary>查看同步异常技术详情</summary><p className="kv">D1 权威规则可读，但边缘 KV 通道当前不可达；请先恢复存储再应用变更。</p></details>
          <button className="btn sm" style={{ marginLeft: 8 }} disabled={applying} onClick={() => void rematerializeReady()}>
            {applying ? '同步中…' : '重新同步当前规则'}
          </button>
        </div>
      )}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="row">
          <b>总开关</b>
          <label className="tap44" title="总开关"><input aria-label="启用区域屏蔽" type="checkbox" style={{ width: '1.125rem', height: '1.125rem' }} checked={r.enabled} onChange={(e) => set({ enabled: e.target.checked })} /></label>
          {/* 🔴 「已生效」指的是「页面上这份 = 线上那份」,而不是「屏蔽正在生效」——
              上一版总开关关着时旁边也写「已生效」,而同屏状态条写「屏蔽 未启用」,同一件事两个词;
              降级态更糟:页面显示的根本不是真规则,那枚绿标却还写着已生效(第十轮 P2-4)。 */}
          {writeFail?.status === 'unknown' ? (
            <span className="pill warn">应用结果待核实</span>
          ) : dirty ? (
            <span className="pill warn">改动未应用</span>
          ) : st.authority.status === 'pending' ? (
            <span className="pill warn">已保存 · 待确认同步</span>
          ) : st.authority.status === 'bootstrap-required' ? (
            <span className="pill warn">现有规则 · 待首次确认</span>
          ) : st.degraded ? (
            <span className="pill warn">已保存 · 同步结果待核实</span>
          ) : (
            <span className="pill ok">
              {r.enabled ? '屏蔽生效中' : '屏蔽未启用'}
              {st.rules.updatedAt ? ` · 已核对(${new Date(st.rules.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })})` : ' · 已核对'}
            </span>
          )}
          <span className="spacer" />
          <button className="btn" disabled={!st.bypassAvailable} title={st.bypassAvailable ? '' : '直通密钥未配置或仍为默认值'} onClick={() => void getBypass()}>
            获取直通(从任何地区预览官网)
          </button>
        </div>
        <details className="inline-help" style={{ marginTop: 10 }}><summary>规则如何生效</summary><p className="kv">规则先保存到数据库（D1），再同步到各地访问节点（KV）。本页会核对同步结果，异常时暂停新改动并显示恢复入口。</p></details>
        {!st.bypassAvailable && (
          <div className="note warn" style={{ marginBottom: 0 }}>
            直通功能当前停用:部署时的直通密钥未配置,或仍是代码库里的开发默认值(运维手册里叫 BYPASS_SECRET)。上线前必须轮换成真密钥,否则任何人都能自行伪造直通凭证绕过屏蔽。
          </div>
        )}
      </div>
      <div className="card" style={{ marginBottom: 12 }}>
        <h3>屏蔽名单 <span className="pill">{r.countries.length} 个国家 / 地区</span></h3>
        <div className="chipset">
          {r.countries.map((c) => (
            <span className="cchip" key={c} style={{ background: 'var(--surface2)', borderRadius: 99, padding: '7px 12px', display: 'inline-flex', gap: 8, alignItems: 'center' }}>
              {c} {countryName(c)}
              <button style={{ color: 'var(--ink4)', minWidth: '2.75rem', minHeight: '2.75rem' }} aria-label={`移除 ${countryName(c)}`} title="移除(须应用变更生效)" onClick={() => set({ countries: r.countries.filter((x) => x !== c) })}>✕</button>
            </span>
          ))}
          <select aria-label="添加屏蔽国家或地区" value={addSel} style={{ width: '13.75rem' }} onChange={(e) => { const v = e.target.value; if (v && !r.countries.includes(v)) set({ countries: [...r.countries, v] }); setAddSel(''); }}>
            <option value="">+ 添加国家/地区…</option>
            {ISO_COUNTRIES.filter((c) => !r.countries.includes(c.code)).map((c) => (
              <option key={c.code} value={c.code}>{c.code} {c.name}</option>
            ))}
          </select>
        </div>
        <p className="kv" style={{ marginTop: 8 }}>⚠ CN 仅指中国大陆;HK/MO/TW 为独立代码,不会被连带,要连带须显式添加。名单为空+开启 = 不拦任何人。</p>
      </div>
      <div className="card" style={{ marginBottom: 12 }}>
        <h3>受限访客看到的内容</h3>
        <p className="kv">中文标题和正文必填，其它语言留空时回退中文。标题最多 120 字符，正文最多 300 字符。此页应用规则后直接生效；网站语言开关仍需保存草稿并发布。</p>
        <LocaleToolbar workspace={language} enabledLocales={(shellOverview?.draft?.payload as SiteConfigView | undefined)?.enabledLocales} optional={language.target !== SOURCE_LOCALE} immediate gaps={(['title', 'body'] as const).filter((field) => !r.blockPage[field][language.target]?.trim()).map((field) => ({ path: `geo.blockPage.${field}.${language.target}`, label: field === 'title' ? '拦截页标题' : '拦截页正文' }))} />
        <LocalePair workspace={language} reference={language.reference ? <>{r.blockPage.title[language.reference] || <span lang="zh">标题尚未填写</span>}{'\n\n'}{r.blockPage.body[language.reference] || <span lang="zh">正文尚未填写</span>}</> : ''} label="拦截页">
          {[language.target].map((l) => (
            <div key={l}>
              <div className="field" style={{ margin: 0 }}><label htmlFor={`geo-title-${l}`}>{LOCALE_NAMES[l]}标题</label>
                <input lang={l} id={`geo-title-${l}`} aria-describedby={`geo-title-${l}-length`} data-field={`geo.blockPage.title.${l}`} value={r.blockPage.title[l] ?? ''} onChange={(e) => set({ blockPage: { ...r.blockPage, title: { ...r.blockPage.title, [l]: e.target.value } } })} />
                <TextLimitHint id={`geo-title-${l}-length`} fieldId={'/geo/blockPage/title/' + l} locale={l} value={r.blockPage.title[l] ?? ''} immediate /></div>
              {/* 🔴 就地计数 + 就地拦(第十轮独立验收 P1-8):上一版 label 写着「≤300」却
                  没有计数、没有红字、按钮照常可点,人一路走到最后一步才被一句
                  `bad-request` 打回,而那句话 2.6 秒就消失、也不说是哪一栏超了多少。 */}
              <div className="field"><label htmlFor={`geo-body-${l}`}>{LOCALE_NAMES[l]}正文
                <span className="kv" style={{ marginLeft: 6, color: (r.blockPage.body[l] ?? '').length > 300 ? 'var(--bad)' : undefined }}>
                  系统长度 {(r.blockPage.body[l] ?? '').length}/300
                </span>
              </label>
                <AutoTextarea lang={l} id={`geo-body-${l}`} aria-describedby={`geo-body-${l}-length`} data-field={`geo.blockPage.body.${l}`} value={r.blockPage.body[l] ?? ''} onChange={(e) => set({ blockPage: { ...r.blockPage, body: { ...r.blockPage.body, [l]: e.target.value } } })} />
                <TextLimitHint id={`geo-body-${l}-length`} fieldId={'/geo/blockPage/body/' + l} locale={l} value={r.blockPage.body[l] ?? ''} immediate /></div>
            </div>
          ))}
        </LocalePair>
      </div>
      <div className="row" style={{ marginBottom: 16 }}>
        {/* 只有 D1 ready 且 KV 通道可达时允许新写。bootstrap/pending 先完成对应恢复，
            避免把一项未完成的物化任务再叠加成第二项。 */}
        <button
          className="btn primary"
          disabled={!dirty || applying || !writable || textErrors.length > 0}
          title={!writable ? '请先确认现有规则或重新同步，恢复后才能应用新改动' : textErrors.length ? textErrors.join(';') : ''}
          onClick={() => {
            if (st.authority.status === 'ready') openApplyConfirmation(r, st.authority);
          }}
        >
          应用变更(确认+理由)
        </button>
        {dirty && <button className="btn ghost" onClick={() => setDraft(null)}>放弃改动</button>}
        {/* 禁用必须说明原因(不变量);发布页在同样情形下写「无改动可发布」,这里此前是空的 */}
        {!dirty && writable && <span className="kv">当前没有未应用的改动</span>}
      </div>
      {textErrors.map((x, i) => <div className="note bad" key={i} style={{ marginBottom: 10 }}>{x}——请修正后再应用</div>)}

      {/* 写入失败:常驻红条 + 重试(CON12-⑤)。改动仍在草稿里,重试就是再发一次同一份规则。 */}
      {writeFail && (
        <div className="note bad" style={{ marginBottom: 16 }}>
          <b>{writeFail.status === 'unknown'
            ? writeFail.kind === 'bootstrap'
              ? '首次确认结果暂时未知，请重新读取实际状态。'
              : writeFail.kind === 'recovery'
                ? '恢复结果暂时未知，不能断言待处理操作仍未完成。'
                : writeFail.kind === 'ready-recovery'
                  ? '同步结果暂时未知，当前无法确认访问节点是否恢复。'
                : '应用结果暂时未知，不能断言线上仍是旧规则。'
            : writeFail.kind === 'bootstrap'
              ? '现有规则尚未完成首次确认。'
              : writeFail.kind === 'recovery'
                ? '恢复尚未完成。'
                : writeFail.kind === 'ready-recovery'
                  ? '已保存的规则尚未确认同步完成。'
                : '本次规则没有生效。'}</b>
          <div className="kv" style={{ marginTop: 4 }}>本页改动已保留。{writeFail.status === 'unknown' ? '请先核实实际结果，再决定下一步。' : '请按上方状态提示处理，或重新读取线上规则后核对。'}</div>
          <details className="inline-help">
            <summary>查看本次操作技术详情</summary>
            <p className="kv">{writeFail.why}</p>
            <p className="kv mono" style={{ overflowWrap: 'anywhere' }}>错误码：{writeFail.code}{writeFail.operationId && ` · 操作 ID：${writeFail.operationId}`}</p>
          </details>
          <div className="row" style={{ marginTop: 8 }}>
            {writeFail.status === 'unknown' ? (
              <button className="btn sm" disabled={applying} onClick={() => void verifyUnknown()}>{applying ? '读取中…' : '重新读取实际状态'}</button>
            ) : writeFail.kind === 'ready-recovery' && st.authority.status === 'ready' && st.degraded ? (
              <button className="btn sm" disabled={applying} onClick={() => void rematerializeReady()}>{applying ? '重试中…' : '重试同步'}</button>
            ) : !writeFail.code.startsWith('geo-update-conflict')
              && !writeFail.code.startsWith('geo-update-recovery')
              && !writeFail.code.startsWith('geo-operation-id-conflict')
              && !writeFail.code.startsWith('geo-high-traffic-')
              && !writeFail.code.startsWith('geo-recovery-')
              && !writeFail.code.startsWith('geo-bootstrap-') ? (
              <button className="btn sm" disabled={applying} onClick={() => { setWriteFail(null); void apply(); }}>{applying ? '重试中…' : '重试写入'}</button>
            ) : null}
            {writeFail.status === 'known' && (
              <button
                className="btn ghost sm"
                onClick={() => void (async () => {
                  const next = await load();
                  if (next) await syncShell(next.rules, next.degraded);
                })()}
              >放弃并重新读取线上规则</button>
            )}
          </div>
        </div>
      )}

      {confirmBox && writeFail?.status !== 'unknown' && (
        <div className="card" style={{ marginBottom: 16, outline: '2px solid var(--warn)' }}>
          <h3>确认应用屏蔽规则变更?</h3>
          <p className="kv">变更后约 1 分钟全球生效;本操作进入审计。目标:{confirmBox.rules.enabled ? `开启,名单 [${confirmBox.rules.countries.join(', ') || '空'}]` : '停用(所有地区可访问)'}</p>
          {confirmBox.hot && (
            <div className="note bad">
              ⚠ 误伤护栏:{confirmBox.hot.map((h) => `${h.country} ${countryName(h.country)} 占近 7 天流量 ${(h.share * 100).toFixed(1)}%`).join(';')}——这是主要市场流量。
              <label className="row" style={{ marginTop: 8, gap: 8 }}>
                <input type="checkbox" style={{ width: '1rem', height: '1rem' }} checked={confirmBox.ack} onChange={(ev) => setConfirmBox({ ...confirmBox, ack: ev.target.checked })} />
                我知道这会拦截主要市场流量
              </label>
            </div>
          )}
          <div className="field"><label htmlFor="geo-reason">理由（必填，至少 8 字）</label>
            <textarea id="geo-reason" value={confirmBox.reason} onChange={(ev) => setConfirmBox({ ...confirmBox, reason: ev.target.value })} placeholder="例:合规要求,上线前开启大陆屏蔽" /></div>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn ghost" onClick={() => setConfirmBox(null)}>取消</button>
            <button className="btn primary" disabled={applying || (!!confirmBox.hot && !confirmBox.ack)} onClick={() => void apply()}>
              {applying ? '写入中…' : confirmBox.hot ? '仍然应用' : '确认应用'}
            </button>
          </div>
        </div>
      )}

      <h3 className="section-label">拦截概况</h3>
      <div className="field-grid">
        <div className="card"><h3>今日拦截(实时)</h3><div className="mono" style={{ fontSize: 'var(--text-metric)', fontWeight: 600 }}>{st.stats.todayLive}</div><div className="kv">仅页面级请求;直通与资产不计。同一来源每分钟超 120 次的洪水流量会被采样记录,此时该数字是<b>下限</b></div></div>
        <div className="card"><h3>近 7 天拦截</h3><div className="mono" style={{ fontSize: 'var(--text-metric)', fontWeight: 600 }}>{st.stats.blocked7}</div><div className="kv">占总请求 {(st.stats.shareOfRequests * 100).toFixed(1)}%(口径:拦截数 ÷ 拦截+人类访问)</div></div>
        <div className="card">
          <h3>被拦区域 TopN(近 7 天)</h3>
          {st.stats.last7.length === 0 ? (
            <p className="kv">{st.rules.enabled ? '暂无拦截记录' : '屏蔽未启用,暂无数据'}</p>
          ) : (
            <table>{st.stats.last7.map((x) => (
              <tbody key={x.country}><tr><td>{x.country} {countryName(x.country)}</td><td className="mono" style={{ textAlign: 'right' }}><b>{x.hits}</b></td></tr></tbody>
            ))}</table>
          )}
        </div>
      </div>
    </section>
  );
}
