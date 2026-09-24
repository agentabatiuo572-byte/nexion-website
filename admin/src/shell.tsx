/* 控制台壳(CON02):导航五组 + 状态条三 chip + 失败红条 + 重试;当前位置高亮。 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { NavLink, Outlet, useBlocker, useLocation, useNavigate } from 'react-router-dom';
import { advanceAuthGeneration, ApiError, api, toast, type Overview } from './api';
import { failReasonLine } from './lib/fail-reason';
import { shouldBlockNavigation } from './lib/unsaved-changes';
import { Icon, type IconName } from './lib/icon';
import { TranslationProvider } from './lib/translations';
import { publishedSiteUrl } from './lib/published-site';

function keepEditorFocusVisible(field: EventTarget | null): void {
  if (!(field instanceof HTMLElement) || field.closest('.editor-actions')) return;
  requestAnimationFrame(() => {
    if (document.activeElement !== field) return;
    const actions = field.closest('.editor-page')?.querySelector('.editor-actions');
    if (!actions) return;
    const box = field.getBoundingClientRect();
    const bar = actions.getBoundingClientRect();
    const bottom = Math.min(window.innerHeight, bar.top) - 12;
    // Native focus scrolling does not account for the sticky bar or an already-focused field after resize.
    if (box.top < 12 || box.bottom > bottom) {
      window.scrollBy({ top: box.top - Math.max(12, (bottom - box.height) / 2), behavior: 'instant' });
    }
  });
}

const onEditorFocus = (event: SyntheticEvent<HTMLElement>) => keepEditorFocusVisible(event.target);

interface ShellState {
  overview: Overview | null;
  failed: boolean;
  reload: (expectation?: OverviewExpectation) => Promise<Overview | null>;
  setUnsavedChanges: (dirty: boolean) => void;
}
const ShellCtx = createContext<ShellState>({ overview: null, failed: false, reload: async () => null, setUnsavedChanges: () => {} });
export const useShell = () => useContext(ShellCtx);

export interface OverviewExpectation {
  geo?: { enabled: boolean; countries: number; degraded: boolean };
}

const matchesExpectation = (overview: Overview, expectation?: OverviewExpectation): boolean => {
  if (!expectation?.geo) return true;
  return overview.geo?.enabled === expectation.geo.enabled
    && overview.geo.countries === expectation.geo.countries
    && overview.geo.degraded === expectation.geo.degraded;
};

/** 编辑页把本页 dirty 状态登记到壳；壳统一拦截侧栏跳转和浏览器离开。 */
export function useUnsavedChanges(dirty: boolean): void {
  const { setUnsavedChanges } = useShell();
  useEffect(() => {
    setUnsavedChanges(dirty);
    return () => setUnsavedChanges(false);
  }, [dirty, setUnsavedChanges]);
}

const NAV: Array<{ group: string; items: Array<{ to: string; label: string; icon: IconName }> }> = [
  { group: '工作空间', items: [{ to: '/', label: '数据概览', icon: 'chart' }] },
  {
    group: '网站管理',
    items: [
      { to: '/content', label: '网站文案', icon: 'file' },
      { to: '/content/languages', label: '语言设置', icon: 'globe' },
      { to: '/ai', label: 'AI 翻译设置', icon: 'globe' },
      { to: '/content/downloads', label: '下载入口', icon: 'download' },
      { to: '/content/stats', label: '展示数字', icon: 'users' },
      { to: '/content/skus', label: '产品卡片', icon: 'grid' },
      { to: '/content/faq', label: '常见问题', icon: 'message' },
      { to: '/content/announcement', label: '网站公告', icon: 'megaphone' },
      { to: '/content/seo', label: '联系与搜索设置', icon: 'settings' },
      { to: '/content/legal', label: '法律文档', icon: 'shield' },
    ],
  },
  { group: '访问控制', items: [{ to: '/geo', label: '区域屏蔽', icon: 'globe' }] },
  {
    group: '发布管理',
    items: [
      { to: '/publish', label: '发布与版本', icon: 'arrow-up-right' },
      { to: '/audit', label: '审计日志', icon: 'history' },
    ],
  },
];

