import type { Knex } from '@examos/db';
import {
  PAPER_TRANSITIONS,
  assertTransition,
  type PaperStatus,
  type PaperUpsert,
  type PaperReviewDecision,
  type PaperSetCreate,
} from '@examos/contracts';
import type { AppDeps } from '../../types.js';
import { AppError } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { canonicalJson, encryptAtRest, decryptAtRest, sha256Hex } from '../../lib/crypto.js';

export async function getExamPaper(
  deps: AppDeps,
  trx: Knex.Transaction,
  tenantId: string,
  actorId: string,
  examId: string,
  options?: { isStaff?: boolean; requestId?: string },
) {
  const exam = await trx('exams').where({ tenant_id: tenantId, id: examId }).first();
  if (!exam) throw AppError.notFound('EXAM_NOT_FOUND');

  // Find latest paper
  const paper = await trx('question_papers')
    .where({ tenant_id: tenantId, exam_id: examId })
    .orderBy('version', 'desc')
    .first();

  if (!paper) return null;

  // Audit on early view: reading an approved paper before exam is LIVE is audited
  if (paper.status === 'APPROVED' && exam.status !== 'LIVE' && options?.isStaff) {
    await audit(trx, {
      tenantId,
      actorType: 'USER',
      actorId,
      action: 'paper.viewed',
      entityType: 'question_paper',
      entityId: paper.id,
      requestId: options?.requestId,
      metadata: { examId, examStatus: exam.status, paperVersion: paper.version },
    });
  }

  const questions = await trx('paper_questions')
    .where({ tenant_id: tenantId, paper_id: paper.id })
    .orderBy('number', 'asc');

  const sets = await trx('paper_sets')
    .where({ tenant_id: tenantId, paper_id: paper.id })
    .orderBy('set_code', 'asc');

  return {
    id: paper.id,
    examId: paper.exam_id,
    version: paper.version,
    status: paper.status as PaperStatus,
    title: paper.title,
    instructions: paper.instructions,
    totalMarks: Number(paper.total_marks),
    sections: paper.sections,
    sealedSha256: paper.sealed_sha256,
    createdBy: paper.created_by,
    submittedAt: paper.submitted_at ? new Date(paper.submitted_at).toISOString() : null,
    approvedBy: paper.approved_by,
    approvedAt: paper.approved_at ? new Date(paper.approved_at).toISOString() : null,
    createdAt: new Date(paper.created_at).toISOString(),
    updatedAt: new Date(paper.updated_at).toISOString(),
    questions: questions.map((q) => ({
      id: q.id,
      questionId: q.question_id,
      sectionCode: q.section_code,
      number: q.number,
      kind: q.kind,
      prompt: q.prompt,
      options: q.options,
      maxMarks: Number(q.max_marks),
      rubric: q.rubric,
      expectedAnswer: q.expected_answer,
      attachments: q.attachments,
      codeSpec: q.code_spec ?? undefined,
    })),
    sets: sets.map((s) => ({
      setCode: s.set_code,
      questionOrder: s.question_order,
    })),
  };
}

