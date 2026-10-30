import type { Problem } from '@examos/contracts';
import { sebHeaders } from './seb';
import { Emitter } from './events';

export const API_BASE = '/api/v1';

/** A dead socket must surface as a NETWORK failure (and be retried), never as a request that hangs for the rest of the exam. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export function timeoutSignal(ms: number): AbortSignal | undefined {
  try {
    return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined;
  } catch {
    return undefined;
  }
}

/** An RFC 7807 problem returned by the API, as a throwable. */
export class ApiError extends Error {
  readonly problem: Problem;
  constructor(problem: Problem) {
    super(problem.title);
    this.name = 'ApiError';
    this.problem = problem;
  }
  get code(): string {
    return this.problem.code;
  }
  get status(): number {
    return this.problem.status;
  }
}

export function isApiError(e: unknown, code?: string): e is ApiError {
  return e instanceof ApiError && (code === undefined || e.code === code);
}

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  kind: string;
}
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: SessionUser;
}

/**
 * Token store: memory first, mirrored to sessionStorage so a reload inside the
 * exam client survives. Never localStorage — it outlives the exam tab.
 */
const SESSION_KEY = 'examos.session';
const DEVICE_KEY = 'examos.device-session';

let tokens: TokenPair | null = null;
let deviceSession: string | null = null;
let hydrated = false;

function storage(): Storage | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    return null;
  }
}

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  const s = storage();
  if (!s) return;
  try {
    const raw = s.getItem(SESSION_KEY);
    if (raw) tokens = JSON.parse(raw) as TokenPair;
    deviceSession = s.getItem(DEVICE_KEY);
  } catch {
    tokens = null;
  }
}

export function getTokens(): TokenPair | null {
  hydrate();
  return tokens;
}

export function setTokens(pair: TokenPair | null): void {
  hydrate();
  tokens = pair;
  const s = storage();
  if (!s) return;
  if (pair) s.setItem(SESSION_KEY, JSON.stringify(pair));
  else s.removeItem(SESSION_KEY);
}

export function getDeviceSession(): string | null {
  hydrate();
  return deviceSession;
}

/** Set after admit/reconnect; every student exam request carries it as x-device-session. */
export function setDeviceSession(id: string | null): void {
  hydrate();
  deviceSession = id;
  const s = storage();
  if (!s) return;
  if (id) s.setItem(DEVICE_KEY, id);
  else s.removeItem(DEVICE_KEY);
}

export interface ApiEvents extends Record<string, unknown> {
  problem: Problem;
  'signed-out': { reason: string };
}
export const apiEvents = new Emitter<ApiEvents>();

export interface RequestOptions {
  body?: unknown;
  /** Send the bearer token (default true). */
  auth?: boolean;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Problem codes that are expected by the caller and must not be surfaced as toasts; `true` silences all. */
  quiet?: true | readonly string[];
}

/**
 * One refresh at a time for the whole tab (many requests can 401 together when
 * the access token expires). Only the server saying "this refresh token is not
 * valid" (401/403) ends the session; a dropped connection, a proxy error or a
 * rate limit during a four-hour exam is transient — tokens are kept and the
 * caller retries, so a Wi-Fi blip at the wrong second never logs a student out.
 */
type RefreshOutcome = 'ok' | 'denied' | 'transient';
let refreshInFlight: Promise<RefreshOutcome> | null = null;

