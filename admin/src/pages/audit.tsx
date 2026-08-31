/* 审计日志(CON14 ⑤⑥:过滤/游标/展开/CSV;append-only 只读) */
import { useEffect, useState } from 'react';
import { api, toast } from '../api';

interface Row {
  id: number; ts: number; actor: string; action: string;
  target: string | null; before_summary: string | null; after_summary: string | null; reason: string | null;
}

const FILTERS = [
  ['', '全部'], ['config.', '内容'], ['geo.', '规则'], ['login.', '登录'], ['auth.', '账号'], ['admin.', '运维'],
] as const;

export default function AuditPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [filter, setFilter] = useState('');
  const [next, setNext] = useState<number | null>(null);
  const [err, setErr] = useState(false);
  const [open, setOpen] = useState<number | null>(null);

  async function load(action: string, before: number | null, append: boolean) {
    try {
      setErr(false);
      if (!append) setRows(null);
      const q = new URLSearchParams({ limit: '50' });
      if (action) q.set('action', action);
      if (before) q.set('before', String(before));
      const r = await api<{ items: Row[]; nextBefore: number | null }>(`/api/audit?${q}`);
      setRows((prev) => (append && prev ? [...prev, ...r.items] : r.items));
      setNext(r.items.length === 50 ? r.nextBefore : null);
    } catch {
      setErr(true);
      if (!append) setRows([]);
    }
  }
  useEffect(() => { void load(filter, null, false); }, [filter]);

  function exportCsv() {
    if (!rows?.length) return toast('当前无可导出记录');
    const esc = (s: unknown) => `"${String(s ?? '').replaceAll('"', '""')}"`;
    const csv = ['id,time,actor,action,target,before,after,reason',
      ...rows.map((r) => [r.id, new Date(r.ts).toISOString(), r.actor, r.action, r.target, r.before_summary, r.after_summary, r.reason].map(esc).join(','))].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
    a.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    toast(`已导出 ${rows.length} 行(当前已加载范围)`);
  }

  return (
    <section>
      <h2>审计日志 <span className="pill">append-only · 不可改删</span></h2>
      <div className="row" style={{ marginBottom: 10 }}>
        {FILTERS.map(([v, label]) => (
          <button key={v} className={`pill ${filter === v ? 'brand' : ''}`} onClick={() => setFilter(v)} style={{ cursor: 'pointer' }}>{label}</button>
        ))}
        <span className="spacer" />
        <button className="btn sm" onClick={exportCsv}>导出 CSV</button>
      </div>
      {err && <div className="note bad">加载失败 <button className="btn ghost sm" onClick={() => load(filter, null, false)}>重试</button></div>}
      <div className="card">
        {rows === null ? (
          <div className="grid"><div className="skl" /><div className="skl" /><div className="skl" style={{ width: '60%' }} /></div>
        ) : rows.length === 0 ? (
          <p className="kv" style={{ padding: 8 }}>没有匹配记录</p>
        ) : (
          <table>
            <thead><tr><th>时间</th><th>动作</th><th>对象</th><th>变更</th><th>理由</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} onClick={() => setOpen(open === r.id ? null : r.id)} style={{ cursor: 'pointer' }}>
                  <td className="mono kv">{new Date(r.ts).toLocaleString('zh-CN', { hour12: false })}</td>
                  <td><b>{r.action}</b></td>
                  <td>{r.target ?? '—'}</td>
                  <td style={open === r.id ? {} : { maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {[r.before_summary, r.after_summary].filter(Boolean).join(' → ') || '—'}
                  </td>
                  <td>{r.reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {next && <button className="btn ghost" style={{ marginTop: 10 }} onClick={() => load(filter, next, true)}>加载更早 …</button>}
      </div>
    </section>
  );
}