export async function upsertExamPaper(
  deps: AppDeps,
  trx: Knex.Transaction,
  tenantId: string,
  actorId: string,
  examId: string,
  input: PaperUpsert,
  requestId?: string,
) {
  const exam = await trx('exams').where({ tenant_id: tenantId, id: examId }).forUpdate().first();
  if (!exam) throw AppError.notFound('EXAM_NOT_FOUND');
  if (!['DRAFT', 'PAPER_REVIEW'].includes(exam.status)) {
    throw AppError.conflict('EXAM_LOCKED', `Paper cannot be edited while exam is ${exam.status}`);
  }

  const totalMarks = input.questions.reduce((sum, q) => sum + q.maxMarks, 0);

  // Validate unique questionIds within the paper
  const qIds = new Set<string>();
  for (const q of input.questions) {
    if (qIds.has(q.questionId)) {
      throw AppError.unprocessable('DUPLICATE_QUESTION_ID', `Duplicate question ID: ${q.questionId}`);
    }
    qIds.add(q.questionId);
  }

  // Find existing draft/review paper or latest paper
  const existing = await trx('question_papers')
    .where({ tenant_id: tenantId, exam_id: examId })
    .orderBy('version', 'desc')
    .forUpdate()
    .first();

  let paperId: string;
  let version = 1;

  if (existing && existing.status === 'APPROVED') {
    // If approved exists, creating a new draft creates a new version
    version = existing.version + 1;
    const [created] = await trx('question_papers')
      .insert({
        tenant_id: tenantId,
        exam_id: examId,
        version,
        status: 'DRAFT',
        title: input.title,
        instructions: input.instructions ?? null,
        total_marks: totalMarks,
        sections: JSON.stringify(input.sections),
        created_by: actorId,
      })
      .returning('*');
    paperId = created.id;
  } else if (existing && ['DRAFT', 'REVIEW'].includes(existing.status)) {
    paperId = existing.id;
    version = existing.version;
    await trx('question_papers')
      .where('id', paperId)
      .update({
        title: input.title,
        instructions: input.instructions ?? null,
        total_marks: totalMarks,
        sections: JSON.stringify(input.sections),
        status: 'DRAFT', // editing resets to DRAFT if it was in REVIEW
        updated_at: trx.fn.now(),
      });
    // Delete existing questions to re-insert fresh
    await trx('paper_questions').where({ tenant_id: tenantId, paper_id: paperId }).delete();
  } else {
    const [created] = await trx('question_papers')
      .insert({
        tenant_id: tenantId,
        exam_id: examId,
        version: 1,
        status: 'DRAFT',
        title: input.title,
        instructions: input.instructions ?? null,
        total_marks: totalMarks,
        sections: JSON.stringify(input.sections),
        created_by: actorId,
      })
      .returning('*');
    paperId = created.id;
  }

  // Insert questions
  for (const q of input.questions) {
    await trx('paper_questions').insert({
      tenant_id: tenantId,
      paper_id: paperId,
      question_id: q.questionId,
      section_code: q.sectionCode,
      number: q.number,
      kind: q.kind,
      prompt: JSON.stringify(q.prompt),
      options: q.options ? JSON.stringify(q.options) : null,
      max_marks: q.maxMarks,
      rubric: q.rubric ? JSON.stringify(q.rubric) : null,
      expected_answer: q.expectedAnswer ? JSON.stringify(q.expectedAnswer) : null,
      attachments: JSON.stringify(q.attachments ?? []),
      code_spec: q.codeSpec ? JSON.stringify(q.codeSpec) : null,
    });
  }

  await audit(trx, {
    tenantId,
    actorType: 'USER',
    actorId,
    action: 'paper.upserted',
    entityType: 'question_paper',
    entityId: paperId,
    requestId,
    metadata: { examId, version, totalMarks, questionCount: input.questions.length },
  });

  return { paperId, version, status: 'DRAFT' as const, totalMarks, questionCount: input.questions.length };
}

export async function submitPaperForReview(
  deps: AppDeps,
  trx: Knex.Transaction,
  tenantId: string,
  actorId: string,
  examId: string,
  requestId?: string,
) {
  const paper = await trx('question_papers')
    .where({ tenant_id: tenantId, exam_id: examId })
    .orderBy('version', 'desc')
    .forUpdate()
    .first();

  if (!paper) throw AppError.notFound('PAPER_NOT_FOUND');
  assertTransition('paper', PAPER_TRANSITIONS, paper.status as PaperStatus, 'REVIEW');

  const questionsCount = await trx('paper_questions')
    .where({ tenant_id: tenantId, paper_id: paper.id })
    .count<{ count: string }>('id as count')
    .first();

  if (!questionsCount || Number(questionsCount.count) === 0) {
    throw AppError.unprocessable('EMPTY_PAPER', 'Question paper must have at least one question');
  }

  await trx('question_papers').where('id', paper.id).update({
    status: 'REVIEW',
    submitted_at: trx.fn.now(),
    updated_at: trx.fn.now(),
  });

  await audit(trx, {
    tenantId,
    actorType: 'USER',
    actorId,
    action: 'paper.submitted_for_review',
    entityType: 'question_paper',
    entityId: paper.id,
    requestId,
    metadata: { examId, version: paper.version },
  });

  return { paperId: paper.id, version: paper.version, status: 'REVIEW' as const };
}

