/* 平台统计数字(CON06 ⑤⑥):五数字+口径月;锚值软警(R49-A2);三语格式预览。高敏模块。 */
import { useState } from 'react';
import { daysSince, grownValue, type GrowingKey, type StatsGrowth } from '../../../schema/src/stats-growth';
import { retainPostSubmit, submissionSnapshot } from '../lib/async-state';
import { fieldName } from '../lib/human-path';
import { NumericInput, parseNumericInput } from '../lib/numeric-input';
import { useDraft } from '../lib/use-draft';
import { useFocusField } from '../lib/use-focus-field';

const ANCHORS: Record<string, number> = { activeDevices: 28432, activeJobs: 4812, nodes: 156, countries: 47, uptime: 99.7 };
const FIELDS = [
  ['activeDevices', 'Active devices(活跃设备)', 0],
  ['activeJobs', 'AI jobs running(在跑任务)', 0],
  ['nodes', 'Network nodes(节点)', 0],
  ['countries', 'Countries(国家数)', 0],
  ['uptime', 'Uptime %(可用率)', 1],
] as const;

function fmt(n: number, decimals: number, tag: string): string {
  if (!Number.isFinite(n)) return '';
  if (n >= 999500) return `${(n / 1e6).toLocaleString(tag, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}M`;
  if (n >= 99950) return `${(n / 1e3).toLocaleString(tag, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}K`;
  return n.toLocaleString(tag, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

const GROWING = [
  ['activeDevices', '活跃设备'], ['activeJobs', '运行中任务'], ['nodes', '节点'], ['countries', '覆盖国家'],
] as const;
const DEFAULT_GROWTH: StatsGrowth = { enabled: false, since: new Date().toISOString().slice(0, 10), daily: { activeDevices: 0, activeJobs: 0, nodes: 0, countries: 0 } };
type GrowthDraft = Omit<StatsGrowth, 'daily'> & { daily: Record<GrowingKey, string> };

const growthDraftOf = (growth: StatsGrowth): GrowthDraft => ({
  ...growth,
  daily: {
    activeDevices: String(growth.daily.activeDevices),
    activeJobs: String(growth.daily.activeJobs),
    nodes: String(growth.daily.nodes),
    countries: String(growth.daily.countries),
  },
});

const parsedGrowthOf = (growth: GrowthDraft): StatsGrowth => ({
  enabled: growth.enabled,
  since: growth.since,
  daily: {
    activeDevices: parseNumericInput(growth.daily.activeDevices) ?? Number.NaN,
    activeJobs: parseNumericInput(growth.daily.activeJobs) ?? Number.NaN,
    nodes: parseNumericInput(growth.daily.nodes) ?? Number.NaN,
    countries: parseNumericInput(growth.daily.countries) ?? Number.NaN,
  },
});

export default function StatsPage() {
  useFocusField(); // 「去修复」带来的 ?focus=<字段> 由它定位并高亮
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [growthE, setGrowthE] = useState<GrowthDraft | null>(null);
  const dirty = Object.keys(edits).length > 0 || growthE !== null;
  const { draft, saving, conflict, save, reload } = useDraft(dirty);

  if (!draft) return <section><h2>平台统计数字</h2><div className="skl" style={{ height: 80 }} /></section>;

  const growthBase = (draft.stats as { growth?: StatsGrowth }).growth ?? DEFAULT_GROWTH;
  const growth: GrowthDraft = growthE ?? growthDraftOf(growthBase);
  const parsedGrowth = parsedGrowthOf(growth);
  const setGrowth = (g: GrowthDraft) => setGrowthE(g);
  /* 起算日在未来 = 配置写错了:公式会按 0 天算,于是数字看起来「不长」,
     而人会以为是开关没生效 —— 说出来,别让人猜。 */
  const growthErr = growth.enabled && Date.parse(`${growth.since}T00:00:00Z`) > Date.now() ? '起算日在未来,数字要等到那天才开始长' : '';

  const cur = (k: string): number | string => (k in edits ? edits[k]! : (draft.stats as Record<string, number | string>)[k]!);
  const numOf = (k: string) => Number(cur(k));
  const errs: string[] = [];
  for (const [k, , dec] of FIELDS) {
    const v = numOf(k);
    if (!Number.isFinite(v) || v <= 0) errs.push(`${fieldName(k)}:须填一个大于 0 的数`);
    else if (k === 'uptime' && v > 100) errs.push(`${fieldName('uptime')}:不得超过 100`);
    else if (dec === 0 && !Number.isInteger(v)) errs.push(`${fieldName(k)}:须为整数(不能有小数)`);
  }
  for (const [k, label] of GROWING) {
    const daily = parseNumericInput(growth.daily[k]);
    if (daily === null || daily < 0) errs.push(`${label}每天增量：须填一个不小于 0 的数`);
  }
  const asOf = String(cur('asOf'));
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(asOf)) errs.push('口径月格式:YYYY-MM(月份 01-12)');
  const anchorHits = FIELDS.filter(([k]) => numOf(k) === ANCHORS[k]).map(([k]) => k);
  return (
    <section>
      <h2>平台统计数字 <span className="pill warn">高敏 · 发布须理由</span></h2>
      {conflict && <div className="note bad">草稿已在别处更新,本次保存被拒 <button className="btn ghost sm" onClick={() => { setEdits({}); setGrowthE(null); reload(); }}>刷新后重试</button></div>}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
        {FIELDS.map(([k, label]) => (
          // data-field:「去修复」的落点(useFocusField 逐级剥尾匹配到这一级)
          <div className="card" key={k} data-field={`stats.${k}`}>
            <div className="field" style={{ margin: 0 }}>
              <label>{label}</label>
              <NumericInput className="mono" value={String(cur(k))} onValueChange={(value) => setEdits((s) => ({ ...s, [k]: value.trim() }))} />
            </div>
            {/* 🔴 主人 2026-09-01 拍板:平台数字**全部后台模拟、不接真实数据**。
                于是「和内置初值一样」不再是待办 —— 它只是「这一项还没调过」。
                旧文案写的是「上线前请换成真实口径值,否则生产发布会被拦下」,
                那条指令在拍板之后已经过期:留着它等于让人去做一件不会发生的事。 */}
            {anchorHits.includes(k) ? (
              <div className="kv" style={{ marginTop: 6 }}>仍是初始值(可直接用,也可按需调)</div>
            ) : (
              <div className="kv" style={{ marginTop: 6 }}>✓ 已按需调整过</div>
            )}
          </div>
        ))}
        <div className="card">
          <div className="field" style={{ margin: 0 }}>
            <label>口径月(站上 “Data as of”)</label>
            <input className="mono" value={asOf} onChange={(e) => setEdits((s) => ({ ...s, asOf: e.target.value.trim() }))} placeholder="YYYY-MM" />
          </div>
        </div>
      </div>
      {/* 🔴 线性增长(主人 2026-09-01 拍板:平台数字全部后台模拟、不接真实数据,但要会自己长)。
          上面填的是**起算日那天**的值;站上显示 = 它 + 日增量 ×(今天 − 起算日)。 */}
      <div className="card" style={{ marginTop: 10 }} data-field="stats.growth">
        <div className="row">
          <h3 style={{ margin: 0 }}>自动增长</h3>
          <label className="tap44" title="开启后站上数字每天自己往上走">
            <input
              type="checkbox" style={{ width: 18, height: 18 }} checked={growth.enabled}
              onChange={(e) => setGrowth({ ...growth, enabled: e.target.checked })}
            />
          </label>
          <span className="pill">{growth.enabled ? '每天自动增长' : '固定不变'}</span>
        </div>
        <p className="kv" style={{ marginTop: 6 }}>
          上面五个数字是<b>起算日那天</b>的值。开启后,站上显示的是「那个值 + 每天增量 × 已过天数」——
          不用人工定期来改,也不接任何真实数据源。
        </p>
        {growth.enabled && (
          <>
            <div className="grid" style={{ gridTemplateColumns: 'repeat(5,1fr)', marginTop: 8 }}>
              <div className="field" style={{ margin: 0 }}>
                <label>起算日</label>
                <input type="date" value={growth.since} onChange={(e) => setGrowth({ ...growth, since: e.target.value })} />
              </div>
              {GROWING.map(([k, label]) => (
                <div className="field" key={k} style={{ margin: 0 }}>
                  <label>{label} · 每天 +</label>
                   <NumericInput
                     className="mono" value={growth.daily[k]}
                     onValueChange={(value) => setGrowth({ ...growth, daily: { ...growth.daily, [k]: value } })}
                   />
                </div>
              ))}
            </div>
            <div className="note info" style={{ marginTop: 8, marginBottom: 0 }}>
              <b>今天站上实际显示:</b>{' '}
              {GROWING.map(([k, label]) => `${label} ${grownValue(numOf(k), k, parsedGrowth, Date.now()).toLocaleString('en-US')}`).join(' · ')}
              <div className="kv" style={{ marginTop: 4 }}>
                起算日至今 {daysSince(growth.since, Date.now())} 天{growthErr && <span style={{ color: 'var(--bad)' }}> · {growthErr}</span>}
              </div>
            </div>
          </>
        )}
      </div>

      <div className="card" style={{ marginTop: 10 }}>
        <h3>站上预览(格式随语言;此处存原始值,格式化由站侧既有规则负责)</h3>
        <div className="mono" style={{ fontSize: 15 }}>
          en {fmt(numOf('activeDevices'), 0, 'en-US')} · vi {fmt(numOf('activeDevices'), 0, 'vi-VN')} · zh {fmt(numOf('activeDevices'), 0, 'zh-CN')}
          <span className="kv" style={{ marginLeft: 10 }}>uptime {fmt(numOf('uptime'), 1, 'en-US')}%</span>
        </div>
      </div>
      {errs.map((e, i) => <div className="note bad" key={i}>{e}</div>)}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn primary" disabled={!dirty || errs.length > 0 || saving}
          onClick={async () => {
            const submittedEdits = submissionSnapshot(edits);
            const submittedGrowth = submissionSnapshot(growthE);
            const ok = await save((d) => {
              const t = d.stats as Record<string, number | string | StatsGrowth>;
              for (const [k, v] of Object.entries(submittedEdits)) t[k] = k === 'asOf' ? v : Number(v);
              if (submittedGrowth) t.growth = parsedGrowthOf(submittedGrowth);
            });
            if (ok) {
              setEdits((current) => retainPostSubmit(current, submittedEdits, {}));
              setGrowthE((current) => retainPostSubmit(current, submittedGrowth, null));
            }
          }}>
          {saving ? '保存中…' : '保存草稿'}
        </button>
        {anchorHits.length > 0 && <span className="kv">当前 {anchorHits.length} 项与内置演示值相同(可保存)</span>}
      </div>
    </section>
  );
}
