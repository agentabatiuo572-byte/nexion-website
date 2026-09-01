/* Legal(CON11 ⑤⑥):三文档 × 三语 Markdown + 白名单预览(标题/段落/列表/链接/强调——
   预览器只认这些,不渲染任何 HTML=白名单 by construction;服务端保存时另剥危险节点)。高敏。 */
import { useState, type ReactNode } from 'react';
import { useDraft } from '../lib/use-draft';
import { useFocusField } from '../lib/use-focus-field';

const DOCS: Array<['terms' | 'privacy' | 'appPrivacy', string]> = [
  ['terms', '使用条款'], ['privacy', '隐私政策'], ['appPrivacy', 'App 隐私政策'],
];

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
      else out.push(<a key={`${keyBase}-${i++}`} href={m[3]} style={{ color: 'var(--brand)' }} target="_blank" rel="noopener noreferrer">{m[2]}</a>);
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
      const size = [18, 15, 13.5][h[1]!.length - 1];
      blocks.push(<div key={n} style={{ fontSize: size, fontWeight: 600, margin: '10px 0 4px' }}>{inline(h[2]!, `h${n}`)}</div>);
    } else if (line.trim()) {
      blocks.push(<p key={n} style={{ margin: '4px 0', color: 'var(--ink2)' }}>{inline(line, `p${n}`)}</p>);
    }
  });
  flushList('ul-end');
  return blocks;
}

export default function LegalPage() {
  useFocusField(); // 「去修复」带来的 ?focus=<字段> 由它定位并高亮
  const { draft, saving, conflict, clearConflict, save, reload } = useDraft();
  const [doc, setDoc] = useState<'terms' | 'privacy' | 'appPrivacy'>('terms');
  const [loc, setLoc] = useState<'en' | 'vi' | 'zh'>('en');
  const [edits, setEdits] = useState<Record<string, string>>({});

  if (!draft) return <section><h2>Legal</h2><div className="skl" style={{ height: 80 }} /></section>;

  const key = `${doc}.${loc}`;
  const v = edits[key] ?? draft.legal[doc].md[loc];
  const dirty = Object.keys(edits).length > 0;
  const pending = v.includes('PENDING-TRUST-ASSETS');
  // 直接算不缓存:早退分支之后禁挂钩子(#310 实踩);md-lite 单文档渲染开销可忽略
  const preview = mdLite(v);

  return (
    <section>
      <h2>Legal <span className="pill warn">高敏 · 发布须理由</span></h2>
      <div className="note info">粘贴法务供稿的 Markdown;en 为法律约束文本,vi/zh 缺文时站上回退英文并提示(既有 EN-prevails 策略)。保存时服务端自动剥离脚本类危险内容并提示。</div>
      {conflict && <div className="note bad">草稿已在别处更新,保存被拒 <button className="btn ghost sm" onClick={() => { setEdits({}); clearConflict(); reload(); }}>刷新后重试</button></div>}
      <div className="row" style={{ marginBottom: 10 }}>
        {/* 「去修复」落点:红项形如 legal.privacy.md.en,一页只渲染选中的那一份文档,
            所以定位停在选择器上,让人看到该切到哪一份(同 seo 页) */}
        {DOCS.map(([d, label]) => <button key={d} className={`pill ${doc === d ? 'brand' : ''}`} style={{ cursor: 'pointer' }} data-field={`legal.${d}`} onClick={() => setDoc(d)}>{label}{edits[`${d}.en`] || edits[`${d}.vi`] || edits[`${d}.zh`] ? ' ·改' : ''}</button>)}
        <span className="kv">|</span>
        {(['en', 'vi', 'zh'] as const).map((l) => <button key={l} className={`pill ${loc === l ? 'brand' : ''}`} style={{ cursor: 'pointer' }} onClick={() => setLoc(l)}>{l}{l === 'en' && '(法律文本)'}</button>)}
        <span className="spacer" />
        <span className="kv">最后发布更新:{draft.legal[doc].updatedAt || '—'}</span>
      </div>
      {pending && <div className="note warn">仍含 PENDING-TRUST-ASSETS 占位——生产门(verify:prod)将拦截此页上线</div>}
      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div className="card" style={{ padding: 10 }}>
          <h3>Markdown 原文({key})</h3>
          <textarea rows={22} value={v} style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }} placeholder={loc === 'en' ? '# Terms of Service\n\n…(法务供稿)' : '留空 = 站上回退英文正文'}
            onChange={(e) => setEdits((s) => ({ ...s, [key]: e.target.value }))} />
        </div>
        <div className="card" style={{ maxHeight: 560, overflow: 'auto' }}>
          <h3>渲染预览(白名单:标题/段落/列表/链接/加粗)</h3>
          {v.trim() ? preview : <p className="kv">(空{loc !== 'en' && '——站上将回退英文正文并显示 EN-prevails 提示行'})</p>}
        </div>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn primary" disabled={!dirty || saving}
          onClick={async () => {
            const ok = await save((d) => {
              for (const [k2, val] of Object.entries(edits)) {
                const [dd, ll] = k2.split('.') as ['terms', 'en'];
                d.legal[dd].md[ll] = val;
              }
            });
            if (ok) setEdits({});
          }}>
          {saving ? '保存中…' : '保存草稿'}
        </button>
        {dirty && <button className="btn ghost" onClick={() => setEdits({})}>放弃本页未保存改动</button>}
      </div>
    </section>
  );
}
