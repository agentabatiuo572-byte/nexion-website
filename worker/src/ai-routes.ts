import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { requireAuth, requireSameOriginJson } from './auth';
import { enqueueMissingTranslations } from './translations';
import {
  AiError, isAiProvider, isTranslationTarget, TRANSLATION_TARGET_LOCALES, requestTranslations, validateTranslationInputs, type AiProvider, type TranslationResult,
} from './ai-client';
import {
  aiAudit, aiConnectionUsable, aiLeaseGuardSql, aiLeaseGuardValues, allowedAiModels, claimAiCall, encryptApiKey,
  finishAiCall, getAiConnection, getAiConnectionState, markAiCallSent, type AiEnv,
} from './ai-connection';

type C = Context<{ Bindings: AiEnv }>;
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const operation = z.object({
  expectedCredentialRev: revision, expectedOperationSeq: revision,
  operationId: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/),
});
const candidate = operation.extend({
  provider: z.custom<AiProvider>(isAiProvider).optional(), model: z.string().min(1).max(100),
  apiKey: z.string().min(12).max(1024).regex(/^[^\s\u0000-\u001f\u007f]+$/u),
}).strict();
const currentTest = operation.strict();
const remove = z.object({ expectedCredentialRev: revision }).strict();
const settings = z.object({
  expectedSettingsRev: revision, enabled: z.boolean().optional(),
  dailyCharacterLimit: z.number().int().min(1000).max(500000).optional(),
}).strict().refine(v => v.enabled !== undefined || v.dailyCharacterLimit !== undefined);
const TEST_FIELDS = [{ id: 'connection-test', source: '欢迎使用 NexGrid。', maxLength: 120 }];
const TEST_TARGET = TRANSLATION_TARGET_LOCALES[0];
const TEST_CHARACTERS = validateTranslationInputs(TEST_TARGET, TEST_FIELDS);
const translation = z.object({
  source: z.string().min(1).max(6000),
  targetLocale: z.custom<(typeof TRANSLATION_TARGET_LOCALES)[number]>(isTranslationTarget),
}).strict();
const messages: Record<string, string> = {
  'invalid-key': 'AI 密钥无效，请检查后重试。', 'permission-denied': 'AI 密钥没有所选模型的调用权限。',
  'model-unavailable': '所选模型不可用。', 'quota-exhausted': 'AI 服务额度不足。',
  'billing-required': 'AI 服务账户尚未开通付款或额度，请检查所选服务商的付款设置后重试。',
  'rate-limited': 'AI 服务暂时限流，请稍后重试。', 'provider-unavailable': 'AI 服务暂时不可用。',
  'provider-rejected': 'AI 服务未接受请求。', 'network-error': 'AI 请求连接中断，消耗状态未知，请先查看操作结果。',
  'invalid-result': 'AI 返回内容未通过校验，原配置已保留。', 'response-too-large': 'AI 返回内容超过上限。',
  'encryption-unavailable': '服务端加密配置缺失或无效，原配置已保留。',
  'decryption-failed': '无法解密已有 AI 配置，请恢复原根密钥或移除后重新配置。',
  'ai-storage-unavailable': 'AI 存储尚未准备就绪。', busy: 'AI 正在处理另一项请求，请稍后重试。',
  conflict: 'AI 配置已变化，请刷新后重试。', 'daily-limit': '已达到今日 AI 调用上限。',
  'test-rate-limited': '连接测试过于频繁或已达到今日测试上限。',
  'ai-unavailable': '请先配置可用的 AI 连接。', cancelled: '操作已取消或配置已变化。',
};
function failure(c: C, error: string) {
  // Upstream authentication failures are AI business errors, never administrator HTTP 401.
  const status = ['conflict', 'busy', 'cancelled'].includes(error) ? 409
    : ['daily-limit', 'test-rate-limited'].includes(error) ? 429
    : ['encryption-unavailable', 'decryption-failed', 'ai-storage-unavailable'].includes(error) ? 503 : 422;
  return c.json({ error, message: messages[error] ?? 'AI 操作未完成，原数据已保留。' }, status);
}
async function body<T>(c: C, schema: z.ZodType<T>): Promise<T | null> {
  const reader = c.req.raw.body?.getReader();
  if (!reader) return null;
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.length;
      if (length > 8192) { await reader.cancel(); return null; }
      parts.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  const text = new TextDecoder().decode(bytes);
  try { const parsed = schema.safeParse(JSON.parse(text)); return parsed.success ? parsed.data : null; }
  catch { return null; }
}
export const aiRoutes = new Hono<{ Bindings: AiEnv }>();
aiRoutes.onError((e, c) => {
  if (e instanceof AiError) return failure(c, e.code);
  // Hono catches route errors before outer middleware: override its default logging handler.
  return c.json({ error: 'ai-operation-failed', message: 'AI 操作未完成，请刷新状态后重试。' }, 503);
});
aiRoutes.use('*', requireAuth);
aiRoutes.use('*', requireSameOriginJson);
aiRoutes.use('*', async (c, next) => {
  if (!['GET', 'HEAD'].includes(c.req.method)) {
    if (Number(c.req.header('content-length') ?? 0) > 8192) return c.json({ error: 'body-too-large' }, 413);
  }
  await next();
});
aiRoutes.get('/connection', async c => c.json(await getAiConnectionState(c.env)));

