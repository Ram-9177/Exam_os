import { withTenantTx, withWorkerTx, type Knex } from '@examos/db';
import { CANDIDATE_TRANSITIONS, assertTransition, type CandidateStatus } from '@examos/contracts';
import type { AppDeps } from '../../types.js';
import { proposeMarksForAttempt, snapshotProposals } from '../evaluation/auto-marks.js';
import { AppError } from '../../lib/errors.js';
import { audit, logAttemptEvent } from '../../lib/audit.js';
import { canonicalJson, sha256Hex } from '../../lib/crypto.js';
import { recordIntegrationEvent } from '../integration/events.js';
import { enqueueMail } from '../notifications/service.js';
import { tenantPrimaryHost } from '../tenants/service.js';
import { erpIdentity } from '../../lib/identity.js';

/**
 * Post-seal candidate pipeline (spec §46, review §3/§9).
 *
 * Forensic checks here are the completeness and provenance checks that exist
 * without the media pipeline: manifest ↔ document hashes, timeline chain,
 * unresolved incidents. Identity is recorded as session-verified (SSO + hall
 * ticket + invigilator) until the biometric pipeline (Gate C) exists; media
 * quality is NOT_APPLICABLE for the same reason. Nothing here can mark a
 * candidate as a confirmed violation — only humans do that.
 */
export async function runForensicChecks(deps: AppDeps, trx: Knex.Transaction, tenantId: string, attemptId: string) {
  const packet = await trx('candidate_review_packets').where({ tenant_id: tenantId, attempt_id: attemptId }).forUpdate().first();
  if (!packet) throw AppError.notFound('PACKET_NOT_FOUND');
  if (packet.status !== 'ATTEMPT_SEALED') return packet;
  await setPacketStatus(trx, packet, 'FORENSIC_CHECKS_RUNNING');

  const manifest = await trx('submission_manifests').where({ attempt_id: attemptId }).first();
  const docs = await trx('answer_documents').where({ attempt_id: attemptId });
  const findings: Array<{ category: string; severity: 'INFO' | 'LOW' | 'HIGH'; detail: string }> = [];
  if (!manifest) findings.push({ category: 'SUBMISSION', severity: 'HIGH', detail: 'no submission manifest' });
  else {
    const expected = new Map((manifest.manifest.answers as Array<{ questionId: string; sha256: string; revision: number }>).map((a) => [a.questionId, a]));
    for (const d of docs) {
      const m = expected.get(d.question_id);
      if (!m) findings.push({ category: 'SUBMISSION', severity: 'HIGH', detail: `document ${d.question_id} missing from manifest` });
      else if (m.sha256 !== d.content_sha256 || m.revision !== d.current_revision) findings.push({ category: 'SUBMISSION', severity: 'HIGH', detail: `document ${d.question_id} differs from sealed manifest` });
      const revs = await trx('answer_revisions').where({ attempt_id: attemptId, question_id: d.question_id }).orderBy('revision');
      if (revs.length !== d.current_revision) findings.push({ category: 'ANSWER_LEDGER', severity: 'HIGH', detail: `revision count ${revs.length} ≠ current revision ${d.current_revision} for ${d.question_id}` });
      if (revs.length && revs[revs.length - 1]!.content_sha256 !== d.content_sha256) findings.push({ category: 'ANSWER_LEDGER', severity: 'HIGH', detail: `last revision hash mismatch for ${d.question_id}` });
    }
  }
  // timeline hash chain
  const events = await trx('attempt_event_log').where({ attempt_id: attemptId }).orderBy('seq');
  let prev: string | null = null;
  for (const e of events) {
    if (e.prev_hash !== prev) {
      findings.push({ category: 'TIMELINE', severity: 'HIGH', detail: `hash chain broken at seq ${e.seq}` });
      break;
    }
    prev = e.hash;
  }
  const unresolved = await trx('proctor_incidents').where({ attempt_id: attemptId, status: 'PROCTOR_REVIEW' }).count<{ count: string }[]>('id as count');
  const confirmed = await trx('proctor_warnings').where({ attempt_id: attemptId }).count<{ count: string }[]>('id as count');
  const unresolvedCount = Number(unresolved[0]?.count ?? 0);
  const confirmedCount = Number(confirmed[0]?.count ?? 0);
  if (unresolvedCount) findings.push({ category: 'INCIDENTS', severity: 'LOW', detail: `${unresolvedCount} incident(s) awaiting proctor decision` });
  findings.push({ category: 'INCIDENTS', severity: 'INFO', detail: `${confirmedCount} confirmed warning(s) across all epochs` });

  const high = findings.some((f) => f.severity === 'HIGH');
  const integrityState = high ? 'PENDING_TECHNICAL' : unresolvedCount ? 'PENDING' : confirmedCount ? 'CLEARED_WITH_NOTES' : 'CLEAR';
  await trx('candidate_review_packets').where('id', packet.id).update({
    identity_state: 'VERIFIED_BY_SESSION',
    media_quality_state: 'NOT_APPLICABLE',
    integrity_state: integrityState,
    sealed_submission_verified: !!manifest && !high,
    checklist_digest: sha256Hex(canonicalJson(findings)),
    updated_at: trx.fn.now(),
  });
  const fresh = await trx('candidate_review_packets').where('id', packet.id).first();
  const next: CandidateStatus = high ? 'TECHNICAL_REVIEW_REQUIRED' : 'FORENSIC_REVIEW_READY';
  await setPacketStatus(trx, fresh, next);
  if (next === 'FORENSIC_REVIEW_READY') {
    await setPacketStatus(trx, { ...fresh, status: next }, 'ACADEMIC_MARKING_READY');
    // The system evaluates the script as soon as it reaches marking; a person then reads it and decides.
    await snapshotProposals(trx, tenantId, fresh.exam_id, attemptId);
  }
  await logAttemptEvent(trx, { tenantId, attemptId, eventType: 'forensics.completed', actor: 'SYSTEM:forensics', metadata: { findings, integrityState } });
  return { ...fresh, status: next === 'FORENSIC_REVIEW_READY' ? 'ACADEMIC_MARKING_READY' : next, findings };
}

