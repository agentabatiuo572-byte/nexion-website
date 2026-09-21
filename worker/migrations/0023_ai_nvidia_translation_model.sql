-- Replace the unresponsive general chat model with NVIDIA's free translation NIM.
UPDATE translation_jobs SET status='pending',attempts=0,error_code='model-changed',next_attempt_at=0,
  lease_token=NULL,lease_until=NULL,updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER)
WHERE intent='auto' AND status='failed' AND error_code IN ('invalid-result','network-error','provider-unavailable','rate-limited')
  AND EXISTS (SELECT 1 FROM ai_connection WHERE id=1 AND provider='nvidia' AND model='mistralai/mistral-nemotron');
UPDATE ai_connection SET model='nvidia/riva-translate-4b-instruct-v2',execution_rev=execution_rev+1,
  call_lease_token=NULL,call_lease_until=NULL,call_sent=0,updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER)
WHERE id=1 AND provider='nvidia' AND model='mistralai/mistral-nemotron';
