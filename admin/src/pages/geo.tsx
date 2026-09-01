/* 区域屏蔽(CON12 ⑤⑥):规则区(开关/国家多选/拦截页文案/直通/生效状态)+ 统计区。
   即时生效通道:应用=确认(理由 ≥8 字)→ 写 KV → 回读确认;失败态不装成功。 */
import { useEffect, useState } from 'react';
import { ApiError, api, toast } from '../api';
import { AutoTextarea } from '../lib/auto-textarea';
import { ISO_COUNTRIES, countryName } from '../lib/iso-countries';

interface Rules {
  enabled: boolean;
  countries: string[];
  blockPage: { title: { zh: string; en: string }; body: { zh: string; en: string } };
  updatedAt?: number;
}
interface GeoState {
  rules: Rules;
  degraded: boolean;
  bypassAvailable: boolean;
  stats: { last7: Array<{ country: string; hits: number }>; todayLive: number; blocked7: number; shareOfRequests: number };
}

/* 写入失败的原因 → 人话。服务端的错误码不该出现在运营的屏幕上;
   缺映射时显示一句通用说明,而不是吐原始码(gate-console-copy 判据②同源)。 */
const WRITE_FAIL_REASON: Record<string, string> = {
  'kv-readback-mismatch(线上仍为旧规则)': '写进去之后回读对不上,规则没有真正生效',
  'bad-request': '这份规则本身不合法(国家代码或拦截页文案有问题)',
  network: '网络异常,请求没送到服务端',
};

