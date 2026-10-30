import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestContext, provisionTenant, createStaff, answerHash, cleanScan, type TestContext, type ProvisionedTenant } from './helpers.js';

describe('Question paper module (authoring, review, encrypted seal, release, marking validation)', () => {
  let ctx: TestContext;
  let t: ProvisionedTenant;
  let examCell: { userId: string; token: string; email: string };
  let setter: { userId: string; token: string; email: string };
  let reviewer: { userId: string; token: string; email: string };
  let student: { userId: string; token: string; email: string; externalId: string; attemptId?: string };

  const req = () => ctx.request();
  const H = (token: string) => ({ Host: t.host, Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    ctx = await createTestContext();
    t = await provisionTenant(ctx, 'paper');
    examCell = await createStaff(ctx, t, ['EXAM_CELL_OPERATOR'], 'examcell');
    setter = await createStaff(ctx, t, ['QUESTION_SETTER', 'EVALUATOR'], 'setter');
    reviewer = await createStaff(ctx, t, ['PAPER_REVIEWER'], 'reviewer');

    // Create course and student through admin / integration
    await ctx.admin('departments').insert({ id: randomUUID(), tenant_id: t.tenantId, code: 'CSE', name: 'Computer Science' });
    const [dept] = await ctx.admin('departments').where({ tenant_id: t.tenantId, code: 'CSE' }).select('id');
    await ctx.admin('courses').insert({ id: randomUUID(), tenant_id: t.tenantId, department_id: dept.id, code: 'CS201', name: 'Data Structures' });

    // Create student
    const studentEmail = `student-${randomUUID().slice(0, 6)}@${t.slug}.test`;
    const studentUser = await ctx.request().post('/api/v1/tenant/users').set('Host', t.host).set('Authorization', `Bearer ${t.admin.token}`).send({
      email: studentEmail,
      fullName: 'Sita Raman',
      kind: 'STUDENT',
      roles: [{ role: 'STUDENT' }],
    });
    expect(studentUser.status).toBe(201);
    const sId = studentUser.body.userId;
    student = {
      userId: sId,
      email: studentEmail,
      externalId: 'STU-101',
      token: '',
    };
    await ctx.admin('external_identities').insert({
      tenant_id: t.tenantId,
      user_id: sId,
      provider: 'erp',
      external_id: student.externalId,
    });
    await ctx.admin('student_profiles').where({ tenant_id: t.tenantId, user_id: sId }).update({
      register_number: '2026CSE001',
      department_id: dept.id,
    });

    const [crs] = await ctx.admin('courses').where({ tenant_id: t.tenantId, code: 'CS201' }).select('id');
    await ctx.admin('course_enrollments').insert({
      tenant_id: t.tenantId,
      user_id: sId,
      course_id: crs.id,
      academic_year: '2026-27',
      term: 'ODD',
      eligibility_status: 'ELIGIBLE',
    });

    // Activate student
    const actToken = await ctx.admin('mail_dispatches').where({ tenant_id: t.tenantId, category: 'ACCOUNT_ACTIVATION', to_address: student.email.toLowerCase() }).orderBy('created_at', 'desc').first('body_text');
    expect(actToken).toBeDefined();
    const match = /token=([^\s]+)/.exec(actToken.body_text as string);
    expect(match).not.toBeNull();
    const act = await ctx.request().post('/api/v1/auth/activate').set('Host', t.host).send({ token: decodeURIComponent(match![1]!), password: 'Student-Passw0rd!2026' });
    expect(act.status).toBe(200);
    student.token = act.body.accessToken;
    student.userId = act.body.user.id;
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('enforces authoring, validation, review, approval, and exam transition gates', async () => {
    const start = new Date(Date.now() - 5 * 60_000);
    const end = new Date(Date.now() + 2 * 3600_000);

    // 1. Create exam with maxMarks = 25
    const examRes = await req()
      .post('/api/v1/exams')
      .set(H(examCell.token))
      .send({
        code: 'CS201-MID',
        title: 'Data Structures Mid Exam',
        courseCode: 'CS201',
        examType: 'MID_1',
        maxMarks: 25,
        securityProfile: 'BASIC_BROWSER',
        durationMinutes: 60,
        windowStartAt: start.toISOString(),
        windowEndAt: end.toISOString(),
      });
    expect(examRes.status).toBe(201);
    const examId = examRes.body.examId;

    // Transition to PAPER_REVIEW
    const toReview = await req().post(`/api/v1/exams/${examId}/submit-for-review`).set(H(examCell.token));
    expect(toReview.status).toBe(200);

    // 2. Exam cannot move PAPER_REVIEW -> APPROVED without an approved paper
    const prematureApprove = await req().post(`/api/v1/exams/${examId}/approve`).set(H(examCell.token));
    expect(prematureApprove.status).toBe(422);
    expect(prematureApprove.body.code).toBe('APPROVED_PAPER_REQUIRED');

    // 3. Question setter drafts paper with marks mismatch (e.g. 20 marks instead of 25)
    const paperPayload = {
      title: 'CS201 Mid Examination Paper',
      instructions: 'Answer all questions clearly.',
      sections: [
        { code: 'A', title: 'Part A', instructions: 'Short answers' },
        { code: 'B', title: 'Part B', instructions: 'Detailed analysis' },
      ],
      questions: [
        {
          questionId: 'q1',
          sectionCode: 'A',
          number: 1,
          kind: 'DESCRIPTIVE' as const,
          prompt: { blocks: [{ id: 'b1', kind: 'paragraph', content: 'Explain amortized time complexity.' }] },
          maxMarks: 10,
          rubric: [{ code: 'DEF', max: 5, description: 'Definition' }, { code: 'EX', max: 5, description: 'Example' }],
          expectedAnswer: { blocks: [{ id: 'ea1', kind: 'paragraph', content: 'Amortized analysis averages the time...' }] },
          attachments: [],
        },
        {
          questionId: 'q2',
          sectionCode: 'B',
          number: 2,
          kind: 'DESCRIPTIVE' as const,
          prompt: { blocks: [{ id: 'b2', kind: 'paragraph', content: 'Implement an AVL tree rotation.' }] },
          maxMarks: 10,
          rubric: [{ code: 'ROT', max: 10, description: 'Correct single/double rotations' }],
          expectedAnswer: { blocks: [{ id: 'ea2', kind: 'paragraph', content: 'Left and right rotations maintain height balance...' }] },
          attachments: [],
        },
      ],
    };

    // Ordinary student cannot draft paper (forbidden)
    const forbiddenDraft = await req().put(`/api/v1/exams/${examId}/paper`).set(H(student.token)).send(paperPayload);
    expect(forbiddenDraft.status).toBe(403);

    // Setter saves draft
    const draftRes = await req().put(`/api/v1/exams/${examId}/paper`).set(H(setter.token)).send(paperPayload);
    expect(draftRes.status).toBe(200);
    expect(draftRes.body.totalMarks).toBe(20);
    expect(draftRes.body.questionCount).toBe(2);

    // 4. Setter submits paper for review
    const submitForRev = await req().post(`/api/v1/exams/${examId}/paper/submit-for-review`).set(H(setter.token));
    expect(submitForRev.status).toBe(200);
    expect(submitForRev.body.status).toBe('REVIEW');

    // 5. Paper reviewer attempts to approve, but marks mismatch (20 != 25)
    const mismatchApprove = await req().post(`/api/v1/exams/${examId}/paper/approve`).set(H(reviewer.token));
    expect(mismatchApprove.status).toBe(422);
    expect(mismatchApprove.body.code).toBe('PAPER_MARKS_MISMATCH');

    // 6. Reviewer rejects paper with feedback
    const rejectRes = await req()
      .post(`/api/v1/exams/${examId}/paper/reject`)
      .set(H(reviewer.token))
      .send({ feedback: 'Add question 3 for 5 marks to reach 25 marks total.' });
    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.status).toBe('DRAFT');

    // 7. Setter updates paper to 25 marks
    const updatedPayload = {
      ...paperPayload,
      questions: [
        ...paperPayload.questions,
        {
          questionId: 'q3',
          sectionCode: 'A',
          number: 3,
          kind: 'MCQ' as const,
          prompt: { blocks: [{ id: 'b3', kind: 'paragraph', content: 'What is the worst-case lookup in a hash table?' }] },
          options: [
            { key: 'A', text: 'O(1)' },
            { key: 'B', text: 'O(log n)' },
            { key: 'C', text: 'O(n)' },
            { key: 'D', text: 'O(n^2)' },
          ],
          maxMarks: 5,
          rubric: [{ code: 'CORR', max: 5, description: 'Correct choice C' }],
          expectedAnswer: { key: 'C' },
          attachments: [],
        },
      ],
    };
    const updateRes = await req().put(`/api/v1/exams/${examId}/paper`).set(H(setter.token)).send(updatedPayload);
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.totalMarks).toBe(25);

    // Submit for review again
    await req().post(`/api/v1/exams/${examId}/paper/submit-for-review`).set(H(setter.token));

    // Optional set configuration
    const setsRes = await req()
      .post(`/api/v1/exams/${examId}/paper/sets`)
      .set(H(setter.token))
      .send({
        sets: [
          { setCode: 'SET-A', questionOrder: ['q1', 'q2', 'q3'] },
          { setCode: 'SET-B', questionOrder: ['q3', 'q1', 'q2'] },
        ],
      });
    expect(setsRes.status).toBe(200);
    expect(setsRes.body.setCount).toBe(2);

    // 8. Reviewer approves paper (now 25 == 25)
    const approveRes = await req().post(`/api/v1/exams/${examId}/paper/approve`).set(H(reviewer.token));
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.status).toBe('APPROVED');
    expect(approveRes.body.sealedSha256).toMatch(/^[a-f0-9]{64}$/);

    // 9. Verify paper encryption at rest in database
    const paperRow = await ctx.admin('question_papers').where({ id: approveRes.body.paperId }).first();
    expect(paperRow.status).toBe('APPROVED');
    expect(paperRow.encrypted_body).not.toBeNull();
    expect(Buffer.isBuffer(paperRow.encrypted_body)).toBe(true);

    // 10. Audit on early view before LIVE
    const staffView = await req().get(`/api/v1/exams/${examId}/paper`).set(H(examCell.token));
    expect(staffView.status).toBe(200);
    const auditRow = await ctx.admin('audit_events').where({
      tenant_id: t.tenantId,
      action: 'paper.viewed',
      entity_id: approveRes.body.paperId,
    }).first();
    expect(auditRow).toBeDefined();

    // 11. Exam transition to APPROVED now succeeds!
    const examApprove = await req().post(`/api/v1/exams/${examId}/approve`).set(H(examCell.token));
    expect(examApprove.status).toBe(200);

    // Schedule exam and allocate student
    await req().post(`/api/v1/exams/${examId}/schedule`).set(H(examCell.token));
    const alloc = await req().post(`/api/v1/exams/${examId}/allocations`).set(H(examCell.token)).send({ studentExternalIds: [student.externalId], provider: 'erp' });
    expect(alloc.status).toBe(200);
    expect(alloc.body.allocated).toBe(1);
    await req().post(`/api/v1/exams/${examId}/hall-tickets`).set(H(examCell.token)).send({});

    // Get attemptId for student
    const myExams = await req().get('/api/v1/student/me/exams').set(H(student.token));
    expect(myExams.status).toBe(200);
    student.attemptId = myExams.body.exams[0].attemptId;

    // 12. Student cannot fetch paper while exam is SCHEDULED or attempt is ALLOCATED
    const studentEarly = await req().get(`/api/v1/student/attempts/${student.attemptId}/paper`).set(H(student.token));
    expect([403, 409]).toContain(studentEarly.status);

    // Open precheck and complete readiness
    await req().post(`/api/v1/exams/${examId}/open-precheck`).set(H(examCell.token));
    const preRes = await req().post(`/api/v1/student/attempts/${student.attemptId}/prechecks`).set(H(student.token)).send({});
    const runId = preRes.body.runId;
    await req().post(`/api/v1/student/prechecks/${runId}/items/verify`).set(H(student.token)).send({ code: 'CLOCK_SYNC', clientClockMs: Date.now() });
    await req().post(`/api/v1/student/prechecks/${runId}/items/verify`).set(H(student.token)).send({ code: 'KEYBOARD_INPUT', keyboardSample: 'The quick brown fox, 2026; jumps (over) the lazy dog!' });
    await req().post(`/api/v1/student/prechecks/${runId}/items/verify`).set(H(student.token)).send({ code: 'SYSTEM_SCAN', scan: cleanScan() });
    const practiceHash = 'a'.repeat(64);
    const ps = await req().post(`/api/v1/student/prechecks/${runId}/practice-saves`).set(H(student.token)).send({ contentDigest: practiceHash });
    expect(ps.status).toBe(200);
    await req().post(`/api/v1/student/prechecks/${runId}/items/verify`).set(H(student.token)).send({ code: 'NETWORK_SAVE_ROUNDTRIP' });
    const fin = await req().post(`/api/v1/student/prechecks/${runId}/finalize`).set(H(student.token));
    expect(fin.status).toBe(200);
    expect(fin.body.status).toBe('READY');

    // Exam moves to LIVE
    await req().post(`/api/v1/exams/${examId}/start`).set(H(examCell.token));

    // Student enters and admits
    const grantRes = await req().post(`/api/v1/student/attempts/${student.attemptId}/entry-grants`).set(H(student.token));
    expect(grantRes.status).toBe(201);
    const admitRes = await req().post(`/api/v1/student/attempts/${student.attemptId}/admit`).set(H(student.token)).send({ grantToken: grantRes.body.grantToken });
    expect(admitRes.status).toBe(200);
    const deviceSessionId = admitRes.body.deviceSessionId;

    // 13. Concurrency race test: multiple concurrent requests to release student paper
    const releases = await Promise.all([
      req().get(`/api/v1/student/attempts/${student.attemptId}/paper`).set(H(student.token)),
      req().get(`/api/v1/student/attempts/${student.attemptId}/paper`).set(H(student.token)),
      req().get(`/api/v1/student/attempts/${student.attemptId}/paper`).set(H(student.token)),
    ]);
    for (const r of releases) {
      expect(r.status).toBe(200);
      expect(r.body.totalMarks).toBe(25);
      expect(r.body.questions.length).toBe(3);
      // NEVER leak expectedAnswer or rubric to student
      for (const q of r.body.questions) {
        expect(q.expectedAnswer).toBeUndefined();
        expect(q.rubric).toBeUndefined();
      }
    }
    // Database has exactly ONE paper_release row for this attempt
    const releaseRows = await ctx.admin('paper_releases').where({ tenant_id: t.tenantId, attempt_id: student.attemptId });
    expect(releaseRows.length).toBe(1);

    // 14. Candidate paper endpoint for evaluators / staff (includes rubric and expectedAnswer)
    const candidatePaper = await req().get(`/api/v1/candidates/${student.attemptId}/paper`).set(H(examCell.token));
    expect(candidatePaper.status).toBe(200);
    expect(candidatePaper.body.questions[0].rubric).toBeDefined();
    expect(candidatePaper.body.questions[0].expectedAnswer).toBeDefined();

    // 15. Marks validation against the paper: submit attempt then mark
    const ansBlocks = [{ id: 'ans1', kind: 'paragraph', content: 'My answer to amortized analysis' }];
    const saveAns = await req()
      .put(`/api/v1/student/attempts/${student.attemptId}/answers/q1`)
      .set(H(student.token))
      .set('x-device-session', deviceSessionId)
      .send({
        clientOperationId: randomUUID(),
        baseRevision: 0,
        answerFormat: 'hybrid-v1',
        ops: [{ op: 'upsert-block', blockId: 'ans1', kind: 'paragraph', content: 'My answer to amortized analysis' }],
        contentSha256: answerHash(ansBlocks),
      });
    expect(saveAns.status).toBe(200);

    const sub = await req().post(`/api/v1/student/attempts/${student.attemptId}/submit`).set(H(student.token)).send({ idempotencyKey: randomUUID() });
    expect(sub.status).toBe(200);

    // Student cannot fetch paper after seal
    const postSealFetch = await req().get(`/api/v1/student/attempts/${student.attemptId}/paper`).set(H(student.token));
    expect(postSealFetch.status).toBe(409);
    expect(postSealFetch.body.code).toBe('ATTEMPT_SEALED');

    // Run forensics to advance packet to ACADEMIC_MARKING_READY
    await req().post(`/api/v1/candidates/${student.attemptId}/forensics/run`).set(H(examCell.token));

    // Evaluator tries to mark question with marks > maxMarks (q1 maxMarks is 10, try 15)
    const evaluator = setter; // the setter also marks (four logins per tenant)
    const overMark = await req().post(`/api/v1/candidates/${student.attemptId}/result-versions`).set(H(evaluator.token)).send({
      items: [
        { questionId: 'q1', marks: 15, maxMarks: 10, explanation: 'Too generous marks' },
      ],
    });
    expect(overMark.status).toBe(422);
    expect(overMark.body.code).toBe('MARK_OUT_OF_RANGE');

    // Evaluator tries to mark an unknown question not in the paper
    const unknownQ = await req().post(`/api/v1/candidates/${student.attemptId}/result-versions`).set(H(evaluator.token)).send({
      items: [
        { questionId: 'q999', marks: 0, maxMarks: 5, explanation: 'Not in paper' },
      ],
    });
    expect(unknownQ.status).toBe(422);
    expect(unknownQ.body.code).toBe('UNKNOWN_QUESTION_ID');

    // Evaluator marks with valid marks respecting paper maxMarks
    const validMark = await req().post(`/api/v1/candidates/${student.attemptId}/result-versions`).set(H(evaluator.token)).send({
      items: [
        {
          questionId: 'q1',
          marks: 8,
          maxMarks: 10,
          explanation: 'Clear explanation of potential method',
          criteria: [{ code: 'DEF', max: 5, awarded: 4 }, { code: 'EX', max: 5, awarded: 4 }],
        },
      ],
    });
    expect(validMark.status).toBe(201);
  });
});