async function refreshOnce(): Promise<RefreshOutcome> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async (): Promise<RefreshOutcome> => {
    const current = getTokens();
    if (!current) return 'denied';
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      });
      if (res.status === 401 || res.status === 403) {
        setTokens(null);
        apiEvents.emit('signed-out', { reason: 'refresh-failed' });
        return 'denied';
      }
      if (!res.ok) return 'transient';
      setTokens((await res.json()) as TokenPair);
      return 'ok';
    } catch {
      return 'transient';
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

async function toProblem(res: Response): Promise<Problem> {
  const fallback: Problem = { type: 'about:blank', title: res.statusText || 'Request failed', status: res.status, code: `HTTP_${res.status}`, requestId: '', retryable: false };
  try {
    const text = await res.text();
    if (!text) return fallback;
    const parsed = JSON.parse(text) as Partial<Problem>;
    return { ...fallback, ...parsed, code: parsed.code ?? fallback.code, title: parsed.title ?? fallback.title, status: parsed.status ?? res.status };
  } catch {
    return fallback;
  }
}

export async function request<T>(method: string, path: string, opts: RequestOptions = {}, _retried = false): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json', ...sebHeaders(), ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const auth = opts.auth ?? true;
  const t = getTokens();
  if (auth && t) headers['authorization'] = `Bearer ${t.accessToken}`;
  const ds = getDeviceSession();
  if (ds) headers['x-device-session'] = ds;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), signal: opts.signal ?? timeoutSignal(DEFAULT_REQUEST_TIMEOUT_MS) });
  } catch (e) {
    const problem: Problem = { type: 'urn:examos:error:NETWORK', title: 'Could not reach the server', status: 0, code: 'NETWORK', requestId: '', retryable: true };
    if (opts.quiet !== true && !(Array.isArray(opts.quiet) && opts.quiet.includes('NETWORK'))) apiEvents.emit('problem', problem);
    throw Object.assign(new ApiError(problem), { cause: e });
  }

  if (res.ok) {
    if (res.status === 204 || res.headers.get('content-length') === '0') return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  const problem = await toProblem(res);
  if (res.status === 401 && auth) {
    if (problem.code === 'TOKEN_INVALID' && !_retried && t) {
      const outcome = await refreshOnce();
      if (outcome === 'ok') return request<T>(method, path, opts, true);
      if (outcome === 'transient') {
        // Session still valid as far as we know; report it like a network failure so drafts are kept and retried.
        const transient: Problem = { type: 'urn:examos:error:NETWORK', title: 'Could not renew the session; will retry', status: 0, code: 'NETWORK', requestId: problem.requestId, retryable: true };
        if (opts.quiet !== true && !(Array.isArray(opts.quiet) && opts.quiet.includes('NETWORK'))) apiEvents.emit('problem', transient);
        throw new ApiError(transient);
      }
    }
    if (problem.code === 'SESSION_REVOKED' || problem.code === 'TOKEN_INVALID' || problem.code === 'TENANT_MISMATCH') {
      setTokens(null);
      apiEvents.emit('signed-out', { reason: problem.code });
    }
  }
  const silenced = opts.quiet === true || (Array.isArray(opts.quiet) && opts.quiet.includes(problem.code));
  if (!silenced) apiEvents.emit('problem', problem);
  throw new ApiError(problem);
}

export async function downloadBlob(path: string, fallbackFilename: string, opts: RequestOptions = {}): Promise<void> {
  const headers: Record<string, string> = { ...sebHeaders(), ...(opts.headers ?? {}) };
  const auth = opts.auth ?? true;
  const t = getTokens();
  if (auth && t) headers['authorization'] = `Bearer ${t.accessToken}`;
  const ds = getDeviceSession();
  if (ds) headers['x-device-session'] = ds;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { method: 'GET', headers, signal: opts.signal });
  } catch (e) {
    const problem: Problem = { type: 'urn:examos:error:NETWORK', title: 'Could not reach the server', status: 0, code: 'NETWORK', requestId: '', retryable: true };
    if (opts.quiet !== true && !(Array.isArray(opts.quiet) && opts.quiet.includes('NETWORK'))) apiEvents.emit('problem', problem);
    throw Object.assign(new ApiError(problem), { cause: e });
  }

  if (!res.ok) {
    const problem = await toProblem(res);
    const silenced = opts.quiet === true || (Array.isArray(opts.quiet) && opts.quiet.includes(problem.code));
    if (!silenced) apiEvents.emit('problem', problem);
    throw new ApiError(problem);
  }

  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition');
  let filename = fallbackFilename;
  if (disposition) {
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
    if (match && match[1]) filename = decodeURIComponent(match[1]);
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>('GET', path, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('POST', path, { ...opts, body: body ?? {} }),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PUT', path, { ...opts, body: body ?? {} }),
  del: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('DELETE', path, { ...opts, ...(body !== undefined ? { body } : {}) }),
  download: (path: string, fallbackFilename: string, opts?: RequestOptions) => downloadBlob(path, fallbackFilename, opts),
};
