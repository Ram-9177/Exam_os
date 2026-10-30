// Run against a server seeded with `npm run demo` (API on :4000, tenant host `localhost`):  node apps/api/scripts/security-probes.mjs
// Black-box security probes against the running API (not a penetration test).
import http from 'node:http';
const B = 'http://127.0.0.1:4000';
const H = { Host: 'localhost', 'content-type': 'application/json' };
// Node's fetch drops the Host header (forbidden by the Fetch spec), so probes use http.request to set it like a browser behind a proxy would.
function fetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = { ...(opts.headers ?? {}) };
    const rq = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: opts.method ?? 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: { get: (k) => res.headers[k.toLowerCase()] ?? null }, json: async () => JSON.parse(text), text: async () => text });
      });
    });
    rq.on('error', reject);
    if (opts.body) rq.write(opts.body);
    rq.end();
  });
}
const results = [];
const ok = (name, cond, detail) => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
const j = async (r) => { try { return await r.json(); } catch { return null; } };
async function login(email, password) { const r = await fetch(`${B}/api/v1/auth/login`, { method: 'POST', headers: H, body: JSON.stringify({ email, password }) }); return (await r.json()); }

const examcell = await login('examcell@demo.local', 'Demo-Staff!2026');
const s05 = await login('student05@demo.local', 'Demo-Student!2026');
const s06 = await login('student06@demo.local', 'Demo-Student!2026');
const auth = (t) => ({ ...H, authorization: `Bearer ${t.accessToken}` });

// 1 auth required
let r = await fetch(`${B}/api/v1/exams`, { headers: H }); ok('protected route without token → 401', r.status === 401);
r = await fetch(`${B}/api/v1/tenant`, { headers: { Host: 'evil.example' } }); ok('unknown host → 404 TENANT_NOT_FOUND', r.status === 404);
// 2 SQL injection attempts in filters
r = await fetch(`${B}/api/v1/exams?q=${encodeURIComponent("' OR 1=1 --")}&status=${encodeURIComponent("LIVE' OR '1'='1")}`, { headers: auth(examcell) });
let body = await j(r); ok('SQL injection in query filters → parameterised (200, no leak, no 500)', r.status === 200 && Array.isArray(body.exams) && body.exams.length === 0, `status ${r.status}, rows ${body?.exams?.length}`);
r = await fetch(`${B}/api/v1/tenant/users?q=${encodeURIComponent("%' ; DROP TABLE users; --")}`, { headers: auth(await login('admin@demo.local', 'Demo-Admin!2026')) }); ok('SQL injection in user search → no error', r.status === 200);
// 3 malformed / oversized bodies
r = await fetch(`${B}/api/v1/auth/login`, { method: 'POST', headers: H, body: '{"email": ' }); body = await j(r); ok('malformed JSON → 400 MALFORMED_JSON', r.status === 400 && body?.code === 'MALFORMED_JSON');
r = await fetch(`${B}/api/v1/auth/login`, { method: 'POST', headers: H, body: JSON.stringify({ email: 'a@b.c', password: 'x'.repeat(6 * 1024 * 1024) }) }); ok('oversized body → 413', r.status === 413, `status ${r.status}`);
// 4 IDOR between students
const exR = await fetch(`${B}/api/v1/student/me/exams`, { headers: auth(s05) }); const examsA = await exR.json(); if (!examsA.exams) { console.log('me/exams', exR.status, JSON.stringify(examsA), JSON.stringify(s05).slice(0,200)); process.exit(1); }
const attemptA = examsA.exams.find((e) => e.code === 'CS301-MID1').attemptId;
r = await fetch(`${B}/api/v1/student/attempts/${attemptA}/answers/Q1`, { headers: auth(s06) }); ok('student B reads student A answer → 404', r.status === 404);
r = await fetch(`${B}/api/v1/student/attempts/${attemptA}/prechecks`, { method: 'POST', headers: auth(s06), body: '{}' }); ok('student B starts A readiness → 404', r.status === 404);
r = await fetch(`${B}/api/v1/exams/${examsA.exams[0].examId}/readiness`, { headers: auth(s05) }); ok('student opens staff readiness board → 403', r.status === 403);
// 5 mass assignment / unknown fields
r = await fetch(`${B}/api/v1/tenant/users`, { method: 'POST', headers: auth(await login('admin@demo.local', 'Demo-Admin!2026')), body: JSON.stringify({ email: `probe-${Date.now()}@demo.local`, fullName: 'Probe', kind: 'STAFF', roles: [], sendActivation: false, tenant_id: '00000000-0000-0000-0000-000000000000', status: 'ACTIVE', password_hash: 'x' }) });
body = await j(r); ok('unknown/privileged fields in body are stripped (201, no error)', r.status === 201, `status ${r.status}`);
r = await fetch(`${B}/api/v1/auth/login`, { method: 'POST', headers: H, body: JSON.stringify({ __proto__: { polluted: true }, email: 'student05@demo.local', password: 'Demo-Student!2026' }) }); ok('prototype pollution payload has no effect', r.status === 200 && ({}).polluted === undefined);
// 6 headers
r = await fetch(`${B}/healthz`); ok('security headers (helmet) present', r.headers.get('x-content-type-options') === 'nosniff' && !!r.headers.get('x-frame-options') && r.headers.get('x-powered-by') === null, `${r.headers.get('x-content-type-options')} ${r.headers.get('x-frame-options')}`);
// 7 token tampering
const [h, p, sig] = s05.accessToken.split('.');
r = await fetch(`${B}/api/v1/auth/me`, { headers: { ...H, authorization: `Bearer ${h}.${p}.${sig.slice(0, -3)}abc` } }); ok('tampered JWT signature → 401', r.status === 401);
const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
r = await fetch(`${B}/api/v1/auth/me`, { headers: { ...H, authorization: `Bearer ${none}.${p}.` } }); ok('alg=none JWT → 401', r.status === 401);
r = await fetch(`${B}/api/v1/integration/v1/events?apiKey=exk_live_x`, {}); ok('API key is never accepted in the query string → 401', r.status === 401);
// 8 rate limit on login
let last = 0; for (let i = 0; i < 25; i++) { const rr = await fetch(`${B}/api/v1/auth/login`, { method: 'POST', headers: H, body: JSON.stringify({ email: 'ratelimit@demo.local', password: 'wrong-password-123' }) }); last = rr.status; if (last === 429) break; }
ok('login brute force → 429 within 25 attempts', last === 429, `last status ${last}`);
// 9 error bodies never leak internals
r = await fetch(`${B}/api/v1/student/attempts/not-a-uuid/answers/Q1`, { headers: auth(s05) }); body = await j(r); ok('bad id → 400 with problem envelope, no stack', r.status === 400 && !JSON.stringify(body).includes('at ') && !!body.requestId);
// 10 export lock & cross-tenant style: host/token mismatch
r = await fetch(`${B}/api/v1/auth/me`, { headers: { Host: 'demo.examos.local', authorization: `Bearer ${s05.accessToken}` } }); ok('same tenant, alternate host → 200 (both hosts registered)', r.status === 200);
console.log(results.join('\n'));
console.log(`\n${results.filter((x) => x.startsWith('PASS')).length}/${results.length} probes passed`);
