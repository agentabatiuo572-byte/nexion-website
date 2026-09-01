/* 审计日志(CON14 ⑤⑥:过滤/游标/展开/CSV;append-only 只读) */
import { useEffect, useState } from 'react';
import { api, toast } from '../api';

interface Row {
  id: number; ts: number; actor: string; action: string;
  target: string | null; before_summary: string | null; after_summary: string | null; reason: string | null;
}

/* 动作码 → 人话。审计是给人看的追责面,不该逼人认机器词;
   机器码仍在下面小字保留(排查时要能对上日志),但主视线是人话。
   缺映射时显示原码——不隐藏,但那说明表该补了(gate-console-copy 守这张表不许有死键)。 */
const ACTION_LABEL: Record<string, string> = {
  'auth.setup': '完成初始化', 'login.success': '登录成功', 'login.fail': '登录失败', 'auth.logout': '退出登录',
  'admin.rollup': '手动重算统计', 'config.save': '保存草稿', 'geo.update': '修改区域屏蔽规则', 'bypass.issue': '签发区域直通链接',
  'config.publish': '发起发布', 'config.publish.live': '发布成功上线', 'config.publish.failed': '发布失败',
  'config.publish.cancel': '取消发布', 'config.publish.rejected': '发布被拒(已有发布进行中)', 'config.rollback': '发起回滚',
};

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
      /* 🔴 取不到 ≠ 没发生过(2026-09-01 实景走查 P1)。
         此前这里 `setRows([])`,于是加载失败时页面同屏显示「加载失败」和「没有匹配记录」——
         而这是**追责面**:把「我查不到」画成「查过了,没有」,是这一页最不该说的一句话。
         保持 rows 为 null(渲染成加载/未知态),只显示失败与重试。 */
      setErr(true);
      if (!append) setRows(null);
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
        {rows === null && err ? (
          /* 失败态:既不显示「没有匹配记录」(那是在说谎),也不永远转骨架屏(那是在假装还在加载) */
          <p className="kv" style={{ padding: 8 }}>这一段记录当前取不到,不代表没有发生过。请点上方「重试」。</p>
        ) : rows === null ? (
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
                  <td><b>{ACTION_LABEL[r.action] ?? r.action}</b>{ACTION_LABEL[r.action] ? <div className="kv mono">{r.action}</div> : null}</td>
                  <td>{r.target ?? '—'}</td>
                  {/* PRD CON14-E3 要「摘要 + 字节数」:折叠时先告诉人这条有多长,他才知道值不值得展开(实景走查 P2-8) */}
                  <td style={open === r.id ? {} : { maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {(() => {
                      const text = [r.before_summary, r.after_summary].filter(Boolean).join(' → ');
                      if (!text) return '—';
                      const bytes = new TextEncoder().encode(text).length;
                      return (
                        <>
                          {text}
                          {bytes > 200 && !(open === r.id) && <span className="kv mono"> · {bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} 字节`},点击展开</span>}
                        </>
                      );
                    })()}
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
