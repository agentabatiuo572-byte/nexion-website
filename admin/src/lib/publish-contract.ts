export interface PublishConfirmation {
  reason: string;
  rollbackFrom?: number;
  /** 普通发布在打开确认面时冻结的草稿 revision。 */
  draftRev?: number;
}

export function publishRequestBody(confirm: PublishConfirmation): { reason: string; fromVersion?: number; draftRev?: number } {
  if (confirm.rollbackFrom !== undefined) return { reason: confirm.reason, fromVersion: confirm.rollbackFrom };
  if (confirm.draftRev === undefined) throw new Error('missing-draft-revision');
  return { reason: confirm.reason, draftRev: confirm.draftRev };
}
