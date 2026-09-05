/* 驾驶舱(CON03 ⑤⑥):11 组卡 + 4 态。
   诚实口径三原则:①缺数据显「—」不插值 ②比率标注口径(按日相加,非唯一访客)
   ③下载为「点击」口径,商店安装数不在本站数据面,不冒充。 */
import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { api } from '../api';
import { failReasonLine } from '../lib/fail-reason';
import { countryName } from '../lib/iso-countries';

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

function Card({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <h3>{title}</h3>
      {children}
      {note && <div className="kv" style={{ marginTop: 6 }}>{note}</div>}
    </div>
  );
}
const ErrCard = ({ title, onRetry }: { title: string; onRetry: () => void }) => (
  <div className="card"><h3>{title}</h3><div className="note bad" style={{ margin: 0 }}>本卡数据查询失败 <button className="btn ghost sm" onClick={onRetry}>重试</button></div></div>
);
const Bar = ({ v, max }: { v: number; max: number }) => (
  <div className="bar" style={{ height: 8, borderRadius: 4, background: 'var(--surface3)', overflow: 'hidden', margin: '4px 0' }}>
    <i style={{ display: 'block', height: '100%', width: `${max > 0 ? Math.max(2, (v / max) * 100) : 0}%`, background: 'var(--brand)' }} />
  </div>
);

