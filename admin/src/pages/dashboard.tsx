/* 驾驶舱(CON03 ⑤⑥):16 个独立模块 + 加载/失败/空/有数据四态。
   诚实口径三原则:①缺数据显「—」不插值 ②比率标注口径(按日相加,非唯一访客)
   ③下载为「点击」口径,商店安装数不在本站数据面,不冒充。 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { api } from '../api';
import { failReasonLine } from '../lib/fail-reason';
import { countryName } from '../lib/iso-countries';
import { LatestRequest } from '../lib/latest-request';
import { LOCALE_NAME } from '../lib/human-path';
import { Icon } from '../lib/icon';
import './dashboard.css';

type Maybe<T> = T | { error: true };
const isErr = (x: unknown): x is { error: true } => !!x && typeof x === 'object' && (x as { error?: boolean }).error === true;

interface Dash {
  range: number; from: string; to: string;
  overview: {
    traffic: Maybe<{ pv: number; uv: number; sessions: number; deltaUv: number | null; hasData: boolean }>;
    downloads: Maybe<{ ctaClicks: number; byCta: Array<{ cta_id: string; clicks: number }>; deltaCta: number | null }>;
    conversion: Maybe<{ ctaVisitors: number; starRate: number | null; starRatePrev: number | null }>;
  };
  trend: Maybe<Array<{ date: string; pv: number; uv: number; cta: number }>>;
  funnel: Maybe<{ uv: number; download: number; trust: number; cta: number }>;
  locales: Maybe<Array<{ locale: string; uv: number; pv: number; share: number; rate: number | null }>>;
  dims: { sources: Maybe<Array<{ k: string; uv: number }>>; countries: Maybe<Array<{ k: string; uv: number }>>; devices: Maybe<Array<{ k: string; uv: number }>> };
  content: {
    pages: Maybe<Array<{ path: string; locale: string; pv: number; uv: number }>>;
    faq: Maybe<Array<{ faq_id: string; opens: number }>>;
    learn: Maybe<Array<{ slug: string; reads: number }>>;
    sections: Maybe<Array<{ section_id: string; uniq: number }>>;
  };
  quality: Maybe<{ latest: { date: string; lcp_p75: number; cls_p75: number; n: number } | null; errors: number | null; notFound: Array<{ path: string; hits: number }>; notFoundTotal: number | null }>;
  health: Maybe<{
    botShare: number | null; botLegacy: boolean; botDays: { covered: number; total: number }; blocked: number; blockedShare: number | null;
    blockedTop: Array<{ country: string; hits: number }>;
    geo: { enabled: boolean; countries: number; degraded: boolean } | null;
    lastPublish: { id: number; status: string; fail_reason: string | null } | null;
    probes: Array<{ target: string; url: string; ok: boolean; status: number; fail_streak: number; checked_at: number; alert: boolean }>;
  }>;
  todayLive: Maybe<{ pv: number; uv: number; cta: number; blocked: number }>;
}

const RANGES = [7, 30, 90];
const pct = (v: number | null | undefined, digits = 1) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(digits)}%`);
const num = (v: number | null | undefined) => (v === null || v === undefined ? '—' : v.toLocaleString('zh-CN'));
const CTA_LABEL: Record<string, string> = { ios: 'iOS', android: 'Android', h5: 'Web App', contact: '联系' };
const SEC_LABEL: Record<string, string> = {
  download: '首屏下载区', stats: '实时数字', social: '社证', mission: '使命', devices: '设备阶梯',
  how: 'How it works', path: '收益路径', trust: '信任板块', nex: 'NEX', 'learn-entry': '学习入口', faq: 'FAQ', 'final-cta': '收尾 CTA',
};

function Card({ title, note, children, className = '', action }: { title: string; note?: string; children: React.ReactNode; className?: string; action?: React.ReactNode }) {
  return (
    <div className={`card dash-card ${className}`}>
      <div className="dash-card-heading"><h3>{title}</h3>{action}</div>
      {children}
      {note && <div className="kv dash-card-note">{note}</div>}
    </div>
  );
}
const ErrCard = ({ title, onRetry }: { title: string; onRetry: () => void }) => (
  <Card title={title}><div className="note bad dash-card-error">本卡数据查询失败 <button className="btn ghost sm" onClick={onRetry}>重试</button></div></Card>
);
const Bar = ({ v, max }: { v: number; max: number }) => (
  <div className="dash-bar" aria-hidden="true">
    <i style={{ width: `${max > 0 ? Math.min(100, Math.max(0, (v / max) * 100)) : 0}%` }} />
  </div>
);

type TrendRow = { date: string; pv: number; uv: number; cta: number };
const METRICS = { uv: '独立访客 UV', pv: '页面浏览 PV', cta: '下载点击' };
const axisNumber = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });
const dayTime = (date: string) => Date.parse(`${date}T00:00:00Z`);
const DAY = 86_400_000;

function Trend({ rows, from, to }: { rows: TrendRow[]; from: string; to: string }) {
  const [metric, setMetric] = useState<keyof typeof METRICS>('uv');
  const [activeDate, setActiveDate] = useState<string | null>(null);
  const gradient = useId();
  const data = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const active = data.find((row) => row.date === activeDate) ?? data.at(-1);
  const max = Math.max(4, Math.ceil(Math.max(...data.map((row) => row[metric]), 0) / 4) * 4);
  const start = dayTime(from);
  const duration = Math.max(dayTime(to) - start, DAY);
  const x = (row: TrendRow) => ((dayTime(row.date) - start) / duration) * 100;
  const y = (row: TrendRow) => 100 - (row[metric] / max) * 100;
  const selectAt = (event: React.MouseEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!data.length || bounds.width <= 0) return;
    const time = start + Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) * duration;
    const nearest = data.reduce((closest, row) => Math.abs(dayTime(row.date) - time) < Math.abs(dayTime(closest.date) - time) ? row : closest);
    setActiveDate(nearest.date);
  };
  const segments: TrendRow[][] = [];
  for (const row of data) {
    const previous = segments.at(-1)?.at(-1);
    if (!previous || dayTime(row.date) - dayTime(previous.date) > DAY) segments.push([row]);
    else segments.at(-1)!.push(row);
  }

  return <Card title="按日趋势" className="dash-trend" action={
    <div className="dash-metric-tabs" aria-label="趋势指标">
      {(Object.keys(METRICS) as Array<keyof typeof METRICS>).map((key) => <button key={key} aria-pressed={metric === key} onClick={() => setMetric(key)}>{key === 'cta' ? '点击' : key.toUpperCase()}</button>)}
    </div>
  }>
    <div className="dash-trend-summary"><div><strong>{data.length ? num(data.reduce((total, row) => total + row[metric], 0)) : '—'}</strong><span>{METRICS[metric]} · 期间合计</span></div><span className="dash-chart-key"><i />{data.length ? `${data.length} 天有记录` : '等待访问数据'}</span></div>
    {!data.length ? <div className="dash-chart-empty"><Icon name="clock" size={42} /><strong>每一次访问，都会在这里留下趋势</strong><p>暂未收到这段时间的汇总数据</p><span>今日访问可先查看「今日实时」</span></div> : <>
      <label className="dash-chart-date">查看日期<select aria-label="查看日期" value={active?.date ?? ''} onChange={(event) => setActiveDate(event.target.value)}>{data.map((row) => <option key={row.date} value={row.date}>{row.date}</option>)}</select></label>
      <div className="dash-chart-readout" aria-live="polite"><time>{active?.date}</time><span>UV <b>{num(active?.uv)}</b></span><span>PV <b>{num(active?.pv)}</b></span><span>点击 <b>{num(active?.cta)}</b></span></div>
      <div className="dash-chart-layout">
        <div className="dash-chart-y-axis">{[4, 3, 2, 1, 0].map((i) => <span key={i} title={num((max * i) / 4)}>{axisNumber.format((max * i) / 4)}</span>)}</div>
        <div className="dash-chart-plot" role="group" aria-label={`${METRICS[metric]}按日趋势，${data.length} 天有记录；可点击图面或选择日期查看，完整数据在下方表格`} onClick={selectAt} onMouseMove={selectAt}>
          <svg className="dash-chart" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--brand)" stopOpacity=".24" /><stop offset="100%" stopColor="var(--brand)" stopOpacity="0" /></linearGradient></defs>
            {[0, 1, 2, 3, 4].map((i) => <line key={i} x1="0" x2="100" y1={100 - i * 25} y2={100 - i * 25} className="dash-chart-grid" />)}
            {segments.map((segment) => {
              const path = segment.map((row, index) => `${index ? 'L' : 'M'} ${x(row)} ${y(row)}`).join(' ');
              return <g key={segment[0].date}>{segment.length > 1 && <><path d={`${path} L ${x(segment.at(-1)!)} 100 L ${x(segment[0])} 100 Z`} fill={`url(#${gradient})`} /><path data-trend-line="true" d={path} fill="none" stroke="var(--brand)" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" /></>}</g>;
            })}
            {active && <line x1={x(active)} x2={x(active)} y1="0" y2="100" className="dash-chart-cursor" />}
          </svg>
          {data.map((row) => <span key={row.date} className="dash-chart-point" data-date={row.date} data-active={active?.date === row.date} style={{ left: `${x(row)}%`, top: `${y(row)}%` }} aria-hidden="true" />)}
          <div className="dash-chart-hit" aria-hidden="true" />
        </div>
        <div className="dash-chart-x-axis"><time dateTime={from}>{from.slice(5)}</time><time dateTime={to}>{to.slice(5)}</time></div>
      </div>
      <details className="dash-trend-data"><summary>查看每日明细 <span>缺失日期留空，不插值</span></summary><div className="dash-table-scroll"><table><caption className="dash-sr-only">每日访问数据</caption><thead><tr><th scope="col">日期</th><th scope="col">UV</th><th scope="col">PV</th><th scope="col">点击</th></tr></thead><tbody>{data.map((row) => <tr key={row.date}><th scope="row">{row.date}</th><td>{num(row.uv)}</td><td>{num(row.pv)}</td><td>{num(row.cta)}</td></tr>)}</tbody></table></div></details>
    </>}
    <div className="dash-trend-note">按日汇总；UV 跨日重复计人。下载统计点击次数。</div>
  </Card>;
}

export default function Dashboard() {
  const [range, setRange] = useState(7);
  const [d, setD] = useState<Dash | null>(null);
  const [failed, setFailed] = useState(false);
  const request = useRef(new LatestRequest());

  const load = useCallback((r: number) => {
    const current = request.current.begin();
    setD(null);
    setFailed(false);
    api<Dash>(`/api/dash?range=${r}`)
      .then((data) => { if (request.current.isCurrent(current)) setD(data); })
      .catch(() => { if (request.current.isCurrent(current)) setFailed(true); });
  }, []);
  useEffect(() => {
    load(range);
    return () => { request.current.invalidate(); };
  }, [load, range]);

  return (
    <section className="dashboard">
      <header className="dash-header"><div><span className="dash-eyebrow">OVERVIEW</span><h2>数据看板</h2><p>了解官网表现，把下一步做得更好。</p></div><div className="dash-toolbar"><div className="dash-range" aria-label="统计区间">{RANGES.map((r) => <button key={r} aria-pressed={range === r} onClick={() => setRange(r)}>近 {r} 天</button>)}</div><button className="dash-refresh" aria-label="刷新看板" disabled={!d && !failed} onClick={() => load(range)}><Icon name="refresh" size={18} /></button></div></header>
      <div className="dash-period"><span className="dash-status-dot" />{d ? `${d.from} — ${d.to}` : `近 ${range} 天` }<span>按日汇总 · 今日数据单独展示</span></div>
      <nav className="dash-shortcuts" aria-label="运营快捷入口"><span><b>从这里开始</b><small>让每一次访问都更有价值</small></span><NavLink to="/content"><i>01</i><span>更新官网文案</span><Icon name="arrow-up-right" size={16} /></NavLink><NavLink to="/content/downloads"><i>02</i><span>检查下载入口</span><Icon name="arrow-up-right" size={16} /></NavLink><NavLink to="/publish"><i>03</i><span>预览并发布</span><Icon name="arrow-up-right" size={16} /></NavLink></nav>
      {failed ? <div className="note bad" role="alert">数据获取失败 <button className="btn ghost sm" onClick={() => load(range)}>重试</button></div> : !d ? <div className="dash-loading" role="status" aria-label="正在加载看板">
        {(['dash-kpis', 'dash-main-grid', 'dash-audience-grid', 'dash-content-grid', 'dash-operations-grid'] as const).map((group, row) => <div className={group} key={group}>{Array.from({ length: row === 1 || row === 4 ? 2 : 4 }, (_, index) => <div className={`card dash-card dash-skeleton ${row === 1 && index === 0 ? 'dash-skeleton-chart' : ''}`} key={index}><div className="skl" /><div className="skl" /><div className="skl" /></div>)}</div>)}
      </div> : <DashboardData d={d} retry={() => load(range)} />}
    </section>
  );
}

function DashboardData({ d, retry }: { d: Dash; retry: () => void }) {
  const { traffic, downloads, conversion } = d.overview;
  const empty = !isErr(traffic) && !traffic.hasData;

  return <>
      {empty && <div className="dash-empty-banner"><span className="dash-empty-mark"><Icon name="sparkles" size={24} /></span><div><strong>这段时间还没有访问数据</strong><p>官网访问会从上线日起累积，当天数据在次日汇总。先检查内容和下载入口，准备迎接第一位访客。</p></div><NavLink to="/content/downloads">检查下载入口 <Icon name="arrow-right" size={16} /></NavLink></div>}

      {/* 总览 */}
        <div className="dash-kpis">
          {isErr(traffic) ? <ErrCard title="独立访客 UV" onRetry={retry} /> : (
          <Card title="独立访客 UV" note="按日相加，跨日重复计人" action={<span className="dash-kpi-symbol"><Icon name="users" size={16} /></span>}>
            <div className="dash-kpi-value">{traffic.hasData ? num(traffic.uv) : '—'}
              {traffic.deltaUv !== null && <small className={`dash-delta ${traffic.deltaUv < 0 ? 'negative' : ''}`}><Icon name="arrow-up-right" size={11} />{traffic.deltaUv >= 0 ? '+' : ''}{pct(traffic.deltaUv)}</small>}
            </div>
            <div className="kv">PV {traffic.hasData ? num(traffic.pv) : '—'} · 会话 {traffic.hasData ? num(traffic.sessions) : '—'}</div>
          </Card>
          )}
          {isErr(downloads) ? <ErrCard title="下载点击" onRetry={retry} /> : (
          <Card title="下载点击" note="官网按钮点击次数，不等于安装数" action={<span className="dash-kpi-symbol"><Icon name="download" size={16} /></span>}>
            <div className="dash-kpi-value">{num(downloads.ctaClicks)}
              {downloads.deltaCta !== null && <small className={`dash-delta ${downloads.deltaCta < 0 ? 'negative' : ''}`}><Icon name="arrow-up-right" size={11} />{downloads.deltaCta >= 0 ? '+' : ''}{pct(downloads.deltaCta)}</small>}
            </div>
            <div className="kv">{downloads.byCta.length ? downloads.byCta.map((x) => `${CTA_LABEL[x.cta_id] ?? x.cta_id} ${x.clicks}`).join(' · ') : '—'}</div>
          </Card>
          )}
          {isErr(conversion) ? <ErrCard title="下载转化率" onRetry={retry} /> : (
          <Card title="下载转化率" note="点击访客 ÷ UV，两者按日相加" action={<span className="dash-kpi-symbol"><Icon name="target" size={16} /></span>}>
            <div className="dash-kpi-value">{pct(conversion.starRate)}</div>
            <div className="kv">点击访客 {num(conversion.ctaVisitors)}</div>
          </Card>
          )}
          <Card title="今日实时" note="已排除爬虫，以次日汇总为准" action={<span className="dash-live-label"><i />LIVE</span>}>
            {isErr(d.todayLive) ? (
              <div className="note bad dash-card-error">查询失败 <button className="btn ghost sm" onClick={retry}>重试</button></div>
            ) : (
              <>
                <div className="dash-kpi-value">{num(d.todayLive.uv)}<span className="kv"> UV</span></div>
                <div className="kv">PV {num(d.todayLive.pv)} · 点击 {num(d.todayLive.cta)} · 被屏蔽 {num(d.todayLive.blocked)}</div>
              </>
            )}
          </Card>
        </div>

      <div className="dash-main-grid">
        {isErr(d.trend) ? <ErrCard title="按日趋势" onRetry={retry} /> : <Trend rows={d.trend} from={d.from} to={d.to} />}
        {isErr(d.funnel) ? <ErrCard title="转化漏斗" onRetry={retry} /> : (() => {
          const f = d.funnel;
          return (
            <Card title="转化漏斗" className="dash-funnel" note="滚达：板块进入访客视野；比例以访客数为基准。">
              <p className="dash-card-subtitle">从访问到行动，每一步都看得见</p>
              {([['访客', f.uv], ['滚达下载区', f.download], ['滚达信任板块', f.trust], ['CTA 点击', f.cta]] as Array<[string, number]>).map(([k, v]) => (
                <div className="dash-funnel-step" key={k}>
                  <div><span>{k}</span><b>{num(v)}<small>{f.uv > 0 ? pct(v / f.uv, 0) : '—'}</small></b></div>
                  <Bar v={v} max={f.uv || 1} />
                </div>
              ))}
            </Card>
          );
        })()}
      </div>

      {/* 来源 / 国家 / 设备 */}
        <div className="dash-section-heading"><h3>访客来自哪里</h3><span>看清市场、渠道和设备分布</span></div>
        <div className="dash-audience-grid">
          {([['流量来源', d.dims.sources, (k: string) => ({ direct: '直接访问', search: '搜索引擎', social: '社交媒体', referral: '外链', internal: '站内' }[k] ?? k)],
            ['国家/地区 Top', d.dims.countries, (k: string) => `${k} ${countryName(k)}`],
            ['设备端', d.dims.devices, (k: string) => ({ m: '移动设备', d: '桌面设备' }[k] ?? k)]] as Array<[string, Maybe<Array<{ k: string; uv: number }>>, (k: string) => string]>).map(([title, rows, fmt]) => (
            isErr(rows) ? <ErrCard key={title} title={title} onRetry={retry} /> : <Card key={title} title={title}>
              {rows.length === 0 ? <p className="dash-list-empty">暂无数据</p> : <div className="dash-rank-list">{rows.slice(0, 8).map((r) => <div key={r.k} className="dash-rank-row"><div><span>{fmt(r.k)}</span><b>{num(r.uv)} <small>UV</small></b></div><Bar v={r.uv} max={Math.max(...rows.map((row) => row.uv), 1)} /></div>)}</div>}
            </Card>
          ))}
          {isErr(d.locales) ? <ErrCard title="分语言转化" onRetry={retry} /> : (
            <Card title="分语言转化" note="各语言分别计算转化率">
              {d.locales.length === 0 ? <p className="dash-list-empty">暂无数据</p> : (
                <table><thead><tr><th>语言</th><th>UV 占比</th><th>转化率</th></tr></thead><tbody>{d.locales.map((l) => <tr key={l.locale}><td>{LOCALE_NAME[l.locale] ?? l.locale}</td><td>{pct(l.share, 0)}</td><td><b>{pct(l.rate)}</b></td></tr>)}</tbody></table>
              )}
            </Card>
          )}
        </div>

      {/* 内容四榜:服务端已各自独立成组(复测 R2-P2),前端逐卡判失败——一张表挂了只黑它自己 */}
      <div className="dash-section-heading"><h3>哪些内容更受关注</h3><NavLink to="/content">管理官网内容 <Icon name="arrow-up-right" size={15} /></NavLink></div>
      <div className="dash-content-grid">
        {isErr(d.content.pages) ? <ErrCard title="页面 PV 榜" onRetry={retry} /> : (
          <Card title="页面 PV 榜">
            {d.content.pages.length === 0 ? <p className="dash-list-empty">暂无数据</p> : (
              <table><tbody>{d.content.pages.slice(0, 8).map((p) => (
                  <tr key={p.path + p.locale}><td title={`${p.path} · ${p.locale}`} className="dash-truncate">{p.path}<small className="dash-row-locale">{p.locale}</small></td><td className="mono" style={{ textAlign: 'right' }}><b>{num(p.pv)}</b></td></tr>
              ))}</tbody></table>
            )}
          </Card>
        )}
        {isErr(d.content.sections) ? <ErrCard title="板块曝光" onRetry={retry} /> : (
          <Card title="板块曝光" note="看到该板块的访客数">
            {d.content.sections.length === 0 ? <p className="dash-list-empty">暂无数据</p> : (
              <table><tbody>{d.content.sections.slice(0, 8).map((s) => (
                <tr key={s.section_id}><td>{SEC_LABEL[s.section_id] ?? s.section_id}</td><td className="mono" style={{ textAlign: 'right' }}><b>{num(s.uniq)}</b></td></tr>
              ))}</tbody></table>
            )}
          </Card>
        )}
        {isErr(d.content.faq) ? <ErrCard title="FAQ 展开榜" onRetry={retry} /> : (
          <Card title="FAQ 展开榜" note="客服热点问题的真实排序">
            {d.content.faq.length === 0 ? <p className="dash-list-empty">暂无数据</p> : (
              <table><tbody>{d.content.faq.slice(0, 8).map((f) => (
                <tr key={f.faq_id}><td>{f.faq_id}</td><td className="mono" style={{ textAlign: 'right' }}><b>{num(f.opens)}</b></td></tr>
              ))}</tbody></table>
            )}
          </Card>
        )}
        {isErr(d.content.learn) ? <ErrCard title="学习中心阅读榜" onRetry={retry} /> : (
          <Card title="学习中心阅读榜">
            {d.content.learn.length === 0 ? <p className="dash-list-empty">暂无数据</p> : (
              <table><tbody>{d.content.learn.slice(0, 8).map((l) => (
                <tr key={l.slug}><td title={l.slug} className="dash-truncate">{l.slug}</td><td className="mono" style={{ textAlign: 'right' }}><b>{num(l.reads)}</b></td></tr>
              ))}</tbody></table>
            )}
          </Card>
        )}
      </div>

      {/* 质量 + 运营健康 */}
      <div className="dash-section-heading"><h3>运行状态</h3><span>及时发现影响访问与下载的问题</span></div>
      <div className="dash-operations-grid">
        {isErr(d.quality) ? <ErrCard title="性能与质量" onRetry={retry} /> : (
          <Card title="性能与质量" note={d.quality.latest ? `取最近一天(${d.quality.latest.date})的 75 分位,样本 ${d.quality.latest.n};p75 不能跨天平均` : undefined}>
            <div className="row" style={{ gap: 20 }}>
              <div><div className="mono" style={{ fontSize: 'var(--text-heading)', fontWeight: 600, color: d.quality.latest && d.quality.latest.lcp_p75 > 2500 ? 'var(--bad)' : undefined }}>
                {d.quality.latest ? `${(d.quality.latest.lcp_p75 / 1000).toFixed(2)}s` : '—'}</div><div className="kv">LCP p75(红线 2.5s)</div></div>
              <div><div className="mono" style={{ fontSize: 'var(--text-heading)', fontWeight: 600, color: d.quality.latest && d.quality.latest.cls_p75 > 0.1 ? 'var(--bad)' : undefined }}>
                {d.quality.latest ? d.quality.latest.cls_p75.toFixed(3) : '—'}</div><div className="kv">CLS p75(红线 0.1)</div></div>
              {/* 每个指标只看自己的数据(复测 R2-P3:此前绑在性能样本上,导致「有报错没性能样本」时
                  真实告警被藏成「—」);null=该区间无记录 → num() 显「—」,有记录则显真值(含 0) */}
              <div><div className="mono" style={{ fontSize: 'var(--text-heading)', fontWeight: 600, color: (d.quality.errors ?? 0) > 0 ? 'var(--warn)' : undefined }}>{num(d.quality.errors)}</div><div className="kv">JS 报错</div></div>
              <div><div className="mono" style={{ fontSize: 'var(--text-heading)', fontWeight: 600 }}>{num(d.quality.notFoundTotal)}</div>
                <div className="kv">404 命中<span title="单来源每分钟超 120 次的部分不落库,此时为下限">*</span></div></div>
            </div>
            {d.quality.notFound.length > 0 && (
              <div style={{ marginTop: 8 }}><div className="kv">404 路径 Top</div>
                <table><tbody>{d.quality.notFound.slice(0, 5).map((n) => (
                  <tr key={n.path}><td className="mono" style={{ fontSize: 'var(--text-sm)' }}>{n.path}</td><td className="mono" style={{ textAlign: 'right' }}>{n.hits}</td></tr>
                ))}</tbody></table>
              </div>
            )}
          </Card>
        )}
        {isErr(d.health) ? <ErrCard title="运营健康" onRetry={retry} /> : (
          <Card title="运营健康">
            {/* P1-1 下载链接定时探活(每 6 小时):连续 2 次失败即红条——官网唯一转化路径挂了必须有人知道 */}
            {d.health.probes.filter((p) => p.alert).map((p) => (
              <div className="note bad" key={p.target} style={{ marginTop: 0 }}>
                {CTA_LABEL[p.target] ?? p.target} 下载链接不可达(连续 {p.fail_streak} 次;最近核验 {new Date(p.checked_at).toLocaleString('zh-CN', { hour12: false })})
                {' '}<NavLink to="/content/downloads" style={{ color: 'var(--bad)' }}>去处理 <Icon name="arrow-right" size={14} /></NavLink>
              </div>
            ))}
            <div className="row" style={{ gap: 20 }}>
              <div>
                <div className="mono" style={{ fontSize: 'var(--text-heading)', fontWeight: 600 }}>{pct(d.health.botShare)}</div>
                <div className="kv">
                  爬虫占比
                  {d.health.botLegacy
                    ? '(该区间为口径升级前数据,无法回算)'
                    : d.health.botDays.covered < d.health.botDays.total
                      ? `(按请求加权;仅覆盖 ${d.health.botDays.covered}/${d.health.botDays.total} 天,其余为口径升级前数据)`
                      : '(按请求加权;已排除出流量指标)'}
                </div>
              </div>
              {/* 数字与占比共用同一判据(复测 R3-P1:此前数字看「有拦截或已启用」、占比看「有流量」,
                  于是「站上线了但还没开屏蔽」这段常态画面会显示「— · 占 0.0%」——左边说没数据、
                  右边给精确到小数的 0.0%,自相矛盾。同族即本轮刚修的「0 与『—』混用」)。 */}
              {(() => {
                const meaningful = d.health.blocked > 0 || !!d.health.geo?.enabled;
                return (
                  <div>
                    <div className="mono" style={{ fontSize: 'var(--text-heading)', fontWeight: 600 }}>{meaningful ? num(d.health.blocked) : '—'}</div>
                    <div className="kv">
                      被屏蔽请求{meaningful && d.health.blockedShare !== null ? ` · 占 ${pct(d.health.blockedShare)}` : ''}
                      <span title="单来源每分钟超 120 次的部分不落库,此时为下限">*</span>
                    </div>
                  </div>
                );
              })()}
              <div>
                <div className="mono" style={{ fontSize: 'var(--text-heading)', fontWeight: 600 }}>{d.health.geo ? (d.health.geo.enabled ? `${d.health.geo.countries} 地区` : '未启用') : '—'}</div>
                <div className="kv">屏蔽规则 <NavLink to="/geo" style={{ color: 'var(--brand-ink)' }}>详情 <Icon name="arrow-right" size={14} /></NavLink></div>
              </div>
              <div>
                <div className="mono" style={{ fontSize: 'var(--text-heading)', fontWeight: 600 }}>{d.health.probes.length ? `${d.health.probes.filter((p) => p.ok).length}/${d.health.probes.length}` : '—'}</div>
                <div className="kv">下载链接可达(每 6 小时巡检)</div>
              </div>
            </div>
            {d.health.geo?.degraded && <div className="note bad" style={{ marginBottom: 0 }}>屏蔽规则读取异常,边缘正在用兜底名单 <NavLink to="/geo" style={{ color: 'var(--bad)' }}>去查看 <Icon name="arrow-right" size={14} /></NavLink></div>}
            {d.health.blockedTop.length > 0 && <div className="kv" style={{ marginTop: 6 }}>被拦 Top:{d.health.blockedTop.map((b) => `${b.country} ${b.hits}`).join(' · ')}</div>}
            {d.health.lastPublish && (
              <div className={`note ${d.health.lastPublish.status === 'failed' ? 'bad' : 'info'}`} style={{ marginBottom: 0 }}>
                {/* 枚举值不许直出到页面上(实测印过「最近发布 v8:cancelled」)。缺映射时说「状态未知」而不是原样吐机器词。 */}
                最近发布 v{d.health.lastPublish.id}:
                {{ live: '成功', failed: `失败(${d.health.lastPublish.fail_reason ? failReasonLine(d.health.lastPublish.fail_reason) : '原因见发布页'})`, cancelled: '已取消', validating: '校验中', publishing: '发布中', archived: '已被更新的版本取代' }[
                  d.health.lastPublish.status
                ] ?? '状态未知(见发布页)'}
                {' '}<NavLink to="/publish" style={{ color: 'var(--brand-ink)' }}>发布页 <Icon name="arrow-right" size={14} /></NavLink>
              </div>
            )}
          </Card>
        )}
      </div>

      <p className="kv dash-footnote">
        口径说明:统计匿名、无 cookie、不记录个人信息;下载为「点击」口径(商店安装数据不在本站数据面);
        被屏蔽请求与正常访客分桶互不污染;单来源洪水流量下拦截与 404 计数为下限。
      </p>
    </>;
}
