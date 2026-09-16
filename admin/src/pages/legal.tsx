/* Legal(CON11 ⑤⑥):三文档 × 多语言 Markdown + 白名单预览(标题/段落/列表/链接/强调——
   预览器只认这些,不渲染任何 HTML=白名单 by construction;服务端保存时另剥危险节点)。高敏。 */
import { useState, type ReactNode } from 'react';
import { retainPostSubmit, submissionSnapshot } from '../lib/async-state';
import { useDraft } from '../lib/use-draft';
import { useFocusField } from '../lib/use-focus-field';
import { TextLimitHint } from '../lib/text-limit-hint';
import { LOCALE_NAME } from '../lib/human-path';
import { LocalePair, LocaleToolbar, SOURCE_LOCALE, useLocaleWorkspace, type Locale } from '../lib/locale-editor';

const DOCS: Array<['terms' | 'privacy' | 'appPrivacy', string]> = [
  ['terms', '使用条款'], ['privacy', '隐私政策'], ['appPrivacy', 'App 隐私政策'],
];
const fallbackHint = `当前语种留空时优先显示${LOCALE_NAME[SOURCE_LOCALE]}正文，源语言也为空时显示英文`;

/** md-lite:仅白名单元素;所有原文按纯文本处理(不解析内嵌 HTML) */
function mdLite(src: string): ReactNode {
  const inline = (s: string, keyBase: string): ReactNode[] => {
    const out: ReactNode[] = [];
    let rest = s;
    let i = 0;
    const RE = /\*\*([^*]+)\*\*|\[([^\]]+)\]\((https:\/\/[^\s)]+|\/[^\s)]*)\)/;
    while (rest) {
      const m = RE.exec(rest);
      if (!m) { out.push(rest); break; }
      if (m.index > 0) out.push(rest.slice(0, m.index));
      if (m[1]) out.push(<b key={`${keyBase}-${i++}`}>{m[1]}</b>);
      else out.push(<a key={`${keyBase}-${i++}`} href={m[3]} style={{ color: 'var(--brand-ink)' }} target="_blank" rel="noopener noreferrer">{m[2]}</a>);
      rest = rest.slice(m.index + m[0].length);
    }
    return out;
  };
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flushList = (k: string) => {
    if (list.length) blocks.push(<ul key={k} style={{ paddingLeft: 20, margin: '6px 0' }}>{list.map((li, j) => <li key={j}>{inline(li, `${k}-${j}`)}</li>)}</ul>);
    list = [];
  };
  src.split(/\r?\n/).forEach((line, n) => {
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const li = /^[-*]\s+(.*)$/.exec(line);
    if (li) { list.push(li[1]!); return; }
    flushList(`ul${n}`);
    if (h) {
      const size = ['var(--text-heading)', 'var(--text-lg)', 'var(--text-body)'][h[1]!.length - 1];
      blocks.push(<div key={n} style={{ fontSize: size, fontWeight: 600, margin: '10px 0 4px' }}>{inline(h[2]!, `h${n}`)}</div>);
    } else if (line.trim()) {
      blocks.push(<p key={n} style={{ margin: '4px 0', color: 'var(--ink2)' }}>{inline(line, `p${n}`)}</p>);
    }
  });
  flushList('ul-end');
  return blocks;
}

