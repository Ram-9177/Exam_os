import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, apiEvents, getTokens, setTokens, type TokenPair } from '@/lib/api';
import { mockFetch, problem } from './helpers';

const pair = (accessToken: string, refreshToken: string): TokenPair => ({ accessToken, refreshToken, expiresIn: 600, user: { id: 'u1', email: 'student01@demo.local', fullName: 'Student One', kind: 'STUDENT' } });

/**
 * Four hours of exam means twenty-odd access-token renewals per student. Only
 * the server saying "that refresh token is not valid" may end the session; a
 * dropped connection or a 5xx while renewing is transient, the tokens stay and
 * the save is retried — a Wi-Fi blip at the wrong second never logs anyone out.
 */
describe('session renewal during the exam', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setTokens(null);
  });

  it('keeps the session through a failing or unreachable refresh endpoint and surfaces a retryable NETWORK problem', async () => {
    setTokens(pair('old', 'r1'));
    let refresh: { status: number; json: unknown } | 'throw' = { status: 503, json: {} };
    const { calls } = mockFetch(({ path, headers }) => {
      if (path === '/auth/refresh') {
        if (refresh === 'throw') throw new TypeError('Failed to fetch');
        return refresh;
      }
      if (path === '/student/x') return headers['authorization'] === 'Bearer new' ? { json: { ok: true } } : problem(401, 'TOKEN_INVALID');
      return undefined;
    });
    const signedOut: string[] = [];
    const off = apiEvents.on('signed-out', (e) => signedOut.push(e.reason));

    await expect(api.get('/student/x', { quiet: true })).rejects.toMatchObject({ code: 'NETWORK' });
    expect(getTokens()?.refreshToken).toBe('r1');
    refresh = 'throw';
    await expect(api.get('/student/x', { quiet: true })).rejects.toMatchObject({ code: 'NETWORK' });
    expect(getTokens()?.refreshToken).toBe('r1');
    expect(signedOut).toEqual([]);

    // the network comes back: the renewal succeeds and the original request is replayed with the new token
    refresh = { status: 200, json: pair('new', 'r2') };
    await expect(api.get('/student/x', { quiet: true })).resolves.toEqual({ ok: true });
    expect(getTokens()).toMatchObject({ accessToken: 'new', refreshToken: 'r2' });
    expect(calls.filter((c) => c.path === '/auth/refresh')).toHaveLength(3);

    // only an explicit refusal ends the session
    setTokens(pair('old', 'r1'));
    refresh = problem(401, 'SESSION_REVOKED');
    await expect(api.get('/student/x', { quiet: true })).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
    expect(getTokens()).toBeNull();
    expect(signedOut[0]).toBe('refresh-failed');
    off();
  });

  it('many requests that expire together share one renewal', async () => {
    setTokens(pair('old', 'r1'));
    const { calls } = mockFetch(({ path, headers }) => {
      if (path === '/auth/refresh') return { status: 200, json: pair('new', 'r2') };
      if (path.startsWith('/student/q')) return headers['authorization'] === 'Bearer new' ? { json: { ok: path } } : problem(401, 'TOKEN_INVALID');
      return undefined;
    });
    const out = await Promise.all(['/student/q1', '/student/q2', '/student/q3', '/student/q4'].map((p) => api.get<{ ok: string }>(p, { quiet: true })));
    expect(out.map((o) => o.ok)).toEqual(['/student/q1', '/student/q2', '/student/q3', '/student/q4']);
    expect(calls.filter((c) => c.path === '/auth/refresh')).toHaveLength(1);
  });
});
