/* 登录页(CON01 ⑤⑥:默认/加载/报错/锁定倒计时四态) */
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { advanceAuthGeneration, ApiError, api } from '../api';
import { lockoutText, useLockout } from '../lib/use-lockout';
import { Icon } from '../lib/icon';
import './editors.css';

const logo = new URL('../../../public/logo-lockup-dark.webp', import.meta.url).href;

export default function Login() {
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const lock = useLockout();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || lock.sec > 0) return;
    setBusy(true);
    setErr('');
    try {
      await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: pw }) });
      advanceAuthGeneration();
      nav(sp.get('back') || '/', { replace: true });
    } catch (ex) {
      if (lock.capture(ex)) {
        setErr('');
      } else if (ex instanceof ApiError && ex.status === 401) {
        setErr('管理员口令不正确，请重新输入');
      } else {
        setErr('网络异常,请重试');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <section className="auth-intro" aria-label="NexGrid 官网管理">
        <img className="auth-logo" src={logo} alt="NexGrid" width="176" height="60" />
        <div className="auth-story">
          <span className="auth-kicker">SITE CONSOLE</span>
          <h1>让每次更新，<br /><em>清晰可控。</em></h1>
          <p>从了解访问情况，到调整内容、发布上线。<br />官网运营，从这里开始。</p>
          <div className="auth-features">
            <span><Icon name="chart" />了解网站表现</span>
            <span><Icon name="file" />管理多语言内容</span>
            <span><Icon name="shield" />检查后再发布</span>
          </div>
        </div>
        <span className="auth-footer">NexGrid · 官网管理工作台</span>
      </section>
      <main className="auth-main">
        <form className="auth-form" onSubmit={submit} aria-busy={busy}>
          <div className="auth-lock"><Icon name="lock" size={24} /></div>
          <span className="eyebrow">管理员登录</span>
          <h2>欢迎回来</h2>
          <p className="auth-description">输入管理员口令，进入官网后台。</p>
          <div className="field">
            <label htmlFor="pw">管理员口令</label>
            <div className="password-field">
              <input id="pw" type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus aria-describedby={err || lock.sec > 0 ? 'login-error' : undefined} />
              <button type="button" className="password-toggle" aria-label={showPassword ? '隐藏口令' : '显示口令'} aria-pressed={showPassword} onClick={() => setShowPassword((shown) => !shown)}><Icon name={showPassword ? 'eye-off' : 'eye'} /></button>
            </div>
          </div>
          {(err || lock.sec > 0) && <div id="login-error" className="note bad" role="alert">{lock.sec > 0 ? lockoutText(lock.sec) : err}</div>}
          <button className="btn primary auth-submit" disabled={busy || lock.sec > 0}>
            {busy ? '登录中…' : '登录'}<Icon name="arrow-right" size={18} />
          </button>
          <div className="auth-setup-link"><span>首次使用？</span><a href="/admin/setup">初始化管理员 <Icon name="arrow-up-right" size={16} /></a></div>
          <p className="kv auth-help">初始化需要部署时配置的初始化令牌。</p>
        </form>
        <span className="auth-main-footer"><Icon name="shield" size={15} />仅管理员可访问</span>
      </main>
    </div>
  );
}
