import { withTenantTx, type Knex } from '@examos/db';
import type { z } from 'zod';
import { EXAM_TRANSITIONS, assertTransition, type ExamCreateSchema, type ExamStatus, type AdmissionExceptionSchema, SECURITY_REQUIRED_CHECKS, type PrecheckCheckCode } from '@examos/contracts';
import type { AppDeps } from '../../types.js';
import { AppError } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { sha256Hex } from '../../lib/crypto.js';
import { recordIntegrationEvent } from '../integration/events.js';
import { enqueueMail } from '../notifications/service.js';
import { sealAttempt } from '../attempts/service.js';
import { instructionFor } from '../attempts/instructions.js';

type ExamCreate = z.infer<typeof ExamCreateSchema>;
type AdmissionException = z.infer<typeof AdmissionExceptionSchema>;

export async function createExam(trx: Knex.Transaction, tenantId: string, actorId: string, input: ExamCreate): Promise<string> {
  const course = await trx('courses').where({ tenant_id: tenantId, code: input.courseCode }).first('id');
  if (!course) throw AppError.unprocessable('COURSE_NOT_FOUND', `course ${input.courseCode} unknown; sync the roster first`);
  if (new Date(input.windowEndAt) <= new Date(input.windowStartAt)) throw AppError.unprocessable('WINDOW_INVALID', 'windowEndAt must be after windowStartAt');
  const [e] = await trx('exams')
    .insert({
      tenant_id: tenantId,
      code: input.code,
      title: input.title,
      course_id: course.id,
      exam_type: input.examType,
      academic_year: input.academicYear ?? null,
      semester: input.semester ?? null,
      max_marks: input.maxMarks ?? null,
      security_profile: input.securityProfile,
      duration_minutes: input.durationMinutes,
      window_start_at: new Date(input.windowStartAt),
      window_end_at: new Date(input.windowEndAt),
      warning_threshold: input.warningThreshold,
      policy: JSON.stringify(input.policy ?? {}),
      policy_version: `v1-${sha256Hex(JSON.stringify(input.policy ?? {})).slice(0, 8)}`,
      created_by: actorId,
    })
    .onConflict(['tenant_id', 'code'])
    .ignore()
    .returning('id');
  if (!e) throw AppError.conflict('EXAM_EXISTS', `exam ${input.code} already exists`);
  await audit(trx, { tenantId, actorType: 'USER', actorId, action: 'exam.created', entityType: 'exam', entityId: e.id, metadata: { code: input.code, securityProfile: input.securityProfile, examType: input.examType } });
  return e.id as string;
}

