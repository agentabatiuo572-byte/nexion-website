/* 平台统计数字(CON06 ⑤⑥):五数字+口径月;锚值软警(R49-A2);三语格式预览。高敏模块。 */
import { useState } from 'react';
import { fieldName } from '../lib/human-path';
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

export default function StatsPage() {
  useFocusField(); // 「去修复」带来的 ?focus=<字段> 由它定位并高亮
  const { draft, saving, conflict, save, reload } = useDraft();
  const [edits, setEdits] = useState<Record<string, string>>({});

  if (!draft) return <section><h2>平台统计数字</h2><div className="skl" style={{ height: 80 }} /></section>;

  const cur = (k: string): number | string => (k in edits ? edits[k]! : (draft.stats as Record<string, number | string>)[k]!);
  const numOf = (k: string) => Number(cur(k));
  const errs: string[] = [];
  for (const [k, , dec] of FIELDS) {
    const v = numOf(k);
    if (!Number.isFinite(v) || v <= 0) errs.push(`${fieldName(k)}:须填一个大于 0 的数`);
    else if (k === 'uptime' && v > 100) errs.push(`${fieldName('uptime')}:不得超过 100`);
    else if (dec === 0 && !Number.isInteger(v)) errs.push(`${fieldName(k)}:须为整数(不能有小数)`);
  }
  const asOf = String(cur('asOf'));
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(asOf)) errs.push('口径月格式:YYYY-MM(月份 01-12)');
  const anchorHits = FIELDS.filter(([k]) => numOf(k) === ANCHORS[k]).map(([k]) => k);
  const dirty = Object.keys(edits).length > 0;

  return (
    <section>
      <h2>平台统计数字 <span className="pill warn">高敏 · 发布须理由</span></h2>
      {conflict && <div className="note bad">草稿已在别处更新,本次保存被拒 <button className="btn ghost sm" onClick={() => { setEdits({}); reload(); }}>刷新后重试</button></div>}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
        {FIELDS.map(([k, label]) => (
          // data-field:「去修复」的落点(useFocusField 逐级剥尾匹配到这一级)
          <div className="card" key={k} data-field={`stats.${k}`}>
            <div className="field" style={{ margin: 0 }}>
              <label>{label}</label>
              <input className="mono" value={String(cur(k))} onChange={(e) => setEdits((s) => ({ ...s, [k]: e.target.value.trim() }))} />
            </div>
            {/* 内部门编号(R49-F1)运营既查不到也用不上,不该印在页面上(第十轮 P2-6) */}
            {anchorHits.includes(k) ? (
              <div className="note warn" style={{ margin: '8px 0 0' }}>与内置演示值相同——上线前请换成真实口径值,否则生产发布会被拦下</div>
            ) : (
              <div className="kv" style={{ marginTop: 6 }}>✓ 非演示锚值</div>
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
            const ok = await save((d) => {
              const t = d.stats as Record<string, number | string>;
              for (const [k, v] of Object.entries(edits)) t[k] = k === 'asOf' ? v : Number(v);
            });
            if (ok) setEdits({});
          }}>
          {saving ? '保存中…' : '保存草稿'}
        </button>
        {anchorHits.length > 0 && <span className="kv">当前 {anchorHits.length} 项仍为演示锚值(可保存;上线前须真值化)</span>}
      </div>
    </section>
  );
}
