/* 控制台壳(CON02):导航五组 + 状态条三 chip + 失败红条 + 重试;当前位置高亮。 */
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { api, toast, type Overview } from './api';

interface ShellState {
  overview: Overview | null;
  failed: boolean;
  reload: () => void;
}
const ShellCtx = createContext<ShellState>({ overview: null, failed: false, reload: () => {} });
export const useShell = () => useContext(ShellCtx);

const NAV: Array<{ group: string; items: Array<{ to: string; label: string; icon: string }> }> = [
  { group: '', items: [{ to: '/', label: '驾驶舱', icon: '📊' }] },
  {
    group: '内容',
    items: [
      { to: '/content', label: '文案树', icon: '✏️' },
      { to: '/content/downloads', label: '下载入口', icon: '⬇️' },
      { to: '/content/stats', label: '平台数字', icon: '🔢' },
      { to: '/content/skus', label: '产品卡', icon: '🧱' },
      { to: '/content/faq', label: 'FAQ', icon: '❓' },
      { to: '/content/announcement', label: '公告条', icon: '📣' },
      { to: '/content/seo', label: 'SEO 与页脚', icon: '🧭' },
      { to: '/content/legal', label: 'Legal', icon: '📜' },
    ],
  },
  { group: '控制', items: [{ to: '/geo', label: '区域屏蔽', icon: '🌐' }] },
  {
    group: '发布',
    items: [
      { to: '/publish', label: '发布与版本', icon: '🚀' },
      { to: '/audit', label: '审计日志', icon: '🧾' },
    ],
  },
];

export default function Shell() {
  const nav = useNavigate();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [failed, setFailed] = useState(false);

  const reload = useCallback(() => {
    setFailed(false);
    api<Overview>('/api/config')
      .then(setOverview)
      .catch(() => setFailed(true));
  }, []);
  useEffect(() => {
    void api('/api/me').catch(() => {}); // 会话探针:401 由 api 层统一踢回登录
    reload();
  }, [reload]);

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    toast('已退出');
    nav('/login');
  }

  return (
    <ShellCtx.Provider value={{ overview, failed, reload }}>
      <div className="shell">
        <aside>
          <div className="brandrow">
            <span className="dot" />
            <div className="lbl">
              <b style={{ fontSize: 14 }}>官网后台</b>
              <div className="tag">SITE CONSOLE</div>
            </div>
          </div>
          {NAV.map((g) => (
            <div key={g.group || 'root'}>
              {g.group && <div className="navg"><span className="tag">{g.group}</span></div>}
              {g.items.map((it) => (
                <NavLink key={it.to} to={it.to} end={it.to === '/' || it.to === '/content'} className={({ isActive }) => `nav ${isActive ? 'on' : ''}`}>
                  <span aria-hidden>{it.icon}</span>
                  <span className="lbl">{it.label}</span>
                  {it.to === '/publish' && (overview?.dirty ?? 0) > 0 && <span className="pill warn">{overview!.dirty}</span>}
                </NavLink>
              ))}
            </div>
          ))}
          <div style={{ flex: 1 }} />
          <button className="nav" onClick={logout}>↩︎ <span className="lbl">退出</span></button>
        </aside>
        <main className="content">
          {/* CON02-E2:上次发布失败的红条,常驻壳顶直到有一次成功发布把它顶掉 */}
          {overview?.lastPublishFailed && (
            <div className="note bad" style={{ margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: 10 }}>
              <span>上次发布失败(v{overview.lastPublishFailed.id}):{overview.lastPublishFailed.reason}　线上仍是 v{overview.liveVersion},未受影响。</span>
              <NavLink to="/publish" className="btn ghost sm">去看详情</NavLink>
            </div>
          )}
          <div className="statusbar">
            {overview ? (
              <>
                <span className="chip">线上 <b>v{overview.liveVersion}</b></span>
                <span className={`chip ${overview.dirty ? 'warnc' : ''}`}>{overview.dirty ? `草稿 · ${overview.dirty} 处未发布改动` : '与线上一致'}</span>
                <NavLink to="/geo" className={`chip ${overview.geo?.degraded ? 'warnc' : ''}`} title="区域屏蔽(只读状态;点击进入规则面板)">
                  屏蔽 <b>{overview.geo ? (overview.geo.enabled ? `开启 · ${overview.geo.countries} 个地区` : '未启用') : '状态未知'}</b>
                  {overview.geo?.degraded && ' ⚠ 兜底中'}
                </NavLink>
              </>
            ) : failed ? (
              <span className="note bad" style={{ margin: 0 }}>状态获取失败 <button className="btn ghost sm" onClick={reload}>重试</button></span>
            ) : (
              <span className="skl" style={{ width: 260 }} />
            )}
            <span className="spacer" />
            <NavLink to="/publish" className="btn sm">去发布</NavLink>
          </div>
          <Outlet />
        </main>
      </div>
    </ShellCtx.Provider>
  );
}