// A button click produces an editable suggestion; only the normal Save action writes the draft.
aiRoutes.post('/translate', async c => {
  const input = await body(c, translation);
  if (!input) return c.json({ error: 'bad-request' }, 400);
  const fields = [{ id: 'preview', source: input.source }];
  const characters = validateTranslationInputs(input.targetLocale, fields);
  const connection = await getAiConnection(c.env.DB);
  const claimed = await claimAiCall(c.env, { purpose: 'preview', characters,
    expectedCredentialRev: connection.credential_rev, expectedExecutionRev: connection.execution_rev });
  if (claimed.status !== 'claimed') return failure(c, claimed.status === 'rejected' ? claimed.error : 'conflict');
  const lease = claimed.lease;
  let result: TranslationResult | undefined, error: string | undefined;
  try {
    if (!(await markAiCallSent(c.env, lease))) throw new AiError('cancelled');
    result = await requestTranslations(lease.apiKey, lease.model, input.targetLocale, fields, c.req.raw.signal, lease.provider);
    const current = await c.env.DB.prepare('SELECT 1 AS current WHERE ' + aiLeaseGuardSql()).bind(...aiLeaseGuardValues(lease)).first();
    if (!current) throw new AiError('cancelled');
  } catch (e) { error = e instanceof AiError ? e.code : 'ai-operation-failed'; }
  finally { await finishAiCall(c.env, lease, { usage: result?.usage, error }); }
  if (error || !result) return failure(c, error ?? 'invalid-result');
  return c.json({ text: result.translations[0].text });
});

