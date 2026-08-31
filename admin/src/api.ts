/* API 层:同源 /api(dev 走 vite 代理→8787);401 统一踢回登录并记回跳(CON01-E3)。 */

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: { error?: string; retryAfterSec?: number } & Record<string, unknown>,
  ) {
    super(body.error ?? `http-${status}`);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  if (res.status === 401 && !location.hash.includes('login') && !location.pathname.includes('login')) {
    const back = encodeURIComponent(location.pathname.replace(/^\/admin/, '') + location.search);
    location.assign(`/admin/login?back=${back}`);
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
  /** CON02-E2:上次发布失败(且线上之后没再成功发布过)→ 壳顶红条 */
  lastPublishFailed: { id: number; reason: string; at: number } | null;
  draft: { payload: Record<string, unknown>; draftRev: number; updatedAt: number };
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
