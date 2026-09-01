/* 控制台壳(CON02):导航五组 + 状态条三 chip + 失败红条 + 重试;当前位置高亮。 */
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
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
  const isOnPublish = useLocation().pathname === '/publish';
  const [overview, setOverview] = useState<Overview | null>(null);
  const [failed, setFailed] = useState(false);

  const reload = useCallback(() => {
    setFailed(false);
    api<Overview>('/api/config')
      .then(setOverview)
      .catch(() => setFailed(true));
  }, []);
  /* 🔴 先确认会话,再渲染子页(实景走查 P2-9)。
     此前壳与子页同时挂载并各自发请求,未登录时会连着打出好几个 401 ——
     其中 `/api/dash` 那条是纯浪费的越权请求(用户还没登录,驾驶舱就去拉数据了)。
     现在等会话探针有结果再放子页;401 由 api 层统一用**路由跳转**踢回登录。 */
  const [authed, setAuthed] = useState(false);
  useEffect(() => {
    api('/api/me')
      .then(() => { setAuthed(true); reload(); })
      .catch(() => {}); // 401 已由 api 层跳转;其它错误由下面的失败态兜
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
              {/* 🔴 窄窗下 .lbl 被 CSS 隐藏、只剩一个 aria-hidden 的 emoji,于是每个导航链接的
                  可访问名为空——读屏器什么都读不到,肉眼要靠猜图标(实景走查 P2-5)。
                  aria-label 给读屏器,title 给鼠标悬停;图标仍 aria-hidden(它不是信息)。 */}
              {g.items.map((it) => (
                <NavLink key={it.to} to={it.to} end={it.to === '/' || it.to === '/content'} aria-label={it.label} title={it.label} className={({ isActive }) => `nav ${isActive ? 'on' : ''}`}>
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
          {/* 线上内容与系统记录对不上:此前只在发布页显示,别的页面仍写「与线上一致」(第四轮 P1-6) */}
          {overview?.drift && (
            <div className="note bad" style={{ margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: 10 }}>
              {/* 两种形态说法不同:版本号不符 vs 版本号对得上但内容被改过。
                  此前只写前一种,于是被改动的情形会渲染出「记录里线上是 v11,快照来自 v11」这种自相矛盾的话(第六轮 P1-4)。 */}
              <span>
                {overview.drift.tampered?.length
                  ? `线上文件被绕过发布流程改动过(v${overview.liveVersion}):${overview.drift.tampered.join('、')} 与发布时不一致`
                  : `线上内容与系统记录对不上:记录里线上是 v${overview.liveVersion},线上实际伺服的快照${
                      overview.drift.snapshot ? `来自 v${overview.drift.snapshot}` : '没有上线标记'
                    }`}
              </span>
              <NavLink to="/publish" className="btn ghost sm">去处理</NavLink>
            </div>
          )}
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
                {/* 🔴 「与线上一致」说的是**草稿 vs 线上版本**,可劈叉时它会和上方红条同屏矛盾
                    (红条:线上内容与系统记录对不上)。劈叉时把话说准:草稿没改动,但线上内容另有问题。 */}
                <span className={`chip ${overview.dirty ? 'warnc' : overview.drift ? 'warnc' : ''}`}>
                  {overview.dirty ? `草稿 · ${overview.dirty} 处未发布改动` : overview.drift ? '草稿无改动(线上内容另有问题,见上方红条)' : '与线上一致'}
                </span>
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
            {/* 🔴 已经在发布页时,这个按钮点了什么都不会发生、也没有任何反馈(实景走查 P2-3)。
                界面上的每个按钮都该要么有效、要么显式禁用并说明原因——「点了没反应」是最坏的一种。 */}
            {isOnPublish ? (
              <button className="btn sm" disabled title="已经在发布页了">去发布</button>
            ) : (
              <NavLink to="/publish" className="btn sm">去发布</NavLink>
            )}
          </div>
          {/* 会话未确认前不挂子页:避免未登录时子页各自发请求(见上方注释) */}
          {authed ? <Outlet /> : <div className="grid" style={{ marginTop: 12 }}><div className="skl" style={{ height: 120 }} /><div className="skl" style={{ height: 120 }} /></div>}
        </main>
      </div>
    </ShellCtx.Provider>
  );
}
