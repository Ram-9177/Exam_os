import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ROLE_CODES } from '@examos/contracts';
import { createTestContext, provisionTenant, setStaffRoles, createApiKey, activationTokenFor, login, PLATFORM_KEY, type TestContext, type ProvisionedTenant } from './helpers.js';

/**
 * Route coverage and robustness sweep.
 *
 * 1. Every route registered on the real app (nested routers walked) is listed in docs/api/route-map.md,
 *    and every route-map line matches a registered route.
 * 2. Every non-public route refuses an anonymous caller with 401 — never 2xx, never 5xx.
 * 3. Every route survives garbage: empty and wrong-typed bodies, syntactically invalid and unknown
 *    uuid params, called as a student, as the most-privileged tenant staff login, with the platform
 *    key and with an all-scope ERP API key. Garbage is refused with 4xx; nothing is ever 5xx.
 */

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
interface RouteDef { method: Method; path: string }

const API_PREFIX = '/api/v1';
const METHODS = new Set<Method>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

// ---------------------------------------------------------------------------------------------
// Route enumeration (Express 4 router stack)
// ---------------------------------------------------------------------------------------------

interface Layer {
  route?: { path: string | string[]; methods: Record<string, boolean> };
  name?: string;
  handle?: { stack?: Layer[] };
  regexp?: RegExp & { fast_slash?: boolean };
}

/** Recovers the literal mount path of a `router.use('/x', subRouter)` layer from its compiled regexp. */
function mountPath(layer: Layer): string {
  const re = layer.regexp;
  if (!re || re.fast_slash) return '';
  const src = re.source
    .replace(/^\^/, '')
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '') // trailing  \/?(?=\/|$)
    .replace(/\\\//g, '/');
  if (!/^[/A-Za-z0-9._-]*$/.test(src)) throw new Error(`cannot recover mount path from ${re.source}`);
  return src === '/' ? '' : src;
}

function walk(stack: Layer[], prefix: string, out: RouteDef[]): void {
  for (const layer of stack) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const p of paths) {
        for (const [m, on] of Object.entries(layer.route.methods)) {
          const method = m.toUpperCase() as Method;
          const full = (prefix + p).replace(/\/{2,}/g, '/');
          if (on && METHODS.has(method)) out.push({ method, path: full.length > 1 ? full.replace(/\/$/, '') : full });
        }
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      walk(layer.handle.stack, prefix + mountPath(layer), out);
    }
  }
}

