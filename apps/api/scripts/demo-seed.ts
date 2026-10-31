/**
 * Demo seed: provisions a complete tenant on the development database so the
 * web app can be clicked through end to end. Runs the real API in-process.
 *
 *   npm run demo -w @examos/api
 *
 * Creates tenant `demo` (hosts: localhost, demo.examos.local) with:
 *   admin@demo.local / Demo-Admin!2026                 ADMIN_CONTROLLER bundle (+ SYSTEM_ADMIN, HOD, REPORT_VIEWER)
 *   examcell@demo.local / Demo-Staff!2026              EXAM_OFFICE bundle (Exam Section + Question Setter)
 *   chief@demo.local / Demo-Staff!2026                 CHIEF_REVIEWER bundle (Chief Proctor + Paper Reviewer)
 *   evaluator@demo.local / Demo-Staff!2026             EXAMINER bundle (Evaluator + Moderator)
 *   student01..student12@demo.local / Demo-Student!2026 (STUDENT)
 * Four staff logins is the per-tenant cap the database enforces; every other
 * account is a student.
 * plus a BASIC_BROWSER exam with its readiness check already open and a
 * SECURE_BYOD exam that is scheduled.
 */
import supertest from 'supertest';
import knex from 'knex';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { buildDeps, closeDeps } from '../src/deps.js';
import { loadConfig } from '../src/config.js';

const PLATFORM_KEY = process.env['PLATFORM_BOOTSTRAP_KEY'] ?? 'demo-platform-bootstrap-key-0123456789';
process.env['PLATFORM_BOOTSTRAP_KEY'] = PLATFORM_KEY;
process.env['LOG_LEVEL'] = process.env['LOG_LEVEL'] ?? 'warn';

