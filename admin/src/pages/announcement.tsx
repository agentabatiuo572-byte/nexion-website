/* 公告条(CON09 ⑤⑥):开关/多语言文案 ≤120/链接/UTC 起止窗;窗口态预览;内容变更 server 换 id。 */
import { useState } from 'react';
// @ts-expect-error 禁用词单源
import { scanForbidden } from '../../../scripts/forbidden-patterns.mjs';
import { pointer, useDraft, type Tri } from '../lib/use-draft';
import { retainPostSubmit, submissionSnapshot } from '../lib/async-state';
import { TranslatedTextarea } from '../lib/translated-textarea';
import { TextLimitHint } from '../lib/text-limit-hint';
import { useFocusField } from '../lib/use-focus-field';
import { LOCALE_NAME } from '../lib/human-path';
import { LOCALES, LocalePair, LocaleToolbar, SOURCE_LOCALE, useLocaleWorkspace } from '../lib/locale-editor';

const scan = scanForbidden as (t: string) => Array<{ label: string; match: string }>;
type Ann = { id: string; enabled: boolean; text: Tri; href?: string; startsAt?: string; endsAt?: string };

const toLocal = (iso?: string) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—');
const toInput = (iso?: string) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
const fromInput = (v: string) => (v ? new Date(v).toISOString() : undefined);

