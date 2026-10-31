import type { Knex } from '@examos/db';
import {
  type EvaluatorAssignInput,
  type EvaluatorAssignmentSummary,
  type EvaluatorRoleType,
  type ModerationResolveInput,
  type RevaluationRequestInput,
  type RevaluationDecideInput,
  type ResultItem,
} from '@examos/contracts';
import { proposeMarksForAttempt, snapshotProposals } from './auto-marks.js';
import { enqueueCodeGrading } from './judge.js';
import { AppError } from '../../lib/errors.js';
import { audit, logAttemptEvent } from '../../lib/audit.js';
import { sha256Hex } from '../../lib/crypto.js';
import { recordResultVersion, setPacketStatus } from '../candidates/service.js';
import { enqueueMail } from '../notifications/service.js';
import { tenantPrimaryHost } from '../tenants/service.js';

// ---------------------------------------------------------------------------
// Evaluator Assignments & Workload Balancing
// ---------------------------------------------------------------------------
export async function assignEvaluators(
  trx: Knex.Transaction,
  tenantId: string,
  actorId: string,
  examId: string,
  input: EvaluatorAssignInput,
) {
  const exam = await trx('exams').where({ tenant_id: tenantId, id: examId }).first();
  if (!exam) throw AppError.notFound('EXAM_NOT_FOUND');

  const evaluator = await trx('users').where({ tenant_id: tenantId, id: input.evaluatorUserId }).first();
  if (!evaluator) throw AppError.notFound('EVALUATOR_NOT_FOUND');

  let targetAttemptIds: string[] = [];

  if (input.attemptIds && input.attemptIds.length > 0) {
    const attempts = await trx('exam_attempts')
      .where({ tenant_id: tenantId, exam_id: examId })
      .whereIn('id', input.attemptIds)
      .select('id');
    targetAttemptIds = attempts.map((a) => a.id);
  } else if (input.count && input.count > 0) {
    // Find attempts for this exam that are ready for marking and don't yet have an assignment for this roleType
    const alreadyAssigned = trx('evaluator_assignments')
      .where({ tenant_id: tenantId, exam_id: examId, role_type: input.roleType })
      .select('attempt_id');

    const available = await trx('candidate_review_packets')
      .where({ tenant_id: tenantId, exam_id: examId })
      .whereIn('status', ['ACADEMIC_MARKING_READY', 'REVALUATION_PENDING', 'FORENSIC_REVIEW_READY', 'ATTEMPT_SEALED'])
      .whereNotIn('attempt_id', alreadyAssigned)
      .limit(input.count)
      .select('attempt_id');

    targetAttemptIds = available.map((a) => a.attempt_id);
  }

  if (targetAttemptIds.length === 0) {
    return { assignedCount: 0, evaluatorUserId: input.evaluatorUserId, roleType: input.roleType };
  }

  let assignedCount = 0;
  for (const attemptId of targetAttemptIds) {
    const existing = await trx('evaluator_assignments')
      .where({ tenant_id: tenantId, attempt_id: attemptId, role_type: input.roleType })
      .first();

    if (!existing) {
      await trx('evaluator_assignments').insert({
        tenant_id: tenantId,
        exam_id: examId,
        attempt_id: attemptId,
        evaluator_user_id: input.evaluatorUserId,
        role_type: input.roleType,
        status: 'ASSIGNED',
      });
      assignedCount++;
    }
  }

  await audit(trx, {
    tenantId,
    actorType: 'USER',
    actorId,
    action: 'evaluator.assigned',
    entityType: 'exam',
    entityId: examId,
    metadata: {
      evaluatorUserId: input.evaluatorUserId,
      roleType: input.roleType,
      assignedCount,
    },
  });

  return { assignedCount, evaluatorUserId: input.evaluatorUserId, roleType: input.roleType };
}