async function testConnection(c: C, save: boolean) {
  const parsed = save ? await body(c, candidate) : await body(c, currentTest);
  if (!parsed) return c.json({ error: 'bad-request' }, 400);
  const input = parsed as z.infer<typeof candidate>;
  const claimed = await claimAiCall(c.env, {
    purpose: save ? 'test-candidate' : 'test-current', characters: TEST_CHARACTERS,
    expectedCredentialRev: input.expectedCredentialRev, expectedOperationSeq: input.expectedOperationSeq,
    operationId: input.operationId, provider: input.provider, model: input.model, candidateKey: input.apiKey,
  });
  if (claimed.status === 'rejected') return failure(c, claimed.error);
  if (claimed.status === 'duplicate') return c.json({ ...(await getAiConnectionState(c.env)), duplicate: true });
  const lease = claimed.lease;
  let result: TranslationResult | undefined;
  let error: string | undefined;
  let applied = false;
  try {
    if (!(await markAiCallSent(c.env, lease))) throw new AiError('cancelled');
    result = await requestTranslations(lease.apiKey, lease.model, TEST_TARGET, TEST_FIELDS, undefined, lease.provider);
    const now = Date.now();
    if (save) {
      const encrypted = await encryptApiKey(c.env, lease.apiKey, lease.provider);
      const rows = await c.env.DB.batch([
        c.env.DB.prepare('UPDATE ai_connection SET key_ciphertext=?1,key_iv=?2,key_version=?3,root_initialized=1,' +
          'model=?4,provider=?12,credential_rev=credential_rev+1,execution_rev=execution_rev+1,connection_status=?5,last_test_at=?6,' +
          'operation_status=?7,operation_error=NULL,updated_at=?6 ' +
          'WHERE id=1 AND credential_rev=?8 AND operation_seq=?9 AND operation_id=?10 AND call_lease_token=?11 AND call_lease_until>?6')
          .bind(encrypted.ciphertext, encrypted.iv, encrypted.version, lease.model, 'available', now, 'succeeded',
            lease.credentialRev, lease.operationSeq, lease.operationId, lease.token, lease.provider),
        aiAudit(c.env.DB, 'ai.connection.saved', 'credential ' + (lease.credentialRev + 1) + '; provider ' + lease.provider + '; model ' + lease.model, now),
      ]);
      applied = (rows[0].meta.changes ?? 0) > 0;
    } else {
      const rows = await c.env.DB.batch([
        c.env.DB.prepare('UPDATE ai_connection SET connection_status=?1,last_test_at=?2,operation_status=?3,operation_error=NULL,updated_at=?2 ' +
          'WHERE id=1 AND credential_rev=?4 AND execution_rev=?5 AND operation_seq=?6 AND operation_id=?7 AND call_lease_token=?8 AND call_lease_until>?2')
          .bind('available', now, 'succeeded', lease.credentialRev, lease.executionRev, lease.operationSeq, lease.operationId, lease.token),
        aiAudit(c.env.DB, 'ai.connection.tested', 'credential ' + lease.credentialRev + '; provider ' + lease.provider + '; model ' + lease.model, now),
      ]);
      applied = (rows[0].meta.changes ?? 0) > 0;
    }
    if (!applied) error = 'cancelled';
  } catch (e) { error = e instanceof AiError ? e.code : 'ai-operation-failed'; }
  finally { await finishAiCall(c.env, lease, { usage: result?.usage, error }); }
  if (error) return failure(c, error);
  return c.json({ ...(await getAiConnectionState(c.env)), saved: applied });
}
aiRoutes.put('/connection', c => testConnection(c, true));
aiRoutes.post('/connection/test', c => testConnection(c, false));
aiRoutes.delete('/connection', async c => {
  const input = await body(c, remove);
  if (!input) return c.json({ error: 'bad-request' }, 400);
  const now = Date.now();
  const rows = await c.env.DB.batch([
    c.env.DB.prepare('UPDATE ai_connection SET key_ciphertext=NULL,key_iv=NULL,key_version=NULL,enabled=0,' +
      'credential_rev=credential_rev+1,settings_rev=settings_rev+1,execution_rev=execution_rev+1,' +
      'operation_seq=operation_seq+1,operation_id=NULL,operation_status=?1,operation_error=NULL,connection_status=?2,updated_at=?3 ' +
      'WHERE id=1 AND credential_rev=?4')
      .bind('cancelled', 'unconfigured', now, input.expectedCredentialRev),
    aiAudit(c.env.DB, 'ai.connection.removed', 'credential ' + (input.expectedCredentialRev + 1), now),
  ]);
  if (!(rows[0].meta.changes ?? 0)) return failure(c, 'conflict');
  return c.json(await getAiConnectionState(c.env));
});
aiRoutes.patch('/settings', async c => {
  const input = await body(c, settings);
  if (!input) return c.json({ error: 'bad-request' }, 400);
  const row = await getAiConnection(c.env.DB);
  if (row.settings_rev !== input.expectedSettingsRev) return failure(c, 'conflict');
  if (input.enabled === true) {
    const state = await getAiConnectionState(c.env);
    if (!state.ready || !aiConnectionUsable(row) || !allowedAiModels(c.env, row.provider).includes(row.model)) return failure(c, 'ai-unavailable');
  }
  const enabled = input.enabled === undefined ? row.enabled : Number(input.enabled);
  const limit = input.dailyCharacterLimit ?? row.daily_character_limit;
  if (enabled === row.enabled && limit === row.daily_character_limit) return settingsResult(c, input.enabled === true);
  const now = Date.now();
  const rows = await c.env.DB.batch([
    c.env.DB.prepare('UPDATE ai_connection SET enabled=?1,daily_character_limit=?2,settings_rev=settings_rev+1,' +
      'execution_rev=execution_rev+CASE WHEN enabled<>?1 THEN 1 ELSE 0 END,updated_at=?3 ' +
      'WHERE id=1 AND settings_rev=?4 AND credential_rev=?5 AND execution_rev=?6')
      .bind(enabled, limit, now, row.settings_rev, row.credential_rev, row.execution_rev),
    aiAudit(c.env.DB, 'ai.settings', 'enabled ' + enabled + '; daily characters ' + limit, now),
  ]);
  if (!(rows[0].meta.changes ?? 0)) return failure(c, 'conflict');
  return settingsResult(c, input.enabled === true);
});
async function settingsResult(c: C, scan: boolean) {
  let scanStatus: 'not-needed' | 'queued' | 'retry' = 'not-needed';
  if (scan) {
    try { await enqueueMissingTranslations(c.env); scanStatus = 'queued'; }
    catch { scanStatus = 'retry'; } // The settings transaction already committed successfully.
  }
  return c.json({ ...(await getAiConnectionState(c.env)), scanStatus });
}
