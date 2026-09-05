/* 审计日志(CON14 ⑤⑥:过滤/游标/展开/CSV;append-only 只读) */
import { useEffect, useRef, useState } from 'react';
import { api, toast } from '../api';
import { LatestRequest } from '../lib/latest-request';

interface Row {
  id: number; ts: number; actor: string; action: string;
  target: string | null; before_summary: string | null; after_summary: string | null; reason: string | null;
}

/* 动作码 → 人话。审计是给人看的追责面,不该逼人认机器词;
   机器码仍在下面小字保留(排查时要能对上日志),但主视线是人话。
   缺映射时显示原码——不隐藏,但那说明表该补了(gate-console-copy 守这张表不许有死键)。 */
const ACTION_LABEL: Record<string, string> = {
  'auth.setup.attempt': '尝试初始化', 'auth.setup.fail': '初始化失败', 'auth.setup': '完成初始化',
  'login.attempt': '尝试登录', 'login.success': '登录成功', 'login.fail': '登录失败', 'auth.logout': '退出登录',
  'admin.rollup': '手动重算统计', 'config.save': '保存草稿', 'geo.update': '修改区域屏蔽规则',
  'geo.update.attempt': '尝试修改区域屏蔽规则', 'geo.update.applied': '区域屏蔽规则已应用', 'bypass.issue': '签发区域直通链接',
  'config.publish': '发起发布', 'config.publish.live': '发布成功上线', 'config.publish.failed': '发布失败',
  'config.publish.unknown': '发布切换结果待核实',
  'config.publish.cancel': '取消发布', 'config.publish.rejected': '发布被拒(已有发布进行中)', 'config.rollback': '发起回滚',
};

/* 类别与服务端的 AUDIT_GROUPS 一一对应(前端只传类别名,归类规则单源在服务端)。
   🔴 上一版按前缀分,于是「发布」这一类建不出来 —— 发布/回滚/取消全被塞进「内容」,
   而 CON14-② 写死的四类里就有「发布」(第十轮独立验收 P1-5)。
   另:退出登录曾归「账号」、登录归「登录」,查一次会话进出要点两个页签,现在合成「登录与账号」。 */
const FILTERS = [
  ['', '全部'], ['content', '内容改动'], ['publish', '发布与回滚'], ['geo', '区域规则'], ['session', '登录与账号'], ['ops', '运维'],
] as const;