export async function listEvaluatorAssignments(
  trx: Knex.Transaction,
  tenantId: string,
  examId: string,
) {
  const rows = await trx('evaluator_assignments as a')
    .join('users as u', 'u.id', 'a.evaluator_user_id')
    .join('candidate_review_packets as p', 'p.attempt_id', 'a.attempt_id')
    .where('a.tenant_id', tenantId)
    .andWhere('a.exam_id', examId)
    .select(
      'a.id',
      'a.attempt_id as attemptId',
      'a.evaluator_user_id as evaluatorId',
      'u.full_name as evaluatorName',
      'u.email as evaluatorEmail',
      'a.role_type as roleType',
      'a.status as status',
      'a.assigned_at as assignedAt',
      'a.completed_at as completedAt',
      'p.status as candidateStatus',
      'p.result_version_id as resultVersionId',
    );

  // Group by evaluator to create summary
  const summaryMap = new Map<string, EvaluatorAssignmentSummary>();
  for (const r of rows) {
    if (!summaryMap.has(r.evaluatorId)) {
      summaryMap.set(r.evaluatorId, {
        evaluatorId: r.evaluatorId,
        evaluatorName: r.evaluatorName,
        evaluatorEmail: r.evaluatorEmail,
        totalAssigned: 0,
        inProgress: 0,
        completed: 0,
      });
    }
    const s = summaryMap.get(r.evaluatorId)!;
    s.totalAssigned++;
    if (r.status === 'COMPLETED') s.completed++;
    else if (r.status === 'IN_PROGRESS' || r.status === 'ASSIGNED') s.inProgress++;
  }

  return {
    summaries: Array.from(summaryMap.values()),
    assignments: rows,
  };
}

export async function getEvaluatorQueue(
  trx: Knex.Transaction,
  tenantId: string,
  evaluatorUserId: string,
  examId?: string,
) {
  let query = trx('evaluator_assignments as a')
    .join('exams as e', 'e.id', 'a.exam_id')
    .join('candidate_review_packets as p', 'p.attempt_id', 'a.attempt_id')
    .join('users as u', 'u.id', 'p.user_id')
    .leftJoin('hall_tickets as ht', function () {
      this.on('ht.exam_id', '=', 'a.exam_id').andOn('ht.user_id', '=', 'p.user_id');
    })
    .leftJoin('mark_proposals as mp', 'mp.attempt_id', 'a.attempt_id')
    .where('a.tenant_id', tenantId)
    .andWhere('a.evaluator_user_id', evaluatorUserId)
    .select(
      'a.id as assignmentId',
      'a.attempt_id as attemptId',
      'a.exam_id as examId',
      'e.title as examTitle',
      'e.code as examCode',
      'e.exam_type as examType',
      'e.policy as examPolicy',
      'a.role_type as roleType',
      'a.status as assignmentStatus',
      'p.status as candidateStatus',
      'p.result_version_id as resultVersionId',
      'u.full_name as fullName',
      'u.email as email',
      'ht.number as hallTicketNumber',
      'mp.proposed_total as proposedTotal',
      'mp.max_total as proposedMax',
      'mp.needs_examiner as needsExaminer',
      'mp.check_carefully as checkCarefully',
    );

  if (examId) {
    query = query.andWhere('a.exam_id', examId);
  }

  const rows = await query;

  return rows.map((r) => {
    const policy = (r.examPolicy ?? {}) as Record<string, unknown>;
    const isAnonymized = r.examType === 'SEM_EXTERNAL' || Boolean(policy['anonymizeEvaluation']);
    const anonymizedIdentifier = `ANON-${sha256Hex(r.attemptId + tenantId).slice(0, 8).toUpperCase()}`;

    return {
      assignmentId: r.assignmentId,
      attemptId: r.attemptId,
      examId: r.examId,
      examTitle: r.examTitle,
      examCode: r.examCode,
      examType: r.examType,
      roleType: r.roleType,
      assignmentStatus: r.assignmentStatus,
      candidateStatus: r.candidateStatus,
      resultVersionId: r.resultVersionId,
      isAnonymized,
      anonymizedIdentifier: isAnonymized ? anonymizedIdentifier : null,
      candidateName: isAnonymized ? null : r.fullName,
      candidateEmail: isAnonymized ? null : r.email,
      hallTicketNumber: isAnonymized ? null : r.hallTicketNumber,
      // the system's evaluation, waiting for this examiner to read the script and decide
      systemEvaluation: r.proposedTotal == null ? null : { proposedTotal: Number(r.proposedTotal), max: Number(r.proposedMax), needsExaminer: Number(r.needsExaminer), checkCarefully: Number(r.checkCarefully) },
    };
  });
}