export default function LegalPage() {
  const language = useLocaleWorkspace();
  const [doc, setDoc] = useState<'terms' | 'privacy' | 'appPrivacy'>('terms');
  const loc = language.target;
  const [edits, setEdits] = useState<Record<string, string>>({});
  const dirty = Object.keys(edits).length > 0;
  const { draft, saving, conflict, clearConflict, save, reload } = useDraft(dirty);
  useFocusField((target) => {
    const found = DOCS.find(([id]) => id === target.segments[1]);
    if (target.area === 'legal' && found) setDoc(found[0]);
  }, !!draft);

  if (!draft) return <section><h2>Legal</h2><div className="skl" style={{ height: 80 }} /></section>;

  const key = `${doc}.${loc}`;
  const v = edits[key] ?? draft.legal[doc].md[loc] ?? '';
  const pending = v.includes('PENDING-TRUST-ASSETS');
  // 直接算不缓存:早退分支之后禁挂钩子(#310 实踩);md-lite 单文档渲染开销可忽略
  const preview = mdLite(v);

  return (
    <section className="editor-page">
      <header className="page-heading">
        <span className="eyebrow">内容管理</span>
        <h2>法律文档 <span className="pill warn">高敏 · 发布须理由</span></h2>
        <p className="page-description">按语言更新使用条款与隐私政策，可对照参考并展开预览。保存草稿后需发布。</p>
      </header>
      <LocaleToolbar workspace={language} enabledLocales={draft.enabledLocales} optional gaps={DOCS.filter(([id]) => !(edits[`${id}.${loc}`] ?? draft.legal[id].md[loc] ?? '').trim()).map(([id, label]) => ({ path: `legal.${id}.md.${loc}`, label }))} />
      <div className="note info">请使用法务提供的 Markdown 正文。英文为法律约束文本。{fallbackHint}；非英语页面回退英文时会提示。保存会自动移除危险脚本。</div>
      {conflict && <div className="note bad">草稿已在别处更新,保存被拒 <button className="btn ghost sm" onClick={() => { setEdits({}); clearConflict(); reload(); }}>刷新后重试</button></div>}
      <div className="row" style={{ marginBottom: 10 }}>
        {/* 深链可自动选择文档和目标语言，按钮同时保留文档层级的定位入口。 */}
        {DOCS.map(([d, label]) => <button key={d} className={`pill ${doc === d ? 'brand' : ''}`} aria-pressed={doc === d} style={{ cursor: 'pointer' }} data-field={`legal.${d}`} onClick={() => setDoc(d)}>{label}{Object.keys(edits).some((k) => k.startsWith(`${d}.`)) ? ' · 已改' : ''}</button>)}
        <span className="spacer" />
        <span className="kv">最后发布更新:{draft.legal[doc].updatedAt || '—'}</span>
      </div>
      {pending && <div className="note warn">仍含 PENDING-TRUST-ASSETS 占位——生产门(verify:prod)将拦截此页上线</div>}
      <LocalePair workspace={language} reference={language.reference ? edits[`${doc}.${language.reference}`] ?? draft.legal[doc].md[language.reference] ?? '' : ''} label="Markdown 正文">
        <div className="card" style={{ padding: 10 }}>
          <h3><label htmlFor="legal-source">{LOCALE_NAME[loc]}正文 · Markdown</label></h3>
          <textarea lang={loc} id="legal-source" aria-describedby="legal-source-length" data-field={`legal.${doc}.md.${loc}`} rows={22} value={v} style={{ fontFamily: 'var(--mono)', fontSize: 'var(--text-body)' }} placeholder={loc === SOURCE_LOCALE ? '# 服务条款\n\n…(法务供稿)' : fallbackHint}
            onChange={(e) => setEdits((s) => ({ ...s, [key]: e.target.value }))} />
          <TextLimitHint id="legal-source-length" fieldId={'/legal/' + doc + '/md/' + loc} locale={loc} value={v} />
        </div>
      </LocalePair>
        <details className="card legal-preview">
          <summary>正文预览</summary>
          <p className="kv">支持标题、段落、列表、链接和加粗。</p>
          {v.trim() ? preview : <p className="kv">{fallbackHint}；非英语页面回退英文时会提示。</p>}
        </details>
      <div className="editor-actions">
        <button className="btn primary" disabled={!dirty || saving}
          onClick={async () => {
            const submitted = submissionSnapshot(edits);
            const ok = await save((d) => {
              for (const [k2, val] of Object.entries(submitted)) {
                const [dd, ll] = k2.split('.') as [typeof doc, Locale];
                d.legal[dd].md[ll] = val;
              }
            });
            if (ok) setEdits((current) => retainPostSubmit(current, submitted, {}));
          }}>
          {saving ? '保存中…' : '保存草稿'}
        </button>
        {dirty && <button className="btn ghost" onClick={() => setEdits({})}>放弃本页未保存改动</button>}
      </div>
    </section>
  );
}