export async function reviewPaper(
  deps: AppDeps,
  trx: Knex.Transaction,
  tenantId: string,
  actorId: string,
  examId: string,
  input: PaperReviewDecision,
  requestId?: string,
) {
  const exam = await trx('exams').where({ tenant_id: tenantId, id: examId }).first();
  if (!exam) throw AppError.notFound('EXAM_NOT_FOUND');

  const paper = await trx('question_papers')
    .where({ tenant_id: tenantId, exam_id: examId })
    .orderBy('version', 'desc')
    .forUpdate()
    .first();

  if (!paper) throw AppError.notFound('PAPER_NOT_FOUND');

  if (input.decision === 'REJECT') {
    assertTransition('paper', PAPER_TRANSITIONS, paper.status as PaperStatus, 'DRAFT');
    await trx('question_papers').where('id', paper.id).update({
      status: 'DRAFT',
      updated_at: trx.fn.now(),
    });
    await audit(trx, {
      tenantId,
      actorType: 'USER',
      actorId,
      action: 'paper.rejected',
      entityType: 'question_paper',
      entityId: paper.id,
      requestId,
      metadata: { examId, version: paper.version, feedback: input.feedback ?? null },
    });
    return { paperId: paper.id, version: paper.version, status: 'DRAFT' as const };
  }

  // Approve path
  assertTransition('paper', PAPER_TRANSITIONS, paper.status as PaperStatus, 'APPROVED');

  // Verify total marks equals exam max_marks if exam max_marks is set
  if (exam.max_marks != null && Number(paper.total_marks) !== Number(exam.max_marks)) {
    throw AppError.unprocessable(
      'PAPER_MARKS_MISMATCH',
      `Paper total marks (${paper.total_marks}) does not match exam max marks (${exam.max_marks})`,
    );
  }

  const questions = await trx('paper_questions')
    .where({ tenant_id: tenantId, paper_id: paper.id })
    .orderBy('number', 'asc');

  if (questions.length === 0) {
    throw AppError.unprocessable('EMPTY_PAPER', 'Question paper must have at least one question');
  }

  // Calculate canonical sealed hash over paper structure and questions
  const sealedPayload = {
    paper: {
      id: paper.id,
      title: paper.title,
      instructions: paper.instructions,
      totalMarks: Number(paper.total_marks),
      sections: paper.sections,
    },
    questions: questions.map((q) => ({
      questionId: q.question_id,
      sectionCode: q.section_code,
      number: q.number,
      kind: q.kind,
      prompt: q.prompt,
      options: q.options,
      maxMarks: Number(q.max_marks),
      rubric: q.rubric,
      expectedAnswer: q.expected_answer,
      codeSpec: q.code_spec ?? null,
    })),
  };

  const sealedSha256 = sha256Hex(canonicalJson(sealedPayload));

  // Encrypt the paper body at rest with APP_ENCRYPTION_KEY until exam is LIVE
  const ciphertext = encryptAtRest(deps.config.appEncryptionKey, canonicalJson(sealedPayload));
  const encryptedBuffer = Buffer.from(ciphertext, 'utf8');

  // Supersede any previously approved papers for this exam
  await trx('question_papers')
    .where({ tenant_id: tenantId, exam_id: examId, status: 'APPROVED' })
    .update({ status: 'SUPERSEDED', updated_at: trx.fn.now() });

  await trx('question_papers')
    .where('id', paper.id)
    .update({
      status: 'APPROVED',
      approved_by: actorId,
      approved_at: trx.fn.now(),
      sealed_sha256: sealedSha256,
      encrypted_body: encryptedBuffer,
      updated_at: trx.fn.now(),
    });

  await audit(trx, {
    tenantId,
    actorType: 'USER',
    actorId,
    action: 'paper.approved',
    entityType: 'question_paper',
    entityId: paper.id,
    requestId,
    metadata: { examId, version: paper.version, sealedSha256 },
  });

  return { paperId: paper.id, version: paper.version, status: 'APPROVED' as const, sealedSha256 };
}