// ---------------------------------------------------------------------------
// Evaluator Marks Entry & Double Evaluation / Moderation
// ---------------------------------------------------------------------------
export async function recordEvaluatorMarks(
  trx: Knex.Transaction,
  tenantId: string,
  evaluatorUserId: string,
  attemptId: string,
  items: ResultItem[],
  roleType?: EvaluatorRoleType,
) {
  // Check if an assignment exists
  let assignment = await trx('evaluator_assignments')
    .where({ tenant_id: tenantId, attempt_id: attemptId, evaluator_user_id: evaluatorUserId })
    .first();

  const assignedRole = assignment?.role_type ?? roleType ?? 'EVALUATOR_1';

  // Record result version
  const rv = await recordResultVersion(trx, tenantId, evaluatorUserId, attemptId, items);

  // Update assignment status
  if (assignment) {
    await trx('evaluator_assignments')
      .where('id', assignment.id)
      .update({
        status: 'COMPLETED',
        result_version_id: rv.resultVersionId,
        completed_at: trx.fn.now(),
        updated_at: trx.fn.now(),
      });
  }

  // Check double evaluation logic
  const packet = await trx('candidate_review_packets').where({ tenant_id: tenantId, attempt_id: attemptId }).first();
  const exam = await trx('exams').where('id', packet.exam_id).first();
  const policy = (exam.policy ?? {}) as Record<string, unknown>;
  const isDoubleEval = exam.exam_type === 'SEM_EXTERNAL' || Boolean(policy['doubleEvaluation']);

  if (isDoubleEval) {
    // Check if both EVALUATOR_1 and EVALUATOR_2 are completed
    const a1 = await trx('evaluator_assignments')
      .where({ tenant_id: tenantId, attempt_id: attemptId, role_type: 'EVALUATOR_1', status: 'COMPLETED' })
      .first();
    const a2 = await trx('evaluator_assignments')
      .where({ tenant_id: tenantId, attempt_id: attemptId, role_type: 'EVALUATOR_2', status: 'COMPLETED' })
      .first();

    if (!a1 || !a2) {
      // One evaluation is still pending. Keep in ACADEMIC_MARKING_READY.
      const fresh = await trx('candidate_review_packets').where('id', packet.id).first();
      if (fresh.status !== 'ACADEMIC_MARKING_READY') {
        await trx('candidate_review_packets').where('id', packet.id).update({
          status: 'ACADEMIC_MARKING_READY',
          updated_at: trx.fn.now(),
        });
      }
      return {
        ...rv,
        doubleEvaluation: true,
        status: 'ACADEMIC_MARKING_READY',
        pendingSecondEvaluation: true,
      };
    }

    // Both completed! Compare marks for divergence
    const rv1 = await trx('result_versions').where('id', a1.result_version_id).first();
    const rv2 = await trx('result_versions').where('id', a2.result_version_id).first();

    const diff = Math.abs(Number(rv1.total_marks) - Number(rv2.total_marks));
    const thresholdPct = Number(policy['divergenceThresholdPct'] ?? 15);
    const thresholdMarks = (thresholdPct / 100) * Number(rv.max);

    if (diff > thresholdMarks) {
      // Divergence exceeded threshold! Transition to MARKING_MODERATION_REQUIRED
      const fresh = await trx('candidate_review_packets').where('id', packet.id).first();
      await setPacketStatus(trx, fresh, 'MARKING_MODERATION_REQUIRED');

      await trx('moderation_samples').insert({
        tenant_id: tenantId,
        exam_id: packet.exam_id,
        attempt_id: attemptId,
        evaluator_1_user_id: a1.evaluator_user_id,
        evaluator_2_user_id: a2.evaluator_user_id,
        reason: 'DIVERGENCE_EXCEEDED',
        divergence: diff,
        evaluator_1_marks: rv1.total_marks,
        evaluator_2_marks: rv2.total_marks,
        status: 'PENDING',
      });

      await audit(trx, {
        tenantId,
        actorType: 'USER',
        actorId: evaluatorUserId,
        action: 'moderation.divergence_flagged',
        entityType: 'candidate_review_packet',
        entityId: packet.id,
        metadata: { attemptId, diff, thresholdMarks, rv1Marks: rv1.total_marks, rv2Marks: rv2.total_marks },
      });

      return {
        ...rv,
        doubleEvaluation: true,
        status: 'MARKING_MODERATION_REQUIRED',
        divergence: diff,
      };
    } else {
      // Divergence is within threshold: advance to EXAM_CELL_REVIEW
      return {
        ...rv,
        doubleEvaluation: true,
        status: 'EXAM_CELL_REVIEW',
        divergence: diff,
      };
    }
  }

  return rv;
}

