// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ api: vi.fn(), reload: vi.fn() }));
vi.mock('../src/api', () => ({ api: mocks.api, ApiError: class extends Error {} }));
vi.mock('../src/shell', () => ({ useShell: () => ({ reload: mocks.reload }), useUnsavedChanges: () => {} }));
import AiPage, { type AiConnectionView } from '../src/pages/ai';

const fixture = (): AiConnectionView => ({ provider: 'zen', model: 'deepseek-v4-flash-free', allowedModels: ['deepseek-v4-flash-free', 'gpt-5.4-mini', 'gpt-5.4-nano'], configured: true,
  providers: [
    { id: 'zen', name: 'OpenCode Zen', defaultModel: 'deepseek-v4-flash-free', allowedModels: ['deepseek-v4-flash-free', 'gpt-5.4-mini', 'gpt-5.4-nano'] },
    { id: 'gemini', name: 'Google Gemini', defaultModel: 'gemini-3.5-flash-lite', allowedModels: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'] },
    { id: 'openai', name: 'OpenAI', defaultModel: 'gpt-5.4-mini', allowedModels: ['gpt-5.4-mini', 'gpt-5.4-nano'] },
    { id: 'anthropic', name: 'Anthropic Claude', defaultModel: 'claude-haiku-4-5-20251001', allowedModels: ['claude-haiku-4-5-20251001'] },
    { id: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-v4-flash', allowedModels: ['deepseek-v4-flash'] },
    { id: 'groq', name: 'Groq', defaultModel: 'openai/gpt-oss-20b', allowedModels: ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'] },
    { id: 'openrouter', name: 'OpenRouter', defaultModel: 'openai/gpt-5.4-mini', allowedModels: ['openai/gpt-5.4-mini'] },
    { id: 'nvidia', name: 'NVIDIA NIM', defaultModel: 'mistralai/mistral-nemotron', allowedModels: ['mistralai/mistral-nemotron'] },
  ],
  encryptionReady: true, credentialRev: 4, activeRevision: 4, settingsRev: 6, executionRev: 6, enabled: false, status: 'available', ready: true,
  operationSeq: 7, operationId: null, operationStatus: 'idle', operationError: null, lastTestAt: null, busy: false, dailyCharacterLimit: 20000,
  usage: { day: '2026-09-09', sentCharacters: 120, calls: 2, inputTokens: 50, outputTokens: 30, unknownCalls: 0 } });
let connection: AiConnectionView;
beforeEach(() => { connection = fixture(); mocks.api.mockImplementation(async (_path: string, init?: RequestInit) => { if (init?.method) throw new Error('unexpected mutation'); return connection; }); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const mount = () => render(<MemoryRouter><AiPage /></MemoryRouter>);

it('opens translation tasks when linked from publish readiness', () => {
  const { container } = render(<MemoryRouter initialEntries={['/ai#translation-tasks']}><AiPage /></MemoryRouter>);
  expect((container.querySelector('#translation-tasks') as HTMLDetailsElement).open).toBe(true);
});

it('reads state without testing and clears a submitted key while preserving a failed replacement', async () => {
  mount(); await screen.findByLabelText('OpenCode Zen API Key');
  expect(mocks.api.mock.calls.every((call) => !call[1]?.method)).toBe(true);
  let reject!: (error: Error) => void;
  mocks.api.mockImplementationOnce((_path: string, init: RequestInit) => {
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toMatchObject({ provider: 'zen', expectedCredentialRev: 4, expectedOperationSeq: 7, apiKey: 'synthetic-test-value' });
    return new Promise((_resolve, fail) => { reject = fail; });
  });
  fireEvent.change(screen.getByLabelText('OpenCode Zen API Key'), { target: { value: 'synthetic-test-value' } });
  fireEvent.click(screen.getByRole('button', { name: '测试并保存' }));
  expect((screen.getByLabelText('OpenCode Zen API Key') as HTMLInputElement).value).toBe('');
  await act(async () => reject(new Error('mock connection rejected')));
  expect(screen.getByText('已保存连接 · 修订 4')).toBeTruthy();
  expect(mocks.api.mock.calls.filter((call) => call[1]?.method === 'PUT')).toHaveLength(1);
  expect(screen.queryByDisplayValue('synthetic-test-value')).toBeNull();
});

it('shows a non-secret mask for a saved key without treating it as replacement input', async () => {
  mount();
  const keyField = await screen.findByLabelText('OpenCode Zen API Key') as HTMLInputElement;
  expect(keyField.value).toBe('');
  expect(keyField.placeholder).toMatch(/^•{8,}$/u);
  expect(keyField.classList.contains('ai-key-field')).toBe(true);
  expect(keyField.getAttribute('aria-describedby')).toBe('ai-key-help');
  expect(document.getElementById('ai-key-help')?.textContent).toContain('真实密钥不会回显');
  expect((screen.getByRole('button', { name: '测试并保存' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByDisplayValue(/^•+$/u)).toBeNull();
});

it('shows bounded scan recovery after enable and guards a pending budget edit', async () => {
  mount(); await screen.findByLabelText('自动补译缺项');
  mocks.api.mockImplementationOnce(async (path: string, init: RequestInit) => {
    expect(path).toBe('/api/ai/settings');
    expect(JSON.parse(String(init.body))).toEqual({ expectedSettingsRev: 6, enabled: true });
    return { ...connection, enabled: true, scanStatus: 'retry', settingsRev: 7 };
  });
  fireEvent.click(screen.getByLabelText('自动补译缺项'));
  expect(await screen.findByText('已启用，首批待办未建立；请在下方按语种建立补译批次。')).toBeTruthy();
  fireEvent.click(screen.getByText('高级：按语种补译与任务'));
  expect(screen.getByText('正在读取各语种待办…')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('每日发送字符上限'), { target: { value: '30000' } });
  expect((screen.getByLabelText('自动补译缺项') as HTMLInputElement).disabled).toBe(true);
  mocks.api.mockImplementationOnce(async (_path: string, init: RequestInit) => {
    expect(JSON.parse(String(init.body))).toEqual({ expectedSettingsRev: 7, dailyCharacterLimit: 30000 });
    return { ...connection, enabled: true, settingsRev: 8, dailyCharacterLimit: 30000 };
  });
  fireEvent.click(screen.getByRole('button', { name: '保存用量上限' }));
  await waitFor(() => expect((screen.getByLabelText('自动补译缺项') as HTMLInputElement).disabled).toBe(false));
});

it('requires explicit remove confirmation and keeps usage visible', async () => {
  mount(); await screen.findByLabelText('OpenCode Zen API Key');
  fireEvent.click(screen.getByRole('button', { name: '移除配置', exact: true }));
  expect(mocks.api.mock.calls.filter((call) => call[1]?.method)).toHaveLength(0);
  mocks.api.mockImplementationOnce(async (_path: string, init: RequestInit) => {
    expect(init.method).toBe('DELETE'); expect(JSON.parse(String(init.body))).toEqual({ expectedCredentialRev: 4 });
    return { ...connection, configured: false, ready: false, status: 'unconfigured', credentialRev: 5 };
  });
  fireEvent.click(screen.getByRole('button', { name: '确认移除配置' }));
  expect(await screen.findByText('尚未保存 API Key')).toBeTruthy();
  expect(screen.getByText(/已发送 120 字符 · 2 次调用/)).toBeTruthy();
});

it('clears keys across provider changes and saves only the selected provider and model', async () => {
  mount(); await screen.findByLabelText('OpenCode Zen API Key');
  fireEvent.change(screen.getByLabelText('OpenCode Zen API Key'), { target: { value: 'synthetic-zen-key' } });
  fireEvent.change(screen.getByLabelText('AI 服务商'), { target: { value: 'gemini' } });
  expect((screen.getByLabelText('Google Gemini API Key') as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('Google Gemini API Key') as HTMLInputElement).placeholder).toBe('输入 API Key');
  expect((screen.getByLabelText('翻译模型') as HTMLSelectElement).value).toBe('gemini-3.5-flash-lite');
  expect(screen.queryByRole('option', { name: 'gpt-5.4-mini' })).toBeNull();
  expect((screen.getByRole('button', { name: '测试并保存' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Google Gemini API Key'), { target: { value: 'AQ.synthetic-gemini-key' } });
  mocks.api.mockImplementationOnce(async (_path: string, init: RequestInit) => {
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toMatchObject({ provider: 'gemini', model: 'gemini-3.5-flash-lite', apiKey: 'AQ.synthetic-gemini-key', expectedCredentialRev: 4, expectedOperationSeq: 7 });
    return { ...connection, provider: 'gemini', model: 'gemini-3.5-flash-lite', credentialRev: 5, operationStatus: 'succeeded' };
  });
  fireEvent.click(screen.getByRole('button', { name: '测试并保存' }));
  await screen.findByText('连接已测试并保存，可以使用输入框旁的 AI 翻译。');
  expect(screen.getByText('当前连接：Google Gemini · gemini-3.5-flash-lite')).toBeTruthy();
  expect((screen.getByLabelText('Google Gemini API Key') as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('Google Gemini API Key') as HTMLInputElement).placeholder).toMatch(/^•{8,}$/u);
});

it('keeps the existing saved provider visible after a failed Gemini replacement', async () => {
  mount(); await screen.findByLabelText('AI 服务商');
  fireEvent.change(screen.getByLabelText('AI 服务商'), { target: { value: 'gemini' } });
  fireEvent.change(screen.getByLabelText('Google Gemini API Key'), { target: { value: 'AQ.synthetic-gemini-key' } });
  mocks.api.mockRejectedValueOnce(new Error('mock rejected'));
  fireEvent.click(screen.getByRole('button', { name: '测试并保存' }));
  await screen.findByRole('alert');
  expect(screen.getByText('当前连接：OpenCode Zen · deepseek-v4-flash-free')).toBeTruthy();
  expect((screen.getByLabelText('Google Gemini API Key') as HTMLInputElement).value).toBe('');
  expect(mocks.api.mock.calls.filter(call => call[1]?.method === 'PUT')).toHaveLength(1);
});

it('selects the allowed Gemini model when the configured default is excluded', async () => {
  connection.providers[1].allowedModels = ['gemini-3.1-flash-lite'];
  mount(); await screen.findByLabelText('AI 服务商');
  fireEvent.change(screen.getByLabelText('AI 服务商'), { target: { value: 'gemini' } });
  fireEvent.change(screen.getByLabelText('Google Gemini API Key'), { target: { value: 'AQ.synthetic-gemini-key' } });
  expect((screen.getByRole('button', { name: '测试并保存' }) as HTMLButtonElement).disabled).toBe(false);
  mocks.api.mockImplementationOnce(async (_path: string, init: RequestInit) => {
    expect(JSON.parse(String(init.body))).toMatchObject({ provider: 'gemini', model: 'gemini-3.1-flash-lite' });
    return { ...connection, provider: 'gemini', model: 'gemini-3.1-flash-lite', credentialRev: 5 };
  });
  fireEvent.click(screen.getByRole('button', { name: '测试并保存' }));
  await screen.findByText('当前连接：Google Gemini · gemini-3.1-flash-lite');
});

it('shows a saved Zen configuration separately from an unavailable model', async () => {
  connection = { ...fixture(), provider: 'groq', model: 'openai/gpt-oss-20b', allowedModels: ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'] };
  mount(); await screen.findByLabelText('AI 服务商');
  fireEvent.change(screen.getByLabelText('AI 服务商'), { target: { value: 'zen' } });
  fireEvent.change(screen.getByLabelText('OpenCode Zen API Key'), { target: { value: 'synthetic-zen-key' } });
  mocks.api.mockImplementationOnce(async () => ({ ...fixture(), status: 'model-unavailable', ready: false, saved: true,
    credentialRev: 5, operationStatus: 'failed', operationError: 'model-unavailable' }));
  fireEvent.click(screen.getByRole('button', { name: '测试并保存' }));
  expect(await screen.findByText('连接配置已保存；所选模型当前不可用，AI 翻译保持关闭。')).toBeTruthy();
  expect(screen.getByText('当前连接：OpenCode Zen · deepseek-v4-flash-free')).toBeTruthy();
  expect(screen.getByText('模型不可用')).toBeTruthy();
  expect((screen.getByLabelText('OpenCode Zen API Key') as HTMLInputElement).placeholder).toMatch(/^•{8,}$/u);
});

it('repairs a stored model excluded by the allowlist without switching providers', async () => {
  connection.provider = 'gemini'; connection.model = 'gemini-3.5-flash-lite';
  connection.allowedModels = ['gemini-3.1-flash-lite']; connection.providers[1].allowedModels = connection.allowedModels;
  mount(); await screen.findByLabelText('Google Gemini API Key');
  expect((screen.getByLabelText('翻译模型') as HTMLSelectElement).value).toBe('gemini-3.1-flash-lite');
  fireEvent.change(screen.getByLabelText('Google Gemini API Key'), { target: { value: 'AQ.synthetic-gemini-key' } });
  expect((screen.getByRole('button', { name: '测试并保存' }) as HTMLButtonElement).disabled).toBe(false);
  mocks.api.mockImplementationOnce(async (_path: string, init: RequestInit) => {
    expect(JSON.parse(String(init.body))).toMatchObject({ provider: 'gemini', model: 'gemini-3.1-flash-lite' });
    return { ...connection, model: 'gemini-3.1-flash-lite', credentialRev: 5 };
  });
  fireEvent.click(screen.getByRole('button', { name: '测试并保存' }));
  await screen.findByText('当前连接：Google Gemini · gemini-3.1-flash-lite');
});

it.each(fixture().providers.slice(2))('routes a selected $name credential to its own provider and model', async selected => {
  mount(); await screen.findByLabelText('AI 服务商');
  fireEvent.change(screen.getByLabelText('OpenCode Zen API Key'), { target: { value: 'synthetic-previous-secret' } });
  fireEvent.change(screen.getByLabelText('AI 服务商'), { target: { value: selected.id } });
  const keyField = screen.getByLabelText(selected.name + ' API Key') as HTMLInputElement;
  expect(keyField.value).toBe('');
  fireEvent.change(keyField, { target: { value: 'synthetic-' + selected.id + '-key' } });
  mocks.api.mockImplementationOnce(async (_path: string, init: RequestInit) => {
    expect(JSON.parse(String(init.body))).toMatchObject({ provider: selected.id, model: selected.defaultModel, apiKey: 'synthetic-' + selected.id + '-key' });
    return { ...connection, provider: selected.id, model: selected.defaultModel, credentialRev: 5 };
  });
  fireEvent.click(screen.getByRole('button', { name: '测试并保存' }));
  await screen.findByText('当前连接：' + selected.name + ' · ' + selected.defaultModel);
  expect(keyField.value).toBe('');
});
