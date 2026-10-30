import type { Knex } from '@examos/db';
import {
  ATTEMPT_TRANSITIONS,
  assertTransition,
  HUMAN_REVIEW_ONLY_SIGNAL_CLASSES,
  SERVER_VERIFIED_COUNTABLE_CLASSES,
  TECHNICAL_SIGNAL_CLASSES,
  type ProctorSignalClass,
  type ProctorDecisionAction,
} from '@examos/contracts';
import type { AppDeps } from '../../types.js';
import { AppError } from '../../lib/errors.js';
import { audit, logAttemptEvent } from '../../lib/audit.js';
import { enqueueMail } from '../notifications/service.js';

/** Rapid repeats of the same signal within this window are one incident (spec §8, §30). */
const GROUPING_WINDOW_SECONDS = 120;

export interface IngestedEvent {
  sourceEventId: string;
  attemptId: string;
  signalClass: ProctorSignalClass;
  clientRecordedAt?: string;
  clientSequence?: number;
  metadata: Record<string, unknown>;
}

/**
 * Ingests raw signals. Deduplicated by (source, sourceEventId); grouped into an
 * open incident of the same class within the grouping window. Technical classes
 * become TECHNICAL incidents; vision/other classes go to PROCTOR_REVIEW; only
 * CONCURRENT_SESSION, which the server observes itself, is eligible for a
 * deterministic countable warning — and even that is inserted through a
 * decision row, never by the ingest path.
 */
export async function ingestEvents(deps: AppDeps, trx: Knex.Transaction, tenantId: string, sourceId: string, events: IngestedEvent[]) {
  const results: Array<{ sourceEventId: string; accepted: boolean; incidentId: string | null; duplicate: boolean }> = [];
  for (const ev of events) {
    const attempt = await trx('exam_attempts').where({ tenant_id: tenantId, id: ev.attemptId }).first('id', 'exam_id', 'status');
    if (!attempt) {
      results.push({ sourceEventId: ev.sourceEventId, accepted: false, incidentId: null, duplicate: false });
      continue;
    }
    const inserted = await trx('proctor_events')
      .insert({ tenant_id: tenantId, attempt_id: ev.attemptId, source_id: sourceId, source_event_id: ev.sourceEventId, signal_class: ev.signalClass, client_recorded_at: ev.clientRecordedAt ? new Date(ev.clientRecordedAt) : null, client_sequence: ev.clientSequence ?? null, metadata: JSON.stringify(ev.metadata) })
      .onConflict(['tenant_id', 'source_id', 'source_event_id'])
      .ignore()
      .returning('id');
    if (!inserted.length) {
      const existing = await trx('proctor_events').where({ tenant_id: tenantId, source_id: sourceId, source_event_id: ev.sourceEventId }).first('incident_id');
      results.push({ sourceEventId: ev.sourceEventId, accepted: true, incidentId: existing?.incident_id ?? null, duplicate: true });
      continue;
    }
    const now = deps.clock.now();
    const windowStart = new Date(now.getTime() - GROUPING_WINDOW_SECONDS * 1000);
    let incident = await trx('proctor_incidents').where({ attempt_id: ev.attemptId, signal_class: ev.signalClass }).whereIn('status', ['PROCTOR_REVIEW', 'TECHNICAL']).where('last_event_at', '>=', windowStart).orderBy('last_event_at', 'desc').forUpdate().first();
    if (incident) {
      await trx('proctor_incidents').where('id', incident.id).update({ last_event_at: now, event_count: incident.event_count + 1, updated_at: trx.fn.now() });
    } else {
      const status = TECHNICAL_SIGNAL_CLASSES.includes(ev.signalClass) ? 'TECHNICAL' : 'PROCTOR_REVIEW';
      const priority = SERVER_VERIFIED_COUNTABLE_CLASSES.includes(ev.signalClass) ? 90 : HUMAN_REVIEW_ONLY_SIGNAL_CLASSES.includes(ev.signalClass) ? 60 : status === 'TECHNICAL' ? 20 : 50;
      const [created] = await trx('proctor_incidents').insert({ tenant_id: tenantId, attempt_id: ev.attemptId, exam_id: attempt.exam_id, signal_class: ev.signalClass, status, first_event_at: now, last_event_at: now, priority }).returning('*');
      incident = created;
    }
    await trx('proctor_events').where('id', inserted[0].id).update({ incident_id: incident.id });
    await logAttemptEvent(trx, { tenantId, attemptId: ev.attemptId, eventType: 'proctor.signal', actor: `SOURCE:${sourceId}`, metadata: { signalClass: ev.signalClass, incidentId: incident.id, sourceEventId: ev.sourceEventId } });
    results.push({ sourceEventId: ev.sourceEventId, accepted: true, incidentId: incident.id, duplicate: false });
  }
  return results;
}

