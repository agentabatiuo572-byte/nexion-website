import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api';
import { fieldEditorLink } from './field-target';
import { humanPath, LOCALE_NAME } from './human-path';
import { SOURCE_LOCALE } from '../../../schema/src/locales';

export interface TranslationStateView {
  fieldId: string; targetLocale: string; draftFieldId: string; origin: 'seed' | 'ai' | 'manual' | 'none';
  generation: number; stale: boolean; reviewNeeded?: boolean; missing: boolean; sourceHash: string; targetValue: string; required: boolean;
  jobStatus?: string | null; jobErrorCode?: string | null;
}
export interface TranslationTaskView {
  id: string; status: string; fieldId: string; targetLocale: string; intent: string; errorCode: string | null;
  sourceHash: string | null; targetValue: string | null; createdAt: number; updatedAt: number; attempts: number; canRetry: boolean;
}
export interface TranslationOverview {
  draftRev: number; counts: Record<string, number>; states: TranslationStateView[]; items: TranslationTaskView[]; nextCursor: string | null;
}
interface TranslationContextValue { data: TranslationOverview | null; error: string | null; refresh: () => Promise<void> }
const TASK_ERRORS: Record<string, string> = {
  'invalid-key': '密钥无效，请到 AI 设置检查连接', 'permission-denied': '连接缺少模型权限', 'model-unavailable': '模型暂不可用',
  'quota-exhausted': '服务额度不足', 'rate-limited': '服务暂时限流', 'provider-unavailable': '翻译服务暂不可用',
  'billing-required': '付款或额度未就绪',
  'network-error': '连接中断，可重试', 'invalid-result': '返回内容未通过校验，未写入草稿', 'response-too-large': '返回内容过长，未写入草稿',
  'needs-retry': '连接已切换，请确认后重试', 'connection-changed': '连接已切换，旧结果失效', 'interrupted': '处理曾中断，请检查后重试',
  'cancelled': '任务已停止', 'too-long': '待翻译文本超过单次限制', 'provider-rejected': '服务拒绝本次请求', 'invalid-input': '待翻译内容不符合要求',
};
const TranslationContext = createContext<TranslationContextValue>({ data: null, error: null, refresh: async () => {} });
export const useTranslations = () => useContext(TranslationContext);
export const translationError = (error: unknown) => error instanceof ApiError && typeof error.body.message === 'string'
  ? error.body.message : error instanceof ApiError && error.status === 409 ? '内容已变化，本次操作未应用；当前编辑已保留，请核对最新内容。' : '操作未完成，请刷新状态后重试。';

export function TranslationProvider({ children, draftRevision, onDraftChanged }: { children: ReactNode; draftRevision?: number; onDraftChanged: () => Promise<unknown> }) {
  const [data, setData] = useState<TranslationOverview | null>(null), [error, setError] = useState<string | null>(null);
  const current = useRef({ draftRevision, onDraftChanged }); current.current = { draftRevision, onDraftChanged };
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const token = ++generation.current;
    try {
      const next = await api<TranslationOverview>('/api/translations');
      if (token !== generation.current) return;
      setData(next); setError(null);
      if (typeof next.draftRev === 'number' && current.current.draftRevision !== undefined && next.draftRev > current.current.draftRevision) await current.current.onDraftChanged();
    } catch { if (token === generation.current) setError('翻译状态读取失败，已有编辑仍保留。'); }
  }, []);
  useEffect(() => { void refresh(); }, [draftRevision, refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') void refresh(); }, 5000);
    return () => { clearInterval(timer); generation.current++; };
  }, [refresh]);
  return <TranslationContext.Provider value={{ data, error, refresh }}>{children}</TranslationContext.Provider>;
}

