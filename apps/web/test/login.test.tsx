import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginPage } from '@/features/auth/LoginPage';
import { getTokens, setTokens } from '@/lib/api';
import { mockFetch, problem, renderApp, TENANT } from './helpers';

describe('LoginPage', () => {
  it('shows the tenant, offers Microsoft sign-in when SSO is configured, and explains a wrong password', async () => {
    setTokens(null);
    const { calls } = mockFetch(({ method, path, body }) => {
      if (method === 'GET' && path === '/tenant') return { json: { ...TENANT, ssoProvider: 'entra' } };
      if (method === 'POST' && path === '/auth/login') {
        const b = body as { email: string; password: string };
        if (b.password === 'Demo-Student!2026') return { json: { accessToken: 'a', refreshToken: 'r'.repeat(30), expiresIn: 600, user: { id: 'u1', email: b.email, fullName: 'Student One', kind: 'STUDENT' } } };
        return problem(401, 'INVALID_CREDENTIALS', 'Invalid e-mail or password');
      }
      if (method === 'GET' && path === '/auth/me') return { json: { userId: 'u1', email: 'student01@demo.local', kind: 'STUDENT', grants: [{ role: 'STUDENT', scopeType: 'TENANT', scopeId: null }], tenant: TENANT } };
      if (method === 'GET' && path === '/auth/oidc/start?redirectUri=http%3A%2F%2Flocalhost%3A3000%2Fauth%2Fcallback') return { json: { authorizationUrl: 'https://login.example/authorize', state: 's1' } };
      return undefined;
    });
    renderApp([{ path: '/login', element: <LoginPage /> }, { path: '/student', element: <h1>My exams</h1> }], '/login');

    expect(await screen.findByText('St. Mary’s University')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Sign in with Microsoft' })).toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('E-mail'), 'student01@demo.local');
    await user.type(screen.getByLabelText('Password'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The e-mail or password is not right.');
    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true');

    await user.clear(screen.getByLabelText('Password'));
    await user.type(screen.getByLabelText('Password'), 'Demo-Student!2026');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'My exams' })).toBeInTheDocument();
    expect(getTokens()?.accessToken).toBe('a');
    const login = calls.find((c) => c.path === '/auth/login');
    expect(login?.headers['authorization']).toBeUndefined();
    expect(calls.some((c) => c.path === '/auth/me' && c.headers['authorization'] === 'Bearer a')).toBe(true);
  });

  it('hides the SSO button when the tenant has no provider', async () => {
    setTokens(null);
    mockFetch(({ method, path }) => (method === 'GET' && path === '/tenant' ? { json: TENANT } : undefined));
    renderApp([{ path: '/login', element: <LoginPage /> }], '/login');
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: /Sign in with/ })).not.toBeInTheDocument());
  });

  it('refreshes once on TOKEN_INVALID and retries the original request', async () => {
    setTokens({ accessToken: 'stale', refreshToken: 'refresh-token-value-long-enough', expiresIn: 600, user: { id: 'u1', email: 'x@demo.local', fullName: 'X', kind: 'STUDENT' } });
    const { calls } = mockFetch(({ method, path, headers }) => {
      if (method === 'GET' && path === '/tenant') return { json: TENANT };
      if (method === 'GET' && path === '/auth/me') {
        if (headers['authorization'] === 'Bearer stale') return problem(401, 'TOKEN_INVALID');
        return { json: { userId: 'u1', email: 'x@demo.local', kind: 'STUDENT', grants: [{ role: 'STUDENT', scopeType: 'TENANT', scopeId: null }], tenant: TENANT } };
      }
      if (method === 'POST' && path === '/auth/refresh') return { json: { accessToken: 'fresh', refreshToken: 'another-refresh-token-value', expiresIn: 600, user: { id: 'u1', email: 'x@demo.local', fullName: 'X', kind: 'STUDENT' } } };
      return undefined;
    });
    renderApp([{ path: '/login', element: <LoginPage /> }, { path: '/student', element: <h1>My exams</h1> }], '/login');
    expect(await screen.findByRole('heading', { name: 'My exams' })).toBeInTheDocument();
    expect(calls.filter((c) => c.path === '/auth/refresh')).toHaveLength(1);
    expect(getTokens()?.accessToken).toBe('fresh');
    vi.unstubAllGlobals();
  });
});