export default function GeoPage() {
  const [st, setSt] = useState<GeoState | null>(null);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState<Rules | null>(null); // 待应用改动(未写 KV)
  const [applying, setApplying] = useState(false);
  const [writeFail, setWriteFail] = useState<{ why: string; code: string } | null>(null);
  const [confirmBox, setConfirmBox] = useState<{ reason: string; hot: Array<{ country: string; share: number }> | null; ack: boolean } | null>(null);
  const [addSel, setAddSel] = useState('');

  const load = () => {
    setFailed(false);
    api<GeoState>('/api/geo').then((s) => { setSt(s); setDraft(null); }).catch(() => setFailed(true));
  };
  useEffect(load, []);

  if (failed) return <section><h2>区域屏蔽</h2><div className="note bad">状态获取失败 <button className="btn ghost sm" onClick={load}>重试</button></div></section>;
  if (!st) return <section><h2>区域屏蔽</h2><div className="skl" style={{ height: 80 }} /></section>;

  const r = draft ?? st.rules;
  const dirty = draft !== null;
  const set = (patch: Partial<Rules>) => setDraft({ ...structuredClone(r), ...patch });

  async function apply(confirmHighTraffic: boolean) {
    if (!confirmBox) return;
    if (confirmBox.reason.trim().length < 8) return toast('理由至少 8 字');
    setApplying(true);
    try {
      await api('/api/geo', {
        method: 'PUT',
        body: JSON.stringify({ enabled: r.enabled, countries: r.countries, blockPage: r.blockPage, reason: confirmBox.reason, confirmHighTraffic }),
      });
      toast('已写入并回读确认 · 约 1 分钟内全球生效');
      setWriteFail(null); // 成功了就把上一次的失败条收掉,否则它会一直挂在那儿说假话
      setConfirmBox(null);
      load();
    } catch (ex) {
      if (ex instanceof ApiError && ex.status === 409) {
        const hot = (ex.body as { hot?: Array<{ country: string; share: number }> }).hot ?? [];
        setConfirmBox({ ...confirmBox, hot, ack: false }); // E2 二次确认
      } else {
        /* 🔴 写入失败必须**留在屏幕上 + 给重试**(CON12-⑤ 逐字要求「+重试」;第十轮独立验收 P1)。
           上一版只有一条 2.6 秒就消失的浮层,而且把服务端的错误码原样印给运营。
           这是合规开关:「以为已经生效、其实没有」的代价是屏蔽规则形同虚设,
           而人一转头那句提示就没了,连自己看到过什么都记不住。 */
        setWriteFail({
          why: ex instanceof ApiError ? WRITE_FAIL_REASON[String(ex.body.error)] ?? '服务端拒绝了这次写入' : '网络异常,请求没送到',
          code: ex instanceof ApiError ? String(ex.body.error ?? '') : 'network',
        });
      }
    } finally {
      setApplying(false);
    }
  }

  async function getBypass() {
    try {
      const { url } = await api<{ url: string }>('/api/geo/bypass-token', { method: 'POST' });
      window.open(url, '_blank', 'noopener');
      toast('已在新标签兑换 30 天直通并打开官网(从任何地区可预览;直通访问不计统计)');
    } catch {
      toast('直通签发失败,请重试');
    }
  }

  return (
    <section>
      <h2>区域屏蔽 <span className="pill warn">高敏 · 变更须理由</span></h2>
      {st.degraded && <div className="note bad">⚠ 规则存储读取异常——边缘正在使用内置兜底名单(仅 CN)。请稍后重试或检查部署。</div>}
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="row">
          <b>总开关</b>
          <input type="checkbox" style={{ width: 18, height: 18 }} checked={r.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          {dirty ? <span className="pill warn">改动未应用</span> : <span className="pill ok">已生效{st.rules.updatedAt ? ` · ${new Date(st.rules.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })} 回读确认` : ''}</span>}
          <span className="spacer" />
          <button className="btn" disabled={!st.bypassAvailable} title={st.bypassAvailable ? '' : '直通密钥未配置或仍为默认值'} onClick={() => void getBypass()}>
            获取直通(从任何地区预览官网)
          </button>
        </div>
        <p className="kv" style={{ marginTop: 6 }}>控制台永不受屏蔽;规则改动走即时通道(约 1 分钟全球生效),不经内容发布链。</p>
        {!st.bypassAvailable && (
          <div className="note warn" style={{ marginBottom: 0 }}>
            直通功能当前停用:部署密钥(BYPASS_SECRET)未配置、或仍是仓库内的开发默认值。上线前必须轮换成真密钥,否则任何人都能自行伪造直通凭证绕过屏蔽。
          </div>
        )}
      </div>
      <div className="card" style={{ marginBottom: 12 }}>
        <h3>屏蔽名单(ISO 国家/地区码 · 选择不手输)</h3>
        <div className="chipset">
          {r.countries.map((c) => (
            <span className="cchip" key={c} style={{ background: 'var(--surface2)', borderRadius: 99, padding: '7px 12px', display: 'inline-flex', gap: 8, alignItems: 'center' }}>
              {c} {countryName(c)}
              <button style={{ color: 'var(--ink4)', minWidth: 22 }} title="移除(须应用变更生效)" onClick={() => set({ countries: r.countries.filter((x) => x !== c) })}>✕</button>
            </span>
          ))}
          <select value={addSel} style={{ width: 220 }} onChange={(e) => { const v = e.target.value; if (v && !r.countries.includes(v)) set({ countries: [...r.countries, v] }); setAddSel(''); }}>
            <option value="">+ 添加国家/地区…</option>
            {ISO_COUNTRIES.filter((c) => !r.countries.includes(c.code)).map((c) => (
              <option key={c.code} value={c.code}>{c.code} {c.name}</option>
            ))}
          </select>
        </div>
        <p className="kv" style={{ marginTop: 8 }}>⚠ CN 仅指中国大陆;HK/MO/TW 为独立代码,不会被连带,要连带须显式添加。名单为空+开启 = 不拦任何人。</p>
      </div>
      <div className="card" style={{ marginBottom: 12 }}>
        <h3>拦截页文案(zh + en,内联渲染不引站内资源;HTTP 451)</h3>
        <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          {(['zh', 'en'] as const).map((l) => (
            <div key={l}>
              <div className="field" style={{ margin: 0 }}><label>{l} 标题</label>
                <input value={r.blockPage.title[l]} onChange={(e) => set({ blockPage: { ...r.blockPage, title: { ...r.blockPage.title, [l]: e.target.value } } })} /></div>
              <div className="field"><label>{l} 正文(≤300)</label>
                <AutoTextarea value={r.blockPage.body[l]} onChange={(e) => set({ blockPage: { ...r.blockPage, body: { ...r.blockPage.body, [l]: e.target.value } } })} /></div>
            </div>
          ))}
        </div>
      </div>
      <div className="row" style={{ marginBottom: 16 }}>
        {/* 🔴 降级态下必须禁止应用:此时页面上显示的是**内置兜底名单**(仅 CN),不是真规则。
            KV 短暂故障后恢复,运营在这个页面上改一处再应用,写回去的是「基线 + 这一处改动」,
            真名单被静默覆盖且没有任何报错。先刷新拿到真规则,再改。 */}
        <button className="btn primary" disabled={!dirty || applying || st.degraded} title={st.degraded ? '规则存储读取异常,页面显示的是兜底名单;请先重试加载再改' : ''} onClick={() => setConfirmBox({ reason: '', hot: null, ack: false })}>应用变更(确认+理由)</button>
        {dirty && <button className="btn ghost" onClick={() => setDraft(null)}>放弃改动</button>}
      </div>

      {/* 写入失败:常驻红条 + 重试(CON12-⑤)。改动仍在草稿里,重试就是再发一次同一份规则。 */}
      {writeFail && (
        <div className="note bad" style={{ marginBottom: 16 }}>
          <b>规则没有生效,线上仍是旧规则。</b>
          <div className="kv" style={{ marginTop: 4 }}>{writeFail.why}。你的改动还在这一页上,没有丢。</div>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn sm" disabled={applying} onClick={() => { setWriteFail(null); void apply(false); }}>{applying ? '重试中…' : '重试写入'}</button>
            <button className="btn ghost sm" onClick={() => { setWriteFail(null); load(); }}>放弃并重新读取线上规则</button>
            <span className="spacer" />
            <span className="kv mono" title="排查用的原始错误码">{writeFail.code}</span>
          </div>
        </div>
      )}

      {confirmBox && (
        <div className="card" style={{ marginBottom: 16, outline: '2px solid var(--warn)' }}>
          <h3>确认应用屏蔽规则变更?</h3>
          <p className="kv">变更后约 1 分钟全球生效;本操作进入审计。目标:{r.enabled ? `开启,名单 [${r.countries.join(', ') || '空'}]` : '停用(所有地区可访问)'}</p>
          {confirmBox.hot && (
            <div className="note bad">
              ⚠ 误伤护栏:{confirmBox.hot.map((h) => `${h.country} ${countryName(h.country)} 占近 7 天流量 ${(h.share * 100).toFixed(1)}%`).join(';')}——这是主要市场流量。
              <label className="row" style={{ marginTop: 8, gap: 8 }}>
                <input type="checkbox" style={{ width: 16, height: 16 }} checked={confirmBox.ack} onChange={(ev) => setConfirmBox({ ...confirmBox, ack: ev.target.checked })} />
                我知道这会拦截主要市场流量
              </label>
            </div>
          )}
          <div className="field"><label>理由(必填,≥8 字)</label>
            <textarea value={confirmBox.reason} onChange={(ev) => setConfirmBox({ ...confirmBox, reason: ev.target.value })} placeholder="例:合规要求,上线前开启大陆屏蔽" /></div>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn ghost" onClick={() => setConfirmBox(null)}>取消</button>
            <button className="btn primary" disabled={applying || (!!confirmBox.hot && !confirmBox.ack)} onClick={() => void apply(!!confirmBox.hot && confirmBox.ack)}>
              {applying ? '写入中…' : confirmBox.hot ? '仍然应用' : '确认应用'}
            </button>
          </div>
        </div>
      )}

      <div className="grid" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
        <div className="card"><h3>今日拦截(实时)</h3><div className="mono" style={{ fontSize: 26, fontWeight: 600 }}>{st.stats.todayLive}</div><div className="kv">仅页面级请求;直通与资产不计。同一来源每分钟超 120 次的洪水流量会被采样记录,此时该数字是<b>下限</b></div></div>
        <div className="card"><h3>近 7 天拦截</h3><div className="mono" style={{ fontSize: 26, fontWeight: 600 }}>{st.stats.blocked7}</div><div className="kv">占总请求 {(st.stats.shareOfRequests * 100).toFixed(1)}%(口径:拦截数 ÷ 拦截+人类访问)</div></div>
        <div className="card">
          <h3>被拦区域 TopN(近 7 天)</h3>
          {st.stats.last7.length === 0 ? (
            <p className="kv">{st.rules.enabled ? '暂无拦截记录' : '屏蔽未启用,暂无数据'}</p>
          ) : (
            <table>{st.stats.last7.map((x) => (
              <tbody key={x.country}><tr><td>{x.country} {countryName(x.country)}</td><td className="mono" style={{ textAlign: 'right' }}><b>{x.hits}</b></td></tr></tbody>
            ))}</table>
          )}
        </div>
      </div>
    </section>
  );
}