export default function Shell() {
  const nav = useNavigate();
  const routeLocation = useLocation();
  const isOnPublish = routeLocation.pathname === '/publish';
  const [overview, setOverview] = useState<Overview | null>(null);
  const [failed, setFailed] = useState(false);
  const [hasUnsavedChanges, setUnsavedChanges] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutNotice, setLogoutNotice] = useState<string | null>(null);
  const [criticalRefresh, setCriticalRefresh] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const currentPage = NAV.flatMap((group) => group.items).find((item) => item.to === routeLocation.pathname);
  const allowNextNavigation = useRef(false);
  const reloadGeneration = useRef(0);
  const requiredExpectation = useRef<OverviewExpectation | null>(null);

  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    const authBypass = (nextLocation.state as { bypassUnsaved?: boolean } | null)?.bypassUnsaved === true;
    return shouldBlockNavigation(
      hasUnsavedChanges,
      currentLocation.pathname,
      nextLocation.pathname,
      allowNextNavigation.current || authBypass,
    );
  });

  useEffect(() => {
    allowNextNavigation.current = false;
    setMenuOpen(false);
  }, [routeLocation.pathname]);

  useEffect(() => {
    const onResize = () => keepEditorFocusVisible(document.activeElement);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    if (window.confirm('本页有未保存改动。确定离开并放弃这些改动吗？')) blocker.proceed();
    else blocker.reset();
  }, [blocker]);

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hasUnsavedChanges]);

  const reload = useCallback(async (expectation?: OverviewExpectation): Promise<Overview | null> => {
    if (expectation) requiredExpectation.current = expectation;
    const generation = ++reloadGeneration.current;
    const isCritical = requiredExpectation.current !== null;
    if (isCritical) setCriticalRefresh(true);
    setFailed(false);
    try {
      const next = await api<Overview>('/api/config');
      if (generation !== reloadGeneration.current) return null;
      if (!matchesExpectation(next, requiredExpectation.current ?? expectation)) {
        setCriticalRefresh(false);
        setFailed(true);
        return null;
      }
      requiredExpectation.current = null;
      setCriticalRefresh(false);
      setOverview(next);
      return next;
    } catch {
      if (generation === reloadGeneration.current) {
        setCriticalRefresh(false);
        setFailed(true);
      }
      return null;
    }
  }, []);
  /* 🔴 先确认会话,再渲染子页(实景走查 P2-9)。
     此前壳与子页同时挂载并各自发请求,未登录时会连着打出好几个 401 ——
     其中 `/api/dash` 那条是纯浪费的越权请求(用户还没登录,驾驶舱就去拉数据了)。
     现在等会话探针有结果再放子页;401 由 api 层统一用**路由跳转**踢回登录。 */
  const [authed, setAuthed] = useState(false);
  useEffect(() => {
    api('/api/me')
      .then(() => { setAuthed(true); reload(); })
      .catch((e) => {
        /* 🔴 401 之外的错误必须落进失败态(2026-09-01 第八轮 P1-1,**这是我上一轮修补引入的回归**)。
           我当时写的注释是「其它错误由下面的失败态兜」——**而那个兜底并不存在**:
           后端整体不可达时 authed 永远为 false、failed 永远为 false,
           界面就永久停在骨架屏,既不报错也没有重试按钮。
           注释里写的「由别处兜」是一句零成本的断言,当时没有任何东西验证它。 */
        if ((e as ApiError)?.status !== 401) setFailed(true);
      });
  }, [reload]);

  async function logout() {
    if (loggingOut) return;
    if (hasUnsavedChanges && !window.confirm('本页有未保存改动。确定退出并放弃这些改动吗？')) return;
    setLoggingOut(true);
    setLogoutNotice(null);
    const completeLogout = (message: string) => {
      allowNextNavigation.current = true;
      setUnsavedChanges(false);
      advanceAuthGeneration();
      toast(message);
      nav('/login', { state: { bypassUnsaved: true } });
    };
    try {
      await api('/api/auth/logout', { method: 'POST' }, { redirectUnauthorized: false });
      completeLogout('已退出');
    } catch {
      /* 退出接口可能已经删掉 session，只在写审计或回传响应时失败。失败后必须回读，
         不能把“没收到成功响应”误说成“会话仍有效”。 */
      try {
        await api('/api/me', undefined, { redirectUnauthorized: false });
        const message = '退出请求未完整成功；回读确认会话仍然有效，请重试';
        setLogoutNotice(message);
        toast(message);
      } catch (probeError) {
        if (probeError instanceof ApiError && probeError.status === 401) {
          completeLogout('退出响应异常，但回读确认会话已经结束');
        } else {
          const message = '退出结果暂时未知，无法确认会话是否仍有效；请刷新页面核实';
          setLogoutNotice(message);
          toast(message);
        }
      }
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <ShellCtx.Provider value={{ overview, failed, reload, setUnsavedChanges }}>
      <div className="shell" data-unsaved={hasUnsavedChanges ? 'true' : 'false'}>
        <div className="mobile-toolbar">
          <span className="mobile-brand">Uvel <span>官网后台</span></span>
          <button className="icon-button" aria-label={menuOpen ? '关闭导航' : '打开导航'} aria-expanded={menuOpen} aria-controls="console-navigation" onClick={() => setMenuOpen((open) => !open)}><Icon name={menuOpen ? 'close' : 'menu'} /></button>
        </div>
        <a href="#workspace" className="skip-link">跳到页面内容</a>
        <aside id="console-navigation" className={`sidebar ${menuOpen ? 'mobile-open' : ''}`}>
          <div className="brandrow">
            <img className="brand-mark" src={new URL('../../public/logo-mark-dark.webp', import.meta.url).href} alt="" />
            <div className="lbl">
              <b className="brand-name">Uvel</b>
              <div className="brand-caption">官网运营工作台</div>
            </div>
          </div>
          <nav aria-label="主导航">
          {NAV.map((g) => (
            <div key={g.group || 'root'}>
              {g.group && <div className="navg"><span className="tag">{g.group}</span></div>}
              {/* 🔴 窄窗下 .lbl 被 CSS 隐藏、只剩一个 aria-hidden 的 emoji,于是每个导航链接的
                  可访问名为空——读屏器什么都读不到,肉眼要靠猜图标(实景走查 P2-5)。
                  aria-label 给读屏器,title 给鼠标悬停;图标仍 aria-hidden(它不是信息)。 */}
              {g.items.map((it) => (
                <NavLink key={it.to} to={it.to} end={it.to === '/' || it.to === '/content'} aria-label={it.label} title={it.label} className={({ isActive }) => `nav ${isActive ? 'on' : ''}`}>
                  <Icon name={it.icon} size={19} />
                  <span className="lbl">{it.label}</span>
                  {it.to === '/publish' && (overview?.dirty ?? 0) > 0 && <span className="pill warn">{overview!.dirty}</span>}
                </NavLink>
              ))}
            </div>
          ))}
          </nav>
          <div style={{ flex: 1 }} />
          <div className="sidebar-account"><span className="account-avatar">U</span><span className="lbl"><b>管理员</b><small>官网运营</small></span><button className="icon-button" title="退出登录" aria-label={loggingOut ? '退出中…' : '退出'} disabled={loggingOut} onClick={logout}><Icon name="logout" size={18} /></button></div>
        </aside>
        <main className="content" id="workspace" tabIndex={-1} onFocusCapture={onEditorFocus} onInputCapture={onEditorFocus}>
          <header className="workspace-header"><div className="breadcrumb"><span>官网后台</span><Icon name="chevron-right" size={14} /><b>{currentPage?.label ?? '页面'}</b></div><a href={publishedSiteUrl()} target="_blank" rel="noreferrer" className="btn ghost sm">查看官网 <Icon name="arrow-up-right" size={16} /></a></header>
          {/* 线上内容与系统记录对不上:此前只在发布页显示,别的页面仍写「与线上一致」(第四轮 P1-6) */}
          {!isOnPublish && !failed && !criticalRefresh && overview?.drift && (
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
          {/* 发布页集中显示当前阻断和历史失败，其余页面保留全局提醒。 */}
          {!isOnPublish && !failed && !criticalRefresh && overview?.lastPublishFailed && (
            <div className="note bad" style={{ margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: 10 }}>
              {/* 只给人话:壳顶这行没有排查场景,门名/原始报错留在发布页详情(lib/fail-reason 单源) */}
              <span>上次发布失败(v{overview.lastPublishFailed.id}):{failReasonLine(overview.lastPublishFailed.reason)}　{overview.drift ? '线上内容需核查，请到发布页查看当前核验结果。' : `当前记录的线上版本为 v${overview.liveVersion}。`}</span>
              <NavLink to="/publish" className="btn ghost sm">去看详情</NavLink>
            </div>
          )}
          <div className="statusbar">
            {criticalRefresh ? (
              <span className="note" style={{ margin: 0 }}>正在同步最新全局状态…</span>
            ) : failed ? (
              <span className="note bad" style={{ margin: 0 }}>
                {overview ? '全局状态刷新失败，旧状态已隐藏' : '状态获取失败'} <button className="btn ghost sm" onClick={() => void reload()}>重试</button>
              </span>
            ) : overview ? (
              <>
                <span className="chip"><span className="status-dot" />线上 <b>v{overview.liveVersion}</b></span>
                {/* 🔴 「与线上一致」说的是**草稿 vs 线上版本**,可劈叉时它会和上方红条同屏矛盾
                    (红条:线上内容与系统记录对不上)。劈叉时把话说准:草稿没改动,但线上内容另有问题。 */}
                <span className={`chip ${overview.dirty ? 'warnc' : overview.drift ? 'warnc' : ''}`}>
                  {overview.dirty ? `草稿 · ${overview.dirty} 处未发布改动` : overview.drift ? '草稿无改动，线上内容需核查' : '与线上一致'}
                </span>
                <NavLink to="/geo" className={`chip ${overview.geo?.degraded ? 'warnc' : ''}`} title="区域屏蔽(只读状态;点击进入规则面板)">
                  屏蔽 <b>{overview.geo ? (overview.geo.enabled ? `开启 · ${overview.geo.countries} 个地区` : '未启用') : '状态未知'}</b>
                  {overview.geo?.degraded && ' ⚠ 兜底中'}
                </NavLink>
              </>
            ) : (
              <span className="skl" style={{ width: 260 }} />
            )}
            <span className="spacer" />
            {/* 🔴 已经在发布页时,这个按钮点了什么都不会发生、也没有任何反馈(实景走查 P2-3)。
                界面上的每个按钮都该要么有效、要么显式禁用并说明原因——「点了没反应」是最坏的一种。 */}
            {isOnPublish ? (
              <span className="kv">正在查看发布与版本</span>
            ) : (
              <NavLink to="/publish" className="btn primary sm">检查并发布 <Icon name="arrow-up-right" size={16} /></NavLink>
            )}
          </div>
          {logoutNotice && <div className="note warn" role="status" style={{ marginBottom: 10 }}>{logoutNotice}</div>}
          {/* 会话未确认前不挂子页:避免未登录时子页各自发请求(见上方注释) */}
          {authed ? (
            <TranslationProvider draftRevision={overview?.draft.draftRev} onDraftChanged={reload}><Outlet /></TranslationProvider>
          ) : failed ? (
            <div className="note bad" style={{ marginTop: 12 }}>后台服务连不上,页面无法加载 <button className="btn ghost sm" onClick={() => { setFailed(false); location.reload(); }}>重试</button></div>
          ) : (
            <div className="grid" style={{ marginTop: 12 }}><div className="skl" style={{ height: 120 }} /><div className="skl" style={{ height: 120 }} /></div>
          )}
        </main>
      </div>
    </ShellCtx.Provider>
  );
}
