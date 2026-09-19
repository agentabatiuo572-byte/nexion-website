import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../api';
import { useShell, useUnsavedChanges } from '../shell';
import { DefaultTranslationActions, TranslationTasks, translationError } from '../lib/translations';

type AiProvider = 'zen' | 'gemini' | 'openai' | 'anthropic' | 'deepseek' | 'groq' | 'openrouter';
export interface AiConnectionView {
  provider: AiProvider; model: string; allowedModels: string[]; configured: boolean; encryptionReady: boolean;
  providers: { id: AiProvider; name: string; defaultModel: string; allowedModels: string[] }[];
  credentialRev: number; activeRevision: number; settingsRev: number; executionRev: number; enabled: boolean;
  status: string; ready: boolean; operationSeq: number; operationId: string | null; operationStatus: string;
  operationError: string | null; lastTestAt: number | null; busy: boolean; dailyCharacterLimit: number;
  scanStatus?: 'not-needed' | 'queued' | 'retry';
  usage: { day: string; sentCharacters: number; calls: number; inputTokens: number; outputTokens: number; unknownCalls: number };
}
const statusText: Record<string, string> = {
  unconfigured: '尚未配置', available: '连接可用', 'invalid-key': '密钥无效', 'permission-denied': '缺少模型权限',
  'model-unavailable': '模型不可用', 'quota-exhausted': '服务额度不足', 'rate-limited': '暂时限流',
  'billing-required': '付款或额度未就绪',
  'provider-unavailable': '服务暂不可用', 'network-error': '连接中断', 'encryption-unavailable': '服务端加密配置缺失',
  'decryption-failed': '已有密钥无法解密', running: '处理中', succeeded: '已成功', failed: '未成功', unknown: '结果待确认', cancelled: '已取消', idle: '尚未执行',
};
function allowedModel(provider: AiConnectionView['providers'][number] | undefined, candidate: string) {
  return provider?.allowedModels.includes(candidate) ? candidate
    : provider?.allowedModels.includes(provider.defaultModel) ? provider.defaultModel : provider?.allowedModels[0] ?? '';
}

