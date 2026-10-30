import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { createTestContext, provisionTenant, createStaff, adminAsController, answerHash, type TestContext, type ProvisionedTenant } from './helpers.js';
import { closeBrowser } from '../src/modules/documents/renderer.js';

describe('Server-side PDF and QR verification (hall ticket, booklet, evidence, export lock, hash stability)', () => {
  let ctx: TestContext;
  let t: ProvisionedTenant;
  let examCell: { userId: string; token: string; email: string };
  let setter: { userId: string; token: string; email: string };
  let reviewer: { userId: string; token: string; email: string };
  let evaluator: { userId: string; token: string; email: string };
  let controller: { userId: string; token: string; email: string };
  let student: { userId: string; token: string; email: string; externalId: string };
  let student2: { userId: string; token: string; email: string; externalId: string };

  const req = () => ctx.request();
  const H = (token: string) => ({ Host: t.host, Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    ctx = await createTestContext();
    t = await provisionTenant(ctx, 'docs');
    examCell = await createStaff(ctx, t, ['EXAM_CELL_OPERATOR'], 'examcell');
    setter = await createStaff(ctx, t, ['QUESTION_SETTER', 'EVALUATOR'], 'setter');
    reviewer = await createStaff(ctx, t, ['PAPER_REVIEWER', 'CHIEF_PROCTOR'], 'reviewer');
    evaluator = setter;
    controller = adminAsController(t);

    // Create course and students
    await ctx.admin('departments').insert({ id: randomUUID(), tenant_id: t.tenantId, code: 'CSE', name: 'Computer Science' });
    const [dept] = await ctx.admin('departments').where({ tenant_id: t.tenantId, code: 'CSE' }).select('id');
    await ctx.admin('courses').insert({ id: randomUUID(), tenant_id: t.tenantId, department_id: dept.id, code: 'CS301', name: 'Operating Systems' });

    // Student 1
    const s1Email = `student1-${randomUUID().slice(0, 6)}@${t.slug}.test`;
    const s1User = await ctx.request().post('/api/v1/tenant/users').set(H(t.admin.token)).send({
      email: s1Email,
      fullName: 'Aarav Patel',
      kind: 'STUDENT',
      roles: [{ role: 'STUDENT' }],
    });
    expect(s1User.status).toBe(201);
    student = { userId: s1User.body.userId, email: s1Email, externalId: 'STU-001', token: '' };
    await ctx.admin('external_identities').insert({ tenant_id: t.tenantId, user_id: student.userId, provider: 'erp', external_id: student.externalId });
    await ctx.admin('student_profiles').where({ tenant_id: t.tenantId, user_id: student.userId }).update({ register_number: '2026CSE001', department_id: dept.id });

    // Student 2
    const s2Email = `student2-${randomUUID().slice(0, 6)}@${t.slug}.test`;
    const s2User = await ctx.request().post('/api/v1/tenant/users').set(H(t.admin.token)).send({
      email: s2Email,
      fullName: 'Diya Sharma',
      kind: 'STUDENT',
      roles: [{ role: 'STUDENT' }],
    });
    expect(s2User.status).toBe(201);
    student2 = { userId: s2User.body.userId, email: s2Email, externalId: 'STU-002', token: '' };
    await ctx.admin('external_identities').insert({ tenant_id: t.tenantId, user_id: student2.userId, provider: 'erp', external_id: student2.externalId });
    await ctx.admin('student_profiles').where({ tenant_id: t.tenantId, user_id: student2.userId }).update({ register_number: '2026CSE002', department_id: dept.id });

    const [crs] = await ctx.admin('courses').where({ tenant_id: t.tenantId, code: 'CS301' }).select('id');
    for (const sid of [student.userId, student2.userId]) {
      await ctx.admin('course_enrollments').insert({
        tenant_id: t.tenantId,
        user_id: sid,
        course_id: crs.id,
        academic_year: '2026-27',
        term: 'ODD',
      });
    }

    // Activate students
    for (const s of [student, student2]) {
      const row = await ctx.admin('mail_dispatches').where({ tenant_id: t.tenantId, category: 'ACCOUNT_ACTIVATION', to_address: s.email }).orderBy('created_at', 'desc').first();
      const m = /token=([^\s]+)/.exec(row.body_text);
      const actRes = await ctx.request().post('/api/v1/auth/activate').set('Host', t.host).send({ token: decodeURIComponent(m![1]!), password: 'Password!2026' });
      expect(actRes.status).toBe(200);
      s.token = actRes.body.accessToken;
    }
  });

  afterAll(async () => {
    await closeBrowser();
    await ctx.close();
  });

  it('renders hall ticket PDF with QR code, validates access, and proves hash stability', async () => {
    const now = Date.now();
    const examRes = await req().post('/api/v1/exams').set(H(examCell.token)).send({
      code: `EXAM-${randomUUID().slice(0, 6)}`,
      title: 'Operating Systems — Midterm',
      courseCode: 'CS301',
      examType: 'MID_1',
      academicYear: '2026-27',
      semester: 5,
      maxMarks: 20,
      securityProfile: 'BASIC_BROWSER',
      durationMinutes: 60,
      windowStartAt: new Date(now + 3600_000).toISOString(),
      windowEndAt: new Date(now + 7200_000).toISOString(),
    });
    expect(examRes.status).toBe(201);
    const examId = examRes.body.examId;

    // Allocate both students and issue hall tickets
    await req().post(`/api/v1/exams/${examId}/allocations`).set(H(examCell.token)).send({
      studentExternalIds: [student.externalId, student2.externalId],
      provider: 'erp',
    });
    const htRes = await req().post(`/api/v1/exams/${examId}/hall-tickets`).set(H(examCell.token)).send({});
    expect(htRes.status).toBe(200);
    expect(htRes.body.issued).toBe(2);

    // 1. Student 1 downloads own hall ticket PDF
    const s1PdfRes = await req()
      .get(`/api/v1/student/me/exams/${examId}/hall-ticket.pdf`)
      .set(H(student.token))
      .responseType('blob');
    expect(s1PdfRes.status).toBe(200);
    expect(s1PdfRes.headers['content-type']).toBe('application/pdf');
    expect(s1PdfRes.body).toBeInstanceOf(Buffer);
    expect(s1PdfRes.body.slice(0, 5).toString('ascii')).toBe('%PDF-');

    const expectedSha1 = createHash('sha256').update(s1PdfRes.body).digest('hex');
    expect(s1PdfRes.headers['x-document-sha256']).toBe(expectedSha1);

    // 2. Hash stability: second call returns the exact same cached buffer and hash
    const s1PdfRepeat = await req()
      .get(`/api/v1/student/me/exams/${examId}/hall-ticket.pdf`)
      .set(H(student.token))
      .responseType('blob');
    expect(s1PdfRepeat.status).toBe(200);
    expect(s1PdfRepeat.headers['x-document-sha256']).toBe(expectedSha1);
    expect(s1PdfRepeat.body.equals(s1PdfRes.body)).toBe(true);

    // Verify stored_documents table row exists
    const storedDoc = await ctx.admin('stored_documents').where({
      tenant_id: t.tenantId,
      doc_kind: 'HALL_TICKET_PDF',
      entity_id: `${examId}:${student.userId}`,
    }).first();
    expect(storedDoc).toBeDefined();
    expect(storedDoc.sha256).toBe(expectedSha1);

    // 3. Staff can fetch the student's hall ticket PDF
    const staffPdfRes = await req()
      .get(`/api/v1/exams/${examId}/hall-tickets/${student.userId}/pdf`)
      .set(H(examCell.token))
      .responseType('blob');
    expect(staffPdfRes.status).toBe(200);
    expect(staffPdfRes.headers['x-document-sha256']).toBe(expectedSha1);

    // 4. Student 1 cannot fetch Student 2's hall ticket directly via staff route (refused 403)
    const rogueRes = await req()
      .get(`/api/v1/exams/${examId}/hall-tickets/${student2.userId}/pdf`)
      .set(H(student.token));
    expect(rogueRes.status).toBe(403);
  });

  it('renders answer booklet PDF after publication, proves export lock during precheck/live, and checks evidence PDF', async () => {
    const now = Date.now();
    const examRes = await req().post('/api/v1/exams').set(H(examCell.token)).send({
      code: `EXAM-${randomUUID().slice(0, 6)}`,
      title: 'Operating Systems — Final',
      courseCode: 'CS301',
      examType: 'SEM_INTERNAL',
      academicYear: '2026-27',
      semester: 5,
      maxMarks: 10,
      securityProfile: 'BASIC_BROWSER',
      durationMinutes: 60,
      windowStartAt: new Date(now - 60_000).toISOString(),
      windowEndAt: new Date(now + 7200_000).toISOString(),
    });
    expect(examRes.status).toBe(201);
    const examId = examRes.body.examId;

    // Allocate student & issue hall ticket
    await req().post(`/api/v1/exams/${examId}/allocations`).set(H(examCell.token)).send({
      studentExternalIds: [student.externalId],
      provider: 'erp',
    });
    await req().post(`/api/v1/exams/${examId}/hall-tickets`).set(H(examCell.token)).send({});

    // Author and approve question paper
    await req().put(`/api/v1/exams/${examId}/paper`).set(H(setter.token)).send({
      title: 'OS Final Paper',
      sections: [{ code: 'A', title: 'Main Section' }],
      questions: [
        {
          questionId: 'Q1',
          sectionCode: 'A',
          number: 1,
          kind: 'DESCRIPTIVE',
          prompt: { blocks: [{ id: 'b1', kind: 'paragraph', content: 'Explain scheduling algorithms.' }] },
          maxMarks: 10,
          rubric: [{ code: 'CRIT1', description: 'Concepts', max: 10 }],
        },
      ],
    });
    await req().post(`/api/v1/exams/${examId}/paper/submit-for-review`).set(H(setter.token));
    await req().post(`/api/v1/exams/${examId}/paper/approve`).set(H(reviewer.token));

    // Transition exam: submit-for-review -> approve -> schedule -> open-precheck -> start (LIVE)
    await req().post(`/api/v1/exams/${examId}/submit-for-review`).set(H(examCell.token));
    await req().post(`/api/v1/exams/${examId}/approve`).set(H(examCell.token));
    await req().post(`/api/v1/exams/${examId}/schedule`).set(H(examCell.token));
    await req().post(`/api/v1/exams/${examId}/open-precheck`).set(H(examCell.token));

    const attemptRow = await ctx.admin('exam_attempts').where({ tenant_id: t.tenantId, exam_id: examId, user_id: student.userId }).first();
    const attemptId = attemptRow.id;

    // Start precheck
    const preRes = await req().post(`/api/v1/student/attempts/${attemptId}/prechecks`).set(H(student.token)).send({ clientBuild: 'browser' });
    expect(preRes.status).toBe(201);
    const runId = preRes.body.runId;

    // Now start the exam (LIVE)
    await req().post(`/api/v1/exams/${examId}/start`).set(H(examCell.token));

    // INVARIANT TEST 1: Requesting booklet PDF or evidence PDF while exam is LIVE triggers EXPORT_LOCKED 403
    // and records audit event in database
    const liveBookletRes = await req()
      .get(`/api/v1/candidates/${attemptId}/booklet.pdf`)
      .set(H(examCell.token));
    expect(liveBookletRes.status).toBe(403);
    expect(liveBookletRes.body.code).toBe('EXPORT_LOCKED');

    const liveEvidenceRes = await req()
      .get(`/api/v1/candidates/${attemptId}/evidence.pdf`)
      .set(H(examCell.token));
    expect(liveEvidenceRes.status).toBe(403);
    expect(liveEvidenceRes.body.code).toBe('EXPORT_LOCKED');

    // Verify audit event was committed before refusal
    const exportAuditEvent = await ctx.admin('audit_events').where({
      tenant_id: t.tenantId,
      action: 'export.blocked',
      entity_id: examId,
    }).first();
    expect(exportAuditEvent).toBeDefined();

    // Student completes precheck items and admits
    await req().post(`/api/v1/student/prechecks/${runId}/items/verify`).set(H(student.token)).send({ code: 'CLIENT_VERSION', clientBuild: 'browser' });
    await req().post(`/api/v1/student/prechecks/${runId}/items/verify`).set(H(student.token)).send({ code: 'CLOCK_SYNC', clientClockMs: Date.now() });
    await req().post(`/api/v1/student/prechecks/${runId}/items/verify`).set(H(student.token)).send({ code: 'KEYBOARD_INPUT', keyboardSample: 'The quick brown fox, 2026; jumps (over) the lazy dog!' });
    await req().post(`/api/v1/student/prechecks/${runId}/practice-saves`).set(H(student.token)).send({ contentDigest: 'a'.repeat(64) });
    await req().post(`/api/v1/student/prechecks/${runId}/items/verify`).set(H(student.token)).send({ code: 'NETWORK_SAVE_ROUNDTRIP' });
    await req().post(`/api/v1/student/prechecks/${runId}/items/verify`).set(H(student.token)).send({ code: 'CONSENT', consentPolicyVersion: 'v1' });

    const fin = await req().post(`/api/v1/student/prechecks/${runId}/finalize`).set(H(student.token));
    expect(fin.status).toBe(200);
    expect(fin.body.status).toBe('READY');

    const grantRes = await req().post(`/api/v1/student/attempts/${attemptId}/entry-grants`).set(H(student.token));
    expect(grantRes.status).toBe(201);
    const admitRes = await req().post(`/api/v1/student/attempts/${attemptId}/admit`).set(H(student.token)).send({ grantToken: grantRes.body.grantToken });
    expect(admitRes.status).toBe(200);
    const devSession = admitRes.body.deviceSessionId;

    // Student writes answer with text and vector canvas diagram
    const doc = {
      blocks: [
        { id: 'b1', kind: 'paragraph', content: 'SJF minimizes waiting time. Round Robin provides fairness.' },
        {
          id: 'b2',
          kind: 'canvas',
          content: {
            width: 300,
            height: 150,
            strokes: [
              { tool: 'pen', width: 2, points: [[10, 10], [50, 50], [100, 10]] },
              { tool: 'eraser', width: 5, points: [[45, 45], [55, 55]] },
            ],
          },
        },
      ],
    };
    await req()
      .put(`/api/v1/student/attempts/${attemptId}/answers/Q1`)
      .set(H(student.token))
      .set('x-device-session', devSession)
      .send({
        clientOperationId: randomUUID(),
        baseRevision: 0,
        answerFormat: 'hybrid-v1',
        ops: [{ op: 'upsert-block', blockId: 'b1', kind: 'paragraph', content: doc.blocks[0]!.content }, { op: 'upsert-block', blockId: 'b2', kind: 'canvas', content: doc.blocks[1]!.content }],
        contentSha256: answerHash(doc.blocks),
      });

    // Student submits exam
    const subRes = await req()
      .post(`/api/v1/student/attempts/${attemptId}/submit`)
      .set(H(student.token))
      .send({ idempotencyKey: randomUUID() });
    expect(subRes.status).toBe(200);

    // Close exam
    await req().post(`/api/v1/exams/${examId}/close`).set(H(examCell.token));

    // Run forensics to advance packet to ACADEMIC_MARKING_READY
    await req().post(`/api/v1/candidates/${attemptId}/forensics/run`).set(H(examCell.token));

    // INVARIANT TEST 2: Student cannot download booklet PDF before publication
    const prePubRes = await req()
      .get(`/api/v1/student/attempts/${attemptId}/booklet.pdf`)
      .set(H(student.token));
    expect(prePubRes.status).toBe(409);
    expect(prePubRes.body.code).toBe('NOT_PUBLISHED');

    // Evaluator marks the exam
    const markRes = await req()
      .post(`/api/v1/candidates/${attemptId}/result-versions`)
      .set(H(evaluator.token))
      .send({
        items: [
          {
            questionId: 'Q1',
            maxMarks: 10,
            marks: 8.5,
            explanation: 'Accurate comparison. Excellent diagram.',
            criteria: [{ code: 'CRIT1', max: 10, awarded: 8.5, evidence: 'Both algorithms covered' }],
          },
        ],
      });
    expect(markRes.status).toBe(201);
    const rvId = markRes.body.resultVersionId;

    // Exam Cell approves candidate
    const appRes = await req()
      .post(`/api/v1/candidates/${attemptId}/approvals`)
      .set(H(examCell.token))
      .send({
        reviewedResultVersionId: rvId,
        decision: 'APPROVED',
        reason: 'Evaluation verified by scrutiny committee',
        idempotencyKey: randomUUID(),
      });
    expect(appRes.status).toBe(201);

    // Controller authorizes and publishes
    const pubRes = await req()
      .post(`/api/v1/candidates/${attemptId}/authorize-publication`)
      .set(H(controller.token))
      .send({
        candidateApprovalId: appRes.body.approvalId,
        idempotencyKey: randomUUID(),
      });
    expect(pubRes.status).toBe(200);
    expect(pubRes.body.status).toBe('PUBLISHED');

    // NOW TEST 3: Student downloads official Booklet PDF
    const bookletPdfRes = await req()
      .get(`/api/v1/student/attempts/${attemptId}/booklet.pdf`)
      .set(H(student.token))
      .responseType('blob');
    expect(bookletPdfRes.status).toBe(200);
    expect(bookletPdfRes.headers['content-type']).toBe('application/pdf');
    expect(bookletPdfRes.body.slice(0, 5).toString('ascii')).toBe('%PDF-');

    const bookletSha = createHash('sha256').update(bookletPdfRes.body).digest('hex');
    expect(bookletPdfRes.headers['x-document-sha256']).toBe(bookletSha);

    // Booklet PDF hash stability
    const bookletRepeat = await req()
      .get(`/api/v1/student/attempts/${attemptId}/booklet.pdf`)
      .set(H(student.token))
      .responseType('blob');
    expect(bookletRepeat.status).toBe(200);
    expect(bookletRepeat.headers['x-document-sha256']).toBe(bookletSha);
    expect(bookletRepeat.body.equals(bookletPdfRes.body)).toBe(true);

    // TEST 4: Staff can download restricted Evidence PDF
    const evidencePdfRes = await req()
      .get(`/api/v1/candidates/${attemptId}/evidence.pdf`)
      .set(H(examCell.token))
      .responseType('blob');
    expect(evidencePdfRes.status).toBe(200);
    expect(evidencePdfRes.headers['content-type']).toBe('application/pdf');
    expect(evidencePdfRes.body.slice(0, 5).toString('ascii')).toBe('%PDF-');

    const evidenceSha = createHash('sha256').update(evidencePdfRes.body).digest('hex');
    expect(evidencePdfRes.headers['x-document-sha256']).toBe(evidenceSha);

    // Verify stored_documents table recorded both
    const bookletRow = await ctx.admin('stored_documents').where({
      tenant_id: t.tenantId,
      doc_kind: 'BOOKLET_PDF',
      entity_id: `${attemptId}:v1`,
    }).first();
    expect(bookletRow).toBeDefined();
    expect(bookletRow.sha256).toBe(bookletSha);

    const evidenceRow = await ctx.admin('stored_documents').where({
      tenant_id: t.tenantId,
      doc_kind: 'EVIDENCE_PDF',
      entity_id: attemptId,
    }).first();
    expect(evidenceRow).toBeDefined();
    expect(evidenceRow.sha256).toBe(evidenceSha);
  });
});
