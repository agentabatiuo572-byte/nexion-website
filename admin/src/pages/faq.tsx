/* FAQ 管理(CON08 ⑤⑥):增删改排 + 回收区(草稿可恢复,发布物理剪除)+ ≥3 可见门槛。 */
import { useState, type DragEvent } from 'react';
import { flushSync } from 'react-dom';
// @ts-expect-error 禁用词单源
import { scanForbidden } from '../../../scripts/forbidden-patterns.mjs';
import { api } from '../api';
import { mergeWorkingValue, retainPostSubmit, submissionSnapshot } from '../lib/async-state';
import { TranslatedTextarea } from '../lib/translated-textarea';
import { appendMintedFaqItem, type FaqItemValue } from '../lib/faq-items';
import { pointer, useDraft } from '../lib/use-draft';
import { useFocusField } from '../lib/use-focus-field';
import { LOCALE_NAME } from '../lib/human-path';
import { LOCALES, LocalePair, LocaleToolbar, SOURCE_LOCALE, useLocaleWorkspace } from '../lib/locale-editor';

const scan = scanForbidden as (t: string) => Array<{ label: string; match: string }>;
type Item = FaqItemValue;

export default function FaqPage() {
  const language = useLocaleWorkspace();
  const [work, setWork] = useState<Item[] | null>(null); // 本页工作副本(含新增/回收)
  const [touchedTargets, setTouchedTargets] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');
  const { draft, live, editingBase, saving, conflict, clearConflict, save, reload } = useDraft(work !== null);
  useFocusField((target) => {
    if (target.area === 'faq') {
      const key = target.segments[2];
      setOpen(target.path.includes('[') ? draft?.faq.items[Number(key)]?.id ?? null : key ?? null);
    }
  }, !!draft);

  if (!draft) return <section><h2>FAQ</h2><div className="skl" style={{ height: 80 }} /></section>;

  const rawItems: Item[] = work ?? [...(draft.faq.items as Item[])].sort((a, b) => a.sort - b.sort);
  const items: Item[] = work && editingBase ? mergeWorkingValue(editingBase.faq.items as Item[], work, draft.faq.items as Item[]) : rawItems;
  const rawById = (id: string) => rawItems.find((item) => item.id === id) ?? items.find((item) => item.id === id)!;
  const alive = items.filter((i) => !i.deleted);
  const bin = items.filter((i) => i.deleted);
  const visibleCount = alive.filter((i) => i.visible).length;
  const dirty = work !== null;
  const upd = (id: string, patch: Partial<Item> | ((i: Item) => void)) =>
    setWork((current) => (current ?? rawItems).map((i) => {
      if (i.id !== id) return i;
      const c = structuredClone(i);
      typeof patch === 'function' ? patch(c) : Object.assign(c, patch);
      return c;
    }));

  function onDrop(e: DragEvent, targetId: string) {
    e.preventDefault();
    if (!dragId || dragId === targetId) return;
    const ids = alive.map((i) => i.id).filter((x) => x !== dragId);
    ids.splice(ids.indexOf(targetId) + (e.nativeEvent.offsetY > (e.currentTarget as HTMLElement).offsetHeight / 2 ? 1 : 0), 0, dragId);
    setWork([...ids.map(rawById), ...bin.map((item) => rawById(item.id))]);
    setDragId(null);
  }

  function move(index: number, direction: -1 | 1, button: HTMLButtonElement) {
    const target = index + direction;
    if (target < 0 || target >= alive.length) return;
    const next = [...alive];
    [next[index], next[target]] = [next[target]!, next[index]!];
    flushSync(() => setWork([...next, ...bin].map((item) => rawById(item.id))));
    // DOM 重排可能丢焦点；到达边界时保留在同一项可用的排序按钮上。
    (button.disabled ? button.parentElement?.querySelector<HTMLButtonElement>('button:not(:disabled)') : button)?.focus();
  }

  async function addItem() {
    if (adding) return;
    setAdding(true);
    setAddError('');
    try {
      const { id } = await api<{ id: string }>('/api/config/mint-id', { method: 'POST', body: JSON.stringify({ kind: 'faq' }) });
      setWork((current) => appendMintedFaqItem(current, rawItems, id));
      setOpen(id);
    } catch {
      setAddError('新增失败：没有拿到条目编号，请重试；现有编辑已保留。');
    } finally {
      setAdding(false);
    }
  }

  return (
    <section className="editor-page" data-field="faq">
      <header className="page-heading">
        <span className="eyebrow">内容管理</span>
        <h2>常见问题</h2>
        <p className="page-description">按语言编辑问答、调整顺序或隐藏条目。保存草稿后需发布，官网至少展示 3 条问答。</p>
      </header>
      <LocaleToolbar workspace={language} enabledLocales={draft.enabledLocales} gaps={alive.flatMap((item) => (['q', 'a'] as const).filter((field) => !item[field][language.target]?.trim()).map((field) => ({ path: `faq.items.${item.id}.${field}.${language.target}`, label: `${item.q[SOURCE_LOCALE] || item.id} · ${field === 'q' ? '问题' : '回答'}` })))} />
      <div className="note info">可用上移、下移按钮或拖动条目排序。删除的问答先进入回收区，发布前可恢复；发布后永久移除。</div>
      {addError && <div className="note bad" role="alert">{addError} <button className="btn ghost sm" disabled={adding} onClick={() => void addItem()}>重试新增</button></div>}
      {conflict && <div className="note bad">草稿已在别处更新,保存被拒 <button className="btn ghost sm" onClick={() => { setWork(null); setTouchedTargets({}); clearConflict(); reload(); }}>刷新后重试</button></div>}
      {visibleCount < 3 && <div className="note bad">FAQ 可见条目须 ≥3(当前 {visibleCount})——保存被拦</div>}
      {alive.map((it, idx) => {
        const missing = !it.q[language.target]?.trim() || !it.a[language.target]?.trim();
        const hits = LOCALES.flatMap((l) => [...scan(it.q[l] ?? ''), ...scan(it.a[l] ?? '')]);
        return (
          /* 「去修复」落点。两种记法都标:校验器发 `faq.items.<id>.…`(稳定 id),
             改动 diff 发 `faq.items[N].…`(下标)。同一处产出两个属性,不会各自演化。 */
          <div className="card" key={it.id} style={{ marginBottom: 8, opacity: dragId === it.id ? 0.5 : 1 }}
            data-field={`faq.items.${it.id}`} data-field-alt={`faq.items[${idx}]`}
            draggable onDragStart={() => setDragId(it.id)} onDragOver={(e) => e.preventDefault()} onDrop={(e) => onDrop(e, it.id)}>
            <div className="row">
              <span className="kv mono" style={{ cursor: 'grab' }}>⠿</span>
              <b style={{ maxWidth: '23.75rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.q[SOURCE_LOCALE] || <i className="kv">(新条目,未填)</i>}</b>
              <span className="pill">#{idx + 1}</span>
              {missing && <span className="pill warn">缺译</span>}
              {hits.length > 0 && <span className="pill bad">合规拦截</span>}
              <span className="spacer" />
              <div className="row" role="group" aria-label={`第 ${idx + 1} 条问答排序`}>
                <button className="btn ghost" aria-label={`上移第 ${idx + 1} 条问答`} disabled={idx === 0} onClick={(e) => move(idx, -1, e.currentTarget)}>上移</button>
                <button className="btn ghost" aria-label={`下移第 ${idx + 1} 条问答`} disabled={idx === alive.length - 1} onClick={(e) => move(idx, 1, e.currentTarget)}>下移</button>
              </div>
              <label className="row tap44" style={{ gap: 6 }}><span className="kv">可见</span>
                <input aria-label={`展示第 ${idx + 1} 条问答`} type="checkbox" style={{ width: '1.125rem', height: '1.125rem' }} checked={it.visible} onChange={(e) => upd(it.id, { visible: e.target.checked })} />
              </label>
              <button className="btn ghost sm" aria-expanded={open === it.id} onClick={() => setOpen(open === it.id ? null : it.id)}>{open === it.id ? '收起' : '编辑'}</button>
              {/* 🔴 拦点在**删除动作**上,不是保存时(CON08-E1 逐字:「Given 删到仅剩 2 条,
                  When 删除第 3 条,Then 拒绝」;第十轮独立验收 P2-11 实测可一路删到 0 条,
                  剩 2 条才在页顶冒出「保存被拦」)。让人删完七条再告诉他不行,是最差的时机。 */}
              {confirmDel === it.id ? (
                <button className="btn sm" style={{ background: 'var(--bad-soft)', color: 'var(--bad)' }}
                  onClick={() => { upd(it.id, { deleted: true }); setConfirmDel(null); }}>确认移入回收区?</button>
              ) : (
                <button
                  className="btn ghost sm"
                  disabled={it.visible && visibleCount <= 3}
                  title={it.visible && visibleCount <= 3 ? `站上至少要有 3 条可见问答(当前 ${visibleCount} 条),不能再删了` : ''}
                  onClick={() => setConfirmDel(it.id)}
                >
                  删除
                </button>
              )}
            </div>
            {open === it.id && (
              <div style={{ marginTop: 10 }}>
                <LocalePair workspace={language} reference={language.reference ? <>{it.q[language.reference] || <span lang="zh">问题尚未填写</span>}{'\n\n'}{it.a[language.reference] || <span lang="zh">回答尚未填写</span>}</> : ''} label="问答">
                {[language.target].map((l) => (
                  <div key={l}>
                    <div className="field" style={{ margin: 0 }}>
                      <TranslatedTextarea label={<>{LOCALE_NAME[l]}问题{l === SOURCE_LOCALE && ' · 源语言'}</>} draftFieldId={pointer('faq', 'items', it.id, 'q', l)} targetLocale={l} source={it.q[SOURCE_LOCALE]}
                        id={`faq-${it.id}-q-${l}`} data-field={`faq.items.${it.id}.q.${l}`} data-field-alt={`faq.items[${draft.faq.items.findIndex((item) => item.id === it.id)}].q.${l}`} value={it.q[l] ?? ''} onValueChange={(value) => { setTouchedTargets((current) => ({ ...current, [pointer('faq', 'items', it.id, 'q', l)]: value })); upd(it.id, (c) => { c.q[l] = value; }); }} /></div>
                    <div className="field">
                      <TranslatedTextarea label={`${LOCALE_NAME[l]}回答`} draftFieldId={pointer('faq', 'items', it.id, 'a', l)} targetLocale={l} source={it.a[SOURCE_LOCALE]}
                        id={`faq-${it.id}-a-${l}`} data-field={`faq.items.${it.id}.a.${l}`} data-field-alt={`faq.items[${draft.faq.items.findIndex((item) => item.id === it.id)}].a.${l}`} value={it.a[l] ?? ''} onValueChange={(value) => { setTouchedTargets((current) => ({ ...current, [pointer('faq', 'items', it.id, 'a', l)]: value })); upd(it.id, (c) => { c.a[l] = value; }); }} /></div>
                  </div>
                ))}
                </LocalePair>
              </div>
            )}
          </div>
        );
      })}
      <div className="editor-actions">
        <button className="btn" disabled={adding} onClick={() => void addItem()}>{adding ? '新增中…' : '+ 新增条目'}</button>
        <button className="btn primary" disabled={!dirty || saving || visibleCount < 3}
          onClick={async () => {
            const submitted = submissionSnapshot(work!);
            const submittedTargets = submissionSnapshot(touchedTargets);
            const submittedAlive = submitted.filter((item) => !item.deleted);
            const ok = await save((d) => {
              (d.faq.items as Item[]) = submitted.map((i, n) => ({ ...i, sort: i.deleted ? i.sort : submittedAlive.findIndex((a) => a.id === i.id) + 1 || n + 1 }));
            }, undefined, Object.keys(submittedTargets));
            if (ok) { setWork((current) => retainPostSubmit(current, submitted, null)); setTouchedTargets((current) => retainPostSubmit(current, submittedTargets, {})); }
          }}>
          {saving ? '保存中…' : '保存草稿'}
        </button>
        {dirty && <button className="btn ghost" onClick={() => { setWork(null); setTouchedTargets({}); }}>放弃本页未保存改动</button>}
      </div>
      <div className="card">
        <h3>回收区 <span className="pill">{bin.length} 条</span></h3>
        <p className="kv">发布前可恢复；发布后永久移除，不可恢复。</p>
        {bin.length === 0 ? <p className="kv">没有待删除条目</p> : bin.map((it) => {
          // T13 验收 P-1:从未发布过的新条目(线上不存在)允许当场彻底移除,不留墓碑
          const neverPublished = !!live && !(live.faq.items as Item[]).some((x) => x.id === it.id);
          return (
            <div className="row" key={it.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
              <span style={{ color: 'var(--ink3)' }}>{it.q[SOURCE_LOCALE] || it.id}</span>
              {neverPublished && <span className="pill">从未发布</span>}
              <span className="spacer" />
              {/* T13 验收 P-2:恢复回列表末位(PRD ⑥ 字面) */}
              <button className="btn ghost sm" onClick={() => setWork([...alive.map((item) => rawById(item.id)), { ...rawById(it.id), deleted: false }, ...bin.filter((b) => b.id !== it.id).map((item) => rawById(item.id))])}>恢复(回末位)</button>
              {neverPublished && (
                <button className="btn ghost sm" style={{ color: 'var(--bad)' }} onClick={() => setWork(rawItems.filter((x) => x.id !== it.id))}>彻底移除</button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
