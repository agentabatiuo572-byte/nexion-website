/* SEO 与页脚(CON10 ⑤⑥):6 页 title/description 多语言(长度软警)+ 联系邮箱(空=站上隐藏联系行)。
   页脚披露句/导航文案归文案树(⑦ 不双源);社媒清单=现网集(当前为空,站上落地后接入)。 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { TranslatedTextarea } from '../lib/translated-textarea';
import { TextLimitHint } from '../lib/text-limit-hint';
import { countInputCharacters } from '../lib/text-limits';
import { retainPostSubmit, submissionSnapshot } from '../lib/async-state';
import { pointer, useDraft, type Tri } from '../lib/use-draft';
import { useFocusField } from '../lib/use-focus-field';
import { LOCALE_NAME } from '../lib/human-path';
import { emptyTranslation, LocalePair, LocaleToolbar, SOURCE_LOCALE, useLocaleWorkspace, type Locale } from '../lib/locale-editor';

const PAGES: Array<[string, string]> = [
  ['home', '首页'], ['learn', '学习中心'], ['nex', 'NEX'],
  ['legal-privacy', '隐私政策'], ['legal-terms', '使用条款'], ['legal-app-privacy', 'App 隐私'],
];

export default function SeoPage() {
  const language = useLocaleWorkspace();
  const [pid, setPid] = useState('home');
  const [edits, setEdits] = useState<Record<string, { title?: Partial<Tri>; description?: Partial<Tri> }>>({});
  const [email, setEmail] = useState<string | null>(null);
  const dirty = Object.keys(edits).length > 0 || email !== null;
  const { draft, saving, conflict, clearConflict, save, reload } = useDraft(dirty);
  useFocusField((target) => {
    if (target.area === 'seo' && PAGES.some(([id]) => id === target.segments[2])) setPid(target.segments[2]!);
  }, !!draft);

  if (!draft) return <section><h2>SEO 与页脚</h2><div className="skl" style={{ height: 80 }} /></section>;

  const page = draft.seo.pages[pid] ?? { title: emptyTranslation(), description: emptyTranslation() };
  const cur = (field: 'title' | 'description', l: Locale) => edits[pid]?.[field]?.[l] ?? page[field][l] ?? '';
  const mail = email ?? draft.footer.contactEmail;
  const mailErr = mail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail) ? '邮箱格式不合法' : '';

  return (
    <section className="editor-page">
      <header className="page-heading">
        <span className="eyebrow">内容管理</span>
        <h2>搜索展示与联系邮箱</h2>
        <p className="page-description">管理搜索结果中的标题、描述，以及官网页脚的联系邮箱。修改保存到草稿，发布后生效。</p>
      </header>
      <LocaleToolbar workspace={language} enabledLocales={draft.enabledLocales} optional gaps={PAGES.flatMap(([id, label]) => (['title', 'description'] as const).filter((field) => !(edits[id]?.[field]?.[language.target] ?? draft.seo.pages[id]?.[field][language.target] ?? '').trim()).map((field) => ({ path: `seo.pages.${id}.${field}.${language.target}`, label: `${label} · ${field === 'title' ? '标题' : '描述'}` })))} />
      {conflict && <div className="note bad">草稿已在别处更新,保存被拒 <button className="btn ghost sm" onClick={() => { setEdits({}); setEmail(null); clearConflict(); reload(); }}>刷新后重试</button></div>}

      {/* 🔴 对外联系邮箱提到页面第一位(主人 2026-09-01 指令:对外邮箱在后台配置)。
          字段本来就有、也能配,但它此前排在六页 SEO 文案的**下面** —— 一个每天都不会碰的
          页面里,藏着一个上线前必须配的东西。位置本身就是可发现性。
          单源不变:仍是 footer.contactEmail 这一个字段,没有新造第二处。 */}
      <div className="card" style={{ marginBottom: 12 }} data-field="footer.contactEmail">
        <h3><label htmlFor="contact-email">对外联系邮箱</label></h3>
        <div className="field" style={{ margin: 0, maxWidth: '23.75rem' }}>
          <input id="contact-email" aria-describedby="contact-email-length" type="email" placeholder="例:ops@nexgrid.ai" value={mail} onChange={(ev) => setEmail(ev.target.value.trim())} />
          <TextLimitHint id="contact-email-length" fieldId="/footer/contactEmail" locale={language.target} value={mail} />
        </div>
        <p className="kv" style={{ marginTop: 6 }}>
          {mail ? '发布后，官网页脚的「For AI teams」联系行显示此邮箱，访客可点击发信。' : '当前草稿为空：发布后联系行会隐藏。填写邮箱并发布后才会显示。'}
        </p>
        {mailErr && <div className="note bad" style={{ marginBottom: 0 }}>{mailErr}</div>}
      </div>
      <div className="row" style={{ marginBottom: 10 }}>
        {/* 深链先通过共享路径解析选择页面，再等待对应语言输入框渲染并聚焦。 */}
        {PAGES.map(([id, label]) => (
          <button key={id} className={`pill ${pid === id ? 'brand' : ''}`} aria-pressed={pid === id} style={{ cursor: 'pointer' }} data-field={`seo.pages.${id}`} onClick={() => setPid(id)}>{label}</button>
        ))}
      </div>
      {(['title', 'description'] as const).map((field) => (
        // 「去修复」落点:红项路径形如 seo.pages.home.title.zh,逐级剥尾会停在这一级
        <div className="card" key={field} style={{ marginBottom: 10 }} data-field={`seo.pages.${pid}.${field}`}>
          <h3>{field === 'title' ? '搜索标题（建议不超过 60 字符）' : '搜索描述（建议不超过 160 字符）'}</h3>
          <LocalePair workspace={language} reference={language.reference ? cur(field, language.reference) : ''} label={field === 'title' ? '标题' : '描述'}>
            {[language.target].map((l) => {
              const v = cur(field, l);
              const limit = field === 'title' ? 60 : 160;
              return (
                <div className="field" key={l} style={{ margin: 0 }}>
                  <TranslatedTextarea label={<>{LOCALE_NAME[l]}{l === SOURCE_LOCALE && ' · 源语言'}</>}
                    draftFieldId={pointer('seo', 'pages', pid, field, l)} targetLocale={l} source={cur(field, SOURCE_LOCALE)}
                    id={`seo-${pid}-${field}-${l}`} data-field={`seo.pages.${pid}.${field}.${l}`} value={v}
                    onValueChange={(value) => setEdits((s) => ({ ...s, [pid]: { ...s[pid], [field]: { ...s[pid]?.[field], [l]: value } } }))} />
                  {countInputCharacters(v, l) > limit && <div className="kv" style={{ color: 'var(--warn)' }}>超长——搜索结果可能截断(软警,可发布)</div>}
                </div>
              );
            })}
          </LocalePair>
        </div>
      ))}
      <div className="note info">
        页脚主体资料、导航等文案在 <Link to="/content" style={{ color: 'var(--brand-ink)' }}>网站文案</Link> 的「页脚 / 导航」板块编辑。
      </div>
      <div className="editor-actions">
        <button className="btn primary" disabled={!dirty || saving || !!mailErr}
          onClick={async () => {
            const submittedEdits = submissionSnapshot(edits);
            const submittedEmail = email;
            const ok = await save((d) => {
              for (const [id, m] of Object.entries(submittedEdits)) {
                const t = d.seo.pages[id]!;
                if (m.title) Object.assign(t.title, m.title);
                if (m.description) Object.assign(t.description, m.description);
              }
              if (submittedEmail !== null) d.footer.contactEmail = submittedEmail;
            }, undefined, Object.entries(submittedEdits).flatMap(([id, values]) => Object.entries(values).flatMap(([field, translations]) => Object.keys(translations).map((locale) => pointer('seo', 'pages', id, field, locale)))));
            if (ok) {
              setEdits((current) => retainPostSubmit(current, submittedEdits, {}));
              setEmail((current) => retainPostSubmit(current, submittedEmail, null));
            }
          }}>
          {saving ? '保存中…' : '保存草稿'}
        </button>
        <span className="kv">{dirty ? '本页有未保存改动' : '保存后仍需发布'}</span>
      </div>
    </section>
  );
}
