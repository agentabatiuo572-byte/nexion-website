/* 公告条(CON09 ⑤⑥):开关/三语文案 ≤120/链接/UTC 起止窗;窗口态预览;内容变更 server 换 id。 */
import { useState } from 'react';
// @ts-expect-error 禁用词单源
import { scanForbidden } from '../../../scripts/forbidden-patterns.mjs';
import { useDraft, type Tri } from '../lib/use-draft';
import { retainPostSubmit, submissionSnapshot } from '../lib/async-state';
import { AutoTextarea } from '../lib/auto-textarea';
import { useFocusField } from '../lib/use-focus-field';

const scan = scanForbidden as (t: string) => Array<{ label: string; match: string }>;
type Ann = { id: string; enabled: boolean; text: Tri; href?: string; startsAt?: string; endsAt?: string };

const toLocal = (iso?: string) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—');
const toInput = (iso?: string) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
const fromInput = (v: string) => (v ? new Date(v).toISOString() : undefined);

export default function AnnouncementPage() {
  useFocusField(); // 「去修复」带来的 ?focus=<字段> 由它定位并高亮
  const [e, setE] = useState<Partial<Ann>>({});
  const [textE, setTextE] = useState<Partial<Tri>>({});
  const dirty = Object.keys(e).length > 0 || Object.keys(textE).length > 0;
  const { draft, saving, conflict, clearConflict, save, reload } = useDraft(dirty);

  if (!draft) return <section><h2>公告条</h2><div className="skl" style={{ height: 80 }} /></section>;

  const a: Ann = { ...draft.announcement, ...e, text: { ...draft.announcement.text, ...textE } };
  const now = Date.now();
  /* 窗口态一律人话:此前混着 disabled / scheduled / expired 这类机器词直出(实景走查 P1) */
  const winState = !a.enabled ? '未启用' : !a.startsAt || !a.endsAt ? '缺起止时间' : now < Date.parse(a.startsAt) ? '已排期(还没到展示时间)' : now > Date.parse(a.endsAt) ? '已过期(展示时间已过)' : '展示中';
  /* 🔴 校验**不以总开关为前提**(2026-09-01 第十轮独立验收 P1-9)。
     上一版全部校验都裹在 `if (a.enabled)` 里,于是总开关关着时:
     倒挂的起止时间、`javascript:` 链接、超长正文**全都能存进草稿且零红条**,
     等到打开开关才一次性冒出四条 —— 而运营的自然顺序恰恰是
     「先把文案时间填好,最后才打开开关」,整个填写过程零反馈。
     CON09-E1/E2 两条(时间倒挂、链接协议)本来就没有以 enabled 为前提。
     分两档:**格式类**任何时候都拦(填了就得填对);**必填类**只在启用时拦
     (关着的公告允许留空,那是草稿的正常状态)。 */
  const errs: string[] = [];
  for (const l of ['en', 'vi', 'zh'] as const) {
    if (a.text[l].length > 120) errs.push(`${l} 文案超 120 字符(当前 ${a.text[l].length},超出 ${a.text[l].length - 120})`);
  }
  if (a.startsAt && a.endsAt && Date.parse(a.endsAt) <= Date.parse(a.startsAt)) errs.push('结束时间须晚于开始时间');
  if (a.href && !/^(https:\/\/|\/)/.test(a.href)) errs.push('链接须为 https:// 开头或站内路径(/ 开头)');
  if (a.enabled) {
    for (const l of ['en', 'vi', 'zh'] as const) if (!a.text[l].trim()) errs.push(`启用的公告 ${l} 文案必填`);
    if (!a.startsAt || !a.endsAt) errs.push('启用的公告须有起止时间');
  }
  const hits = (['en', 'vi', 'zh'] as const).flatMap((l) => scan(a.text[l] ?? '').map((h) => `${l}:${h.match}`));

  return (
    <section>
      <h2>公告条</h2>
      <div className="note info">站顶限时公告:到窗自动出现、过窗自动消失(站侧按 UTC 判,零重建);访客点关同一条不再弹(内容改动=新公告,自动重新展示);零 cookie。</div>
      {conflict && <div className="note bad">草稿已在别处更新,保存被拒 <button className="btn ghost sm" onClick={() => { setE({}); setTextE({}); clearConflict(); reload(); }}>刷新后重试</button></div>}
      <div className="card" style={{ marginBottom: 10 }} data-field="announcement.enabled" data-field-alt="announcement">
        <div className="row">
          <b>总开关</b>
          <label className="tap44" title="总开关"><input type="checkbox" style={{ width: 18, height: 18 }} checked={a.enabled} onChange={(ev) => setE((s) => ({ ...s, enabled: ev.target.checked }))} /></label>
          <span className={`pill ${winState === '展示中' ? 'ok' : winState === '未启用' ? '' : 'warn'}`}>{winState}</span>
        </div>
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
        {(['en', 'vi', 'zh'] as const).map((l) => (
          <div className="card" key={l} data-field={`announcement.text.${l}`}>
            <div className="field" style={{ margin: 0 }}>
              <label>{l} 文案(≤120)<span className="kv" style={{ marginLeft: 6, color: a.text[l].length > 120 ? 'var(--bad)' : undefined }}>{a.text[l].length}/120</span></label>
              <AutoTextarea value={a.text[l]} onChange={(ev) => setTextE((s) => ({ ...s, [l]: ev.target.value }))} />
            </div>
          </div>
        ))}
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(3,1fr)', marginTop: 10 }}>
        <div className="card" data-field="announcement.href"><div className="field" style={{ margin: 0 }}><label>链接(可选,https 或 / 站内)</label>
          <input value={a.href ?? ''} onChange={(ev) => setE((s) => ({ ...s, href: ev.target.value.trim() || undefined }))} /></div></div>
        <div className="card" data-field="announcement.startsAt"><div className="field" style={{ margin: 0 }}><label>开始(本地输入,存 UTC;当前 {toLocal(a.startsAt)})</label>
          <input type="datetime-local" value={toInput(a.startsAt)} onChange={(ev) => setE((s) => ({ ...s, startsAt: fromInput(ev.target.value) }))} /></div></div>
        <div className="card" data-field="announcement.endsAt"><div className="field" style={{ margin: 0 }}><label>结束(本地输入,存 UTC;当前 {toLocal(a.endsAt)})</label>
          <input type="datetime-local" value={toInput(a.endsAt)} onChange={(ev) => setE((s) => ({ ...s, endsAt: fromInput(ev.target.value) }))} /></div></div>
      </div>
      {a.enabled && (
        <div className="card" style={{ marginTop: 10 }}>
          <h3>站顶预览</h3>
          <div style={{ background: 'var(--brand-soft)', borderRadius: 8, padding: '8px 12px' }}>
            {a.text.zh || a.text.en || <i className="kv">(空)</i>} {a.href && <span className="kv">→ {a.href}</span>}
          </div>
        </div>
      )}
      {errs.map((x, i) => <div className="note bad" key={i}>{x}</div>)}
      {hits.map((h, i) => <div className="note bad" key={'h' + i}>合规拦截:{h}(可存草稿,发布将被拒)</div>)}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn primary" disabled={!dirty || saving || errs.length > 0}
          onClick={async () => {
            const submitted = submissionSnapshot(e);
            const submittedText = submissionSnapshot(textE);
            const ok = await save((d) => {
              Object.assign(d.announcement, submitted);
              Object.assign(d.announcement.text, submittedText);
            });
            if (ok) {
              setE((current) => retainPostSubmit(current, submitted, {}));
              setTextE((current) => retainPostSubmit(current, submittedText, {}));
            }
          }}>
          {saving ? '保存中…' : '保存草稿'}
        </button>
        {dirty && <button className="btn ghost" onClick={() => { setE({}); setTextE({}); }}>放弃本页未保存改动</button>}
      </div>
    </section>
  );
}
