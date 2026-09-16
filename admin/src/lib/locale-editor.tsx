import { useId, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DEFAULT_ENABLED_LOCALES, LOCALES, LOCALE_NAMES, LOCALE_NATIVE_NAMES, SOURCE_LOCALE, isLocale, type Locale } from '../../../schema/src/locales';
export { LOCALES, LOCALE_NAMES, SOURCE_LOCALE, type Locale } from '../../../schema/src/locales';
import { parseFieldTarget } from './field-target';
import type { SiteConfigView, Tri } from './use-draft';

export const emptyTranslation = (): Tri => Object.fromEntries(LOCALES.map((locale) => [locale, ''])) as Tri;
export interface TranslationGap { path: string; label: string }

/** Only selection lives here. Page work copies keep every locale, including hidden targets. */
export function useLocaleWorkspace() {
  const [params, setParams] = useSearchParams();
  const focus = params.get('focus');
  const picked = params.get('lang') ?? '';
  const target: Locale = (focus && parseFieldTarget(focus).locale) || (isLocale(picked) ? picked : SOURCE_LOCALE);
  const pickedReference = params.get('reference');
  const reference: Locale | '' = pickedReference === null ? (target === SOURCE_LOCALE ? '' : SOURCE_LOCALE) : isLocale(pickedReference) && pickedReference !== target ? pickedReference : '';
  const select = (key: string, value: string) => setParams((previous) => {
    const next = new URLSearchParams(previous);
    next.set(key, value);
    if (key === 'lang' || key === 'reference') {
      next.delete('focus');
      if (key === 'reference') next.set('lang', target);
    }
    return next;
  }, { replace: true });
  return {
    target, reference, focusPath: focus,
    setTarget: (locale: string) => { if (isLocale(locale)) select('lang', locale); },
    setReference: (locale: string) => select('reference', locale),
    locate: (path: string) => select('focus', path),
  };
}
export type LocaleWorkspace = ReturnType<typeof useLocaleWorkspace>;

export function LocaleToolbar({ workspace, enabledLocales = DEFAULT_ENABLED_LOCALES, gaps = [], optional = false, immediate = false }: {
  workspace: LocaleWorkspace; enabledLocales?: readonly Locale[]; gaps?: TranslationGap[]; optional?: boolean; immediate?: boolean;
}) {
  const id = useId();
  return <div className="card locale-toolbar">
    <div className="field"><label htmlFor={`${id}-target`}>编辑语言</label>
      <select id={`${id}-target`} data-locale-target value={workspace.target} onChange={(event) => workspace.setTarget(event.target.value)}>
        {LOCALES.map((locale) => <option key={locale} value={locale}>{LOCALE_NAMES[locale]} · {LOCALE_NATIVE_NAMES[locale]} · {enabledLocales.includes(locale) ? '已启用' : '未启用'}</option>)}
      </select>
    </div>
    <div className="field"><label htmlFor={`${id}-reference`}>参考语言（只读）</label>
      <select id={`${id}-reference`} data-locale-reference value={workspace.reference} onChange={(event) => workspace.setReference(event.target.value)}>
        <option value="">不显示参考</option>
        {LOCALES.filter((locale) => locale !== workspace.target).map((locale) => <option key={locale} value={locale}>{LOCALE_NAMES[locale]} · {LOCALE_NATIVE_NAMES[locale]}</option>)}
      </select>
    </div>
    <div className="locale-progress">
      <span className="kv" role="status">{LOCALE_NAMES[workspace.target]} · {enabledLocales.includes(workspace.target) ? '草稿已启用' : '未启用，可提前翻译'} · {gaps.length ? `${gaps.length} 处${optional ? '未填写（选填）' : '待填写'}` : '本页已填写'}</span>
      {gaps.length > 0 && <div className="row">
        <button type="button" className="btn ghost" onClick={() => {
          const current = gaps.findIndex((gap) => gap.path === workspace.focusPath);
          workspace.locate(gaps[(current + 1) % gaps.length]!.path);
        }}>下一处待填写</button>
        <select aria-label="定位待填写字段" value="" onChange={(event) => { if (event.target.value) workspace.locate(event.target.value); }}>
          <option value="">选择待填写字段…</option>
          {gaps.map((gap) => <option key={gap.path} value={gap.path}>{gap.label}</option>)}
        </select>
      </div>}
    </div>
    <p className="kv locale-help">切换语言保留本页未保存内容；{immediate ? '应用规则' : '保存草稿'}会提交本页所有语言的修改。参考内容不会随目标语言写入。</p>
  </div>;
}

/** Reference is text, never a second writable form or an implicit fallback value. */
export function LocalePair({ workspace, reference, label, children }: {
  workspace: LocaleWorkspace; reference: ReactNode; label: string; children: ReactNode;
}) {
  return <div className={`locale-pair${workspace.reference ? '' : ' locale-pair-single'}`}>
    {workspace.reference && <div className="locale-reference" lang={workspace.reference}>
      <div className="kv" lang="zh">{LOCALE_NAMES[workspace.reference]} · {label}参考（只读）</div>
      <div className="locale-reference-text" lang="zh" tabIndex={0} role="region" aria-label={`${LOCALE_NAMES[workspace.reference]}${label}参考`}><span lang={workspace.reference}>{reference || <span lang="zh">此语种尚未填写</span>}</span></div>
    </div>}
    <div className="locale-target" lang="zh" data-editing-locale={workspace.target}>{children}</div>
  </div>;
}

/** Same required-field scope as publication: SEO and legal keep their existing fallback. */
export function requiredTranslationGaps(config: SiteConfigView, locale: Locale): TranslationGap[] {
  const gaps: TranslationGap[] = [];
  const check = (value: string | undefined, path: string, label: string) => { if (!value?.trim()) gaps.push({ path, label }); };
  for (const key of Object.keys(config.copy.en)) check(config.copy[locale]?.[key], `copy.${locale}.${key}`, `网站文案 · ${key}`);
  for (const item of config.faq.items) if (!(item as { deleted?: boolean }).deleted) {
    check(item.q[locale], `faq.items.${item.id}.q.${locale}`, `常见问题 · ${item.q.en || item.id} · 问题`);
    check(item.a[locale], `faq.items.${item.id}.a.${locale}`, `常见问题 · ${item.q.en || item.id} · 回答`);
  }
  for (const sku of config.skus) check(sku.tagline[locale], `skus.${sku.id}.tagline.${locale}`, `产品卡片 · ${sku.name} · 标语`);
  if (config.announcement.enabled) check(config.announcement.text[locale], `announcement.text.${locale}`, '公告文案');
  return gaps;
}
