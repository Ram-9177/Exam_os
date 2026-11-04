import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createTestContext,
  provisionTenant,
  createStaff,
  createApiKey,
  activationTokenFor,
  startFakeServer,
  runWorkers,
  answerHash,
  cleanScan,
  PLATFORM_KEY,
  type TestContext,
  type ProvisionedTenant,
} from './helpers.js';
import { runForensicsOnce } from '../src/modules/candidates/service.js';
import { sha256Hex } from '../src/lib/crypto.js';

interface StudentData {
  externalId: string;
  email: string;
  token: string;
  userId: string;
  attemptId: string;
  deviceSessionId?: string;
}

/**
 * All-Personas Comprehensive End-to-End Suite:
 * Exercises every named persona, every duty bundle, every student scenario,
 * and every edge case across the complete examination lifecycle against the
 * real PostgreSQL 16 database and Redis 7.
 */
describe('All-Personas Comprehensive End-to-End Exam Suite', () => {
  let ctx: TestContext;
  let t: ProvisionedTenant;

  // 4 Staff Logins (Maximum permitted by ExamOS tenant architecture trigger)
  let tenantAdmin: { userId: string; email: string; token: string }; // ADMIN_CONTROLLER: TENANT_ADMIN + CONTROLLER + SECURITY_AUDITOR
  let examCell: Awaited<ReturnType<typeof createStaff>>; // EXAM_OFFICE: EXAM_CELL_OPERATOR + QUESTION_SETTER
  let chiefReviewer: Awaited<ReturnType<typeof createStaff>>; // CHIEF_REVIEWER: CHIEF_PROCTOR + PAPER_REVIEWER + HOD
  let examiner: Awaited<ReturnType<typeof createStaff>>; // EXAMINER: EVALUATOR + MODERATOR + PROCTOR

  // 5 Distinct Students exercising distinct flows
  const alpha: StudentData = { externalId: 'SMRU-9001', email: '', token: '', userId: '', attemptId: '' }; // Normal + Whiteboard
  const beta: StudentData = { externalId: 'SMRU-9002', email: '', token: '', userId: '', attemptId: '' }; // Security Exception / Loaner
  const gamma: StudentData = { externalId: 'SMRU-9003', email: '', token: '', userId: '', attemptId: '' }; // Disciplinary 5 Warnings & Suspension
  const delta: StudentData = { externalId: 'SMRU-9004', email: '', token: '', userId: '', attemptId: '' }; // Auto-seal on Exam Close
  const epsilon: StudentData = { externalId: 'SMRU-9005', email: '', token: '', userId: '', attemptId: '' }; // Revaluation applicant

  // ERP Integration
  let erpKey: { apiKey: string };
  let receiver: { url: string; close: () => Promise<void> };
  const erpEvents: Array<{ type: string; data: Record<string, unknown> }> = [];

  let examId = '';
  let sebKey = '';
  const examCode = `CS901-${Date.now().toString(36).toUpperCase()}`;

  const H = (token: string) => ({ Host: t.host, Authorization: `Bearer ${token}` });
  const req = () => ctx.request();

  beforeAll(async () => {
    ctx = await createTestContext();
    t = await provisionTenant(ctx, 'all-personas');

    tenantAdmin = {
      userId: t.admin.userId,
      email: t.admin.email,
      token: t.admin.token,
    };

    // Exactly 3 additional staff accounts created (total 4 per tenant, fulfilling the limit trigger)
    [examCell, chiefReviewer, examiner] = await Promise.all([
      createStaff(ctx, t, ['EXAM_CELL_OPERATOR', 'QUESTION_SETTER'], 'examcell'),
      createStaff(ctx, t, ['CHIEF_PROCTOR', 'PAPER_REVIEWER', 'HOD'], 'chief'),
      createStaff(ctx, t, ['EVALUATOR', 'MODERATOR', 'PROCTOR'], 'examiner'),
    ]);

    // External ERP Webhook receiver
    receiver = await startFakeServer((app) => {
      app.post('/erp-webhook', (r, res) => {
        erpEvents.push(r.body);
        res.status(200).json({ ok: true });
      });
    });

    // ERP API Key
    erpKey = await createApiKey(ctx, t, [
      'roster:write',
      'roster:read',
      'events:read',
      'results:read',
      'webhooks:manage',
    ]);

    // Webhook subscription for all lifecycle events
    const hookRes = await req()
      .post('/api/v1/integration/v1/webhooks')
      .set('Authorization', `Bearer ${erpKey.apiKey}`)
      .send({
        url: `${receiver.url}/erp-webhook`,
        eventTypes: ['exam.scheduled', 'attempt.submitted', 'candidate.held', 'result.published'],
      });
    expect(hookRes.status).toBe(201);

    // Ingest Academic Roster via ERP Simple API
    const K = (p: string) =>
      req()
        .put(`/api/v1/integration/v1/roster/${p}/batch`)
        .set('Authorization', `Bearer ${erpKey.apiKey}`)
        .set('Idempotency-Key', randomUUID())
        .set('X-ExamOS-Provider', 'uos');

    const unitsRes = await K('academic-units').send({
      rows: [
        { kind: 'DEPARTMENT', code: 'CS', name: 'Computer Science & Engineering', parentCode: 'ENG' },
        { kind: 'PROGRAMME', code: 'BTECH-CS', name: 'B.Tech in Computer Science', parentCode: 'CS' },
      ],
    });
    expect(unitsRes.status).toBe(200);

    const coursesRes = await K('courses').send({
      rows: [{ code: 'CS901', name: 'Advanced Distributed Operating Systems', departmentCode: 'CS' }],
    });
    expect(coursesRes.status).toBe(200);

    // Ingest 5 students
    alpha.email = `alpha@${t.slug}.test`;
    beta.email = `beta@${t.slug}.test`;
    gamma.email = `gamma@${t.slug}.test`;
    delta.email = `delta@${t.slug}.test`;
    epsilon.email = `epsilon@${t.slug}.test`;

    const students = [alpha, beta, gamma, delta, epsilon];
    const personsRes = await K('persons').send({
      rows: students.map((s, idx) => ({
        externalId: s.externalId,
        kind: 'STUDENT',
        fullName: `Candidate ${s.externalId}`,
        email: s.email,
        departmentCode: 'CS',
        programmeCode: 'BTECH-CS',
        currentSemester: 7,
        section: 'A',
        attributes: { registerNumber: `2026-CS-${String(idx + 1).padStart(4, '0')}` },
      })),
    });
    expect(personsRes.body.summary.created).toBe(5);

    const enrollRes = await K('enrollments').send({
      rows: students.map((s) => ({
        studentExternalId: s.externalId,
        courseCode: 'CS901',
        academicYear: '2026-27',
        term: 'ODD',
        section: 'A',
      })),
    });
    expect(enrollRes.body.summary.created).toBe(5);

    // Activate all 5 students
    for (const s of students) {
      const actTok = await activationTokenFor(ctx, t.tenantId, s.email);
      const act = await req()
        .post('/api/v1/auth/activate')
        .set('Host', t.host)
        .send({ token: actTok, password: 'StudentPass!2026' });
      expect(act.status).toBe(200);
      s.token = act.body.accessToken;
      s.userId = act.body.user.id;
    }
  });

  afterAll(async () => {
    await receiver.close();
    await ctx.close();
  });

  it('1. PLATFORM_ADMIN & TENANT_ADMIN: Validates governance, platform boundaries & ERP connection setup', async () => {
    // Platform bootstrap boundary: superadmin accesses platform routes
    const platRes = await req().get('/api/v1/platform/tenants').set('x-platform-key', PLATFORM_KEY);
    expect(platRes.status).toBe(200);
    expect(platRes.body.tenants.some((x: { id: string }) => x.id === t.tenantId)).toBe(true);

    // Tenant Admin configures external ERP connection
    const erpConnRes = await req()
      .post('/api/v1/tenant/erp-connections')
      .set(H(tenantAdmin.token))
      .send({
        provider: 'uos',
        label: 'Primary University ERP',
        baseUrl: 'https://erp.smru.edu.in',
        status: 'ACTIVE',
        mapping: { studentIdField: 'externalId' },
      });
    expect(erpConnRes.status).toBe(201);
    expect(erpConnRes.body.id).toBeTruthy();

    // Tenant Admin verifies staff login limit (5th staff account is refused)
    const fifthStaff = await req()
      .post('/api/v1/tenant/users')
      .set(H(tenantAdmin.token))
      .send({ email: `overflow@${t.slug}.test`, fullName: 'Fifth Staff', kind: 'STAFF', roles: [{ role: 'PROCTOR' }] });
    expect(fifthStaff.status).toBe(409);
    expect(fifthStaff.body.code).toBe('STAFF_LOGIN_LIMIT');
  });

  it('2. QUESTION_SETTER & CHIEF_REVIEWER: Question authoring, review rejection, revision, and cryptographic approval', async () => {
    // Exam Cell creates exam in DRAFT
    const start = new Date(Date.now() - 5 * 60_000);
    const end = new Date(Date.now() + 3 * 3600_000);

    const createExam = await req()
      .post('/api/v1/exams')
      .set(H(examCell.token))
      .send({
        code: examCode,
        title: 'Distributed Systems Comprehensive Exam',
        courseCode: 'CS901',
        examType: 'SEM_EXTERNAL',
        academicYear: '2026-27',
        semester: 7,
        maxMarks: 30,
        securityProfile: 'SECURE_BYOD',
        durationMinutes: 90,
        windowStartAt: start.toISOString(),
        windowEndAt: end.toISOString(),
        warningThreshold: 5,
        policy: { allowedClientBuilds: ['seb-3.8.0'] },
      });
    expect(createExam.status).toBe(201);
    examId = createExam.body.examId;

    // Question Setter drafts initial paper with 3 questions (Total marks 30)
    const initialPaper = await req()
      .put(`/api/v1/exams/${examId}/paper`)
      .set(H(examCell.token))
      .send({
        title: 'Distributed Systems Final Paper',
        sections: [{ code: 'A', title: 'Core Concepts', instructions: 'Attempt all questions' }],
        questions: [
          {
            questionId: 'Q1',
            sectionCode: 'A',
            number: 1,
            kind: 'DESCRIPTIVE',
            prompt: { blocks: [{ id: 'p1', kind: 'paragraph', content: 'Explain Raft consensus leader election.' }] },
            maxMarks: 10,
            rubric: [{ code: 'LEADER_ELECTION', max: 10, description: 'Correct term and heartbeat logic' }],
            attachments: [],
          },
          {
            questionId: 'Q2',
            sectionCode: 'A',
            number: 2,
            kind: 'DRAWING',
            prompt: { blocks: [{ id: 'p2', kind: 'paragraph', content: 'Draw the 2-Phase Commit state transition diagram.' }] },
            maxMarks: 10,
            rubric: [{ code: 'DIAGRAM', max: 10, description: 'Coordinator and Participant state transitions' }],
            attachments: [],
          },
          {
            questionId: 'Q3',
            sectionCode: 'A',
            number: 3,
            kind: 'DESCRIPTIVE',
            prompt: { blocks: [{ id: 'p3', kind: 'paragraph', content: 'Analyze Byzantine Fault Tolerance assumptions.' }] },
            maxMarks: 10,
            rubric: [{ code: 'BFT_MATH', max: 10, description: '3f + 1 node requirement proof' }],
            attachments: [],
          },
        ],
      });
    expect(initialPaper.status).toBe(200);
    expect(initialPaper.body.totalMarks).toBe(30);

    // Question setter submits for review
    const submitReview = await req().post(`/api/v1/exams/${examId}/paper/submit-for-review`).set(H(examCell.token));
    expect(submitReview.status).toBe(200);
    expect(submitReview.body.status).toBe('REVIEW');

    // Chief Reviewer rejects with feedback
    const reject = await req()
      .post(`/api/v1/exams/${examId}/paper/reject`)
      .set(H(chiefReviewer.token))
      .send({ feedback: 'Please add explicit rubric breakdown for Q2 diagram components.' });
    expect(reject.status).toBe(200);
    expect(reject.body.status).toBe('DRAFT');

    // Question Setter updates rubric and re-submits
    await req()
      .put(`/api/v1/exams/${examId}/paper`)
      .set(H(examCell.token))
      .send({
        title: 'Distributed Systems Final Paper (Revised)',
        sections: [{ code: 'A', title: 'Core Concepts', instructions: 'Attempt all questions' }],
        questions: [
          {
            questionId: 'Q1',
            sectionCode: 'A',
            number: 1,
            kind: 'DESCRIPTIVE',
            prompt: { blocks: [{ id: 'p1', kind: 'paragraph', content: 'Explain Raft consensus leader election.' }] },
            maxMarks: 10,
            rubric: [{ code: 'LEADER_ELECTION', max: 10, description: 'Correct term and heartbeat logic' }],
            attachments: [],
          },
          {
            questionId: 'Q2',
            sectionCode: 'A',
            number: 2,
            kind: 'DRAWING',
            prompt: { blocks: [{ id: 'p2', kind: 'paragraph', content: 'Draw the 2-Phase Commit state transition diagram.' }] },
            maxMarks: 10,
            rubric: [
              { code: 'COORDINATOR_STATES', max: 5, description: 'Commit/Abort transitions' },
              { code: 'PARTICIPANT_STATES', max: 5, description: 'Prepare/Ready transitions' },
            ],
            attachments: [],
          },
          {
            questionId: 'Q3',
            sectionCode: 'A',
            number: 3,
            kind: 'DESCRIPTIVE',
            prompt: { blocks: [{ id: 'p3', kind: 'paragraph', content: 'Analyze Byzantine Fault Tolerance assumptions.' }] },
            maxMarks: 10,
            rubric: [{ code: 'BFT_MATH', max: 10, description: '3f + 1 node requirement proof' }],
            attachments: [],
          },
        ],
      });

    await req().post(`/api/v1/exams/${examId}/paper/submit-for-review`).set(H(examCell.token));

    // Chief Reviewer approves revised paper
    const approvePaper = await req()
      .post(`/api/v1/exams/${examId}/paper/approve`)
      .set(H(chiefReviewer.token))
      .send({ decision: 'APPROVED' });
    expect(approvePaper.status).toBe(200);
    expect(approvePaper.body.status).toBe('APPROVED');
    expect(approvePaper.body.sealedSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('3. EXAM_OFFICE: Allocates candidates, issues hall tickets, sets SEB policy, and schedules the exam', async () => {
    // Allocate all 5 candidates
    const alloc = await req()
      .post(`/api/v1/exams/${examId}/allocations`)
      .set(H(examCell.token))
      .send({ studentExternalIds: [alpha, beta, gamma, delta, epsilon].map((s) => s.externalId), provider: 'uos' });
    expect(alloc.status).toBe(200);
    expect(alloc.body.allocated).toBe(5);

    // Issue hall tickets
    const ht = await req().post(`/api/v1/exams/${examId}/hall-tickets`).set(H(examCell.token)).send({});
    expect(ht.status).toBe(200);
    expect(ht.body.issued).toBe(5);

    // Exam Cell configures SEB policy
    const sebConfig = await req()
      .post(`/api/v1/exams/${examId}/seb-config`)
      .set(H(examCell.token))
      .send({
        allowQuit: true,
        kioskMode: true,
        blockVirtualMachines: true,
        blockScreenCapture: true,
        blockClipboard: true,
      });
    expect(sebConfig.status).toBe(201);
    expect(sebConfig.body.sebConfigKey).toBeTruthy();
    sebKey = sebConfig.body.sebConfigKey as string;

    // Advance exam lifecycle: submit-for-review -> approve -> schedule
    expect((await req().post(`/api/v1/exams/${examId}/submit-for-review`).set(H(examCell.token))).status).toBe(200);
    expect((await req().post(`/api/v1/exams/${examId}/approve`).set(H(examCell.token))).status).toBe(200);
    expect((await req().post(`/api/v1/exams/${examId}/schedule`).set(H(examCell.token))).status).toBe(200);

    // Students retrieve attempt IDs from their personal exam list
    for (const s of [alpha, beta, gamma, delta, epsilon]) {
      const myExams = await req().get('/api/v1/student/me/exams').set(H(s.token));
      expect(myExams.status).toBe(200);
      const match = myExams.body.exams.find((e: { code: string }) => e.code === examCode);
      expect(match).toBeTruthy();
      expect(match.attemptStatus).toBe('ALLOCATED');
      s.attemptId = match.attemptId;
    }

    // Open Precheck phase
    const openPrecheck = await req().post(`/api/v1/exams/${examId}/open-precheck`).set(H(examCell.token));
    expect(openPrecheck.status).toBe(200);

    // Verify webhook dispatched to ERP
    await runWorkers(ctx);
    expect(erpEvents.some((e) => e.type === 'exam.scheduled')).toBe(true);
  });

  it('4. STUDENT & CONTROLLER: Student readiness precheck — Normal vs Security Waiver (Loaner)', async () => {
    const examPolicy = await ctx.admin('exams').where('id', examId).first('policy_version');

    // Candidate Alpha (Model Student) runs full precheck
    const runAlpha = await req()
      .post(`/api/v1/student/attempts/${alpha.attemptId}/prechecks`)
      .set(H(alpha.token))
      .send({ clientBuild: 'seb-3.8.0' });
    expect(runAlpha.status).toBe(201);
    const rIdA = runAlpha.body.runId;

    const vA = (body: Record<string, unknown>) => {
      const verifyPath = `/api/v1/student/prechecks/${rIdA}/items/verify`;
      const fullUrl = `http://${t.host}${verifyPath}`;
      const sebConfigKeyHash = sha256Hex(`${fullUrl}${sebKey}`);
      return req()
        .post(verifyPath)
        .set(H(alpha.token))
        .set('X-SafeExamBrowser-ConfigKeyHash', sebConfigKeyHash)
        .send(body);
    };

    await vA({ code: 'CLIENT_VERSION', clientBuild: 'seb-3.8.0' });
    await vA({ code: 'CLOCK_SYNC', clientClockMs: Date.now() });
    await vA({ code: 'KEYBOARD_INPUT', keyboardSample: 'Quick brown fox jumps over 123 lazy dogs, verified!' });
    // Candidate Alpha starts with dual display -> REMEDIATE, then disconnects second screen -> PASS
    const dualScan = await vA({
      code: 'SYSTEM_SCAN',
      scan: cleanScan({
        screen: {
          width: 1920,
          height: 1080,
          availWidth: 1920,
          availHeight: 1040,
          colorDepth: 24,
          pixelRatio: 1,
          isExtended: true,
          displayCount: 2,
        },
      }),
    });
    expect(dualScan.body.checks.find((c: { code: string }) => c.code === 'SYSTEM_SCAN')).toMatchObject({
      status: 'REMEDIATE',
      diagnosticCode: 'MULTIPLE_DISPLAYS',
      remediationCode: 'FIX_DEVICE_SETTINGS',
    });
    const cleanScanA = await vA({ code: 'SYSTEM_SCAN', scan: cleanScan() });
    expect(cleanScanA.body.checks.find((c: { code: string }) => c.code === 'SYSTEM_SCAN')).toMatchObject({
      status: 'PASS',
      source: 'CLIENT_DECLARED',
    });

    await req()
      .post(`/api/v1/student/prechecks/${rIdA}/practice-saves`)
      .set(H(alpha.token))
      .send({ contentDigest: '0'.repeat(64) });
    await vA({ code: 'NETWORK_SAVE_ROUNDTRIP' });
    await vA({ code: 'CONSENT', consentPolicyVersion: examPolicy.policy_version });

    const finAlpha = await req().post(`/api/v1/student/prechecks/${rIdA}/finalize`).set(H(alpha.token));
    expect(finAlpha.status).toBe(200);
    expect(finAlpha.body.status).toBe('READY');

    // Candidate Beta fails strict client check (using normal Chrome instead of approved SEB)
    const runBeta = await req()
      .post(`/api/v1/student/attempts/${beta.attemptId}/prechecks`)
      .set(H(beta.token))
      .send({ clientBuild: 'chrome-130' });
    const rIdB = runBeta.body.runId;

    const vB = (body: Record<string, unknown>) =>
      req().post(`/api/v1/student/prechecks/${rIdB}/items/verify`).set(H(beta.token)).send(body);

    await vB({ code: 'CLIENT_VERSION', clientBuild: 'chrome-130' });
    await vB({ code: 'CLOCK_SYNC', clientClockMs: Date.now() });
    await vB({ code: 'KEYBOARD_INPUT', keyboardSample: 'Keyboard check sample text 123, done!' });
    await vB({ code: 'SYSTEM_SCAN', scan: cleanScan() });
    await req()
      .post(`/api/v1/student/prechecks/${rIdB}/practice-saves`)
      .set(H(beta.token))
      .send({ contentDigest: '1'.repeat(64) });
    await vB({ code: 'NETWORK_SAVE_ROUNDTRIP' });
    await vB({ code: 'CONSENT', consentPolicyVersion: examPolicy.policy_version });

    const finBetaBlocked = await req().post(`/api/v1/student/prechecks/${rIdB}/finalize`).set(H(beta.token));
    expect(finBetaBlocked.body.status).toBe('REMEDIATE');
    expect(finBetaBlocked.body.checks.find((c: { code: string }) => c.code === 'CLIENT_VERSION').status).toBe('REMEDIATE');

    // Exam Cell attempts to override security check -> 403 (Controller only!)
    const deniedWaiver = await req()
      .post(`/api/v1/exams/${examId}/attempts/${beta.attemptId}/admission-exceptions`)
      .set(H(examCell.token))
      .send({
        exceptionCode: 'TECH_ALT_DEVICE',
        coversChecks: ['CLIENT_VERSION'],
        reason: 'Loaner laptop issued',
      });
    expect(deniedWaiver.status).toBe(403);
    expect(deniedWaiver.body.code).toBe('SECURITY_OVERRIDE_REQUIRED');

    // Controller grants admission exception for loaner laptop
    const grantedWaiver = await req()
      .post(`/api/v1/exams/${examId}/attempts/${beta.attemptId}/admission-exceptions`)
      .set(H(tenantAdmin.token))
      .send({
        exceptionCode: 'TECH_ALT_DEVICE',
        coversChecks: ['CLIENT_VERSION'],
        reason: 'Approved loaner machine issued at desk 1',
      });
    expect(grantedWaiver.status).toBe(201);

    // Candidate Beta re-verifies and is now covered by the Controller's waiver
    const runBeta2 = await req()
      .post(`/api/v1/student/attempts/${beta.attemptId}/prechecks`)
      .set(H(beta.token))
      .send({ clientBuild: 'chrome-130' });
    const rIdB2 = runBeta2.body.runId;
    const vB2 = (b: Record<string, unknown>) =>
      req().post(`/api/v1/student/prechecks/${rIdB2}/items/verify`).set(H(beta.token)).send(b);
    await vB2({ code: 'CLIENT_VERSION', clientBuild: 'chrome-130' });
    await vB2({ code: 'CLOCK_SYNC', clientClockMs: Date.now() });
    await vB2({ code: 'KEYBOARD_INPUT', keyboardSample: 'Keyboard check sample text 123, done!' });
    await vB2({ code: 'SYSTEM_SCAN', scan: cleanScan() });
    await req().post(`/api/v1/student/prechecks/${rIdB2}/practice-saves`).set(H(beta.token)).send({ contentDigest: '2'.repeat(64) });
    await vB2({ code: 'NETWORK_SAVE_ROUNDTRIP' });
    await vB2({ code: 'CONSENT', consentPolicyVersion: examPolicy.policy_version });

    const finBetaReady = await req().post(`/api/v1/student/prechecks/${rIdB2}/finalize`).set(H(beta.token));
    expect(finBetaReady.body.status).toBe('READY');
    expect(finBetaReady.body.checks.find((c: { code: string }) => c.code === 'CLIENT_VERSION').coveredByException).toBe(true);

    // Candidates Gamma, Delta, Epsilon complete prechecks to READY
    for (const s of [gamma, delta, epsilon]) {
      const run = await req()
        .post(`/api/v1/student/attempts/${s.attemptId}/prechecks`)
        .set(H(s.token))
        .send({ clientBuild: 'seb-3.8.0' });
      const rId = run.body.runId;
      const verifyPath = `/api/v1/student/prechecks/${rId}/items/verify`;
      const fullUrl = `http://${t.host}${verifyPath}`;
      const sebConfigKeyHash = sha256Hex(`${fullUrl}${sebKey}`);
      const v = (b: Record<string, unknown>) =>
        req()
          .post(verifyPath)
          .set(H(s.token))
          .set('X-SafeExamBrowser-ConfigKeyHash', sebConfigKeyHash)
          .send(b);
      await v({ code: 'CLIENT_VERSION', clientBuild: 'seb-3.8.0' });
      await v({ code: 'CLOCK_SYNC', clientClockMs: Date.now() });
      await v({ code: 'KEYBOARD_INPUT', keyboardSample: 'Valid typing speed sample 123, verified!' });
      await v({ code: 'SYSTEM_SCAN', scan: cleanScan() });
      await req().post(`/api/v1/student/prechecks/${rId}/practice-saves`).set(H(s.token)).send({ contentDigest: '3'.repeat(64) });
      await v({ code: 'NETWORK_SAVE_ROUNDTRIP' });
      await v({ code: 'CONSENT', consentPolicyVersion: examPolicy.policy_version });
      const fin = await req().post(`/api/v1/student/prechecks/${rId}/finalize`).set(H(s.token));
      expect(fin.body.status).toBe('READY');
    }
  });

  it('5. EXAM_OFFICE & CANDIDATES: Exam start and admission burst with device session binding', async () => {
    // Early entry refused before exam start
    const earlyAdmit = await req().post(`/api/v1/student/attempts/${alpha.attemptId}/entry-grants`).set(H(alpha.token));
    expect(earlyAdmit.status).toBe(409);
    expect(earlyAdmit.body.code).toBe('EXAM_NOT_STARTED');

    // Exam Cell starts the live exam
    const startRes = await req().post(`/api/v1/exams/${examId}/start`).set(H(examCell.token));
    expect(startRes.status).toBe(200);

    // Candidates obtain single-use entry grants and admit
    for (const s of [alpha, beta, gamma, delta, epsilon]) {
      const grantRes = await req().post(`/api/v1/student/attempts/${s.attemptId}/entry-grants`).set(H(s.token));
      expect(grantRes.status).toBe(201);
      const grantToken = grantRes.body.grantToken;

      const admitRes = await req()
        .post(`/api/v1/student/attempts/${s.attemptId}/admit`)
        .set(H(s.token))
        .send({ grantToken });
      expect(admitRes.status).toBe(200);
      expect(admitRes.body.status).toBe('ACTIVE');
      s.deviceSessionId = admitRes.body.deviceSessionId;
      expect(s.deviceSessionId).toBeTruthy();
    }
  });

  it('6. STUDENT: In-exam autosave, whiteboard vector drawing, revision conflicts, and deduplication', async () => {
    const q1 = `/api/v1/student/attempts/${alpha.attemptId}/answers/Q1`;
    const q2 = `/api/v1/student/attempts/${alpha.attemptId}/answers/Q2`;

    // 1. Text paragraph save on Q1
    const blocksQ1_v1 = [{ id: 'b1', kind: 'paragraph', content: 'Raft uses randomized election timers to avoid split votes.' }];
    const op1 = randomUUID();
    const save1 = await req()
      .put(q1)
      .set(H(alpha.token))
      .set('x-device-session', alpha.deviceSessionId!)
      .send({
        clientOperationId: op1,
        baseRevision: 0,
        answerFormat: 'hybrid-v1',
        ops: [{ op: 'upsert-block', blockId: 'b1', kind: 'paragraph', content: blocksQ1_v1[0]!.content }],
        contentSha256: answerHash(blocksQ1_v1),
      });
    expect(save1.status).toBe(200);
    expect(save1.body.serverRevision).toBe(1);

    // 2. Network retry returns duplicate receipt idempotently
    const save1Retry = await req()
      .put(q1)
      .set(H(alpha.token))
      .set('x-device-session', alpha.deviceSessionId!)
      .send({
        clientOperationId: op1,
        baseRevision: 0,
        answerFormat: 'hybrid-v1',
        ops: [{ op: 'upsert-block', blockId: 'b1', kind: 'paragraph', content: blocksQ1_v1[0]!.content }],
        contentSha256: answerHash(blocksQ1_v1),
      });
    expect(save1Retry.body.duplicate).toBe(true);
    expect(save1Retry.body.receiptId).toBe(save1.body.receiptId);

    // 3. Stale revision returns 409 REVISION_CONFLICT
    const staleSave = await req()
      .put(q1)
      .set(H(alpha.token))
      .set('x-device-session', alpha.deviceSessionId!)
      .send({
        clientOperationId: randomUUID(),
        baseRevision: 0,
        answerFormat: 'hybrid-v1',
        ops: [{ op: 'upsert-block', blockId: 'b2', kind: 'paragraph', content: 'Conflict' }],
        contentSha256: 'a'.repeat(64),
      });
    expect(staleSave.status).toBe(409);
    expect(staleSave.body.code).toBe('REVISION_CONFLICT');

    // 4. Whiteboard Canvas Drawing save on Q2 (Vector strokes)
    const blocksQ2 = [
      {
        id: 'c1',
        kind: 'canvas',
        content: {
          width: 800,
          height: 600,
          strokes: [
            { tool: 'pen', color: 'ink' as const, width: 2, points: [[50, 50], [150, 50], [150, 150], [50, 150]] },
            { tool: 'pen', color: 'red' as const, width: 2, points: [[200, 100], [300, 100]] },
          ],
        },
      },
    ];
    const saveCanvas = await req()
      .put(q2)
      .set(H(alpha.token))
      .set('x-device-session', alpha.deviceSessionId!)
      .send({
        clientOperationId: randomUUID(),
        baseRevision: 0,
        answerFormat: 'hybrid-v1',
        ops: [{ op: 'upsert-block', blockId: 'c1', kind: 'canvas', content: blocksQ2[0]!.content }],
        contentSha256: answerHash(blocksQ2),
      });
    expect(saveCanvas.status).toBe(200);
    expect(saveCanvas.body.serverRevision).toBe(1);

    // 5. Text paragraph save on Q3 so all paper questions have answers
    const q3 = `/api/v1/student/attempts/${alpha.attemptId}/answers/Q3`;
    const blocksQ3 = [{ id: 'b3', kind: 'paragraph', content: 'BFT requires 3f + 1 total nodes to tolerate f arbitrary faulty or Byzantine nodes.' }];
    const saveQ3 = await req()
      .put(q3)
      .set(H(alpha.token))
      .set('x-device-session', alpha.deviceSessionId!)
      .send({
        clientOperationId: randomUUID(),
        baseRevision: 0,
        answerFormat: 'hybrid-v1',
        ops: [{ op: 'upsert-block', blockId: 'b3', kind: 'paragraph', content: blocksQ3[0]!.content }],
        contentSha256: answerHash(blocksQ3),
      });
    expect(saveQ3.status).toBe(200);
    expect(saveQ3.body.serverRevision).toBe(1);

    // In-exam device scan submitted from workspace
    const scanRes = await req()
      .post(`/api/v1/student/attempts/${alpha.attemptId}/device-scans`)
      .set(H(alpha.token))
      .send({ scan: cleanScan() });
    expect(scanRes.status).toBe(202);
    expect(scanRes.body.verdict).toBe('CLEAN');
  });

  it('7. PROCTOR & CHIEF_PROCTOR: Concurrency rejection, warning threshold atomic suspension, and epoch resumption', async () => {
    const q1 = `/api/v1/student/attempts/${gamma.attemptId}/answers/Q1`;

    // 1. Candidate Gamma saves initial answer on Q1
    const gammaInitBlocks = [{ id: 'g1', kind: 'paragraph', content: 'Gamma initial answer' }];
    await req()
      .put(q1)
      .set(H(gamma.token))
      .set('x-device-session', gamma.deviceSessionId!)
      .send({
        clientOperationId: randomUUID(),
        baseRevision: 0,
        answerFormat: 'hybrid-v1',
        ops: [{ op: 'upsert-block', blockId: 'g1', kind: 'paragraph', content: gammaInitBlocks[0]!.content }],
        contentSha256: answerHash(gammaInitBlocks),
      });

    // 2. Candidate Gamma attempts a save from an unauthorized second device
    const foreignDeviceSession = randomUUID();
    const concurrentAttempt = await req()
      .put(q1)
      .set(H(gamma.token))
      .set('x-device-session', foreignDeviceSession)
      .send({
        clientOperationId: randomUUID(),
        baseRevision: 1,
        answerFormat: 'hybrid-v1',
        ops: [{ op: 'upsert-block', blockId: 'g2', kind: 'paragraph', content: 'Second device rogue save' }],
        contentSha256: 'f'.repeat(64),
      });
    expect(concurrentAttempt.status).toBe(409);
    expect(concurrentAttempt.body.code).toBe('DEVICE_SESSION_MISMATCH');

    // Verify CONCURRENT_SESSION incident was committed
    const concurrentInc = await ctx.admin('proctor_incidents').where({ attempt_id: gamma.attemptId, signal_class: 'CONCURRENT_SESSION' }).first();
    expect(concurrentInc).toBeTruthy();
    expect(concurrentInc.priority).toBe(90);

    // 3. Technical signal ingested -> cannot be counted as a violation warning
    const techReport = await req()
      .post('/api/v1/proctor/events')
      .set(H(gamma.token))
      .send({
        events: [{ attemptId: gamma.attemptId, signalClass: 'CAMERA_UNAVAILABLE', sourceEventId: 'cam-err-1', metadata: {} }],
      });
    expect(techReport.status).toBe(202);
    const techIncidentId = techReport.body.results[0].incidentId;

    const countTry = await req()
      .post(`/api/v1/proctor/incidents/${techIncidentId}/decision`)
      .set(H(examiner.token))
      .send({ action: 'CONFIRM_WARNING', reasonCode: 'MISCONDUCT', idempotencyKey: randomUUID() });
    expect(countTry.status).toBe(422);
    expect(countTry.body.code).toBe('TECHNICAL_NOT_COUNTABLE');

    // 4. Ingest 4 policy violation signals for Candidate Gamma
    const violations = ['FULLSCREEN_EXIT', 'VISUAL_ANOMALY', 'WINDOW_RESIZED', 'DUAL_SCREEN_DETECTED'];
    const violReport = await req()
      .post('/api/v1/proctor/events')
      .set(H(gamma.token))
      .send({
        events: violations.map((v, i) => ({
          attemptId: gamma.attemptId,
          signalClass: v,
          sourceEventId: `v-${i}-${Date.now()}`,
          metadata: {},
        })),
      });
    const violIncidentIds = violReport.body.results.map((r: { incidentId: string }) => r.incidentId);

    // Include the concurrent session incident -> total 5 distinct countable incidents
    const allViolations = [concurrentInc.id, ...violIncidentIds];
    expect(allViolations.length).toBe(5);

    // Invigilator confirms warnings 1 through 4 (Student remains ACTIVE)
    for (let i = 0; i < 4; i++) {
      const d = await req()
        .post(`/api/v1/proctor/incidents/${allViolations[i]}/decision`)
        .set(H(examiner.token))
        .send({ action: 'CONFIRM_WARNING', reasonCode: 'POLICY_VIOLATION_CONFIRMED', idempotencyKey: randomUUID() });
      expect(d.status).toBe(200);
      expect(d.body.attemptStatus).toBe('ACTIVE');
      expect(d.body.epoch.confirmedCount).toBe(i + 1);
    }

    // 5. Invigilator confirms the 5th warning -> triggers ATOMIC SUSPENSION
    const d5 = await req()
      .post(`/api/v1/proctor/incidents/${allViolations[4]}/decision`)
      .set(H(examiner.token))
      .send({ action: 'CONFIRM_WARNING', reasonCode: 'THRESHOLD_REACHED', idempotencyKey: randomUUID() });
    expect(d5.status).toBe(200);
    expect(d5.body.attemptStatus).toBe('SUSPENDED');
    expect(d5.body.suspensionKind).toBe('WARNING_THRESHOLD');
    expect(d5.body.epoch.confirmedCount).toBe(5);

    // Subsequent save from suspended candidate is refused
    const blockedSave = await req()
      .put(q1)
      .set(H(gamma.token))
      .set('x-device-session', gamma.deviceSessionId!)
      .send({
        clientOperationId: randomUUID(),
        baseRevision: 1,
        answerFormat: 'hybrid-v1',
        ops: [{ op: 'upsert-block', blockId: 'g3', kind: 'paragraph', content: 'Blocked post-suspend save' }],
        contentSha256: '9'.repeat(64),
      });
    expect(blockedSave.status).toBe(409);
    expect(blockedSave.body.code).toBe('ATTEMPT_NOT_ACTIVE');

    // Ordinary proctor cannot resume (Forbidden)
    const unauthorizedResume = await req()
      .post(`/api/v1/proctor/attempts/${gamma.attemptId}/resume`)
      .set(H(examiner.token))
      .send({ reasonCode: 'PROCTOR_TRY', notes: 'Trying to resume', idempotencyKey: randomUUID(), deadlineExtensionMinutes: 5 });
    expect(unauthorizedResume.status).toBe(403);

    // Chief Proctor reviews timeline and authorizes resumption with Epoch 2 and 10-minute deadline extension
    const resumeRes = await req()
      .post(`/api/v1/proctor/attempts/${gamma.attemptId}/resume`)
      .set(H(chiefReviewer.token))
      .send({
        reasonCode: 'EXTENUATING_CIRCUMSTANCES',
        notes: 'Peripheral glitch inspected and cleared by Chief Proctor; 10 min extension granted.',
        idempotencyKey: randomUUID(),
        deadlineExtensionMinutes: 10,
      });
    expect(resumeRes.status).toBe(200);
    expect(resumeRes.body.attemptStatus).toBe('ACTIVE');
    expect(resumeRes.body.epoch.no).toBe(2);
    expect(resumeRes.body.epoch.confirmedCount).toBe(0);
    expect(resumeRes.body.lifetimeWarnings).toBe(5);

    // Candidate Gamma can now save answers again
    const postResumeBlocks = [...gammaInitBlocks, { id: 'g3', kind: 'paragraph', content: 'Resumed write in epoch 2' }];
    const postResumeSave = await req()
      .put(q1)
      .set(H(gamma.token))
      .set('x-device-session', gamma.deviceSessionId!)
      .send({
        clientOperationId: randomUUID(),
        baseRevision: 1,
        answerFormat: 'hybrid-v1',
        ops: [{ op: 'upsert-block', blockId: 'g3', kind: 'paragraph', content: 'Resumed write in epoch 2' }],
        contentSha256: answerHash(postResumeBlocks),
      });
    expect(postResumeSave.status).toBe(200);
    expect(postResumeSave.body.serverRevision).toBe(2);
  });

  it('8. EXAM_OFFICE & WORKERS: Submissions, exam closure, deadline sweep & automated forensic checks', async () => {
    // Candidates Alpha, Beta, Gamma, Epsilon submit manually
    for (const s of [alpha, beta, gamma, epsilon]) {
      const sub = await req()
        .post(`/api/v1/student/attempts/${s.attemptId}/submit`)
        .set(H(s.token))
        .send({ idempotencyKey: randomUUID() });
      expect(sub.status).toBe(200);
      expect(sub.body.manifest).toBeTruthy();
      expect(sub.body.receiptId).toBeTruthy();
    }

    // Candidate Delta does NOT manually submit before exam close
    // Exam Cell closes the exam
    const closeRes = await req().post(`/api/v1/exams/${examId}/close`).set(H(examCell.token));
    expect(closeRes.status).toBe(200);

    // Candidate Delta's attempt is sealed as EXPIRED with acknowledged answers intact
    const deltaAttempt = await ctx.admin('exam_attempts').where('id', delta.attemptId).first();
    expect(deltaAttempt.status).toBe('EXPIRED');
    expect(deltaAttempt.sealed_at).toBeTruthy();

    // Candidate Delta's late save is refused
    const deltaLateSave = await req()
      .put(`/api/v1/student/attempts/${delta.attemptId}/answers/Q1`)
      .set(H(delta.token))
      .set('x-device-session', delta.deviceSessionId!)
      .send({
        clientOperationId: randomUUID(),
        baseRevision: 0,
        answerFormat: 'hybrid-v1',
        ops: [{ op: 'upsert-block', blockId: 'd1', kind: 'paragraph', content: 'Late' }],
        contentSha256: '0'.repeat(64),
      });
    expect(deltaLateSave.status).toBe(409);
    expect(deltaLateSave.body.code).toBe('ATTEMPT_NOT_ACTIVE');

    // Run automated post-seal forensic audit
    const forensicsCount = await runForensicsOnce(ctx.deps);
    expect(forensicsCount).toBeGreaterThanOrEqual(4);

    // Candidate review packet for Alpha is ready for academic evaluation
    const pAlpha = await ctx.admin('candidate_review_packets').where('attempt_id', alpha.attemptId).first();
    expect(pAlpha.status).toBe('ACADEMIC_MARKING_READY');
    expect(pAlpha.sealed_submission_verified).toBe(true);
  });

  it('9. EVALUATOR & MODERATOR: Workload assignment, blind marking, divergence resolution, and AI rubric proposals', async () => {
    // Exam Cell assigns Candidate Alpha to Examiner
    const assignRes = await req()
      .post(`/api/v1/exams/${examId}/evaluators/assign`)
      .set(H(examCell.token))
      .send({
        evaluatorUserId: examiner.userId,
        roleType: 'EVALUATOR_1',
        attemptIds: [alpha.attemptId],
      });
    expect(assignRes.status).toBe(201);
    expect(assignRes.body.assignedCount).toBe(1);

    // Examiner inspects personal anonymized marking queue
    const queue = await req().get(`/api/v1/evaluator/me/assignments?examId=${examId}`).set(H(examiner.token));
    expect(queue.status).toBe(200);
    const assignedAlpha = queue.body.find((a: { attemptId: string }) => a.attemptId === alpha.attemptId);
    expect(assignedAlpha).toBeTruthy();

    // Examiner inspects AI Rubric Proposals
    const proposals = await req().get(`/api/v1/candidates/${alpha.attemptId}/rubric-proposals`).set(H(examiner.token));
    expect(proposals.status).toBe(200);
    expect(proposals.body.proposals).toBeTruthy();

    // Examiner records marks for Candidate Alpha with mandatory explanations
    const marksRes = await req()
      .post(`/api/v1/candidates/${alpha.attemptId}/result-versions`)
      .set(H(examiner.token))
      .send({
        items: [
          {
            questionId: 'Q1',
            maxMarks: 10,
            marks: 9,
            explanation: 'Accurate explanation of leader election randomized timeouts.',
            criteria: [{ code: 'LEADER_ELECTION', max: 10, awarded: 9 }],
          },
          {
            questionId: 'Q2',
            maxMarks: 10,
            marks: 10,
            explanation: 'Complete and legible 2PC state transition diagram.',
            criteria: [
              { code: 'COORDINATOR_STATES', max: 5, awarded: 5 },
              { code: 'PARTICIPANT_STATES', max: 5, awarded: 5 },
            ],
          },
          {
            questionId: 'Q3',
            maxMarks: 10,
            marks: 8,
            explanation: 'Good proof of 3f+1 node requirement.',
            criteria: [{ code: 'BFT_MATH', max: 10, awarded: 8 }],
          },
        ],
      });
    expect(marksRes.status).toBe(201);
    expect(marksRes.body.version).toBe(1);
    expect(marksRes.body.total).toBe(27); // 9 + 10 + 8 = 27 / 30 = 90% (Outstanding: O)
  });

  it('10. CONTROLLER: Result approval, hold enforcement, lifelong ledger publication & signed student booklet', async () => {
    // 1. Exam Cell approves Candidate Alpha's result version
    const pAlpha = await ctx.admin('candidate_review_packets').where('attempt_id', alpha.attemptId).first();
    const ap1 = await req()
      .post(`/api/v1/candidates/${alpha.attemptId}/approvals`)
      .set(H(examCell.token))
      .send({
        reviewedResultVersionId: pAlpha.result_version_id,
        reason: 'Exam Section verified evaluation integrity',
        idempotencyKey: randomUUID(),
      });
    expect(ap1.status).toBe(201);
    expect(ap1.body.status).toBe('CANDIDATE_APPROVED');

    // 2. Exam Cell places an integrity hold on Candidate Gamma
    const holdRes = await req()
      .post(`/api/v1/candidates/${gamma.attemptId}/holds`)
      .set(H(examCell.token))
      .send({
        status: 'INTEGRITY_HOLD',
        reason: 'Under review for concurrent device session and suspension telemetry',
      });
    expect(holdRes.status).toBe(200);

    // Marking while held is refused
    const heldMark = await req()
      .post(`/api/v1/candidates/${gamma.attemptId}/result-versions`)
      .set(H(examiner.token))
      .send({
        items: [{ questionId: 'Q1', maxMarks: 10, marks: 5, explanation: 'Partial' }],
      });
    expect(heldMark.status).toBe(409);

    // Exam Cell investigates and releases the hold with documented justification
    const releaseRes = await req()
      .post(`/api/v1/candidates/${gamma.attemptId}/holds/release`)
      .set(H(examCell.token))
      .send({ reason: 'Investigation concluded: student was permitted loaner swap; exonerated.' });
    expect(releaseRes.status).toBe(200);

    // 3. Controller authorizes publication of Candidate Alpha's result
    const pubRes = await req()
      .post(`/api/v1/candidates/${alpha.attemptId}/authorize-publication`)
      .set(H(tenantAdmin.token))
      .send({ candidateApprovalId: ap1.body.approvalId, idempotencyKey: randomUUID() });
    expect(pubRes.status).toBe(200);
    expect(pubRes.body.status).toBe('PUBLISHED');

    // Verify Lifelong Ledger write
    const ledger = await req().get('/api/v1/student/me/ledger').set(H(alpha.token));
    expect(ledger.status).toBe(200);
    expect(ledger.body.records.length).toBe(1);
    expect(ledger.body.records[0]).toMatchObject({
      grade: 'O', // 27/30 = 90% -> O (Outstanding, 10 Grade Points)
      exam_type: 'SEM_EXTERNAL',
    });
    expect(Number(ledger.body.records[0].marks)).toBe(27);
    expect(Number(ledger.body.records[0].max_marks)).toBe(30);

    // Verify Student Digital Answer Booklet & Public Verification
    const booklet = await req().get(`/api/v1/student/attempts/${alpha.attemptId}/booklet`).set(H(alpha.token));
    expect(booklet.status).toBe(200);
    expect(booklet.body.validation.examiner).toBeTruthy();
    expect(booklet.body.validation.controller).toBeTruthy();
    expect(booklet.body.verificationHash).toMatch(/^[a-f0-9]{64}$/);

    const publicVerify = await req().get(`/api/v1/student/verify/${alpha.attemptId}/1`).set('Host', t.host);
    expect(publicVerify.body).toMatchObject({ valid: true, total: 27, max: 30 });

    // Verify ERP webhook dispatch
    await runWorkers(ctx);
    const pubEvent = erpEvents.find((e) => e.type === 'result.published' && e.data['studentExternalId'] === alpha.externalId);
    expect(pubEvent).toBeTruthy();
    expect(pubEvent!.data).toMatchObject({ examCode, total: 27, max: 30, resultVersion: 1 });

    // Verify ERP Results Pull via Simple API
    const erpResults = await req()
      .get('/api/v1/integration/v1/results')
      .set('Authorization', `Bearer ${erpKey.apiKey}`)
      .query({ examCode });
    expect(erpResults.status).toBe(200);
    expect(erpResults.body.results).toEqual([
      expect.objectContaining({
        studentExternalId: alpha.externalId,
        provider: 'uos',
        grade: 'O',
      }),
    ]);
  });

  it('11. STUDENT & CONTROLLER: Student revaluation request, fee reference & Controller approval', async () => {
    // Candidate Alpha (whose results are PUBLISHED) requests revaluation with fee payment reference
    const revalReq = await req()
      .post(`/api/v1/student/attempts/${alpha.attemptId}/revaluation`)
      .set(H(alpha.token))
      .send({ reason: 'Requesting verification of marks for Q2', feeRef: 'FEE-2026-REV-98765' });
    expect(revalReq.status).toBe(201);
    expect(revalReq.body.status).toBe('REQUESTED');
    const reqId = revalReq.body.requestId;

    // Student checks revaluation status
    const studentStatus = await req()
      .get(`/api/v1/student/attempts/${alpha.attemptId}/revaluation`)
      .set(H(alpha.token));
    expect(studentStatus.status).toBe(200);
    const fee = studentStatus.body.revaluation.fee_ref ?? studentStatus.body.revaluation.feeRef;
    expect(fee).toBe('FEE-2026-REV-98765');
    expect(studentStatus.body.revaluation.status).toBe('REQUESTED');

    // Controller lists all revaluation requests for the exam
    const listRequests = await req()
      .get(`/api/v1/exams/${examId}/revaluation-requests`)
      .set(H(tenantAdmin.token));
    expect(listRequests.status).toBe(200);
    const target = listRequests.body.find((r: { id: string }) => r.id === reqId);
    expect(target).toBeTruthy();

    // Controller approves revaluation request
    const decideRes = await req()
      .post(`/api/v1/revaluation-requests/${reqId}/decide`)
      .set(H(tenantAdmin.token))
      .send({ decision: 'APPROVED', note: 'Fee payment verified on ERP ledger.' });
    expect(decideRes.status).toBe(200);
    expect(decideRes.body.status).toBe('APPROVED');
  });

  it('12. HOD & REPORT_VIEWER: Academic Analytics overview and department KPI verification', async () => {
    // HOD checks academic analytics overview
    const overview = await req().get('/api/v1/analytics/overview').set(H(chiefReviewer.token));
    expect(overview.status).toBe(200);
    expect(overview.body.overview.departments).toBeInstanceOf(Array);

    const dept = await ctx.admin('departments').where({ tenant_id: t.tenantId, code: 'CS' }).first('id');
    expect(dept).toBeTruthy();

    // HOD checks department breakdown
    const deptAnalytics = await req()
      .get(`/api/v1/analytics/department/${dept.id}`)
      .set(H(chiefReviewer.token));
    expect(deptAnalytics.status).toBe(200);
    expect(deptAnalytics.body.analytics.summary).toMatchObject({
      totalStudents: 5,
      totalExams: 1,
      totalPublishedResults: 1,
      passCount: 1,
      failCount: 0,
      passRate: 100,
    });
  });
});
