import type { Env } from './env';
import { AI_PROVIDERS, AiError, isAiProvider, type AiProvider, type AiUsage } from './ai-client';

export type AiEnv = Env & { AI_CREDENTIAL_ENCRYPTION_KEY?: string; AI_ALLOWED_MODELS?: string };
export const AI_LEASE_MS = 90_000;
export const AI_TEST_COOLDOWN_MS = 10_000;
export const AI_DAILY_TEST_LIMIT = 20;
export interface AiConnection {
  id: number; provider: AiProvider; model: string; root_initialized: number;
  credential_rev: number; settings_rev: number; execution_rev: number; enabled: number;
  key_ciphertext: string | null; key_iv: string | null; key_version: number | null;
  connection_status: string; last_test_at: number | null;
  operation_seq: number; operation_id: string | null; operation_status: string;
  operation_error: string | null; operation_kind: string | null;
  call_lease_token: string | null; call_lease_until: number | null; call_sent: number;
  call_purpose: string | null; call_day: string | null; call_characters: number;
  usage_day: string; daily_character_limit: number; sent_characters: number; call_count: number;
  input_tokens: number; output_tokens: number; unknown_usage_count: number;
  test_day: string; test_count: number; next_test_at: number; updated_at: number;
}
export interface AiCallLease {
  token: string; until: number; credentialRev: number; executionRev: number;
  operationSeq: number; operationId: string | null; purpose: AiCallInput['purpose'];
  day: string; characters: number; provider: AiProvider; model: string; apiKey: string;
}
export interface AiCallInput {
  purpose: 'translation' | 'preview' | 'test-candidate' | 'test-current';
  characters: number; expectedCredentialRev: number; expectedExecutionRev?: number;
  expectedOperationSeq?: number; operationId?: string;
  candidateKey?: string; provider?: AiProvider; model?: string; now?: number;
}
export type AiClaim = { status: 'claimed'; lease: AiCallLease } |
  { status: 'duplicate'; operationStatus: string; operationError: string | null } |
  { status: 'rejected'; error: string };
const encoder = new TextEncoder();
const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);
const temporary = new Set(['available', 'rate-limited', 'provider-unavailable', 'network-error']);
const blocking = new Set(['invalid-key', 'permission-denied', 'model-unavailable', 'quota-exhausted', 'billing-required']);

