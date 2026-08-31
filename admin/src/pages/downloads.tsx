/* 下载入口(CON05 ⑤⑥):三入口 URL/开关 + 即时探活(预警不阻断,永不自动下架)。高敏模块。 */
import { useState } from 'react';
import { api, toast } from '../api';
import { useDraft } from '../lib/use-draft';

const ROWS = [
  ['ios', 'iOS', 'App Store URL(https://…)'],
  ['android', 'Android', 'Google Play URL(https://…)'],
  ['h5', 'Web App', '产品 H5 部署 URL(https://…)'],
] as const;

type Probe = Record<string, { ok: boolean; status: number; note?: string }> & { at?: number };

export default function DownloadsPage() {
  const { draft, saving, conflict, save, reload } = useDraft();
  const [edits, setEdits] = useState<Record<string, { url?: string; enabled?: boolean }>>({});
  const [probe, setProbe] = useState<Probe | null>(null);
  const [probing, setProbing] = useState(false);

  if (!draft) return <section><h2>下载入口</h2><div className="skl" style={{ height: 80 }} /></section>;

  const cur = (k: 'ios' | 'android' | 'h5') => ({ ...draft.downloads[k], ...edits[k] });
  const errs = ROWS.flatMap(([k]) => {
    const c = cur(k);
    if (c.enabled && !c.url) return [`${k}:开启的入口必须有 URL(或关闭改 coming-soon)`];
    if (c.url && !/^https:\/\/.+/.test(c.url)) return [`${k}:须为 https 完整链接`];
    return [];
  });
  const dirty = Object.keys(edits).length > 0;

  async function doProbe() {
    setProbing(true);
    try {
      setProbe(await api<Probe>('/api/config/probe-downloads', { method: 'POST', body: '{}' }));
    } catch {
      toast('探活请求失败');
    } finally {
      setProbing(false);
    }
  }

  return (
    <section>
      <h2>下载入口 <span className="pill warn">高敏 · 发布须理由</span></h2>
      <div className="note info">未配置/关闭的入口,站上自动降级为 coming-soon 禁用态,零死链(WEB02);改动保存进草稿,经「发布」过全部机器门后生效。</div>
      {conflict && <div className="note bad">草稿已在别处更新,本次保存被拒 <button className="btn ghost sm" onClick={() => { setEdits({}); reload(); }}>刷新后重试</button></div>}
      {ROWS.map(([k, label, ph]) => {
        const c = cur(k);
        const p = probe?.[k];
        return (
          <div className="card" key={k} style={{ marginBottom: 10 }}>
            <div className="row">
              <b style={{ width: 88 }}>{label}</b>
              <span className={`pill ${c.enabled ? 'ok' : ''}`}>{c.enabled ? '已上线' : 'coming-soon'}</span>
              {p && (p.ok ? <span className="pill ok">可达 {p.status}</span> : <span className="pill bad">不可达{p.note === 'empty' ? '(空)' : `(${p.status || '超时'})`}</span>)}
              <span className="spacer" />
              <label className="row" style={{ gap: 6 }}>
                <span className="kv">开启</span>
                <input type="checkbox" style={{ width: 18, height: 18 }} checked={c.enabled}
                  onChange={(e) => setEdits((s) => ({ ...s, [k]: { ...s[k], enabled: e.target.checked } }))} />
              </label>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <input placeholder={ph} value={c.url} onChange={(e) => setEdits((s) => ({ ...s, [k]: { ...s[k], url: e.target.value.trim() } }))} />
            </div>
            {c.enabled && p && !p.ok && p.note !== 'empty' && (
              <div className="note warn" style={{ margin: '8px 0 0' }}>链接当前不可达——预警不阻断(商店未过审可先配);是否下架由您决定,系统永不自动下架。</div>
            )}
          </div>
        );
      })}
      {errs.map((e, i) => <div className="note bad" key={i}>{e}</div>)}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn primary" disabled={!dirty || errs.length > 0 || saving}
          onClick={async () => { if (await save((d) => { for (const [k, m] of Object.entries(edits)) Object.assign(d.downloads[k as 'ios'], m); })) setEdits({}); }}>
          {saving ? '保存中…' : '保存草稿'}
        </button>
        <button className="btn" disabled={probing} onClick={doProbe}>{probing ? '探活中…' : '立即探活'}</button>
        {probe?.at && <span className="kv">最近核验 {new Date(probe.at).toLocaleTimeString('zh-CN', { hour12: false })}</span>}
      </div>
    </section>
  );
}
