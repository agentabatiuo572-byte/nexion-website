/* 下载入口(CON05 ⑤⑥):三入口 URL/开关 + 即时探活(预警不阻断,永不自动下架)。高敏模块。 */
import { useState } from 'react';
import { api, toast } from '../api';
import { fieldName } from '../lib/human-path';
import { useDraft } from '../lib/use-draft';
import { useFocusField } from '../lib/use-focus-field';

const ROWS = [
  ['ios', 'iOS', 'App Store URL(https://…)'],
  ['android', 'Android', 'Google Play URL(https://…)'],
  ['h5', 'Web App', '产品 H5 部署 URL(https://…)'],
] as const;

type ProbeItem = { ok?: boolean; status?: number; note?: string; skipped?: boolean };
type Probe = Record<string, ProbeItem> & { at?: number };

export default function DownloadsPage() {
  useFocusField(); // 「去修复」带来的 ?focus=<字段> 由它定位并高亮
  const { draft, saving, conflict, save, reload } = useDraft();
  const [edits, setEdits] = useState<Record<string, { url?: string; enabled?: boolean }>>({});
  const [probe, setProbe] = useState<Probe | null>(null);
  const [probing, setProbing] = useState(false);

  if (!draft) return <section><h2>下载入口</h2><div className="skl" style={{ height: 80 }} /></section>;

  const cur = (k: 'ios' | 'android' | 'h5') => ({ ...draft.downloads[k], ...edits[k] });
  const errs = ROWS.flatMap(([k]) => {
    const c = cur(k);
    // 报错里用人话字段名,不印配置键(那一行的标题写的是「iOS」,报错却说 ios,第十轮 P2-7)
    if (c.enabled && !c.url) return [`${fieldName(k)}:开启的入口必须填写链接(或把开关关掉,站上会显示「即将推出」)`];
    if (c.url && !/^https:\/\/.+/.test(c.url)) return [`${fieldName(k)}:须为 https 完整链接`];
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
      <div className="note info">未配置或关闭的入口,站上会显示「即将推出」并禁用点击,不会出现打不开的链接;改动保存进草稿,经「发布」过全部机器门后生效。</div>
      {conflict && <div className="note bad">草稿已在别处更新,本次保存被拒 <button className="btn ghost sm" onClick={() => { setEdits({}); reload(); }}>刷新后重试</button></div>}
      {ROWS.map(([k, label, ph]) => {
        const c = cur(k);
        const p = probe?.[k];
        return (
          <div className="card" key={k} data-field={`downloads.${k}`} style={{ marginBottom: 10 }}>
            <div className="row">
              <b style={{ width: 88 }}>{label}</b>
              <span className={`pill ${c.enabled ? 'ok' : ''}`}>{c.enabled ? '已上线' : '未配置(站上显示「即将推出」并禁用)'}</span>
              {p && (p.skipped ? <span className="pill">未启用/未配置,不探</span> : p.ok ? <span className="pill ok">{/* enum-ok:这是 HTTP 状态码,原值就是要给人看的 */}可达 {p.status}</span> : <span className="pill bad">不可达({p.status || '超时'})</span>)}
              <span className="spacer" />
              {/* tap44:上下架是高敏动作,点歪就把下载入口关了(第十轮 P2-9) */}
              <label className="row tap44" style={{ gap: 6 }}>
                <span className="kv">开启</span>
                <input type="checkbox" style={{ width: 18, height: 18 }} checked={c.enabled}
                  onChange={(e) => setEdits((s) => ({ ...s, [k]: { ...s[k], enabled: e.target.checked } }))} />
              </label>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <input placeholder={ph} value={c.url} onChange={(e) => setEdits((s) => ({ ...s, [k]: { ...s[k], url: e.target.value.trim() } }))} />
            </div>
            {c.enabled && p && !p.skipped && !p.ok && (
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
