/* 产品卡(CON07 ⑤⑥):拖拽排序/显隐/多语言标语/事实字段高敏;V1 不开放增删 SKU(集合权威=App PRD §7.1)。 */
import { useState, type DragEvent } from 'react';
import { flushSync } from 'react-dom';
// @ts-expect-error 禁用词单源
import { scanForbidden } from '../../../scripts/forbidden-patterns.mjs';
import { TranslatedTextarea } from '../lib/translated-textarea';
import { TextLimitHint } from '../lib/text-limit-hint';
import { retainPostSubmit, submissionSnapshot } from '../lib/async-state';
import { NumericInput, parseNumericInput } from '../lib/numeric-input';
import { pointer, useDraft, type SiteConfigView, type Tri } from '../lib/use-draft';
import { useFocusField } from '../lib/use-focus-field';
import { LOCALE_NAME } from '../lib/human-path';
import { LOCALES, LocalePair, LocaleToolbar, SOURCE_LOCALE, useLocaleWorkspace } from '../lib/locale-editor';

const scan = scanForbidden as (t: string) => Array<{ label: string; match: string }>;
/** 机器枚举 → 人话。缺映射时显示「状态未知(原值)」,不静默、也不吐裸枚举 */
const SKU_STATUS: Record<string, string> = { active: '在售', legacy: '已停产', coming: '即将上市' };
const FACTS = ['name', 'priceUSD', 'multiplier', 'status'] as const;
type Sku = SiteConfigView['skus'][number];
type SkuEdit = Partial<Omit<Sku, 'priceUSD' | 'multiplier' | 'tagline'>> & {
  priceUSD?: string;
  multiplier?: string;
  tagline?: Partial<Tri>;
};