export async function transitionExam(trx: Knex.Transaction, tenantId: string, actorId: string, examId: string, to: ExamStatus, requestId?: string): Promise<{ from: ExamStatus; to: ExamStatus }> {
  const exam = await trx('exams').where({ tenant_id: tenantId, id: examId }).forUpdate().first();
  if (!exam) throw AppError.notFound('EXAM_NOT_FOUND');
  const from = exam.status as ExamStatus;
  assertTransition('exam', EXAM_TRANSITIONS, from, to);

  if (to === 'APPROVED' && from === 'PAPER_REVIEW') {
    const paper = await trx('question_papers')
      .where({ tenant_id: tenantId, exam_id: examId, status: 'APPROVED' })
      .first();
    if (!paper) {
      throw AppError.unprocessable('APPROVED_PAPER_REQUIRED', 'Exam cannot move to APPROVED without an approved question paper');
    }
    if (exam.max_marks != null && Number(paper.total_marks) !== Number(exam.max_marks)) {
      throw AppError.unprocessable(
        'PAPER_MARKS_MISMATCH',
        `Approved paper total marks (${paper.total_marks}) does not match exam max marks (${exam.max_marks})`,
      );
    }
  }

  const now = new Date();
  const stamps: Record<string, unknown> = {};
  if (to === 'PRECHECK') {
    if (now.getTime() < new Date(exam.window_start_at).getTime() - 2 * 3600_000 || now.getTime() > new Date(exam.window_end_at).getTime()) throw AppError.unprocessable('OUTSIDE_WINDOW', 'Readiness check can open at most 2 hours before the exam window and not after it closes');
    stamps['precheck_opened_at'] = now;
    stamps['precheck_opened_by'] = actorId;
  }
  if (to === 'LIVE') {
    if (now.getTime() > new Date(exam.window_end_at).getTime()) throw AppError.unprocessable('OUTSIDE_WINDOW', 'The exam window has already closed');
    stamps['started_at'] = now;
    stamps['started_by'] = actorId;
  }
  if (to === 'CLOSED') {
    stamps['closed_at'] = now;
    stamps['closed_by'] = actorId;
  }
  await trx('exams').where('id', examId).update({ status: to, ...stamps, updated_at: trx.fn.now() });
  if (to === 'PRECHECK') {
    await trx('exam_attempts').where({ tenant_id: tenantId, exam_id: examId, status: 'ALLOCATED' }).update({ status: 'PRECHECK_AVAILABLE', updated_at: trx.fn.now() });
  }
  if (to === 'CLOSED') {
    // Server-side deadline authority: any attempt still open is expired and sealed with its acknowledged answers.
    const open = await trx('exam_attempts').where({ tenant_id: tenantId, exam_id: examId }).whereIn('status', ['ACTIVE', 'RECOVERY_PENDING', 'SUSPENDED', 'ADMITTED']).select('id');
    for (const a of open) await sealAttempt(trx, tenantId, a.id, 'EXPIRED', 'SYSTEM:exam_closed', null);
    await trx('exam_attempts').where({ tenant_id: tenantId, exam_id: examId }).whereIn('status', ['ALLOCATED', 'PRECHECK_AVAILABLE', 'PRECHECK_RUNNING', 'READY']).update({ status: 'EXPIRED', updated_at: trx.fn.now() });
  }
  await audit(trx, { tenantId, actorType: 'USER', actorId, action: `exam.${to.toLowerCase()}`, entityType: 'exam', entityId: examId, requestId, metadata: { from, to } });
  if (to === 'SCHEDULED') {
    await recordIntegrationEvent(trx, { tenantId, type: 'exam.scheduled', aggregateType: 'exam', aggregateId: examId, data: { examId, examCode: exam.code, windowStartAt: new Date(exam.window_start_at).toISOString(), windowEndAt: new Date(exam.window_end_at).toISOString() } });
  }
  return { from, to };
}

/**
 * Allocation creates the attempt row (ALLOCATED). Allocation changes are
 * refused while the exam is in PRECHECK or LIVE (review §11, decision 6).
 */