export default function AnnouncementPage() {
  const language = useLocaleWorkspace();
  const [e, setE] = useState<Partial<Ann>>({});
  const [textE, setTextE] = useState<Partial<Tri>>({});
  const dirty = Object.keys(e).length > 0 || Object.keys(textE).length > 0;
  const { draft, saving, conflict, clearConflict, save, reload } = useDraft(dirty);
  useFocusField(undefined, !!draft);

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
  for (const l of LOCALES) {
    if ((a.text[l] ?? '').length > 120) errs.push(`${LOCALE_NAME[l]} 文案超 120 字符(当前 ${a.text[l].length},超出 ${a.text[l].length - 120})`);
  }
  if (a.startsAt && a.endsAt && Date.parse(a.endsAt) <= Date.parse(a.startsAt)) errs.push('结束时间须晚于开始时间');
  if (a.href && !/^(https:\/\/|\/)/.test(a.href)) errs.push('链接须为 https:// 开头或站内路径(/ 开头)');
  if (a.enabled) {
    for (const l of draft.enabledLocales ?? LOCALES) if (!a.text[l]?.trim()) errs.push(`启用的公告 ${LOCALE_NAME[l]} 文案必填`);
    if (!a.startsAt || !a.endsAt) errs.push('启用的公告须有起止时间');
  }
  const hits = LOCALES.flatMap((l) => scan(a.text[l] ?? '').map((h) => `${LOCALE_NAME[l]}:${h.match}`));

  return (
    <section className="editor-page">
      <header className="page-heading">
        <span className="eyebrow">内容管理</span>
        <h2>限时公告</h2>
        <p className="page-description">在官网顶部展示一条限时通知。保存并发布后，公告按设定时间自动出现和结束。</p>
      </header>
      <LocaleToolbar workspace={language} enabledLocales={draft.enabledLocales} optional={!a.enabled} gaps={a.text[language.target]?.trim() ? [] : [{ path: `announcement.text.${language.target}`, label: '公告文案' }]} />
      <p className="kv">访客关闭后，同一条公告不再弹出；修改公告内容并发布后会重新展示。</p>
      {conflict && <div className="note bad">草稿已在别处更新,保存被拒 <button className="btn ghost sm" onClick={() => { setE({}); setTextE({}); clearConflict(); reload(); }}>刷新后重试</button></div>}
      <div className="card" style={{ marginBottom: 10 }} data-field="announcement.enabled" data-field-alt="announcement">
        <div className="row">
          <b>总开关</b>
          <label className="tap44" title="总开关"><input aria-label="启用公告" type="checkbox" style={{ width: '1.125rem', height: '1.125rem' }} checked={a.enabled} onChange={(ev) => setE((s) => ({ ...s, enabled: ev.target.checked }))} /></label>
          <span className={`pill ${winState === '展示中' ? 'brand' : winState === '未启用' ? '' : 'warn'}`}>草稿预览 · {winState}</span>
        </div>
      </div>
      <LocalePair workspace={language} reference={language.reference ? a.text[language.reference] ?? '' : ''} label="公告文案">
        {[language.target].map((l) => (
          <div className="card" key={l} data-field={`announcement.text.${l}`}>
            <div className="field" style={{ margin: 0 }}>
              <TranslatedTextarea label={<>{LOCALE_NAME[l]}文案{l === SOURCE_LOCALE && ' · 源语言'}<span className="kv" style={{ marginLeft: 6, color: (a.text[l] ?? '').length > 120 ? 'var(--bad)' : undefined }}>系统长度 {(a.text[l] ?? '').length}/120</span></>}
                draftFieldId={pointer('announcement', 'text', l)} targetLocale={l} source={a.text[SOURCE_LOCALE]}
                id={`announcement-${l}`} value={a.text[l] ?? ''} onValueChange={(value) => setTextE((s) => ({ ...s, [l]: value }))} />
            </div>
          </div>
        ))}
      </LocalePair>
      <div className="field-grid" style={{ marginTop: 10 }}>
        <div className="card" data-field="announcement.href"><div className="field" style={{ margin: 0 }}><label htmlFor="announcement-link">跳转链接（可选）</label>
          <input id="announcement-link" aria-describedby="announcement-link-length" placeholder="https://… 或 /站内路径" value={a.href ?? ''} onChange={(ev) => setE((s) => ({ ...s, href: ev.target.value.trim() || undefined }))} />
          <TextLimitHint id="announcement-link-length" fieldId="/announcement/href" locale={language.target} value={a.href ?? ''} /></div></div>
        <div className="card" data-field="announcement.startsAt"><div className="field" style={{ margin: 0 }}><label htmlFor="announcement-start">开始时间（本地时间）</label>
          <input id="announcement-start" type="datetime-local" value={toInput(a.startsAt)} onChange={(ev) => setE((s) => ({ ...s, startsAt: fromInput(ev.target.value) }))} /><span className="kv">当前：{toLocal(a.startsAt)}</span></div></div>
        <div className="card" data-field="announcement.endsAt"><div className="field" style={{ margin: 0 }}><label htmlFor="announcement-end">结束时间（本地时间）</label>
          <input id="announcement-end" type="datetime-local" value={toInput(a.endsAt)} onChange={(ev) => setE((s) => ({ ...s, endsAt: fromInput(ev.target.value) }))} /><span className="kv">当前：{toLocal(a.endsAt)}</span></div></div>
      </div>
      {a.enabled && (
        <div className="card" style={{ marginTop: 10 }}>
          <h3>草稿 · {LOCALE_NAME[language.target]}站顶预览</h3>
          <div style={{ background: 'var(--brand-soft)', borderRadius: 8, padding: '8px 12px' }}>
            {a.text[language.target] || <i className="kv">(当前语言为空)</i>} {a.href && <span className="kv">→ {a.href}</span>}
          </div>
        </div>
      )}
      {errs.map((x, i) => <div className="note bad" key={i}>{x}</div>)}
      {hits.map((h, i) => <div className="note bad" key={'h' + i}>合规拦截:{h}(可存草稿,发布将被拒)</div>)}
      <div className="editor-actions">
        <button className="btn primary" disabled={!dirty || saving || errs.length > 0}
          onClick={async () => {
            const submitted = submissionSnapshot(e);
            const submittedText = submissionSnapshot(textE);
            const ok = await save((d) => {
              Object.assign(d.announcement, submitted);
              Object.assign(d.announcement.text, submittedText);
            }, undefined, Object.keys(submittedText).map((locale) => pointer('announcement', 'text', locale)));
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
