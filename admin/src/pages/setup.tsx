/* 首次初始化(CON01:令牌+设口令;已初始化 → 410 提示,E4) */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, api, toast } from '../api';

export default function Setup() {
  const nav = useNavigate();
  const [token, setToken] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [gone, setGone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (pw.length < 12) return setErr('口令至少 12 位');
    if (pw !== pw2) return setErr('两次口令不一致');
    setBusy(true);
    setErr('');
    try {
      await api('/api/auth/setup', { method: 'POST', body: JSON.stringify({ token, password: pw }) });
      toast('初始化完成,请登录');
      nav('/login', { replace: true });
    } catch (ex) {
      if (ex instanceof ApiError && ex.status === 410) setGone(true);
      else if (ex instanceof ApiError && ex.status === 403) setErr('初始化令牌不正确');
      else if (ex instanceof ApiError && ex.status === 429) setErr('尝试过多,稍后再试');
      else setErr('网络异常,请重试');
    } finally {
      setBusy(false);
    }
  }

  if (gone)
    return (
      <div className="center-card">
        <div className="logincard">
          <h1>已初始化</h1>
          <p className="kv" style={{ margin: '10px 0' }}>本后台已完成初始化,此入口永久失效。忘记口令须重新部署轮换 SETUP_TOKEN(见 worker/README 运维手册)。</p>
          <a className="btn" style={{ width: '100%' }} href="/admin/login">去登录</a>
        </div>
      </div>
    );

  return (
    <div className="center-card">
      <form className="logincard" onSubmit={submit}>
        <h1>初始化管理员口令</h1>
        <div className="field"><label>初始化令牌(SETUP_TOKEN)</label><input value={token} onChange={(e) => setToken(e.target.value)} autoFocus /></div>
        <div className="field"><label>设置口令(≥12 位)</label><input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></div>
        <div className="field"><label>重复口令</label><input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></div>
        {err && <div className="note bad">{err}</div>}
        <button className="btn primary" style={{ width: '100%', marginTop: 6 }} disabled={busy}>{busy ? '提交中…' : '设置口令'}</button>
      </form>
    </div>
  );
}