export async function listIncidents(trx: Knex.Transaction, tenantId: string, filter: { examId?: string; status?: string; limit: number }) {
  return trx('proctor_incidents as i')
    .join('exam_attempts as a', 'a.id', 'i.attempt_id')
    .join('users as u', 'u.id', 'a.user_id')
    .leftJoin('warning_epochs as w', 'w.id', 'a.current_epoch_id')
    .where('i.tenant_id', tenantId)
    .modify((qb) => {
      if (filter.examId) qb.where('i.exam_id', filter.examId);
      if (filter.status) qb.where('i.status', filter.status);
    })
    .select('i.*', 'a.status as attemptStatus', 'a.user_id as userId', 'u.full_name as studentName', 'w.confirmed_count as currentWarnings', 'w.epoch_no as epochNo')
    .orderBy([{ column: 'i.priority', order: 'desc' }, { column: 'i.created_at', order: 'asc' }])
    .limit(filter.limit);
}

export interface DecisionInput {
  action: ProctorDecisionAction;
  reasonCode: string;
  notes?: string;
  idempotencyKey: string;
}

/**
 * Human decision on an incident. CONFIRM_WARNING inserts the countable warning
 * and, on reaching the exam's threshold, suspends the attempt atomically in the
 * same transaction (spec §18 fifth-warning pseudocode, implemented literally).
 */
