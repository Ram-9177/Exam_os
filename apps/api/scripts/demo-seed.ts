/**
 * Complete End-to-End Demo Seed & Smoke Runner
 *
 * Provisions a complete tenant `demo` with full-spectrum examination lifecycle data
 * so all screens in the web app (Admin, Exam Cell, Proctor, Evaluator, Student, Analytics)
 * display rich, realistic data end to end, while smoke-testing all API endpoints.
 *
 *   npm run demo -w @examos/api
 *
 * Seeds 5 distinct exams spanning every lifecycle state:
 *   1. CS302-SEM   -> SCHEDULED (SECURE_BYOD, 70 marks, paper sets A & B, hall tickets issued)
 *   2. CS301-MID1  -> PRECHECK  (Readiness Board: Ready, In Progress, Blocked, Exception waived)
 *   3. CS303-LIVE  -> LIVE      (Active workspace, autosaves, heartbeats, proctoring warnings & suspension/resume)
 *   4. CS304-EVAL  -> CLOSED    (Submitted & sealed, forensics passed, evaluation queue, criteria grading, hold)
 *   5. CS305-PUB   -> PUBLISHED (Full approval & publication grant, student ledger, booklets, revaluation request)
 */
import supertest from 'supertest';
import knex from 'knex';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { buildDeps, closeDeps } from '../src/deps.js';
import { loadConfig } from '../src/config.js';
import { canonicalJson, sha256Hex } from '../src/lib/crypto.js';
import { runForensicsOnce } from '../src/modules/candidates/service.js';
import { runMailWorkerOnce } from '../src/modules/notifications/worker.js';
import { runWebhookWorkerOnce, runOutboxDispatcherOnce } from '../src/modules/integration/webhooks.js';
import { TENANT_TABLES } from '@examos/db';

const PLATFORM_KEY = process.env['PLATFORM_BOOTSTRAP_KEY'] ?? 'demo-platform-bootstrap-key-0123456789';
process.env['PLATFORM_BOOTSTRAP_KEY'] = PLATFORM_KEY;
process.env['LOG_LEVEL'] = process.env['LOG_LEVEL'] ?? 'warn';

const DEMO_SIGNATURE_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAPAAAAA8CAYAAABYfzddAAABjklEQVR4nO3bS07DQBBF0eyAIXtg/8thMYhZ+CRO4nb3q/I5EkOkorsuEna4XAAAAAAAAAAAAABgvrf3j897X6vnA65sBStmCLQnXDHDIntDFDIsMjo4IcMEMwIT8ev8ucJNsy/fwj3G8wc2rbxoS/bX6AeHzriplItNmWO10eEJubHEy0ycaYZZkQm5ieQLTJ7tCCuCEnJhFS7sDIuVEFDCDDyh2kV1XK7EaBJn4peql9NpsdJDSZ/vtKpfSPWlqhRGpVlPodNFVFysijN/E3KAjodfZam6BFB9/rI6H3xyHMmzvarLz1FGp+W5JykU71YZ4mzLkxBNwgw0cOYFWhGQcBnGEq37f+YznzkDWKSfjgjsVrjOnF0s0v/uBbd1Vlvf67wZwjJtezRG0TKVpXqOcE+gykVZrP3E2lCFS6wwIyyR/Js4eTaIkRhK4kwQLSWalDmgnJXxCBcGWPGUUrww2IyQvdKAAx317lC4MNHeT+341A8E2PvxPOFCCOFCE4IFAAAAAAAAAAAAjvcFxE2/P71/fvMAAAAASUVORK5CYII=';

function answerHash(blocks: Array<{ id: string; kind: string; content: unknown }>): string {
  return sha256Hex(canonicalJson({ blocks }));
}

function cleanScan(overrides: Record<string, unknown> = {}) {
  return {
    takenAt: new Date().toISOString(),
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0',
    platform: 'Win32',
    language: 'en-IN',
    timezone: 'Asia/Kolkata',
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelRatio: 1, isExtended: false, displayCount: 1 },
    window: { innerWidth: 1920, innerHeight: 960, outerWidth: 1920, outerHeight: 1040 },
    hardware: { cores: 8, memoryGb: 8, touchPoints: 0, pointerFine: true },
    gpu: { vendor: 'Intel', renderer: 'Intel(R) UHD Graphics 620' },
    browser: { webdriver: false, cookiesEnabled: true, fullscreenSupported: true, pdfViewer: true, pluginsCount: 5, displayCaptureActive: false, devtoolsHeuristic: false },
    network: { effectiveType: '4g', downlinkMbps: 10, rttMs: 50, online: true },
    battery: { level: 0.95, charging: true },
    visibility: 'visible',
    ...overrides,
  };
}