export default function AiPage() {
  const location = useLocation();
  const [tasksOpen, setTasksOpen] = useState(location.hash === '#translation-tasks');
  const { reload } = useShell();
  const [connection, setConnection] = useState<AiConnectionView | null>(null), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [apiKey, setApiKey] = useState(''), [model, setModel] = useState<string | null>(null), [limit, setLimit] = useState<string | null>(null);
  const [provider, setProvider] = useState<AiProvider | null>(null);
  const [busy, setBusy] = useState(false), [confirmRemove, setConfirmRemove] = useState(false);
  const candidateBase = useRef<{ credential: number; sequence: number } | null>(null);
  const settingsBase = useRef<number | null>(null);
  const readGeneration = useRef(0);
  useUnsavedChanges(Boolean(apiKey || limit !== null || model !== null || provider !== null));
  const refresh = useCallback(async () => {
    const generation = ++readGeneration.current;
    try {
      const next = await api<AiConnectionView>('/api/ai/connection');
      if (generation !== readGeneration.current) return null;
      setConnection(next); return next;
    } catch { if (generation === readGeneration.current) setError('AI 连接状态读取失败，请重试。'); return null; }
  }, []);
  useEffect(() => { void refresh(); return () => { readGeneration.current++; }; }, [refresh]);
  useEffect(() => {
    if (!connection?.busy) return;
    const timer = window.setInterval(() => { void refresh(); }, 3000);
    return () => clearInterval(timer);
  }, [connection?.busy, refresh]);
  const selectedProvider = connection?.providers.find(value => value.id === (provider ?? connection.provider));
  const selectedModel = allowedModel(selectedProvider, model ?? connection?.model ?? '');
  const captureCandidate = () => {
    if (!candidateBase.current && connection) {
      candidateBase.current = { credential: connection.credentialRev, sequence: connection.operationSeq };
      setProvider(value => value ?? connection.provider);
      setModel(selectedModel);
    }
  };

  async function test(save: boolean) {
    if (!connection || busy || !connection.encryptionReady || (save && (!selectedProvider || !selectedProvider.allowedModels.includes(selectedModel)))) return;
    const base = save ? candidateBase.current ?? { credential: connection.credentialRev, sequence: connection.operationSeq } : { credential: connection.credentialRev, sequence: connection.operationSeq };
    const operationId = crypto.randomUUID();
    const key = apiKey;
    readGeneration.current++;
    setApiKey(''); setBusy(true); setError(''); setMessage('');
    try {
      const next = await api<AiConnectionView>(save ? '/api/ai/connection' : '/api/ai/connection/test', {
        method: save ? 'PUT' : 'POST', body: JSON.stringify({ expectedCredentialRev: base.credential, expectedOperationSeq: base.sequence,
          operationId, ...(save ? { provider: selectedProvider!.id, model: selectedModel, apiKey: key } : {}) }),
      });
      setConnection(next); setModel(null); setProvider(null);
      setMessage(next.operationStatus === 'succeeded' ? save ? '连接已测试并保存，可以使用输入框旁的 AI 翻译。' : '当前连接测试成功。' : `操作${statusText[next.operationStatus] ?? '等待确认'}，请查看最新状态。`);
    } catch (e) {
      setError(translationError(e));
      const current = await refresh();
      if (current?.operationId === operationId) setMessage(`本次操作${statusText[current.operationStatus] ?? '等待确认'}；请先核对结果，再发起新的测试。`);
    } finally { candidateBase.current = null; setBusy(false); }
  }
  async function settings(change: { enabled?: boolean; dailyCharacterLimit?: number }) {
    if (!connection || busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const next = await api<AiConnectionView>('/api/ai/settings', { method: 'PATCH', body: JSON.stringify({ expectedSettingsRev: settingsBase.current ?? connection.settingsRev, ...change }) });
      setConnection(next); setLimit(null); settingsBase.current = null;
      setMessage(next.scanStatus === 'retry' ? '已启用，缺项扫描未完成，请在高级设置点击一键补译缺项重试。' : change.enabled === false ? '自动补译已关闭，输入框旁的 AI 翻译仍可使用。' : 'AI 设置已保存并即时生效。');
    } catch (e) { setError(translationError(e)); await refresh(); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!connection || busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const next = await api<AiConnectionView>('/api/ai/connection', { method: 'DELETE', body: JSON.stringify({ expectedCredentialRev: connection.credentialRev }) });
      setConnection(next); setModel(null); setProvider(null); setApiKey(''); candidateBase.current = null; setConfirmRemove(false);
      setMessage('后台连接已移除，AI 翻译已关闭；已有译文及今日用量保留。');
    } catch (e) { setError(translationError(e)); await refresh(); }
    finally { setBusy(false); }
  }
  const limitNumber = Number(limit ?? connection?.dailyCharacterLimit);
  const validLimit = Number.isInteger(limitNumber) && limitNumber >= 1000 && limitNumber <= 500000;
  return <section className="editor-page ai-page"><header className="page-heading"><span className="eyebrow">网站管理</span><h2>AI 翻译设置</h2><p className="page-description">连接后，点击文案输入框旁的「AI 翻译」，生成译文并继续编辑，最后保存草稿。</p></header>
    {error && <div className="note bad" role="alert">{error} <button className="btn ghost" disabled={busy} onClick={() => { setError(''); void refresh(); }}>刷新状态</button></div>}
    {message && <p className="note info" role="status">{message}</p>}
    {!connection ? <div className="skl" aria-label="正在读取 AI 配置" /> : <>
      <section className="card"><div className="row"><h3>AI 服务连接</h3><span className={`pill ${connection.ready ? 'brand' : 'warn'}`}>{statusText[connection.status] ?? '状态待核对'}</span></div>
        <p className="kv">{connection.configured ? `已保存连接 · 修订 ${connection.credentialRev}` : '尚未保存 API Key'}{connection.lastTestAt ? ` · 最近测试 ${new Date(connection.lastTestAt).toLocaleString('zh-CN')}` : ''}</p>
        {connection.configured && <p className="kv">当前连接：{connection.providers.find(value => value.id === connection.provider)?.name ?? connection.provider} · {connection.model}</p>}
        {!connection.encryptionReady && <p className="note warn">服务端加密配置尚未就绪，暂不能测试或保存密钥。网站和发布功能仍可使用。</p>}
        <form onSubmit={(event) => { event.preventDefault(); void test(true); }}>
          <div className="field"><label htmlFor="ai-provider">AI 服务商</label><select id="ai-provider" value={provider ?? connection.provider} disabled={busy} onChange={(event) => {
            const next = connection.providers.find(value => value.id === event.target.value);
            if (!next) return;
            captureCandidate(); setProvider(next.id); setModel(allowedModel(next, next.defaultModel)); setApiKey(''); setError(''); setMessage('');
          }}>{connection.providers.map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select></div>
          <div className="field-grid"><div className="field"><label htmlFor="ai-model">翻译模型</label><select id="ai-model" value={selectedModel} disabled={busy} onChange={(event) => { captureCandidate(); setModel(event.target.value); }}>{selectedProvider?.allowedModels.map((value) => <option key={value} value={value}>{value}</option>)}</select></div>
            <div className="field"><label htmlFor="ai-key">{selectedProvider?.name ?? 'AI'} API Key</label><input id="ai-key" type="password" autoComplete="off" spellCheck={false} value={apiKey} disabled={busy} placeholder={connection.configured ? '输入新密钥以替换现有连接' : '输入 API Key'} onChange={(event) => { captureCandidate(); setApiKey(event.target.value); }} /></div></div>
          <p className="kv">测试会发送一条固定短句，产生少量 API 用量。密钥提交后清空，不会回显。</p>
          <div className="row"><button type="submit" className="btn primary" disabled={busy || connection.busy || !connection.encryptionReady || !apiKey.trim() || !selectedProvider?.allowedModels.includes(selectedModel)}>{busy ? '处理中…' : '测试并保存'}</button>
            <button type="button" className="btn ghost" disabled={busy || connection.busy || !connection.configured || !connection.encryptionReady} onClick={() => void test(false)}>测试当前连接</button>
            <button type="button" className="btn ghost" disabled={busy || !connection.configured} onClick={() => setConfirmRemove(true)}>移除配置</button></div>
        </form>
        {confirmRemove && <div className="note warn" role="alert">移除后台配置会暂停新任务，保留已有译文；这不会撤销服务商账户中的 Key。
          <button className="btn" disabled={busy} onClick={() => void remove()}>确认移除配置</button><button className="btn ghost" onClick={() => setConfirmRemove(false)}>取消</button></div>}
        {connection.operationId && <p className="kv">最近操作：{statusText[connection.operationStatus] ?? '结果待确认'}。{connection.operationStatus === 'unknown' && '请先刷新确认，避免重复发起付费测试。'}</p>}
      </section>
      <section className="card"><h3>翻译与用量</h3><label className="row tap44"><input type="checkbox" checked={connection.enabled} disabled={busy || limit !== null || (!connection.ready && !connection.enabled)} onChange={(event) => void settings({ enabled: event.target.checked })} />自动补译缺项</label><p className="kv">开启后在后台补译缺项；关闭时仍可逐项点击 AI 翻译。{limit !== null && '先保存用量上限，再切换自动补译。'}</p>
        <div className="field"><label htmlFor="ai-daily-limit">每日发送字符上限</label><input id="ai-daily-limit" type="number" min={1000} max={500000} step={1000} value={limit ?? connection.dailyCharacterLimit} disabled={busy} onChange={(event) => { if (settingsBase.current === null) settingsBase.current = connection.settingsRev; setLimit(event.target.value); }} /></div>
        {!validLimit && <p className="note bad">上限须为 1,000–500,000 之间的整数。</p>}<button className="btn" disabled={busy || limit === null || !validLimit} onClick={() => void settings({ dailyCharacterLimit: limitNumber })}>保存用量上限</button>
        <p className="kv">UTC 日期 {connection.usage.day} · 已发送 {connection.usage.sentCharacters.toLocaleString()} 字符 · {connection.usage.calls} 次调用 · 已知输入/输出 token {connection.usage.inputTokens}/{connection.usage.outputTokens}{connection.usage.unknownCalls > 0 ? ` · ${connection.usage.unknownCalls} 次用量待确认` : ''}。字符上限不是账单金额。</p>
      </section>
    </>}
    <details className="card" id="translation-tasks" open={tasksOpen} onToggle={(event) => setTasksOpen(event.currentTarget.open)}><summary>高级：批量补译与任务</summary><DefaultTranslationActions onChanged={reload} /><TranslationTasks /></details>
  </section>;
}
