/* 下载入口(CON05 ⑤):三入口 URL/开关。高敏模块。 */
import { useState } from 'react';
import { TextLimitHint } from '../lib/text-limit-hint';
import { retainPostSubmit, submissionSnapshot } from '../lib/async-state';
import { fieldName } from '../lib/human-path';
import { useDraft } from '../lib/use-draft';
import { useFocusField } from '../lib/use-focus-field';

const ROWS = [
  ['ios', 'iOS', 'iOS 下载地址(https://…)'],
  ['android', 'Android', 'Google Play URL(https://…)'],
  ['h5', 'Web App', '产品 H5 部署 URL(https://…)'],
] as const;

export default function DownloadsPage() {
  const [edits, setEdits] = useState<Record<string, { url?: string; enabled?: boolean }>>({});
  const dirty = Object.keys(edits).length > 0;
  const { draft, saving, conflict, save, reload } = useDraft(dirty);
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
        return (
          <div className="card" key={k} data-field={`downloads.${k}`} style={{ marginBottom: 10 }}>
            <div className="row">
              <b style={{ width: '5.5rem' }}>{label}</b>
              <span className={`pill ${c.enabled ? 'brand' : ''}`}>{c.enabled ? '草稿已开启' : '草稿已关闭'}</span>
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
          </div>
        );
      })}
      {errs.map((e, i) => <div className="note bad" key={i}>{e}</div>)}
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
      </div>
    </section>
  );
}
