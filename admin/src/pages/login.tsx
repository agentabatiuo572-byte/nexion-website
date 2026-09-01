/* 登录页(CON01 ⑤⑥:默认/加载/报错/锁定倒计时四态) */
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, api } from '../api';
import { lockoutText, useLockout } from '../lib/use-lockout';

export default function Login() {
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const lock = useLockout();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || lock.sec > 0) return;
    setBusy(true);
    setErr('');
    try {
      await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ password: pw }) });
      nav(sp.get('back') || '/', { replace: true });
    } catch (ex) {
      if (lock.capture(ex)) {
        setErr('');
      } else if (ex instanceof ApiError && ex.status === 401) {
        setErr('用户名或口令不正确');
      } else {
        setErr('网络异常,请重试');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-card">
      <form className="logincard" onSubmit={submit}>
        <div className="row" style={{ marginBottom: 14 }}>
          <span className="dot" />
          <span className="tag">NEXGRID · SITE CONSOLE</span>
        </div>
        <h1>官网后台</h1>
        <div className="field" style={{ marginTop: 14 }}>
          <label htmlFor="pw">管理员口令</label>
          <input id="pw" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
        </div>
        {err && <div className="note bad">{err}</div>}
        {lock.sec > 0 && <div className="note bad">{lockoutText(lock.sec)}</div>}
        <button className="btn primary" style={{ width: '100%', marginTop: 6 }} disabled={busy || lock.sec > 0}>
          {busy ? '登录中…' : '登录'}
        </button>
        <p className="kv" style={{ marginTop: 12 }}>首次使用?先完成初始化(需要部署时配置的初始化令牌):<a href="/admin/setup" style={{ color: 'var(--ink2)' }}>去初始化 →</a></p>
      </form>
    </div>
  );
}
