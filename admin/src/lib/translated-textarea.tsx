import { useEffect, useRef, useState, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { api, toast } from '../api';
import { AutoTextarea } from './auto-textarea';
import { TextLimitHint } from './text-limit-hint';
import { translationError, useTranslations } from './translations';
import type { Locale } from '../../../schema/src/locales';
import { SOURCE_LOCALE } from './locale-editor';

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'id'> & {
  id: string; label: ReactNode; draftFieldId: string; targetLocale: Locale;
  source: string; value: string; onValueChange: (value: string) => void;
};

/** A suggestion changes only the page's working copy, through its normal edit handler. */
export function TranslatedTextarea({ id, label, draftFieldId, targetLocale, source, value, onValueChange, ...textarea }: Props) {
  const { data } = useTranslations();
  const field = data?.states.find((item) => item.draftFieldId === draftFieldId);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const editable = !textarea.disabled && !textarea.readOnly;
  const mounted = useRef(false), inFlight = useRef(false), editVersion = useRef(0);
  const current = useRef({ draftFieldId, targetLocale, source, value, editable, onValueChange });
  const previous = current.current;
  if (previous.draftFieldId !== draftFieldId || previous.targetLocale !== targetLocale || previous.source !== source || previous.value !== value || previous.editable !== editable) editVersion.current++;
  current.current = { draftFieldId, targetLocale, source, value, editable, onValueChange };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; editVersion.current++; }; }, []);

  async function translate() {
    if (inFlight.current || !editable || targetLocale === SOURCE_LOCALE || !source.trim()) return;
    const started = { ...current.current, editVersion: editVersion.current };
    inFlight.current = true; setBusy(true); setNotice('');
    try {
      const result = await api<{ text: string }>('/api/ai/translate', { method: 'POST', body: JSON.stringify({ source: started.source, targetLocale: started.targetLocale }) });
      if (!mounted.current) { toast('编辑位置已切换，本次译文未填入。可在当前字段重新翻译。'); return; }
      if (editVersion.current !== started.editVersion) { setNotice('内容已修改，本次译文未填入，已保留当前输入。'); return; }
      if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('invalid-translation');
      current.current.onValueChange(result.text);
      setNotice('已填入，可继续修改；尚未保存。');
    } catch (error) {
      if (mounted.current) setNotice(translationError(error));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const status = !value.trim() ? '缺译' : field && field.targetValue !== value ? '未保存' : field?.origin === 'seed' ? '默认译文' : field?.origin === 'ai' ? 'AI 译文' : field?.origin === 'manual' ? '人工维护' : '';
  return <>
    <div className="translation-input-label">
      <label htmlFor={id}>{label}</label>
      {status === '缺译' ? <button type="button" className="pill warn" title="点击定位到这一栏" onClick={() => { const input = document.getElementById(id); input?.focus(); input?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }}>缺译</button> : status && <span className="kv">{status}</span>}
      {targetLocale !== SOURCE_LOCALE && <button type="button" className="btn ghost sm" disabled={busy || !editable || !source.trim()} onClick={() => void translate()}>{busy ? '翻译中…' : 'AI 翻译'}</button>}
      {field?.jobStatus === 'running' && <span className="kv">自动翻译中</span>}
      {field?.jobStatus === 'failed' && <span className="kv">自动翻译失败，可重试</span>}
      {(field?.stale || field?.reviewNeeded) && <span className="kv">原文已更新</span>}
    </div>
    <AutoTextarea {...textarea} id={id} lang={targetLocale} value={value} aria-describedby={[textarea['aria-describedby'], id + '-length'].filter(Boolean).join(' ')} onChange={(event) => { if (editable) { editVersion.current++; onValueChange(event.target.value); } }} />
    <TextLimitHint id={id + '-length'} fieldId={draftFieldId} locale={targetLocale} value={value} />
    {notice && <p className="kv" role="status">{notice}</p>}
  </>;
}