export async function decideIncident(deps: AppDeps, trx: Knex.Transaction, tenantId: string, actorUserId: string, incidentId: string, input: DecisionInput) {
  const prior = await trx('proctor_decisions').where({ tenant_id: tenantId, idempotency_key: input.idempotencyKey }).first();
  if (prior) return decisionResult(trx, prior.attempt_id, prior.id);

  const incident = await trx('proctor_incidents').where({ tenant_id: tenantId, id: incidentId }).forUpdate().first();
  if (!incident) throw AppError.notFound('INCIDENT_NOT_FOUND');
  const attempt = await trx('exam_attempts').where({ tenant_id: tenantId, id: incident.attempt_id }).forNoKeyUpdate().first();
  const exam = await trx('exams').where('id', attempt.exam_id).first('warning_threshold', 'title', 'id');
  const now = deps.clock.now();

  if (input.action === 'CONFIRM_WARNING') {
    if (TECHNICAL_SIGNAL_CLASSES.includes(incident.signal_class)) throw AppError.unprocessable('TECHNICAL_NOT_COUNTABLE', 'Technical signals (network, camera, recording gaps) can never be counted as warnings');
    if (!['ACTIVE', 'RECOVERY_PENDING', 'SUSPENDED'].includes(attempt.status)) throw AppError.conflict('ATTEMPT_STATE', `attempt is ${attempt.status}`);
    const epoch = await trx('warning_epochs').where({ attempt_id: attempt.id }).whereNull('closed_at').forUpdate().first();
    if (!epoch) throw AppError.conflict('NO_OPEN_EPOCH', 'Attempt has no open warning epoch');
    const already = await trx('proctor_warnings').where({ incident_id: incident.id, warning_epoch_id: epoch.id }).first('id');
    const [decision] = await trx('proctor_decisions')
      .insert({ tenant_id: tenantId, attempt_id: attempt.id, incident_id: incident.id, actor_user_id: actorUserId, actor_type: 'HUMAN', action: input.action, reason_code: input.reasonCode, notes: input.notes ?? null, idempotency_key: input.idempotencyKey, resulting_attempt_status: attempt.status, warning_count_after: epoch.confirmed_count })
      .returning('id');
    if (already) {
      // one countable warning per incident per epoch — a repeated confirm is a no-op decision
      return decisionResult(trx, attempt.id, decision.id);
    }
    const warningNo = epoch.confirmed_count + 1;
    await trx('proctor_warnings').insert({ tenant_id: tenantId, attempt_id: attempt.id, incident_id: incident.id, warning_epoch_id: epoch.id, warning_no: warningNo, decision_id: decision.id });
    await trx('warning_epochs').where('id', epoch.id).update({ confirmed_count: warningNo });
    await trx('proctor_incidents').where('id', incident.id).update({ status: 'CONFIRMED_COUNTABLE_WARNING', updated_at: trx.fn.now() });
    let resulting = attempt.status;
    if (warningNo >= exam.warning_threshold && attempt.status !== 'SUSPENDED') {
      assertTransition('attempt', ATTEMPT_TRANSITIONS, attempt.status, 'SUSPENDED');
      resulting = 'SUSPENDED';
      await trx('exam_attempts').where('id', attempt.id).update({ status: 'SUSPENDED', suspension_kind: 'WARNING_THRESHOLD', suspended_at: now, authorization_generation: attempt.authorization_generation + 1, updated_at: trx.fn.now() });
      await trx('proctor_decisions').insert({ tenant_id: tenantId, attempt_id: attempt.id, incident_id: incident.id, actor_user_id: null, actor_type: 'SERVER_POLICY', action: 'ESCALATE', reason_code: 'AUTOMATIC_POLICY_SUSPENSION', notes: `warning ${warningNo} of ${exam.warning_threshold} in epoch ${epoch.epoch_no}`, idempotency_key: trx.raw('gen_random_uuid()'), resulting_attempt_status: 'SUSPENDED', warning_count_after: warningNo });
      await logAttemptEvent(trx, { tenantId, attemptId: attempt.id, eventType: 'attempt.suspended', actor: 'SERVER_POLICY', metadata: { kind: 'WARNING_THRESHOLD', warningNo, epochId: epoch.id } });
      await notifyProctors(trx, tenantId, attempt.id, exam.title, `warning ${warningNo}/${exam.warning_threshold} confirmed`);
    }
    await trx('proctor_decisions').where('id', decision.id).update({ resulting_attempt_status: resulting, warning_count_after: warningNo });
    await logAttemptEvent(trx, { tenantId, attemptId: attempt.id, eventType: 'proctor.warning_confirmed', actor: `USER:${actorUserId}`, metadata: { incidentId: incident.id, warningNo, epochNo: epoch.epoch_no } });
    await audit(trx, { tenantId, actorType: 'USER', actorId: actorUserId, action: 'proctor.warning_confirmed', entityType: 'proctor_incident', entityId: incident.id, metadata: { attemptId: attempt.id, warningNo, resulting } });
    return decisionResult(trx, attempt.id, decision.id);
  }

  const newStatus = input.action === 'DISMISS' ? 'DISMISSED' : input.action === 'MARK_TECHNICAL' ? 'TECHNICAL' : incident.status;
  const [decision] = await trx('proctor_decisions')
    .insert({ tenant_id: tenantId, attempt_id: attempt.id, incident_id: incident.id, actor_user_id: actorUserId, actor_type: 'HUMAN', action: input.action, reason_code: input.reasonCode, notes: input.notes ?? null, idempotency_key: input.idempotencyKey, resulting_attempt_status: attempt.status })
    .returning('id');
  if (newStatus !== incident.status) await trx('proctor_incidents').where('id', incident.id).update({ status: newStatus, updated_at: trx.fn.now() });
  await audit(trx, { tenantId, actorType: 'USER', actorId: actorUserId, action: `proctor.${input.action.toLowerCase()}`, entityType: 'proctor_incident', entityId: incident.id, metadata: { attemptId: attempt.id, reasonCode: input.reasonCode } });
  return decisionResult(trx, attempt.id, decision.id);
}