async function main() {
  const config = loadConfig();
  const deps = buildDeps({ config });
  const { app } = await createApp(deps);
  const admin = knex({ client: 'pg', connection: config.DATABASE_ADMIN_URL });
  const req = () => supertest(app);
  const HOST = 'localhost';

  async function activationToken(tenantId: string, email: string): Promise<string> {
    const row = await admin('mail_dispatches').where({ tenant_id: tenantId, category: 'ACCOUNT_ACTIVATION', to_address: email }).orderBy('created_at', 'desc').first('body_text');
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
    if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  }

  try {
    const existing = await admin('tenants').where('slug', 'demo').first('id');
    if (existing) {
      console.log(`
Demo tenant already provisioned on http://${HOST}:${config.PORT} (web app on http://localhost:5173)

=== Staff logins (four per tenant — the cap the database enforces) ===
  • admin@demo.local     / Demo-Admin!2026   Tenant admin + Controller of Examinations + security auditor + analytics
  • examcell@demo.local  / Demo-Staff!2026   Examination Section + Question Setter (conduct, readiness board, papers)
  • chief@demo.local     / Demo-Staff!2026   Chief Proctor + Paper Reviewer (incidents, holds, resume, paper approval)
  • evaluator@demo.local / Demo-Staff!2026   Examiner + Moderator (marks, double-evaluation moderation)

=== Student Accounts (Password: Demo-Student!2026) ===
  • student01@demo.local .. student12@demo.local  (Student profile, ID card, readiness run, exam workspace, ledger)
    - Register numbers: 22CSE001 .. 22CSE012
    - Department: Computer Science & Engineering (B.Tech CSE)

=== Active Seeded Exams ===
  • CS301-MID1 (Operating Systems — Mid 1)
    - Status: PRECHECK (Readiness check is OPEN)
    - Security Profile: BASIC_BROWSER
    - Marks: 20 marks (6 questions authored and approved)
  • CS302-SEM (Database Systems — Semester External)
    - Status: SCHEDULED
    - Security Profile: SECURE_BYOD (Safe Exam Browser .seb download enabled)
    - Marks: 70 marks (Paper sets A & B configured)

=== ERP Integration & Completeness ===
  • ERP Connection: Campus Central UOS (https://uos.smru.edu.in)
  • Roster Import: Supported via CSV / Spreadsheet templates for Persons, Units, Courses, Enrollments
  • Mail Transports: Power Automate, Microsoft Graph, SMTP, ACS Email, AWS SES with bounce reconciliation
`);
      return;
    }
  const prov = must(await req().post('/api/v1/platform/tenants').set('x-platform-key', PLATFORM_KEY).send({ slug: 'demo', name: "St. Mary's University (demo)", domains: [HOST, 'demo.examos.local'], adminEmail: 'admin@demo.local', adminFullName: 'Demo Admin' }), 'provision');
  const tenantId = prov.tenantId as string;
  const adminToken = await activate(tenantId, 'admin@demo.local', 'Demo-Admin!2026');
  const A = { Host: HOST, Authorization: `Bearer ${adminToken}` };
  must(await req().put('/api/v1/tenant/mail-config').set(A).send({ transportKind: 'capture', senderAddress: 'exam@demo.local', senderName: 'Examination Cell (demo)' }), 'mail config');

  const staff: Record<string, string> = {};
  // Four named staff logins per tenant (the cap the database enforces): the admin plus three duty bundles.
  for (const [email, bundle, name] of [
    ['examcell@demo.local', 'EXAM_OFFICE', 'Examination Section'],
    ['chief@demo.local', 'CHIEF_REVIEWER', 'Chief Proctor'],
    ['evaluator@demo.local', 'EXAMINER', 'Examiner'],
  ] as const) {
    must(await req().post('/api/v1/tenant/users').set(A).send({ email, fullName: name, kind: 'STAFF', bundle, roles: [] }), `create ${email}`);
    staff[email] = await activate(tenantId, email, 'Demo-Staff!2026');
  }
  // The admin is also the Controller of Examinations and the security auditor. Only the platform may change an
  // admin's own roles, so this goes through the platform route (bootstrap key in development).
  const adminUser = await admin('users').where({ tenant_id: tenantId, email: 'admin@demo.local' }).first('id');
  must(await req().put(`/api/v1/platform/tenants/${tenantId}/staff/${adminUser.id}/roles`).set('x-platform-key', PLATFORM_KEY).send({ bundle: 'ADMIN_CONTROLLER', roles: ['SYSTEM_ADMIN', 'HOD', 'REPORT_VIEWER'] }), 'admin roles');

  const key = must(await req().post('/api/v1/tenant/api-keys').set(A).send({ label: 'demo-erp', scopes: ['roster:write', 'roster:read', 'events:read', 'results:read', 'webhooks:manage'] }), 'api key');

  // Configure demonstration ERP connection (Phase 7)
  must(await req().post('/api/v1/tenant/erp-connections').set(A).send({
    provider: 'uos',
    label: 'Campus Central UOS',
    baseUrl: 'https://uos.smru.edu.in',
    syncScheduleCron: '0 2 * * *',
    status: 'ACTIVE',
  }), 'demo erp connection');

  const K = (p: string) => req().put(`/api/v1/integration/v1/roster/${p}/batch`).set('Authorization', `Bearer ${key.apiKey}`).set('Idempotency-Key', randomUUID()).set('X-ExamOS-Provider', 'uos');
  must(await K('academic-units').send({ rows: [{ kind: 'DEPARTMENT', code: 'CSE', name: 'Computer Science & Engineering', parentCode: 'SOE' }, { kind: 'DEPARTMENT', code: 'ECE', name: 'Electronics & Communication', parentCode: 'SOE' }, { kind: 'PROGRAMME', code: 'BTECH-CSE', name: 'B.Tech CSE', parentCode: 'CSE' }] }), 'units');
  must(await K('courses').send({ rows: [{ code: 'CS301', name: 'Operating Systems', departmentCode: 'CSE', credits: 4 }, { code: 'CS302', name: 'Database Systems', departmentCode: 'CSE', credits: 4 }] }), 'courses');
  const students = Array.from({ length: 12 }, (_, i) => ({ externalId: `UOS-${1001 + i}`, kind: 'STUDENT' as const, fullName: `Student ${String(i + 1).padStart(2, '0')}`, email: `student${String(i + 1).padStart(2, '0')}@demo.local`, departmentCode: 'CSE', programmeCode: 'BTECH-CSE', currentSemester: 5, section: i < 6 ? 'A' : 'B', attributes: { registerNumber: `22CSE${String(i + 1).padStart(3, '0')}` } }));
  must(await K('persons').send({ rows: students }), 'persons');
  must(await K('enrollments').send({ rows: students.flatMap((s) => ['CS301', 'CS302'].map((courseCode) => ({ studentExternalId: s.externalId, courseCode, academicYear: '2026-27', term: 'ODD', section: s.section }))) }), 'enrollments');
  for (const s of students) await activate(tenantId, s.email, 'Demo-Student!2026');

  const E = { Host: HOST, Authorization: `Bearer ${staff['examcell@demo.local']}` };
  const S = E; // question setting is part of the EXAM_OFFICE bundle
  const R = { Host: HOST, Authorization: `Bearer ${staff['chief@demo.local']}` }; // paper review is part of CHIEF_REVIEWER
  const now = Date.now();
  const basic = must(await req().post('/api/v1/exams').set(E).send({ code: 'CS301-MID1', title: 'Operating Systems — Mid 1', courseCode: 'CS301', examType: 'MID_1', academicYear: '2026-27', semester: 5, maxMarks: 20, securityProfile: 'BASIC_BROWSER', durationMinutes: 60, windowStartAt: new Date(now - 5 * 60_000).toISOString(), windowEndAt: new Date(now + 6 * 3600_000).toISOString(), policy: { ipPolicy: 'REVIEW' } }), 'exam basic');
  const secure = must(await req().post('/api/v1/exams').set(E).send({ code: 'CS302-SEM', title: 'Database Systems — Semester External', courseCode: 'CS302', examType: 'SEM_EXTERNAL', academicYear: '2026-27', semester: 5, maxMarks: 70, securityProfile: 'SECURE_BYOD', durationMinutes: 180, windowStartAt: new Date(now + 2 * 86400_000).toISOString(), windowEndAt: new Date(now + 2 * 86400_000 + 5 * 3600_000).toISOString(), policy: { allowedClientBuilds: ['SEB_Win_3.8.0', 'SEB_macOS_3.4.0'], ipPolicy: 'LOCK' } }), 'exam secure');

  // 1. Author, review, approve and set-generate paper for basic exam (20 marks)
  must(await req().put(`/api/v1/exams/${basic.examId}/paper`).set(S).send({
    title: 'Operating Systems — Mid 1 Question Paper',
    instructions: 'Answer all questions. Rough work can be done in the workspace.',
    sections: [
      { code: 'A', title: 'Section A (Concepts)', instructions: 'Answer both questions' },
      { code: 'B', title: 'Section B (Applied)', instructions: 'Answer both questions' },
    ],
    questions: [
      {
        questionId: 'Q1',
        sectionCode: 'A',
        number: 1,
        kind: 'DESCRIPTIVE',
        prompt: { blocks: [{ id: 'b1', kind: 'paragraph', content: 'Explain the difference between a process and a thread. Detail the components stored in a Process Control Block (PCB).' }] },
        maxMarks: 5,
        rubric: [{ code: 'DEF', description: 'Process vs thread comparison', max: 2.5, keywords: ['address space', 'shares|share|shared', 'scheduling|scheduled|unit of execution', 'context switch'] }, { code: 'PCB', description: 'PCB components list and purpose', max: 2.5, keywords: ['program counter', 'registers', 'process state|state', 'memory-management|page table|base and limit', 'open files|I/O status'] }],
      },
      {
        questionId: 'Q2',
        sectionCode: 'A',
        number: 2,
        kind: 'DESCRIPTIVE',
        prompt: { blocks: [{ id: 'b2', kind: 'paragraph', content: 'Describe the four Coffman conditions necessary for deadlock to occur. How can deadlock prevention break the hold-and-wait condition?' }] },
        maxMarks: 5,
        rubric: [{ code: 'COND', description: 'Four Coffman conditions', max: 3, keywords: ['mutual exclusion', 'hold and wait', 'no preemption|non-preemption', 'circular wait'] }, { code: 'PREV', description: 'Hold-and-wait prevention mechanism', max: 2, keywords: ['all resources at once|request all|before execution|at the start', 'release|releases|give up'] }],
      },
      {
        questionId: 'Q3',
        sectionCode: 'B',
        number: 3,
        kind: 'NUMERIC',
        prompt: { blocks: [{ id: 'b3', kind: 'paragraph', content: 'Three processes P1(burst 6ms), P2(burst 4ms), P3(burst 2ms) arrive at t=0. Compute the average turnaround time and average waiting time under Round Robin scheduling with time quantum q=2ms.' }] },
        maxMarks: 5,
        rubric: [{ code: 'GANTT', description: 'Correct execution order and completion times', max: 3 }, { code: 'AVG', description: 'Turnaround and waiting time calculations', max: 2 }],
        // Round Robin q=2: completions P1 12, P2 10, P3 6 → average turnaround 28/3, average waiting 16/3
        expectedAnswer: { values: [9.33, 5.33], tolerance: 0.05 },
      },
      {
        questionId: 'Q4',
        sectionCode: 'B',
        number: 4,
        kind: 'DESCRIPTIVE',
        prompt: { blocks: [{ id: 'b4', kind: 'paragraph', content: 'Explain virtual memory paging. Contrast the function of a standard hierarchical page table with a Translation Lookaside Buffer (TLB). What happens during a page fault?' }] },
        maxMarks: 5,
        rubric: [{ code: 'PAGING', description: 'Paging concepts and address translation', max: 2.5, keywords: ['page|pages', 'frame|frames', 'page table', 'logical address|virtual address'] }, { code: 'TLB', description: 'TLB lookup vs page fault handling', max: 2.5, keywords: ['TLB|translation lookaside buffer', 'cache|cached', 'page fault', 'disk|secondary storage|swap'] }],
      },
    ],
  }), 'paper basic author');
  must(await req().post(`/api/v1/exams/${basic.examId}/paper/submit-for-review`).set(S), 'paper basic submit');
  must(await req().post(`/api/v1/exams/${basic.examId}/paper/approve`).set(R), 'paper basic approve');
  must(await req().post(`/api/v1/exams/${basic.examId}/paper/sets`).set(E).send({
    sets: [
      { setCode: 'A', questionOrder: ['Q1', 'Q2', 'Q3', 'Q4'] },
      { setCode: 'B', questionOrder: ['Q2', 'Q1', 'Q4', 'Q3'] },
    ],
  }), 'paper basic sets');

  // 2. Author, review, approve and set-generate paper for secure exam (70 marks)
  must(await req().put(`/api/v1/exams/${secure.examId}/paper`).set(S).send({
    title: 'Database Systems — Semester External Question Paper',
    instructions: 'All questions are compulsory. State assumptions clearly.',
    sections: [
      { code: 'A', title: 'Section A (Relational Model & Normalization)', instructions: 'Answer all 3 questions' },
      { code: 'B', title: 'Section B (Storage & Transactions)', instructions: 'Answer all 3 questions' },
    ],
    questions: [
      {
        questionId: 'Q1',
        sectionCode: 'A',
        number: 1,
        kind: 'DESCRIPTIVE',
        prompt: { blocks: [{ id: 'b1', kind: 'paragraph', content: 'Explain the ACID properties of database transactions with concrete banking scenario examples (e.g., fund transfers).' }] },
        maxMarks: 10,
        rubric: [{ code: 'ACID', description: 'Detailed definition of Atomicity, Consistency, Isolation, Durability', max: 10 }],
      },
      {
        questionId: 'Q2',
        sectionCode: 'A',
        number: 2,
        kind: 'DESCRIPTIVE',
        prompt: { blocks: [{ id: 'b2', kind: 'paragraph', content: 'Explain Boyce-Codd Normal Form (BCNF) versus Third Normal Form (3NF). When is BCNF desirable, and why might 3NF be preferred for dependency preservation?' }] },
        maxMarks: 10,
        rubric: [{ code: 'NORM', description: 'Comparison between 3NF and BCNF', max: 10 }],
      },
      {
        questionId: 'Q3',
        sectionCode: 'A',
        number: 3,
        kind: 'DESCRIPTIVE',
        prompt: { blocks: [{ id: 'b3', kind: 'paragraph', content: 'Given relations Student(roll, name, dept) and Enrolled(roll, courseId), write relational algebra expressions for: (a) Names of students enrolled in CS301, (b) Students enrolled in all courses offered by CSE.' }] },
        maxMarks: 15,
        rubric: [{ code: 'JOIN', description: 'Part A relational algebra with join/projection', max: 7 }, { code: 'DIV', description: 'Part B relational division expression', max: 8 }],
      },
      {
        questionId: 'Q4',
        sectionCode: 'B',
        number: 4,
        kind: 'DESCRIPTIVE',
        prompt: { blocks: [{ id: 'b4', kind: 'paragraph', content: 'Explain the structure of a B+ Tree index. Detail the search and insertion algorithms, including node splitting when an index node overflows.' }] },
        maxMarks: 15,
        rubric: [{ code: 'BPLUS', description: 'Node structure and search/insert operations', max: 15 }],
      },
      {
        questionId: 'Q5',
        sectionCode: 'B',
        number: 5,
        kind: 'DESCRIPTIVE',
        prompt: { blocks: [{ id: 'b5', kind: 'paragraph', content: 'Explain strict two-phase locking (Strict 2PL). How does it guarantee conflict serializability and prevent cascading aborts?' }] },
        maxMarks: 10,
        rubric: [{ code: '2PL', description: '2PL vs Strict 2PL and cascading aborts prevention', max: 10 }],
      },
      {
        questionId: 'Q6',
        sectionCode: 'B',
        number: 6,
        kind: 'DESCRIPTIVE',
        prompt: { blocks: [{ id: 'b6', kind: 'paragraph', content: 'Describe the Write-Ahead Logging (WAL) protocol and the three passes of the ARIES recovery algorithm: Analysis, Redo, and Undo.' }] },
        maxMarks: 10,
        rubric: [{ code: 'ARIES', description: 'WAL protocol and Analysis/Redo/Undo passes', max: 10 }],
      },
    ],
  }), 'paper secure author');
  must(await req().post(`/api/v1/exams/${secure.examId}/paper/submit-for-review`).set(S), 'paper secure submit');
  must(await req().post(`/api/v1/exams/${secure.examId}/paper/approve`).set(R), 'paper secure approve');
  must(await req().post(`/api/v1/exams/${secure.examId}/paper/sets`).set(E).send({
    sets: [
      { setCode: 'A', questionOrder: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6'] },
      { setCode: 'B', questionOrder: ['Q3', 'Q2', 'Q1', 'Q6', 'Q5', 'Q4'] },
    ],
  }), 'paper secure sets');

  for (const examId of [basic.examId, secure.examId]) {
    must(await req().post(`/api/v1/exams/${examId}/allocations`).set(E).send({ studentExternalIds: students.map((s) => s.externalId), provider: 'uos' }), 'allocate');
    must(await req().post(`/api/v1/exams/${examId}/hall-tickets`).set(E).send({}), 'hall tickets');
    for (const step of ['submit-for-review', 'approve', 'schedule']) must(await req().post(`/api/v1/exams/${examId}/${step}`).set(E), step);
  }
  must(await req().post(`/api/v1/exams/${basic.examId}/open-precheck`).set(E), 'open precheck');

  console.log(`
Demo tenant ready on http://${HOST}:${config.PORT} (web app proxies here)

  admin@demo.local / Demo-Admin!2026           tenant admin + Controller (publication, security waivers) + auditor + analytics
  examcell@demo.local / Demo-Staff!2026        Exam Section + Question Setter (open/start/close exams, readiness board, candidates, papers)
  chief@demo.local / Demo-Staff!2026           Chief Proctor + Paper Reviewer (incidents, holds, resume, paper approval & seal)
  evaluator@demo.local / Demo-Staff!2026       Examiner + Moderator (marks, double-evaluation moderation)
  student01..student12@demo.local / Demo-Student!2026

  Exam CS301-MID1 (BASIC_BROWSER, ipPolicy REVIEW): readiness check is open; start it as examcell when students are READY.
  Exam CS302-SEM (SECURE_BYOD, ipPolicy LOCK): scheduled in 2 days; requires an approved client build.
  ERP API key (store it): ${key.apiKey}
`);
  } finally {
    await admin.destroy();
    await closeDeps(deps);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