// ---------------------------------------------------------------------------
// Moderation Workflow
// ---------------------------------------------------------------------------
export async function listModerationSamples(
  trx: Knex.Transaction,
  tenantId: string,
  examId: string,
) {
  return trx('moderation_samples as m')
    .leftJoin('users as u1', 'u1.id', 'm.evaluator_1_user_id')
    .leftJoin('users as u2', 'u2.id', 'm.evaluator_2_user_id')
    .leftJoin('users as mod', 'mod.id', 'm.moderator_user_id')
    .where('m.tenant_id', tenantId)
    .andWhere('m.exam_id', examId)
    .select(
      'm.id',
      'm.attempt_id as attemptId',
      'm.reason',
      'm.divergence',
      'm.evaluator_1_marks as evaluator1Marks',
      'm.evaluator_2_marks as evaluator2Marks',
      'u1.full_name as evaluator1Name',
      'u2.full_name as evaluator2Name',
      'mod.full_name as moderatorName',
      'm.status',
      'm.resolution_note as resolutionNote',
      'm.resolved_version_id as resolvedVersionId',
      'm.created_at as createdAt',
      'm.resolved_at as resolvedAt',
    );
}

export async function resolveModeration(
  trx: Knex.Transaction,
  tenantId: string,
  moderatorUserId: string,
  sampleId: string,
  input: ModerationResolveInput,
) {
  const sample = await trx('moderation_samples')
    .where({ tenant_id: tenantId, id: sampleId })
    .first();
  if (!sample) throw AppError.notFound('MODERATION_SAMPLE_NOT_FOUND');
  if (sample.status !== 'PENDING') throw AppError.conflict('MODERATION_ALREADY_RESOLVED', 'Moderation sample has already been resolved');

  // Record reconciled 3rd version
  const rv = await recordResultVersion(trx, tenantId, moderatorUserId, sample.attempt_id, input.items);

  // Update moderation sample
  await trx('moderation_samples')
    .where('id', sample.id)
    .update({
      status: 'RESOLVED',
      resolution_note: input.resolutionNote,
      resolved_version_id: rv.resultVersionId,
      moderator_user_id: moderatorUserId,
      resolved_at: trx.fn.now(),
    });

  // Ensure candidate packet moves to EXAM_CELL_REVIEW
  const packet = await trx('candidate_review_packets').where({ tenant_id: tenantId, attempt_id: sample.attempt_id }).first();
  if (packet.status === 'MARKING_MODERATION_REQUIRED') {
    await setPacketStatus(trx, packet, 'EXAM_CELL_REVIEW');
  }

  await audit(trx, {
    tenantId,
    actorType: 'USER',
    actorId: moderatorUserId,
    action: 'moderation.resolved',
    entityType: 'moderation_sample',
    entityId: sample.id,
    metadata: { attemptId: sample.attempt_id, resultVersionId: rv.resultVersionId },
  });

  return {
    sampleId: sample.id,
    status: 'RESOLVED',
    resultVersionId: rv.resultVersionId,
  };
}

