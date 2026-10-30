import { StrictMode, type ReactNode } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router';
import { vi } from 'vitest';
import { AuthProvider } from '@/lib/auth';
import { setTokens, setDeviceSession } from '@/lib/api';
import { ToastProvider } from '@/ui';

export interface MockCall {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

export type MockHandler = (call: MockCall) => { status?: number; json?: unknown } | undefined;

/** Installs a fetch mock routed by (method, path). Paths are relative to /api/v1 and include the query string. */
export function mockFetch(handler: MockHandler) {
  const calls: MockCall[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api\/v1/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const call = { method, path, body, headers };
    calls.push(call);
    const out = handler(call);
    if (!out) {
      return new Response(JSON.stringify({ type: 'about:blank', title: `No mock for ${method} ${path}`, status: 404, code: 'ROUTE_NOT_FOUND', requestId: 'test' }), { status: 404, headers: { 'content-type': 'application/problem+json' } });
    }
    const status = out.status ?? 200;
    if (status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(out.json ?? {}), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn };
}

export function problem(status: number, code: string, title = code) {
  return { status, json: { type: `urn:examos:error:${code}`, title, status, code, requestId: 'test', retryable: false } };
}

export const TENANT = { id: 't1', slug: 'demo', name: 'St. Mary’s University', timezone: 'Asia/Kolkata', ssoProvider: null as string | null };

export function signInAs(roles: string[], user = { id: 'u1', email: 'person@demo.local', fullName: 'Test Person', kind: roles.includes('STUDENT') ? 'STUDENT' : 'STAFF' }) {
  setTokens({ accessToken: 'access', refreshToken: 'refresh-token-value-long-enough', expiresIn: 600, user });
  setDeviceSession(null);
  return { userId: user.id, email: user.email, kind: user.kind, grants: roles.map((role) => ({ role, scopeType: 'TENANT', scopeId: null as string | null })), tenant: TENANT };
}

export function renderApp(routes: RouteObject[], initialPath: string): RenderResult & { router: ReturnType<typeof createMemoryRouter>; queryClient: QueryClient } {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 }, mutations: { retry: false } } });
  const router = createMemoryRouter(routes, { initialEntries: [initialPath] });
  // StrictMode on purpose: effects mount twice, which is how the real app runs in development.
  const wrapper = ({ children }: { children: ReactNode }) => (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <AuthProvider>{children}</AuthProvider>
        </ToastProvider>
      </QueryClientProvider>
    </StrictMode>
  );
  const result = render(<RouterProvider router={router} />, { wrapper });
  return { ...result, router, queryClient };
}
