import type { MiddlewareHandler } from 'hono';
import type { Env } from './env';
import { requireAuth, timingSafeEqualHex } from './auth';
import { checkDraftUpgrade } from './config-upgrade';

export const RUNNER_FRESH_MS = 60_000;
export const RUNNER_ID = /^[a-zA-Z0-9_.:-]{1,100}$/;
const MACHINE_ROUTES = new Set(['next', 'step', 'heartbeat', 'runner-state', 'runner-fail']);

/** Execution credentials never authorize editing, publishing or administrator operations. */
export const requirePublishIdentity: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const route = new URL(c.req.url).pathname.replace(/\/$/, '').split('/').at(-1)!;
  if (!MACHINE_ROUTES.has(route)) return requireAuth(c, next);
  const secret = c.env.PUBLISH_RUNNER_TOKEN ?? '';
  const supplied = c.req.header('authorization') ?? '';
  if (secret.length < 32 || supplied.length > 1024 || !timingSafeEqualHex(supplied, `Bearer ${secret}`)) {
    return c.json({error:'unauthorized'}, 401);
  }
  await next();
};

/** Infrastructure availability also serves existing immutable jobs, independent of today's draft. */
async function executionAvailability(env: Env, now = Date.now()) {
  const mode = env.PUBLISH_EXECUTION_MODE ?? 'unconfigured';
  const result = { mode, ready:false, reason:'发布服务尚未配置，请联系维护人员完成部署。', lastSeenAt:null as number | null };
  if ((env.PUBLISH_RUNNER_TOKEN ?? '').length < 32) return result;
  if (mode === 'local' && env.ENVIRONMENT === 'dev') {
    const row = await env.DB.prepare('SELECT MAX(last_seen_at) AS t FROM publish_runner').first<{t:number | null}>();
    result.lastSeenAt = row?.t ?? null;
    result.ready = !!row?.t && now - row.t < RUNNER_FRESH_MS;
    result.reason = result.ready ? '' : '发布服务暂时不可用，正在等待服务恢复。草稿已保留。';
  } else if (mode === 'github' && env.ENVIRONMENT === 'production') {
    const repo = env.PUBLISH_GITHUB_REPOSITORY ?? '';
    const workflow = env.PUBLISH_GITHUB_WORKFLOW ?? '';
    const ref = env.PUBLISH_GITHUB_REF ?? '';
    result.ready = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)
      && /^[a-zA-Z0-9_.-]+\.ya?ml$/.test(workflow) && /^[a-zA-Z0-9_./-]{1,120}$/.test(ref)
      && (env.PUBLISH_GITHUB_TOKEN ?? '').length >= 20;
    if (result.ready) result.reason = '';
  }
  return result;
}

/** Accepting a new publication additionally requires the current draft to be compatible. */
export async function executorState(env: Env, now = Date.now()) {
  const result = await executionAvailability(env, now);
  if ((env.PUBLISH_RUNNER_TOKEN ?? '').length < 32) return result;
  const upgrade = await checkDraftUpgrade(env.DB);
  if (upgrade.status === 'blocked' || upgrade.status === 'retry') {
    result.ready = false;
    result.reason = upgrade.status === 'blocked'
      ? '配置有需要处理的冲突，发布服务准备尚未完成。草稿已保留。'
      : '发布服务正在准备新版配置，请稍后重试。草稿已保留。';
  }
  return result;
}

/** A durable outbox, not the lifetime of the HTTP request, owns retries. Duplicate dispatches
 * are harmless: a fixed CI concurrency group plus the version's atomic claim serialize work. */
export async function dispatchPending(env: Env, now = Date.now()) {
  if (env.PUBLISH_EXECUTION_MODE !== 'github' || !(await executionAvailability(env, now)).ready) return;
  const due = await env.DB.prepare(
    `SELECT d.version_id FROM publish_dispatch d JOIN publish_lock l ON l.version_id=d.version_id
     WHERE l.claimed_at IS NULL AND l.expires_at>?1 AND d.next_attempt_at<=?1 AND d.state<>'failed' LIMIT 1`,
  ).bind(now).first<{version_id:number}>();
  if (!due) return;
  const reserved = await env.DB.prepare(
    `UPDATE publish_dispatch SET state='sending', attempts=attempts+1, next_attempt_at=?2
     WHERE version_id=?1 AND next_attempt_at<=?3 RETURNING attempts`,
  ).bind(due.version_id, now + 90_000, now).first<{attempts:number}>();
  if (!reserved) return;
  let problem: string | null = null;
  let runId: string | null = null;
  try {
    const response = await fetch(`https://api.github.com/repos/${env.PUBLISH_GITHUB_REPOSITORY}/actions/workflows/${env.PUBLISH_GITHUB_WORKFLOW}/dispatches`, {
      method:'POST', redirect:'error', signal:AbortSignal.timeout(8_000),
      headers:{authorization:`Bearer ${env.PUBLISH_GITHUB_TOKEN}`, accept:'application/vnd.github+json', 'content-type':'application/json', 'user-agent':'nexgrid-publisher', 'x-github-api-version':'2026-03-10'},
      body:JSON.stringify({ref:env.PUBLISH_GITHUB_REF, inputs:{versionId:String(due.version_id)}}),
    });
    if (!response.ok) problem = `调度服务返回 HTTP ${response.status}`;
    else {
      const body = await response.json().catch(() => null) as {workflow_run_id?: number} | null;
      runId = body?.workflow_run_id ? String(body.workflow_run_id) : null;
    }
  } catch { problem = '调度连接暂时中断，将自动重试'; }
  // A timeout may mean delivery succeeded. Keep the record retryable until claimed or expired.
  await env.DB.prepare(`UPDATE publish_dispatch SET state=?2,last_error=?3,run_id=COALESCE(?4,run_id),next_attempt_at=?5 WHERE version_id=?1`)
    .bind(due.version_id, problem ? 'pending' : 'waiting', problem, runId, now + (problem ? 30_000 : 90_000)).run();
}