// ---------------------------------------------------------------------------
// Revaluation Workflow
// ---------------------------------------------------------------------------
export async function requestRevaluation(
  trx: Knex.Transaction,
  tenantId: string,
  studentUserId: string,
  attemptId: string,
  input: RevaluationRequestInput,
) {
  const attempt = await trx('exam_attempts')
    .where({ tenant_id: tenantId, id: attemptId, user_id: studentUserId })
    .first();
  if (!attempt) throw AppError.notFound('ATTEMPT_NOT_FOUND');

  const packet = await trx('candidate_review_packets')
    .where({ tenant_id: tenantId, attempt_id: attemptId })
    .first();
  if (!packet) throw AppError.notFound('PACKET_NOT_FOUND');
  if (packet.status !== 'PUBLISHED') {
    throw AppError.conflict('REVALUATION_NOT_ELIGIBLE', `Results must be PUBLISHED to request revaluation (currently ${packet.status})`);
  }

  // 7-day revaluation window check
  if (packet.published_at) {
    const publishedAtTime = new Date(packet.published_at).getTime();
    const daysSincePublish = (Date.now() - publishedAtTime) / (1000 * 60 * 60 * 24);
    if (daysSincePublish > 7) {
      throw AppError.conflict('REVALUATION_WINDOW_CLOSED', 'The 7-day revaluation request window has closed.');
    }
  }

  // Check existing request
  const existing = await trx('revaluation_requests')
    .where({ tenant_id: tenantId, attempt_id: attemptId })
    .first();
  if (existing) {
    throw AppError.conflict('REVALUATION_ALREADY_REQUESTED', 'A revaluation request has already been recorded for this attempt.');
  }

  const [req] = await trx('revaluation_requests')
    .insert({
      tenant_id: tenantId,
      attempt_id: attemptId,
      requested_by: studentUserId,
      reason: input.reason,
      fee_ref: input.feeRef ?? null,
      status: 'REQUESTED',
    })
    .returning('id');

  await audit(trx, {
    tenantId,
    actorType: 'USER',
    actorId: studentUserId,
    action: 'revaluation.requested',
    entityType: 'revaluation_request',
    entityId: req.id,
    metadata: { attemptId, reason: input.reason, feeRef: input.feeRef },
  });

  return { requestId: req.id, status: 'REQUESTED' };
}

export async function listRevaluationRequests(
  trx: Knex.Transaction,
  tenantId: string,
  examId: string,
) {
  return trx('revaluation_requests as r')
    .join('exam_attempts as a', 'a.id', 'r.attempt_id')
    .join('candidate_review_packets as p', 'p.attempt_id', 'r.attempt_id')
    .join('users as u', 'u.id', 'r.requested_by')
    .leftJoin('result_versions as rv', 'rv.id', 'p.result_version_id')
    .where('r.tenant_id', tenantId)
    .andWhere('a.exam_id', examId)
    .select(
      'r.id',
      'r.attempt_id as attemptId',
      'r.requested_by as studentUserId',
      'u.full_name as studentName',
      'u.email as studentEmail',
      'r.reason',
      'r.fee_ref as feeRef',
      'r.status',
      'r.decision_note as decisionNote',
      'r.created_at as createdAt',
      'r.decided_at as decidedAt',
      'rv.total_marks as currentMarks',
      'rv.max_marks as maxMarks',
      'p.status as packetStatus',
    );
}

export async function getStudentRevaluationStatus(
  trx: Knex.Transaction,
  tenantId: string,
  studentUserId: string,
  attemptId: string,
) {
  const req = await trx('revaluation_requests')
    .where({ tenant_id: tenantId, attempt_id: attemptId, requested_by: studentUserId })
    .first();
  return req ?? null;
}

export async function decideRevaluationRequest(
  trx: Knex.Transaction,
  tenantId: string,
  actorId: string,
  requestId: string,
  input: RevaluationDecideInput,
) {
  const req = await trx('revaluation_requests')
    .where({ tenant_id: tenantId, id: requestId })
    .first();
  if (!req) throw AppError.notFound('REVALUATION_REQUEST_NOT_FOUND');
  if (req.status !== 'REQUESTED') {
    throw AppError.conflict('REQUEST_ALREADY_DECIDED', `Request is already ${req.status}`);
  }

  const packet = await trx('candidate_review_packets').where({ tenant_id: tenantId, attempt_id: req.attempt_id }).first();
  const exam = await trx('exams').where('id', packet.exam_id).first();
  const user = await trx('users').where('id', req.requested_by).first();
  const host = await tenantPrimaryHost(trx, tenantId);

  if (input.decision === 'REJECTED') {
    await trx('revaluation_requests')
      .where('id', req.id)
      .update({
        status: 'REJECTED',
        decision_note: input.note ?? 'Request rejected by Examination Cell.',
        decided_by: actorId,
        decided_at: trx.fn.now(),
        updated_at: trx.fn.now(),
      });

    await enqueueMail(trx, {
      tenantId,
      category: 'REVALUATION_DECISION',
      to: { address: user.email, name: user.full_name },
      dedupeKey: `reval:${req.id}:rejected`,
      vars: {
        fullName: user.full_name,
        examTitle: exam.title,
        decision: 'REJECTED',
        decisionNote: input.note ?? 'Your request was reviewed and not approved.',
        portalUrl: `https://${host}`,
      },
    });

    await audit(trx, {
      tenantId,
      actorType: 'USER',
      actorId,
      action: 'revaluation.rejected',
      entityType: 'revaluation_request',
      entityId: req.id,
      metadata: { attemptId: req.attempt_id, note: input.note },
    });

    return { requestId: req.id, status: 'REJECTED' };
  }

  // APPROVED: transition PUBLISHED -> REVALUATION_PENDING -> ACADEMIC_MARKING_READY
  await trx('revaluation_requests')
    .where('id', req.id)
    .update({
      status: 'APPROVED',
      decision_note: input.note ?? 'Approved for re-evaluation.',
      decided_by: actorId,
      decided_at: trx.fn.now(),
      updated_at: trx.fn.now(),
    });

  const fresh = await trx('candidate_review_packets').where('id', packet.id).first();
  await setPacketStatus(trx, fresh, 'REVALUATION_PENDING');
  const fresh2 = await trx('candidate_review_packets').where('id', packet.id).first();
  await setPacketStatus(trx, fresh2, 'ACADEMIC_MARKING_READY');

  await enqueueMail(trx, {
    tenantId,
    category: 'REVALUATION_DECISION',
    to: { address: user.email, name: user.full_name },
    dedupeKey: `reval:${req.id}:approved`,
    vars: {
      fullName: user.full_name,
      examTitle: exam.title,
      decision: 'APPROVED',
      decisionNote: input.note ?? 'Your request was approved and moved for re-evaluation.',
      portalUrl: `https://${host}`,
    },
  });

  await audit(trx, {
    tenantId,
    actorType: 'USER',
    actorId,
    action: 'revaluation.approved',
    entityType: 'revaluation_request',
    entityId: req.id,
    metadata: { attemptId: req.attempt_id, note: input.note },
  });

  return { requestId: req.id, status: 'APPROVED' };
}