export function allowedAiModels(env: AiEnv, provider: AiProvider = 'zen'): string[] {
  if (!isAiProvider(provider)) return [];
  const allowed = AI_PROVIDERS[provider].allowedModels as readonly string[];
  const selected = env.AI_ALLOWED_MODELS?.split(',').map(v => v.trim()).filter(Boolean) ?? allowed;
  return [...new Set(selected)].filter(v => allowed.includes(v));
}
function decode(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new AiError('encryption-unavailable');
  try { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
  catch { throw new AiError('encryption-unavailable'); }
}
function encode(value: ArrayBuffer | Uint8Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(value instanceof Uint8Array ? value : value)));
}
export async function encryptionKey(env: AiEnv): Promise<CryptoKey> {
  const bytes = decode(env.AI_CREDENTIAL_ENCRYPTION_KEY ?? '');
  if (bytes.byteLength !== 32) throw new AiError('encryption-unavailable');
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
// Retain the exact v1 AAD for existing Zen/Gemini ciphertext and bind each provider's key separately.
const aad = (env: AiEnv, provider: AiProvider) => encoder.encode('nexgrid-ai-connection:1:' + provider + ':v1:' + env.ENVIRONMENT);
export function validApiKey(key: unknown): key is string {
  return typeof key === 'string' && key.length >= 12 && key.length <= 1024 && !/[\s\u0000-\u001f\u007f]/u.test(key);
}
export async function encryptApiKey(env: AiEnv, plaintext: string, provider: AiProvider = 'zen') {
  if (!isAiProvider(provider)) throw new AiError('model-unavailable');
  if (!validApiKey(plaintext)) throw new AiError('invalid-key-format');
  const key = await encryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(env, provider), tagLength: 128 }, key, encoder.encode(plaintext));
  return { ciphertext: encode(ciphertext), iv: encode(iv), version: 1 };
}
export async function decryptApiKey(env: AiEnv, row: AiConnection): Promise<string> {
  const key = await encryptionKey(env);
  if (!isAiProvider(row.provider) || !row.key_ciphertext || !row.key_iv || row.key_version !== 1) throw new AiError('encryption-unavailable');
  try {
    const iv = decode(row.key_iv);
    if (iv.length !== 12) throw new Error();
    const plaintext = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aad(env, row.provider), tagLength: 128 }, key, decode(row.key_ciphertext),
    ));
    if (!validApiKey(plaintext)) throw new Error();
    return plaintext;
  } catch { throw new AiError('decryption-failed'); }
}
export async function getAiConnection(db: D1Database): Promise<AiConnection> {
  const row = await db.prepare('SELECT * FROM ai_connection WHERE id=1').first<AiConnection>();
  if (!row) throw new AiError('ai-storage-unavailable');
  return row;
}
export function aiConnectionUsable(row: AiConnection): boolean {
  return !!row.key_ciphertext && temporary.has(row.connection_status);
}
export async function getAiConnectionState(env: AiEnv, now = Date.now()) {
  const row = await getAiConnection(env.DB);
  let encryptionReady = false;
  let encryptionError: string | null = null;
  try { if (row.key_ciphertext) await decryptApiKey(env, row); else await encryptionKey(env); encryptionReady = true; }
  catch (e) { encryptionError = e instanceof AiError ? e.code : 'encryption-unavailable'; }
  const today = row.usage_day === utcDay(now);
  const models = allowedAiModels(env, row.provider);
  return {
    provider: row.provider, model: row.model, allowedModels: models,
    providers: (Object.keys(AI_PROVIDERS) as AiProvider[]).map(id => ({ id, name: AI_PROVIDERS[id].name,
      defaultModel: AI_PROVIDERS[id].defaultModel, allowedModels: allowedAiModels(env, id) })), configured: !!row.key_ciphertext,
    rootInitialized: !!row.root_initialized, encryptionReady,
    credentialRev: row.credential_rev, activeRevision: row.credential_rev, settingsRev: row.settings_rev,
    executionRev: row.execution_rev, enabled: !!row.enabled,
    status: encryptionError ?? (models.includes(row.model) ? row.connection_status : 'model-unavailable'),
    ready: encryptionReady && aiConnectionUsable(row) && models.includes(row.model),
    operationSeq: row.operation_seq, operationId: row.operation_id,
    operationStatus: row.operation_status === 'running' && (row.call_lease_until ?? 0) <= now ? 'unknown' : row.operation_status,
    operationError: row.operation_error, lastTestAt: row.last_test_at,
    busy: (row.call_lease_until ?? 0) > now,
    dailyCharacterLimit: row.daily_character_limit,
    usage: { day: utcDay(now), sentCharacters: today ? row.sent_characters : 0, calls: today ? row.call_count : 0,
      inputTokens: today ? row.input_tokens : 0, outputTokens: today ? row.output_tokens : 0, unknownCalls: today ? row.unknown_usage_count : 0 },
  };
}

/** Guard for statements supplied by the translation engine in the SAME reservation batch. */
export function aiLeaseGuardSql(): string {
  return 'EXISTS (SELECT 1 FROM ai_connection WHERE id=1 AND call_lease_token=? AND credential_rev=? AND execution_rev=? AND call_lease_until>?)';
}
export function aiLeaseGuardValues(lease: AiCallLease, now = Date.now()): [string, number, number, number] {
  return [lease.token, lease.credentialRev, lease.executionRev, now];
}
type AiAuditAction = 'ai.connection.attempt' | 'ai.connection.saved' | 'ai.connection.tested' | 'ai.connection.removed' | 'ai.settings';
export function aiAudit(db: D1Database, action: AiAuditAction, detail: string, now = Date.now()) {
  // Immediately follows the conditional mutation inside one batch; no intervening statement.
  return db.prepare('INSERT INTO audit(ts,actor,action,target,after_summary) SELECT ?,?,?,?,? WHERE changes()>0')
    .bind(now, 'admin', action, 'ai-connection', detail);
}

/** Crash recovery never refunds uncertain charges or automatically repeats a connection test. */
export async function recoverAiCall(db: D1Database, now = Date.now()): Promise<void> {
  await db.prepare('UPDATE ai_connection SET operation_status=CASE WHEN operation_status=? THEN ? ELSE operation_status END, ' +
    'operation_error=CASE WHEN operation_status=? THEN ? ELSE operation_error END, call_lease_token=NULL,call_lease_until=NULL,call_sent=0 ' +
    'WHERE id=1 AND call_lease_until<=?').bind('running', 'unknown', 'running', 'interrupted', now).run();
}