async function decisionResult(trx: Knex.Transaction, attemptId: string, decisionId: string) {
  const attempt = await trx('exam_attempts').where('id', attemptId).first('status', 'suspension_kind', 'authorization_generation', 'current_epoch_id');
  const epoch = attempt.current_epoch_id ? await trx('warning_epochs').where('id', attempt.current_epoch_id).first('epoch_no', 'confirmed_count', 'closed_at') : null;
  const lifetime = await trx('proctor_warnings').where('attempt_id', attemptId).count<{ count: string }[]>('id as count');
  return { decisionId, attemptStatus: attempt.status, suspensionKind: attempt.suspension_kind, authorizationGeneration: attempt.authorization_generation, epoch: epoch ? { no: epoch.epoch_no, confirmedCount: epoch.confirmed_count, open: !epoch.closed_at } : null, lifetimeWarnings: Number(lifetime[0]?.count ?? 0) };
}

async function notifyProctors(trx: Knex.Transaction, tenantId: string, attemptId: string, examTitle: string, reason: string) {
  const recipients = await trx('role_grants as g').join('users as u', 'u.id', 'g.user_id').where({ 'g.tenant_id': tenantId }).whereNull('g.revoked_at').whereIn('g.role_code', ['CHIEF_PROCTOR']).distinct('u.email', 'u.full_name');
  for (const r of recipients) {
    await enqueueMail(trx, { tenantId, category: 'SUSPENSION_ALERT', to: { address: r.email, name: r.full_name }, dedupeKey: `suspension:${attemptId}:${reason}:${r.email}`, vars: { attemptId, examTitle, reason, suspendedAtLocal: new Date().toISOString(), consoleUrl: '/proctor' } });
  }
}

/** Technical hold: blocks writes, preserves answers, never counts as a warning (spec §33). */
export async function technicalHold(deps: AppDeps, trx: Knex.Transaction, tenantId: string, actorUserId: string, attemptId: string, input: { reasonCode: string; notes?: string; idempotencyKey: string }) {
  const prior = await trx('proctor_decisions').where({ tenant_id: tenantId, idempotency_key: input.idempotencyKey }).first();
  if (prior) return decisionResult(trx, prior.attempt_id, prior.id);
  const attempt = await trx('exam_attempts').where({ tenant_id: tenantId, id: attemptId }).forNoKeyUpdate().first();
  if (!attempt) throw AppError.notFound('ATTEMPT_NOT_FOUND');
  if (!['ACTIVE', 'RECOVERY_PENDING'].includes(attempt.status)) throw AppError.conflict('ATTEMPT_STATE', `attempt is ${attempt.status}`);
  assertTransition('attempt', ATTEMPT_TRANSITIONS, attempt.status, 'SUSPENDED');
  await trx('exam_attempts').where('id', attemptId).update({ status: 'SUSPENDED', suspension_kind: 'TECHNICAL_HOLD', suspended_at: deps.clock.now(), authorization_generation: attempt.authorization_generation + 1, updated_at: trx.fn.now() });
  const [decision] = await trx('proctor_decisions').insert({ tenant_id: tenantId, attempt_id: attemptId, incident_id: null, actor_user_id: actorUserId, actor_type: 'HUMAN', action: 'ESCALATE', reason_code: input.reasonCode, notes: input.notes ?? null, idempotency_key: input.idempotencyKey, resulting_attempt_status: 'SUSPENDED' }).returning('id');
  await logAttemptEvent(trx, { tenantId, attemptId, eventType: 'attempt.technical_hold', actor: `USER:${actorUserId}`, metadata: { reasonCode: input.reasonCode } });
  await audit(trx, { tenantId, actorType: 'USER', actorId: actorUserId, action: 'attempt.technical_hold', entityType: 'exam_attempt', entityId: attemptId, metadata: { reasonCode: input.reasonCode } });
  return decisionResult(trx, attemptId, decision.id);
}

/**
 * Authorized resume (spec §18 "Resume"): closes the current epoch (history
 * retained), opens the next with count 0, sets ACTIVE and bumps the
 * authorization generation. A technical hold resume keeps the same epoch.
 */
