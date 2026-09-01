/* SEO 与页脚(CON10 ⑤⑥):6 页 title/description 三语(长度软警)+ 联系邮箱(空=站上隐藏联系行)。
   页脚披露句/导航文案归文案树(⑦ 不双源);社媒清单=现网集(当前为空,站上落地后接入)。 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AutoTextarea } from '../lib/auto-textarea';
import { useDraft, type Tri } from '../lib/use-draft';
import { useFocusField } from '../lib/use-focus-field';

const PAGES: Array<[string, string]> = [
  ['home', '首页'], ['learn', '学习中心'], ['nex', 'NEX'],
  ['legal-privacy', '隐私政策'], ['legal-terms', '使用条款'], ['legal-app-privacy', 'App 隐私'],
];

export default function SeoPage() {
  useFocusField(); // 「去修复」带来的 ?focus=<字段> 由它定位并高亮
  const { draft, saving, conflict, clearConflict, save, reload } = useDraft();
  const [pid, setPid] = useState('home');
  const [edits, setEdits] = useState<Record<string, { title?: Partial<Tri>; description?: Partial<Tri> }>>({});
  const [email, setEmail] = useState<string | null>(null);

  if (!draft) return <section><h2>SEO 与页脚</h2><div className="skl" style={{ height: 80 }} /></section>;

  const page = draft.seo.pages[pid] ?? { title: { en: '', vi: '', zh: '' }, description: { en: '', vi: '', zh: '' } };
  const cur = (field: 'title' | 'description', l: 'en' | 'vi' | 'zh') => edits[pid]?.[field]?.[l] ?? page[field][l];
  const mail = email ?? draft.footer.contactEmail;
  const mailErr = mail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail) ? '邮箱格式不合法' : '';
  const dirty = Object.keys(edits).length > 0 || email !== null;

  return (
    <section>
      <h2>SEO 与页脚</h2>
      {conflict && <div className="note bad">草稿已在别处更新,保存被拒 <button className="btn ghost sm" onClick={() => { setEdits({}); setEmail(null); clearConflict(); reload(); }}>刷新后重试</button></div>}
      <div className="row" style={{ marginBottom: 10 }}>
        {/* 红项可能指向**当前没选中**的那一页,而这一页只渲染选中的那个。
            所以选择器按钮也是落点:定位会停在这里,人一眼看到该切到哪一页去改。
            (真正的根治是钩子能驱动页面切换,那要求路径带结构而不是一串点号——
             见 docs/changes/2026-09-01-cross-surface-string-structural-reflection.md) */}
        {PAGES.map(([id, label]) => (
          <button key={id} className={`pill ${pid === id ? 'brand' : ''}`} style={{ cursor: 'pointer' }} data-field={`seo.pages.${id}`} onClick={() => setPid(id)}>{label}</button>
        ))}
      </div>
      {(['title', 'description'] as const).map((field) => (
        // 「去修复」落点:红项路径形如 seo.pages.home.title.zh,逐级剥尾会停在这一级
        <div className="card" key={field} style={{ marginBottom: 10 }} data-field={`seo.pages.${pid}.${field}`}>
          <h3>{field === 'title' ? '标题 title(建议 ≤60 字符)' : '描述 description(建议 ≤160 字符)'}</h3>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
            {(['en', 'vi', 'zh'] as const).map((l) => {
              const v = cur(field, l);
              const limit = field === 'title' ? 60 : 160;
              return (
                <div className="field" key={l} style={{ margin: 0 }}>
                  <label>{l}<span className="kv" style={{ marginLeft: 6, color: v.length > limit ? 'var(--warn)' : undefined }}>{v.length}/{limit}</span></label>
                  <AutoTextarea value={v}
                    onChange={(ev) => setEdits((s) => ({ ...s, [pid]: { ...s[pid], [field]: { ...s[pid]?.[field], [l]: ev.target.value } } }))} />
                  {v.length > limit && <div className="kv" style={{ color: 'var(--warn)' }}>超长——搜索结果可能截断(软警,可发布)</div>}
                </div>
              );
            })}
          </div>
        </div>
      ))}
      <div className="card" style={{ marginBottom: 10 }}>
        <h3>页脚 · 联系邮箱</h3>
        <div className="field" style={{ margin: 0, maxWidth: 380 }}>
          <input placeholder="ops@nexgrid.ai(留空=站上隐藏联系行)" value={mail} onChange={(ev) => setEmail(ev.target.value.trim())} />
        </div>
        <p className="kv" style={{ marginTop: 6 }}>{mail ? '站上「For AI teams」联系行将显示此邮箱' : '当前为空:站上的联系行处于隐藏状态,填入邮箱后即会显示'}</p>
        {mailErr && <div className="note bad" style={{ marginBottom: 0 }}>{mailErr}</div>}
      </div>
      <div className="note info">
        页脚披露句/法定名行/导航文案在 <Link to="/content" style={{ color: 'var(--brand)' }}>文案树</Link>(页脚/导航组)编辑——每处内容唯一编辑面;社媒链接清单当前站上为空集,站上落地后此处接管。
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn primary" disabled={!dirty || saving || !!mailErr}
          onClick={async () => {
            const ok = await save((d) => {
              for (const [id, m] of Object.entries(edits)) {
                const t = d.seo.pages[id]!;
                if (m.title) Object.assign(t.title, m.title);
                if (m.description) Object.assign(t.description, m.description);
              }
              if (email !== null) d.footer.contactEmail = email;
            });
            if (ok) { setEdits({}); setEmail(null); }
          }}>
          {saving ? '保存中…' : '保存草稿'}
        </button>
      </div>
    </section>
  );
}