export async function createPaperSets(
  deps: AppDeps,
  trx: Knex.Transaction,
  tenantId: string,
  actorId: string,
  examId: string,
  sets: PaperSetCreate[],
  requestId?: string,
) {
  const paper = await trx('question_papers')
    .where({ tenant_id: tenantId, exam_id: examId })
    .orderBy('version', 'desc')
    .first();

  if (!paper) throw AppError.notFound('PAPER_NOT_FOUND');

  const questions = await trx('paper_questions').where({ tenant_id: tenantId, paper_id: paper.id });
  const validQuestionIds = new Set(questions.map((q) => q.question_id));

  for (const s of sets) {
    for (const qid of s.questionOrder) {
      if (!validQuestionIds.has(qid)) {
        throw AppError.unprocessable('INVALID_SET_QUESTION', `Question ${qid} does not exist in paper`);
      }
    }
    await trx('paper_sets')
      .insert({
        tenant_id: tenantId,
        paper_id: paper.id,
        set_code: s.setCode,
        question_order: JSON.stringify(s.questionOrder),
      })
      .onConflict(['paper_id', 'set_code'])
      .merge(['question_order']);
  }

  await audit(trx, {
    tenantId,
    actorType: 'USER',
    actorId,
    action: 'paper.sets_configured',
    entityType: 'question_paper',
    entityId: paper.id,
    requestId,
    metadata: { setCodes: sets.map((s) => s.setCode) },
  });

  return { setCount: sets.length };
}

/**
 * Student paper delivery.
 * Invariants:
 * - Exam must be LIVE.
 * - Attempt must be ACTIVE, RECOVERY_PENDING, or SUSPENDED.
 * - Sealed attempts cannot fetch paper.
 * - Never returns expected_answer or rubric.
 */
export async function releasePaperForStudent(
  deps: AppDeps,
  trx: Knex.Transaction,
  tenantId: string,
  userId: string,
  attemptId: string,
) {
  const attempt = await trx('exam_attempts as a')
    .join('exams as e', 'e.id', 'a.exam_id')
    .where({ 'a.tenant_id': tenantId, 'a.id': attemptId })
    .select('a.id', 'a.user_id', 'a.exam_id', 'a.status as attemptStatus', 'e.status as examStatus', 'e.title as examTitle')
    .first();

  if (!attempt) throw AppError.notFound('ATTEMPT_NOT_FOUND');
  if (attempt.user_id !== userId) throw AppError.notFound('ATTEMPT_NOT_FOUND');

  if (['SUBMITTED', 'EXPIRED', 'VOIDED_BY_AUTHORITY'].includes(attempt.attemptStatus)) {
    throw AppError.conflict('ATTEMPT_SEALED', 'Attempt is sealed; question paper cannot be accessed');
  }

  if (!['ACTIVE', 'RECOVERY_PENDING', 'SUSPENDED'].includes(attempt.attemptStatus)) {
    throw AppError.conflict('ATTEMPT_NOT_ACTIVE', `Attempt is in status ${attempt.attemptStatus}; cannot access paper`);
  }

  if (attempt.examStatus !== 'LIVE') {
    throw AppError.conflict('EXAM_NOT_LIVE', 'Question paper is released only when the exam is LIVE');
  }

  // Get approved paper
  const paper = await trx('question_papers')
    .where({ tenant_id: tenantId, exam_id: attempt.exam_id, status: 'APPROVED' })
    .first();

  if (!paper) {
    throw AppError.notFound('APPROVED_PAPER_NOT_FOUND', 'No approved question paper found for this exam');
  }

  // Check existing release
  let release = await trx('paper_releases')
    .where({ tenant_id: tenantId, attempt_id: attemptId })
    .first();

  if (!release) {
    // Determine set code
    const sets = await trx('paper_sets').where({ tenant_id: tenantId, paper_id: paper.id });
    let setCode = 'DEFAULT';
    if (sets.length > 0) {
      // Deterministic assignment based on attempt id
      const hashNum = parseInt(attemptId.slice(0, 8), 16);
      const chosen = sets[hashNum % sets.length]!;
      setCode = chosen.set_code;
    }

    const [created] = await trx('paper_releases')
      .insert({
        tenant_id: tenantId,
        attempt_id: attemptId,
        paper_id: paper.id,
        set_code: setCode,
      })
      .onConflict(['tenant_id', 'attempt_id'])
      .ignore()
      .returning('*');

    release = created ?? (await trx('paper_releases').where({ tenant_id: tenantId, attempt_id: attemptId }).first());
  }

  // Fetch questions
  const rawQuestions = await trx('paper_questions')
    .where({ tenant_id: tenantId, paper_id: paper.id })
    .orderBy('number', 'asc');

  // Check if a specific question order applies for this set
  let orderedQuestions = rawQuestions;
  if (release && release.set_code !== 'DEFAULT') {
    const setRow = await trx('paper_sets')
      .where({ tenant_id: tenantId, paper_id: paper.id, set_code: release.set_code })
      .first();
    if (setRow && Array.isArray(setRow.question_order)) {
      const orderMap = new Map((setRow.question_order as string[]).map((qid, idx) => [qid, idx]));
      orderedQuestions = [...rawQuestions].sort((a, b) => {
        const orderA = orderMap.get(a.question_id) ?? a.number;
        const orderB = orderMap.get(b.question_id) ?? b.number;
        return orderA - orderB;
      });
    }
  }

  // Sanitize: NEVER serve expected_answer or rubric to student
  const sanitizedQuestions = orderedQuestions.map((q, idx) => ({
    id: q.id,
    questionId: q.question_id,
    sectionCode: q.section_code,
    number: idx + 1,
    kind: q.kind,
    prompt: q.prompt,
    options: q.options,
    maxMarks: Number(q.max_marks),
    attachments: q.attachments,
    // visible part of a CODE question: languages, starter, sample tests, limits (hidden tests stay server-side)
    codeSpec: q.code_spec ?? undefined,
  }));

  return {
    paperId: paper.id,
    title: paper.title,
    instructions: paper.instructions,
    totalMarks: Number(paper.total_marks),
    sections: paper.sections,
    setCode: release?.set_code ?? 'DEFAULT',
    questions: sanitizedQuestions,
  };
}