export async function resumeAttempt(deps: AppDeps, trx: Knex.Transaction, tenantId: string, actorUserId: string, attemptId: string, input: { reasonCode: string; notes: string; idempotencyKey: string; deadlineExtensionMinutes: number; rebindDevice?: boolean }) {
  const prior = await trx('proctor_decisions').where({ tenant_id: tenantId, idempotency_key: input.idempotencyKey }).first();
  if (prior) return decisionResult(trx, prior.attempt_id, prior.id);
  const attempt = await trx('exam_attempts').where({ tenant_id: tenantId, id: attemptId }).forNoKeyUpdate().first();
  if (!attempt) throw AppError.notFound('ATTEMPT_NOT_FOUND');
  if (attempt.status !== 'SUSPENDED') throw AppError.conflict('ATTEMPT_STATE', `attempt is ${attempt.status}, not SUSPENDED`);
  const exam = await trx('exams').where('id', attempt.exam_id).first('status', 'window_end_at');
  if (exam.status !== 'LIVE') throw AppError.conflict('EXAM_NOT_LIVE', 'The exam is no longer live');
  assertTransition('attempt', ATTEMPT_TRANSITIONS, 'SUSPENDED', 'ACTIVE');

  const [decision] = await trx('proctor_decisions').insert({ tenant_id: tenantId, attempt_id: attemptId, incident_id: null, actor_user_id: actorUserId, actor_type: 'HUMAN', action: 'ESCALATE', reason_code: input.reasonCode, notes: input.notes, idempotency_key: input.idempotencyKey, resulting_attempt_status: 'ACTIVE' }).returning('id');
  let fromEpochId: string | null = attempt.current_epoch_id;
  let toEpochId: string | null = attempt.current_epoch_id;
  if (attempt.suspension_kind === 'WARNING_THRESHOLD') {
    const current = await trx('warning_epochs').where({ attempt_id: attemptId }).whereNull('closed_at').forUpdate().first();
    if (current) await trx('warning_epochs').where('id', current.id).update({ closed_at: trx.fn.now() });
    const [next] = await trx('warning_epochs').insert({ tenant_id: tenantId, attempt_id: attemptId, epoch_no: (current?.epoch_no ?? 0) + 1, opened_by: actorUserId, reason: input.reasonCode }).returning('id');
    fromEpochId = current?.id ?? null;
    toEpochId = next.id;
  }
  const newDeadline = input.deadlineExtensionMinutes > 0 && attempt.deadline_at ? new Date(Math.min(new Date(attempt.deadline_at).getTime() + input.deadlineExtensionMinutes * 60_000, new Date(exam.window_end_at).getTime())) : attempt.deadline_at;
  await trx('exam_attempts').where('id', attemptId).update({ status: 'ACTIVE', suspension_kind: null, suspended_at: null, current_epoch_id: toEpochId, deadline_at: newDeadline, authorization_generation: attempt.authorization_generation + 1, device_session_id: input.rebindDevice ? null : attempt.device_session_id, updated_at: trx.fn.now() });
  await trx('resume_grants').insert({ tenant_id: tenantId, attempt_id: attemptId, decision_id: decision.id, actor_user_id: actorUserId, from_epoch_id: fromEpochId, to_epoch_id: toEpochId, reason_code: input.reasonCode, notes: input.notes, deadline_extension_minutes: input.deadlineExtensionMinutes });
  await logAttemptEvent(trx, { tenantId, attemptId, eventType: 'attempt.resumed', actor: `USER:${actorUserId}`, metadata: { reasonCode: input.reasonCode, fromEpochId, toEpochId, deadlineExtensionMinutes: input.deadlineExtensionMinutes } });
  await audit(trx, { tenantId, actorType: 'USER', actorId: actorUserId, action: 'attempt.resumed', entityType: 'exam_attempt', entityId: attemptId, metadata: { reasonCode: input.reasonCode, deadlineExtensionMinutes: input.deadlineExtensionMinutes } });
  return decisionResult(trx, attemptId, decision.id);
}

export async function attemptTimeline(trx: Knex.Transaction, tenantId: string, attemptId: string) {
  const attempt = await trx('exam_attempts').where({ tenant_id: tenantId, id: attemptId }).first();
  if (!attempt) throw AppError.notFound('ATTEMPT_NOT_FOUND');
  const events = await trx('attempt_event_log').where({ attempt_id: attemptId }).orderBy('seq');
  const warnings = await trx('proctor_warnings as w').join('warning_epochs as e', 'e.id', 'w.warning_epoch_id').where('w.attempt_id', attemptId).select('w.*', 'e.epoch_no').orderBy('w.created_at');
  const epochs = await trx('warning_epochs').where({ attempt_id: attemptId }).orderBy('epoch_no');
  return { attempt, events, warnings, epochs };
}