export async function setPacketStatus(trx: Knex.Transaction, packet: { id: string; status: string; version: number }, to: CandidateStatus) {
  assertTransition('candidate', CANDIDATE_TRANSITIONS, packet.status as CandidateStatus, to);
  await trx('candidate_review_packets').where('id', packet.id).update({ status: to, version: packet.version + 1, updated_at: trx.fn.now() });
  packet.status = to;
  packet.version = packet.version + 1;
}

/** Worker pass: runs forensic checks for all sealed packets. */
export async function runForensicsOnce(deps: AppDeps, batch = 50): Promise<number> {
  const sealed = await withWorkerTx(deps.db, (trx) => trx('candidate_review_packets').where('status', 'ATTEMPT_SEALED').orderBy('created_at').limit(batch).select('tenant_id', 'attempt_id'));
  for (const p of sealed) {
    try {
      await withTenantTx(deps.db, p.tenant_id, (trx) => runForensicChecks(deps, trx, p.tenant_id, p.attempt_id));
    } catch (e) {
      // A packet whose checks cannot run (corrupt manifest, unexpected data) goes to a human instead of
      // blocking every later packet of every tenant on this lane.
      deps.logger.error({ err: e, tenantId: p.tenant_id, attemptId: p.attempt_id }, 'forensic checks failed; routed to technical review');
      await withTenantTx(deps.db, p.tenant_id, async (trx) => {
        const packet = await trx('candidate_review_packets').where({ tenant_id: p.tenant_id, attempt_id: p.attempt_id }).forNoKeyUpdate().first();
        if (!packet || packet.status !== 'ATTEMPT_SEALED') return;
        assertTransition('candidate', CANDIDATE_TRANSITIONS, packet.status, 'TECHNICAL_REVIEW_REQUIRED');
        await trx('candidate_review_packets').where('id', packet.id).update({ status: 'TECHNICAL_REVIEW_REQUIRED', version: packet.version + 1, hold_reason: `FORENSICS_FAILED: ${e instanceof Error ? e.message.slice(0, 200) : 'error'}`, updated_at: trx.fn.now() });
        await logAttemptEvent(trx, { tenantId: p.tenant_id, attemptId: p.attempt_id, eventType: 'forensics.failed', actor: 'SYSTEM:forensics', metadata: { error: e instanceof Error ? e.message.slice(0, 200) : 'error' } });
      }).catch((err) => deps.logger.error({ err, attemptId: p.attempt_id }, 'could not route failed packet to technical review'));
    }
  }
  return sealed.length;
}

// ---------------------------------------------------------------------------
// Academic lane: examiner records question-wise marks with one explanation
// per question (second brief). AI proposals plug in as a *source* of the items
// later; the approving human is always named.
// ---------------------------------------------------------------------------
export interface ResultItem {
  questionId: string;
  maxMarks: number;
  marks: number;
  explanation: string;
  criteria?: Array<{ code: string; max: number; awarded: number; evidence?: string }>;
  overrideReason?: string;
  proposedMarks?: number | null;
  proposalMethod?: string;
  /** Set on a revaluation version: the mark that was published before. */
  publishedMarks?: number;
}

