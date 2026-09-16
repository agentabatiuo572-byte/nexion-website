import { useState } from 'react';
import { Link } from 'react-router-dom';
import { DEFAULT_ENABLED_LOCALES, LOCALES, LOCALE_NAMES, LOCALE_NATIVE_NAMES, type Locale } from '../../../schema/src/locales';
import { useDraft } from '../lib/use-draft';
import { retainPostSubmit, submissionSnapshot } from '../lib/async-state';
import { requiredTranslationGaps } from '../lib/locale-editor';
import { fieldEditorLink } from '../lib/field-target';
import { useFocusField } from '../lib/use-focus-field';
import { DefaultTranslationActions } from '../lib/translations';

export default function LanguagesPage() {
  const [work, setWork] = useState<Locale[] | null>(null);
  const { draft, live, saving, conflict, clearConflict, save, reload } = useDraft(work !== null);
  useFocusField(undefined, !!draft);
  if (!draft) return <section><h2>语言设置</h2><div className="skl" /></section>;
  const enabled = work ?? draft.enabledLocales ?? [...DEFAULT_ENABLED_LOCALES];
  return <section className="editor-page">
    <header className="page-heading"><span className="eyebrow">网站管理</span><h2>语言设置</h2>
      <p className="page-description">选择官网提供的语言。保存草稿后，到「发布与版本」检查并上线；未启用语种的内容仍会保留，可提前翻译。</p>
    </header>
    <div className="note info">英语是默认语言和缺译时的回退语言，始终启用。其它语种可随时在草稿中开关，发布前需补齐该语种必填内容；SEO 和法律文档保留原有回退规则。</div>
    <DefaultTranslationActions disabled={work !== null || saving} onChanged={reload} />
    {conflict && <div className="note bad">草稿已在别处更新，本次保存被拒。<button className="btn ghost" onClick={() => { setWork(null); clearConflict(); void reload(); }}>放弃本页改动并刷新</button></div>}
    <div className="language-settings" data-field="enabledLocales">
      {LOCALES.map((locale) => {
        const selected = enabled.includes(locale);
        const liveSelected = live?.enabledLocales?.includes(locale);
        const gaps = requiredTranslationGaps(draft, locale);
        return <div className="card language-setting" key={locale} data-field={`enabledLocales.${locale}`}>
          <label className="language-toggle" htmlFor={`language-${locale}`}>
            <input id={`language-${locale}`} type="checkbox" checked={selected} disabled={locale === 'en'} onChange={(event) => {
              const checked = event.target.checked;
              setWork((previous) => LOCALES.filter((candidate) => candidate === 'en' || (candidate === locale ? checked : (previous ?? enabled).includes(candidate))));
            }} />
            <span><b>{LOCALE_NAMES[locale]}</b><span className="kv language-native" lang={locale}>{LOCALE_NATIVE_NAMES[locale]}</span></span>
          </label>
          <div className="row"><span className={`pill ${selected ? 'brand' : ''}`}>草稿 · {selected ? '已启用' : '未启用'}</span><span className="kv">线上 · {liveSelected === undefined ? '状态未读取' : liveSelected ? '已启用' : '未启用'}</span></div>
          <p className="kv">{locale === 'en' && '默认语言，不能关闭。'}{gaps.length ? `${gaps.length} 处必填内容待补齐${selected ? '，发布检查会拦截' : '，可提前准备'}` : '必填内容已填写'}</p>
          <Link className="btn ghost" to={gaps[0] ? fieldEditorLink(gaps[0].path) : `/content?lang=${locale}`}>{gaps.length ? '定位待翻译内容' : '编辑此语言'}</Link>
        </div>;
      })}
    </div>
    <div className="editor-actions"><span className="kv" role="status">已选择 {enabled.length} 种语言 · {work ? '本页未保存' : '保存后仍需发布'}</span><span className="spacer" />
      {work && <button className="btn ghost" onClick={() => setWork(null)}>放弃本页未保存改动</button>}
      <button className="btn primary" disabled={!work || saving} onClick={async () => {
        const submitted = submissionSnapshot(work!);
        if (await save((config) => { config.enabledLocales = submitted; })) setWork((current) => retainPostSubmit(current, submitted, null));
      }}>{saving ? '保存中…' : '保存草稿'}</button>
    </div>
  </section>;
}
