/* 文案树编辑器(CON04 ⑤⑥):按实际数据分组 · 单目标与只读参考 · 缺译定位 · 禁用词即时红(词表与站上门同一份)
   · 占位符守恒即时校验 · 行级「查看线上值/撤销」 · 乐观锁冲突条。
   faq 问答与设备标语为集合背书(各自模块页管理),本页对应组只读跳转——每 key 唯一编辑面(⑦)。 */
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
// @ts-expect-error 禁用词单源(站上门同文件)
import { scanForbidden } from '../../../scripts/forbidden-patterns.mjs';
import { pointer, tokensOf, useDraft, type SiteConfigView } from '../lib/use-draft';
import { TranslatedTextarea } from '../lib/translated-textarea';
import { retainPostSubmit, submissionSnapshot } from '../lib/async-state';
import { COPY_GROUPS, LOCALE_NAME, fieldName } from '../lib/human-path';
import { useFocusField } from '../lib/use-focus-field';
import { LOCALES, LocalePair, LocaleToolbar, SOURCE_LOCALE, useLocaleWorkspace, type Locale } from '../lib/locale-editor';

/* 分组名单源在 lib/human-path 的 COPY_GROUPS —— 发布页翻译红项路径时用的是同一份。
   两处各写各的必漂:实测发布页此前根本翻不出组名,因为那张表只在这个页面里。 */
const SENSITIVE_GROUPS = new Set(['trust', 'legal']);
const SENSITIVE_KEYS = ['footer.legalLine'];
const COLLECTION_NOTE: Record<string, ReactNode> = {
  faq: <>问答条目在 <Link to="/content/faq" style={{ color: 'var(--brand-ink)' }}>FAQ 模块</Link> 管理；这里编辑板块标题。</>,
  devices: <>各设备标语随 <Link to="/content/skus" style={{ color: 'var(--brand-ink)' }}>产品卡</Link> 编辑；这里编辑板块文案。</>,
};

type Hit = { label: string; match: string };
const scan = scanForbidden as (t: string) => Hit[];