/** Extra statements must use aiLeaseGuardSql/Values, so a lost reservation cannot claim work. */
export async function claimAiCall(
  env: AiEnv, input: AiCallInput,
  extraStatements: (lease: AiCallLease) => D1PreparedStatement[] = () => [],
): Promise<AiClaim> {
  const now = input.now ?? Date.now();
  await recoverAiCall(env.DB, now);
  const row = await getAiConnection(env.DB);
  const test = input.purpose === 'test-candidate' || input.purpose === 'test-current';
  if (test && input.operationId === row.operation_id) return { status: 'duplicate', operationStatus: row.operation_status, operationError: row.operation_error };
  if (!Number.isSafeInteger(input.characters) || input.characters < 1 || input.characters > 3000) return { status: 'rejected', error: 'too-long' };
  if (row.credential_rev !== input.expectedCredentialRev ||
    (input.expectedExecutionRev !== undefined && row.execution_rev !== input.expectedExecutionRev) ||
    (test && row.operation_seq !== input.expectedOperationSeq)) return { status: 'rejected', error: 'conflict' };
  if ((row.call_lease_until ?? 0) > now) return { status: 'rejected', error: 'busy' };
  if (!test && ((input.purpose === 'translation' && !row.enabled) || !aiConnectionUsable(row))) return { status: 'rejected', error: 'ai-unavailable' };
  if (test && (!input.operationId || !/^[a-zA-Z0-9_-]{8,128}$/.test(input.operationId))) return { status: 'rejected', error: 'invalid-operation' };
  const model = input.purpose === 'test-candidate' ? input.model ?? '' : row.model;
  const provider = input.purpose === 'test-candidate' ? input.provider ?? 'zen' : row.provider;
  if (!allowedAiModels(env, provider).includes(model)) return { status: 'rejected', error: 'model-unavailable' };
  await encryptionKey(env);
  const apiKey = input.purpose === 'test-candidate' ? input.candidateKey : await decryptApiKey(env, row);
  if (!validApiKey(apiKey)) return { status: 'rejected', error: 'invalid-key-format' };
  const day = utcDay(now);
  if ((row.usage_day === day ? row.sent_characters : 0) + input.characters > row.daily_character_limit) return { status: 'rejected', error: 'daily-limit' };
  if (test && (row.next_test_at > now || (row.test_day === day && row.test_count >= AI_DAILY_TEST_LIMIT))) return { status: 'rejected', error: 'test-rate-limited' };
  const lease: AiCallLease = { token: crypto.randomUUID(), until: now + AI_LEASE_MS, credentialRev: row.credential_rev,
    executionRev: row.execution_rev, operationSeq: row.operation_seq + (test ? 1 : 0), operationId: test ? input.operationId! : null,
    purpose: input.purpose, day, characters: input.characters, provider, model, apiKey };
  const reserve = env.DB.prepare(
    'UPDATE ai_connection SET call_lease_token=?1,call_lease_until=?2,call_sent=0,call_purpose=?3,call_day=?4,call_characters=?5,' +
    'sent_characters=CASE WHEN usage_day=?4 THEN sent_characters+?5 ELSE ?5 END,' +
    'call_count=CASE WHEN usage_day=?4 THEN call_count+1 ELSE 1 END,' +
    'input_tokens=CASE WHEN usage_day=?4 THEN input_tokens ELSE 0 END,output_tokens=CASE WHEN usage_day=?4 THEN output_tokens ELSE 0 END,' +
    'unknown_usage_count=CASE WHEN usage_day=?4 THEN unknown_usage_count+1 ELSE 1 END,usage_day=?4,' +
    'operation_seq=operation_seq+?6,operation_id=CASE WHEN ?6=1 THEN ?7 ELSE operation_id END,' +
    'operation_status=CASE WHEN ?6=1 THEN ?8 ELSE operation_status END,operation_error=CASE WHEN ?6=1 THEN NULL ELSE operation_error END,' +
    'operation_kind=CASE WHEN ?6=1 THEN ?3 ELSE operation_kind END,' +
    'test_count=CASE WHEN ?6=1 THEN CASE WHEN test_day=?4 THEN test_count+1 ELSE 1 END ELSE test_count END,' +
    'test_day=CASE WHEN ?6=1 THEN ?4 ELSE test_day END,next_test_at=CASE WHEN ?6=1 THEN ?9 ELSE next_test_at END,updated_at=?10 ' +
    'WHERE id=1 AND credential_rev=?11 AND execution_rev=?12 AND operation_seq=?13 AND (call_lease_until IS NULL OR call_lease_until<=?10) ' +
    'AND (CASE WHEN usage_day=?4 THEN sent_characters ELSE 0 END)+?5<=daily_character_limit ' +
    'AND (?6=0 OR (next_test_at<=?10 AND (test_day<>?4 OR test_count<?14)))' +
    " AND (?3<>'translation' OR enabled=1)",
  ).bind(lease.token, lease.until, input.purpose, day, input.characters, test ? 1 : 0, input.operationId ?? null,
    'running', now + AI_TEST_COOLDOWN_MS, now, row.credential_rev, row.execution_rev, row.operation_seq, AI_DAILY_TEST_LIMIT);
  const statements = [reserve];
  if (test) statements.push(aiAudit(env.DB, 'ai.connection.attempt', 'operation ' + lease.operationSeq + '; provider ' + provider + '; model ' + model, now));
  statements.push(...extraStatements(lease));
  const result = await env.DB.batch(statements);
  if (!(result[0].meta.changes ?? 0)) return { status: 'rejected', error: 'conflict' };
  return { status: 'claimed', lease };
}

