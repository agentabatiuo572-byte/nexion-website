// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ api: vi.fn(), advanceAuthGeneration: vi.fn() }));
vi.mock('../src/api', () => {
  class ApiError extends Error {
    constructor(public status: number, public body: Record<string, unknown>) { super(String(status)); }
  }
  return { ApiError, api: mocks.api, advanceAuthGeneration: mocks.advanceAuthGeneration };
});

import { ApiError } from '../src/api';
import Login from '../src/pages/login';

function mount() {
  return render(<MemoryRouter initialEntries={['/login?back=/content']}><Routes>
    <Route path="/login" element={<Login />} />
    <Route path="/content" element={<p>已回到原页面</p>} />
  </Routes></MemoryRouter>);
}

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('login form', () => {
  it('reveals the password without submitting, then authenticates and returns to the requested page', async () => {
    mocks.api.mockResolvedValue({});
    mount();
    const password = screen.getByLabelText('管理员口令') as HTMLInputElement;
    fireEvent.change(password, { target: { value: 'correct-password' } });
    fireEvent.click(screen.getByRole('button', { name: '显示口令' }));
    expect(password.type).toBe('text');
    expect(password.value).toBe('correct-password');
    expect(mocks.api).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '隐藏口令' }));
    expect(password.type).toBe('password');
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByText('已回到原页面')).toBeTruthy();
    expect(mocks.api).toHaveBeenCalledWith('/api/auth/login', {
      method: 'POST', body: JSON.stringify({ password: 'correct-password' }),
    });
    expect(mocks.advanceAuthGeneration).toHaveBeenCalledTimes(1);
  });

  it('keeps the failed password editable and presents its error to assistive technology', async () => {
    mocks.api.mockRejectedValue(new ApiError(401, {}));
    mount();
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    expect((await screen.findByRole('alert')).textContent).toContain('管理员口令不正确');
    expect(screen.getByLabelText('管理员口令').getAttribute('aria-describedby')).toBe('login-error');
    expect(mocks.advanceAuthGeneration).not.toHaveBeenCalled();
  });

  it('blocks button and form submission during the server lockout', async () => {
    mocks.api.mockRejectedValue(new ApiError(429, { retryAfterSec: 900 }));
    mount();
    const button = screen.getByRole('button', { name: '登录' }) as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(true));
    expect((await screen.findByRole('alert')).textContent).toContain('尝试过多');
    fireEvent.submit(button.closest('form')!);
    expect(mocks.api).toHaveBeenCalledTimes(1);
    expect(mocks.advanceAuthGeneration).not.toHaveBeenCalled();
  });
});
