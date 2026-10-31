// Smoke test against a RUNNING ExamOS (after a deploy, before an exam, or locally after `npm run demo`).
//
//   npm run smoke                                   # demo defaults: API http://127.0.0.1:4000, tenant host localhost
//   SMOKE_BASE_URL=https://cs.exam.smru.edu.in SMOKE_HOST=cs.exam.smru.edu.in SMOKE_STUDENT=... SMOKE_STAFF_PASSWORD=... npm run smoke
//
// Read-mostly: it signs in once per role, opens the screens each role lives on, checks refusals and the error shape,
// rotates one refresh token and replays it (which, by design, ends that one student session), and measures latency.
// It never creates, changes or deletes exam data. Exit code 1 on any failure.
import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';

const BASE = (process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');
const HOST = process.env.SMOKE_HOST ?? 'localhost';
const STAFF_PW = process.env.SMOKE_STAFF_PASSWORD ?? 'Demo-Staff!2026';
const ADMIN_PW = process.env.SMOKE_ADMIN_PASSWORD ?? 'Demo-Admin!2026';
const STUDENT_PW = process.env.SMOKE_STUDENT_PASSWORD ?? 'Demo-Student!2026';
const ACCOUNTS = {
  admin: [process.env.SMOKE_ADMIN ?? 'admin@demo.local', ADMIN_PW],
  examcell: [process.env.SMOKE_EXAMCELL ?? 'examcell@demo.local', STAFF_PW],
  chief: [process.env.SMOKE_CHIEF ?? 'chief@demo.local', STAFF_PW],
  evaluator: [process.env.SMOKE_EVALUATOR ?? 'evaluator@demo.local', STAFF_PW],
  student: [process.env.SMOKE_STUDENT ?? 'student01@demo.local', STUDENT_PW],
};
const SLOW_MS = Number(process.env.SMOKE_SLOW_MS ?? 2000);

// Node's fetch drops the Host header; the tenant is resolved from it, so use http(s).request directly.
function call(method, path, { token, body, headers = {} } = {}) {
  const u = new URL(`${BASE}${path}`);
  const lib = u.protocol === 'https:' ? https : http;
  const h = { Host: HOST, accept: 'application/json', ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  if (payload) h['content-type'] = 'application/json';
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    const rq = lib.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: h, timeout: 15_000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, json, ms: performance.now() - t0 });
      });
    });
    rq.on('timeout', () => rq.destroy(new Error('timeout')));
    rq.on('error', reject);
    if (payload) rq.write(payload);
    rq.end();
  });
}

const rows = [];
const latencies = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    rows.push({ ok: true, name, detail: detail ?? '' });
  } catch (e) {
    rows.push({ ok: false, name, detail: e instanceof Error ? e.message : String(e) });
  }
}
function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}
async function get(path, token, want = 200) {
  const r = await call('GET', path, { token });
  latencies.push(r.ms);
  expect(r.status === want, `${path} → ${r.status}${r.json?.code ? ` ${r.json.code}` : ''} (wanted ${want})`);
  return r;
}

const tokens = {};
await check('API is up (GET /healthz)', async () => {
  const r = await call('GET', '/healthz');
  expect(r.status === 200, `status ${r.status}`);
  return `${Math.round(r.ms)} ms`;
});
await check('tenant resolves from the host', async () => {
  const r = await get('/api/v1/tenant');
  expect(r.json?.name && r.json?.timezone, 'no tenant name/timezone');
  return `${r.json.name} · ${r.json.timezone}`;
});
await check('unknown host is refused', async () => {
  const r = await call('GET', '/api/v1/tenant', { headers: { Host: `nope-${randomUUID().slice(0, 8)}.invalid` } });
  expect(r.status === 404, `status ${r.status}`);
});
await check('JWKS publishes the RS256 verification key', async () => {
  const r = await get('/api/v1/auth/.well-known/jwks.json');
  expect(Array.isArray(r.json?.keys) && r.json.keys.length > 0 && r.json.keys.every((k) => !('d' in k)), 'no public keys (or a private part leaked)');
  return `${r.json.keys.length} key(s)`;
});
for (const [role, [email, password]] of Object.entries(ACCOUNTS)) {
  await check(`${role} signs in`, async () => {
    const r = await call('POST', '/api/v1/auth/login', { body: { email, password } });
    latencies.push(r.ms);
    expect(r.status === 200 && r.json?.accessToken && r.json?.refreshToken, `status ${r.status} ${r.json?.code ?? ''}`);
    expect(!JSON.stringify(r.json).includes('passwordHash'), 'login response carries a password hash');
    tokens[role] = r.json;
    return `${email} (${r.json.user?.kind})`;
  });
}
const T = (role) => tokens[role]?.accessToken;