/** Must succeed immediately before fetch. Old execution tokens cannot send after disable/replace. */
export async function markAiCallSent(env: AiEnv, lease: AiCallLease, now = Date.now()): Promise<boolean> {
  const result = await env.DB.prepare('UPDATE ai_connection SET call_sent=1 WHERE id=1 AND call_lease_token=?1 ' +
    'AND credential_rev=?2 AND execution_rev=?3 AND call_lease_until>?4 AND call_sent=0 AND (?5<>?6 OR enabled=1)')
    .bind(lease.token, lease.credentialRev, lease.executionRev, now, lease.purpose, 'translation').run();
  return (result.meta.changes ?? 0) > 0;
}
export async function finishAiCall(
  env: AiEnv, lease: AiCallLease, outcome: { usage?: AiUsage | null; error?: string; sent?: boolean }, now = Date.now(),
): Promise<boolean> {
  const usage = outcome.usage;
  const known = !!usage && [usage.inputTokens, usage.outputTokens, usage.totalTokens].every(v => Number.isSafeInteger(v) && v >= 0)
    && usage.totalTokens === usage.inputTokens + usage.outputTokens;
  const error = outcome.error ?? null;
  const status = lease.purpose !== 'test-candidate' && error && (blocking.has(error) || temporary.has(error)) ? error : null;
  const finish = env.DB.prepare('UPDATE ai_connection SET ' +
    'sent_characters=sent_characters-CASE WHEN call_sent=0 AND usage_day=?2 THEN call_characters ELSE 0 END,' +
    'call_count=call_count-CASE WHEN call_sent=0 AND usage_day=?2 THEN 1 ELSE 0 END,' +
    'input_tokens=input_tokens+CASE WHEN ?3=1 AND call_sent=1 AND usage_day=?2 THEN ?4 ELSE 0 END,' +
    'output_tokens=output_tokens+CASE WHEN ?3=1 AND call_sent=1 AND usage_day=?2 THEN ?5 ELSE 0 END,' +
    'unknown_usage_count=MAX(0,unknown_usage_count-CASE WHEN usage_day=?2 AND (call_sent=0 OR ?3=1) THEN 1 ELSE 0 END),' +
    'connection_status=CASE WHEN credential_rev=?6 AND execution_rev=?7 AND ?8 IS NOT NULL THEN ?8 ELSE connection_status END,' +
    'execution_rev=execution_rev+CASE WHEN credential_rev=?6 AND execution_rev=?7 AND ?9=1 THEN 1 ELSE 0 END,' +
    'operation_status=CASE WHEN operation_id=?10 AND operation_seq=?11 AND operation_status=?12 THEN ?13 ELSE operation_status END,' +
    'operation_error=CASE WHEN operation_id=?10 AND operation_seq=?11 AND operation_status=?12 THEN ?14 ELSE operation_error END,' +
    'call_lease_token=NULL,call_lease_until=NULL,call_sent=0,updated_at=?15 WHERE id=1 AND call_lease_token=?1')
    .bind(lease.token, lease.day, known ? 1 : 0, known ? usage!.inputTokens : 0, known ? usage!.outputTokens : 0,
      lease.credentialRev, lease.executionRev, status, error && blocking.has(error) && lease.purpose !== 'test-candidate' ? 1 : 0,
      lease.operationId, lease.operationSeq, 'running', error ? (error === 'network-error' ? 'unknown' : 'failed') : 'succeeded', error, now);
  const statements = [finish];
  if (error && lease.purpose.startsWith('test-')) statements.push(aiAudit(env.DB, 'ai.connection.tested', 'operation ' + lease.operationSeq + '; result ' + error, now));
  const rows = await env.DB.batch(statements);
  return (rows[0].meta.changes ?? 0) > 0;
}