export async function allocateStudents(trx: Knex.Transaction, tenantId: string, actorId: string, examId: string, provider: string, input: { studentExternalIds: string[]; extraTimeMinutes: number; accommodationRef?: string }): Promise<{ allocated: number; skipped: Array<{ externalId: string; reason: string }> }> {
  const exam = await trx('exams').where({ tenant_id: tenantId, id: examId }).forUpdate().first();
  if (!exam) throw AppError.notFound('EXAM_NOT_FOUND');
  if (['PRECHECK', 'LIVE', 'CLOSED', 'ARCHIVED', 'CANCELLED'].includes(exam.status)) throw AppError.conflict('EXAM_LOCKED', `Allocations cannot change while the exam is ${exam.status}`);
  let allocated = 0;
  const skipped: Array<{ externalId: string; reason: string }> = [];
  for (const ext of input.studentExternalIds) {
    const ident = await trx('external_identities as x').join('users as u', 'u.id', 'x.user_id').where({ 'x.tenant_id': tenantId, 'x.provider': provider, 'x.external_id': ext }).select('u.id', 'u.kind', 'u.status').first();
    if (!ident || ident.kind !== 'STUDENT') {
      skipped.push({ externalId: ext, reason: 'STUDENT_NOT_FOUND' });
      continue;
    }
    if (ident.status === 'SUSPENDED' || ident.status === 'INACTIVE') {
      skipped.push({ externalId: ext, reason: 'STUDENT_INACTIVE' });
      continue;
    }
    const enrolled = exam.course_id
      ? await trx('course_enrollments').where({ tenant_id: tenantId, user_id: ident.id, course_id: exam.course_id }).whereIn('eligibility_status', ['ELIGIBLE']).first('id')
      : { id: 'n/a' };
    if (!enrolled) {
      skipped.push({ externalId: ext, reason: 'NOT_ELIGIBLE_FOR_COURSE' });
      continue;
    }
    const inserted = await trx('exam_allocations')
      .insert({ tenant_id: tenantId, exam_id: examId, user_id: ident.id, extra_time_minutes: input.extraTimeMinutes, accommodation_ref: input.accommodationRef ?? null })
      .onConflict(['tenant_id', 'exam_id', 'user_id'])
      .merge({ extra_time_minutes: input.extraTimeMinutes, accommodation_ref: input.accommodationRef ?? null, status: 'ALLOCATED', updated_at: trx.fn.now() })
      .returning('id');
    if (inserted.length) {
      await trx('exam_attempts').insert({ tenant_id: tenantId, exam_id: examId, user_id: ident.id, attempt_no: 1, status: 'ALLOCATED' }).onConflict(['tenant_id', 'exam_id', 'user_id', 'attempt_no']).ignore();
      allocated++;
    }
  }
  await audit(trx, { tenantId, actorType: 'USER', actorId, action: 'exam.allocated', entityType: 'exam', entityId: examId, metadata: { allocated, skipped: skipped.length } });
  await recordIntegrationEvent(trx, { tenantId, type: 'exam.allocation.changed', aggregateType: 'exam', aggregateId: examId, data: { examId, examCode: exam.code, allocated, skipped } });
  return { allocated, skipped };
}

/** Hall tickets per exam, issued by the Examination Section (second brief). */
export async function issueHallTickets(trx: Knex.Transaction, tenantId: string, actorId: string, examId: string, explicit?: Record<string, string>): Promise<{ issued: number }> {
  const exam = await trx('exams').where({ tenant_id: tenantId, id: examId }).first();
  if (!exam) throw AppError.notFound('EXAM_NOT_FOUND');
  const allocations = await trx('exam_allocations as a')
    .leftJoin('hall_tickets as h', function () {
      this.on('h.exam_id', '=', 'a.exam_id').andOn('h.user_id', '=', 'a.user_id');
    })
    .leftJoin('student_profiles as sp', 'sp.user_id', 'a.user_id')
    .where({ 'a.tenant_id': tenantId, 'a.exam_id': examId, 'a.status': 'ALLOCATED' })
    .whereNull('h.id')
    .select('a.user_id', 'sp.register_number')
    .orderBy('sp.register_number');
  let issued = 0;
  const countRow = await trx('hall_tickets').where({ tenant_id: tenantId, exam_id: examId }).count<{ count: string }[]>('id as count');
  let seq = Number(countRow[0]?.count ?? 0);
  for (const a of allocations) {
    seq++;
    const number = explicit?.[a.user_id] ?? `${exam.code}-${String(seq).padStart(4, '0')}`;
    const verificationHash = sha256Hex(`${tenantId}|${examId}|${a.user_id}|${number}`);
    await trx('hall_tickets').insert({ tenant_id: tenantId, exam_id: examId, user_id: a.user_id, number, issued_by: actorId, verification_hash: verificationHash });
    issued++;
  }
  await audit(trx, { tenantId, actorType: 'USER', actorId, action: 'halltickets.issued', entityType: 'exam', entityId: examId, metadata: { issued } });
  return { issued };
}