export default function AuditPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [filter, setFilter] = useState('');
  const [next, setNext] = useState<number | null>(null);
  const [busyExport, setBusyExport] = useState(false);
  /* 导出结果**常驻**而不是浮层:那句话是「这份文件里到底有多少条、含不含筛选」的唯一交代,
     而浮层 2.6 秒就没了。人往往是先点导出、再去开文件,回头已经无从确认(第十轮 P1)。 */
  const [lastExport, setLastExport] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [listBusy, setListBusy] = useState(false);
  const listRequests = useRef(new LatestRequest());
  const listBusyRef = useRef(false);

  function beginCriteriaChange(change: () => void): void {
    listRequests.current.invalidate();
    listBusyRef.current = true;
    setListBusy(true);
    setRows(null);
    setNext(null);
    setErr(false);
    change();
  }

  /** 把当前筛选(类别 + 时间窗)拼成查询串;导出与列表共用,两处不会各自演化 */
  function queryOf(
    extra: Record<string, string> = {},
    criteria = { filter, from, to },
  ): URLSearchParams {
    const q = new URLSearchParams({ limit: '50', ...extra });
    if (criteria.filter) q.set('group', criteria.filter);
    if (criteria.from) q.set('from', String(Date.parse(criteria.from)));
    // 「到」这一天要**含当天**:输入 2026-09-01 意思是截到那天 23:59:59,不是 00:00
    if (criteria.to) q.set('to', String(Date.parse(criteria.to) + 86_399_999));
    return q;
  }

  async function load(action: string, before: number | null, append: boolean) {
    if (append && listBusyRef.current) return;
    const requestToken = listRequests.current.begin();
    listBusyRef.current = true;
    setListBusy(true);
    try {
      setErr(false);
      if (!append) {
        setRows(null);
        setNext(null);
      }
      const q = queryOf();
      if (action) q.set('group', action);
      if (before) q.set('before', String(before));
      const r = await api<{ items: Row[]; nextBefore: number | null }>(`/api/audit?${q}`);
      if (!listRequests.current.isCurrent(requestToken)) return;
      setRows((prev) => (append && prev ? [...prev, ...r.items] : r.items));
      setNext(r.items.length === 50 ? r.nextBefore : null);
    } catch {
      if (!listRequests.current.isCurrent(requestToken)) return;
      /* 🔴 取不到 ≠ 没发生过(2026-09-01 实景走查 P1)。
         此前这里 `setRows([])`,于是加载失败时页面同屏显示「加载失败」和「没有匹配记录」——
         而这是**追责面**:把「我查不到」画成「查过了,没有」,是这一页最不该说的一句话。
         保持 rows 为 null(渲染成加载/未知态),只显示失败与重试。 */
      setErr(true);
      if (!append) setRows(null);
    } finally {
      if (listRequests.current.isCurrent(requestToken)) {
        listBusyRef.current = false;
        setListBusy(false);
      }
    }
  }
  // 类别或时间窗一变就重查(时间窗也参与,否则改了日期没反应)
  useEffect(() => { void load(filter, null, false); }, [filter, from, to]);
  useEffect(() => () => listRequests.current.invalidate(), []);

  /* 🔴 导出必须是**当前筛选下的全部记录**,不是屏幕上已加载的那 50 行
     (2026-09-01 第十轮独立验收 P1:库里 95 行、导出文件只有 50 行,
      事前无提示、事后只有一条 2.6 秒就消失的浮层写着「当前已加载范围」)。
     审计是追责面,一份**静悄悄少了一半**的存档比没有存档更危险 ——
     拿到它的人不会知道自己看的是残缺的。
     所以这里自己翻页拉全,拉不完就明说拉到哪儿为止,绝不默默截断。 */
  async function exportCsv() {
    if (busyExport) return;
    /* 一次导出只认点击那一刻的筛选快照；翻页期间 UI 即使重渲染，也不能把新条件和旧 cursor 混用。 */
    const criteria = { filter, from, to };
    setBusyExport(true);
    let all: Row[] = [];
    let cursor: number | null = null;
    let truncated = false;
    try {
      for (;;) {
        const q = queryOf({ limit: '200' }, criteria);
        if (cursor) q.set('before', String(cursor));
        const r: { items: Row[]; nextBefore: number | null } = await api(`/api/audit?${q}`);
        all = all.concat(r.items);
        cursor = r.items.length === 200 ? r.nextBefore : null;
        if (!cursor) break;
        // 上限只为防跑飞;真撞上要**说出来**,不能让人以为导全了
        if (all.length >= 20000) { truncated = true; break; }
      }
    } catch {
      setBusyExport(false);
      return toast('导出失败:记录没取全,已取消(不会给出残缺文件)');
    }
    setBusyExport(false);
    if (!all.length) return toast('当前筛选下没有记录可导出');
    const rows = all;
    const esc = (s: unknown) => `"${String(s ?? '').replaceAll('"', '""')}"`;
    /* 机器码与人话**都要**:机器码是给 Excel 筛选/比对的稳定键(不能翻),
       人话是给读这份存档的人的。只给一边,另一边就得自己翻——而审计存档常常是
       出事之后给不熟悉本系统的人看的(实景走查 P1-3 的延伸)。 */
    const csv = ['id,time,actor,action,action_label,target,target_label,before,after,reason',
      ...rows.map((r) => [
        r.id, new Date(r.ts).toISOString(), r.actor,
        r.action, ACTION_LABEL[r.action] ?? '',
        r.target, !r.target || r.target === 'unknown' ? '来源不详' : r.target,
        r.before_summary, r.after_summary, r.reason,
      ].map(esc).join(','))].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
    a.download = `audit-${new Date().toISOString().slice(0, 10)}${criteria.filter ? `-${criteria.filter.replace(/\W+/g, '')}` : ''}.csv`;
    a.click();
    setLastExport(`已导出 ${rows.length} 行${criteria.filter ? `(筛选:${FILTERS.find(([v]) => v === criteria.filter)?.[1] ?? criteria.filter})` : '(全部记录)'}${truncated ? ' —— 已达 20000 行上限,更早的记录未包含' : ''}`);
  }

  return (
    <section>
      <h2>审计日志 <span className="pill">append-only · 不可改删</span></h2>
      <div className="row" style={{ marginBottom: 10 }}>
        {FILTERS.map(([v, label]) => (
          <button
            key={v}
            className={`pill ${filter === v ? 'brand' : ''}`}
            disabled={busyExport}
            onClick={() => { if (v !== filter) beginCriteriaChange(() => setFilter(v)); }}
            style={{ cursor: 'pointer' }}
          >{label}</button>
        ))}
        <span className="spacer" />
        {/* 时间过滤(CON14-② A1 与 ⑤ 两处明写)。出事后最常问的是「昨天下午发生了什么」,
            上一版一个日期输入都没有,只能靠底部「加载更早」一次 50 条往回按。 */}
        <label className="kv" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          从 <input type="date" value={from} max={to || undefined} disabled={busyExport} onChange={(e) => beginCriteriaChange(() => setFrom(e.target.value))} style={{ width: 150 }} />
        </label>
        <label className="kv" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          到 <input type="date" value={to} min={from || undefined} disabled={busyExport} onChange={(e) => beginCriteriaChange(() => setTo(e.target.value))} style={{ width: 150 }} />
        </label>
        {(from || to) && <button className="btn ghost sm" disabled={busyExport} onClick={() => beginCriteriaChange(() => { setFrom(''); setTo(''); })}>清除时间</button>}
        <button className="btn sm" disabled={busyExport} onClick={() => void exportCsv()} title="导出当前筛选下的全部记录,不只是屏幕上已加载的">
          {busyExport ? '导出中…' : '导出 CSV'}
        </button>
      </div>
      {lastExport && <div className="note" style={{ marginBottom: 10 }}>{lastExport}</div>}
      {err && <div className="note bad">加载失败 <button className="btn ghost sm" onClick={() => load(filter, null, false)}>重试</button></div>}
      <div className="card">
        {rows === null && err ? (
          /* 失败态:既不显示「没有匹配记录」(那是在说谎),也不永远转骨架屏(那是在假装还在加载) */
          <p className="kv" style={{ padding: 8 }}>这一段记录当前取不到,不代表没有发生过。请点上方「重试」。</p>
        ) : rows === null ? (
          <div className="grid"><div className="skl" /><div className="skl" /><div className="skl" style={{ width: '60%' }} /></div>
        ) : rows.length === 0 ? (
          /* 空态要说清「为什么空」并给出口:光写「没有匹配记录」时,人分不出是这个筛选下没有、
             还是系统压根没记(审计是追责面,这两件事的分量完全不同)。 */
          <div style={{ padding: '18px 8px' }}>
            {/* 空态要说清是**哪个**筛选造成的:类别、时间窗,还是真的一条都没有 */}
            <p className="kv" style={{ margin: 0 }}>
              {filter || from || to
                ? `当前筛选下没有记录${filter ? `(类别:${FILTERS.find(([v]) => v === filter)?.[1] ?? filter})` : ''}${from || to ? `(时间:${from || '最早'} 至 ${to || '现在'})` : ''}。`
                : '还没有任何操作记录。'}
            </p>
            <p className="kv" style={{ margin: '6px 0 0' }}>
              {filter || from || to ? '放宽筛选再看一次,已发生的动作都会在这里留痕。' : '登录、改内容、改规则、发布,任一动作发生后即刻在此留痕。'}
            </p>
            {(filter || from || to) && (
              <button className="btn ghost" style={{ marginTop: 10 }} onClick={() => beginCriteriaChange(() => { setFilter(''); setFrom(''); setTo(''); })}>清空筛选,看全部</button>
            )}
          </div>
        ) : (
          <table>
            <thead><tr><th>时间</th><th>动作</th><th>对象</th><th>变更</th><th>理由</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                /* 🔴 只有**真有东西可展开**的行才做成可点(第十轮 P2-13):
                   上一版整行都是 `cursor:pointer`,而短行点下去 innerText 一个字都不变 ——
                   界面上每个看起来能点的位置,要么有效,要么别让它看起来能点。 */
                const expandable = ((r.before_summary ?? '') + (r.after_summary ?? '')).length > 60;
                return (
                <tr
                  key={r.id}
                  onClick={expandable ? () => setOpen(open === r.id ? null : r.id) : undefined}
                  style={expandable ? { cursor: 'pointer' } : undefined}
                  title={expandable ? '点击展开完整变更内容' : undefined}
                >
                  <td className="mono kv">{new Date(r.ts).toLocaleString('zh-CN', { hour12: false })}</td>
                  {/* enum-ok:主视线是人话,下面小字**刻意**保留机器码——排查时要能和日志对上 */}
                  <td><b>{ACTION_LABEL[r.action] ?? r.action}</b>{ACTION_LABEL[r.action] ? <div className="kv mono">{r.action}</div> : null}</td>
                  {/* 「对象」列不印内部占位词:登录类事件的对象是来访 IP,取不到时服务端写 'unknown',
                      直接印出来运营会以为是个真值(实景走查 P1-3)。 */}
                  <td>{!r.target || r.target === 'unknown' ? <span className="kv">来源不详</span> : r.target}</td>
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
                );
              })}
            </tbody>
          </table>
        )}
        {next && <button className="btn ghost" disabled={listBusy} style={{ marginTop: 10 }} onClick={() => void load(filter, next, true)}>{listBusy ? '加载中…' : '加载更早 …'}</button>}
      </div>
    </section>
  );
}