// ---------------------------------------------------------------------------
// Gate E: Rubric Proposal Generation & Similarity Analysis
// ---------------------------------------------------------------------------
/**
 * Automatic mark proposals for the examiner (see ./auto-marks.ts): answer key for MCQ and NUMERIC, rubric key terms
 * otherwise; none where the system cannot judge. Never a mark: recordResultVersion requires a reason for any mark
 * that differs from these, recomputed there from the same data.
 */
export async function generateRubricProposals(trx: Knex.Transaction, tenantId: string, attemptId: string) {
  const packet = await trx('candidate_review_packets').where({ tenant_id: tenantId, attempt_id: attemptId }).first('exam_id');
  if (!packet) throw AppError.notFound('PACKET_NOT_FOUND');
  const proposals = await proposeMarksForAttempt(trx, tenantId, packet.exam_id, attemptId);
  if (!proposals) throw AppError.notFound('APPROVED_PAPER_NOT_FOUND', 'No approved question paper for this exam');
  const proposedTotal = proposals.reduce((a, p) => a + (p.proposedMarks ?? 0), 0);
  return { attemptId, proposals, proposedTotal: Math.round(proposedTotal * 100) / 100, needsExaminer: proposals.filter((p) => p.proposedMarks === null).map((p) => p.questionId) };
}

/** Re-run the system's evaluation for every script of the exam that is still waiting for, or in, marking. */
export async function autoEvaluateExam(trx: Knex.Transaction, tenantId: string, examId: string) {
  const exam = await trx('exams').where({ tenant_id: tenantId, id: examId }).first('id');
  if (!exam) throw AppError.notFound('EXAM_NOT_FOUND');
  const packets = await trx('candidate_review_packets').where({ tenant_id: tenantId, exam_id: examId }).whereIn('status', ['ACADEMIC_MARKING_READY', 'MARKING_MODERATION_REQUIRED', 'REVALUATION_PENDING', 'EXAM_CELL_REVIEW']).select('attempt_id');
  let evaluated = 0;
  let checkCarefully = 0;
  let needsExaminer = 0;
  for (const p of packets) {
    // programs whose grading failed (judge down) or changed are queued again; the worker refreshes the proposal after
    await trx('code_runs').where({ tenant_id: tenantId, attempt_id: p.attempt_id, purpose: 'GRADING', status: 'ERROR' }).update({ status: 'QUEUED', attempts: 0, error: null, claimed_at: null });
    await enqueueCodeGrading(trx, tenantId, examId, p.attempt_id);
    const s = await snapshotProposals(trx, tenantId, examId, p.attempt_id);
    if (!s) throw AppError.notFound('APPROVED_PAPER_NOT_FOUND', 'No approved question paper for this exam');
    evaluated++;
    if (s.checkCarefully) checkCarefully++;
    if (s.needsExaminer) needsExaminer++;
  }
  return { evaluated, scriptsToReadCarefully: checkCarefully, scriptsWithQuestionsForTheExaminer: needsExaminer };
}

