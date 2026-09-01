/* 产品卡(CON07 ⑤⑥):拖拽排序/显隐/三语标语/事实字段高敏;V1 不开放增删 SKU(集合权威=App PRD §7.1)。 */
import { useState, type DragEvent } from 'react';
// @ts-expect-error 禁用词单源
import { scanForbidden } from '../../../scripts/forbidden-patterns.mjs';
import { AutoTextarea } from '../lib/auto-textarea';
import { useDraft } from '../lib/use-draft';
import { useFocusField } from '../lib/use-focus-field';

const scan = scanForbidden as (t: string) => Array<{ label: string; match: string }>;
/** 机器枚举 → 人话。缺映射时显示「状态未知(原值)」,不静默、也不吐裸枚举 */
const SKU_STATUS: Record<string, string> = { active: '在售', legacy: '已停产', coming: '即将上市' };
const FACTS = ['name', 'priceUSD', 'multiplier', 'status'] as const;

export default function SkusPage() {
  useFocusField(); // 「去修复」带来的 ?focus=<字段> 由它定位并高亮
  const { draft, live, saving, conflict, clearConflict, save, reload } = useDraft();
  const [edits, setEdits] = useState<Record<string, Record<string, unknown>>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [order, setOrder] = useState<string[] | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  if (!draft) return <section><h2>产品卡</h2><div className="skl" style={{ height: 80 }} /></section>;

  const ids = order ?? [...draft.skus].sort((a, b) => a.sort - b.sort).map((s) => s.id);
  const skuOf = (id: string) => {
    const base = draft.skus.find((s) => s.id === id)!;
    return { ...base, ...(edits[id] ?? {}), tagline: { ...base.tagline, ...((edits[id]?.tagline as object) ?? {}) } };
  };
  const factTouched = (id: string) => FACTS.some((f) => edits[id]?.[f] !== undefined);
  const anyFactTouched = ids.some(factTouched);
  const dirty = Object.keys(edits).length > 0 || order !== null;
  const visibleCount = ids.filter((id) => skuOf(id).visible).length;

  function onDrop(e: DragEvent, targetId: string) {
    e.preventDefault();
    if (!dragId || dragId === targetId) return;
    const next = ids.filter((x) => x !== dragId);
    next.splice(next.indexOf(targetId) + (e.nativeEvent.offsetY > (e.currentTarget as HTMLElement).offsetHeight / 2 ? 1 : 0), 0, dragId);
    setOrder(next);
    setDragId(null);
  }

  return (
    <section>
      <h2>产品卡 <span className="pill warn">事实字段高敏</span></h2>
      <div className="note info">标语/排序/显隐随意改;<b>名称/价格/倍数/状态是产品事实字段</b>——须与 App PRD §7.1 一致(官网不新造业务规则),改动标高敏、发布须理由。V1 不开放增删 SKU(阵容变更走 App PRD 流程)。</div>
      {conflict && <div className="note bad">草稿已在别处更新,保存被拒 <button className="btn ghost sm" onClick={() => { setEdits({}); setOrder(null); clearConflict(); reload(); }}>刷新后重试</button></div>}
      {visibleCount === 0 && <div className="note bad">设备板块不可为空:至少保留 1 个可见(当前 0)——保存被拦</div>}
      {ids.map((id) => {
        const s = skuOf(id);
        const tagHits = (['en', 'vi', 'zh'] as const).flatMap((l) => scan(s.tagline[l] ?? '').map((h) => `${l}:${h.match}`));
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
              <span className="mono kv">${s.priceUSD.toLocaleString('en-US')} · {s.multiplier}×</span>
              {factTouched(id) && <span className="pill warn">事实字段已改</span>}
              <span className="spacer" />
              <label className="row" style={{ gap: 6 }}>
                <span className="kv">展示</span>
                <input type="checkbox" style={{ width: 18, height: 18 }} checked={s.visible}
                  onChange={(e) => setEdits((st) => ({ ...st, [id]: { ...st[id], visible: e.target.checked } }))} />
              </label>
              <button className="btn ghost sm" onClick={() => setOpen(open === id ? null : id)}>{open === id ? '收起' : '编辑'}</button>
            </div>
            {open === id && (
              <div style={{ marginTop: 10 }}>
                <div className="grid" style={{ gridTemplateColumns: 'repeat(4,1fr)' }}>
                  <div className="field"><label>名称(事实)</label><input value={String(s.name)} onChange={(e) => setEdits((st) => ({ ...st, [id]: { ...st[id], name: e.target.value } }))} /></div>
                  <div className="field"><label>价格 USD(事实)</label><input className="mono" value={String(s.priceUSD)} onChange={(e) => setEdits((st) => ({ ...st, [id]: { ...st[id], priceUSD: Number(e.target.value) } }))} /></div>
                  <div className="field"><label>算力倍数(事实)</label><input className="mono" value={String(s.multiplier)} onChange={(e) => setEdits((st) => ({ ...st, [id]: { ...st[id], multiplier: Number(e.target.value) } }))} /></div>
                  <div className="field"><label>状态(事实)</label>
                    {/* enum-ok:select 的 value 必须是机器值,人话在 option 文字里 */}
                    <select value={s.status} onChange={(e) => setEdits((st) => ({ ...st, [id]: { ...st[id], status: e.target.value } }))}>
                      <option value="active">在售</option><option value="legacy">已停产</option><option value="coming">即将上市</option>
                    </select>
                  </div>
                </div>
                {factTouched(id) && <div className="note warn" style={{ margin: '4px 0' }}>产品事实字段已改——发布须理由,且请确认与 App PRD §7.1 一致</div>}
                <div className="grid" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
                  {(['en', 'vi', 'zh'] as const).map((l) => (
                    <div className="field" key={l} style={{ margin: 0 }}>
                      <label>标语 {l}</label>
                      <AutoTextarea value={s.tagline[l] ?? ''} style={scan(s.tagline[l] ?? '').length ? { borderColor: 'var(--bad)' } : {}}
                        onChange={(e) => setEdits((st) => ({ ...st, [id]: { ...st[id], tagline: { ...(st[id]?.tagline as object), [l]: e.target.value } } }))} />
                    </div>
                  ))}
                </div>
                {tagHits.map((h, i) => <div className="kv" key={i} style={{ color: 'var(--bad)' }}>合规拦截:{h}(可存草稿,发布将被拒)</div>)}
              </div>
            )}
          </div>
        );
      })}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn primary" disabled={!dirty || saving || visibleCount === 0}
          onClick={async () => {
            const ok = await save((d) => {
              for (const [id, m] of Object.entries(edits)) {
                const t = d.skus.find((s) => s.id === id)!;
                const { tagline, ...rest } = m as { tagline?: Record<string, string> };
                Object.assign(t, rest);
                if (tagline) Object.assign(t.tagline, tagline);
              }
              const ord = order ?? ids;
              d.skus.forEach((s) => { s.sort = ord.indexOf(s.id) + 1; });
            }, anyFactTouched ? '草稿已保存(含事实字段改动,发布须理由)' : '草稿已保存 · 未发布');
            if (ok) { setEdits({}); setOrder(null); }
          }}>
          {saving ? '保存中…' : '保存草稿'}
        </button>
        {live && dirty && <button className="btn ghost" onClick={() => { setEdits({}); setOrder(null); }}>放弃本页未保存改动</button>}
      </div>
    </section>
  );
}
