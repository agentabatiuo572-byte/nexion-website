/* FAQ 管理(CON08 ⑤⑥):增删改排 + 回收区(草稿可恢复,发布物理剪除)+ ≥3 可见门槛。 */
import { useState, type DragEvent } from 'react';
// @ts-expect-error 禁用词单源
import { scanForbidden } from '../../../scripts/forbidden-patterns.mjs';
import { api } from '../api';
import { useDraft, type Tri } from '../lib/use-draft';
import { useFocusField } from '../lib/use-focus-field';

const scan = scanForbidden as (t: string) => Array<{ label: string; match: string }>;
type Item = { id: string; q: Tri; a: Tri; sort: number; visible: boolean; deleted?: boolean };

export default function FaqPage() {
  useFocusField(); // 「去修复」带来的 ?focus=<字段> 由它定位并高亮
  const { draft, live, saving, conflict, clearConflict, save, reload } = useDraft();
  const [work, setWork] = useState<Item[] | null>(null); // 本页工作副本(含新增/回收)
  const [open, setOpen] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  if (!draft) return <section><h2>FAQ</h2><div className="skl" style={{ height: 80 }} /></section>;

  const items: Item[] = work ?? [...(draft.faq.items as Item[])].sort((a, b) => a.sort - b.sort);
  const alive = items.filter((i) => !i.deleted);
  const bin = items.filter((i) => i.deleted);
  const visibleCount = alive.filter((i) => i.visible).length;
  const dirty = work !== null;
  const upd = (id: string, patch: Partial<Item> | ((i: Item) => void)) =>
    setWork(items.map((i) => {
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
    setWork([...ids.map((id) => items.find((i) => i.id === id)!), ...bin]);
    setDragId(null);
  }

  async function addItem() {
    const { id } = await api<{ id: string }>('/api/config/mint-id', { method: 'POST', body: JSON.stringify({ kind: 'faq' }) });
    const empty: Tri = { en: '', vi: '', zh: '' };
    setWork([...items, { id, q: { ...empty }, a: { ...empty }, sort: items.length + 1, visible: true }]);
    setOpen(id);
  }

  return (
    <section>
      <h2>FAQ 管理</h2>
      <div className="note info">拖拽排序 · 可见条目须 ≥3 · 删除先进回收区(发布前可恢复,发布后物理移除)· 发布后站上问答与搜索结构化数据自动跟随。</div>
      {conflict && <div className="note bad">草稿已在别处更新,保存被拒 <button className="btn ghost sm" onClick={() => { setWork(null); clearConflict(); reload(); }}>刷新后重试</button></div>}
      {visibleCount < 3 && <div className="note bad">FAQ 可见条目须 ≥3(当前 {visibleCount})——保存被拦</div>}
      {alive.map((it, idx) => {
        const missing = (['en', 'vi', 'zh'] as const).some((l) => !it.q[l].trim() || !it.a[l].trim());
        const hits = (['en', 'vi', 'zh'] as const).flatMap((l) => [...scan(it.q[l]), ...scan(it.a[l])]);
        return (
          <div className="card" key={it.id} style={{ marginBottom: 8, opacity: dragId === it.id ? 0.5 : 1 }}
            draggable onDragStart={() => setDragId(it.id)} onDragOver={(e) => e.preventDefault()} onDrop={(e) => onDrop(e, it.id)}>
            <div className="row">
              <span className="kv mono" style={{ cursor: 'grab' }}>⠿</span>
              <b style={{ maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.q.en || <i className="kv">(新条目,未填)</i>}</b>
              <span className="pill">#{idx + 1}</span>
              {missing && <span className="pill warn">缺译</span>}
              {hits.length > 0 && <span className="pill bad">合规拦截</span>}
              <span className="spacer" />
              <label className="row" style={{ gap: 6 }}><span className="kv">可见</span>
                <input type="checkbox" style={{ width: 18, height: 18 }} checked={it.visible} onChange={(e) => upd(it.id, { visible: e.target.checked })} />
              </label>
              <button className="btn ghost sm" onClick={() => setOpen(open === it.id ? null : it.id)}>{open === it.id ? '收起' : '编辑'}</button>
              {confirmDel === it.id ? (
                <button className="btn sm" style={{ background: 'var(--bad-soft)', color: 'var(--bad)' }}
                  onClick={() => { upd(it.id, { deleted: true }); setConfirmDel(null); }}>确认移入回收区?</button>
              ) : (
                <button className="btn ghost sm" onClick={() => setConfirmDel(it.id)}>删除</button>
              )}
            </div>
            {open === it.id && (
              <div className="grid" style={{ gridTemplateColumns: 'repeat(3,1fr)', marginTop: 10 }}>
                {(['en', 'vi', 'zh'] as const).map((l) => (
                  <div key={l}>
                    <div className="field" style={{ margin: 0 }}><label>问 {l}</label>
                      <textarea rows={2} value={it.q[l]} onChange={(e) => upd(it.id, (c) => { c.q[l] = e.target.value; })} /></div>
                    <div className="field"><label>答 {l}</label>
                      <textarea rows={4} value={it.a[l]} onChange={(e) => upd(it.id, (c) => { c.a[l] = e.target.value; })} /></div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
      <div className="row" style={{ margin: '12px 0' }}>
        <button className="btn" onClick={() => void addItem()}>+ 新增条目(三语必填)</button>
        <button className="btn primary" disabled={!dirty || saving || visibleCount < 3}
          onClick={async () => {
            const ok = await save((d) => {
              (d.faq.items as Item[]) = items.map((i, n) => ({ ...i, sort: i.deleted ? i.sort : alive.findIndex((a) => a.id === i.id) + 1 || n + 1 }));
            });
            if (ok) setWork(null);
          }}>
          {saving ? '保存中…' : '保存草稿'}
        </button>
        {dirty && <button className="btn ghost" onClick={() => setWork(null)}>放弃本页未保存改动</button>}
      </div>
      <div className="card">
        <h3>回收区(发布前可恢复;发布后物理移除,不可恢复)</h3>
        {bin.length === 0 ? <p className="kv">没有待删除条目</p> : bin.map((it) => {
          // T13 验收 P-1:从未发布过的新条目(线上不存在)允许当场彻底移除,不留墓碑
          const neverPublished = !!live && !(live.faq.items as Item[]).some((x) => x.id === it.id);
          return (
            <div className="row" key={it.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
              <span style={{ color: 'var(--ink3)' }}>{it.q.en || it.id}</span>
              {neverPublished && <span className="pill">从未发布</span>}
              <span className="spacer" />
              {/* T13 验收 P-2:恢复回列表末位(PRD ⑥ 字面) */}
              <button className="btn ghost sm" onClick={() => setWork([...alive, { ...it, deleted: false }, ...bin.filter((b) => b.id !== it.id)])}>恢复(回末位)</button>
              {neverPublished && (
                <button className="btn ghost sm" style={{ color: 'var(--bad)' }} onClick={() => setWork(items.filter((x) => x.id !== it.id))}>彻底移除</button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
