// End-to-end link and route checker for ExamOS
import http from 'node:http';

const BASE = 'http://127.0.0.1:4000';
const HOST = 'localhost';

function request(method, path, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + path);
    const headers = { Host: HOST, 'content-type': 'application/json', ...(opts.headers || {}) };
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(body);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, body, json });
        });
      }
    );
    req.on('error', reject);
    if (opts.body) req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    req.end();
  });
}

async function login(email, password) {
  const r = await request('POST', '/api/v1/auth/login', { body: { email, password } });
  if (r.status !== 200) throw new Error(`Login failed for ${email}: ${r.status} ${r.body}`);
  return r.json;
}

async function run() {
  console.log('===============================================================');
  console.log('   SMRU ExamOS — Comprehensive End-to-End Link & Route Check   ');
  console.log('===============================================================\n');

  const results = [];
  function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`  ${ok ? '✓ [PASS]' : '✗ [FAIL]'} ${name}${detail ? ` (${detail})` : ''}`);
  }

  // 1. Public Links
  console.log('[Phase 1] Testing Public Endpoints...');
  const health = await request('GET', '/healthz');
  check('GET /healthz', health.status === 200, `status ${health.status}`);

  const tenant = await request('GET', '/api/v1/tenant');
  check('GET /api/v1/tenant', tenant.status === 200 && tenant.json?.slug === 'demo', `slug=${tenant.json?.slug}`);

  // 2. Staff Authentication & Persona Links
  console.log('\n[Phase 2] Testing Staff Role Endpoints...');
  const admin = await login('admin@demo.local', 'Demo-Admin!2026');
  const examcell = await login('examcell@demo.local', 'Demo-Staff!2026');
  const chief = await login('chief@demo.local', 'Demo-Staff!2026');
  const evaluator = await login('evaluator@demo.local', 'Demo-Staff!2026');

  const auth = (token) => ({ Authorization: `Bearer ${token}` });

  // /auth/me for each staff persona
  const meAdmin = await request('GET', '/api/v1/auth/me', { headers: auth(admin.accessToken) });
  check('GET /api/v1/auth/me (Admin)', meAdmin.status === 200 && meAdmin.json?.kind === 'STAFF');

  const meChief = await request('GET', '/api/v1/auth/me', { headers: auth(chief.accessToken) });
  check('GET /api/v1/auth/me (Chief Reviewer)', meChief.status === 200 && meChief.json?.kind === 'STAFF');

  // Exams List
  const examsRes = await request('GET', '/api/v1/exams', { headers: auth(examcell.accessToken) });
  check('GET /api/v1/exams', examsRes.status === 200 && Array.isArray(examsRes.json?.exams), `count=${examsRes.json?.exams?.length}`);
  const exams = examsRes.json?.exams || [];
  const publishedExam = exams.find((e) => e.status === 'PUBLISHED') || exams[0];
  const liveExam = exams.find((e) => e.status === 'LIVE') || exams[0];
  const precheckExam = exams.find((e) => e.status === 'PRECHECK') || exams[0];

  // Exam Details
  if (publishedExam) {
    const examDetail = await request('GET', `/api/v1/exams/${publishedExam.id}`, { headers: auth(examcell.accessToken) });
    check(`GET /api/v1/exams/${publishedExam.code}`, examDetail.status === 200);

    const paper = await request('GET', `/api/v1/exams/${publishedExam.id}/paper`, { headers: auth(chief.accessToken) });
    check(`GET /api/v1/exams/${publishedExam.code}/paper (Reviewer access)`, paper.status === 200);

    const candidates = await request('GET', `/api/v1/exams/${publishedExam.id}/candidates`, { headers: auth(examcell.accessToken) });
    check(`GET /api/v1/exams/${publishedExam.code}/candidates`, candidates.status === 200 && Array.isArray(candidates.json?.candidates));
  }

  if (precheckExam) {
    const readiness = await request('GET', `/api/v1/exams/${precheckExam.id}/readiness`, { headers: auth(examcell.accessToken) });
    check(`GET /api/v1/exams/${precheckExam.code}/readiness (Readiness Board)`, readiness.status === 200 && readiness.json?.summary?.total > 0);
  }

  // Academic Analytics
  const analyticsOverview = await request('GET', '/api/v1/analytics/overview', { headers: auth(admin.accessToken) });
  const depts = analyticsOverview.json?.departments ?? analyticsOverview.json?.overview?.departments ?? [];
  check('GET /api/v1/analytics/overview', analyticsOverview.status === 200 && Array.isArray(depts), `count=${depts.length}`);

  const dept = depts[0]?.department ?? depts[0];
  if (dept) {
    const deptAnalytics = await request('GET', `/api/v1/analytics/department/${dept.id}`, { headers: auth(admin.accessToken) });
    check(`GET /api/v1/analytics/department/${dept.code}`, deptAnalytics.status === 200 && (deptAnalytics.json?.analytics?.summary?.passRate !== undefined || deptAnalytics.json?.summary?.passRate !== undefined));
  }

  // Administration Links
  const users = await request('GET', '/api/v1/tenant/users', { headers: auth(admin.accessToken) });
  check('GET /api/v1/tenant/users', users.status === 200 && Array.isArray(users.json?.users));

  const mailDispatches = await request('GET', '/api/v1/tenant/mail-dispatches', { headers: auth(admin.accessToken) });
  check('GET /api/v1/tenant/mail-dispatches', mailDispatches.status === 200);

  const audit = await request('GET', '/api/v1/tenant/audit', { headers: auth(admin.accessToken) });
  check('GET /api/v1/tenant/audit', audit.status === 200 && Array.isArray(audit.json?.events));

  // Proctor Console
  const incidents = await request('GET', '/api/v1/proctor/incidents', { headers: auth(chief.accessToken) });
  check('GET /api/v1/proctor/incidents (Chief Proctor)', incidents.status === 200);

  // Evaluator Queue
  const assignments = await request('GET', '/api/v1/evaluator/me/assignments', { headers: auth(evaluator.accessToken) });
  check('GET /api/v1/evaluator/me/assignments', assignments.status === 200 && Array.isArray(assignments.json));

  // 3. Student Authentication & Endpoints
  console.log('\n[Phase 3] Testing Student Links & Endpoints...');
  const student = await login('student01@demo.local', 'Demo-Student!2026');
  const sAuth = auth(student.accessToken);

  const studentExams = await request('GET', '/api/v1/student/me/exams', { headers: sAuth });
  check('GET /api/v1/student/me/exams', studentExams.status === 200 && Array.isArray(studentExams.json?.exams));

  const studentLedger = await request('GET', '/api/v1/student/me/ledger', { headers: sAuth });
  check('GET /api/v1/student/me/ledger', studentLedger.status === 200 && (studentLedger.json?.overall?.exams !== undefined || studentLedger.json?.overall?.totalExams !== undefined));

  const studentProfile = await request('GET', '/api/v1/student/profile', { headers: sAuth });
  check('GET /api/v1/student/profile', studentProfile.status === 200 && studentProfile.json?.profile?.student?.registerNumber === '22CSE001');

  const studentIdCard = await request('GET', '/api/v1/student/profile/id-card', { headers: sAuth });
  check('GET /api/v1/student/profile/id-card', studentIdCard.status === 200 && studentIdCard.json?.idCard?.valid === true);

  // Hall Ticket PDF link
  if (publishedExam) {
    const htPdf = await request('GET', `/api/v1/student/me/exams/${publishedExam.id}/hall-ticket.pdf`, { headers: sAuth });
    check(`GET /api/v1/student/me/exams/${publishedExam.code}/hall-ticket.pdf`, htPdf.status === 200 && htPdf.headers['content-type'] === 'application/pdf');
  }

  // Answer Booklet link
  const myPubExam = (studentExams.json?.exams || []).find((e) => e.code === 'CS305-PUB');
  if (myPubExam?.attemptId) {
    const booklet = await request('GET', `/api/v1/student/attempts/${myPubExam.attemptId}/booklet`, { headers: sAuth });
    check('GET /api/v1/student/attempts/:id/booklet', booklet.status === 200 && booklet.json?.total?.marks > 0);

    const bookletPdf = await request('GET', `/api/v1/student/attempts/${myPubExam.attemptId}/booklet.pdf`, { headers: sAuth });
    check('GET /api/v1/student/attempts/:id/booklet.pdf', bookletPdf.status === 200 && bookletPdf.headers['content-type'] === 'application/pdf');

    // Public verification link
    if (booklet.json?.verificationHash) {
      const verify = await request('GET', `/api/v1/student/verify/${myPubExam.attemptId}/1`);
      check('GET /api/v1/student/verify/:attemptId/:version (Public verification)', verify.status === 200 && verify.json?.valid === true);
    }
  }

  // Summary
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log('\n===============================================================');
  console.log(`   Link Check Summary: ${passed} PASSED, ${failed} FAILED (${results.length} total)   `);
  console.log('===============================================================\n');

  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Fatal link check error:', err);
  process.exit(1);
});