export async function analyzeExamSimilarity(
  trx: Knex.Transaction,
  tenantId: string,
  examId: string,
  threshold = 0.85,
) {
  const exam = await trx('exams').where({ tenant_id: tenantId, id: examId }).first('id');
  if (!exam) throw AppError.notFound('EXAM_NOT_FOUND');
  // Fetch all sealed attempts for the exam
  const attempts = await trx('exam_attempts')
    .where({ tenant_id: tenantId, exam_id: examId })
    .whereIn('status', ['SUBMITTED', 'EXPIRED'])
    .select('id');

  if (attempts.length < 2) {
    return { examId, threshold, comparisonsCount: 0, flaggedPairs: [] };
  }

  // Fetch answer documents
  const docs = await trx('answer_documents')
    .whereIn('attempt_id', attempts.map((a) => a.id))
    .select('attempt_id', 'question_id', 'content');

  // Group by questionId -> attemptId -> normalized text
  const questionAnswers = new Map<string, Map<string, string>>();
  for (const d of docs) {
    if (!questionAnswers.has(d.question_id)) {
      questionAnswers.set(d.question_id, new Map());
    }
    const parsed = typeof d.content === 'string' ? JSON.parse(d.content) : d.content;
    const blocks = (parsed?.blocks ?? []) as Array<{ kind: string; content: string }>;
    const text = blocks
      .map((b) => (typeof b.content === 'string' ? b.content : ''))
      .join(' ')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, ' ')
      .trim();

    if (text.length > 20) {
      questionAnswers.get(d.question_id)!.set(d.attempt_id, text);
    }
  }

  function get3Grams(str: string): Set<string> {
    const set = new Set<string>();
    const words = str.split(/\s+/).filter(Boolean);
    for (let i = 0; i <= words.length - 3; i++) {
      set.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
    }
    return set;
  }

  function jaccardSimilarity(s1: Set<string>, s2: Set<string>): number {
    if (s1.size === 0 || s2.size === 0) return 0;
    let intersect = 0;
    for (const g of s1) if (s2.has(g)) intersect++;
    return intersect / (s1.size + s2.size - intersect);
  }

  const flaggedPairs: Array<{
    attemptId1: string;
    attemptId2: string;
    questionId: string;
    similarity: number;
  }> = [];

  let comparisonsCount = 0;

  for (const [questionId, attemptTexts] of questionAnswers.entries()) {
    const attemptList = Array.from(attemptTexts.entries());
    for (let i = 0; i < attemptList.length; i++) {
      const [id1, text1] = attemptList[i]!;
      const grams1 = get3Grams(text1);
      if (grams1.size === 0) continue;

      for (let j = i + 1; j < attemptList.length; j++) {
        const [id2, text2] = attemptList[j]!;
        const grams2 = get3Grams(text2);
        if (grams2.size === 0) continue;

        comparisonsCount++;
        const sim = jaccardSimilarity(grams1, grams2);
        if (sim >= threshold) {
          flaggedPairs.push({
            attemptId1: id1,
            attemptId2: id2,
            questionId,
            similarity: Math.round(sim * 100) / 100,
          });

          // Move candidates to INTEGRITY_HOLD for human adjudication
          for (const attId of [id1, id2]) {
            const p = await trx('candidate_review_packets').where({ tenant_id: tenantId, attempt_id: attId }).first();
            if (p && ['ACADEMIC_MARKING_READY', 'EXAM_CELL_REVIEW', 'FORENSIC_REVIEW_READY'].includes(p.status)) {
              await setPacketStatus(trx, p, 'INTEGRITY_HOLD');
              await trx('candidate_review_packets').where('id', p.id).update({
                hold_reason: `Answer similarity of ${Math.round(sim * 100)}% on question ${questionId} with candidate ${attId === id1 ? id2 : id1}`,
                updated_at: trx.fn.now(),
              });
            }
          }
        }
      }
    }
  }

  return { examId, threshold, comparisonsCount, flaggedPairs };
}
