import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestContext, provisionTenant, setStaffRoles, type TestContext, type ProvisionedTenant } from './helpers.js';

describe('Phase 6 — Evaluation at Scale, Moderation, and Revaluation', () => {
  let ctx: TestContext;
  let t: ProvisionedTenant;
  const H = (token: string) => ({ Host: t.host, Authorization: `Bearer ${token}` });
  const req = () => ctx.request();

  let courseId: string;
  let student1: { userId: string; email: string; token: string; registerNumber: string };
  let student2: { userId: string; email: string; token: string; registerNumber: string };
  let student3: { userId: string; email: string; token: string; registerNumber: string };
  let evaluator1: { userId: string; email: string; token: string };
  let evaluator2: { userId: string; email: string; token: string };
  let moderator: { userId: string; email: string; token: string };
  let examCell: { userId: string; email: string; token: string };
  let controller: { userId: string; email: string; token: string };

  beforeAll(async () => {
    ctx = await createTestContext();
    t = await provisionTenant(ctx, 'smru-eval-scale');

    const courseRes = await ctx.admin('courses').insert({
      id: randomUUID(),
      tenant_id: t.tenantId,
      code: 'CS601',
      name: 'Advanced Distributed Systems',
    }).returning('id');
    courseId = courseRes[0]!.id;

    async function createUser(
      email: string,
      fullName: string,
      kind: 'STUDENT' | 'STAFF',
      roles: Array<{ role: string; scopeType?: string; scopeId?: string | null }>,
    ) {
      const uRes = await req()
        .post('/api/v1/tenant/users')
        .set(H(t.admin.token))
        .send({
          email,
          fullName,
          kind,
          roles: roles.map((r) => ({
            role: r.role,
            scopeType: r.scopeType ?? 'TENANT',
            ...(r.scopeId ? { scopeId: r.scopeId } : {}),
          })),
        });
      expect(uRes.status).toBe(201);
      const userId = uRes.body.userId as string;

      const mailRow = await ctx.admin('mail_dispatches')
        .where({ tenant_id: t.tenantId, category: 'ACCOUNT_ACTIVATION', to_address: email })
        .orderBy('created_at', 'desc')
        .first();
      const m = /token=([^\s]+)/.exec(mailRow.body_text);
      const actRes = await req().post('/api/v1/auth/activate').set('Host', t.host).send({
        token: decodeURIComponent(m![1]!),
        password: 'Password!2026',
      });
      expect(actRes.status).toBe(200);

      return { userId, email, token: actRes.body.accessToken as string };
    }

    const s1 = await createUser('student.eval1@demo.local', 'Aarav Sharma', 'STUDENT', [{ role: 'STUDENT', scopeType: 'TENANT' }]);
    student1 = { ...s1, registerNumber: '2026-CS-0201' };

    const s2 = await createUser('student.eval2@demo.local', 'Bhavna Menon', 'STUDENT', [{ role: 'STUDENT', scopeType: 'TENANT' }]);
    student2 = { ...s2, registerNumber: '2026-CS-0202' };

    const s3 = await createUser('student.eval3@demo.local', 'Chetan Roy', 'STUDENT', [{ role: 'STUDENT', scopeType: 'TENANT' }]);
    student3 = { ...s3, registerNumber: '2026-CS-0203' };

    evaluator1 = await createUser('evaluator1@demo.local', 'Prof. Evaluation One', 'STAFF', [{ role: 'EVALUATOR', scopeType: 'TENANT' }]);
    evaluator2 = await createUser('evaluator2@demo.local', 'Prof. Evaluation Two', 'STAFF', [{ role: 'EVALUATOR', scopeType: 'TENANT' }]);
    examCell = await createUser('examcell.eval@demo.local', 'Exam Cell Lead', 'STAFF', [{ role: 'EXAM_CELL_OPERATOR', scopeType: 'TENANT' }]);
    // Four logins: two examiners, the examination section, and the admin/controller who also moderates
    // (a moderator never marks the first two versions, and the approver is never the author of the approved version).
    controller = { userId: t.admin.userId, email: t.admin.email, token: t.admin.token };
    await setStaffRoles(ctx, t, t.admin.userId, ['TENANT_ADMIN', 'CONTROLLER', 'SECURITY_AUDITOR', 'MODERATOR']);
    moderator = controller;
  });

  afterAll(async () => {
    await ctx.close();
  });

  async function createSealedExamWithCandidates(
    examType: 'MID_1' | 'SEM_EXTERNAL' = 'SEM_EXTERNAL',
    doubleEval: boolean = true,
  ) {
    const examRes = await ctx.admin('exams').insert({
      id: randomUUID(),
      tenant_id: t.tenantId,
      code: `EXAM-${randomUUID().slice(0, 8)}`,
      title: 'Distributed Consensus & Fault Tolerance',
      course_id: courseId,
      academic_year: '2026-27',
      semester: 6,
      exam_type: examType,
      security_profile: 'BASIC_BROWSER',
      status: 'CLOSED',
      duration_minutes: 180,
      window_start_at: new Date(Date.now() - 7200_000),
      window_end_at: new Date(Date.now() - 3600_000),
      max_marks: 100,
      policy: {
        doubleEvaluation: doubleEval,
        divergenceThresholdPct: 15,
        anonymizeEvaluation: examType === 'SEM_EXTERNAL',
      },
      created_by: examCell.userId,
    }).returning('*');
    const exam = examRes[0]!;

    // Create approved question paper
    const paperRes = await ctx.admin('question_papers').insert({
      id: randomUUID(),
      tenant_id: t.tenantId,
      exam_id: exam.id,
      version: 1,
      status: 'APPROVED',
      title: 'Consensus Examination Paper',
      total_marks: 100,
      sections: JSON.stringify([{ code: 'A', title: 'Part A' }]),
      created_by: examCell.userId,
    }).returning('id');
    const paperId = paperRes[0]!.id;

    await ctx.admin('paper_questions').insert([
      {
        id: randomUUID(),
        tenant_id: t.tenantId,
        paper_id: paperId,
        question_id: 'Q1',
        section_code: 'A',
        number: 1,
        kind: 'DESCRIPTIVE',
        prompt: JSON.stringify({ blocks: [{ kind: 'paragraph', content: 'Explain Raft consensus leader election and log replication.' }] }),
        max_marks: 50,
        rubric: JSON.stringify([
          { code: 'ELECTION', max: 25, description: 'Leader election safety and term timers' },
          { code: 'REPLICATION', max: 25, description: 'Log matching property and commit index' },
        ]),
      },
      {
        id: randomUUID(),
        tenant_id: t.tenantId,
        paper_id: paperId,
        question_id: 'Q2',
        section_code: 'A',
        number: 2,
        kind: 'DESCRIPTIVE',
        prompt: JSON.stringify({ blocks: [{ kind: 'paragraph', content: 'Describe Byzantine fault tolerance in asynchronous networks.' }] }),
        max_marks: 50,
        rubric: JSON.stringify([
          { code: 'BOUND', max: 25, description: 'Proof that 3f+1 nodes are required for f Byzantine faults' },
          { code: 'VIEWCHANGE', max: 25, description: 'View change protocol and checkpoint certificates' },
        ]),
      },
    ]);

    // Create 3 attempts and candidate review packets
    const students = [student1, student2, student3];
    const attempts: Array<{ attemptId: string; packetId: string; student: typeof student1 }> = [];

    for (const s of students) {
      const attemptId = randomUUID();
      await ctx.admin('exam_allocations').insert({
        id: randomUUID(),
        tenant_id: t.tenantId,
        exam_id: exam.id,
        user_id: s.userId,
        status: 'ALLOCATED',
      });
      await ctx.admin('exam_attempts').insert({
        id: attemptId,
        tenant_id: t.tenantId,
        exam_id: exam.id,
        user_id: s.userId,
        status: 'SUBMITTED',
        attempt_no: 1,
      });
      await ctx.admin('hall_tickets').insert({
        id: randomUUID(),
        tenant_id: t.tenantId,
        exam_id: exam.id,
        user_id: s.userId,
        number: `${s.registerNumber}-${randomUUID().slice(0, 6)}`,
        verification_hash: randomUUID().replace(/-/g, ''),
      });

      // Answer documents
      await ctx.admin('answer_documents').insert([
        {
          id: randomUUID(),
          tenant_id: t.tenantId,
          attempt_id: attemptId,
          question_id: 'Q1',
          current_revision: 1,
          content_sha256: 'a1b2c3d4e5f6',
          content: JSON.stringify({
            blocks: [
              {
                id: 'b1',
                kind: 'paragraph',
                content: 'In Raft consensus, leader election uses randomized election timers to avoid split votes. When a candidate receives votes from a majority of nodes for the current term, it transitions to leader and begins sending periodic heartbeats. Log replication proceeds by appending entries and updating the commit index once a majority acknowledges receipt.',
              },
            ],
          }),
        },
        {
          id: randomUUID(),
          tenant_id: t.tenantId,
          attempt_id: attemptId,
          question_id: 'Q2',
          current_revision: 1,
          content_sha256: 'f6e5d4c3b2a1',
          content: JSON.stringify({
            blocks: [
              {
                id: 'b2',
                kind: 'paragraph',
                content: 'Byzantine fault tolerance requires 3f+1 replicas to tolerate f arbitrary or malicious faults. The system proceeds through pre-prepare, prepare, and commit phases. View change protocol allows progression if a leader becomes faulty, verified using cryptographic checkpoint certificates.',
              },
            ],
          }),
        },
      ]);

      const packetRes = await ctx.admin('candidate_review_packets').insert({
        id: randomUUID(),
        tenant_id: t.tenantId,
        attempt_id: attemptId,
        exam_id: exam.id,
        user_id: s.userId,
        status: 'ACADEMIC_MARKING_READY',
        sealed_submission_verified: true,
        identity_state: 'VERIFIED_BY_SESSION',
        media_quality_state: 'NOT_APPLICABLE',
        integrity_state: 'CLEAR',
        version: 1,
      }).returning('id');

      attempts.push({ attemptId, packetId: packetRes[0]!.id, student: s });
    }

    return { exam, paperId, attempts };
  }

  it('assigns evaluators with workload balancing and enforces assignment uniqueness', async () => {
    const { exam, attempts } = await createSealedExamWithCandidates();

    // 1. Assign Evaluator 1 to 2 attempts
    const assignRes1 = await req()
      .post(`/api/v1/exams/${exam.id}/evaluators/assign`)
      .set(H(examCell.token))
      .send({
        evaluatorUserId: evaluator1.userId,
        roleType: 'EVALUATOR_1',
        count: 2,
      });

    expect(assignRes1.status).toBe(201);
    expect(assignRes1.body.assignedCount).toBe(2);

    // 2. Assign Evaluator 2 to remaining attempts for EVALUATOR_1
    const assignRes2 = await req()
      .post(`/api/v1/exams/${exam.id}/evaluators/assign`)
      .set(H(examCell.token))
      .send({
        evaluatorUserId: evaluator2.userId,
        roleType: 'EVALUATOR_1',
        count: 2,
      });

    expect(assignRes2.status).toBe(201);
    expect(assignRes2.body.assignedCount).toBe(1); // Only 1 attempt was left unassigned!

    // 3. Inspect assignments summary list
    const listRes = await req()
      .get(`/api/v1/exams/${exam.id}/evaluators/assignments`)
      .set(H(examCell.token));

    expect(listRes.status).toBe(200);
    expect(listRes.body.summaries.length).toBe(2);

    const s1 = listRes.body.summaries.find((s: any) => s.evaluatorId === evaluator1.userId);
    const s2 = listRes.body.summaries.find((s: any) => s.evaluatorId === evaluator2.userId);
    expect(s1.totalAssigned).toBe(2);
    expect(s2.totalAssigned).toBe(1);

    // 4. Test database uniqueness constraint: attempting duplicate insert for same (attempt_id, role_type)
    const duplicateAssignment = ctx.admin('evaluator_assignments').insert({
      tenant_id: t.tenantId,
      exam_id: exam.id,
      attempt_id: attempts[0]!.attemptId,
      evaluator_user_id: evaluator2.userId,
      role_type: 'EVALUATOR_1',
    });
    await expect(duplicateAssignment).rejects.toThrow();
  });

  it('enforces anonymized marking in external exams (masks student identity)', async () => {
    const { exam, attempts } = await createSealedExamWithCandidates('SEM_EXTERNAL', true);

    // Assign Evaluator 1 to attempt 0
    await req()
      .post(`/api/v1/exams/${exam.id}/evaluators/assign`)
      .set(H(examCell.token))
      .send({
        evaluatorUserId: evaluator1.userId,
        roleType: 'EVALUATOR_1',
        attemptIds: [attempts[0]!.attemptId],
      });

    // Evaluator queries their queue
    const queueRes = await req()
      .get(`/api/v1/evaluator/me/assignments?examId=${exam.id}`)
      .set(H(evaluator1.token));

    expect(queueRes.status).toBe(200);
    expect(queueRes.body.length).toBe(1);

    const item = queueRes.body[0];
    expect(item.attemptId).toBe(attempts[0]!.attemptId);
    expect(item.isAnonymized).toBe(true);
    expect(item.anonymizedIdentifier).toMatch(/^ANON-[0-9A-F]{8}$/);
    // Student identity MUST be masked
    expect(item.candidateName).toBeNull();
    expect(item.candidateEmail).toBeNull();
    expect(item.hallTicketNumber).toBeNull();
  });

  it('handles double evaluation, flags divergence > 15%, and moderator resolves with reconciling version', async () => {
    const { exam, attempts } = await createSealedExamWithCandidates('SEM_EXTERNAL', true);
    const targetAttempt = attempts[0]!.attemptId;

    // Assign both Evaluator 1 and Evaluator 2 to the same attempt
    await req()
      .post(`/api/v1/exams/${exam.id}/evaluators/assign`)
      .set(H(examCell.token))
      .send({
        evaluatorUserId: evaluator1.userId,
        roleType: 'EVALUATOR_1',
        attemptIds: [targetAttempt],
      });

    await req()
      .post(`/api/v1/exams/${exam.id}/evaluators/assign`)
      .set(H(examCell.token))
      .send({
        evaluatorUserId: evaluator2.userId,
        roleType: 'EVALUATOR_2',
        attemptIds: [targetAttempt],
      });

    // 1. Evaluator 1 submits high marks (90/100)
    const marksRes1 = await req()
      .post(`/api/v1/evaluator/me/attempts/${targetAttempt}/marks`)
      .set(H(evaluator1.token))
      .send({
        items: [
          { questionId: 'Q1', maxMarks: 50, marks: 45, explanation: 'Excellent explanation of Raft election safety.' },
          { questionId: 'Q2', maxMarks: 50, marks: 45, explanation: 'Very clear Byzantine fault proof.' },
        ],
      });

    expect(marksRes1.status).toBe(201);
    expect(marksRes1.body.doubleEvaluation).toBe(true);
    // Evaluator 2 has not submitted yet -> status remains ACADEMIC_MARKING_READY
    expect(marksRes1.body.pendingSecondEvaluation).toBe(true);
    expect(marksRes1.body.status).toBe('ACADEMIC_MARKING_READY');

    // 2. Evaluator 2 submits divergent marks (60/100) -> difference is 30 marks (> 15% threshold!)
    const marksRes2 = await req()
      .post(`/api/v1/evaluator/me/attempts/${targetAttempt}/marks`)
      .set(H(evaluator2.token))
      .send({
        items: [
          { questionId: 'Q1', maxMarks: 50, marks: 30, explanation: 'Basic understanding of Raft, missing detail on split votes.' },
          { questionId: 'Q2', maxMarks: 50, marks: 30, explanation: 'Incomplete explanation of view change certificates.' },
        ],
      });

    expect(marksRes2.status).toBe(201);
    expect(marksRes2.body.doubleEvaluation).toBe(true);
    // Divergence triggered MARKING_MODERATION_REQUIRED
    expect(marksRes2.body.status).toBe('MARKING_MODERATION_REQUIRED');
    expect(marksRes2.body.divergence).toBe(30);

    // 3. Check moderation sample created
    const samplesRes = await req()
      .get(`/api/v1/exams/${exam.id}/moderation/samples`)
      .set(H(moderator.token));

    expect(samplesRes.status).toBe(200);
    expect(samplesRes.body.length).toBe(1);
    const sample = samplesRes.body[0];
    expect(sample.attemptId).toBe(targetAttempt);
    expect(sample.reason).toBe('DIVERGENCE_EXCEEDED');
    expect(Number(sample.divergence)).toBe(30);
    expect(sample.status).toBe('PENDING');

    // 4. Moderator resolves with reconciled third version (75/100)
    const resolveRes = await req()
      .post(`/api/v1/moderation/samples/${sample.id}/resolve`)
      .set(H(moderator.token))
      .send({
        resolutionNote: 'Reviewed both evaluations. Candidate shows strong grasp of core concepts with minor omissions.',
        items: [
          { questionId: 'Q1', maxMarks: 50, marks: 38, explanation: 'Fair evaluation reflecting solid understanding with slight brevity.' },
          { questionId: 'Q2', maxMarks: 50, marks: 37, explanation: 'Satisfactory proof and view change description.' },
        ],
      });

    expect(resolveRes.status).toBe(200);
    expect(resolveRes.body.status).toBe('RESOLVED');

    // Candidate packet has now advanced to EXAM_CELL_REVIEW!
    const packetRow = await ctx.admin('candidate_review_packets')
      .where({ tenant_id: t.tenantId, attempt_id: targetAttempt })
      .first();
    expect(packetRow.status).toBe('EXAM_CELL_REVIEW');
  });

  it('walks full revaluation lifecycle: student request, exam cell approval, re-marking, and ledger publication correction', async () => {
    const { exam, attempts } = await createSealedExamWithCandidates('MID_1', false);
    const target = attempts[0]!;

    // 1. Initial Evaluation
    const initialMarksRes = await req()
      .post(`/api/v1/evaluator/me/attempts/${target.attemptId}/marks`)
      .set(H(evaluator1.token))
      .send({
        items: [
          { questionId: 'Q1', maxMarks: 50, marks: 30, explanation: 'Initial marking for Q1' },
          { questionId: 'Q2', maxMarks: 50, marks: 25, explanation: 'Initial marking for Q2' },
        ],
      });
    expect(initialMarksRes.status).toBe(201);

    // 2. Exam Cell approves
    const appRes = await req()
      .post(`/api/v1/candidates/${target.attemptId}/approvals`)
      .set(H(examCell.token))
      .send({
        reviewedResultVersionId: initialMarksRes.body.resultVersionId,
        decision: 'APPROVED',
        reason: 'Initial approval by Exam Cell',
        idempotencyKey: randomUUID(),
      });
    expect(appRes.status).toBe(201);
    const approvalId = appRes.body.approvalId;

    // 3. Controller authorizes & publishes initial result
    const pubRes = await req()
      .post(`/api/v1/candidates/${target.attemptId}/authorize-publication`)
      .set(H(controller.token))
      .send({
        candidateApprovalId: approvalId,
        idempotencyKey: randomUUID(),
      });
    expect(pubRes.status).toBe(200);

    // Initial student record is active in lifelong ledger
    const initialLedger = await ctx.admin('student_exam_records')
      .where({ tenant_id: t.tenantId, attempt_id: target.attemptId })
      .first();
    expect(initialLedger).toBeDefined();
    expect(Number(initialLedger.marks)).toBe(55);
    expect(initialLedger.superseded_at).toBeNull();

    // 4. Student requests revaluation
    const revalRes = await req()
      .post(`/api/v1/student/attempts/${target.attemptId}/revaluation`)
      .set(H(target.student.token))
      .send({
        reason: 'I have provided full derivations in Q2 which was marked down too harshly.',
        feeRef: 'FEE-2026-9921',
      });

    expect(revalRes.status).toBe(201);
    expect(revalRes.body.status).toBe('REQUESTED');
    const requestId = revalRes.body.requestId;

    // Duplicate request is rejected
    const dupRes = await req()
      .post(`/api/v1/student/attempts/${target.attemptId}/revaluation`)
      .set(H(target.student.token))
      .send({
        reason: 'Duplicate request',
      });
    expect(dupRes.status).toBe(409);
    expect(dupRes.body.code).toBe('REVALUATION_ALREADY_REQUESTED');

    // 5. Exam Cell lists requests & approves
    const listReqs = await req()
      .get(`/api/v1/exams/${exam.id}/revaluation-requests`)
      .set(H(examCell.token));
    expect(listReqs.status).toBe(200);
    expect(listReqs.body.length).toBe(1);

    const decideRes = await req()
      .post(`/api/v1/revaluation-requests/${requestId}/decide`)
      .set(H(examCell.token))
      .send({
        decision: 'APPROVED',
        note: 'Approved for re-evaluation by Department Chair.',
      });
    expect(decideRes.status).toBe(200);
    expect(decideRes.body.status).toBe('APPROVED');

    // Candidate packet has transitioned through REVALUATION_PENDING to ACADEMIC_MARKING_READY
    const packetAfterReval = await ctx.admin('candidate_review_packets')
      .where({ tenant_id: t.tenantId, attempt_id: target.attemptId })
      .first();
    expect(packetAfterReval.status).toBe('ACADEMIC_MARKING_READY');

    // 6. Evaluator re-marks with corrected marks (version 2: 70/100)
    const remarkRes = await req()
      .post(`/api/v1/evaluator/me/attempts/${target.attemptId}/marks`)
      .set(H(evaluator2.token))
      .send({
        items: [
          { questionId: 'Q1', maxMarks: 50, marks: 35, explanation: 'Re-evaluated Q1: partial credit added for timer safety.' },
          { questionId: 'Q2', maxMarks: 50, marks: 35, explanation: 'Re-evaluated Q2: full derivation acknowledged.' },
        ],
      });
    expect(remarkRes.status).toBe(201);
    expect(remarkRes.body.version).toBe(2);
    expect(Number(remarkRes.body.total)).toBe(70);

    // 7. Exam Cell approves new version
    const appRes2 = await req()
      .post(`/api/v1/candidates/${target.attemptId}/approvals`)
      .set(H(examCell.token))
      .send({
        reviewedResultVersionId: remarkRes.body.resultVersionId,
        decision: 'APPROVED',
        reason: 'Approved revised marks following revaluation.',
        idempotencyKey: randomUUID(),
      });
    expect(appRes2.status).toBe(201);

    // 8. Controller authorizes & publishes corrected result
    const pubRes2 = await req()
      .post(`/api/v1/candidates/${target.attemptId}/authorize-publication`)
      .set(H(controller.token))
      .send({
        candidateApprovalId: appRes2.body.approvalId,
        idempotencyKey: randomUUID(),
      });
    expect(pubRes2.status).toBe(200);

    // Check lifelong ledger: initial record superseded, new record active!
    const records = await ctx.admin('student_exam_records')
      .where({ tenant_id: t.tenantId, attempt_id: target.attemptId })
      .orderBy('published_at', 'asc');

    expect(records.length).toBe(2);
    expect(records[0]!.superseded_at).not.toBeNull();
    expect(Number(records[0]!.marks)).toBe(55);

    expect(records[1]!.superseded_at).toBeNull();
    expect(Number(records[1]!.marks)).toBe(70);

    // Revaluation request marked DONE
    const finalRequest = await ctx.admin('revaluation_requests')
      .where({ id: requestId })
      .first();
    expect(finalRequest.status).toBe('DONE');

    // Outbox event emitted: result.corrected
    const correctedEvent = await ctx.admin('integration_events')
      .where({ tenant_id: t.tenantId, type: 'result.corrected' })
      .first();
    expect(correctedEvent).toBeDefined();
    const payload = typeof correctedEvent.payload === 'string' ? JSON.parse(correctedEvent.payload) : correctedEvent.payload;
    expect(Number(payload.total)).toBe(70);
  });

  it('Gate E: generates AI rubric proposals and detects answer similarity without auto-disqualifying', async () => {
    const { exam, attempts } = await createSealedExamWithCandidates('MID_1', false);

    // 1. Rubric proposals API
    const proposalsRes = await req()
      .get(`/api/v1/candidates/${attempts[0]!.attemptId}/rubric-proposals`)
      .set(H(evaluator1.token));

    expect(proposalsRes.status).toBe(200);
    expect(proposalsRes.body.proposals.length).toBe(2);
    expect(proposalsRes.body.proposals[0].questionId).toBe('Q1');
    expect(proposalsRes.body.proposals[0].suggestedMarks).toBeGreaterThan(0);
    expect(proposalsRes.body.proposals[0].suggestionExplanation).toContain('Draft AI proposal');

    // 2. Similarity analysis API
    // Attempt 0 and Attempt 1 have identical answers seeded in createSealedExamWithCandidates
    const simRes = await req()
      .post(`/api/v1/exams/${exam.id}/similarity-analysis`)
      .set(H(examCell.token))
      .send({ threshold: 0.8 });

    expect(simRes.status).toBe(200);
    expect(simRes.body.flaggedPairs.length).toBeGreaterThan(0);
    expect(simRes.body.flaggedPairs[0].similarity).toBeGreaterThanOrEqual(0.8);

    // Both candidate review packets must be placed on INTEGRITY_HOLD for human adjudication
    const p1 = await ctx.admin('candidate_review_packets').where({ attempt_id: attempts[0]!.attemptId }).first();
    const p2 = await ctx.admin('candidate_review_packets').where({ attempt_id: attempts[1]!.attemptId }).first();
    expect(p1.status).toBe('INTEGRITY_HOLD');
    expect(p2.status).toBe('INTEGRITY_HOLD');
    expect(p1.hold_reason).toContain('Answer similarity');
  });
});
