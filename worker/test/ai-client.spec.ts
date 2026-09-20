import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { requestTranslations, validateTranslationInputs, validateTranslationText, AiError, AI_DEFAULT_MODEL, AI_PROVIDERS, isAiProvider, type AiProvider } from '../src/ai-client';
import { LOCALES, SOURCE_LOCALE } from '../../schema/src/locales.js';
import { validateTranslationValue, enumerateTranslationFields } from '../../schema/src/draft-fields.js';
import { SiteConfigSchema } from '../../schema/src/index.js';
import { DRAFT_MANIFEST } from '../src/draft-write';
import seed from '../seed/site-config.seed.json';

const fields = [{ id: '/copy/hero', source: '下载 NexGrid 2.0\n适用于 {name}', maxLength: 160 }];
const result = (text = 'Download NexGrid 2.0\nfor {name}') => ({
  status: 'completed', error: null, incomplete_details: null, id: 'resp-fixture',
  output: [{ type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: JSON.stringify({ translations: [{ id: fields[0].id, text }] }) }] }],
  usage: { input_tokens: 12, output_tokens: 18, total_tokens: 30 },
});
beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unmocked provider request')); });
afterEach(() => vi.restoreAllMocks());
const chineseTranslations = {
  en: 'Connect idle devices and start sharing compute.',
  vi: 'Kết nối thiết bị nhàn rỗi và bắt đầu chia sẻ sức mạnh tính toán.',
  es: 'Conecta dispositivos inactivos y empieza a compartir capacidad de cómputo.',
  pt: 'Conecte dispositivos ociosos e comece a compartilhar capacidade computacional.',
  fr: 'Connectez les appareils inactifs et commencez à partager leur puissance de calcul.',
  de: 'Verbinde ungenutzte Geräte und teile ihre Rechenleistung.',
  ja: '使っていない端末を接続し、計算能力の共有を始めましょう。',
  ko: '유휴 기기를 연결하고 컴퓨팅 자원 공유를 시작하세요.',
};
describe('Chinese source contract', () => {
  const source = '连接闲置设备，开始共享算力。';
  it('covers every target in the source-language contract', () => {
    expect(Object.keys(chineseTranslations)).toEqual(LOCALES.filter(locale => locale !== SOURCE_LOCALE));
  });
  it.each(Object.entries(chineseTranslations))('validates Chinese to %s while preserving protected terms', async (target, text) => {
    const input = [{ id: fields[0].id, source }];
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(result(text)));
    expect(await requestTranslations('synthetic-provider-key', AI_DEFAULT_MODEL, target, input)).toMatchObject({ translations: [{ id: fields[0].id, text }] });
    const body = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    expect(body.instructions).toContain(`from ${SOURCE_LOCALE} into ${target}`);
    if (target !== 'ja') {
      expect(() => validateTranslationText(source, target, source)).toThrow(AiError);
      expect(() => validateTranslationText(source, target, '连接闲置设备，开始共享算力！')).toThrow(AiError);
    }
    expect(() => validateTranslationText('NexGrid · USDT {name} 2.0', target, 'NexGrid · USDT {name} 2.0')).not.toThrow();
  });
  it.each(['安全', '法律'])('allows the valid Chinese/Japanese shared term %s', source => {
    expect(() => validateTranslationText(source, 'ja', source)).not.toThrow();
  });
  it('rejects the source locale before any external request', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    await expect(requestTranslations('synthetic-provider-key', AI_DEFAULT_MODEL, SOURCE_LOCALE, [{ id: 'x', source }])).rejects.toMatchObject({ code: 'invalid-input' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['en', 'vi', 'es', 'pt', 'fr', 'de', 'ja', 'ko'])('rejects output in the wrong script for %s', target => {
    const wrong = target === 'ja' || target === 'ko' ? 'Connect idle devices and share compute.' : 'アイドル端末を接続して計算能力を共有します。';
    expect(() => validateTranslationInputs(target, [{ id: 'x', source }])).not.toThrow();
    expect(() => validateTranslationText(source, target, wrong)).toThrow(AiError);
  });
});
const geminiResult = () => ({ id: 'chatcmpl-fixture', choices: [{ index: 0, finish_reason: 'stop',
  message: { role: 'assistant', content: JSON.stringify({ translations: [{ id: fields[0].id, text: 'Download NexGrid 2.0\nfor {name}' }] }) } }],
  usage: { prompt_tokens: 12, completion_tokens: 18, total_tokens: 30 } });
const gemini = () => requestTranslations('AQ.synthetic-key-never-real', AI_PROVIDERS.gemini.defaultModel, 'en', fields, undefined, 'gemini');
const providers = [
  ['zen', 'https://opencode.ai/zen/v1/responses', 'responses'],
  ['gemini', 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', 'chat'],
  ['openai', 'https://api.openai.com/v1/responses', 'responses'],
  ['anthropic', 'https://api.anthropic.com/v1/messages', 'messages'],
  ['deepseek', 'https://api.deepseek.com/chat/completions', 'chat'],
  ['groq', 'https://api.groq.com/openai/v1/chat/completions', 'chat'],
  ['openrouter', 'https://openrouter.ai/api/v1/chat/completions', 'chat'],
  ['nvidia', 'https://integrate.api.nvidia.com/v1/chat/completions', 'chat'],
] as const;
const responseFor = (provider: AiProvider, translations: unknown = [{ id: fields[0].id, text: 'Download NexGrid 2.0\nfor {name}' }], model: string = AI_PROVIDERS[provider].defaultModel) => {
  const text = JSON.stringify({ translations });
  if (provider === 'anthropic') return { id: 'msg_fixture', type: 'message', role: 'assistant', stop_reason: 'end_turn',
    content: [{ type: 'text', text }], usage: { input_tokens: 12, output_tokens: 18 } };
  if ((provider === 'zen' && model !== 'deepseek-v4-flash-free') || provider === 'openai') return { ...result(), output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }] };
  return { ...geminiResult(), choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }] };
};
const callProvider = (provider: AiProvider, model: string = AI_PROVIDERS[provider].defaultModel) =>
  requestTranslations('synthetic-' + provider + '-key', model, 'en', fields, undefined, provider);