await check('every role sees its own screen', async () => {
  const out = [];
  if (T('student')) out.push(`student exams ${(await get('/api/v1/student/me/exams', T('student'))).json.exams.length}`);
  if (T('examcell')) out.push(`exams ${(await get('/api/v1/exams', T('examcell'))).json.exams.length}`);
  if (T('chief')) out.push(`incidents ${(await get('/api/v1/proctor/incidents?limit=50', T('chief'))).json.incidents.length}`);
  if (T('evaluator')) await get('/api/v1/evaluator/me/assignments', T('evaluator')), out.push('assignments ok');
  if (T('admin')) out.push(`audit ${(await get('/api/v1/tenant/audit', T('admin'))).json.events.length}`);
  for (const role of Object.keys(ACCOUNTS)) if (T(role)) expect((await get('/api/v1/auth/me', T(role))).json?.email, `${role} /auth/me`);
  return out.join(' · ');
});
await check('a student cannot open staff screens', async () => {
  for (const p of ['/api/v1/exams', '/api/v1/proctor/incidents', '/api/v1/tenant/users', '/api/v1/tenant/audit']) await get(p, T('student'), 403);
});
await check('no token and a forged token are 401 with a problem object', async () => {
  const a = await call('GET', '/api/v1/exams');
  expect(a.status === 401 && typeof a.json?.code === 'string', `no token → ${a.status}`);
  expect(String(a.headers['content-type']).includes('application/problem+json'), `content-type ${a.headers['content-type']}`);
  expect(!JSON.stringify(a.json).match(/at \w+ \(|node_modules/), 'stack trace in an error response');
  const b = await call('GET', '/api/v1/exams', { token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.forged' });
  expect(b.status === 401, `forged → ${b.status}`);
});
await check('security headers are set', async () => {
  const r = await call('GET', '/api/v1/tenant');
  const h = r.headers;
  expect(h['x-content-type-options'] === 'nosniff', 'x-content-type-options');
  expect(!h['x-powered-by'], 'x-powered-by present');
  return ['x-frame-options', 'strict-transport-security', 'referrer-policy'].filter((k) => h[k]).join(', ') || 'nosniff only';
});
await check('a client cannot report a server-only signal', async () => {
  const exams = (await get('/api/v1/student/me/exams', T('student'))).json.exams;
  const attemptId = exams.find((e) => e.attemptId)?.attemptId;
  expect(attemptId, 'student has no attempt');
  const r = await call('POST', '/api/v1/proctor/events', { token: T('student'), body: { events: [{ sourceEventId: randomUUID(), attemptId, signalClass: 'CONCURRENT_SESSION', metadata: {} }] } });
  expect(r.status === 403 && r.json?.code === 'SERVER_ONLY_SIGNAL', `status ${r.status} ${r.json?.code ?? ''}`);
});
await check('refresh rotates; one lost-response retry is tolerated, a second replay revokes the session', async () => {
  const old = tokens.student?.refreshToken;
  expect(old, 'no student session');
  const r1 = await call('POST', '/api/v1/auth/refresh', { body: { refreshToken: old } });
  expect(r1.status === 200 && r1.json?.refreshToken && r1.json.refreshToken !== old, `rotate → ${r1.status}`);
  // a student on bad Wi-Fi may never have received r1: one retry inside 30 s is answered, never a second
  const retry = await call('POST', '/api/v1/auth/refresh', { body: { refreshToken: old } });
  expect(retry.status === 200, `single retry → ${retry.status}`);
  const replay = await call('POST', '/api/v1/auth/refresh', { body: { refreshToken: old } });
  expect(replay.status === 401 && replay.json?.code === 'SESSION_REVOKED', `second replay → ${replay.status} ${replay.json?.code ?? ''}`);
  const after = await call('POST', '/api/v1/auth/refresh', { body: { refreshToken: r1.json.refreshToken } });
  expect(after.status === 401, `rotated token after reuse → ${after.status} (family must be revoked)`);
});
await check(`reads answer within ${SLOW_MS} ms`, async () => {
  const sorted = [...latencies].sort((a, b) => a - b);
  const p = (q) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0);
  expect(p(1) <= SLOW_MS, `slowest ${p(1)} ms`);
  return `${sorted.length} requests · p50 ${p(0.5)} ms · p95 ${p(0.95)} ms · max ${p(1)} ms`;
});

const width = Math.max(...rows.map((r) => r.name.length));
console.log(`\nExamOS smoke test · ${BASE} · host ${HOST}\n`);
for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail}`);
const failed = rows.filter((r) => !r.ok).length;
console.log(`\n${rows.length - failed}/${rows.length} passed`);
process.exit(failed ? 1 : 0);
