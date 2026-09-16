import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = require('miniflare');
const { build } = require('esbuild');
const workerRoot = fileURLToPath(new URL('.', import.meta.url));
const endpoints = {
  zen: 'https://opencode.ai/zen/v1/responses',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  openai: 'https://api.openai.com/v1/responses',
  anthropic: 'https://api.anthropic.com/v1/messages',
  deepseek: 'https://api.deepseek.com/chat/completions',
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
};

// Compile the real client, then intercept below workerd's native fetch option parsing.
// No Wrangler config, environment files, database bindings or external requests are used.
const entry = `import { requestTranslations, AI_PROVIDERS, TRANSLATION_TARGET_LOCALES } from './src/ai-client.ts';
import { SOURCE_LOCALE } from '../schema/src/locales.ts';
export default { async fetch(request) {
  try {
    const url = new URL(request.url), provider = url.pathname.slice(1);
    const target = url.searchParams.has('source') ? SOURCE_LOCALE : TRANSLATION_TARGET_LOCALES[0];
    const result = await requestTranslations('synthetic-runtime-fixture-key', AI_PROVIDERS[provider].defaultModel, target,
      [{ id: 'runtime-test', source: '欢迎使用 NexGrid。', maxLength: 120 }], undefined, provider);
    return Response.json({ ok: true, text: result.translations[0].text });
  } catch (error) {
    return Response.json({ ok: false, code: error.code ?? error.name });
  }
} };`;

for (const mode of ['success', 'redirect', 'regression-error', 'source-locale']) {
  const bundle = await build({
    stdin: { contents: entry, resolveDir: workerRoot },
    bundle: true, write: false, format: 'esm', platform: 'browser',
    plugins: mode !== 'regression-error' ? [] : [{
      name: 'restore-invalid-runtime-option',
      setup(builder) {
        builder.onLoad({ filter: /ai-client\.ts$/ }, async ({ path }) => {
          const source = await readFile(path, 'utf8');
          const option = /\bredirect\s*:\s*(['"])manual\1/g;
          assert.equal([...source.matchAll(option)].length, 1, 'The regression mutation must target exactly one fetch option.');
          return { contents: source.replace(option, "redirect: 'error'"), loader: 'ts' };
        });
      },
    }],
  });
  let calls = 0;
  let provider;
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-04-01',
    cf: false, telemetry: { enabled: false }, unsafeRegisterWorker: false,
    host: '127.0.0.1', port: 0, log: new Log(LogLevel.ERROR),
    outboundService: async (request) => {
      calls++;
      assert.equal(request.url, endpoints[provider]);
      assert.equal(request.method, 'POST');
      const body = await request.json();
      const instructions = body.instructions ?? body.system ?? body.messages?.[0]?.content;
      assert.ok(instructions.includes('from zh into en'));
      if (provider === 'anthropic') {
        assert.equal(request.headers.get('x-api-key'), 'synthetic-runtime-fixture-key');
        assert.equal(request.headers.get('anthropic-version'), '2023-06-01');
        assert.equal(request.headers.get('authorization'), null);
      } else {
        assert.equal(request.headers.get('authorization'), 'Bearer synthetic-runtime-fixture-key');
        assert.equal(request.headers.get('x-api-key'), null);
      }
      if (mode === 'redirect') return new Response(null, {
        status: 307, headers: { location: 'https://redirect.example/forbidden' },
      });
      if (provider === 'anthropic') return Response.json({ type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{
        type: 'text', text: JSON.stringify({ translations: [{ id: 'runtime-test', text: 'Welcome to NexGrid.' }] }),
      }] });
      if (provider !== 'zen' && provider !== 'openai') return Response.json({ choices: [{ finish_reason: 'stop', message: {
        role: 'assistant', content: JSON.stringify({ translations: [{ id: 'runtime-test', text: 'Welcome to NexGrid.' }] }),
      } }] });
      return Response.json({ status: 'completed', output: [{
        type: 'message', role: 'assistant', status: 'completed', content: [{
          type: 'output_text', text: JSON.stringify({ translations: [{ id: 'runtime-test', text: 'Welcome to NexGrid.' }] }),
        }],
      }] });
    },
  }));
  try {
    for (provider of Object.keys(endpoints)) {
      calls = 0;
      const response = await runtime.dispatchFetch('http://localhost/' + provider + (mode === 'source-locale' ? '?source' : ''));
      const result = await response.json();
      const expected = mode === 'success' ? { ok: true, text: 'Welcome to NexGrid.' }
        : { ok: false, code: mode === 'redirect' ? 'provider-rejected' : mode === 'source-locale' ? 'invalid-input' : 'network-error' };
      assert.deepEqual(result, expected, mode);
      assert.equal(calls, mode === 'regression-error' || mode === 'source-locale' ? 0 : 1, mode + ': native outbound call count');
      console.log(`[ai-runtime] PASS ${provider} ${mode}`);
    }
  } finally {
    await runtime.dispose();
  }
}
