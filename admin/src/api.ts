/* API 层:同源 /api(dev 走 vite 代理→8787);401 统一踢回登录并记回跳(CON01-E3)。 */

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: { error?: string; retryAfterSec?: number } & Record<string, unknown>,
  ) {
    super(body.error ?? `http-${status}`);
  }
}

/* 401 跳转的注入点:main.tsx 在 router 就绪后把 navigate 传进来。
   每个请求在发出时记住认证世代：旧会话的迟到 401 不能影响已经登录成功的新会话。 */
let routerNavigate: ((to: string) => void) | null = null;
let authGeneration = 0;
let redirectedGeneration: number | null = null;
export function setUnauthorizedRedirect(fn: (to: string) => void): void {
  routerNavigate = fn;
  redirectedGeneration = null;
}

/** 登录/明确退出完成后推进会话世代；此前已经发出的请求从此只能报错，不能再导航。 */
export function advanceAuthGeneration(): void {
  authGeneration += 1;
  redirectedGeneration = null;
}

/** 网络错误没有 ApiError.body；失败提示统一在这里做安全降级。 */
export function apiErrorHint(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  const hint = error.body.hint ?? error.body.message;
  return typeof hint === 'string' && hint.trim() ? hint : fallback;
}

export async function api<T>(path: string, init?: RequestInit, options: { redirectUnauthorized?: boolean } = {}): Promise<T> {
  const requestGeneration = authGeneration;
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  /* 401 踢回登录页。
     🔴 两处修正(2026-09-01 实景走查 P2-9):
     ① 用**路由跳转**,不用 `location.assign` —— 后者是整页重载,会丢掉 SPA 状态、重下一次 bundle;
        更要命的是页面刚打开时三个探针请求会**同时**拿到 401,于是连着触发三次整页导航,
        浏览器反复「开始导航又取消」,控制台留下一串 ERR_ABORTED。
     ② 同一次加载里只跳**一次**:多个并发 401 只认第一个。
     跳转函数由 main.tsx 在 router 就绪后注入;注入前(或非 SPA 场景)退回整页跳,不至于卡死。 */
  if (
    res.status === 401
    && options.redirectUnauthorized !== false
    && requestGeneration === authGeneration
    && !location.hash.includes('login')
    && !location.pathname.includes('login')
  ) {
    const back = encodeURIComponent(location.pathname.replace(/^\/admin/, '') + location.search);
    if (redirectedGeneration !== requestGeneration) {
      redirectedGeneration = requestGeneration;
      if (routerNavigate) routerNavigate(`/login?back=${back}`);
      else location.assign(`/admin/login?back=${back}`);
    }
    throw new ApiError(401, { error: 'unauthorized' });
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

export interface Overview {
  liveVersion: number;
  livePublishedAt: number;
  /** 区域屏蔽只读状态(CON02-③;来自 CON12 的 KV 规则) */
  geo: { enabled: boolean; countries: number; degraded: boolean } | null;
  /** 线上快照对不上:版本号不符,或版本号对但内容被直接改过(tampered 列出对不上的文件) */
  drift: { dbLive: number; snapshot: number | null; tampered?: string[] } | null;
  /** CON02-E2:上次发布失败(且线上之后没再成功发布过)→ 壳顶红条 */
  lastPublishFailed: { id: number; reason: string; at: number } | null;
  draft: { payload: Record<string, unknown>; draftRev: number; updatedAt: number };
  live?: { payload: Record<string, unknown> };
  dirty: number;
  changedPaths: string[];
  sensitiveChanged: string[];
}

export function toast(msg: string): void {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout((el as HTMLElement & { _h?: number })._h);
  (el as HTMLElement & { _h?: number })._h = window.setTimeout(() => el!.classList.remove('on'), 2600);
}