/**
 * Examination Section readiness board (second brief): every candidate × every
 * check, with the diagnostic and the instruction the student sees. Nothing is
 * admitted that is not READY or covered by an approved exception.
 */
export async function readinessBoard(trx: Knex.Transaction, tenantId: string, examId: string) {
  const exam = await trx('exams').where({ tenant_id: tenantId, id: examId }).first();
  if (!exam) throw AppError.notFound('EXAM_NOT_FOUND');
  const attempts = await trx('exam_attempts as at')
    .join('users as u', 'u.id', 'at.user_id')
    .leftJoin('student_profiles as sp', 'sp.user_id', 'u.id')
    .leftJoin('hall_tickets as h', function () {
      this.on('h.exam_id', '=', 'at.exam_id').andOn('h.user_id', '=', 'at.user_id');
    })
    .where({ 'at.tenant_id': tenantId, 'at.exam_id': examId })
    .select('at.id as attemptId', 'at.status', 'at.suspension_kind as suspensionKind', 'u.full_name as fullName', 'u.email', 'sp.register_number as registerNumber', 'h.number as hallTicket')
    .orderBy('sp.register_number');
  const attemptIds = attempts.map((a) => a.attemptId);
  const runs = attemptIds.length
    ? await trx('precheck_runs').whereIn('attempt_id', attemptIds).orderBy('started_at', 'desc')
    : [];
  const latestRunByAttempt = new Map<string, (typeof runs)[number]>();
  for (const r of runs) if (!latestRunByAttempt.has(r.attempt_id)) latestRunByAttempt.set(r.attempt_id, r);
  const runIds = [...latestRunByAttempt.values()].map((r) => r.id);
  const items = runIds.length ? await trx('precheck_items').whereIn('precheck_run_id', runIds).orderBy(['precheck_run_id', 'check_code', { column: 'iteration', order: 'desc' }]) : [];
  const exceptions = attemptIds.length ? await trx('admission_exceptions').whereIn('attempt_id', attemptIds).whereNull('revoked_at').where('expires_at', '>', trx.fn.now()) : [];

  const candidates = attempts.map((a) => {
    const run = latestRunByAttempt.get(a.attemptId);
    const latestItems = new Map<string, (typeof items)[number]>();
    for (const it of items) if (run && it.precheck_run_id === run.id && !latestItems.has(it.check_code)) latestItems.set(it.check_code, it);
    const checks = [...latestItems.values()].map((it) => ({
      code: it.check_code,
      status: it.status,
      source: it.source,
      diagnosticCode: it.diagnostic_code,
      remediationCode: it.remediation_code,
      instruction: instructionFor(it.check_code, it.status, it.remediation_code),
      securityRelevant: SECURITY_REQUIRED_CHECKS.includes(it.check_code as PrecheckCheckCode),
    }));
    const blocking = checks.filter((c) => c.status === 'REMEDIATE' || c.status === 'NEED_HELP' || c.status === 'UNVERIFIABLE');
    const exc = exceptions.filter((e) => e.attempt_id === a.attemptId);
    return {
      ...a,
      precheck: run ? { runId: run.id, status: run.status, clientBuild: run.client_build, startedAt: run.started_at, readyUntil: run.ready_until } : null,
      checks,
      blocking: blocking.map((c) => c.code),
      exceptions: exc.map((e) => ({ id: e.id, code: e.exception_code, coversChecks: e.covers_checks, approvedBy: e.approved_by, expiresAt: e.expires_at })),
    };
  });
  const summary = {
    total: candidates.length,
    ready: candidates.filter((c) => c.precheck?.status === 'READY' || ['ADMITTED', 'ACTIVE'].includes(c.status)).length,
    needsFix: candidates.filter((c) => c.precheck?.status === 'REMEDIATE').length,
    needsReview: candidates.filter((c) => c.precheck?.status === 'REVIEW').length,
    notStarted: candidates.filter((c) => !c.precheck).length,
    active: candidates.filter((c) => c.status === 'ACTIVE').length,
    suspended: candidates.filter((c) => c.status === 'SUSPENDED').length,
    submitted: candidates.filter((c) => ['SUBMITTED', 'EXPIRED'].includes(c.status)).length,
  };
  return { exam: { id: exam.id, code: exam.code, title: exam.title, status: exam.status, securityProfile: exam.security_profile, startedAt: exam.started_at, precheckOpenedAt: exam.precheck_opened_at }, summary, candidates };
}