describe('eight fixed provider transports', () => {
  it('accepts exactly the eight registered IDs, rejecting inherited object properties', () => {
    expect(Object.keys(AI_PROVIDERS)).toEqual(providers.map(([id]) => id));
    for (const id of ['constructor', '__proto__', 'toString', '', 'OpenAI', null, {}]) expect(isAiProvider(id)).toBe(false);
  });
  it('routes OpenCode Zen DeepSeek V4 Flash Free through the chat endpoint', async () => {
    expect(AI_PROVIDERS.zen.defaultModel).toBe('deepseek-v4-flash-free');
    expect(AI_PROVIDERS.zen.allowedModels[0]).toBe('deepseek-v4-flash-free');
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(geminiResult()));
    const answer = await requestTranslations('synthetic-zen-key', 'deepseek-v4-flash-free', 'en', fields, undefined, 'zen');
    expect(answer).toMatchObject({ translations: [{ id: fields[0].id, text: 'Download NexGrid 2.0\nfor {name}' }] });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://opencode.ai/zen/v1/chat/completions');
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: 'deepseek-v4-flash-free', max_tokens: 4096,
      response_format: { type: 'json_object' }, messages: [{ role: 'system' }, { role: 'user' }] });
    for (const key of ['input', 'text', 'store', 'reasoning', 'max_output_tokens', 'thinking']) expect(body[key]).toBeUndefined();
  });
  it('accepts NVIDIA JSON fences only after the chat envelope passes validation', async () => {
    expect(AI_PROVIDERS.nvidia.defaultModel).toBe('mistralai/mistral-nemotron');
    const fenced = '```json\n' + JSON.stringify({ translations: [{ id: fields[0].id, text: 'Download NexGrid 2.0\nfor {name}' }] }) + '\n```';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ...geminiResult(), choices: [{ index: 0, finish_reason: 'stop',
      message: { role: 'assistant', content: fenced } }] }));
    await expect(callProvider('nvidia')).resolves.toMatchObject({ translations: [{ id: fields[0].id, text: 'Download NexGrid 2.0\nfor {name}' }] });
  });
  it.each(providers.flatMap(([provider, endpoint, protocol]) => AI_PROVIDERS[provider].allowedModels.map(model => ({ provider, model,
    endpoint: provider === 'zen' && model === 'deepseek-v4-flash-free' ? 'https://opencode.ai/zen/v1/chat/completions' : endpoint,
    protocol: provider === 'zen' && model === 'deepseek-v4-flash-free' ? 'chat' : protocol }))))(
    '$provider / $model uses its fixed endpoint, credentials and protocol', async ({ provider, endpoint, protocol, model }) => {
      const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        new Request(url, init); return Response.json(responseFor(provider, undefined, model));
      });
      expect(await callProvider(provider, model)).toMatchObject({ translations: [{ id: fields[0].id, text: 'Download NexGrid 2.0\nfor {name}' }],
        usage: { inputTokens: 12, outputTokens: 18, totalTokens: 30 } });
      const [url, init] = fetcher.mock.calls[0];
      expect(url).toBe(endpoint); expect(init?.redirect).toBe('manual');
      const headers = new Headers(init?.headers), body = JSON.parse(String(init?.body));
      expect(headers.get('content-type')).toBe('application/json');
      expect(body).toMatchObject({ model, stream: false }); expect(body.tools).toBeUndefined();
      if (protocol === 'messages') {
        expect(headers.get('x-api-key')).toBe('synthetic-anthropic-key');
        expect(headers.get('anthropic-version')).toBe('2023-06-01'); expect(headers.has('authorization')).toBe(false);
        expect(body).toMatchObject({ max_tokens: 4096, thinking: { type: 'disabled' }, output_config: { format: { type: 'json_schema', schema: { additionalProperties: false } } } });
        expect(body.messages).toEqual([{ role: 'user', content: JSON.stringify({ targetLocale: 'en', fields }) }]);
      } else {
        expect(headers.get('authorization')).toBe('Bearer synthetic-' + provider + '-key'); expect(headers.has('x-api-key')).toBe(false);
        if (protocol === 'responses') {
          expect(body).toMatchObject({ store: false, max_output_tokens: 4096, text: { format: { type: 'json_schema', strict: true } } });
          expect(body.messages).toBeUndefined();
        } else {
          expect(body.messages[1].content).toBe(JSON.stringify({ targetLocale: 'en', fields }));
          if (provider === 'nvidia') {
            expect(body.response_format).toBeUndefined();
            expect(body.temperature).toBe(0);
            expect(body.messages[0].content).toContain('JSON object'); expect(body.messages[0].content).toContain('"translations"');
          } else if (provider === 'deepseek' || (provider === 'zen' && model === 'deepseek-v4-flash-free')) {
            expect(body.response_format).toEqual({ type: 'json_object' });
            expect(body.messages[0].content).toContain('JSON object'); expect(body.messages[0].content).toContain('"translations"');
            if (provider === 'deepseek') expect(body.thinking).toEqual({ type: 'disabled' });
            else expect(body.thinking).toBeUndefined();
          } else expect(body.response_format).toMatchObject({ type: 'json_schema', json_schema: { strict: true, schema: { additionalProperties: false } } });
          if (provider === 'groq') {
            expect(body).toMatchObject({ max_completion_tokens: 4096, include_reasoning: false, reasoning_effort: 'low' });
            expect(body.reasoning_format).toBeUndefined(); expect(body.max_tokens).toBeUndefined();
          } else expect(body.max_tokens).toBe(4096);
          if (provider === 'openrouter') expect(body.provider).toEqual({ require_parameters: true });
        }
      }
    });
  it.each(providers)('%s cannot bypass field validation, follow redirects or accept another protocol', async provider => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    for (const translations of [[], [{ id: 'foreign', text: '下载' }], [{ id: fields[0].id, text: '下载 NexGrid 9.0\n适用于 {name}' }],
      [{ id: fields[0].id, text: 'Download NexGrid 2.0\nfor {name}', extra: 'unwanted' }]]) {
      fetcher.mockResolvedValueOnce(Response.json(responseFor(provider, translations)));
      await expect(callProvider(provider)).rejects.toMatchObject({ code: 'invalid-result' });
    }
    fetcher.mockResolvedValueOnce(Response.json(provider === 'openai' ? geminiResult() : result()));
    await expect(callProvider(provider)).rejects.toMatchObject({ code: 'invalid-result' });
    fetcher.mockClear(); fetcher.mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: 'https://evil.example/key' } }));
    await expect(callProvider(provider)).rejects.toMatchObject({ code: 'provider-rejected' }); expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValueOnce(new Response('x'.repeat(262145)));
    await expect(callProvider(provider)).rejects.toMatchObject({ code: 'response-too-large' });
  });
  it.each(providers)('%s rejects disallowed models before sending and sanitizes all HTTP errors', async provider => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    await expect(callProvider(provider, 'unapproved-model')).rejects.toMatchObject({ code: 'model-unavailable' });
    expect(fetcher).not.toHaveBeenCalled();
    for (const [status, code] of [[401, 'invalid-key'], [402, 'billing-required'], [403, 'permission-denied'], [429, 'rate-limited'], [529, 'provider-unavailable']] as const) {
      fetcher.mockResolvedValueOnce(Response.json({ error: { message: 'synthetic-private-provider-key', metadata: { raw: 'private' } } }, { status }));
      await expect(callProvider(provider)).rejects.toMatchObject({ code, message: code });
    }
  });
  it.each(['max_tokens', 'refusal', 'tool_use', 'pause_turn', 'stop_sequence', null])('Anthropic rejects nonfinal stop reason %s', async stop_reason => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ...responseFor('anthropic'), stop_reason }));
    await expect(callProvider('anthropic')).rejects.toMatchObject({ code: 'invalid-result' });
  });
  it('Anthropic rejects tool, thinking, empty and multiple blocks', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    for (const content of [[], [{ type: 'tool_use', text: '{}' }], [{ type: 'thinking', text: '{}' }],
      [{ type: 'text', text: '{}' }, { type: 'text', text: '{}' }]]) {
      fetcher.mockResolvedValueOnce(Response.json({ ...responseFor('anthropic'), content }));
      await expect(callProvider('anthropic')).rejects.toMatchObject({ code: 'invalid-result' });
    }
  });
  it('Anthropic counts input cache tokens and rejects malformed or unsafe token totals', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ ...responseFor('anthropic'),
      usage: { input_tokens: 12, output_tokens: 18, cache_creation_input_tokens: 4, cache_read_input_tokens: 6 } }));
    expect((await callProvider('anthropic')).usage).toEqual({ inputTokens: 22, outputTokens: 18, totalTokens: 40 });
    for (const usage of [{ input_tokens: 12, output_tokens: 18, cache_read_input_tokens: '6' },
      { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 18 }, { output_tokens: 18 }]) {
      fetcher.mockResolvedValueOnce(Response.json({ ...responseFor('anthropic'), usage }));
      expect((await callProvider('anthropic')).usage).toBeNull();
    }
  });
});
describe('Gemini OpenAI-compatible chat boundary', () => {
  it.each(AI_PROVIDERS.gemini.allowedModels)('routes %s to Google with chat JSON schema and accepts AQ auth keys', async model => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      new Request(url, init);
      return Response.json(geminiResult());
    });
    const answer = await requestTranslations('AQ.synthetic-key-never-real', model, 'en', fields, undefined, 'gemini');
    expect(answer).toMatchObject({ usage: { inputTokens: 12, outputTokens: 18, totalTokens: 30 }, responseId: 'chatcmpl-fixture' });
    expect(answer.translations[0].text).toBe('Download NexGrid 2.0\nfor {name}');
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(AI_PROVIDERS.gemini.endpoint);
    expect(init).toMatchObject({ redirect: 'manual', headers: { authorization: 'Bearer AQ.synthetic-key-never-real' } });
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model, stream: false, max_tokens: 4096,
      messages: [{ role: 'system' }, { role: 'user', content: JSON.stringify({ targetLocale: 'en', fields }) }],
      response_format: { type: 'json_schema', json_schema: { strict: true, schema: { additionalProperties: false } } } });
    for (const key of ['tools', 'input', 'text', 'store', 'reasoning', 'max_output_tokens']) expect(body[key]).toBeUndefined();
  });
  it.each([['gemini', AI_DEFAULT_MODEL], ['zen', AI_PROVIDERS.gemini.defaultModel]])('rejects %s paired with %s before fetch', async (provider, model) => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    await expect(requestTranslations('synthetic-key', model, 'en', fields, undefined, provider as AiProvider)).rejects.toMatchObject({ code: 'model-unavailable' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['length', 'content_filter', 'tool_calls', null])('rejects nonfinal finish reason %s', async finish_reason => {
    const value = geminiResult();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ...value, choices: [{ ...value.choices[0], finish_reason }] }));
    await expect(gemini()).rejects.toMatchObject({ code: 'invalid-result' });
  });
  it.each([
    { refusal: 'synthetic-private' }, { tool_calls: [{ name: 'send' }] }, { function_call: { name: 'send' } },
    { content: null }, { content: '{"translations":[]}' }, { content: 'private output' }, { role: 'tool' },
  ])('rejects refusal, tool, missing and malformed content (%j)', async patch => {
    const value = geminiResult();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ...value, choices: [{ ...value.choices[0], message: { ...value.choices[0].message, ...patch } }] }));
    await expect(gemini()).rejects.toMatchObject({ code: 'invalid-result', message: 'invalid-result' });
  });
  it('rejects ambiguous choices and wrong provider envelopes', async () => {
    const value = geminiResult(), fetcher = vi.spyOn(globalThis, 'fetch');
    for (const payload of [{ ...value, choices: [] }, { ...value, choices: [...value.choices, ...value.choices] }, result()]) {
      fetcher.mockResolvedValueOnce(Response.json(payload));
      await expect(gemini()).rejects.toMatchObject({ code: 'invalid-result' });
    }
  });
  it.each([
    [400, 'INVALID_ARGUMENT', 'API_KEY_INVALID', 'invalid-key'],
    [400, 'INVALID_ARGUMENT', 'API_KEY_EXPIRED', 'invalid-key'],
    [401, 'UNAUTHENTICATED', '', 'invalid-key'],
    [403, 'PERMISSION_DENIED', 'BILLING_DISABLED', 'billing-required'],
    [400, 'FAILED_PRECONDITION', 'BILLING_NOT_ACTIVE', 'billing-required'],
    [403, 'PERMISSION_DENIED', 'API_KEY_SERVICE_BLOCKED', 'permission-denied'],
    [404, 'NOT_FOUND', '', 'model-unavailable'],
    [429, 'RESOURCE_EXHAUSTED', '', 'rate-limited'],
    [503, 'UNAVAILABLE', '', 'provider-unavailable'],
  ])('safely maps native HTTP %s / %s / %s', async (status, state, reason, code) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: {
      code: status, status: state, message: 'AQ.synthetic-private-key',
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, metadata: { private: 'AQ.synthetic-private-key' } }],
    } }, { status: Number(status) }));
    await expect(gemini()).rejects.toMatchObject({ code, message: code });
  });
  it('keeps shared redirects, size, malformed JSON and usage guards', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: 'https://evil.example' } }));
    await expect(gemini()).rejects.toMatchObject({ code: 'provider-rejected' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValueOnce(new Response('x'.repeat(262145)));
    await expect(gemini()).rejects.toMatchObject({ code: 'response-too-large' });
    fetcher.mockResolvedValueOnce(new Response('{broken'));
    await expect(gemini()).rejects.toMatchObject({ code: 'invalid-result' });
    fetcher.mockResolvedValueOnce(Response.json({ ...geminiResult(), usage: { prompt_tokens: 12, completion_tokens: 18, total_tokens: 99 } }));
    expect((await gemini()).usage).toBeNull();
  });
  it('uses the caller cancellation signal without leaking network exceptions', async () => {
    const controller = new AbortController(); controller.abort();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      expect(init?.signal?.aborted).toBe(true);
      throw new Error('AQ.synthetic-private-key');
    });
    await expect(requestTranslations('AQ.synthetic-key', AI_PROVIDERS.gemini.defaultModel, 'en', fields, controller.signal, 'gemini'))
      .rejects.toMatchObject({ code: 'cancelled', message: 'cancelled' });
  });
});
describe('OpenCode Zen raw Responses boundary', () => {
  it('uses the fixed endpoint, strict schema and raw output with no retained response', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      // Parse with the real workerd Request: mocks must not hide unsupported fetch options.
      new Request(input, init);
      return Response.json(result());
    });
    const answer = await requestTranslations('synthetic-provider-key', AI_DEFAULT_MODEL, 'en', fields);
    expect(answer.translations).toEqual([{ id: fields[0].id, text: 'Download NexGrid 2.0\nfor {name}' }]);
    expect(answer.usage).toEqual({ inputTokens: 12, outputTokens: 18, totalTokens: 30 });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://opencode.ai/zen/v1/responses');
    expect(init?.redirect).toBe('manual');
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ store: false, stream: false, max_output_tokens: 4096,
      text: { format: { type: 'json_schema', strict: true } } });
    expect(body.tools).toBeUndefined();
  });
  it('rejects redirects without making a credential-bearing follow-up request', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, {
      status: 307, headers: { location: 'https://untrusted.example/' },
    }));
    await expect(requestTranslations('synthetic-provider-key', AI_DEFAULT_MODEL, 'en', fields))
      .rejects.toMatchObject({ code: 'provider-rejected' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['refusal', () => ({ ...result(), output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] })],
    ['incomplete', () => ({ ...result(), status: 'incomplete' })],
    ['error', () => ({ ...result(), error: { message: 'synthetic-provider-key' } })],
    ['tool', () => ({ ...result(), output: [{ type: 'function_call', name: 'edit' }] })],
    ['SDK-only', () => ({ status: 'completed', output_text: JSON.stringify({ translations: [] }) })],
    ['number', () => result('下载 NexGrid 3.0\n适用于 {name}')],
    ['placeholder', () => result('下载 NexGrid 2.0\n适用于 {other}')],
    ['newline', () => result('下载 NexGrid 2.0 适用于 {name}')],
    ['brand', () => result('下载 Other 2.0\n适用于 {name}')],
    ['language', () => result('下载 NexGrid 2.0\n适用于 {name}')],
  ])('rejects %s without exposing provider content', async (_label, response) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(response()));
    await expect(requestTranslations('synthetic-provider-key', AI_DEFAULT_MODEL, 'en', fields)).rejects.toBeInstanceOf(AiError);
  });
  it.each([[], [{ id: 'other', text: '下载' }], [{ id: fields[0].id, text: '下载' }, { id: fields[0].id, text: '下载' }]].map(translations => ({ translations })))(
    'rejects missing, foreign or duplicate fields', async ({ translations }) => {
      const response = result();
      response.output[0].content[0].text = JSON.stringify({ translations });
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(response));
      await expect(requestTranslations('key', AI_DEFAULT_MODEL, 'en', fields)).rejects.toMatchObject({ code: 'invalid-result' });
    });
  it.each([[401, 'invalid-key'], [403, 'permission-denied'], [404, 'model-unavailable'], [429, 'rate-limited'], [503, 'provider-unavailable']])(
    'maps HTTP %s into a safe AI error', async (status, code) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: { message: 'synthetic-provider-key' } }, { status: Number(status), headers: { 'Retry-After': '300' } }));
      await expect(requestTranslations('key', AI_DEFAULT_MODEL, 'en', fields)).rejects.toMatchObject({ code });
    });
  it('rejects oversized bodies and source without external calls', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x'.repeat(262145)));
    await expect(requestTranslations('key', AI_DEFAULT_MODEL, 'en', fields)).rejects.toMatchObject({ code: 'response-too-large' });
    fetcher.mockClear();
    await expect(requestTranslations('key', AI_DEFAULT_MODEL, 'en', [{ id: 'x', source: 'x'.repeat(3001) }])).rejects.toMatchObject({ code: 'too-long' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('counts repeated context in the actual outbound character limit', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    await expect(requestTranslations('key', AI_DEFAULT_MODEL, 'en', [
      { id: 'a', source: 'A', context: 'x'.repeat(1600) }, { id: 'b', source: 'B', context: 'x'.repeat(1600) },
    ])).rejects.toMatchObject({ code: 'too-long' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('handles non-JSON unauthorized errors without leaking their body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('private synthetic-provider-key', { status: 401 }));
    await expect(requestTranslations('key', AI_DEFAULT_MODEL, 'en', fields)).rejects.toMatchObject({ code: 'invalid-key', message: 'invalid-key' });
  });
  it('identifies Zen billing errors even when the provider responds with HTTP 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: {
      type: 'CreditsError', message: 'No payment method: private-workspace-link',
    } }, { status: 401 }));
    await expect(requestTranslations('synthetic-provider-key', AI_DEFAULT_MODEL, 'en', fields))
      .rejects.toMatchObject({ code: 'billing-required', message: 'billing-required' });
  });
  it.each([
    ['ModelError', 'model-unavailable'],
    ['AuthError', 'invalid-key'],
  ])('uses the Zen error type to distinguish %s responses', async (type, code) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: {
      type, message: 'private provider detail',
    } }, { status: 401 }));
    await expect(requestTranslations('synthetic-provider-key', 'deepseek-v4-flash-free', 'en', fields, undefined, 'zen'))
      .rejects.toMatchObject({ code, message: code });
  });
  it('identifies an unavailable Zen upstream model without exposing the provider message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: {
      type: 'server_error', message: 'Error from provider: Model is unavailable. private-detail',
    } }, { status: 400 }));
    await expect(requestTranslations('synthetic-provider-key', 'deepseek-v4-flash-free', 'en', fields, undefined, 'zen'))
      .rejects.toMatchObject({ code: 'model-unavailable', message: 'model-unavailable' });
  });
  it('distinguishes quota exhaustion from temporary 429 and preserves retry delay', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: { code: 'insufficient_quota' } }, { status: 429 }));
    await expect(requestTranslations('key', AI_DEFAULT_MODEL, 'en', fields)).rejects.toMatchObject({ code: 'quota-exhausted', retryable: false });
    fetcher.mockResolvedValue(Response.json({ error: { code: 'rate_limit_exceeded' } }, { status: 429, headers: { 'retry-after': '360' } }));
    await expect(requestTranslations('key', AI_DEFAULT_MODEL, 'en', fields)).rejects.toMatchObject({ code: 'rate-limited', retryable: true, retryAfterMs: 360000 });
  });
  it('preserves duplicate placeholder and URL multiplicity', async () => {
    const input = [{ id: fields[0].id, source: 'Visit https://nexgrid.ai/{name} and {name}.' }];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(result('访问 https://other.example/{name}。')));
    await expect(requestTranslations('key', AI_DEFAULT_MODEL, 'en', input)).rejects.toMatchObject({ code: 'invalid-result' });
  });
  it.each([
    'GPU __クラウド__ ^2^', '[[GPU]] クラウド ^2^', '[[GPU]] __クラウド__ 2',
    '[[GPU]] __クラウド__ ^3^', '[[GPU]] __クラウド__ ^2^ [[追加]]',
    '[[GPU\nサービス]] __クラウド__ ^2^', '[[GPU] __クラウド__ ^2^',
    '[[GPU]] __クラウド__ ^2^ __', '[[GPU]] __クラウド__ ^2^ ^broken^',
  ])('rejects lost, new, or broken site annotation markers: %s', text => {
    expect(validateTranslationValue({ source: '[[GPU]] __cloud__ ^2^', maxLength: 200 }, text)).toBe('markup');
  });
  it('allows translated marker contents and reordered complete annotations', () => {
    expect(validateTranslationValue({ source: '[[GPU cloud]] and __fast computing__ ^2^', maxLength: 200 },
      '__高速計算__ と [[GPU クラウド]] ^2^')).toBeNull();
  });
  it('shared markup validation preserves every existing nonempty approved seed translation', () => {
    const rejected = enumerateTranslationFields(SiteConfigSchema.parse(seed), DRAFT_MANIFEST)
      .filter(f => f.target.trim() && validateTranslationValue(f, f.target)).map(f => `${f.fieldId}:${f.targetLocale}`);
    expect(rejected).toEqual([]);
  });
  it('provider output cannot bypass the shared annotation guard', async () => {
    const input = [{ id: fields[0].id, source: '[[GPU]] __cloud__ ^2^' }];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(result('GPU クラウド 2')));
    await expect(requestTranslations('key', AI_DEFAULT_MODEL, 'ja', input)).rejects.toMatchObject({ code: 'invalid-result' });
  });
});