export default function SkusPage() {
  const language = useLocaleWorkspace();
  const [edits, setEdits] = useState<Record<string, SkuEdit>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [order, setOrder] = useState<string[] | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const dirty = Object.keys(edits).length > 0 || order !== null;
  const { draft, live, saving, conflict, clearConflict, save, reload } = useDraft(dirty);
  useFocusField((target) => {
    if (target.area === 'skus') setOpen(target.path.includes('[') ? draft?.skus[Number(target.segments[1])]?.id ?? null : target.segments[1] ?? null);
  }, !!draft);

  if (!draft) return <section><h2>产品卡</h2><div className="skl" style={{ height: 80 }} /></section>;

  const ids = order ?? [...draft.skus].sort((a, b) => a.sort - b.sort).map((s) => s.id);
  const skuOf = (id: string) => {
    const base = draft.skus.find((s) => s.id === id)!;
    const edit = edits[id];
    return {
      ...base,
      ...(edit ?? {}),
      priceUSD: edit?.priceUSD ?? String(base.priceUSD),
      multiplier: edit?.multiplier ?? String(base.multiplier),
      tagline: { ...base.tagline, ...(edit?.tagline ?? {}) },
    };
  };
  const factTouched = (id: string) => FACTS.some((f) => edits[id]?.[f] !== undefined);
  const anyFactTouched = ids.some(factTouched);
  const visibleCount = ids.filter((id) => skuOf(id).visible).length;
  const numberErrors = ids.flatMap((id) => {
    const sku = skuOf(id);
    const price = parseNumericInput(sku.priceUSD);
    const multiplier = parseNumericInput(sku.multiplier);
    return [
      ...(price === null || price < 0 ? [`${sku.name || id}：价格须为不小于 0 的数`] : []),
      ...(multiplier === null || multiplier < 1 ? [`${sku.name || id}：算力倍数须为不小于 1 的数`] : []),
    ];
  });

  function onDrop(e: DragEvent, targetId: string) {
    e.preventDefault();
    if (!dragId || dragId === targetId) return;
    const next = ids.filter((x) => x !== dragId);
    next.splice(next.indexOf(targetId) + (e.nativeEvent.offsetY > (e.currentTarget as HTMLElement).offsetHeight / 2 ? 1 : 0), 0, dragId);
    setOrder(next);
    setDragId(null);
  }

  function move(index: number, direction: -1 | 1, button: HTMLButtonElement) {
    const target = index + direction;
    if (target < 0 || target >= ids.length) return;
    const next = [...ids];
    [next[index], next[target]] = [next[target]!, next[index]!];
    flushSync(() => setOrder(next));
    // DOM 重排可能丢焦点；到达边界时保留在同一项可用的排序按钮上。
    (button.disabled ? button.parentElement?.querySelector<HTMLButtonElement>('button:not(:disabled)') : button)?.focus();
  }

  return (
    <section className="editor-page">
      <header className="page-heading">
        <span className="eyebrow">内容管理</span>
        <h2>产品卡 <span className="pill warn">事实字段高敏</span></h2>
        <p className="page-description">调整产品展示顺序、显隐与各语言标语。保存草稿后需发布；至少保留一个可见产品。</p>
      </header>
      <LocaleToolbar workspace={language} enabledLocales={draft.enabledLocales} gaps={ids.filter((id) => !skuOf(id).tagline[language.target]?.trim()).map((id) => ({ path: `skus.${id}.tagline.${language.target}`, label: `${skuOf(id).name} · 标语` }))} />
      <div className="note info">名称、价格、倍数和状态须与 App PRD §7.1 一致，修改后发布须填写理由。产品阵容在 App PRD 管理，这里不提供增删。</div>
      {conflict && <div className="note bad">草稿已在别处更新,保存被拒 <button className="btn ghost sm" onClick={() => { setEdits({}); setOrder(null); clearConflict(); reload(); }}>刷新后重试</button></div>}
      {visibleCount === 0 && <div className="note bad">设备板块不可为空:至少保留 1 个可见(当前 0)——保存被拦</div>}
      {ids.map((id, index) => {
        const s = skuOf(id);
        const tagHits = LOCALES.flatMap((l) => scan(s.tagline[l] ?? '').map((h) => `${LOCALE_NAME[l]}:${h.match}`));
        return (
          <div
            /* 两种记法都标:校验器发 `skus.<id>.tagline.en`(点号+稳定 id),
               改动 diff 发 `skus[N].priceUSD`(方括号+下标)。只标一种就有一半的红项落空
               —— 第十轮独立验收实测:九条红项八条定位不到,这里是其中之一。 */
            className="card" key={id} data-field={`skus.${id}`} data-field-alt={`skus[${ids.indexOf(id)}]`} style={{ marginBottom: 8, opacity: dragId === id ? 0.5 : 1 }}
            draggable onDragStart={() => setDragId(id)} onDragOver={(e) => e.preventDefault()} onDrop={(e) => onDrop(e, id)}
          >
            <div className="row">
              <span className="kv mono" style={{ cursor: 'grab' }} title="拖拽排序">⠿</span>
              <b>{s.name}</b>
              <span className={`pill ${s.status === 'active' ? 'brand' : ''}`}>{SKU_STATUS[s.status] ?? `状态未知(${s.status})`}</span>
              <span className="mono kv">${parseNumericInput(s.priceUSD)?.toLocaleString('en-US') ?? s.priceUSD} · {s.multiplier}×</span>
              {factTouched(id) && <span className="pill warn">事实字段已改</span>}
              <span className="spacer" />
              <div className="row" role="group" aria-label={`${s.name} 排序`}>
                <button className="btn ghost" aria-label={`上移 ${s.name}`} disabled={index === 0} onClick={(e) => move(index, -1, e.currentTarget)}>上移</button>
                <button className="btn ghost" aria-label={`下移 ${s.name}`} disabled={index === ids.length - 1} onClick={(e) => move(index, 1, e.currentTarget)}>下移</button>
              </div>
              <label className="row tap44" style={{ gap: 6 }}>
                <span className="kv">展示</span>
                <input type="checkbox" style={{ width: '1.125rem', height: '1.125rem' }} checked={s.visible}
                  aria-label={`展示 ${s.name}`}
                  onChange={(e) => setEdits((st) => ({ ...st, [id]: { ...st[id], visible: e.target.checked } }))} />
              </label>
              <button className="btn ghost sm" aria-expanded={open === id} onClick={() => setOpen(open === id ? null : id)}>{open === id ? '收起' : '编辑'}</button>
            </div>
            {open === id && (
              <div style={{ marginTop: 10 }}>
                <div className="field-grid">
                  <div className="field"><label htmlFor={`sku-${id}-name`}>名称（事实）</label><input id={`sku-${id}-name`} aria-describedby={`sku-${id}-name-length`} value={String(s.name)} onChange={(e) => setEdits((st) => ({ ...st, [id]: { ...st[id], name: e.target.value } }))} />
                    <TextLimitHint id={`sku-${id}-name-length`} fieldId={pointer('skus', id, 'name')} locale={language.target} value={String(s.name)} /></div>
                   <div className="field"><label htmlFor={`sku-${id}-price`}>价格 USD（事实）</label><NumericInput id={`sku-${id}-price`} className="mono" value={s.priceUSD} onValueChange={(value) => setEdits((st) => ({ ...st, [id]: { ...st[id], priceUSD: value } }))} /></div>
                   <div className="field"><label htmlFor={`sku-${id}-multiplier`}>算力倍数（事实）</label><NumericInput id={`sku-${id}-multiplier`} className="mono" value={s.multiplier} onValueChange={(value) => setEdits((st) => ({ ...st, [id]: { ...st[id], multiplier: value } }))} /></div>
                  <div className="field"><label htmlFor={`sku-${id}-status`}>状态（事实）</label>
                    {/* enum-ok:select 的 value 必须是机器值,人话在 option 文字里 */}
                    <select id={`sku-${id}-status`} value={s.status} onChange={(e) => setEdits((st) => ({ ...st, [id]: { ...st[id], status: e.target.value } }))}>
                      <option value="active">在售</option><option value="legacy">已停产</option><option value="coming">即将上市</option>
                    </select>
                  </div>
                </div>
                {factTouched(id) && <div className="note warn" style={{ margin: '4px 0' }}>产品事实字段已改——发布须理由,且请确认与 App PRD §7.1 一致</div>}
                <LocalePair workspace={language} reference={language.reference ? s.tagline[language.reference] ?? '' : ''} label="标语">
                  {[language.target].map((l) => (
                    <div className="field" key={l} style={{ margin: 0 }}>
                      <TranslatedTextarea label={<>{LOCALE_NAME[l]}标语{l === SOURCE_LOCALE && ' · 源语言'}</>} draftFieldId={pointer('skus', id, 'tagline', l)} targetLocale={l} source={s.tagline[SOURCE_LOCALE]}
                        id={`sku-${id}-${l}`} data-field={`skus.${id}.tagline.${l}`} data-field-alt={`skus[${draft.skus.findIndex((item) => item.id === id)}].tagline.${l}`} value={s.tagline[l] ?? ''} style={scan(s.tagline[l] ?? '').length ? { borderColor: 'var(--bad)' } : {}}
                        onValueChange={(value) => setEdits((st) => ({ ...st, [id]: { ...st[id], tagline: { ...(st[id]?.tagline as object), [l]: value } } }))} />
                    </div>
                  ))}
                </LocalePair>
                {tagHits.map((h, i) => <div className="kv" key={i} style={{ color: 'var(--bad)' }}>合规拦截:{h}(可存草稿,发布将被拒)</div>)}
              </div>
            )}
          </div>
        );
      })}
      {numberErrors.map((error) => <div className="note bad" key={error}>{error}</div>)}
      <div className="editor-actions">
        <button className="btn primary" disabled={!dirty || saving || visibleCount === 0 || numberErrors.length > 0}
          onClick={async () => {
            const submittedEdits = submissionSnapshot(edits);
            const submittedOrder = submissionSnapshot(order);
            const ok = await save((d) => {
              for (const [id, m] of Object.entries(submittedEdits)) {
                const t = d.skus.find((s) => s.id === id)!;
                const { tagline, priceUSD, multiplier, ...rest } = m;
                Object.assign(t, rest);
                if (tagline) Object.assign(t.tagline, tagline);
                if (priceUSD !== undefined) t.priceUSD = Number(priceUSD);
                if (multiplier !== undefined) t.multiplier = Number(multiplier);
              }
              const ord = submittedOrder ?? ids;
              d.skus.forEach((s) => { s.sort = ord.indexOf(s.id) + 1; });
            }, anyFactTouched ? '草稿已保存(含事实字段改动,发布须理由)' : '草稿已保存 · 未发布', Object.entries(submittedEdits).flatMap(([id, value]) => Object.keys(value.tagline ?? {}).map((locale) => pointer('skus', id, 'tagline', locale))));
            if (ok) {
              setEdits((current) => retainPostSubmit(current, submittedEdits, {}));
              setOrder((current) => retainPostSubmit(current, submittedOrder, null));
            }
          }}>
          {saving ? '保存中…' : '保存草稿'}
        </button>
        {live && dirty && <button className="btn ghost" onClick={() => { setEdits({}); setOrder(null); }}>放弃本页未保存改动</button>}
      </div>
    </section>
  );
}
