/* 下载入口(CON05 ⑤⑥):三入口 URL/开关 + 即时探活(预警不阻断,永不自动下架)。高敏模块。 */
import { useState } from 'react';
import { TextLimitHint } from '../lib/text-limit-hint';
import { ApiError, api, toast } from '../api';
import { retainPostSubmit, submissionSnapshot } from '../lib/async-state';
import { fieldName } from '../lib/human-path';
import { useDraft } from '../lib/use-draft';
import { useFocusField } from '../lib/use-focus-field';

const ROWS = [
  ['ios', 'iOS', 'App Store URL(https://…)'],
  ['android', 'Android', 'Google Play URL(https://…)'],
  ['h5', 'Web App', '产品 H5 部署 URL(https://…)'],
] as const;

type ProbeItem = { ok?: boolean; status?: number; note?: string; skipped?: boolean };
type Probe = Partial<Record<(typeof ROWS)[number][0], ProbeItem>> & { at?: number; draftRev: number };

export default function DownloadsPage() {
  const [edits, setEdits] = useState<Record<string, { url?: string; enabled?: boolean }>>({});
  const [probe, setProbe] = useState<Probe | null>(null);
  const [probing, setProbing] = useState(false);
  const dirty = Object.keys(edits).length > 0;
  const { draft, saving, conflict, save, reload, draftRev } = useDraft(dirty);
  useFocusField(undefined, !!draft);

  if (!draft) return <section><h2>下载入口</h2><div className="skl" style={{ height: 80 }} /></section>;

  const cur = (k: 'ios' | 'android' | 'h5') => ({ ...draft.downloads[k], ...edits[k] });
  const errs = ROWS.flatMap(([k]) => {
    const c = cur(k);
    // 报错里用人话字段名,不印配置键(那一行的标题写的是「iOS」,报错却说 ios,第十轮 P2-7)
    if (c.enabled && !c.url) return [`${fieldName(k)}:开启的入口必须填写链接(或把开关关掉,站上会显示「即将推出」)`];
    if (c.url && !/^https:\/\/.+/.test(c.url)) return [`${fieldName(k)}:须为 https 完整链接`];
    return [];
  });
  const visibleProbe = !dirty && probe?.draftRev === draftRev ? probe : null;

  async function doProbe() {
    if (dirty || draftRev === undefined) return;
    const checkedRevision = draftRev;
    setProbing(true);
    try {
      const result = await api<Probe>('/api/config/probe-downloads', {
        method: 'POST',
        body: JSON.stringify({ expectedDraftRev: checkedRevision }),
      });
      if (result.draftRev !== checkedRevision) {
        setProbe(null);
        toast(`探活结果属于草稿 r${result.draftRev}，不是当前看到的 r${checkedRevision}；已丢弃并刷新`);
        await reload();
        return;
      }
      setProbe({ ...result, draftRev: checkedRevision });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.body.error === 'draft-changed') {
        setProbe(null);
        toast('草稿已在别处更新，未执行旧版本探活；已刷新，请重新核对');
        await reload();
      } else {
        toast('探活请求失败');
      }
    } finally {
      setProbing(false);
    }
  }

  return (
    <section className="editor-page">
      <header className="page-heading">
        <span className="eyebrow">内容管理</span>
        <h2>下载入口 <span className="pill warn">高敏 · 发布须理由</span></h2>
        <p className="page-description">管理 iOS、Android 和 Web App 的访问入口。保存草稿后，完成发布才会在官网生效。</p>
      </header>
      <div className="note info">关闭入口后，App 下载按钮显示「即将推出」；Web App 入口隐藏。开启只代表草稿设置，不代表已经上线。</div>
      {conflict && <div className="note bad">草稿已在别处更新,本次保存被拒 <button className="btn ghost sm" onClick={() => { setEdits({}); reload(); }}>刷新后重试</button></div>}
      {ROWS.map(([k, label, ph]) => {
        const c = cur(k);
        const p = visibleProbe?.[k] as ProbeItem | undefined;
        return (
          <div className="card" key={k} data-field={`downloads.${k}`} style={{ marginBottom: 10 }}>
            <div className="row">
              <b style={{ width: '5.5rem' }}>{label}</b>
              <span className={`pill ${c.enabled ? 'brand' : ''}`}>{c.enabled ? '草稿已开启' : '草稿已关闭'}</span>
              {p && (p.skipped ? <span className="pill">未启用/未配置,不探</span> : p.ok ? <span className="pill ok">{/* enum-ok:这是 HTTP 状态码,原值就是要给人看的 */}可达 {p.status}</span> : <span className="pill bad">不可达({p.status || '超时'})</span>)}
              <span className="spacer" />
              {/* tap44:上下架是高敏动作,点歪就把下载入口关了(第十轮 P2-9) */}
              <label className="row tap44" style={{ gap: 6 }}>
                <span className="kv">开启入口</span>
                <input type="checkbox" style={{ width: '1.125rem', height: '1.125rem' }} checked={c.enabled}
                  aria-label={`开启 ${label} 入口`}
                  onChange={(e) => setEdits((s) => ({ ...s, [k]: { ...s[k], enabled: e.target.checked } }))} />
              </label>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor={`download-${k}`}>{label} 链接</label>
              <input id={`download-${k}`} aria-describedby={`download-${k}-length`} type="url" placeholder={ph} value={c.url} onChange={(e) => setEdits((s) => ({ ...s, [k]: { ...s[k], url: e.target.value.trim() } }))} />
              <TextLimitHint id={`download-${k}-length`} fieldId={'/downloads/' + k + '/url'} locale="en" value={c.url} />
            </div>
            {c.enabled && p && !p.skipped && !p.ok && (
              <div className="note warn" style={{ margin: '8px 0 0' }}>链接当前不可达。此提醒不阻断发布，系统不会自动关闭入口。</div>
            )}
          </div>
        );
      })}
      {errs.map((e, i) => <div className="note bad" key={i}>{e}</div>)}
      <p className="kv">链接检查仅针对已保存草稿；有未保存改动时，请先保存。检查失败不会自动关闭入口。</p>
      <div className="editor-actions">
        <button className="btn primary" disabled={!dirty || errs.length > 0 || saving}
          onClick={async () => {
            const submitted = submissionSnapshot(edits);
            if (await save((d) => { for (const [k, m] of Object.entries(submitted)) Object.assign(d.downloads[k as 'ios'], m); })) {
              setEdits((current) => retainPostSubmit(current, submitted, {}));
            }
          }}>
          {saving ? '保存中…' : '保存草稿'}
        </button>
        <span className="kv">{dirty ? '本页有未保存改动' : '保存后仍需发布'}</span>
        <button className="btn" disabled={probing || dirty} title={dirty ? '先保存或放弃本页改动；探活检查的是已保存草稿' : '检查已保存草稿里的三个入口'} onClick={doProbe}>{probing ? '探活中…' : '立即探活（已保存草稿）'}</button>
        {visibleProbe?.at && <span className="kv">已保存草稿 r{visibleProbe.draftRev} · 最近核验 {new Date(visibleProbe.at).toLocaleTimeString('zh-CN', { hour12: false })}</span>}
      </div>
    </section>
  );
}