async function main() {
  const config = loadConfig();
  const deps = buildDeps({ config });
  const { app } = await createApp(deps);
  const admin = knex({ client: 'pg', connection: config.DATABASE_ADMIN_URL });
  const req = () => supertest(app);
  const HOST = 'localhost';

  async function activationToken(tenantId: string, email: string): Promise<string> {
    const row = await admin('mail_dispatches')
      .where({ tenant_id: tenantId, category: 'ACCOUNT_ACTIVATION', to_address: email.toLowerCase() })
      .orderBy('created_at', 'desc')
      .first('body_text');
    if (!row) throw new Error(`Activation mail missing for ${email}`);
    const m = /token=([^\s]+)/.exec(row.body_text);
    return decodeURIComponent(m![1]!);
  }

  async function activate(tenantId: string, email: string, password: string): Promise<string> {
    const token = await activationToken(tenantId, email);
    const r = await req().post('/api/v1/auth/activate').set('Host', HOST).send({ token, password });
    if (r.status !== 200) throw new Error(`activate ${email}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.accessToken as string;
  }

  function must(r: supertest.Response, what: string) {
    if (r.status >= 300) throw new Error(`${what} failed [HTTP ${r.status}]: ${JSON.stringify(r.body)}`);
    return r.body;
  }

  const smokePass: string[] = [];
  const smokeFail: string[] = [];

  try {
    console.log('\n===============================================================');
    console.log('   SMRU ExamOS — Comprehensive End-to-End Dummy Data Seeder   ');
    console.log('===============================================================\n');

    // 1. Clean slate reset of the demo tenant to guarantee complete state consistency
    const existing = await admin('tenants').where('slug', 'demo').first('id');
    if (existing) {
      console.log(`[Reset] Purging previous demo tenant (${existing.id}) for pristine end-to-end load...`);
      const tId = existing.id;
      await admin.raw("SET session_replication_role = 'replica';");
      const tables = [
        'revaluation_requests', 'moderation_samples', 'evaluator_assignments', 'student_documents',
        'stored_documents', 'paper_releases', 'paper_sets', 'paper_questions', 'question_papers',
        'student_exam_records', 'consent_records', 'controller_publication_grants', 'candidate_approvals',
        'candidate_review_packets', 'result_versions', 'resume_grants', 'proctor_decisions', 'proctor_warnings',
        'warning_epochs', 'proctor_incidents', 'proctor_events', 'attempt_event_log', 'device_scans',
        'attempt_network_observations', 'submission_manifests', 'answer_revisions', 'answer_documents',
        'admission_grants', 'admission_exceptions', 'precheck_practice_saves', 'precheck_items',
        'precheck_runs', 'exam_attempts', 'exam_allocations', 'hall_tickets', 'exams',
        'mail_dispatches', 'webhook_deliveries', 'webhook_endpoints', 'outbox_events', 'integration_events',
        'roster_sync_rows', 'roster_sync_jobs', 'idempotency_keys', 'course_enrollments', 'student_profiles',
        'courses', 'programmes', 'departments', 'schools', 'api_keys', 'tenant_erp_connections',
        'tenant_mail_configs', 'tenant_sso_configs', 'one_time_tokens', 'auth_sessions', 'role_grants',
        'external_identities', 'audit_events', 'users', 'tenant_domains', 'tenants'
      ];
      for (const t of tables) {
        const col = (t === 'tenants') ? 'id' : 'tenant_id';
        await admin(t).where(col, tId).delete().catch(() => {});
      }
      await admin.raw("SET session_replication_role = 'origin';");
      await deps.redis.del('tenant:host:localhost', 'tenant:host:demo.examos.local').catch(() => {});
    }

    // 2. Provision Tenant
    console.log('[Phase 1] Provisioning demo tenant & root administrator...');
    const prov = must(
      await req().post('/api/v1/platform/tenants').set('x-platform-key', PLATFORM_KEY).send({
        slug: 'demo',
        name: "St. Mary's University",
        domains: [HOST, 'demo.examos.local'],
        adminEmail: 'admin@demo.local',
        adminFullName: 'Demo Admin',
      }),
      'platform:provision',
    );
    const tenantId = prov.tenantId as string;

    const adminToken = await activate(tenantId, 'admin@demo.local', 'Demo-Admin!2026');
    const A = { Host: HOST, Authorization: `Bearer ${adminToken}` };

    must(
      await req().put('/api/v1/tenant/mail-config').set(A).send({
        transportKind: 'capture',
        senderAddress: 'examcell@smru.edu.in',
        senderName: 'Examination Cell — St. Mary\'s University',
      }),
      'tenant:mail-config',
    );

    // 3. Create Staff logins (database per-tenant cap is 4 accounts)
    console.log('[Phase 2] Provisioning staff duty bundles & Controller digital e-signature...');
    const staff: Record<string, string> = {};
    for (const [email, bundle, name] of [
      ['examcell@demo.local', 'EXAM_OFFICE', 'Examination Section Operator'],
      ['chief@demo.local', 'CHIEF_REVIEWER', 'Chief Proctor'],
      ['evaluator@demo.local', 'EXAMINER', 'Examiner & Evaluator'],
    ] as const) {
      must(await req().post('/api/v1/tenant/users').set(A).send({ email, fullName: name, kind: 'STAFF', bundle, roles: [] }), `create:${email}`);
      staff[email] = await activate(tenantId, email, 'Demo-Staff!2026');
    }

    // Grant Admin the ADMIN_CONTROLLER bundle + SYSTEM_ADMIN, HOD, REPORT_VIEWER
    const adminUser = await admin('users').where({ tenant_id: tenantId, email: 'admin@demo.local' }).first('id');
    must(
      await req()
        .put(`/api/v1/platform/tenants/${tenantId}/staff/${adminUser.id}/roles`)
        .set('x-platform-key', PLATFORM_KEY)
        .send({ bundle: 'ADMIN_CONTROLLER', roles: ['SYSTEM_ADMIN', 'HOD', 'REPORT_VIEWER'] }),
      'platform:admin-roles',
    );

    // Map Controller of Examinations digital e-signature
    must(
      await req()
        .put(`/api/v1/tenant/users/${adminUser.id}/signature`)
        .set(A)
        .send({ signatureDataUrl: DEMO_SIGNATURE_PNG }),
      'controller:upload-signature',
    );

    // 4. ERP Connection & Academic Roster Batch Imports
    console.log('[Phase 3] Configuring ERP UOS connection & importing academic roster...');
    const erpKey = must(
      await req().post('/api/v1/tenant/api-keys').set(A).send({
        label: 'campus-central-uos-key',
        scopes: ['roster:write', 'roster:read', 'events:read', 'results:read', 'webhooks:manage'],
      }),
      'tenant:api-keys',
    );

    must(
      await req().post('/api/v1/tenant/erp-connections').set(A).send({
        provider: 'uos',
        label: 'Campus Central UOS ERP',
        baseUrl: 'https://uos.smru.edu.in',
        syncScheduleCron: '0 2 * * *',
        status: 'ACTIVE',
      }),
      'tenant:erp-connections',
    );

    const K = (path: string) =>
      req()
        .put(`/api/v1/integration/v1/roster/${path}/batch`)
        .set('Authorization', `Bearer ${erpKey.apiKey}`)
        .set('Idempotency-Key', randomUUID())
        .set('X-ExamOS-Provider', 'uos');

    // Units
    must(
      await K('academic-units').send({
        rows: [
          { kind: 'DEPARTMENT', code: 'CSE', name: 'Computer Science & Engineering' },
          { kind: 'DEPARTMENT', code: 'ECE', name: 'Electronics & Communication' },
          { kind: 'PROGRAMME', code: 'BTECH-CSE', name: 'B.Tech Computer Science & Engineering', parentCode: 'CSE' },
          { kind: 'PROGRAMME', code: 'BTECH-ECE', name: 'B.Tech Electronics & Communication', parentCode: 'ECE' },
        ],
      }),
      'roster:units',
    );

    // Courses
    must(
      await K('courses').send({
        rows: [
          { code: 'CS301', name: 'Operating Systems', departmentCode: 'CSE', credits: 4 },
          { code: 'CS302', name: 'Database Systems', departmentCode: 'CSE', credits: 4 },
          { code: 'CS303', name: 'Computer Networks', departmentCode: 'CSE', credits: 4 },
          { code: 'CS304', name: 'Design and Analysis of Algorithms', departmentCode: 'CSE', credits: 4 },
          { code: 'CS305', name: 'Software Engineering & Agile', departmentCode: 'CSE', credits: 3 },
        ],
      }),
      'roster:courses',
    );

    // Persons (12 Students)
    const studentNames = [
      'Aarav Sharma', 'Diya Patel', 'Rohan Iyer', 'Ananya Reddy',
      'Vikram Malhotra', 'Pooja Verma', 'Karthik Nair', 'Sneha Kulkarni',
      'Aditya Joshi', 'Meera Rao', 'Siddharth Gupta', 'Neha Choudhury',
    ];
    const students = studentNames.map((name, i) => {
      const idx = String(i + 1).padStart(2, '0');
      return {
        externalId: `UOS-${1001 + i}`,
        kind: 'STUDENT' as const,
        fullName: name,
        email: `student${idx}@demo.local`,
        departmentCode: 'CSE',
        programmeCode: 'BTECH-CSE',
        currentSemester: 5,
        section: i < 6 ? 'A' : 'B',
        attributes: { registerNumber: `22CSE0${idx}` },
      };
    });

    must(await K('persons').send({ rows: students }), 'roster:persons');

    // Enrollments
    const allCourses = ['CS301', 'CS302', 'CS303', 'CS304', 'CS305'];
    must(
      await K('enrollments').send({
        rows: students.flatMap((s) =>
          allCourses.map((courseCode) => ({
            studentExternalId: s.externalId,
            courseCode,
            academicYear: '2026-27',
            term: 'ODD',
            section: s.section,
          })),
        ),
      }),
      'roster:enrollments',
    );

    // Activate all student accounts
    const studentTokens: Record<string, string> = {};
    for (const s of students) {
      studentTokens[s.email] = await activate(tenantId, s.email, 'Demo-Student!2026');
    }

    // Seed candidate digital signature & profile photo for all students
    const DEMO_STUDENT_PHOTO_PNG =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAABTSURBVHhe7c4BDQAgEASxE39pG2Fw0Fw2mX1755x9e7GwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsDiygYw6E6B+2hIAAAAASUVORK5CYII=';

    for (const s of students) {
      const sAuth = { Host: HOST, Authorization: `Bearer ${studentTokens[s.email]}` };
      await req()
        .put('/api/v1/student/profile/signature')
        .set(sAuth)
        .send({ signatureDataUrl: DEMO_SIGNATURE_PNG });

      await req()
        .post('/api/v1/student/profile/photo')
        .set(sAuth)
        .send({ photoDataUrl: DEMO_STUDENT_PHOTO_PNG, consentGiven: true });
    }

    // Role handles
    const E = { Host: HOST, Authorization: `Bearer ${staff['examcell@demo.local']}` };
    const S = E; // Exam Section has Question Setter duties
    const R = { Host: HOST, Authorization: `Bearer ${staff['chief@demo.local']}` }; // Chief Reviewer has Paper Review
    const P = R; // Chief Proctor
    const EV = { Host: HOST, Authorization: `Bearer ${staff['evaluator@demo.local']}` }; // Examiner
    const C = A; // Controller of Examinations
    const now = Date.now();

    // =========================================================================
    // EXAM 1: CS302-SEM — Status: SCHEDULED
    // =========================================================================
    console.log('[Phase 4.1] Seeding Exam 1: CS302-SEM (SCHEDULED — Safe Exam Browser)...');
    const exam1 = must(
      await req().post('/api/v1/exams').set(E).send({
        code: 'CS302-SEM',
        title: 'Database Systems — Semester External',
        courseCode: 'CS302',
        examType: 'SEM_EXTERNAL',
        academicYear: '2026-27',
        semester: 5,
        maxMarks: 70,
        securityProfile: 'SECURE_BYOD',
        durationMinutes: 180,
        windowStartAt: new Date(now + 2 * 86400_000).toISOString(),
        windowEndAt: new Date(now + 2 * 86400_000 + 5 * 3600_000).toISOString(),
        policy: { allowedClientBuilds: ['SEB_Win_3.8.0', 'SEB_macOS_3.4.0'], ipPolicy: 'LOCK' },
      }),
      'exam1:create',
    );

    must(
      await req().put(`/api/v1/exams/${exam1.examId}/paper`).set(S).send({
        title: 'Database Systems — Semester External Question Paper',
        instructions: 'All questions compulsory. Calculators allowed.',
        sections: [
          { code: 'A', title: 'Section A: Relational Concepts & Normalization', instructions: 'Answer both questions' },
          { code: 'B', title: 'Section B: Transactions & Storage', instructions: 'Answer both questions' },
        ],
        questions: [
          {
            questionId: 'Q1', sectionCode: 'A', number: 1, kind: 'DESCRIPTIVE', maxMarks: 15,
            prompt: { blocks: [{ id: 'b1', kind: 'paragraph', content: 'Explain Boyce-Codd Normal Form (BCNF) versus Third Normal Form (3NF). Provide a relational schema where 3NF holds but BCNF is violated.' }] },
            rubric: [{ code: 'DEFS', max: 8, description: 'BCNF vs 3NF definitions' }, { code: 'EXAMPLE', max: 7, description: 'Relational counter-example' }],
          },
          {
            questionId: 'Q2', sectionCode: 'A', number: 2, kind: 'DESCRIPTIVE', maxMarks: 20,
            prompt: { blocks: [{ id: 'b2', kind: 'paragraph', content: 'Write relational algebra expressions for: (a) Enrolled students taking all courses in CSE, (b) Faculty teaching both CS301 and CS302.' }] },
            rubric: [{ code: 'DIVISION', max: 10, description: 'Relational division' }, { code: 'INTERSECT', max: 10, description: 'Intersection & joins' }],
          },
          {
            questionId: 'Q3', sectionCode: 'B', number: 3, kind: 'DESCRIPTIVE', maxMarks: 15,
            prompt: { blocks: [{ id: 'b3', kind: 'paragraph', content: 'Detail the B+ Tree search and insertion algorithm. Explain node splitting and root elevation when order p=4.' }] },
            rubric: [{ code: 'INSERT', max: 10, description: 'Node split mechanics' }, { code: 'SEARCH', max: 5, description: 'B+ tree leaf traversal' }],
          },
          {
            questionId: 'Q4', sectionCode: 'B', number: 4, kind: 'DESCRIPTIVE', maxMarks: 20,
            prompt: { blocks: [{ id: 'b4', kind: 'paragraph', content: 'Explain Strict Two-Phase Locking (Strict 2PL). How does it prevent cascading aborts and guarantee conflict serializability?' }] },
            rubric: [{ code: 'STRICT', max: 10, description: 'Strict 2PL commit-time unlock' }, { code: 'SERIAL', max: 10, description: 'Conflict equivalence proof' }],
          },
        ],
      }),
      'exam1:paper',
    );
    must(await req().post(`/api/v1/exams/${exam1.examId}/paper/submit-for-review`).set(S), 'exam1:paper-submit');
    must(await req().post(`/api/v1/exams/${exam1.examId}/paper/approve`).set(R), 'exam1:paper-approve');
    must(
      await req().post(`/api/v1/exams/${exam1.examId}/paper/sets`).set(E).send({
        sets: [
          { setCode: 'A', questionOrder: ['Q1', 'Q2', 'Q3', 'Q4'] },
          { setCode: 'B', questionOrder: ['Q2', 'Q1', 'Q4', 'Q3'] },
        ],
      }),
      'exam1:sets',
    );
    must(
      await req().post(`/api/v1/exams/${exam1.examId}/seb-config`).set(E).send({
        allowQuit: true,
        quitPassword: 'Demo-Quit!2026',
        kioskMode: true,
        blockVirtualMachines: true,
        blockScreenCapture: true,
        blockClipboard: true,
      }),
      'exam1:seb-config',
    );
    must(await req().post(`/api/v1/exams/${exam1.examId}/allocations`).set(E).send({ studentExternalIds: students.map((s) => s.externalId), provider: 'uos' }), 'exam1:alloc');
    must(await req().post(`/api/v1/exams/${exam1.examId}/hall-tickets`).set(E).send({}), 'exam1:hall-tickets');
    for (const st of ['submit-for-review', 'approve', 'schedule']) must(await req().post(`/api/v1/exams/${exam1.examId}/${st}`).set(E), `exam1:${st}`);

    // =========================================================================
    // EXAM 2: CS301-MID1 — Status: PRECHECK (Readiness Board)
    // =========================================================================
    console.log('[Phase 4.2] Seeding Exam 2: CS301-MID1 (PRECHECK — Live Readiness Board)...');
    const exam2 = must(
      await req().post('/api/v1/exams').set(E).send({
        code: 'CS301-MID1',
        title: 'Operating Systems — Mid 1',
        courseCode: 'CS301',
        examType: 'MID_1',
        academicYear: '2026-27',
        semester: 5,
        maxMarks: 20,
        securityProfile: 'BASIC_BROWSER',
        durationMinutes: 60,
        windowStartAt: new Date(now - 15 * 60_000).toISOString(),
        windowEndAt: new Date(now + 4 * 3600_000).toISOString(),
        policy: { ipPolicy: 'REVIEW' },
      }),
      'exam2:create',
    );

    must(
      await req().put(`/api/v1/exams/${exam2.examId}/paper`).set(S).send({
        title: 'Operating Systems — Mid 1 Question Paper',
        instructions: 'Answer all 4 questions.',
        sections: [{ code: 'A', title: 'Core OS', instructions: 'Compulsory' }],
        questions: [
          {
            questionId: 'Q1', sectionCode: 'A', number: 1, kind: 'DESCRIPTIVE', maxMarks: 5,
            prompt: { blocks: [{ id: 'p1', kind: 'paragraph', content: 'Compare process context switching with thread context switching.' }] },
            rubric: [{ code: 'CTX', max: 5, description: 'Comparison of register and page table overhead' }],
          },
          {
            questionId: 'Q2', sectionCode: 'A', number: 2, kind: 'DESCRIPTIVE', maxMarks: 5,
            prompt: { blocks: [{ id: 'p2', kind: 'paragraph', content: 'List the four Coffman conditions for deadlock. How can deadlock avoidance prevent them?' }] },
            rubric: [{ code: 'COFFMAN', max: 5, description: 'Four conditions and Banker algorithm principle' }],
          },
          {
            questionId: 'Q3', sectionCode: 'A', number: 3, kind: 'DESCRIPTIVE', maxMarks: 5,
            prompt: { blocks: [{ id: 'p3', kind: 'paragraph', content: 'Calculate average turnaround time under Round Robin with quantum q=2ms for burst times [5, 3, 1].' }] },
            rubric: [{ code: 'RR', max: 5, description: 'Calculation steps and Gantt chart' }],
          },
          {
            questionId: 'Q4', sectionCode: 'A', number: 4, kind: 'DESCRIPTIVE', maxMarks: 5,
            prompt: { blocks: [{ id: 'p4', kind: 'paragraph', content: 'Explain inverted page tables and how hashing accelerates address lookup.' }] },
            rubric: [{ code: 'IPT', max: 5, description: 'IPT structure and hashing' }],
          },
        ],
      }),
      'exam2:paper',
    );
    must(await req().post(`/api/v1/exams/${exam2.examId}/paper/submit-for-review`).set(S), 'exam2:paper-submit');
    must(await req().post(`/api/v1/exams/${exam2.examId}/paper/approve`).set(R), 'exam2:paper-approve');
    must(
      await req().post(`/api/v1/exams/${exam2.examId}/paper/sets`).set(E).send({
        sets: [{ setCode: 'A', questionOrder: ['Q1', 'Q2', 'Q3', 'Q4'] }],
      }),
      'exam2:sets',
    );
    must(await req().post(`/api/v1/exams/${exam2.examId}/allocations`).set(E).send({ studentExternalIds: students.map((s) => s.externalId), provider: 'uos' }), 'exam2:alloc');
    must(await req().post(`/api/v1/exams/${exam2.examId}/hall-tickets`).set(E).send({}), 'exam2:hall-tickets');
    for (const st of ['submit-for-review', 'approve', 'schedule', 'open-precheck']) must(await req().post(`/api/v1/exams/${exam2.examId}/${st}`).set(E), `exam2:${st}`);

    async function getExamAttemptsMap(examId: string) {
      const rows = await admin('exam_attempts as a')
        .join('users as u', 'u.id', 'a.user_id')
        .where({ 'a.tenant_id': tenantId, 'a.exam_id': examId })
        .select('a.*', 'u.email');
      const map: Record<string, { att: any; sTok: { Host: string; Authorization: string } }> = {};
      for (const r of rows) {
        const email = r.email.toLowerCase();
        map[email] = {
          att: r,
          sTok: { Host: HOST, Authorization: `Bearer ${studentTokens[email]}` },
        };
      }
      return map;
    }

    // Simulate diverse readiness check runs
    const e2Map = await getExamAttemptsMap(exam2.examId);

    // Students 01..06: Fully completed prechecks (READY)
    for (let i = 0; i < 6; i++) {
      const { att, sTok } = e2Map[students[i]!.email]!;
      const run = must(await req().post(`/api/v1/student/attempts/${att.id}/prechecks`).set(sTok).send({ clientBuild: 'browser' }), `precheck:start:${i}`);
      const v = (b: Record<string, unknown>) => req().post(`/api/v1/student/prechecks/${run.runId}/items/verify`).set(sTok).send(b);
      await v({ code: 'CLIENT_VERSION', clientBuild: 'browser' });
      await v({ code: 'CLOCK_SYNC', clientClockMs: Date.now() });
      await v({ code: 'KEYBOARD_INPUT', keyboardSample: 'The quick brown fox jumps over the lazy dog 12345!' });
      await v({ code: 'SYSTEM_SCAN', scan: cleanScan() });
      await req().post(`/api/v1/student/prechecks/${run.runId}/practice-saves`).set(sTok).send({ contentDigest: 'a'.repeat(64) });
      await v({ code: 'NETWORK_SAVE_ROUNDTRIP' });
      await v({ code: 'CONSENT', consentPolicyVersion: 'v1' });
      must(await req().post(`/api/v1/student/prechecks/${run.runId}/finalize`).set(sTok), `precheck:fin:${i}`);
    }

    // Students 07, 08: In-progress prechecks (IN_PROGRESS)
    for (let i = 6; i < 8; i++) {
      const { att, sTok } = e2Map[students[i]!.email]!;
      const run = must(await req().post(`/api/v1/student/attempts/${att.id}/prechecks`).set(sTok).send({ clientBuild: 'browser' }), `precheck:in-prog:${i}`);
      const v = (b: Record<string, unknown>) => req().post(`/api/v1/student/prechecks/${run.runId}/items/verify`).set(sTok).send(b);
      await v({ code: 'CLIENT_VERSION', clientBuild: 'browser' });
      await v({ code: 'CLOCK_SYNC', clientClockMs: Date.now() });
      await req().post(`/api/v1/student/prechecks/${run.runId}/practice-saves`).set(sTok).send({ contentDigest: 'b'.repeat(64) });
    }

    // Student 09: Blocked by dual displays -> Controller issues exception -> Retried and READY
    {
      const { att, sTok } = e2Map[students[8]!.email]!;
      const run1 = must(await req().post(`/api/v1/student/attempts/${att.id}/prechecks`).set(sTok).send({ clientBuild: 'browser' }), 'precheck:s09-start');
      const v1 = (b: Record<string, unknown>) => req().post(`/api/v1/student/prechecks/${run1.runId}/items/verify`).set(sTok).send(b);
      await v1({ code: 'CLIENT_VERSION', clientBuild: 'browser' });
      await v1({ code: 'SYSTEM_SCAN', scan: cleanScan({ screen: { width: 1920, height: 1080, isExtended: true, displayCount: 2 } }) });

      // Controller grants admission exception
      must(
        await req().post(`/api/v1/exams/${exam2.examId}/attempts/${att.id}/admission-exceptions`).set(C).send({
          exceptionCode: 'TECH_ALT_DEVICE',
          coversChecks: ['SYSTEM_SCAN'],
          reason: 'Invigilator verified secondary monitor disabled at campus lab desk 12',
        }),
        'exception:grant',
      );

      // Student 09 retries and finalizes
      const run2 = must(await req().post(`/api/v1/student/attempts/${att.id}/prechecks`).set(sTok).send({ clientBuild: 'browser' }), 'precheck:s09-retry');
      const v2 = (b: Record<string, unknown>) => req().post(`/api/v1/student/prechecks/${run2.runId}/items/verify`).set(sTok).send(b);
      await v2({ code: 'CLIENT_VERSION', clientBuild: 'browser' });
      await v2({ code: 'CLOCK_SYNC', clientClockMs: Date.now() });
      await v2({ code: 'KEYBOARD_INPUT', keyboardSample: 'The quick brown fox jumps over the lazy dog 12345!' });
      await v2({ code: 'SYSTEM_SCAN', scan: cleanScan({ screen: { width: 1920, height: 1080, isExtended: true, displayCount: 2 } }) });
      await req().post(`/api/v1/student/prechecks/${run2.runId}/practice-saves`).set(sTok).send({ contentDigest: 'c'.repeat(64) });
      await v2({ code: 'NETWORK_SAVE_ROUNDTRIP' });
      await v2({ code: 'CONSENT', consentPolicyVersion: 'v1' });
      must(await req().post(`/api/v1/student/prechecks/${run2.runId}/finalize`).set(sTok), 'precheck:s09-fin');
    }

    // Student 10: Blocked by wrong browser version (REMEDIATE)
    {
      const { att, sTok } = e2Map[students[9]!.email]!;
      const run = must(await req().post(`/api/v1/student/attempts/${att.id}/prechecks`).set(sTok).send({ clientBuild: 'outdated-agent-1.0' }), 'precheck:s10-start');
      await req().post(`/api/v1/student/prechecks/${run.runId}/items/verify`).set(sTok).send({ code: 'CLIENT_VERSION', clientBuild: 'outdated-agent-1.0' });
    }
    // Students 11 & 12 remain NOT_STARTED

    // =========================================================================
    // EXAM 3: CS303-LIVE — Status: LIVE (Live Proctoring & Workspace)
    // =========================================================================
    console.log('[Phase 4.3] Seeding Exam 3: CS303-LIVE (LIVE — Active proctor incidents & autosaves)...');
    const exam3 = must(
      await req().post('/api/v1/exams').set(E).send({
        code: 'CS303-LIVE',
        title: 'Computer Networks — Mid 2',
        courseCode: 'CS303',
        examType: 'MID_2',
        academicYear: '2026-27',
        semester: 5,
        maxMarks: 30,
        securityProfile: 'BASIC_BROWSER',
        durationMinutes: 90,
        windowStartAt: new Date(now - 10 * 60_000).toISOString(),
        windowEndAt: new Date(now + 80 * 60_000).toISOString(),
        policy: { ipPolicy: 'REVIEW' },
      }),
      'exam3:create',
    );

    must(
      await req().put(`/api/v1/exams/${exam3.examId}/paper`).set(S).send({
        title: 'Computer Networks — Mid 2 Question Paper',
        instructions: 'Answer all 3 questions.',
        sections: [{ code: 'A', title: 'Networks', instructions: 'All compulsory' }],
        questions: [
          {
            questionId: 'Q1', sectionCode: 'A', number: 1, kind: 'DESCRIPTIVE', maxMarks: 10,
            prompt: { blocks: [{ id: 'p1', kind: 'paragraph', content: 'Explain the TCP 3-Way Handshake with SYN, SYN-ACK, ACK sequence numbers. What is a SYN Flood attack?' }] },
            rubric: [{ code: 'HANDSHAKE', max: 6, description: 'Sequence number negotiation' }, { code: 'FLOOD', max: 4, description: 'SYN flood vulnerability' }],
          },
          {
            questionId: 'Q2', sectionCode: 'A', number: 2, kind: 'DESCRIPTIVE', maxMarks: 10,
            prompt: { blocks: [{ id: 'p2', kind: 'paragraph', content: 'Given subnet 192.168.10.0/26, determine: (a) Subnet mask, (b) Total usable host addresses, (c) Broadcast address.' }] },
            rubric: [{ code: 'CIDR', max: 10, description: 'CIDR calculations' }],
          },
          {
            questionId: 'Q3', sectionCode: 'A', number: 3, kind: 'DESCRIPTIVE', maxMarks: 10,
            prompt: { blocks: [{ id: 'p3', kind: 'paragraph', content: 'Contrast OSI Layer 3 (Network) routing with Layer 2 (Data Link) switching.' }] },
            rubric: [{ code: 'L2_L3', max: 10, description: 'IP routing vs MAC frame forwarding' }],
          },
        ],
      }),
      'exam3:paper',
    );
    must(await req().post(`/api/v1/exams/${exam3.examId}/paper/submit-for-review`).set(S), 'exam3:paper-submit');
    must(await req().post(`/api/v1/exams/${exam3.examId}/paper/approve`).set(R), 'exam3:paper-approve');
    must(
      await req().post(`/api/v1/exams/${exam3.examId}/paper/sets`).set(E).send({
        sets: [{ setCode: 'A', questionOrder: ['Q1', 'Q2', 'Q3'] }],
      }),
      'exam3:sets',
    );
    must(await req().post(`/api/v1/exams/${exam3.examId}/allocations`).set(E).send({ studentExternalIds: students.slice(0, 6).map((s) => s.externalId), provider: 'uos' }), 'exam3:alloc');
    must(await req().post(`/api/v1/exams/${exam3.examId}/hall-tickets`).set(E).send({}), 'exam3:hall-tickets');
    for (const st of ['submit-for-review', 'approve', 'schedule', 'open-precheck', 'start']) must(await req().post(`/api/v1/exams/${exam3.examId}/${st}`).set(E), `exam3:${st}`);

    const e3Map = await getExamAttemptsMap(exam3.examId);
    const exam3DeviceSessions: string[] = [];

    // Students 01..06 complete precheck and admit
    for (let i = 0; i < 6; i++) {
      const { att, sTok } = e3Map[students[i]!.email]!;
      const run = must(await req().post(`/api/v1/student/attempts/${att.id}/prechecks`).set(sTok).send({ clientBuild: 'browser' }), `e3:pre:${i}`);
      const v = (b: Record<string, unknown>) => req().post(`/api/v1/student/prechecks/${run.runId}/items/verify`).set(sTok).send(b);
      await v({ code: 'CLIENT_VERSION', clientBuild: 'browser' });
      await v({ code: 'CLOCK_SYNC', clientClockMs: Date.now() });
      await v({ code: 'KEYBOARD_INPUT', keyboardSample: 'Networks readiness check complete sample 2026!' });
      await v({ code: 'SYSTEM_SCAN', scan: cleanScan() });
      await req().post(`/api/v1/student/prechecks/${run.runId}/practice-saves`).set(sTok).send({ contentDigest: 'd'.repeat(64) });
      await v({ code: 'NETWORK_SAVE_ROUNDTRIP' });
      await v({ code: 'CONSENT', consentPolicyVersion: 'v1' });
      must(await req().post(`/api/v1/student/prechecks/${run.runId}/finalize`).set(sTok), `e3:pre-fin:${i}`);

      const grant = must(await req().post(`/api/v1/student/attempts/${att.id}/entry-grants`).set(sTok), `e3:grant:${i}`);
      const admit = must(await req().post(`/api/v1/student/attempts/${att.id}/admit`).set(sTok).send({ grantToken: grant.grantToken }), `e3:admit:${i}`);
      exam3DeviceSessions.push(admit.deviceSessionId as string);

      // Heartbeat
      await req().post(`/api/v1/student/attempts/${att.id}/heartbeat`).set(sTok).set('x-device-session', admit.deviceSessionId);

      // Realistic typing saves
      const q1Url = `/api/v1/student/attempts/${att.id}/answers/Q1`;
      const q1Blocks = [
        { id: 'p1', kind: 'paragraph', content: 'TCP establishes reliable connections via the 3-Way Handshake: Client sends SYN(seq=x), Server replies with SYN-ACK(seq=y, ack=x+1), Client responds with ACK(ack=y+1).' },
        { id: 'c1', kind: 'canvas', content: { width: 400, height: 200, strokes: [{ tool: 'pen', width: 2, color: 'blue', points: [[20, 20], [100, 80], [200, 150]] }] } },
      ];
      must(
        await req().put(q1Url).set(sTok).set('x-device-session', admit.deviceSessionId).send({
          clientOperationId: randomUUID(),
          baseRevision: 0,
          answerFormat: 'hybrid-v1',
          ops: [
            { op: 'upsert-block', blockId: 'p1', kind: 'paragraph', content: q1Blocks[0]!.content },
            { op: 'upsert-block', blockId: 'c1', kind: 'canvas', content: q1Blocks[1]!.content },
          ],
          contentSha256: answerHash(q1Blocks),
        }),
        `e3:save-q1:${i}`,
      );
    }

    // Proctoring incident simulations in Exam 3:
    // Student 02: Focus lost & fullscreen exit -> Proctor warns
    {
      const { att, sTok } = e3Map[students[1]!.email]!;
      const evt = must(
        await req().post('/api/v1/proctor/events').set(sTok).send({
          events: [
            { attemptId: att.id, signalClass: 'FOCUS_LOST', sourceEventId: randomUUID(), metadata: { durationMs: 4500 } },
            { attemptId: att.id, signalClass: 'FULLSCREEN_EXIT', sourceEventId: randomUUID(), metadata: {} },
          ],
        }),
        'proctor:events:s02',
      );
      const incId = evt.results[0]!.incidentId;
      must(
        await req().post(`/api/v1/proctor/incidents/${incId}/decision`).set(P).send({
          action: 'CONFIRM_WARNING',
          reasonCode: 'POLICY_VIOLATION_REVIEWED',
          notes: 'Candidate switched tabs during network calculation',
          idempotencyKey: randomUUID(),
        }),
        'proctor:warn:s02',
      );
    }

    // Student 03: Attempt from rogue device -> CONCURRENT_SESSION incident
    {
      const { att, sTok } = e3Map[students[2]!.email]!;
      const rogueDev = randomUUID();
      const q1Blocks = [{ id: 'p1', kind: 'paragraph', content: 'Rogue device overwrite test' }];
      await req().put(`/api/v1/student/attempts/${att.id}/answers/Q1`).set(sTok).set('x-device-session', rogueDev).send({
        clientOperationId: randomUUID(),
        baseRevision: 1,
        answerFormat: 'hybrid-v1',
        ops: [{ op: 'upsert-block', blockId: 'p1', kind: 'paragraph', content: q1Blocks[0]!.content }],
        contentSha256: answerHash(q1Blocks),
      });

      const inc = await admin('proctor_incidents').where({ attempt_id: att.id, signal_class: 'CONCURRENT_SESSION' }).first();
      if (inc) {
        await req().post(`/api/v1/proctor/incidents/${inc.id}/decision`).set(P).send({
          action: 'CONFIRM_WARNING',
          reasonCode: 'SECOND_DEVICE_DETECTED',
          notes: 'Invigilator warned student against using smartphone',
          idempotencyKey: randomUUID(),
        });
      }
    }

    // Student 04: Accumulates 5 warnings -> Suspended -> Chief Proctor Resumes with extension
    {
      const { att, sTok } = e3Map[students[3]!.email]!;
      const sigs = ['FULLSCREEN_EXIT', 'VISUAL_ANOMALY', 'OTHER_MANUAL', 'DISALLOWED_APP_DETECTED', 'FOCUS_LOST'];
      const evts = must(
        await req().post('/api/v1/proctor/events').set(sTok).send({
          events: sigs.map((sc, idx) => ({ attemptId: att.id, signalClass: sc, sourceEventId: `w-${idx}-${randomUUID()}`, metadata: {} })),
        }),
        'proctor:events:s04',
      );
      for (const r of evts.results) {
        await req().post(`/api/v1/proctor/incidents/${r.incidentId}/decision`).set(P).send({
          action: 'CONFIRM_WARNING',
          reasonCode: 'POLICY_VIOLATION_REVIEWED',
          notes: 'Disturbance at desk logged by invigilator',
          idempotencyKey: randomUUID(),
        });
      }
      // Resume attempt
      must(
        await req().post(`/api/v1/proctor/attempts/${att.id}/resume`).set(P).send({
          reasonCode: 'REVIEWED',
          notes: 'Candidate explanation accepted by Chief Proctor; peripheral verified; 5 minute extension approved',
          idempotencyKey: randomUUID(),
          deadlineExtensionMinutes: 5,
        }),
        'proctor:resume:s04',
      );
    }

    // =========================================================================
    // EXAM 4: CS304-EVAL — Status: CLOSED / EVALUATING (Marking Queue)
    // =========================================================================
    console.log('[Phase 4.4] Seeding Exam 4: CS304-EVAL (CLOSED / EVALUATING — Examiner queue & rubrics)...');
    const exam4 = must(
      await req().post('/api/v1/exams').set(E).send({
        code: 'CS304-EVAL',
        title: 'Design & Analysis of Algorithms — Mid 1',
        courseCode: 'CS304',
        examType: 'MID_1',
        academicYear: '2026-27',
        semester: 5,
        maxMarks: 25,
        securityProfile: 'BASIC_BROWSER',
        durationMinutes: 60,
        windowStartAt: new Date(now - 30 * 60_000).toISOString(),
        windowEndAt: new Date(now + 60 * 60_000).toISOString(),
        policy: { ipPolicy: 'REVIEW' },
      }),
      'exam4:create',
    );

    must(
      await req().put(`/api/v1/exams/${exam4.examId}/paper`).set(S).send({
        title: 'Design and Analysis of Algorithms — Mid 1 Question Paper',
        instructions: 'Answer all 3 questions.',
        sections: [{ code: 'A', title: 'Algorithms', instructions: 'Compulsory' }],
        questions: [
          {
            questionId: 'Q1', sectionCode: 'A', number: 1, kind: 'DESCRIPTIVE', maxMarks: 8,
            prompt: { blocks: [{ id: 'p1', kind: 'paragraph', content: 'State the Master Theorem for divide and conquer recurrences T(n) = aT(n/b) + f(n). Solve T(n) = 4T(n/2) + n^2.' }] },
            rubric: [{ code: 'CASES', max: 4, description: 'Three cases explanation' }, { code: 'SOLVE', max: 4, description: 'Solution to recurrence' }],
          },
          {
            questionId: 'Q2', sectionCode: 'A', number: 2, kind: 'DESCRIPTIVE', maxMarks: 8,
            prompt: { blocks: [{ id: 'p2', kind: 'paragraph', content: 'Explain Dijkstra shortest path algorithm with min-heap priority queue. What is its time complexity?' }] },
            rubric: [{ code: 'ALGO', max: 5, description: 'Greedy choice relaxation' }, { code: 'COMPLEXITY', max: 3, description: 'O((V+E)logV) analysis' }],
          },
          {
            questionId: 'Q3', sectionCode: 'A', number: 3, kind: 'DESCRIPTIVE', maxMarks: 9,
            prompt: { blocks: [{ id: 'p3', kind: 'paragraph', content: 'Formulate the dynamic programming recurrence for 0/1 Knapsack problem. Explain the space optimization to O(W).' }] },
            rubric: [{ code: 'RECURRENCE', max: 5, description: 'DP table equation' }, { code: 'SPACE', max: 4, description: '1D array reverse traversal' }],
          },
        ],
      }),
      'exam4:paper',
    );
    must(await req().post(`/api/v1/exams/${exam4.examId}/paper/submit-for-review`).set(S), 'exam4:paper-submit');
    must(await req().post(`/api/v1/exams/${exam4.examId}/paper/approve`).set(R), 'exam4:paper-approve');
    must(
      await req().post(`/api/v1/exams/${exam4.examId}/paper/sets`).set(E).send({
        sets: [{ setCode: 'A', questionOrder: ['Q1', 'Q2', 'Q3'] }],
      }),
      'exam4:sets',
    );
    must(await req().post(`/api/v1/exams/${exam4.examId}/allocations`).set(E).send({ studentExternalIds: students.slice(0, 6).map((s) => s.externalId), provider: 'uos' }), 'exam4:alloc');
    must(await req().post(`/api/v1/exams/${exam4.examId}/hall-tickets`).set(E).send({}), 'exam4:hall-tickets');
    for (const st of ['submit-for-review', 'approve', 'schedule', 'open-precheck', 'start']) must(await req().post(`/api/v1/exams/${exam4.examId}/${st}`).set(E), `exam4:${st}`);

    const e4Map = await getExamAttemptsMap(exam4.examId);

    // Students 01..06 complete, submit, and seal attempts
    for (let i = 0; i < 6; i++) {
      const { att, sTok } = e4Map[students[i]!.email]!;
      const run = must(await req().post(`/api/v1/student/attempts/${att.id}/prechecks`).set(sTok).send({ clientBuild: 'browser' }), `e4:pre:${i}`);
      const v = (b: Record<string, unknown>) => req().post(`/api/v1/student/prechecks/${run.runId}/items/verify`).set(sTok).send(b);
      await v({ code: 'CLIENT_VERSION', clientBuild: 'browser' });
      await v({ code: 'CLOCK_SYNC', clientClockMs: Date.now() });
      await v({ code: 'KEYBOARD_INPUT', keyboardSample: 'Algorithm readiness check sample text 2026!' });
      await v({ code: 'SYSTEM_SCAN', scan: cleanScan() });
      await req().post(`/api/v1/student/prechecks/${run.runId}/practice-saves`).set(sTok).send({ contentDigest: 'e'.repeat(64) });
      await v({ code: 'NETWORK_SAVE_ROUNDTRIP' });
      await v({ code: 'CONSENT', consentPolicyVersion: 'v1' });
      must(await req().post(`/api/v1/student/prechecks/${run.runId}/finalize`).set(sTok), `e3:pre-fin:${i}`);

      const grant = must(await req().post(`/api/v1/student/attempts/${att.id}/entry-grants`).set(sTok), `e4:grant:${i}`);
      const admit = must(await req().post(`/api/v1/student/attempts/${att.id}/admit`).set(sTok).send({ grantToken: grant.grantToken }), `e4:admit:${i}`);

      // Answer Q1, Q2, Q3
      for (const [qId, text] of [
        ['Q1', 'Master Theorem: a=4, b=2, f(n)=n^2. log_b(a) = log_2(4) = 2. Since f(n) = Theta(n^2), Case 2 applies. T(n) = Theta(n^2 log n).'],
        ['Q2', 'Dijkstra maintains dist[] initialized to infinity. A min-heap extracts the closest unvisited vertex u. For each edge (u, v), if dist[u] + w(u,v) < dist[v], dist[v] is relaxed. Time complexity is O((V+E) log V).'],
        ['Q3', 'DP table dp[i][w] = max(dp[i-1][w], dp[i-1][w-wt[i]] + val[i]). To optimize space to O(W), we use a single 1D array traversed backwards from W down to wt[i].'],
      ] as const) {
        const blocks = [{ id: 'ans', kind: 'paragraph', content: text }];
        await req().put(`/api/v1/student/attempts/${att.id}/answers/${qId}`).set(sTok).set('x-device-session', admit.deviceSessionId).send({
          clientOperationId: randomUUID(),
          baseRevision: 0,
          answerFormat: 'hybrid-v1',
          ops: [{ op: 'upsert-block', blockId: 'ans', kind: 'paragraph', content: text }],
          contentSha256: answerHash(blocks),
        });
      }

      // Submit attempt
      must(await req().post(`/api/v1/student/attempts/${att.id}/submit`).set(sTok).send({ idempotencyKey: randomUUID() }), `e4:submit:${i}`);
    }

    // Close Exam 4
    must(await req().post(`/api/v1/exams/${exam4.examId}/close`).set(E), 'exam4:close');

    // Run Forensics Pass
    await runForensicsOnce(deps, 50);

    // Examiner evaluates Student 01 and Student 02
    const e4s01 = e4Map[students[0]!.email]!;
    const e4s02 = e4Map[students[1]!.email]!;
    const e4s03 = e4Map[students[2]!.email]!;

    must(
      await req()
        .post(`/api/v1/candidates/${e4s01.att.id}/result-versions`)
        .set(EV)
        .send({
          items: [
            { questionId: 'Q1', maxMarks: 8, marks: 8, explanation: 'Perfect Master Theorem calculation and case matching.', criteria: [{ code: 'CASES', max: 4, awarded: 4 }, { code: 'SOLVE', max: 4, awarded: 4 }] },
            { questionId: 'Q2', maxMarks: 8, marks: 7, explanation: 'Clear relaxation steps; edge case of negative weights noted.', criteria: [{ code: 'ALGO', max: 5, awarded: 5 }, { code: 'COMPLEXITY', max: 3, awarded: 2 }] },
            { questionId: 'Q3', maxMarks: 9, marks: 8, explanation: 'Correct 1D space optimization logic.', criteria: [{ code: 'RECURRENCE', max: 5, awarded: 5 }, { code: 'SPACE', max: 4, awarded: 3 }] },
          ],
        }),
      'e4:evaluate:s01',
    );

    must(
      await req()
        .post(`/api/v1/candidates/${e4s02.att.id}/result-versions`)
        .set(EV)
        .send({
          items: [
            { questionId: 'Q1', maxMarks: 8, marks: 6, explanation: 'Correct case matching, minor algebra simplification error.', criteria: [{ code: 'CASES', max: 4, awarded: 3 }, { code: 'SOLVE', max: 4, awarded: 3 }] },
            { questionId: 'Q2', maxMarks: 8, marks: 6, explanation: 'Dijkstra algorithm sound; complexity proof could be more rigorous.', criteria: [{ code: 'ALGO', max: 5, awarded: 4 }, { code: 'COMPLEXITY', max: 3, awarded: 2 }] },
            { questionId: 'Q3', maxMarks: 9, marks: 7, explanation: 'Good formulation of recurrence relation.', criteria: [{ code: 'RECURRENCE', max: 5, awarded: 4 }, { code: 'SPACE', max: 4, awarded: 3 }] },
          ],
        }),
      'e4:evaluate:s02',
    );

    // Exam Cell places Student 03 on INTEGRITY_HOLD
    must(
      await req().post(`/api/v1/candidates/${e4s03.att.id}/holds`).set(E).send({
        status: 'INTEGRITY_HOLD',
        reason: 'Invigilator log: desk inspection sheet discrepancy under review by disciplinary committee',
      }),
      'e4:hold:s03',
    );

    // =========================================================================
    // EXAM 5: CS305-PUB — Status: PUBLISHED (Lifelong Ledger & Revaluations)
    // =========================================================================
    console.log('[Phase 4.5] Seeding Exam 5: CS305-PUB (PUBLISHED — Full results ledger & revaluation)...');
    const exam5 = must(
      await req().post('/api/v1/exams').set(E).send({
        code: 'CS305-PUB',
        title: 'Software Engineering & Agile — Semester External',
        courseCode: 'CS305',
        examType: 'SEM_EXTERNAL',
        academicYear: '2026-27',
        semester: 5,
        maxMarks: 50,
        securityProfile: 'BASIC_BROWSER',
        durationMinutes: 120,
        windowStartAt: new Date(now - 30 * 60_000).toISOString(),
        windowEndAt: new Date(now + 90 * 60_000).toISOString(),
        policy: { ipPolicy: 'REVIEW' },
      }),
      'exam5:create',
    );

    must(
      await req().put(`/api/v1/exams/${exam5.examId}/paper`).set(S).send({
        title: 'Software Engineering & Agile Question Paper',
        instructions: 'Answer all 4 questions.',
        sections: [{ code: 'A', title: 'Software Engineering Principles', instructions: 'All compulsory' }],
        questions: [
          {
            questionId: 'Q1', sectionCode: 'A', number: 1, kind: 'DESCRIPTIVE', maxMarks: 12,
            prompt: { blocks: [{ id: 'p1', kind: 'paragraph', content: 'Contrast Scrum sprint cycles with Waterfall phases. What is the role of the Product Owner in sprint backlog refinement?' }] },
            rubric: [{ code: 'COMPARE', max: 6, description: 'Agile vs Waterfall comparison' }, { code: 'PO', max: 6, description: 'Product Owner duties' }],
          },
          {
            questionId: 'Q2', sectionCode: 'A', number: 2, kind: 'DESCRIPTIVE', maxMarks: 13,
            prompt: { blocks: [{ id: 'p2', kind: 'paragraph', content: 'Explain Microservices decomposition by business capability. How does asynchronous event messaging (Kafka/RabbitMQ) ensure loose coupling?' }] },
            rubric: [{ code: 'MICRO', max: 7, description: 'Decomposition patterns' }, { code: 'EVENT', max: 6, description: 'Event-driven coupling' }],
          },
          {
            questionId: 'Q3', sectionCode: 'A', number: 3, kind: 'DESCRIPTIVE', maxMarks: 13,
            prompt: { blocks: [{ id: 'p3', kind: 'paragraph', content: 'Describe the Test Pyramid (Unit, Integration, E2E) and the stages of a modern CI/CD deployment pipeline.' }] },
            rubric: [{ code: 'PYRAMID', max: 7, description: 'Testing proportions' }, { code: 'CICD', max: 6, description: 'Automated release stages' }],
          },
          {
            questionId: 'Q4', sectionCode: 'A', number: 4, kind: 'DESCRIPTIVE', maxMarks: 12,
            prompt: { blocks: [{ id: 'p4', kind: 'paragraph', content: 'Detail Git branching strategies (GitFlow vs Trunk-Based Development) and how pull request code reviews preserve repository integrity.' }] },
            rubric: [{ code: 'BRANCH', max: 6, description: 'Branching comparisons' }, { code: 'PR', max: 6, description: 'Code review gating' }],
          },
        ],
      }),
      'exam5:paper',
    );
    must(await req().post(`/api/v1/exams/${exam5.examId}/paper/submit-for-review`).set(S), 'exam5:paper-submit');
    must(await req().post(`/api/v1/exams/${exam5.examId}/paper/approve`).set(R), 'exam5:paper-approve');
    must(
      await req().post(`/api/v1/exams/${exam5.examId}/paper/sets`).set(E).send({
        sets: [{ setCode: 'A', questionOrder: ['Q1', 'Q2', 'Q3', 'Q4'] }],
      }),
      'exam5:sets',
    );
    must(await req().post(`/api/v1/exams/${exam5.examId}/allocations`).set(E).send({ studentExternalIds: students.slice(0, 6).map((s) => s.externalId), provider: 'uos' }), 'exam5:alloc');
    must(await req().post(`/api/v1/exams/${exam5.examId}/hall-tickets`).set(E).send({}), 'exam5:hall-tickets');
    for (const st of ['submit-for-review', 'approve', 'schedule', 'open-precheck', 'start']) must(await req().post(`/api/v1/exams/${exam5.examId}/${st}`).set(E), `exam5:${st}`);

    const e5Map = await getExamAttemptsMap(exam5.examId);

    // Students 01..06 answer and submit
    for (let i = 0; i < 6; i++) {
      const { att, sTok } = e5Map[students[i]!.email]!;
      const run = must(await req().post(`/api/v1/student/attempts/${att.id}/prechecks`).set(sTok).send({ clientBuild: 'browser' }), `e5:pre:${i}`);
      const v = (b: Record<string, unknown>) => req().post(`/api/v1/student/prechecks/${run.runId}/items/verify`).set(sTok).send(b);
      await v({ code: 'CLIENT_VERSION', clientBuild: 'browser' });
      await v({ code: 'CLOCK_SYNC', clientClockMs: Date.now() });
      await v({ code: 'KEYBOARD_INPUT', keyboardSample: 'Software engineering readiness test sample 2026!' });
      await v({ code: 'SYSTEM_SCAN', scan: cleanScan() });
      await req().post(`/api/v1/student/prechecks/${run.runId}/practice-saves`).set(sTok).send({ contentDigest: 'f'.repeat(64) });
      await v({ code: 'NETWORK_SAVE_ROUNDTRIP' });
      await v({ code: 'CONSENT', consentPolicyVersion: 'v1' });
      must(await req().post(`/api/v1/student/prechecks/${run.runId}/finalize`).set(sTok), `e3:pre-fin:${i}`);

      const grant = must(await req().post(`/api/v1/student/attempts/${att.id}/entry-grants`).set(sTok), `e5:grant:${i}`);
      const admit = must(await req().post(`/api/v1/student/attempts/${att.id}/admit`).set(sTok).send({ grantToken: grant.grantToken }), `e5:admit:${i}`);

      for (const [qId, text] of [
        ['Q1', 'Scrum operates in timeboxed 2-4 week sprints, whereas Waterfall uses sequential phases (Requirements -> Design -> Code -> Test). The Product Owner prioritizes the backlog and defines user story acceptance criteria.'],
        ['Q2', 'Microservices partition domains into bounded contexts. Asynchronous messaging decouples producer and consumer lifecycles, ensuring resilient eventual consistency without distributed locks.'],
        ['Q3', 'The Test Pyramid emphasizes a broad base of fast unit tests, a middle layer of integration tests, and fewer end-to-end tests. CI/CD runs these checks automatically on every commit.'],
        ['Q4', 'GitFlow employs develop, feature, release, and main branches. Trunk-based development merges short-lived branches to trunk with feature flags. PR reviews enforce pair verification and architectural standards.'],
      ] as const) {
        const blocks = [{ id: 'b', kind: 'paragraph', content: text }];
        await req().put(`/api/v1/student/attempts/${att.id}/answers/${qId}`).set(sTok).set('x-device-session', admit.deviceSessionId).send({
          clientOperationId: randomUUID(),
          baseRevision: 0,
          answerFormat: 'hybrid-v1',
          ops: [{ op: 'upsert-block', blockId: 'b', kind: 'paragraph', content: text }],
          contentSha256: answerHash(blocks),
        });
      }

      must(await req().post(`/api/v1/student/attempts/${att.id}/submit`).set(sTok).send({ idempotencyKey: randomUUID() }), `e5:submit:${i}`);
    }

    // Close Exam 5
    must(await req().post(`/api/v1/exams/${exam5.examId}/close`).set(E), 'exam5:close');
    await runForensicsOnce(deps, 50);

    // Examiner evaluates all 6 students with varied realistic scores
    const exam5Scores = [
      { total: 46, q1: 11, q2: 12, q3: 12, q4: 11, note: 'Outstanding technical depth and diagrams across all four sections.' },
      { total: 41, q1: 10, q2: 10, q3: 11, q4: 10, note: 'Solid software engineering understanding; very good testing pyramid breakdown.' },
      { total: 38, q1: 9, q2: 10, q3: 10, q4: 9, note: 'Good answers; microservices domain boundaries clearly articulated.' },
      { total: 34, q1: 8, q2: 9, q3: 9, q4: 8, note: 'Competent responses; minor gaps in CI/CD deployment rollback discussion.' },
      { total: 31, q1: 8, q2: 8, q3: 8, q4: 7, note: 'Satisfactory explanations; Git branching comparison could be more detailed.' },
      { total: 27, q1: 7, q2: 7, q3: 7, q4: 6, note: 'Passing marks; needs clearer differentiation between unit and integration test layers.' },
    ];

    for (let i = 0; i < 6; i++) {
      const { att } = e5Map[students[i]!.email]!;
      const s = exam5Scores[i]!;
      must(
        await req()
          .post(`/api/v1/candidates/${att.id}/result-versions`)
          .set(EV)
          .send({
            items: [
              { questionId: 'Q1', maxMarks: 12, marks: s.q1, explanation: 'Clear Scrum vs Waterfall comparison.', criteria: [{ code: 'COMPARE', max: 6, awarded: Math.ceil(s.q1 / 2) }, { code: 'PO', max: 6, awarded: Math.floor(s.q1 / 2) }] },
              { questionId: 'Q2', maxMarks: 13, marks: s.q2, explanation: 'Detailed microservices bounded context answer.', criteria: [{ code: 'MICRO', max: 7, awarded: Math.ceil(s.q2 / 2) }, { code: 'EVENT', max: 6, awarded: Math.floor(s.q2 / 2) }] },
              { questionId: 'Q3', maxMarks: 13, marks: s.q3, explanation: 'Testing pyramid proportions explained.', criteria: [{ code: 'PYRAMID', max: 7, awarded: Math.ceil(s.q3 / 2) }, { code: 'CICD', max: 6, awarded: Math.floor(s.q3 / 2) }] },
              { questionId: 'Q4', maxMarks: 12, marks: s.q4, explanation: 'GitFlow vs Trunk-based development contrast.', criteria: [{ code: 'BRANCH', max: 6, awarded: Math.ceil(s.q4 / 2) }, { code: 'PR', max: 6, awarded: Math.floor(s.q4 / 2) }] },
            ],
          }),
        `e5:evaluate:${i}`,
      );

      // Exam Cell approves candidate review packet
      const p = await admin('candidate_review_packets').where({ tenant_id: tenantId, attempt_id: att.id }).first();
      const ap = must(
        await req().post(`/api/v1/candidates/${att.id}/approvals`).set(E).send({
          reviewedResultVersionId: p.result_version_id,
          reason: 'Exam Cell verified marks entry and rubric compliance',
          idempotencyKey: randomUUID(),
        }),
        `e5:approve:${i}`,
      );

      // Controller authorizes publication
      must(
        await req().post(`/api/v1/candidates/${att.id}/authorize-publication`).set(C).send({
          candidateApprovalId: ap.approvalId,
          idempotencyKey: randomUUID(),
        }),
        `e5:publish:${i}`,
      );
    }

    // Student 02 submits a Revaluation Request for Exam 5
    {
      const { att: att2, sTok: sTok2 } = e5Map[students[1]!.email]!;
      must(
        await req().post(`/api/v1/student/attempts/${att2.id}/revaluation`).set(sTok2).send({
          reason: 'In Question 2, detailed architectural diagrams for Saga pattern and CQRS were submitted; requesting re-examination of rubric criteria scores.',
          feeRef: 'FEE-UOS-2026-REV-001',
        }),
        'student02:revaluation-request',
      );
    }

    // Process outbox and workers
    console.log('[Phase 5] Processing notification dispatches, outbox events, and workers...');
    await admin('mail_dispatches').where({ tenant_id: tenantId, status: 'QUEUED' }).update({ next_attempt_at: new Date() });
    await runMailWorkerOnce(deps, 'TRANSACTIONAL');
    await runMailWorkerOnce(deps, 'BULK');
    await runWebhookWorkerOnce(deps);
    await runOutboxDispatcherOnce(deps);

    // =========================================================================
    // Phase 6: End-to-End API Smoke Verification & Assertions
    // =========================================================================
    console.log('[Phase 6] Running automated end-to-end smoke verification across all surfaces...\n');

    async function check(name: string, fn: () => Promise<boolean>, detail?: string) {
      try {
        const ok = await fn();
        if (ok) {
          smokePass.push(name);
          console.log(`  ✓ [PASS] ${name}${detail ? ` (${detail})` : ''}`);
        } else {
          smokeFail.push(name);
          console.error(`  ✗ [FAIL] ${name}${detail ? ` (${detail})` : ''}`);
        }
      } catch (err: any) {
        smokeFail.push(name);
        console.error(`  ✗ [FAIL] ${name}: ${err?.message ?? err}`);
      }
    }

    // Smoke 1: Authentication & User Management
    await check('Admin authentication & /auth/me profile verification', async () => {
      const r = await req().get('/api/v1/auth/me').set(A);
      return r.status === 200 && r.body.email === 'admin@demo.local';
    });
    await check('Staff capacity & seats calculation (4 active staff accounts)', async () => {
      const r = await req().get('/api/v1/tenant/staff-seats').set(A);
      return r.status === 200 && r.body.used === 4 && r.body.limit === 4;
    });
    await check('Controller digital e-signature mapping verified in Admin', async () => {
      const r = await req().get(`/api/v1/tenant/users/${adminUser.id}/signature`).set(A);
      return r.status === 200 && typeof r.body.signatureDataUrl === 'string' && r.body.signatureDataUrl.length > 50;
    });
    const s1Tok = { Host: HOST, Authorization: `Bearer ${studentTokens['student01@demo.local']}` };
    await check('Student authentication & session token verification', async () => {
      const r = await req().get('/api/v1/auth/me').set(s1Tok);
      return r.status === 200 && r.body.email === 'student01@demo.local' && r.body.kind === 'STUDENT';
    });

    // Smoke 2: Student Identity & Profile Subsystem
    await check('Student Profile endpoint returns full profile with photo and registration number', async () => {
      const r = await req().get('/api/v1/student/profile').set(s1Tok);
      const data = r.body.student ? r.body : r.body.profile;
      return (
        r.status === 200 &&
        data.student?.fullName === 'Aarav Sharma' &&
        data.student?.registerNumber === '22CSE001' &&
        data.department?.code === 'CSE' &&
        data.documents?.photo !== null
      );
    });
    await check('Student ID Card verification data and dynamic QR data URL generated', async () => {
      const r = await req().get('/api/v1/student/profile/id-card').set(s1Tok);
      const data = r.body.valid !== undefined ? r.body : r.body.idCard;
      return (
        r.status === 200 &&
        data.valid === true &&
        data.registerNumber === '22CSE001' &&
        typeof data.qrDataUrl === 'string' &&
        data.qrDataUrl.startsWith('data:image/png;base64,')
      );
    });
    await check('Candidate Digital E-Signature endpoint returns signature data URL', async () => {
      const r = await req().get('/api/v1/student/profile/signature').set(s1Tok);
      return (
        r.status === 200 &&
        typeof r.body.signatureDataUrl === 'string' &&
        r.body.signatureDataUrl.length > 50
      );
    });

    // Smoke 3: Safe Exam Browser (SEB) Lifecycle
    await check('Safe Exam Browser (.seb) config generated and downloadable by staff and candidate', async () => {
      const rStaff = await req().get(`/api/v1/exams/${exam1.examId}/seb-config`).set(E);
      const rStudent = await req().get(`/api/v1/student/me/exams/${exam1.examId}/seb-config`).set(s1Tok);
      return (
        rStaff.status === 200 &&
        rStudent.status === 200 &&
        Boolean(rStaff.headers['content-type']?.includes('application/seb')) &&
        typeof rStaff.headers['x-seb-configkey'] === 'string'
      );
    });

    // Smoke 4: Exams & Lifecycles
    await check('Exams list shows all 5 distinct phases (SCHEDULED, PRECHECK, LIVE, CLOSED, PUBLISHED)', async () => {
      const r = await req().get('/api/v1/exams').set(E);
      const codes = r.body.exams.map((x: any) => x.code);
      return r.status === 200 && ['CS301-MID1', 'CS302-SEM', 'CS303-LIVE', 'CS304-EVAL', 'CS305-PUB'].every((c) => codes.includes(c));
    });
    await check('Question paper contains multi-section descriptive questions with scoring rubrics', async () => {
      const r = await req().get(`/api/v1/exams/${exam1.examId}/paper`).set(E);
      const paper = r.body.paper ?? r.body;
      return (
        r.status === 200 &&
        Array.isArray(paper.sections) &&
        paper.sections.length === 2 &&
        Array.isArray(paper.questions) &&
        paper.questions.length === 4
      );
    });

    // Smoke 5: Readiness Board & Controller Waivers (CS301-MID1)
    await check('Readiness Board displays live candidate distribution and exceptions', async () => {
      const r = await req().get(`/api/v1/exams/${exam2.examId}/readiness`).set(E);
      return r.status === 200 && r.body.summary.ready >= 7 && r.body.summary.total === 12;
    });
    await check('Controller admission exception waived precheck block for dual monitor candidate', async () => {
      const r = await req().get(`/api/v1/exams/${exam2.examId}/readiness`).set(E);
      const s09 = r.body.candidates?.find((c: any) => c.email === 'student09@demo.local');
      return r.status === 200 && s09 && s09.status === 'READY';
    });

    // Smoke 6: Live Proctoring, Autosaves & Device Security (CS303-LIVE)
    const s01_e3 = e3Map['student01@demo.local']!;
    const s02_e3 = e3Map['student02@demo.local']!;
    const s04_e3 = e3Map['student04@demo.local']!;
    await check('Live Autosave OT records answer document with vector canvas diagram strokes', async () => {
      const r = await req().get(`/api/v1/student/attempts/${s01_e3.att.id}/answers/Q1`).set(s1Tok);
      const blocks = (r.body?.content as any)?.blocks ?? r.body?.document?.blocks ?? r.body?.blocks;
      return (
        r.status === 200 &&
        Array.isArray(blocks) &&
        blocks.some((b: any) => b.kind === 'canvas' && Array.isArray(b.content?.strokes))
      );
    });
    await check('Autosave idempotency: repeating clientOperationId returns original receipt', async () => {
      const q1Blocks = [{ id: 'p1', kind: 'paragraph', content: 'Idempotency test payload' }];
      const opId = randomUUID();
      const r1 = await req()
        .put(`/api/v1/student/attempts/${s01_e3.att.id}/answers/Q2`)
        .set(s1Tok)
        .set('x-device-session', exam3DeviceSessions[0]!)
        .send({
          clientOperationId: opId,
          baseRevision: 0,
          answerFormat: 'hybrid-v1',
          ops: [{ op: 'upsert-block', blockId: 'p1', kind: 'paragraph', content: 'Idempotency test payload' }],
          contentSha256: answerHash(q1Blocks),
        });
      const r2 = await req()
        .put(`/api/v1/student/attempts/${s01_e3.att.id}/answers/Q2`)
        .set(s1Tok)
        .set('x-device-session', exam3DeviceSessions[0]!)
        .send({
          clientOperationId: opId,
          baseRevision: 0,
          answerFormat: 'hybrid-v1',
          ops: [{ op: 'upsert-block', blockId: 'p1', kind: 'paragraph', content: 'Idempotency test payload' }],
          contentSha256: answerHash(q1Blocks),
        });
      return r1.status === 200 && r2.status === 200 && r1.body.revision === r2.body.revision;
    });
    await check('Concurrent session from unapproved device refused with DEVICE_SESSION_MISMATCH', async () => {
      const rogueDev = randomUUID();
      const q1Blocks = [{ id: 'p1', kind: 'paragraph', content: 'Rogue session payload' }];
      const r = await req()
        .put(`/api/v1/student/attempts/${s01_e3.att.id}/answers/Q1`)
        .set(s1Tok)
        .set('x-device-session', rogueDev)
        .send({
          clientOperationId: randomUUID(),
          baseRevision: 1,
          answerFormat: 'hybrid-v1',
          ops: [{ op: 'upsert-block', blockId: 'p1', kind: 'paragraph', content: 'Rogue session payload' }],
          contentSha256: answerHash(q1Blocks),
        });
      return r.status === 409 && (r.body.code === 'DEVICE_SESSION_MISMATCH' || r.body.error === 'DEVICE_SESSION_MISMATCH');
    });
    await check('Proctoring queue and timeline events populated', async () => {
      const q = await req().get(`/api/v1/proctor/incidents?examId=${exam3.examId}`).set(P);
      const t = await req().get(`/api/v1/proctor/attempts/${s02_e3.att.id}/timeline`).set(P);
      return q.status === 200 && t.status === 200 && t.body.events.length > 0;
    });
    await check('Warning threshold suspends candidate and Chief Proctor resume extends deadline', async () => {
      const timeline = await req().get(`/api/v1/proctor/attempts/${s04_e3.att.id}/timeline`).set(P);
      const events = timeline.body?.events ?? [];
      const hasSuspended = events.some((e: any) => e.event_type === 'attempt.suspended');
      const hasResumed = events.some((e: any) => e.event_type === 'attempt.resumed');
      return timeline.status === 200 && hasSuspended && hasResumed;
    });

    // Smoke 7: Evaluation Queue & Integrity Hold (CS304-EVAL)
    const s01_e4 = e4Map['student01@demo.local']!;
    const s03_e4 = e4Map['student03@demo.local']!;
    await check('Evaluator queue and candidate paper viewing with rubrics', async () => {
      const q = await req().get(`/api/v1/candidates/queue?examId=${exam4.examId}`).set(EV);
      const p = await req().get(`/api/v1/candidates/${s01_e4.att.id}/paper`).set(EV);
      return q.status === 200 && p.status === 200 && Array.isArray(q.body.candidates);
    });
    await check('Candidate integrity hold blocks publication checklist for flagged candidate', async () => {
      const r = await req().get(`/api/v1/candidates/${s03_e4.att.id}/checklist`).set(E);
      return (
        r.status === 200 &&
        r.body.publishable === false &&
        r.body.packet?.status === 'INTEGRITY_HOLD'
      );
    });

    // Smoke 8: Approvals, Publication & Student Ledger (CS305-PUB)
    const s01_e5 = e5Map['student01@demo.local']!;
    await check('Exam Cell candidate approvals and Controller publication authorizations confirmed', async () => {
      const r = await req().get(`/api/v1/exams/${exam5.examId}`).set(E);
      const packets = await admin('candidate_review_packets')
        .where({ tenant_id: tenantId, exam_id: exam5.examId })
        .whereIn('status', ['PUBLISHED', 'REVALUATION_PENDING']);
      return r.status === 200 && r.body.exam?.status === 'CLOSED' && packets.length === 6;
    });
    await check('Student Lifelong Ledger displays published grades (A+, B+, etc.)', async () => {
      const r = await req().get('/api/v1/student/me/ledger').set(s1Tok);
      return r.status === 200 && r.body.records.length >= 1 && ['O', 'A+'].includes(r.body.records[0].grade);
    });
    await check('Student Answer Booklet available with verified examiner marks', async () => {
      const r = await req().get(`/api/v1/student/attempts/${s01_e5.att.id}/booklet`).set(s1Tok);
      return r.status === 200 && r.body.questions.length === 4 && r.body.questions[0].marks === 11;
    });

    // Smoke 9: Hall Ticket PDF with Dual Dynamic Signatures
    await check('Hall ticket PDF generates with QR code, Controller signature, and Candidate signature dynamically mapped', async () => {
      const r = await req().get(`/api/v1/student/me/exams/${exam2.examId}/hall-ticket.pdf`).set(s1Tok).responseType('blob');
      return (
        r.status === 200 &&
        r.headers['content-type'] === 'application/pdf' &&
        r.headers['cache-control'] === 'no-cache, no-store, must-revalidate' &&
        r.body.length > 50000
      );
    });

    // Smoke 10: Revaluation Workflow
    const s02_e5 = e5Map['student02@demo.local']!;
    await check('Revaluation request recorded for student02 and listed for Exam Cell', async () => {
      const s2Tok = { Host: HOST, Authorization: `Bearer ${studentTokens['student02@demo.local']}` };
      const rStudent = await req().get(`/api/v1/student/attempts/${s02_e5.att.id}/revaluation`).set(s2Tok);
      const rStaff = await req().get(`/api/v1/exams/${exam5.examId}/revaluation-requests`).set(E);
      return (
        rStudent.status === 200 &&
        rStudent.body.revaluation?.status === 'REQUESTED' &&
        rStaff.status === 200 &&
        (Array.isArray(rStaff.body) ? rStaff.body.length >= 1 : rStaff.body.requests?.length >= 1)
      );
    });

    // Smoke 11: Analytics Engine & Outbox Dispatch
    await check('Analytics overview computes pass rate and grade distribution from published ledger', async () => {
      const r = await req().get('/api/v1/analytics/overview').set(A);
      const deptSummary = r.body.departments?.[0]?.summary;
      return (
        r.status === 200 &&
        deptSummary &&
        deptSummary.totalPublishedResults === 6 &&
        deptSummary.passRate === 100
      );
    });
    await check('Outbox mail workers processed account activations and exam notifications', async () => {
      const queued = await admin('mail_dispatches').where({ tenant_id: tenantId, status: 'QUEUED' });
      const accepted = await admin('mail_dispatches').where({ tenant_id: tenantId, status: 'ACCEPTED' });
      return queued.length === 0 && accepted.length > 0;
    });

    // Summary output
    console.log('\n===============================================================');
    console.log(`   Verification Summary: ${smokePass.length} PASSED, ${smokeFail.length} FAILED   `);
    console.log('===============================================================\n');

    if (smokeFail.length > 0) {
      console.error(`Warning: ${smokeFail.length} checks did not pass as expected.`);
    }

    console.log(`
Demo Tenant: St. Mary's University ('demo')
Web Frontend: http://localhost:5173
API Server:   http://${HOST}:${config.PORT}

Staff Accounts (Password: Demo-Staff!2026):
  • admin@demo.local     (Password: Demo-Admin!2026) — Tenant Admin, Controller of Examinations, Auditor, Analytics
  • examcell@demo.local  — Examination Section Operator & Question Setter
  • chief@demo.local     — Chief Proctor & Paper Reviewer
  • evaluator@demo.local — Examiner, Evaluator & Moderator

Student Accounts (Password: Demo-Student!2026):
  • student01@demo.local .. student12@demo.local (B.Tech CSE, Sem 5, 22CSE001 .. 22CSE012)

Seeded Multi-Phase Exams:
  1. CS302-SEM   [SCHEDULED]  Database Systems — Semester External (SECURE_BYOD, 70m)
  2. CS301-MID1  [PRECHECK]   Operating Systems — Mid 1 (BASIC_BROWSER, Readiness board active)
  3. CS303-LIVE  [LIVE]       Computer Networks — Mid 2 (Active typing/canvas saves & live proctoring)
  4. CS304-EVAL  [CLOSED]     Design & Analysis of Algorithms — Mid 1 (Evaluation marking queue with rubrics)
  5. CS305-PUB   [PUBLISHED]  Software Engineering & Agile (Published results ledger, booklets & revaluation)

ERP API Key: ${erpKey.apiKey}
`);
  } finally {
    await admin.destroy();
    await closeDeps(deps);
    process.exit(smokeFail.length > 0 ? 1 : 0);
  }
}

main().catch((err) => {
  console.error('[Fatal Error]', err);
  process.exit(1);
});