function enumerateRoutes(app: { _router: { stack: Layer[] } }): RouteDef[] {
  const out: RouteDef[] = [];
  walk(app._router.stack, '', out);
  const seen = new Set<string>();
  return out.filter((r) => {
    const k = `${r.method} ${r.path}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** `:anyName` → `:` so parameter names never matter when comparing. */
const shape = (p: string) => p.replace(/:[A-Za-z0-9_]+/g, ':').replace(/\/$/, '');
const relPath = (p: string) => (p.startsWith(API_PREFIX + '/') ? p.slice(API_PREFIX.length) : p);

// ---------------------------------------------------------------------------------------------
// Route map parsing: lines starting with METHOD then a path relative to /api/v1.
// ---------------------------------------------------------------------------------------------

interface DocLine { method: Method; path: string; line: number }
function parseRouteMap(text: string): DocLine[] {
  const out: DocLine[] = [];
  text.split('\n').forEach((raw, i) => {
    const m = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)/.exec(raw);
    if (!m) return;
    out.push({ method: m[1] as Method, path: m[2]!.split('?')[0]!, line: i + 1 });
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Public routes: reachable without a user bearer token. Each entry says why.
// ---------------------------------------------------------------------------------------------

const PUBLIC_ROUTES = new Set<string>([
  'GET /healthz', // liveness probe (outside /api/v1)
  'GET /api/v1/tenant', // public tenant info for the login screen (host tenant)
  'POST /api/v1/auth/login', // password login
  'POST /api/v1/auth/refresh', // refresh-token rotation (the refresh token is the credential)
  'POST /api/v1/auth/activate', // activation-mail token is the credential
  'GET /api/v1/auth/.well-known/jwks.json', // public token-verification keys
  'GET /api/v1/auth/oidc/start', // Microsoft/Google SSO start
  'POST /api/v1/auth/oidc/callback', // SSO callback (state + code are the credential)
  'GET /api/v1/student/verify/:attemptId/:version', // public result verification (QR)
  'GET /api/v1/student/verify-student/:hash', // public student ID-card verification (QR)
  'GET /api/v1/hall-tickets/verify/:hash', // public hall-ticket verification (QR), if registered
  'POST /api/v1/platform/auth/login', // super-admin password + TOTP login
]);

/**
 * Routes authenticated by something other than a user bearer token. They are not "public":
 * without their credential they must still answer 401 (asserted below like every private route).
 *   /platform/*         x-platform-key (dev/test) or a platform session token
 *   /integration/v1/*   tenant ERP API key (Authorization: ApiKey …)
 *   mail provider callbacks carry a per-tenant callback secret
 */
/**
 * Mail provider callbacks: the bearer is the tenant's callback secret, and only the body (dispatch id / recipient)
 * names the tenant whose secret to compare against. A missing bearer is 401 before validation; a present but
 * unverifiable bearer may see 400 for a malformed body, and with a well-formed body it gets 401/404 — never 2xx.
 */
const CALLBACK_SECRET_ROUTES: Record<string, unknown> = {
  'POST /api/v1/integration/v1/mail/callbacks': { dispatchId: '00000000-0000-4000-8000-000000000000', outcome: 'ACCEPTED' },
  'POST /api/v1/integration/v1/mail/bounces': { toAddress: 'nobody@nowhere.invalid', reason: 'mailbox full' },
};

const isPlatform = (p: string) => p.startsWith('/api/v1/platform/');
const isIntegration = (p: string) => p.startsWith('/api/v1/integration/');

/** Routes that take no body at all: whatever is sent is ignored, so a 2xx on garbage is correct. */
const BODY_IGNORED = new Set<string>([
  'POST /api/v1/auth/logout',
  'POST /api/v1/platform/auth/logout',
]);

const BAD_ID = 'not-a-uuid';
const WRONG_TYPED = {
  id: 12,
  code: { x: 1 },
  title: 42,
  name: [],
  email: 7,
  password: 1,
  token: false,
  reason: 9,
  items: 'many',
  events: 'x',
  rows: 3,
  roles: 'ADMIN',
  status: 99,
  decision: [],
  idempotencyKey: 5,
  clientOperationId: {},
  ops: 'x',
  blocks: 1,
  scan: 'x',
  entity: 4,
  csvContent: 12,
  mode: [],
  settings: 'x',
  policy: 'x',
  count: 'lots',
  threshold: 'high',
  attemptIds: 'x',
  studentExternalIds: 'x',
  provider: 1,
  photoDataUrl: 1,
  sections: 'x',
  questions: 'x',
};
const ARRAY_BODY = [1, 'two', { three: 3 }];
/** PostgreSQL text cannot hold U+0000; every string field carries one. */
const NUL_BODY = { title: 'a\u0000b', name: 'a\u0000b', email: 'x\u0000@y.test', reason: 'reason\u0000text', code: 'C\u0000', q: '\u0000', notes: '\u0000' };
const NUL_ID = 'a%00b';

function fill(path: string, value: () => string): string {
  return path.replace(/:[A-Za-z0-9_]+/g, () => value());
}

describe('route coverage and robustness', () => {
  let ctx: TestContext;
  let t: ProvisionedTenant;
  let routes: RouteDef[];
  let studentToken: string;
  let studentEmail: string;
  const STUDENT_PASSWORD = 'Stud3nt-Passw0rd!2026';
  let staffToken: string;
  let apiKey: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    t = await provisionTenant(ctx, 'routes');
    routes = enumerateRoutes(ctx.app.app as unknown as { _router: { stack: Layer[] } });

    // Most-privileged tenant staff login: the tenant admin holding every staff role.
    await setStaffRoles(ctx, t, t.admin.userId, ROLE_CODES.filter((r) => r !== 'STUDENT'));
    staffToken = t.admin.token;

    const email = `student-${randomUUID().slice(0, 6)}@${t.slug}.test`;
    const u = await ctx.request().post('/api/v1/tenant/users').set('Host', t.host).set('Authorization', `Bearer ${staffToken}`).send({ email, fullName: 'Route Student', kind: 'STUDENT', roles: [{ role: 'STUDENT' }] });
    if (u.status !== 201) throw new Error(`student create failed ${u.status} ${JSON.stringify(u.body)}`);
    const act = await ctx.request().post('/api/v1/auth/activate').set('Host', t.host).send({ token: await activationTokenFor(ctx, t.tenantId, email), password: STUDENT_PASSWORD });
    if (act.status !== 200) throw new Error(`student activate failed ${act.status}`);
    studentToken = act.body.accessToken;
    studentEmail = email;

    apiKey = (await createApiKey(ctx, t, ['roster:write', 'roster:read', 'results:read', 'events:read', 'webhooks:manage', 'mail:callback'])).apiKey;
  });

  afterAll(async () => {
    // The sweep hits rate-limited login routes from one address many times; later test files share this Redis
    // database, so drop the fixed-window counters this file created.
    if (ctx) {
      let cursor = '0';
      do {
        const [next, keys] = await ctx.deps.redis.scan(cursor, 'MATCH', 'rl:*', 'COUNT', 500);
        if (keys.length) await ctx.deps.redis.del(...keys);
        cursor = next;
      } while (cursor !== '0');
    }
    await ctx?.close();
  });

  /** Session-ending routes go last so they do not revoke the tokens the sweep is still using. */
  function ordered(): RouteDef[] {
    const last = (r: RouteDef) => (/\/logout$/.test(r.path) ? 1 : 0);
    return [...routes].sort((a, b) => last(a) - last(b));
  }

  function send(method: Method, url: string, headers: Record<string, string>, payload?: unknown) {
    let req = ctx.request()[method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete'](url);
    for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
    if (payload !== undefined) req = req.send(payload as object);
    return req;
  }

  it('enumerates the mounted routers', () => {
    expect(routes.length).toBeGreaterThan(100);
    // spot checks across every mount point, including routers mounted at '/' and nested ones
    for (const k of ['GET /healthz', 'POST /api/v1/platform/tenants', 'POST /api/v1/auth/login', 'GET /api/v1/exams/:id', 'PUT /api/v1/student/attempts/:attemptId/answers/:questionId', 'POST /api/v1/proctor/events', 'GET /api/v1/student/profile']) {
      expect(routes.map((r) => `${r.method} ${shape(r.path)}`)).toContain(shape(k));
    }
  });

  it('documents every route in docs/api/route-map.md and every documented route exists', () => {
    const doc = parseRouteMap(readFileSync(fileURLToPath(new URL('../../../docs/api/route-map.md', import.meta.url)), 'utf8'));
    const documented = new Set(doc.map((d) => `${d.method} ${shape(d.path)}`));
    const undocumented = routes.filter((r) => !documented.has(`${r.method} ${shape(relPath(r.path))}`)).map((r) => `${r.method} ${relPath(r.path)}`);
    const registered = new Set(routes.map((r) => `${r.method} ${shape(relPath(r.path))}`));
    const stale = doc.filter((d) => !registered.has(`${d.method} ${shape(d.path)}`)).map((d) => `line ${d.line}: ${d.method} ${d.path}`);
    expect({ undocumented, stale }).toEqual({ undocumented: [], stale: [] });
  });

  it('refuses every non-public route without credentials (401, never 2xx/5xx)', async () => {
    const failures: string[] = [];
    for (const r of ordered()) {
      const key = `${r.method} ${r.path}`;
      const url = fill(r.path, () => randomUUID());
      const payload = r.method === 'GET' || r.method === 'DELETE' ? undefined : {};
      const res = await send(r.method, url, { Host: t.host }, payload);
      if (res.status >= 500) failures.push(`${key} anonymous → ${res.status} ${res.body?.code ?? ''}`);
      if (PUBLIC_ROUTES.has(key)) continue;
      if (res.status !== 401) failures.push(`${key} anonymous → ${res.status} ${res.body?.code ?? ''} (expected 401)`);
      // A bearer token from the wrong place (garbage) is refused the same way.
      const callbackBody = CALLBACK_SECRET_ROUTES[key];
      const forged = await send(r.method, url, { Host: t.host, Authorization: 'Bearer not.a.jwt' }, callbackBody ?? payload);
      const forgedOk = forged.status === 401 || (isPlatform(r.path) && forged.status === 403) || (callbackBody !== undefined && forged.status === 404);
      if (!forgedOk) failures.push(`${key} forged token → ${forged.status} ${forged.body?.code ?? ''} (expected 401)`);
      // Unknown host: tenant resolution fails first (404) for host-tenant routes; never 2xx/5xx.
      const noTenant = await send(r.method, url, { Host: 'no-such-tenant.invalid' }, payload);
      if (noTenant.status < 400 || noTenant.status >= 500) failures.push(`${key} unknown host → ${noTenant.status}`);
    }
    expect(failures).toEqual([]);
  });

  it('a student token cannot reach platform, integration or staff-only surfaces', async () => {
    const failures: string[] = [];
    for (const r of ordered()) {
      const key = `${r.method} ${r.path}`;
      if (!isPlatform(r.path) && !isIntegration(r.path)) continue;
      if (PUBLIC_ROUTES.has(key)) continue;
      const callbackBody = CALLBACK_SECRET_ROUTES[key];
      const res = await send(r.method, fill(r.path, () => randomUUID()), { Host: t.host, Authorization: `Bearer ${studentToken}` }, callbackBody ?? (r.method === 'GET' ? undefined : {}));
      if (res.status !== 401 && res.status !== 403 && !(callbackBody !== undefined && res.status === 404)) failures.push(`${key} student → ${res.status} ${res.body?.code ?? ''}`);
    }
    expect(failures).toEqual([]);
  });

  it('never answers 5xx to garbage bodies or bad ids, whoever calls', async () => {
    // Session-ending routes get a throwaway session so the shared tokens stay valid for the rest of the file.
    const sessionFor = async (r: RouteDef, who: 'student' | 'staff') => {
      if (r.path !== '/api/v1/auth/logout') return who === 'student' ? studentToken : staffToken;
      return who === 'student' ? (await login(ctx, t.host, studentEmail, STUDENT_PASSWORD)).accessToken : (await login(ctx, t.host, t.admin.email, t.admin.password)).accessToken;
    };
    const callers: Array<{ name: string; headers: (r: RouteDef) => Promise<Record<string, string>> }> = [
      { name: 'student', headers: async (r) => ({ Host: t.host, Authorization: `Bearer ${await sessionFor(r, 'student')}` }) },
      {
        name: 'staff',
        headers: async (r): Promise<Record<string, string>> =>
          isPlatform(r.path)
            ? { 'x-platform-key': PLATFORM_KEY }
            : isIntegration(r.path)
              ? { Host: t.host, Authorization: `Bearer ${apiKey}`, 'Idempotency-Key': randomUUID() }
              : { Host: t.host, Authorization: `Bearer ${await sessionFor(r, 'staff')}` },
      },
    ];
    const failures: string[] = [];
    const accepted: string[] = [];
    for (const r of ordered()) {
      const key = `${r.method} ${r.path}`;
      const hasParams = r.path.includes(':');
      const urls = hasParams ? [fill(r.path, () => BAD_ID), fill(r.path, () => NUL_ID), fill(r.path, () => randomUUID())] : [r.path];
      const bodies: unknown[] = r.method === 'GET' || r.method === 'DELETE' ? [undefined] : [{}, WRONG_TYPED, ARRAY_BODY, NUL_BODY];
      for (const c of callers) {
        for (const url of urls) {
          for (const b of bodies) {
            const res = await send(r.method, url, await c.headers(r), b);
            const label = `${key} as ${c.name} url=${url} body=${b === undefined ? '-' : JSON.stringify(b).slice(0, 20)} → ${res.status} ${res.body?.code ?? ''}`;
            if (res.status >= 500) failures.push(label);
            // Garbage must be refused; an empty body is only acceptable where it is a complete request.
            else if (b !== undefined && res.status < 400 && !BODY_IGNORED.has(key)) accepted.push(label);
            // Syntactically invalid ids never succeed.
            else if (hasParams && (url.includes(BAD_ID) || url.includes(NUL_ID)) && res.status < 400) accepted.push(label);
          }
        }
      }
    }
    expect({ failures, accepted }).toEqual({ failures: [], accepted: [] });
  });

  it('refuses NUL characters at the edge with 400 INVALID_CHARACTERS (body, query and path)', async () => {
    const auth = { Host: t.host, Authorization: `Bearer ${staffToken}` };
    const b = await send('POST', '/api/v1/exams', auth, { code: 'X\u0000', title: 't' });
    expect([b.status, b.body.code]).toEqual([400, 'INVALID_CHARACTERS']);
    const q = await send('GET', '/api/v1/exams?q=%00', auth);
    expect([q.status, q.body.code]).toEqual([400, 'INVALID_CHARACTERS']);
    const p = await send('GET', '/api/v1/student/verify-student/ab%00cd', { Host: t.host });
    expect([p.status, p.body.code]).toEqual([400, 'INVALID_CHARACTERS']);
    // an escaped backslash followed by "u0000" is ordinary text, not a NUL
    const ok = await send('POST', '/api/v1/exams', auth, { code: 'X\\u0000' });
    expect(ok.body.code).toBe('VALIDATION_FAILED');
  });

  it('never answers 5xx to garbage query strings on GET routes', async () => {
    // the shared sessions are still live (no earlier sweep revoked them)
    expect((await send('GET', '/api/v1/auth/me', { Host: t.host, Authorization: `Bearer ${staffToken}` })).status).toBe(200);
    expect((await send('GET', '/api/v1/auth/me', { Host: t.host, Authorization: `Bearer ${studentToken}` })).status).toBe(200);
    const qs = '?examId=not-a-uuid&status=NOPE&kind=NOPE&limit=abc&q=%25%00&source=%00x&since=garbage&types=%2C%2C&examType=x&academicYear=x&semester=-1&departmentCode=x&schoolCode=x&redirectUri=x&examCode=';
    const failures: string[] = [];
    for (const r of ordered()) {
      if (r.method !== 'GET') continue;
      const url = fill(r.path, () => randomUUID()) + qs;
      const headers: Record<string, string> = isPlatform(r.path) ? { 'x-platform-key': PLATFORM_KEY } : isIntegration(r.path) ? { Host: t.host, Authorization: `Bearer ${apiKey}` } : { Host: t.host, Authorization: `Bearer ${staffToken}` };
      for (const h of [headers, { Host: t.host, Authorization: `Bearer ${studentToken}` }]) {
        const res = await send('GET', url, h);
        if (res.status >= 500) failures.push(`GET ${r.path} → ${res.status} ${res.body?.code ?? ''}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