export async function grantAdmissionException(trx: Knex.Transaction, tenantId: string, actor: { userId: string; canOverrideSecurity: boolean }, attemptId: string, input: AdmissionException): Promise<string> {
  const attempt = await trx('exam_attempts').where({ tenant_id: tenantId, id: attemptId }).first();
  if (!attempt) throw AppError.notFound('ATTEMPT_NOT_FOUND');
  const touchesSecurity = input.coversChecks.some((c) => SECURITY_REQUIRED_CHECKS.includes(c));
  if (touchesSecurity && !actor.canOverrideSecurity) throw AppError.forbidden('SECURITY_OVERRIDE_REQUIRED', 'Only a Controller-level approver may waive identity, eligibility, client or consent checks');
  const [row] = await trx('admission_exceptions')
    .insert({ tenant_id: tenantId, attempt_id: attemptId, exception_code: input.exceptionCode, covers_checks: input.coversChecks, approved_by: actor.userId, reason: input.reason, expires_at: new Date(Date.now() + input.expiresInMinutes * 60_000) })
    .returning('id');
  await audit(trx, { tenantId, actorType: 'USER', actorId: actor.userId, action: 'admission.exception.granted', entityType: 'exam_attempt', entityId: attemptId, metadata: { code: input.exceptionCode, coversChecks: input.coversChecks, touchesSecurity } });
  return row.id as string;
}

/**
 * Export lock (second brief): no paper, answer or script export while an exam
 * is in PRECHECK or LIVE. Attempts are audited and alert the Examination
 * Section in their own committed transaction before the request is refused.
 */
export async function assertExportAllowed(deps: AppDeps, trx: Knex.Transaction, tenantId: string, examId: string, actorId: string, what: string): Promise<void> {
  const exam = await trx('exams').where({ tenant_id: tenantId, id: examId }).first();
  if (!exam) throw AppError.notFound('EXAM_NOT_FOUND');
  if (exam.status !== 'PRECHECK' && exam.status !== 'LIVE') return;
  await withTenantTx(deps.db, tenantId, async (alertTrx) => {
    await audit(alertTrx, { tenantId, actorType: 'USER', actorId, action: 'export.blocked', entityType: 'exam', entityId: examId, metadata: { what, status: exam.status } });
    const actor = await alertTrx('users').where('id', actorId).first('email', 'full_name');
    const recipients = await alertTrx('role_grants as g').join('users as u', 'u.id', 'g.user_id').where({ 'g.tenant_id': tenantId }).whereNull('g.revoked_at').whereIn('g.role_code', ['EXAM_CELL_OPERATOR', 'CONTROLLER']).distinct('u.email', 'u.full_name');
    for (const r of recipients) {
      await enqueueMail(alertTrx, {
        tenantId,
        category: 'SECURITY_ALERT',
        to: { address: r.email, name: r.full_name },
        dedupeKey: `export-blocked:${examId}:${actorId}:${what}:${Math.floor(Date.now() / 600_000)}:${r.email}`,
        vars: { examTitle: exam.title, what, actorEmail: actor?.email ?? actorId, actorName: actor?.full_name ?? '', at: new Date().toISOString(), examStatus: exam.status },
      });
    }
  });
  throw AppError.forbidden('EXPORT_LOCKED', `Exports are locked while the exam is ${exam.status}; the Examination Section has been notified`);
}
