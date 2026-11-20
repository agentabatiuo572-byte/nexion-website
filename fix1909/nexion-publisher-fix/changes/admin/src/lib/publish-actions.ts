import type { PublishConfirmation } from './publish-contract';

export type PublishIntent = 'draft' | 'rebuild';
export interface PublishPrecheck {
  ready: boolean;
  changed: number;
  errors: unknown[];
  draftRev: number;
  message?: string;
}
export interface PublishAvailability {
  activeVersion: number | null;
  versions: Array<{ id: number; status: string }>;
  executor: { ready: boolean; reason: string };
}

export function publishBlockReason(pre: PublishPrecheck, status: PublishAvailability, intent: PublishIntent = 'draft'): string | null {
  if (status.activeVersion) return '已有发布正在进行，请等待本次任务结束。';
  if (status.versions.some(version => version.status === 'unknown')) return '上一次切换结果尚未核实，暂时不能再次发布。';
  if (!status.executor.ready) return status.executor.reason || '发布服务尚未就绪，请恢复服务后重新检查。';
  if (pre.message) return pre.message;
  if (pre.errors.length) return '请先处理上方前置检查问题，再重新检查。';
  if (intent === 'rebuild') {
    if (pre.changed !== 0) return '已有待发布的内容改动，请核对后使用“检查并发布”。';
    if (!status.versions.some(version => version.status === 'live')) return '没有可重新构建的线上版本。';
  } else if (!pre.ready) {
    return pre.changed === 0 ? '没有内容改动；代码升级请使用下方的版本重建入口。' : '前置检查尚未就绪，请重新检查。';
  }
  return null;
}

export function preparePublishConfirmation(pre: PublishPrecheck, status: PublishAvailability, intent: PublishIntent = 'draft'): PublishConfirmation {
  const blocked = publishBlockReason(pre, status, intent);
  if (blocked) throw new Error(blocked);
  if (intent === 'rebuild') {
    const version = status.versions.find(item => item.status === 'live')!;
    // Pin the explicitly reviewed snapshot. Reuse the server's fully checked snapshot
    // publication path, never send an allow-empty/skip-validation flag.
    return { reason: `使用当前发布器代码重新构建 v${version.id}，保留该版本内容并执行全部检查`, rollbackFrom: version.id, rebuild: true };
  }
  return { reason: '', draftRev: pre.draftRev };
}

/** Older loads and polls cannot overwrite a newer full preflight/status pair. */
export function createPublishRequestGate() {
  let revision = 0;
  let pending = false;
  return {
    begin: () => { pending = true; return ++revision; },
    pending: () => pending,
    finish: (ticket: number) => { if (ticket === revision) pending = false; },
    current: () => revision,
    isCurrent: (ticket: number) => ticket === revision,
    invalidate: () => { revision++; pending = false; },
  };
}