export async function recordResultVersion(trx: Knex.Transaction, tenantId: string, examinerId: string, attemptId: string, items: ResultItem[]) {
  const packet = await trx('candidate_review_packets').where({ tenant_id: tenantId, attempt_id: attemptId }).forUpdate().first();
  if (!packet) throw AppError.notFound('PACKET_NOT_FOUND');
  if (!['ACADEMIC_MARKING_READY', 'MARKING_MODERATION_REQUIRED', 'EXAM_CELL_REVIEW', 'REVALUATION_PENDING', 'CANDIDATE_APPROVED', 'CONTROLLER_AUTHORIZED'].includes(packet.status)) throw AppError.conflict('PACKET_STATE', `candidate is ${packet.status}`);
  for (const it of items) {
    if (it.marks < 0 || it.marks > it.maxMarks) throw AppError.unprocessable('MARK_OUT_OF_RANGE', `question ${it.questionId}: ${it.marks} not within 0..${it.maxMarks}`);
    if (it.criteria) {
      const sum = it.criteria.reduce((a, c) => a + c.awarded, 0);
      if (Math.abs(sum - it.marks) > 0.001) throw AppError.unprocessable('CRITERIA_SUM_MISMATCH', `question ${it.questionId}: criteria sum ${sum} ≠ marks ${it.marks}`);
      if (it.criteria.some((c) => c.awarded < 0 || c.awarded > c.max)) throw AppError.unprocessable('CRITERION_OUT_OF_RANGE', `question ${it.questionId}: a criterion exceeds its maximum`);
    }
    if (!it.explanation.trim()) throw AppError.unprocessable('EXPLANATION_REQUIRED', `question ${it.questionId}: an explanation is required`);
  }

  const docs = await trx('answer_documents').where({ attempt_id: attemptId }).select('question_id');
  const answered = new Set(docs.map((d) => d.question_id));
  for (const it of items) if (!answered.has(it.questionId) && it.marks > 0) throw AppError.unprocessable('MARKS_WITHOUT_ANSWER', `question ${it.questionId} has no submitted answer but non-zero marks`);

  // Validate against approved question paper if one exists
  const paper = await trx('question_papers')
    .where({ tenant_id: tenantId, exam_id: packet.exam_id, status: 'APPROVED' })
    .first();
  if (paper) {
    const paperQuestions = await trx('paper_questions').where({ tenant_id: tenantId, paper_id: paper.id });
    const qMap = new Map(paperQuestions.map((q) => [q.question_id, q]));
    for (const it of items) {
      const q = qMap.get(it.questionId);
      if (!q) {
        throw AppError.unprocessable('UNKNOWN_QUESTION_ID', `question ${it.questionId} is not in the approved question paper`);
      }
      if (Number(it.maxMarks) !== Number(q.max_marks)) {
        throw AppError.unprocessable('MAX_MARKS_MISMATCH', `question ${it.questionId}: max marks ${it.maxMarks} ≠ paper max marks ${q.max_marks}`);
      }
      if (it.marks > Number(q.max_marks)) {
        throw AppError.unprocessable('MARK_OUT_OF_RANGE', `question ${it.questionId}: marks ${it.marks} exceeds paper max marks ${q.max_marks}`);
      }
    }
  }

  // Automatic proposals: recomputed here (never taken from the client). A mark that differs from the proposal needs
  // the examiner's reason; proposal, method and reason are kept with the version for the Exam Cell and any appeal.
  const proposals = await proposeMarksForAttempt(trx, tenantId, packet.exam_id, attemptId);
  if (proposals) {
    const byQ = new Map(proposals.map((p) => [p.questionId, p]));
    items = items.map((it) => {
      const p = byQ.get(it.questionId);
      if (!p) return it;
      const differs = p.proposedMarks !== null && Math.abs(p.proposedMarks - it.marks) > 0.001;
      if (differs && !(it.overrideReason && it.overrideReason.trim().length >= 10)) {
        throw AppError.unprocessable('OVERRIDE_REASON_REQUIRED', `question ${it.questionId}: the proposed mark is ${p.proposedMarks}; give a reason (at least 10 characters) for ${it.marks}`);
      }
      const { overrideReason, ...rest } = it;
      // a reason is kept whenever one is needed — here, or below for a change from the published mark
      return { ...rest, proposedMarks: p.proposedMarks, proposalMethod: p.method, ...(overrideReason?.trim() ? { overrideReason: overrideReason.trim() } : {}) };
    });
  }

  // After publication marks change only through an approved revaluation; every change from the published mark is
  // explained (the reason goes back to the student with the outcome).
  const live = await trx('student_exam_records').where({ tenant_id: tenantId, attempt_id: attemptId }).whereNull('superseded_at').first('result_version_id');
  if (live) {
    const pub = await trx('result_versions').where('id', live.result_version_id).first('items');
    const pubMarks = new Map(((pub?.items ?? []) as ResultItem[]).map((i) => [i.questionId, Number(i.marks)]));
    items = items.map((it) => {
      const before = pubMarks.get(it.questionId);
      if (before === undefined || Math.abs(before - it.marks) < 0.001) return it;
      const reason = it.overrideReason;
      if (!(reason && reason.trim().length >= 10)) throw AppError.unprocessable('REVALUATION_REASON_REQUIRED', `question ${it.questionId}: the published mark was ${before}; give a reason (at least 10 characters) for ${it.marks}`);
      return { ...it, publishedMarks: before, overrideReason: reason.trim() };
    });
  }

  const total = round2(items.reduce((a, i) => a + i.marks, 0));
  const max = round2(items.reduce((a, i) => a + i.maxMarks, 0));
  const last = await trx('result_versions').where({ attempt_id: attemptId }).max<{ max: number | null }[]>('version as max');
  const version = Number(last[0]?.max ?? 0) + 1;
  const [rv] = await trx('result_versions').insert({ tenant_id: tenantId, attempt_id: attemptId, version, total_marks: total, max_marks: max, items: JSON.stringify(items), approved_by: examinerId, approved_at: trx.fn.now() }).returning('id');

  // A new academic version invalidates any live approval (spec §50 invariant; test 21).
  const invalidated = await trx('candidate_approvals').where({ packet_id: packet.id, decision: 'APPROVED' }).whereNull('invalidated_at').update({ invalidated_at: trx.fn.now(), invalidated_reason: `superseded by result version ${version}` });
  const fresh = await trx('candidate_review_packets').where('id', packet.id).first();
  await trx('candidate_review_packets').where('id', packet.id).update({ result_version_id: rv.id, academic_state: 'HUMAN_APPROVED', version: fresh.version + 1, updated_at: trx.fn.now() });
  fresh.version += 1;
  if (['ACADEMIC_MARKING_READY', 'MARKING_MODERATION_REQUIRED', 'REVALUATION_PENDING'].includes(fresh.status)) {
    if (fresh.status === 'REVALUATION_PENDING') await setPacketStatus(trx, fresh, 'ACADEMIC_MARKING_READY');
    await setPacketStatus(trx, fresh, 'EXAM_CELL_REVIEW');
  } else if (['CANDIDATE_APPROVED', 'CONTROLLER_AUTHORIZED'].includes(fresh.status)) {
    await setPacketStatus(trx, fresh, 'EXAM_CELL_REVIEW');
  }
  await logAttemptEvent(trx, { tenantId, attemptId, eventType: 'marks.version_recorded', actor: `USER:${examinerId}`, metadata: { version, total, max, invalidatedApprovals: invalidated } });
  await audit(trx, { tenantId, actorType: 'USER', actorId: examinerId, action: 'marks.recorded', entityType: 'exam_attempt', entityId: attemptId, metadata: { version, total, max } });
  return { resultVersionId: rv.id, version, total, max, invalidatedApprovals: invalidated };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Exam Cell lane
// ---------------------------------------------------------------------------
export async function listCandidates(trx: Knex.Transaction, tenantId: string, examId: string) {
  const rows = await trx('candidate_review_packets as p')
    .join('users as u', 'u.id', 'p.user_id')
    .leftJoin('student_profiles as sp', 'sp.user_id', 'u.id')
    .leftJoin('hall_tickets as h', function () {
      this.on('h.exam_id', '=', 'p.exam_id').andOn('h.user_id', '=', 'p.user_id');
    })
    .leftJoin('result_versions as rv', 'rv.id', 'p.result_version_id')
    .where({ 'p.tenant_id': tenantId, 'p.exam_id': examId })
    .select('p.*', 'u.full_name as fullName', 'sp.register_number as registerNumber', 'h.number as hallTicket', 'rv.version as resultVersion', 'rv.total_marks as totalMarks', 'rv.max_marks as maxMarks')
    .orderBy('sp.register_number');
  const summary = {
    total: rows.length,
    ready: rows.filter((r) => r.status === 'EXAM_CELL_REVIEW').length,
    approved: rows.filter((r) => ['CANDIDATE_APPROVED', 'CONTROLLER_AUTHORIZED'].includes(r.status)).length,
    published: rows.filter((r) => r.status === 'PUBLISHED').length,
    needsReview: rows.filter((r) => ['TECHNICAL_REVIEW_REQUIRED', 'IDENTITY_REVIEW_REQUIRED', 'MARKING_MODERATION_REQUIRED'].includes(r.status)).length,
    onHold: rows.filter((r) => r.status === 'INTEGRITY_HOLD').length,
    awaitingMarks: rows.filter((r) => ['ATTEMPT_SEALED', 'FORENSIC_CHECKS_RUNNING', 'FORENSIC_REVIEW_READY', 'ACADEMIC_MARKING_READY'].includes(r.status)).length,
  };
  return { summary, candidates: rows };
}

/**
 * Integrity is derived from the live incident ledger, not frozen at forensic
 * time: a proctor may dismiss or confirm incidents after sealing. PENDING_TECHNICAL
 * (manifest/ledger inconsistency) can only be cleared by a human hold release.
 */
export async function refreshIntegrityState(trx: Knex.Transaction, packet: { id: string; attempt_id: string; integrity_state: string }): Promise<string> {
  if (packet.integrity_state === 'PENDING_TECHNICAL' || packet.integrity_state === 'CONFIRMED_VIOLATION') return packet.integrity_state;
  const unresolved = await trx('proctor_incidents').where({ attempt_id: packet.attempt_id, status: 'PROCTOR_REVIEW' }).count<{ count: string }[]>('id as count');
  const confirmed = await trx('proctor_warnings').where({ attempt_id: packet.attempt_id }).count<{ count: string }[]>('id as count');
  const next = Number(unresolved[0]?.count ?? 0) > 0 ? 'PENDING' : Number(confirmed[0]?.count ?? 0) > 0 ? 'CLEARED_WITH_NOTES' : 'CLEAR';
  if (next !== packet.integrity_state) {
    await trx('candidate_review_packets').where('id', packet.id).update({ integrity_state: next, updated_at: trx.fn.now() });
    packet.integrity_state = next;
  }
  return next;
}

export async function candidateChecklist(trx: Knex.Transaction, tenantId: string, attemptId: string) {
  const p = await trx('candidate_review_packets').where({ tenant_id: tenantId, attempt_id: attemptId }).first();
  if (!p) throw AppError.notFound('PACKET_NOT_FOUND');
  await refreshIntegrityState(trx, p);
  const exam = await trx('exams').where('id', p.exam_id).first();
  const rv = p.result_version_id ? await trx('result_versions').where('id', p.result_version_id).first() : null;
  const unresolved = await trx('proctor_incidents').where({ attempt_id: attemptId, status: 'PROCTOR_REVIEW' }).count<{ count: string }[]>('id as count');
  const liveApproval = await trx('candidate_approvals').where({ packet_id: p.id, decision: 'APPROVED' }).whereNull('invalidated_at').first();
  const allocation = await trx('exam_allocations').where({ tenant_id: tenantId, exam_id: p.exam_id, user_id: p.user_id }).first('status', 'extra_time_minutes');
  const hallTicket = await trx('hall_tickets').where({ exam_id: p.exam_id, user_id: p.user_id }).whereNull('revoked_at').first('number');
  const ticketsIssued = await trx('hall_tickets').where({ tenant_id: tenantId, exam_id: p.exam_id }).count<{ count: string }[]>('id as count');
  const allocationOk = !!allocation && allocation.status === 'ALLOCATED';
  const ticketOk = Number(ticketsIssued[0]?.count ?? 0) === 0 || !!hallTicket;
  const checks = [
    { code: 'ELIGIBILITY_AND_SEAT', ok: allocationOk && ticketOk, detail: !allocationOk ? 'no active allocation' : ticketOk ? (hallTicket ? `hall ticket ${hallTicket.number}` : 'allocation present (no hall tickets issued for this exam)') : 'hall tickets were issued for this exam but this candidate has none' },
    { code: 'SEALED_SUBMISSION', ok: !!p.sealed_submission_verified, detail: p.sealed_submission_verified ? 'manifest verified' : 'manifest missing or inconsistent' },
    { code: 'IDENTITY', ok: ['VERIFIED_BY_SESSION', 'VERIFIED_MANUAL', 'VERIFIED_BIOMETRIC'].includes(p.identity_state), detail: p.identity_state },
    { code: 'MEDIA_QUALITY', ok: ['NOT_APPLICABLE', 'COMPLETE', 'REVIEWED'].includes(p.media_quality_state), detail: p.media_quality_state },
    { code: 'INCIDENTS_RESOLVED', ok: Number(unresolved[0]?.count ?? 0) === 0, detail: `${unresolved[0]?.count ?? 0} unresolved` },
    { code: 'INTEGRITY', ok: ['CLEAR', 'CLEARED_WITH_NOTES'].includes(p.integrity_state), detail: p.integrity_state },
    { code: 'MARKS_HUMAN_APPROVED', ok: !!rv && !!rv.approved_by, detail: rv ? `version ${rv.version}: ${rv.total_marks}/${rv.max_marks}` : 'no result version' },
    { code: 'MARK_SUM_RECOMPUTED', ok: !!rv && Math.abs(Number(rv.total_marks) - round2((rv.items as ResultItem[]).reduce((a, i) => a + i.marks, 0))) < 0.001, detail: 'database recomputation' },
    { code: 'APPROVAL_CURRENT', ok: !!liveApproval, detail: liveApproval ? `approved ${new Date(liveApproval.created_at).toISOString()}` : 'not yet approved' },
  ];
  return {
    packet: p,
    exam: { id: exam.id, code: exam.code, title: exam.title, examType: exam.exam_type },
    resultVersion: rv,
    checks,
    publishable: checks.filter((c) => c.code !== 'APPROVAL_CURRENT').every((c) => c.ok),
    liveApproval: liveApproval ? { id: liveApproval.id, approverUserId: liveApproval.approver_user_id, resultVersionId: liveApproval.result_version_id, createdAt: new Date(liveApproval.created_at).toISOString() } : null,
  };
}

/** Examiner queue: candidates awaiting marks for an exam. Deliberately carries no integrity or proctoring fields (spec §12: graders do not see misconduct flags). */
export async function evaluatorQueue(trx: Knex.Transaction, tenantId: string, examId: string) {
  const rows = await trx('candidate_review_packets as p')
    .join('users as u', 'u.id', 'p.user_id')
    .leftJoin('student_profiles as sp', 'sp.user_id', 'u.id')
    .leftJoin('hall_tickets as h', function () {
      this.on('h.exam_id', '=', 'p.exam_id').andOn('h.user_id', '=', 'p.user_id');
    })
    .leftJoin('result_versions as rv', 'rv.id', 'p.result_version_id')
    .leftJoin('mark_proposals as mp', 'mp.attempt_id', 'p.attempt_id')
    .where({ 'p.tenant_id': tenantId, 'p.exam_id': examId })
    .whereIn('p.status', ['ACADEMIC_MARKING_READY', 'MARKING_MODERATION_REQUIRED', 'REVALUATION_PENDING', 'EXAM_CELL_REVIEW', 'CANDIDATE_APPROVED', 'CONTROLLER_AUTHORIZED', 'PUBLISHED'])
    .select('p.attempt_id as attemptId', 'p.status', 'u.full_name as fullName', 'sp.register_number as registerNumber', 'h.number as hallTicket', 'rv.version as resultVersion', 'rv.total_marks as totalMarks', 'rv.max_marks as maxMarks', 'rv.approved_at as markedAt', 'mp.proposed_total as proposedTotal', 'mp.max_total as proposedMax', 'mp.needs_examiner as needsExaminer', 'mp.check_carefully as checkCarefully')
    .orderBy('sp.register_number');
  return {
    summary: { total: rows.length, awaitingMarks: rows.filter((r) => ['ACADEMIC_MARKING_READY', 'MARKING_MODERATION_REQUIRED', 'REVALUATION_PENDING'].includes(r.status)).length, marked: rows.filter((r) => r.resultVersion != null).length },
    candidates: rows.map((r) => ({ ...r, marking: ['ACADEMIC_MARKING_READY', 'MARKING_MODERATION_REQUIRED', 'REVALUATION_PENDING'].includes(r.status) ? 'AWAITING_MARKS' : r.status === 'PUBLISHED' ? 'PUBLISHED' : 'MARKED' })),
  };
}

/** Formal Exam Cell approval transaction (spec §46.5, implemented as written). */
export async function approveCandidate(trx: Knex.Transaction, tenantId: string, approverId: string, attemptId: string, input: { reviewedResultVersionId: string; reason: string; idempotencyKey: string }, policyVersion = 'examcell-v1') {
  const prior = await trx('candidate_approvals').where({ tenant_id: tenantId, idempotency_key: input.idempotencyKey }).first();
  if (prior) return { approvalId: prior.id, status: (await trx('candidate_review_packets').where('id', prior.packet_id).first('status')).status, replayed: true };
  const packet = await trx('candidate_review_packets').where({ tenant_id: tenantId, attempt_id: attemptId }).forUpdate().first();
  if (!packet) throw AppError.notFound('PACKET_NOT_FOUND');
  if (packet.status !== 'EXAM_CELL_REVIEW') throw AppError.conflict('PACKET_STATE', `candidate is ${packet.status}, not EXAM_CELL_REVIEW`);
  if (!packet.result_version_id || packet.result_version_id !== input.reviewedResultVersionId) throw AppError.conflict('STALE_REVIEW', 'The reviewed result version is not the current one');
  if (!packet.sealed_submission_verified) throw AppError.conflict('SEAL_UNVERIFIED', 'Sealed submission not verified');
  const checklist = await candidateChecklist(trx, tenantId, attemptId);
  if (!checklist.publishable) throw AppError.conflict('CHECKLIST_INCOMPLETE', `Blocking: ${checklist.checks.filter((c) => !c.ok && c.code !== 'APPROVAL_CURRENT').map((c) => c.code).join(', ')}`);
  const digest = sha256Hex(canonicalJson(checklist.checks));
  const [a] = await trx('candidate_approvals').insert({ tenant_id: tenantId, packet_id: packet.id, result_version_id: packet.result_version_id, packet_version: packet.version, approver_user_id: approverId, decision: 'APPROVED', policy_version: policyVersion, checklist_digest: digest, reason: input.reason, idempotency_key: input.idempotencyKey }).returning('id');
  await setPacketStatus(trx, packet, 'CANDIDATE_APPROVED');
  await trx('candidate_review_packets').where('id', packet.id).update({ checklist_digest: digest });
  await audit(trx, { tenantId, actorType: 'USER', actorId: approverId, action: 'candidate.approved', entityType: 'candidate_review_packet', entityId: packet.id, metadata: { attemptId, resultVersionId: packet.result_version_id, checklistDigest: digest } });
  await recordIntegrationEvent(trx, { tenantId, type: 'candidate.approved', aggregateType: 'candidate_review_packet', aggregateId: packet.id, data: { attemptId, examId: packet.exam_id, approvalId: a.id } });
  return { approvalId: a.id, status: 'CANDIDATE_APPROVED', replayed: false };
}

export async function holdCandidate(trx: Knex.Transaction, tenantId: string, actorId: string, attemptId: string, input: { status: Extract<CandidateStatus, 'INTEGRITY_HOLD' | 'TECHNICAL_REVIEW_REQUIRED' | 'IDENTITY_REVIEW_REQUIRED' | 'MARKING_MODERATION_REQUIRED'>; reason: string }) {
  const packet = await trx('candidate_review_packets').where({ tenant_id: tenantId, attempt_id: attemptId }).forUpdate().first();
  if (!packet) throw AppError.notFound('PACKET_NOT_FOUND');
  await setPacketStatus(trx, packet, input.status);
  await trx('candidate_review_packets').where('id', packet.id).update({ hold_reason: input.reason });
  await audit(trx, { tenantId, actorType: 'USER', actorId, action: 'candidate.held', entityType: 'candidate_review_packet', entityId: packet.id, metadata: { attemptId, status: input.status, reason: input.reason } });
  const user = await trx('users').where('id', packet.user_id).first('email', 'full_name');
  const exam = await trx('exams').where('id', packet.exam_id).first('title', 'code');
  const host = await tenantPrimaryHost(trx, tenantId);
  await enqueueMail(trx, { tenantId, category: 'CANDIDATE_HOLD_NOTICE', to: { address: user.email, name: user.full_name }, dedupeKey: `hold:${packet.id}:${packet.version}`, vars: { fullName: user.full_name, examTitle: exam.title, holdReason: input.reason, portalUrl: `https://${host}` } });
  await recordIntegrationEvent(trx, { tenantId, type: 'candidate.held', aggregateType: 'candidate_review_packet', aggregateId: packet.id, data: { attemptId, examId: packet.exam_id, examCode: exam.code, status: input.status } });
  return { status: input.status };
}

export async function releaseHold(trx: Knex.Transaction, tenantId: string, actorId: string, attemptId: string, reason: string) {
  const packet = await trx('candidate_review_packets').where({ tenant_id: tenantId, attempt_id: attemptId }).forUpdate().first();
  if (!packet) throw AppError.notFound('PACKET_NOT_FOUND');
  // A hold placed before marks exist (technical, identity or integrity) releases straight back into the marking
  // queue; a hold placed after marks returns to the Exam Cell's review. Neither may strand the candidate.
  if (!packet.result_version_id) {
    await setPacketStatus(trx, packet, 'FORENSIC_REVIEW_READY');
    await setPacketStatus(trx, packet, 'ACADEMIC_MARKING_READY');
  } else {
    await setPacketStatus(trx, packet, 'EXAM_CELL_REVIEW');
  }
  await trx('candidate_review_packets').where('id', packet.id).update({ hold_reason: null, integrity_state: packet.integrity_state === 'PENDING' || packet.integrity_state === 'PENDING_TECHNICAL' ? 'CLEARED_WITH_NOTES' : packet.integrity_state });
  await audit(trx, { tenantId, actorType: 'USER', actorId, action: 'candidate.hold_released', entityType: 'candidate_review_packet', entityId: packet.id, metadata: { attemptId, reason } });
  return { status: packet.status };
}

// ---------------------------------------------------------------------------
// Controller lane: authorize + publish → permanent ledger, ERP event, mail
// ---------------------------------------------------------------------------
export async function controllerAuthorizeAndPublish(trx: Knex.Transaction, tenantId: string, controllerId: string, attemptId: string, input: { candidateApprovalId: string; idempotencyKey: string }, opts: { mass?: boolean } = {}) {
  const prior = await trx('controller_publication_grants').where({ tenant_id: tenantId, idempotency_key: input.idempotencyKey }).first();
  if (prior) return { publicationGrantId: prior.id, status: 'PUBLISHED', replayed: true };
  const packet = await trx('candidate_review_packets').where({ tenant_id: tenantId, attempt_id: attemptId }).forUpdate().first();
  if (!packet) throw AppError.notFound('PACKET_NOT_FOUND');
  if (!opts.mass) {
    // Results of an exam go out together. One result alone is published only after that release: a hold the
    // Exam Cell has since released, or the outcome of a revaluation the Controller of Examinations approved.
    const ex = await trx('exams').where({ tenant_id: tenantId, id: packet.exam_id }).first('results_published_at');
    if (!ex?.results_published_at) throw AppError.conflict('MASS_PUBLICATION_REQUIRED', 'Results of this exam are released together: publish all approved results from the exam page first');
  }
  if (packet.status !== 'CANDIDATE_APPROVED') throw AppError.conflict('PACKET_STATE', `candidate is ${packet.status}, not CANDIDATE_APPROVED`);
  const approval = await trx('candidate_approvals').where({ id: input.candidateApprovalId, packet_id: packet.id, decision: 'APPROVED' }).whereNull('invalidated_at').first();
  if (!approval) throw AppError.conflict('APPROVAL_INVALID', 'No live Exam Cell approval with that id');
  if (approval.result_version_id !== packet.result_version_id) throw AppError.conflict('STALE_APPROVAL', 'Approval refers to a superseded result version');
  const rv = await trx('result_versions').where('id', packet.result_version_id).first();
  const [grant] = await trx('controller_publication_grants').insert({ tenant_id: tenantId, candidate_approval_id: approval.id, packet_id: packet.id, result_version_id: rv.id, controller_user_id: controllerId, idempotency_key: input.idempotencyKey }).returning('id');
  await setPacketStatus(trx, packet, 'CONTROLLER_AUTHORIZED');
  await setPacketStatus(trx, packet, 'PUBLISHED');
  const now = new Date();
  await trx('candidate_review_packets').where('id', packet.id).update({ published_at: now });

  // Lifelong ledger (second brief): supersede any earlier live record for this attempt, never overwrite.
  const exam = await trx('exams').where('id', packet.exam_id).first();
  const ht = await trx('hall_tickets').where({ exam_id: packet.exam_id, user_id: packet.user_id }).first('number');
  const previouslyPublished = await trx('student_exam_records').where({ attempt_id: attemptId }).whereNull('superseded_at').update({ superseded_at: now });
  await trx('student_exam_records').insert({ tenant_id: tenantId, user_id: packet.user_id, exam_id: packet.exam_id, attempt_id: attemptId, result_version_id: rv.id, course_id: exam.course_id, exam_type: exam.exam_type, academic_year: exam.academic_year, semester: exam.semester, marks: rv.total_marks, max_marks: rv.max_marks, grade: gradeFor(Number(rv.total_marks), Number(rv.max_marks), (exam.policy ?? {}) as Record<string, unknown>), hall_ticket_number: ht?.number ?? null, published_at: now });

  // If there was an approved revaluation request, mark it DONE
  await trx('revaluation_requests').where({ tenant_id: tenantId, attempt_id: attemptId, status: 'APPROVED' }).update({ status: 'DONE', updated_at: now });

  await logAttemptEvent(trx, { tenantId, attemptId, eventType: 'result.published', actor: `USER:${controllerId}`, metadata: { resultVersionId: rv.id, version: rv.version } });
  await audit(trx, { tenantId, actorType: 'USER', actorId: controllerId, action: 'result.published', entityType: 'candidate_review_packet', entityId: packet.id, metadata: { attemptId, resultVersionId: rv.id, approvalId: approval.id } });
  const user = await trx('users').where('id', packet.user_id).first('email', 'full_name');
  const ident = await erpIdentity(trx, tenantId, packet.user_id);
  const host = await tenantPrimaryHost(trx, tenantId);
  const isCorrection = previouslyPublished > 0; // a re-publication after an earlier published result, not an internal version number
  await recordIntegrationEvent(trx, {
    tenantId,
    type: isCorrection ? 'result.corrected' : 'result.published',
    aggregateType: 'result_version',
    aggregateId: rv.id,
    data: {
      examId: exam.id,
      examCode: exam.code,
      examType: exam.exam_type,
      academicYear: exam.academic_year,
      semester: exam.semester,
      studentExternalId: ident?.external_id ?? null,
      provider: ident?.provider ?? null,
      hallTicketNumber: ht?.number ?? null,
      resultVersion: rv.version,
      items: (rv.items as ResultItem[]).map((i) => ({ questionId: i.questionId, marks: i.marks, maxMarks: i.maxMarks })),
      total: Number(rv.total_marks),
      max: Number(rv.max_marks),
      publishedAt: now.toISOString(),
      verificationUrl: `https://${host}/verify/${attemptId}/${rv.version}`,
    },
  });
  await enqueueMail(trx, { tenantId, category: 'RESULT_PUBLISHED', to: { address: user.email, name: user.full_name }, dedupeKey: `result:${attemptId}:${rv.version}`, vars: { fullName: user.full_name, examTitle: exam.title, portalUrl: `https://${host}` } });
  return { publicationGrantId: grant.id, status: 'PUBLISHED', replayed: false };
}

/** A stable UUID derived from text (the per-candidate idempotency key of a mass release). */
function derivedUuid(text: string): string {
  const h = sha256Hex(text);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

/** Candidates in these states are withheld from the mass release (published later, once released). */
const HELD_STATUSES = ['INTEGRITY_HOLD', 'TECHNICAL_REVIEW_REQUIRED', 'IDENTITY_REVIEW_REQUIRED'];

/**
 * The Controller of Examinations releases every approved result of an exam at once, so no student learns a result
 * before the others. Refused while any script still waits for marks or Exam Cell approval; held candidates are
 * withheld and listed. After the release a published result changes only through a revaluation the COE approves.
 */
export async function publishExamResults(trx: Knex.Transaction, tenantId: string, controllerId: string, examId: string, idempotencyKey: string) {
  const exam = await trx('exams').where({ tenant_id: tenantId, id: examId }).forNoKeyUpdate().first();
  if (!exam) throw AppError.notFound('EXAM_NOT_FOUND');
  if (exam.results_published_at) {
    const published = await trx('candidate_review_packets').where({ tenant_id: tenantId, exam_id: examId, status: 'PUBLISHED' }).count<{ count: string }[]>('id as count');
    return { publishedAt: new Date(exam.results_published_at).toISOString(), published: Number(published[0]?.count ?? 0), withheld: [], replayed: true };
  }
  if (!['CLOSED', 'ARCHIVED'].includes(exam.status)) throw AppError.conflict('EXAM_NOT_CLOSED', `Results are released after the exam is closed (it is ${exam.status})`);
  const packets = await trx('candidate_review_packets').where({ tenant_id: tenantId, exam_id: examId }).select('id', 'attempt_id', 'status', 'result_version_id');
  const pending = packets.filter((p) => !['CANDIDATE_APPROVED', 'PUBLISHED', ...HELD_STATUSES].includes(p.status));
  if (pending.length) {
    const byStatus = pending.reduce<Record<string, number>>((a, p) => ({ ...a, [p.status]: (a[p.status] ?? 0) + 1 }), {});
    throw AppError.conflict('RESULTS_NOT_READY', `${pending.length} of ${packets.length} candidates are not approved yet (${Object.entries(byStatus).map(([k, v]) => `${v} ${k}`).join(', ')}); every script must be marked and approved before results are released`);
  }
  const approved = packets.filter((p) => p.status === 'CANDIDATE_APPROVED');
  if (!approved.length) throw AppError.conflict('NOTHING_TO_PUBLISH', 'No approved results to release');
  const now = new Date();
  await trx('exams').where('id', examId).update({ results_published_at: now, results_published_by: controllerId, updated_at: trx.fn.now() });
  for (const p of approved) {
    const approval = await trx('candidate_approvals').where({ packet_id: p.id, decision: 'APPROVED', result_version_id: p.result_version_id }).whereNull('invalidated_at').orderBy('created_at', 'desc').first('id');
    if (!approval) throw AppError.conflict('APPROVAL_INVALID', `candidate ${p.attempt_id} has no live approval`);
    await controllerAuthorizeAndPublish(trx, tenantId, controllerId, p.attempt_id, { candidateApprovalId: approval.id, idempotencyKey: derivedUuid(`${idempotencyKey}:${p.attempt_id}`) }, { mass: true });
  }
  const withheld = packets.filter((p) => HELD_STATUSES.includes(p.status)).map((p) => ({ attemptId: p.attempt_id, status: p.status }));
  await audit(trx, { tenantId, actorType: 'USER', actorId: controllerId, action: 'results.released', entityType: 'exam', entityId: examId, metadata: { published: approved.length, withheld: withheld.length, idempotencyKey } });
  return { publishedAt: now.toISOString(), published: approved.length, withheld, replayed: false };
}

/** Tenant grading rule from exam policy (`grading.bands: [{min, grade}]`); percentage fallback when absent. */
function gradeFor(marks: number, max: number, policy: Record<string, unknown>): string | null {
  const pct = max > 0 ? (marks / max) * 100 : 0;
  const grading = policy['grading'] as { bands?: Array<{ min: number; grade: string }> } | undefined;
  const bands = grading?.bands ?? [{ min: 90, grade: 'O' }, { min: 80, grade: 'A+' }, { min: 70, grade: 'A' }, { min: 60, grade: 'B+' }, { min: 50, grade: 'B' }, { min: 40, grade: 'C' }, { min: 0, grade: 'F' }];
  const band = [...bands].sort((a, b) => b.min - a.min).find((b) => pct >= b.min);
  return band?.grade ?? null;
}

// ---------------------------------------------------------------------------
// Student profile ledger + digital booklet
// ---------------------------------------------------------------------------
export async function studentLedger(trx: Knex.Transaction, tenantId: string, userId: string) {
  const records = await trx('student_exam_records as r').join('exams as e', 'e.id', 'r.exam_id').leftJoin('courses as c', 'c.id', 'r.course_id').where({ 'r.tenant_id': tenantId, 'r.user_id': userId }).whereNull('r.superseded_at').select('r.*', 'e.code as examCode', 'e.title as examTitle', 'c.code as courseCode', 'c.name as courseName').orderBy([{ column: 'r.academic_year' }, { column: 'r.semester' }, { column: 'r.published_at' }]);
  const semesters = await trx('v_student_semester_summary').where({ tenant_id: tenantId, user_id: userId }).orderBy(['academic_year', 'semester']);
  const overall = await trx('v_student_overall_summary').where({ tenant_id: tenantId, user_id: userId }).first();
  return { records, semesters, overall: overall ?? { exams: 0, semesters: 0, marks: 0, max_marks: 0, percentage: null } };
}

/**
 * Digital answer booklet (second brief): question → answer → marks → one
 * explanation per question, with the examiner, Controller grant and a
 * verification hash. Only available once PUBLISHED; the web app renders it in
 * a print layout branded for the tenant.
 */
export async function answerBooklet(trx: Knex.Transaction, tenantId: string, attemptId: string, viewer: { userId: string; isStaff: boolean }) {
  const packet = await trx('candidate_review_packets').where({ tenant_id: tenantId, attempt_id: attemptId }).first();
  if (!packet) throw AppError.notFound('PACKET_NOT_FOUND');
  if (!viewer.isStaff && packet.user_id !== viewer.userId) throw AppError.notFound('PACKET_NOT_FOUND');
  if (packet.status !== 'PUBLISHED' && !viewer.isStaff) throw AppError.conflict('NOT_PUBLISHED', 'The booklet is available after the result is published');
  const [tenant, exam, user, profile, ht, rv, docs, manifest, grant, paper] = await Promise.all([
    trx('tenants').where('id', tenantId).first('name', 'slug'),
    trx('exams').where('id', packet.exam_id).first(),
    trx('users').where('id', packet.user_id).first('full_name', 'email'),
    trx('student_profiles').where('user_id', packet.user_id).first('register_number'),
    trx('hall_tickets').where({ exam_id: packet.exam_id, user_id: packet.user_id }).first('number', 'verification_hash'),
    packet.result_version_id ? trx('result_versions').where('id', packet.result_version_id).first() : Promise.resolve(null),
    trx('answer_documents').where({ attempt_id: attemptId }).orderBy('question_id'),
    trx('submission_manifests').where({ attempt_id: attemptId }).first(),
    trx('controller_publication_grants').where({ packet_id: packet.id }).orderBy('authorized_at', 'desc').first(),
    trx('question_papers').where({ tenant_id: tenantId, exam_id: packet.exam_id, status: 'APPROVED' }).first(),
  ]);
  const paperQuestions = paper ? await trx('paper_questions').where({ tenant_id: tenantId, paper_id: paper.id }) : [];
  const qMap = new Map(paperQuestions.map((q) => [q.question_id, q]));
  const examiner = rv?.approved_by ? await trx('users').where('id', rv.approved_by).first('full_name') : null;
  const controller = grant ? await trx('users').where('id', grant.controller_user_id).first('full_name') : null;
  const items = new Map<string, ResultItem>(((rv?.items as ResultItem[]) ?? []).map((i) => [i.questionId, i]));
  const questions = docs.map((d) => ({
    questionId: d.question_id,
    prompt: qMap.get(d.question_id)?.prompt ?? null,
    answer: d.content,
    answerSha256: d.content_sha256,
    revision: d.current_revision,
    marks: items.get(d.question_id)?.marks ?? null,
    maxMarks: items.get(d.question_id)?.maxMarks ?? (qMap.get(d.question_id) ? Number(qMap.get(d.question_id)!.max_marks) : null),
    explanation: items.get(d.question_id)?.explanation ?? null,
    criteria: items.get(d.question_id)?.criteria ?? null,
  }));
  for (const [qid, it] of items) {
    if (!docs.some((d) => d.question_id === qid)) {
      questions.push({
        questionId: qid,
        prompt: qMap.get(qid)?.prompt ?? null,
        answer: { blocks: [] },
        answerSha256: null,
        revision: 0,
        marks: it.marks,
        maxMarks: it.maxMarks,
        explanation: it.explanation,
        criteria: it.criteria ?? null,
      });
    }
  }
  for (const pq of paperQuestions) {
    if (!questions.some((q) => q.questionId === pq.question_id)) {
      questions.push({
        questionId: pq.question_id,
        prompt: pq.prompt,
        answer: { blocks: [] },
        answerSha256: null,
        revision: 0,
        marks: null,
        maxMarks: Number(pq.max_marks),
        explanation: null,
        criteria: null,
      });
    }
  }
  const booklet = {
    tenant: { name: tenant.name, slug: tenant.slug },
    exam: { code: exam.code, title: exam.title, examType: exam.exam_type, academicYear: exam.academic_year, semester: exam.semester, durationMinutes: exam.duration_minutes },
    student: { name: user.full_name, registerNumber: profile?.register_number ?? null, hallTicket: ht?.number ?? null },
    status: packet.status,
    sealedAt: manifest ? new Date(manifest.sealed_at).toISOString() : null,
    manifestSha256: manifest?.manifest_sha256 ?? null,
    questions,
    total: rv ? { marks: Number(rv.total_marks), max: Number(rv.max_marks), version: rv.version } : null,
    validation: { examiner: examiner?.full_name ?? null, examinerApprovedAt: rv?.approved_at ? new Date(rv.approved_at).toISOString() : null, controller: controller?.full_name ?? null, publishedAt: packet.published_at ? new Date(packet.published_at).toISOString() : null },
  };
  const verificationHash = sha256Hex(canonicalJson({ attemptId, manifest: booklet.manifestSha256, total: booklet.total, questions: questions.map((q) => ({ q: q.questionId, s: q.answerSha256, m: q.marks })) }));
  return { ...booklet, verificationHash, verificationUrl: `/verify/${attemptId}/${rv?.version ?? 0}` };
}

export async function verifyResult(trx: Knex.Transaction, tenantId: string, attemptId: string, version: number) {
  const rv = await trx('result_versions').where({ tenant_id: tenantId, attempt_id: attemptId, version }).first();
  const packet = await trx('candidate_review_packets').where({ tenant_id: tenantId, attempt_id: attemptId }).first('status', 'published_at', 'result_version_id');
  if (!rv || !packet) return { valid: false };
  return { valid: packet.status === 'PUBLISHED' && packet.result_version_id === rv.id, published: packet.status === 'PUBLISHED', version, publishedAt: packet.published_at ? new Date(packet.published_at).toISOString() : null, total: Number(rv.total_marks), max: Number(rv.max_marks) };
}