/**
 * Candidate packet paper view for evaluators, Exam Cell, and Controller.
 * Includes rubric and expected_answer for grading.
 */
export async function getCandidatePaper(
  deps: AppDeps,
  trx: Knex.Transaction,
  tenantId: string,
  actorId: string,
  attemptId: string,
) {
  const attempt = await trx('exam_attempts').where({ tenant_id: tenantId, id: attemptId }).first();
  if (!attempt) throw AppError.notFound('ATTEMPT_NOT_FOUND');

  // Look for release or default to approved paper
  const release = await trx('paper_releases').where({ tenant_id: tenantId, attempt_id: attemptId }).first();

  let paper;
  if (release) {
    paper = await trx('question_papers').where({ tenant_id: tenantId, id: release.paper_id }).first();
  } else {
    paper = await trx('question_papers')
      .where({ tenant_id: tenantId, exam_id: attempt.exam_id, status: 'APPROVED' })
      .first();
  }

  if (!paper) {
    // If no approved paper, check latest
    paper = await trx('question_papers')
      .where({ tenant_id: tenantId, exam_id: attempt.exam_id })
      .orderBy('version', 'desc')
      .first();
  }

  if (!paper) throw AppError.notFound('PAPER_NOT_FOUND');

  const questions = await trx('paper_questions')
    .where({ tenant_id: tenantId, paper_id: paper.id })
    .orderBy('number', 'asc');

  return {
    paperId: paper.id,
    examId: paper.exam_id,
    version: paper.version,
    status: paper.status as PaperStatus,
    title: paper.title,
    instructions: paper.instructions,
    totalMarks: Number(paper.total_marks),
    sections: paper.sections,
    setCode: release?.set_code ?? 'DEFAULT',
    questions: questions.map((q) => ({
      id: q.id,
      questionId: q.question_id,
      sectionCode: q.section_code,
      number: q.number,
      kind: q.kind,
      prompt: q.prompt,
      options: q.options,
      maxMarks: Number(q.max_marks),
      rubric: q.rubric,
      expectedAnswer: q.expected_answer,
      attachments: q.attachments,
      codeSpec: q.code_spec ?? undefined,
    })),
  };
}