export function DefaultTranslationActions({ disabled = false, onChanged }: { disabled?: boolean; onChanged?: () => Promise<unknown> }) {
  const { refresh } = useTranslations();
  const [preview, setPreview] = useState<number | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  async function run(mode: 'preview' | 'defaults' | 'missing') {
    if (disabled || busy) return;
    setBusy(true); setMessage('');
    try {
      if (mode === 'missing') { const response = await api<{ queued?: number }>('/api/translations', { method: 'POST', body: JSON.stringify({ mode: 'missing' }) }); setMessage(`补译待办已建立${typeof response.queued === 'number' ? ` · ${response.queued} 项` : ''}，译文写入草稿后仍需发布。`); }
      else {
        const response = await api<{ applied: number; skipped: number; draftRev: number }>('/api/translations/defaults', { method: 'POST', body: JSON.stringify({ dryRun: mode === 'preview' }) });
        if (mode === 'preview') setPreview(response.applied);
        else { setPreview(null); setMessage(`已补齐 ${response.applied} 项默认译文 · 草稿 r${response.draftRev} · 未发布`); }
      }
      if (mode !== 'preview') { await refresh(); await onChanged?.(); }
    } catch (error) { setMessage(translationError(error)); }
    finally { setBusy(false); }
  }
  return <div className="card"><h3>准备其它语言</h3><p className="kv">优先复用与当前{LOCALE_NAME[SOURCE_LOCALE]}源文匹配的已有默认译文；不覆盖人工内容。AI 只处理需要补译的草稿字段。</p>
    <div className="row"><button type="button" className="btn ghost" disabled={disabled || busy} onClick={() => void run('preview')}>查看可补齐默认文案</button><button type="button" className="btn" disabled={disabled || busy} onClick={() => void run('missing')}>一键补译缺项</button></div>
    {preview !== null && <div className="note info">当前可确定补齐 {preview} 项。
      <button type="button" className="btn primary" disabled={disabled || busy || preview === 0} onClick={() => void run('defaults')}>补齐默认文案</button></div>}
    {disabled && <p className="kv">先保存本页改动，再补齐译文。</p>}{message && <p role="status">{message}</p>}
  </div>;
}

export function TranslationTasks() {
  const { data, error, refresh } = useTranslations();
  const [extra, setExtra] = useState<TranslationTaskView[]>([]), [cursor, setCursor] = useState<string | null>(null), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const statuses: Record<string, string> = { pending: '待处理', running: '处理中', succeeded: '已完成', failed: '失败', obsolete: '已过期', cancelled: '已取消', missing: '缺译', stale: '原文已更新', ready: '已准备', manualReview: '人工待复核' };
  const items = [...(data?.items ?? []), ...extra.filter((item) => !data?.items.some((first) => first.id === item.id))];
  async function update(item: TranslationTaskView, action: 'retry' | 'cancel') {
    setBusy(true); setNotice('');
    try { await api(`/api/translations/${action}`, { method: 'POST', body: JSON.stringify(action === 'cancel' ? { ids: [item.id] } : { items: [{ id: item.id, sourceHash: item.sourceHash, targetValue: item.targetValue }] }) }); setExtra([]); setCursor(null); await refresh(); }
    catch (e) { setNotice(translationError(e)); await refresh(); }
    finally { setBusy(false); }
  }
  async function more() {
    const next = cursor ?? data?.nextCursor;
    if (!next || busy) return;
    setBusy(true);
    try { const page = await api<TranslationOverview>(`/api/translations?cursor=${encodeURIComponent(next)}`); setExtra((rows) => [...rows, ...page.items]); setCursor(page.nextCursor ?? ''); }
    catch (e) { setNotice(translationError(e)); }
    finally { setBusy(false); }
  }
  return <section className="card"><div className="row"><h3>翻译任务</h3><span className="spacer" /><button type="button" className="btn ghost" disabled={busy} onClick={() => { setExtra([]); setCursor(null); void refresh(); }}>刷新任务</button></div>
    {(error || notice) && <p className="note bad" role="alert">{error ?? notice}</p>}
    <div className="row">{Object.entries(data?.counts ?? {}).map(([status, count]) => <span className="pill" key={status}>{statuses[status] ?? status} {count}</span>)}</div>
    {!data ? <p className="kv">正在读取翻译状态…</p> : !items.length ? <p className="kv">暂无翻译任务</p> : <div className="table-wrap"><table><thead><tr><th>字段</th><th>语言</th><th>状态</th><th>操作</th></tr></thead><tbody>{items.map((item) => {
      const field = data.states.find((entry) => entry.fieldId === item.fieldId && entry.targetLocale === item.targetLocale);
      return <tr key={item.id}><td>{field ? <Link to={fieldEditorLink(field.draftFieldId)}>{humanPath(field.draftFieldId)}</Link> : '原字段已删除'}</td><td>{LOCALE_NAME[item.targetLocale] ?? item.targetLocale}</td><td>{statuses[item.status] ?? '状态未识别'}{item.errorCode && <div className="kv">{TASK_ERRORS[item.errorCode] ?? '任务未完成，请检查 AI 连接后重试'}</div>}</td><td><div className="row">{item.canRetry && <button className="btn ghost sm" disabled={busy} onClick={() => void update(item, 'retry')}>重试</button>}{['pending', 'running', 'failed'].includes(item.status) && <button className="btn ghost sm" disabled={busy} onClick={() => void update(item, 'cancel')}>取消任务</button>}</div></td></tr>;
    })}</tbody></table></div>}
    {(cursor ?? data?.nextCursor) && <button className="btn ghost" disabled={busy} onClick={() => void more()}>加载更多</button>}
  </section>;
}