export default function ContentPage() {
  const language = useLocaleWorkspace();
  const [group, setGroup] = useState('hero');
  const [q, setQ] = useState('');
  const [edits, setEdits] = useState<Record<string, Partial<Record<Locale, string>>>>({});
  const [confirmRevert, setConfirmRevert] = useState<string | null>(null); // 撤销两步确认(PRD ④,T11-P3)
  const [showLive, setShowLive] = useState<Record<string, boolean>>({}); // 行内线上值展开(PRD ⑥,T11-P4)
  const { draft, live, saving, conflict, clearConflict, save, reload } = useDraft(Object.keys(edits).length > 0);
  useFocusField((target) => {
    if (target.area === 'copy') { setGroup(target.segments[target.locale ? 2 : 1] ?? 'hero'); setQ(''); }
  }, !!draft);

  /* 🔴 搜索**跨全部 18 组**(2026-09-01 第十轮独立验收 P2-12):
     上一版先按当前组过滤、再按关键词过滤,于是运营记得站上有句话要改、
     却不知道它属于哪一组时,搜索完全帮不上忙,只能逐组点开再搜。
     现在:没输关键词 = 看当前组(默认行为不变);输了关键词 = 全局搜,
     并在每条上标出它属于哪一组,点组名可以切过去。 */
  const searching = q.trim().length > 0;
  const matches = (k: string) =>
    k.toLowerCase().includes(q.toLowerCase()) || LOCALES.some((l) => val(draft!, l, k).toLowerCase().includes(q.toLowerCase()));
  const keys = useMemo(() => {
    if (!draft) return [];
    const all = Object.keys(draft.copy[SOURCE_LOCALE] ?? draft.copy.en);
    return searching ? all.filter(matches) : all.filter((k) => k.startsWith(group + '.'));
  }, [draft, group, q, searching, edits]);

  if (!draft) return <section><h2>文案树</h2><div className="grid"><div className="skl" /><div className="skl" style={{ width: '70%' }} /></div></section>;

  const presentGroups = new Set(Object.keys(draft.copy.en).map((key) => key.split('.')[0]));
  const groups = [...new Set([...Object.keys(COPY_GROUPS), ...presentGroups])]
    .filter((key) => presentGroups.has(key)).map((key) => [key, COPY_GROUPS[key] ?? key]);

  function val(d: SiteConfigView, loc: Locale, k: string): string {
    return edits[k]?.[loc] ?? d.copy[loc]?.[k] ?? '';
  }
  const dirtyCount = Object.keys(edits).length;
  // CON04-E2(保存级硬拦,与服务端同判):任何键任一译文占位符缺失 → 保存禁用
  const placeholderProblems = Object.keys(edits).flatMap((k) => {
    const source = val(draft, SOURCE_LOCALE, k);
    return LOCALES.filter((loc) => loc !== SOURCE_LOCALE).flatMap((loc) => {
      const v = val(draft, loc, k);
      const missing = v ? tokensOf(source).filter((token) => !tokensOf(v).includes(token)) : [];
      return missing.length ? [{ path: `copy.${loc}.${k}`, label: `${LOCALE_NAME[loc]} · ${k} · 缺少 ${missing.join(' ')}` }] : [];
    });
  });
  const placeholderBlocked = placeholderProblems.length > 0;

  async function saveAll() {
    const submitted = submissionSnapshot(edits);
    const ok = await save((d) => {
      for (const [k, m] of Object.entries(submitted)) for (const [loc, v] of Object.entries(m)) d.copy[loc as Locale][k] = v as string;
    }, `已保存 ${dirtyCount} 处到草稿 · 未发布`, Object.entries(submitted).flatMap(([key, values]) => Object.keys(values).map((locale) => pointer('copy', locale, key))));
    if (ok) setEdits((current) => retainPostSubmit(current, submitted, {}));
  }

  const groupDirty = (g: string) => Object.keys(edits).filter((k) => k.startsWith(g + '.')).length;

  return (
    <section className="editor-page">
      <header className="page-heading">
        <span className="eyebrow">内容管理</span>
        <h2>网站文案</h2>
        <p className="page-description">按板块和语言修改官网文案。先保存草稿，再到「发布与版本」检查并上线。</p>
      </header>
      <LocaleToolbar workspace={language} enabledLocales={draft.enabledLocales} gaps={Object.keys(draft.copy[SOURCE_LOCALE] ?? draft.copy.en).filter((key) => !val(draft, language.target, key).trim()).map((key) => ({ path: `copy.${language.target}.${key}`, label: key.split('.').map(fieldName).join(' · ') }))} />
      {placeholderProblems.length > 0 && <div className="note bad"><b>保存前需补齐占位符：</b>{placeholderProblems.map((problem) => <button key={problem.path} className="btn ghost" onClick={() => language.locate(problem.path)}>{problem.label} · 去修复</button>)}</div>}
      {conflict && (
        <div className="note bad">草稿已在别处更新(另一个标签页?)。为不覆盖那边的改动,本次保存被拒——
          <button className="btn ghost sm" onClick={() => { setEdits({}); clearConflict(); reload(); }}>刷新后重试(本页未保存改动将丢弃)</button>
        </div>
      )}
      <div className="copy-layout">
        <div className="copy-group-picker field">
          <label htmlFor="copy-group">选择文案板块</label>
          <select id="copy-group" value={group} onChange={(event) => setGroup(event.target.value)}>
            {groups.map(([g, label]) => <option key={g} value={g}>{label}{SENSITIVE_GROUPS.has(g) ? ' · 高敏' : ''}{groupDirty(g) ? ` · ${groupDirty(g)} 处未保存` : ''}</option>)}
          </select>
        </div>
        <nav className="card copy-groups" aria-label="文案板块">
          {groups.map(([g, label]) => (
            <button key={g} className={`nav ${group === g ? 'on' : ''}`} aria-pressed={group === g} onClick={() => setGroup(g)}>
              <span className="lbl">{label}</span>
              {SENSITIVE_GROUPS.has(g) && <span className="pill warn">高敏</span>}
              {groupDirty(g) > 0 && <span className="pill brand">{groupDirty(g)}</span>}
            </button>
          ))}
        </nav>
        <div>
          <div className="row" style={{ marginBottom: 10 }}>
            <input aria-label="搜索全部网站文案" type="search" placeholder={`搜索文案(全部 ${groups.length} 组)…`} value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: '25rem' }} />
            <span className="kv">{searching ? '搜索全部板块' : COPY_GROUPS[group]} · {keys.length} 条文案</span>
          </div>
          {COLLECTION_NOTE[group] && <div className="note info">{COLLECTION_NOTE[group]}</div>}
          {keys.length === 0 && <div className="card"><p className="kv">没有匹配的文案 {q && <button className="btn ghost sm" onClick={() => setQ('')}>清空过滤</button>}</p></div>}
          {keys.map((k) => {
            const source = val(draft, SOURCE_LOCALE, k);
            const sourceTokens = tokensOf(source);
            const sensitive = SENSITIVE_GROUPS.has(group) || SENSITIVE_KEYS.includes(k);
            const liveDiff = live && LOCALES.some((l) => (draft.copy[l]?.[k] ?? '') !== (live.copy[l]?.[k] ?? ''));
            return (
              /* 卡片使用通用 key；输入框携带完整语言路径，深链先切组和语言再聚焦。 */
              <div className="card" key={k} style={{ marginBottom: 10 }} data-field={`copy.${k}`}>
                <div className="row" style={{ marginBottom: 6 }}>
                  <b title={k} style={{ fontSize: 'var(--text-body)' }}>{k.split('.').map(fieldName).join(' · ')}</b>
                  {searching && (
                    <button className="pill" style={{ cursor: 'pointer' }} title="切到这一组" onClick={() => { setGroup(k.split('.')[0]); setQ(''); }}>
                      {COPY_GROUPS[k.split('.')[0]] ?? k.split('.')[0]}
                    </button>
                  )}
                  {sensitive && <span className="pill warn">高敏 · 发布须理由</span>}
                  {(edits[k] || liveDiff) && <span className="pill">已改未发布</span>}
                  <span className="spacer" />
                  {live && (
                    <button className="btn ghost sm" onClick={() => setShowLive((s) => ({ ...s, [k]: !s[k] }))}>
                      {showLive[k] ? '收起线上值' : '查看线上值'}
                    </button>
                  )}
                  {live && (edits[k] || liveDiff) && (
                    confirmRevert === `${k}.${language.target}` ? (
                      <button
                        className="btn sm" style={{ background: 'var(--bad-soft)', color: 'var(--bad)' }}
                        onClick={() => {
                          setEdits((s) => ({ ...s, [k]: { ...s[k], [language.target]: live.copy[language.target]?.[k] ?? '' } }));
                          setConfirmRevert(null);
                        }}
                      >
                        确认恢复{LOCALE_NAME[language.target]}线上值?
                      </button>
                    ) : (
                      <button className="btn ghost sm" onClick={() => setConfirmRevert(`${k}.${language.target}`)}>恢复本语言线上值</button>
                    )
                  )}
                </div>
                {showLive[k] && live && (
                  <div className="note info" style={{ margin: '0 0 8px' }}>
                    <div className="kv" style={{ marginBottom: 4 }}>线上值(与草稿对照;发布前站上实际显示的内容)</div>
                    {[language.target].map((loc) => (
                      <div key={loc} style={{ display: 'flex', gap: 8 }}>
                        <span className="kv" style={{ flex: 'none', minWidth: '2.75rem' }}>{LOCALE_NAME[loc]}</span>
                        <span style={(live.copy[loc]?.[k] ?? '') !== val(draft, loc, k) ? { color: 'var(--warn)' } : {}}>
                          {live.copy[loc]?.[k] || <i className="kv">(空)</i>}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                <LocalePair workspace={language} reference={language.reference ? val(draft, language.reference, k) : ''} label="文案">
                  {[language.target].map((loc) => {
                    const v = val(draft, loc, k);
                    const hits = v ? scan(v) : [];
                    const missTokens = loc !== SOURCE_LOCALE && v ? sourceTokens.filter((t) => !tokensOf(v).includes(t)) : [];
                    return (
                      <div className="field" key={`${k}.${loc}`} style={{ margin: 0 }}>
                        <TranslatedTextarea
                          label={<>{LOCALE_NAME[loc]}{loc === SOURCE_LOCALE && ' · 源语言'}</>}
                          draftFieldId={pointer('copy', loc, k)} targetLocale={loc} source={source}
                          id={`copy-${k}-${loc}`}
                          data-field={`copy.${loc}.${k}`}
                          value={v}
                          style={hits.length || missTokens.length ? { borderColor: 'var(--bad)' } : {}}
                          onValueChange={(value) => setEdits((s) => ({ ...s, [k]: { ...s[k], [loc]: value } }))}
                        />
                        {hits.map((h, i) => (
                          <div className="kv" style={{ color: 'var(--bad)' }} key={i}>合规拦截 [{h.label}]:「{h.match}」——可存草稿,发布将被拒</div>
                        ))}
                        {missTokens.length > 0 && <div className="kv" style={{ color: 'var(--bad)' }}>占位符缺失:{missTokens.join(' ')}——保存被拦(缺了站上会渲染残缺)</div>}
                      </div>
                    );
                  })}
                </LocalePair>
              </div>
            );
          })}
        </div>
      </div>
      <div className="editor-actions">
        <span className="kv" role="status">{placeholderBlocked ? '有占位符缺失，请补齐后保存' : dirtyCount ? `本页未保存 ${dirtyCount} 处` : '无未保存改动'} · 保存后仍需发布</span>
        <span className="spacer" />
        {dirtyCount > 0 && <button className="btn ghost" onClick={() => { setEdits({}); setConfirmRevert(null); }}>放弃本页未保存改动</button>}
        <button className="btn primary" disabled={!dirtyCount || saving || placeholderBlocked} onClick={saveAll}>{saving ? '保存中…' : '保存草稿'}</button>
      </div>
    </section>
  );
}