export default function Dashboard() {
  const [range, setRange] = useState(7);
  const [d, setD] = useState<Dash | null>(null);
  const [failed, setFailed] = useState(false);

  const load = (r: number) => {
    setD(null);
    setFailed(false);
    api<Dash>(`/api/dash?range=${r}`).then(setD).catch(() => setFailed(true));
  };
  useEffect(() => load(range), [range]);

  if (failed)
    return <section><h2>驾驶舱</h2><div className="note bad">数据获取失败 <button className="btn ghost sm" onClick={() => load(range)}>重试</button></div></section>;
  if (!d)
    return (
      /* 🔴 骨架屏要贴合真实布局(实景走查 P2-4):此前只画一排 4 张、总高 900,
         而真实是 4 列一排 + 3 列两排共十几张卡、总高 1079 —— 数据落地时版面大幅跳变。
         骨架的作用是「先把版面占住」,占不住就只是个会动的空白。
         列数与行数跟着下方真实结构走(4 / 3 / 3),改真实布局时这里要一起改。 */
      <section><h2>驾驶舱</h2>
        {([4, 3, 3] as const).map((cols, row) => (
          <div key={row} className="grid" style={{ gridTemplateColumns: `repeat(${cols},1fr)`, marginTop: row ? 12 : 0 }}>
            {Array.from({ length: cols }, (_, i) => (
              <div className="card" key={i}>
                <div className="skl" style={{ height: 14, width: '40%' }} />
                <div className="skl" style={{ height: 34, marginTop: 8 }} />
              </div>
            ))}
          </div>
        ))}
      </section>
    );

  const { traffic, downloads, conversion } = d.overview;
  const empty = !isErr(traffic) && !traffic.hasData;

  return (
    <section>
      <h2>
        驾驶舱
        {RANGES.map((r) => (
          <button key={r} className={`pill ${range === r ? 'brand' : ''}`} style={{ cursor: 'pointer', marginLeft: 6, fontSize: 12 }} onClick={() => setRange(r)}>近 {r} 天</button>
        ))}
        <span className="kv" style={{ marginLeft: 10, fontWeight: 400 }}>{d.from} ~ {d.to}</span>
      </h2>

      {empty && (
        <div className="empty" style={{ border: '1px dashed var(--border)', borderRadius: 14, padding: 22, textAlign: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 15, color: 'var(--ink2)', marginBottom: 4 }}>这段时间还没有访问数据</div>
          <div className="kv">埋点已上线,数据从官网上线日起逐日累积;当天数据在次日汇总后进入这里(下方「今日实时」可先看当天)</div>
        </div>
      )}

      {/* 总览 */}
        <div className="grid" style={{ gridTemplateColumns: 'repeat(4,1fr)' }}>
          {isErr(traffic) ? <ErrCard title="独立访客 UV" onRetry={() => load(range)} /> : (
          <Card title="独立访客 UV" note="按日相加口径(跨日重复计人)">
            <div className="mono" style={{ fontSize: 26, fontWeight: 600 }}>{num(traffic.uv)}
              {traffic.deltaUv !== null && <small style={{ fontSize: 12, marginLeft: 6, color: traffic.deltaUv >= 0 ? 'var(--ok)' : 'var(--bad)' }}>{traffic.deltaUv >= 0 ? '+' : ''}{pct(traffic.deltaUv)}</small>}
            </div>
            <div className="kv">PV {num(traffic.pv)} · 会话 {num(traffic.sessions)}</div>
          </Card>
          )}
          {isErr(downloads) ? <ErrCard title="下载点击" onRetry={() => load(range)} /> : (
          <Card title="下载点击" note="「点击」口径:商店安装数不在本站数据面,不冒充">
            <div className="mono" style={{ fontSize: 26, fontWeight: 600 }}>{num(downloads.ctaClicks)}
              {downloads.deltaCta !== null && <small style={{ fontSize: 12, marginLeft: 6, color: downloads.deltaCta >= 0 ? 'var(--ok)' : 'var(--bad)' }}>{downloads.deltaCta >= 0 ? '+' : ''}{pct(downloads.deltaCta)}</small>}
            </div>
            <div className="kv">{downloads.byCta.length ? downloads.byCta.map((x) => `${CTA_LABEL[x.cta_id] ?? x.cta_id} ${x.clicks}`).join(' · ') : '—'}</div>
          </Card>
          )}
          {isErr(conversion) ? <ErrCard title="北极星转化率" onRetry={() => load(range)} /> : (
          <Card title="北极星转化率" note="点击访客 ÷ UV(官网 PRD §1.3);两者同为按日相加口径">
            <div className="mono" style={{ fontSize: 26, fontWeight: 600 }}>{pct(conversion.starRate)}</div>
            <div className="kv">点击访客 {num(conversion.ctaVisitors)}</div>
          </Card>
          )}
          <Card title="今日实时" note="当日预览,口径以次日汇总为准;已排除爬虫">
            {isErr(d.todayLive) ? (
              <div className="note bad" style={{ margin: 0 }}>查询失败 <button className="btn ghost sm" onClick={() => load(range)}>重试</button></div>
            ) : (
              <>
                <div className="mono" style={{ fontSize: 26, fontWeight: 600 }}>{num(d.todayLive.uv)}<span className="kv" style={{ fontSize: 12 }}> UV</span></div>
                <div className="kv">PV {num(d.todayLive.pv)} · 点击 {num(d.todayLive.cta)} · 被屏蔽 {num(d.todayLive.blocked)}</div>
              </>
            )}
          </Card>
        </div>

      {/* 漏斗 / 分语言 / 趋势 */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(3,1fr)', marginTop: 12 }}>
        {isErr(d.funnel) ? <ErrCard title="转化漏斗" onRetry={() => load(range)} /> : (() => {
          const f = d.funnel;
          return (
            <Card title="转化漏斗" note="滚达=板块进入视野的访客占比">
              {([['访客', f.uv], ['滚达下载区', f.download], ['滚达信任板块', f.trust], ['CTA 点击', f.cta]] as Array<[string, number]>).map(([k, v]) => (
                <div key={k}>
                  <div className="kv">{k} {num(v)}{f.uv > 0 && k !== '访客' ? ` · ${pct(v / f.uv)}` : ''}</div>
                  <Bar v={v} max={f.uv || 1} />
                </div>
              ))}
            </Card>
          );
        })()}
        {isErr(d.locales) ? <ErrCard title="分语言转化" onRetry={() => load(range)} /> : (
          <Card title="分语言转化" note="越南市场运营关键:各语言各自的转化率">
            {d.locales.length === 0 ? <p className="kv">暂无数据</p> : (
              <table><thead><tr><th>语言</th><th>UV 占比</th><th>转化率</th></tr></thead><tbody>
                {d.locales.map((l) => (
                  <tr key={l.locale}><td>{l.locale}</td><td>{pct(l.share, 0)}</td><td><b>{pct(l.rate)}</b></td></tr>
                ))}
              </tbody></table>
            )}
          </Card>
        )}
        {isErr(d.trend) ? <ErrCard title="按日趋势" onRetry={() => load(range)} /> : (() => {
          const rows = d.trend;
          const max = Math.max(...rows.map((x) => x.uv), 1);
          return (
            <Card title="按日趋势(UV)" note={rows.length > 10 ? `共 ${rows.length} 天有数据,下列为最近 10 天;条长按全期最大值 ${max} 归一` : `${rows.length} 天有数据`}>
              {rows.length === 0 ? <p className="kv">暂无数据</p> : rows.slice(-10).map((t) => (
                <div key={t.date}><div className="kv">{t.date.slice(5)} · UV {t.uv} · 点击 {t.cta}</div><Bar v={t.uv} max={max} /></div>
              ))}
            </Card>
          );
        })()}
      </div>

      {/* 来源 / 国家 / 设备 */}
        <div className="grid" style={{ gridTemplateColumns: 'repeat(3,1fr)', marginTop: 12 }}>
          {([['流量来源', d.dims.sources, (k: string) => ({ direct: '直接访问', search: '搜索引擎', social: '社交媒体', referral: '外链', internal: '站内' }[k] ?? k)],
            ['国家/地区 Top', d.dims.countries, (k: string) => `${k} ${countryName(k)}`],
            ['设备端', d.dims.devices, (k: string) => (k === 'm' ? '移动' : '桌面')]] as Array<[string, Maybe<Array<{ k: string; uv: number }>>, (k: string) => string]>).map(([title, rows, fmt]) => (
            isErr(rows) ? <ErrCard key={title} title={title} onRetry={() => load(range)} /> : <Card key={title} title={title}>
              {rows.length === 0 ? <p className="kv">暂无数据</p> : (
                <table><tbody>{rows.slice(0, 8).map((r) => (
                  <tr key={r.k}><td>{fmt(r.k)}</td><td className="mono" style={{ textAlign: 'right' }}><b>{num(r.uv)}</b></td></tr>
                ))}</tbody></table>
              )}
            </Card>
          ))}
        </div>

      {/* 内容四榜:服务端已各自独立成组(复测 R2-P2),前端逐卡判失败——一张表挂了只黑它自己 */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(4,1fr)', marginTop: 12 }}>
        {isErr(d.content.pages) ? <ErrCard title="页面 PV 榜" onRetry={() => load(range)} /> : (
          <Card title="页面 PV 榜">
            {d.content.pages.length === 0 ? <p className="kv">暂无数据</p> : (
              <table><tbody>{d.content.pages.slice(0, 8).map((p) => (
                <tr key={p.path + p.locale}><td style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.path}</td><td className="mono" style={{ textAlign: 'right' }}><b>{num(p.pv)}</b></td></tr>
              ))}</tbody></table>
            )}
          </Card>
        )}
        {isErr(d.content.sections) ? <ErrCard title="板块曝光" onRetry={() => load(range)} /> : (
          <Card title="板块曝光(访客数)" note="哪些板块真的被看到">
            {d.content.sections.length === 0 ? <p className="kv">暂无数据</p> : (
              <table><tbody>{d.content.sections.slice(0, 8).map((s) => (
                <tr key={s.section_id}><td>{SEC_LABEL[s.section_id] ?? s.section_id}</td><td className="mono" style={{ textAlign: 'right' }}><b>{num(s.uniq)}</b></td></tr>
              ))}</tbody></table>
            )}
          </Card>
        )}
        {isErr(d.content.faq) ? <ErrCard title="FAQ 展开榜" onRetry={() => load(range)} /> : (
          <Card title="FAQ 展开榜" note="客服热点问题的真实排序">
            {d.content.faq.length === 0 ? <p className="kv">暂无数据</p> : (
              <table><tbody>{d.content.faq.slice(0, 8).map((f) => (
                <tr key={f.faq_id}><td>{f.faq_id}</td><td className="mono" style={{ textAlign: 'right' }}><b>{num(f.opens)}</b></td></tr>
              ))}</tbody></table>
            )}
          </Card>
        )}
        {isErr(d.content.learn) ? <ErrCard title="学习中心阅读榜" onRetry={() => load(range)} /> : (
          <Card title="学习中心阅读榜">
            {d.content.learn.length === 0 ? <p className="kv">暂无数据</p> : (
              <table><tbody>{d.content.learn.slice(0, 8).map((l) => (
                <tr key={l.slug}><td style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.slug}</td><td className="mono" style={{ textAlign: 'right' }}><b>{num(l.reads)}</b></td></tr>
              ))}</tbody></table>
            )}
          </Card>
        )}
      </div>

      {/* 质量 + 运营健康 */}
      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', marginTop: 12 }}>
        {isErr(d.quality) ? <ErrCard title="性能与质量" onRetry={() => load(range)} /> : (
          <Card title="性能与质量" note={d.quality.latest ? `取最近一天(${d.quality.latest.date})的 75 分位,样本 ${d.quality.latest.n};p75 不能跨天平均` : undefined}>
            <div className="row" style={{ gap: 20 }}>
              <div><div className="mono" style={{ fontSize: 18, fontWeight: 600, color: d.quality.latest && d.quality.latest.lcp_p75 > 2500 ? 'var(--bad)' : undefined }}>
                {d.quality.latest ? `${(d.quality.latest.lcp_p75 / 1000).toFixed(2)}s` : '—'}</div><div className="kv">LCP p75(红线 2.5s)</div></div>
              <div><div className="mono" style={{ fontSize: 18, fontWeight: 600, color: d.quality.latest && d.quality.latest.cls_p75 > 0.1 ? 'var(--bad)' : undefined }}>
                {d.quality.latest ? d.quality.latest.cls_p75.toFixed(3) : '—'}</div><div className="kv">CLS p75(红线 0.1)</div></div>
              {/* 每个指标只看自己的数据(复测 R2-P3:此前绑在性能样本上,导致「有报错没性能样本」时
                  真实告警被藏成「—」);null=该区间无记录 → num() 显「—」,有记录则显真值(含 0) */}
              <div><div className="mono" style={{ fontSize: 18, fontWeight: 600, color: (d.quality.errors ?? 0) > 0 ? 'var(--warn)' : undefined }}>{num(d.quality.errors)}</div><div className="kv">JS 报错</div></div>
              <div><div className="mono" style={{ fontSize: 18, fontWeight: 600 }}>{num(d.quality.notFoundTotal)}</div>
                <div className="kv">404 命中<span title="单来源每分钟超 120 次的部分不落库,此时为下限">*</span></div></div>
            </div>
            {d.quality.notFound.length > 0 && (
              <div style={{ marginTop: 8 }}><div className="kv">404 路径 Top</div>
                <table><tbody>{d.quality.notFound.slice(0, 5).map((n) => (
                  <tr key={n.path}><td className="mono" style={{ fontSize: 11.5 }}>{n.path}</td><td className="mono" style={{ textAlign: 'right' }}>{n.hits}</td></tr>
                ))}</tbody></table>
              </div>
            )}
          </Card>
        )}
        {isErr(d.health) ? <ErrCard title="运营健康" onRetry={() => load(range)} /> : (
          <Card title="运营健康">
            {/* P1-1 下载链接定时探活(每 6 小时):连续 2 次失败即红条——官网唯一转化路径挂了必须有人知道 */}
            {d.health.probes.filter((p) => p.alert).map((p) => (
              <div className="note bad" key={p.target} style={{ marginTop: 0 }}>
                {CTA_LABEL[p.target] ?? p.target} 下载链接不可达(连续 {p.fail_streak} 次;最近核验 {new Date(p.checked_at).toLocaleString('zh-CN', { hour12: false })})
                {' '}<NavLink to="/content/downloads" style={{ color: 'var(--bad)' }}>去处理 →</NavLink>
              </div>
            ))}
            <div className="row" style={{ gap: 20 }}>
              <div>
                <div className="mono" style={{ fontSize: 18, fontWeight: 600 }}>{pct(d.health.botShare)}</div>
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
                    <div className="mono" style={{ fontSize: 18, fontWeight: 600 }}>{meaningful ? num(d.health.blocked) : '—'}</div>
                    <div className="kv">
                      被屏蔽请求{meaningful && d.health.blockedShare !== null ? ` · 占 ${pct(d.health.blockedShare)}` : ''}
                      <span title="单来源每分钟超 120 次的部分不落库,此时为下限">*</span>
                    </div>
                  </div>
                );
              })()}
              <div>
                <div className="mono" style={{ fontSize: 18, fontWeight: 600 }}>{d.health.geo ? (d.health.geo.enabled ? `${d.health.geo.countries} 地区` : '未启用') : '—'}</div>
                <div className="kv">屏蔽规则 <NavLink to="/geo" style={{ color: 'var(--brand)' }}>详情 →</NavLink></div>
              </div>
              <div>
                <div className="mono" style={{ fontSize: 18, fontWeight: 600 }}>{d.health.probes.length ? `${d.health.probes.filter((p) => p.ok).length}/${d.health.probes.length}` : '—'}</div>
                <div className="kv">下载链接可达(每 6 小时巡检)</div>
              </div>
            </div>
            {d.health.geo?.degraded && <div className="note bad" style={{ marginBottom: 0 }}>屏蔽规则读取异常,边缘正在用兜底名单 <NavLink to="/geo" style={{ color: 'var(--bad)' }}>去查看 →</NavLink></div>}
            {d.health.blockedTop.length > 0 && <div className="kv" style={{ marginTop: 6 }}>被拦 Top:{d.health.blockedTop.map((b) => `${b.country} ${b.hits}`).join(' · ')}</div>}
            {d.health.lastPublish && (
              <div className={`note ${d.health.lastPublish.status === 'failed' ? 'bad' : 'info'}`} style={{ marginBottom: 0 }}>
                {/* 枚举值不许直出到页面上(实测印过「最近发布 v8:cancelled」)。缺映射时说「状态未知」而不是原样吐机器词。 */}
                最近发布 v{d.health.lastPublish.id}:
                {{ live: '成功', failed: `失败(${d.health.lastPublish.fail_reason ? failReasonLine(d.health.lastPublish.fail_reason) : '原因见发布页'})`, cancelled: '已取消', validating: '校验中', publishing: '发布中', archived: '已被更新的版本取代' }[
                  d.health.lastPublish.status
                ] ?? '状态未知(见发布页)'}
                {' '}<NavLink to="/publish" style={{ color: 'var(--brand)' }}>发布页 →</NavLink>
              </div>
            )}
          </Card>
        )}
      </div>

      <p className="kv" style={{ marginTop: 10 }}>
        口径说明:统计匿名、无 cookie、不记录个人信息;下载为「点击」口径(商店安装数据不在本站数据面);
        被屏蔽请求与正常访客分桶互不污染;单来源洪水流量下拦截与 404 计数为下限。
      </p>
    </section>
  );
}
