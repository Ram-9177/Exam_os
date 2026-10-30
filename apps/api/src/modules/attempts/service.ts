import { withTenantTx, type Knex } from '@examos/db';
import { randomUUID } from 'node:crypto';
import { DEVICE_SCAN_FINDINGS, DEVICE_SCAN_SIGNAL, type DeviceScanFinding } from '@examos/contracts';
import type { ClientNet } from '../../lib/client-net.js';
import { observeNetwork } from './network.js';
import {
  ATTEMPT_TRANSITIONS,
  assertTransition,
  MANDATORY_CHECKS_BY_PROFILE,
  SECURITY_REQUIRED_CHECKS,
  SEALED_ATTEMPT_STATUSES,
  type AttemptStatus,
  type AnswerSave,
  type PrecheckCheckCode,
  type SecurityProfile,
} from '@examos/contracts';
import type { AppDeps } from '../../types.js';
import { AppError } from '../../lib/errors.js';
import { canonicalJson, randomToken, sha256Hex } from '../../lib/crypto.js';
import { audit, logAttemptEvent } from '../../lib/audit.js';
import { enqueueMail } from '../notifications/service.js';
import { recordIntegrationEvent } from '../integration/events.js';
import { instructionFor } from './instructions.js';
import { erpIdentity } from '../../lib/identity.js';
import { isIpInSubnets } from '../seb/service.js';
import { recordDeviceScan } from './device-scan.js';
import type { DeviceScan } from '@examos/contracts';

const PRECHECK_READY_MINUTES = 45;
const CLOCK_TOLERANCE_MS = 120_000;
const HEARTBEAT_GRACE_SECONDS = 90;

// ---------------------------------------------------------------------------
// Student exam list
// ---------------------------------------------------------------------------
export async function listMyExams(trx: Knex.Transaction, tenantId: string, userId: string) {
  return trx('exam_allocations as a')
    .join('exams as e', 'e.id', 'a.exam_id')
    .leftJoin('courses as c', 'c.id', 'e.course_id')
    .leftJoin('exam_attempts as at', function () {
      this.on('at.exam_id', '=', 'a.exam_id').andOn('at.user_id', '=', 'a.user_id');
    })
    .leftJoin('hall_tickets as h', function () {
      this.on('h.exam_id', '=', 'a.exam_id').andOn('h.user_id', '=', 'a.user_id');
    })
    .leftJoin('student_profiles as sp', 'sp.user_id', 'a.user_id')
    .where({ 'a.tenant_id': tenantId, 'a.user_id': userId, 'a.status': 'ALLOCATED' })
    .whereIn('e.status', ['SCHEDULED', 'PRECHECK', 'LIVE', 'CLOSED', 'ARCHIVED'])
    .select(
      'sp.register_number as registerNumber',
      'e.id as examId',
      'e.code',
      'e.title',
      'e.exam_type as examType',
      'e.academic_year as academicYear',
      'e.semester',
      'e.status as examStatus',
      'e.security_profile as securityProfile',
      'e.duration_minutes as durationMinutes',
      'e.window_start_at as windowStartAt',
      'e.window_end_at as windowEndAt',
      'c.code as courseCode',
      'c.name as courseName',
      'a.extra_time_minutes as extraTimeMinutes',
      'at.id as attemptId',
      'at.status as attemptStatus',
      'at.deadline_at as deadlineAt',
      'h.number as hallTicketNumber',
      'h.verification_hash as hallTicketVerification',
    )
    .orderBy('e.window_start_at', 'desc');
}

// ---------------------------------------------------------------------------
// Preflight (15-minute readiness check)
// ---------------------------------------------------------------------------
export async function attemptPolicy(trx: Knex.Transaction, tenantId: string, userId: string, attemptId: string) {
  const attempt = await trx('exam_attempts').where({ tenant_id: tenantId, id: attemptId }).first();
  if (!attempt || attempt.user_id !== userId) throw AppError.notFound('ATTEMPT_NOT_FOUND');
  const exam = await trx('exams').where({ tenant_id: tenantId, id: attempt.exam_id }).first();
  const profile = exam.security_profile as SecurityProfile;
  const policy = (exam.policy ?? {}) as Record<string, unknown>;
  const mandatory = MANDATORY_CHECKS_BY_PROFILE[profile];
  const consentPurposes = requiredConsents(profile, policy);
  const all: PrecheckCheckCode[] = ['IDENTITY_SESSION', 'ELIGIBILITY', 'CLIENT_VERSION', 'CLOCK_SYNC', 'NETWORK_SAVE_ROUNDTRIP', 'KEYBOARD_INPUT', 'CANVAS_INPUT', 'SYSTEM_SCAN', ...(consentPurposes.includes('CAMERA') ? (['CAMERA'] as PrecheckCheckCode[]) : []), ...(consentPurposes.includes('MICROPHONE') ? (['MICROPHONE'] as PrecheckCheckCode[]) : []), ...(consentPurposes.length ? (['CONSENT'] as PrecheckCheckCode[]) : [])];
  return {
    attemptId,
    attemptStatus: attempt.status,
    examId: exam.id,
    examTitle: exam.title,
    examStatus: exam.status,
    securityProfile: profile,
    policyVersion: exam.policy_version,
    durationMinutes: exam.duration_minutes,
    windowStartAt: new Date(exam.window_start_at).toISOString(),
    windowEndAt: new Date(exam.window_end_at).toISOString(),
    consentPurposes,
    checks: all.map((code) => ({ code, mandatory: mandatory.includes(code), serverMeasured: (['IDENTITY_SESSION', 'ELIGIBILITY'] as string[]).includes(code), optional: code === 'CANVAS_INPUT', securityRelevant: SECURITY_REQUIRED_CHECKS.includes(code) })),
    allowedClientBuilds: Array.isArray(policy['allowedClientBuilds']) ? (policy['allowedClientBuilds'] as string[]) : [],
    monitoringNotice: typeof policy['monitoringNotice'] === 'string' ? (policy['monitoringNotice'] as string) : 'This examination records permitted device signals and, where your exam profile requires it, camera and microphone, only for the purposes described in the examination policy. Technical problems are never treated as misconduct.',
  };
}

async function lockAttemptForUser(trx: Knex.Transaction, tenantId: string, attemptId: string, userId: string) {
  const attempt = await trx('exam_attempts').where({ tenant_id: tenantId, id: attemptId }).forNoKeyUpdate().first();
  if (!attempt || attempt.user_id !== userId) throw AppError.notFound('ATTEMPT_NOT_FOUND');
  const exam = await trx('exams').where({ tenant_id: tenantId, id: attempt.exam_id }).first();
  if (!exam) throw AppError.notFound('EXAM_NOT_FOUND');
  return { attempt, exam };
}

export async function startPrecheck(deps: AppDeps, trx: Knex.Transaction, tenantId: string, userId: string, attemptId: string, clientBuild: string | null, net?: ClientNet): Promise<{ runId: string; checks: unknown[] }> {
  const { attempt, exam } = await lockAttemptForUser(trx, tenantId, attemptId, userId);
  if (net) await observeNetwork(deps, trx, tenantId, attempt, net, 'PRECHECK');
  if (!['PRECHECK', 'LIVE'].includes(exam.status)) throw AppError.conflict('PRECHECK_NOT_OPEN', 'The readiness check has not been opened by the Examination Section yet');
  const from = attempt.status as AttemptStatus;
  if (!['PRECHECK_AVAILABLE', 'PRECHECK_RUNNING', 'READY'].includes(from)) throw AppError.conflict('ATTEMPT_STATE', `Readiness check cannot run while the attempt is ${from}`);
  if (from !== 'PRECHECK_RUNNING') {
    assertTransition('attempt', ATTEMPT_TRANSITIONS, from, 'PRECHECK_RUNNING');
    await trx('exam_attempts').where('id', attemptId).update({ status: 'PRECHECK_RUNNING', updated_at: trx.fn.now() });
  }
  await trx('precheck_runs').where({ attempt_id: attemptId, status: 'RUNNING' }).update({ status: 'EXPIRED', ended_at: trx.fn.now() });
  const [run] = await trx('precheck_runs')
    .insert({ tenant_id: tenantId, attempt_id: attemptId, exam_id: exam.id, user_id: userId, security_profile: exam.security_profile, client_build: clientBuild, policy_version: exam.policy_version })
    .returning('id');
  const runId = run.id as string;

  // Server-measured checks recorded immediately (spec §33: never trust a client "PASS").
  await recordItem(trx, tenantId, runId, 'IDENTITY_SESSION', 'PASS', 'SERVER', null, null, { userId });
  const allocation = await trx('exam_allocations').where({ tenant_id: tenantId, exam_id: exam.id, user_id: userId, status: 'ALLOCATED' }).first('id');
  const enrolled = exam.course_id ? await trx('course_enrollments').where({ tenant_id: tenantId, user_id: userId, course_id: exam.course_id, eligibility_status: 'ELIGIBLE' }).first('id') : { id: 'n/a' };
  await recordItem(trx, tenantId, runId, 'ELIGIBILITY', allocation && enrolled ? 'PASS' : 'REMEDIATE', 'SERVER', allocation && enrolled ? null : 'NOT_ELIGIBLE', allocation && enrolled ? null : 'CONTACT_EXAM_SECTION', {});
  const required = requiredConsents(exam.security_profile, exam.policy);
  if (required.length) {
    const consents = await trx('consent_records').where({ tenant_id: tenantId, user_id: userId }).whereNull('withdrawn_at').andWhere((qb) => qb.where('exam_id', exam.id).orWhereNull('exam_id')).where('policy_version', exam.policy_version).select('purpose');
    const have = new Set(consents.map((c) => c.purpose));
    const missing = required.filter((p) => !have.has(p));
    await recordItem(trx, tenantId, runId, 'CONSENT', missing.length ? 'REMEDIATE' : 'PASS', 'SERVER', missing.length ? 'CONSENT_REQUIRED' : null, missing.length ? 'ACCEPT_MONITORING_NOTICE' : null, { missing });
  }
  await logAttemptEvent(trx, { tenantId, attemptId, eventType: 'precheck.started', actor: `USER:${userId}`, metadata: { runId, clientBuild } });
  return { runId, checks: await listItems(trx, runId) };
}

function requiredConsents(profile: SecurityProfile, policy: Record<string, unknown>): string[] {
  const out: string[] = [];
  const capture = (policy['capture'] ?? {}) as Record<string, unknown>;
  const highTier = profile === 'SECURE_BYOD' || profile === 'MANAGED_ENDPOINT';
  const needsCamera = typeof capture['webcam_required_for_this_tier'] === 'boolean' ? (capture['webcam_required_for_this_tier'] as boolean) : highTier;
  const needsMic = typeof capture['mic_required_for_this_tier'] === 'boolean' ? (capture['mic_required_for_this_tier'] as boolean) : highTier;
  if (needsCamera) out.push('CAMERA');
  if (needsMic) out.push('MICROPHONE');
  return out;
}

async function recordItem(trx: Knex.Transaction, tenantId: string, runId: string, code: PrecheckCheckCode, status: string, source: string, diagnostic: string | null, remediation: string | null, measured: Record<string, unknown>): Promise<void> {
  const last = await trx('precheck_items').where({ precheck_run_id: runId, check_code: code }).max('iteration as max').first();
  const iteration = Number(last?.max ?? 0) + 1;
  await trx('precheck_items').insert({ tenant_id: tenantId, precheck_run_id: runId, check_code: code, iteration, status, source, diagnostic_code: diagnostic, remediation_code: remediation, measured: JSON.stringify(measured) });
}

async function listItems(trx: Knex.Transaction, runId: string) {
  const rows = await trx('precheck_items').where({ precheck_run_id: runId }).orderBy([{ column: 'check_code' }, { column: 'iteration', order: 'desc' }]);
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!latest.has(r.check_code)) latest.set(r.check_code, r);
  return [...latest.values()].map((r) => ({ code: r.check_code, status: r.status, source: r.source, diagnosticCode: r.diagnostic_code, remediationCode: r.remediation_code, instruction: instructionFor(r.check_code, r.status, r.remediation_code), optional: r.check_code === 'CANVAS_INPUT' }));
}

export interface VerifyEvidence {
  code: PrecheckCheckCode;
  clientBuild?: string;
  clientClockMs?: number;
  keyboardSample?: string;
  canvasOps?: number;
  consentPolicyVersion?: string;
  /** Safe Exam Browser request headers, when present */
  sebConfigKeyHash?: string;
  sebBrowserExamKeyHash?: string;
  requestUrl?: string;
  clientIp?: string;
  userAgent?: string;
  /** SYSTEM_SCAN raw scan; findings are derived by the server. */
  scan?: DeviceScan;
}

/**
 * Verifies one readiness item. The server decides the status from evidence it
 * can measure; client-declared media checks are only acceptable on low-tier
 * profiles and are always stored with their source (spec §33, §49).
 */
export async function verifyItem(deps: AppDeps, trx: Knex.Transaction, tenantId: string, userId: string, runId: string, ev: VerifyEvidence) {
  const run = await trx('precheck_runs').where({ tenant_id: tenantId, id: runId }).first();
  if (!run || run.user_id !== userId) throw AppError.notFound('PRECHECK_NOT_FOUND');
  if (run.status !== 'RUNNING') throw AppError.conflict('PRECHECK_FINALIZED', 'Start a new readiness check');
  const exam = await trx('exams').where({ id: run.exam_id }).first();
  const profile = exam.security_profile as SecurityProfile;
  const policy = (exam.policy ?? {}) as Record<string, unknown>;
  const lowTier = profile === 'PRACTICE' || profile === 'BASIC_BROWSER';
  const now = deps.clock.now();

  switch (ev.code) {
    case 'CLIENT_VERSION': {
      if (lowTier) {
        await recordItem(trx, tenantId, runId, ev.code, 'PASS', 'SERVER', null, null, { profile, clientBuild: ev.clientBuild ?? null });
        break;
      }
      if (profile === 'MANAGED_ENDPOINT' || policy['requireManagedEndpoint']) {
        const allowedSubnets = Array.isArray(policy['allowedSubnets']) ? (policy['allowedSubnets'] as string[]) : [];
        const clientIp = ev.clientIp ?? '';
        const ok = allowedSubnets.length > 0 && isIpInSubnets(clientIp, allowedSubnets);
        await recordItem(
          trx,
          tenantId,
          runId,
          ev.code,
          ok ? 'PASS' : 'REMEDIATE',
          ok ? 'SECURE_CLIENT' : 'SERVER',
          ok ? null : 'MANAGED_ENDPOINT_REQUIRED',
          ok ? null : 'CONNECT_FROM_LAB_NETWORK',
          { clientIp, allowedSubnetsCount: allowedSubnets.length }
        );
        break;
      }
      const sebConfigKey = typeof policy['sebConfigKey'] === 'string' ? (policy['sebConfigKey'] as string) : null;
      const allowedBuilds = Array.isArray(policy['allowedClientBuilds']) ? (policy['allowedClientBuilds'] as string[]) : [];
      if (sebConfigKey) {
        // Safe Exam Browser: X-SafeExamBrowser-ConfigKeyHash = SHA256(absolute request URL + Config Key)
        const expected = ev.requestUrl ? sha256Hex(`${ev.requestUrl}${sebConfigKey}`) : null;
        const ok = !!expected && !!ev.sebConfigKeyHash && expected.toLowerCase() === ev.sebConfigKeyHash.toLowerCase();
        await recordItem(trx, tenantId, runId, ev.code, ok ? 'PASS' : 'REMEDIATE', ok ? 'SECURE_CLIENT' : 'SERVER', ok ? null : 'SEB_CONFIG_KEY_MISMATCH', ok ? null : 'OPEN_IN_SECURE_CLIENT', { hasHeader: !!ev.sebConfigKeyHash });
        break;
      }
      if (allowedBuilds.length) {
        const ok = !!ev.clientBuild && allowedBuilds.includes(ev.clientBuild);
        await recordItem(trx, tenantId, runId, ev.code, ok ? 'PASS' : 'REMEDIATE', 'CLIENT_DECLARED', ok ? null : 'CLIENT_BUILD_NOT_ALLOWED', ok ? null : 'INSTALL_APPROVED_CLIENT', { clientBuild: ev.clientBuild ?? null, allowedBuilds });
        break;
      }
      await recordItem(trx, tenantId, runId, ev.code, 'UNVERIFIABLE', 'SERVER', 'NO_CLIENT_POLICY', null, { profile });
      break;
    }
    case 'CLOCK_SYNC': {
      if (typeof ev.clientClockMs !== 'number') throw AppError.badRequest('EVIDENCE_REQUIRED', 'clientClockMs is required');
      const skew = Math.abs(now.getTime() - ev.clientClockMs);
      const ok = skew <= CLOCK_TOLERANCE_MS;
      await recordItem(trx, tenantId, runId, ev.code, ok ? 'PASS' : 'REMEDIATE', 'SERVER', ok ? null : 'CLOCK_SKEW', ok ? null : 'ENABLE_AUTOMATIC_TIME', { skewMs: skew });
      break;
    }
    case 'NETWORK_SAVE_ROUNDTRIP': {
      const saves = await trx('precheck_practice_saves').where({ precheck_run_id: runId }).count('id as count').first();
      const n = Number(saves?.count ?? 0);
      const ok = n >= 1;
      await recordItem(trx, tenantId, runId, ev.code, ok ? 'PASS' : 'REMEDIATE', 'SERVER', ok ? null : 'NO_PRACTICE_SAVE_ACKNOWLEDGED', ok ? null : 'RETRY_PRACTICE_SAVE', { practiceSaves: n });
      break;
    }
    case 'KEYBOARD_INPUT': {
      const s = ev.keyboardSample ?? '';
      // Functional test only: letters, digits, punctuation and a correction key. No WPM, ever (spec §29).
      const ok = /[a-zA-Z]/.test(s) && /\d/.test(s) && /[.,;:!?()-]/.test(s) && s.length >= 20;
      await recordItem(trx, tenantId, runId, ev.code, ok ? 'PASS' : 'REMEDIATE', 'PRACTICE', ok ? null : 'SAMPLE_INCOMPLETE', ok ? null : 'TYPE_FULL_SAMPLE', { length: s.length });
      break;
    }
    case 'CANVAS_INPUT': {
      // Optional: stylus and drawing tablets are never required (second brief). Mouse/trackpad is enough.
      const ops = ev.canvasOps ?? 0;
      await recordItem(trx, tenantId, runId, ev.code, ops >= 3 ? 'PASS' : 'REMEDIATE', 'PRACTICE', ops >= 3 ? null : 'DRAW_THREE_SHAPES', ops >= 3 ? null : 'USE_MOUSE_OR_STYLUS', { ops });
      break;
    }
    case 'CAMERA':
    case 'MICROPHONE': {
      const needed = requiredConsents(profile, policy).includes(ev.code);
      if (!needed) {
        await recordItem(trx, tenantId, runId, ev.code, 'PASS', 'SERVER', 'NOT_REQUIRED_FOR_PROFILE', null, {});
      } else if (lowTier) {
        await recordItem(trx, tenantId, runId, ev.code, 'PASS', 'CLIENT_DECLARED', null, null, {});
      } else {
        // Media verification (snapshot manifest, physical-source assessment) is the Gate C media pipeline; until then
        // the honest status is UNVERIFIABLE, which the Examination Section may cover with an exception.
        await recordItem(trx, tenantId, runId, ev.code, 'UNVERIFIABLE', 'CLIENT_DECLARED', 'MEDIA_PIPELINE_NOT_DEPLOYED', null, {});
      }
      break;
    }
    case 'CONSENT': {
      if (!ev.consentPolicyVersion || ev.consentPolicyVersion !== exam.policy_version) throw AppError.badRequest('EVIDENCE_REQUIRED', 'consentPolicyVersion must equal the exam policy version');
      for (const purpose of requiredConsents(profile, policy)) {
        await trx('consent_records').insert({ tenant_id: tenantId, user_id: userId, exam_id: exam.id, policy_version: exam.policy_version, purpose });
      }
      await recordItem(trx, tenantId, runId, ev.code, 'PASS', 'SERVER', null, null, { policyVersion: exam.policy_version });
      break;
    }
    case 'SYSTEM_SCAN': {
      if (!ev.scan) throw AppError.badRequest('EVIDENCE_REQUIRED', 'scan is required');
      const { scanId, findings, verdict } = await recordDeviceScan(trx, { tenantId, attemptId: run.attempt_id, precheckRunId: runId, phase: 'PRECHECK', scan: ev.scan, ip: ev.clientIp ?? null, userAgent: ev.userAgent ?? null });
      // A blocking setting must be fixed before admission. A clean or review-only scan is client-declared
      // context (it can be forged by hiding data), never a security PASS; review findings go to the readiness board.
      const blocking = verdict === 'BLOCKED';
      await recordItem(trx, tenantId, runId, ev.code, blocking ? 'REMEDIATE' : 'PASS', 'CLIENT_DECLARED', findings[0] ?? null, blocking ? 'FIX_DEVICE_SETTINGS' : null, { scanId, verdict, findings });
      break;
    }
    case 'IDENTITY_SESSION':
    case 'ELIGIBILITY':
      throw AppError.badRequest('SERVER_MEASURED', `${ev.code} is measured by the server and cannot be submitted`);
  }
  return listItems(trx, runId);
}

export async function practiceSave(trx: Knex.Transaction, tenantId: string, userId: string, runId: string, contentDigest: string): Promise<{ revision: number; ackAt: string }> {
  const run = await trx('precheck_runs').where({ tenant_id: tenantId, id: runId }).first();
  if (!run || run.user_id !== userId) throw AppError.notFound('PRECHECK_NOT_FOUND');
  if (run.status !== 'RUNNING') throw AppError.conflict('PRECHECK_FINALIZED', 'Start a new readiness check');
  const last = await trx('precheck_practice_saves').where({ precheck_run_id: runId }).max('revision as max').first();
  const revision = Number(last?.max ?? 0) + 1;
  const [row] = await trx('precheck_practice_saves').insert({ tenant_id: tenantId, precheck_run_id: runId, revision, content_digest: contentDigest }).returning('ack_at');
  return { revision, ackAt: new Date(row.ack_at).toISOString() };
}

export async function finalizePrecheck(deps: AppDeps, trx: Knex.Transaction, tenantId: string, userId: string, runId: string) {
  const run = await trx('precheck_runs').where({ tenant_id: tenantId, id: runId }).forUpdate().first();
  if (!run || run.user_id !== userId) throw AppError.notFound('PRECHECK_NOT_FOUND');
  if (run.status !== 'RUNNING') throw AppError.conflict('PRECHECK_FINALIZED', 'Start a new readiness check');
  const exam = await trx('exams').where({ id: run.exam_id }).first();
  const checks = await listItems(trx, runId);
  const byCode = new Map(checks.map((c) => [c.code, c]));
  const mandatory = MANDATORY_CHECKS_BY_PROFILE[exam.security_profile as SecurityProfile];
  const exceptions = await trx('admission_exceptions').where({ attempt_id: run.attempt_id }).whereNull('revoked_at').where('expires_at', '>', deps.clock.now());
  const covered = new Set(exceptions.flatMap((e) => e.covers_checks as string[]));

  const failing = mandatory.filter((code) => byCode.get(code)?.status !== 'PASS' && !covered.has(code));
  const remediate = failing.filter((code) => (byCode.get(code)?.status ?? 'PENDING') === 'REMEDIATE' || !byCode.has(code));
  let status: 'READY' | 'REMEDIATE' | 'REVIEW' = 'READY';
  if (remediate.length) status = 'REMEDIATE';
  else if (failing.length) status = 'REVIEW';

  const readyUntil = status === 'READY' ? new Date(deps.clock.now().getTime() + PRECHECK_READY_MINUTES * 60_000) : null;
  await trx('precheck_runs').where('id', runId).update({ status, ready_until: readyUntil, ended_at: trx.fn.now() });
  const attempt = await trx('exam_attempts').where('id', run.attempt_id).forNoKeyUpdate().first();
  if (status === 'READY' && attempt.status === 'PRECHECK_RUNNING') {
    assertTransition('attempt', ATTEMPT_TRANSITIONS, 'PRECHECK_RUNNING', 'READY');
    await trx('exam_attempts').where('id', attempt.id).update({ status: 'READY', updated_at: trx.fn.now() });
  }
  await logAttemptEvent(trx, { tenantId, attemptId: run.attempt_id, eventType: 'precheck.finalized', actor: `USER:${userId}`, metadata: { runId, status, failing } });
  return {
    precheckId: runId,
    status,
    securityProfile: exam.security_profile,
    checks: checks.map((c) => ({ ...c, mandatory: mandatory.includes(c.code as PrecheckCheckCode), coveredByException: covered.has(c.code), securityRelevant: SECURITY_REQUIRED_CHECKS.includes(c.code as PrecheckCheckCode) })),
    examTimerStarted: false,
    readyUntil: readyUntil?.toISOString() ?? null,
    helpAction: status === 'READY' ? null : status === 'REMEDIATE' ? 'FIX_AND_RETRY' : 'CONTACT_EXAM_SECTION',
  };
}

// ---------------------------------------------------------------------------
// Entry grant + admission (one-time, atomic)
// ---------------------------------------------------------------------------
export async function issueEntryGrant(deps: AppDeps, trx: Knex.Transaction, tenantId: string, userId: string, attemptId: string): Promise<{ grantToken: string; expiresAt: string }> {
  const { attempt, exam } = await lockAttemptForUser(trx, tenantId, attemptId, userId);
  if (exam.status === 'PRECHECK') throw AppError.conflict('EXAM_NOT_STARTED', 'Waiting for the Examination Section to start the exam');
  if (exam.status !== 'LIVE') throw AppError.conflict('EXAM_NOT_LIVE', `The exam is ${exam.status}`);
  if (attempt.status !== 'READY') throw AppError.conflict('NOT_READY', `Readiness check must be READY (attempt is ${attempt.status})`);
  const run = await trx('precheck_runs').where({ attempt_id: attemptId, status: 'READY' }).orderBy('started_at', 'desc').first();
  if (!run || !run.ready_until || new Date(run.ready_until) < deps.clock.now()) throw AppError.conflict('PRECHECK_STALE', 'Readiness expired; run the check again');
  if (run.policy_version !== exam.policy_version) throw AppError.conflict('POLICY_CHANGED', 'Exam policy changed since the readiness check; run it again');
  const exception = await trx('admission_exceptions').where({ attempt_id: attemptId }).whereNull('revoked_at').where('expires_at', '>', deps.clock.now()).orderBy('created_at', 'desc').first('id');
  const token = randomToken(32);
  const expiresAt = new Date(deps.clock.now().getTime() + deps.config.ADMISSION_GRANT_TTL_SECONDS * 1000);
  await trx('admission_grants').insert({ tenant_id: tenantId, attempt_id: attemptId, precheck_run_id: run.id, exception_id: exception?.id ?? null, jti_hash: sha256Hex(token), policy_version: exam.policy_version, expires_at: expiresAt });
  await logAttemptEvent(trx, { tenantId, attemptId, eventType: 'entry_grant.issued', actor: `USER:${userId}`, metadata: { precheckRunId: run.id, exceptionId: exception?.id ?? null } });
  return { grantToken: token, expiresAt: expiresAt.toISOString() };
}

/**
 * Admission consumes the one-time grant and activates the attempt in a single
 * transaction (spec §33 "Admission"). Two concurrent calls cannot both succeed:
 * the UPDATE ... WHERE consumed_at IS NULL RETURNING is the arbiter, and the
 * attempt row is locked first so the state check and the update are serialized.
 */
export async function admit(deps: AppDeps, trx: Knex.Transaction, tenantId: string, userId: string, attemptId: string, grantToken: string, net?: ClientNet) {
  const { attempt, exam } = await lockAttemptForUser(trx, tenantId, attemptId, userId);
  if (exam.status !== 'LIVE') throw AppError.conflict('EXAM_NOT_LIVE', `The exam is ${exam.status}`);
  if (attempt.status === 'ACTIVE') {
    // idempotent re-entry with the same (already consumed) grant is not allowed; the client must use reconnect
    throw AppError.conflict('ALREADY_ACTIVE', 'Attempt is already active; use reconnect');
  }
  if (attempt.status !== 'READY') throw AppError.conflict('NOT_READY', `attempt is ${attempt.status}`);
  const consumed = await trx('admission_grants')
    .where({ tenant_id: tenantId, attempt_id: attemptId, jti_hash: sha256Hex(grantToken) })
    .whereNull('consumed_at')
    .whereNull('revoked_at')
    .where('expires_at', '>', deps.clock.now())
    .update({ consumed_at: trx.fn.now() })
    .returning('id');
  if (!consumed.length) throw AppError.unauthorized('GRANT_INVALID', 'Entry grant is invalid, expired or already used');

  assertTransition('attempt', ATTEMPT_TRANSITIONS, 'READY', 'ADMITTED');
  assertTransition('attempt', ATTEMPT_TRANSITIONS, 'ADMITTED', 'ACTIVE');
  const allocation = await trx('exam_allocations').where({ tenant_id: tenantId, exam_id: exam.id, user_id: userId }).first('extra_time_minutes');
  const now = deps.clock.now();
  const deadline = new Date(Math.min(now.getTime() + (exam.duration_minutes + (allocation?.extra_time_minutes ?? 0)) * 60_000, new Date(exam.window_end_at).getTime()));
  const [epoch] = await trx('warning_epochs').insert({ tenant_id: tenantId, attempt_id: attemptId, epoch_no: 1, reason: 'admission' }).returning('id');
  const deviceSessionId = randomUUID();
  await trx('exam_attempts').where('id', attemptId).update({
    status: 'ACTIVE',
    admitted_at: now,
    started_at: now,
    deadline_at: deadline,
    current_epoch_id: epoch.id,
    device_session_id: deviceSessionId,
    authorization_generation: attempt.authorization_generation + 1,
    // The admitted address is the reference for the exam's ipPolicy (LOCK binds writes to it).
    admitted_ip: net?.ip ?? null,
    admitted_user_agent: net?.userAgent ?? null,
    updated_at: trx.fn.now(),
  });
  if (net) await observeNetwork(deps, trx, tenantId, { ...attempt, status: 'ACTIVE', admitted_ip: net.ip }, net, 'ADMISSION');
  await logAttemptEvent(trx, { tenantId, attemptId, eventType: 'attempt.admitted', actor: `USER:${userId}`, metadata: { deadline: deadline.toISOString(), grantId: consumed[0].id } });
  await audit(trx, { tenantId, actorType: 'USER', actorId: userId, action: 'attempt.admitted', entityType: 'exam_attempt', entityId: attemptId });
  const user = await trx('users').where('id', userId).first('email', 'full_name');
  const tenant = await trx('tenants').where('id', tenantId).first('timezone');
  await enqueueMail(trx, {
    tenantId,
    category: 'ADMISSION_RECEIPT',
    to: { address: user.email, name: user.full_name },
    dedupeKey: `admission:${attemptId}`,
    vars: { fullName: user.full_name, examTitle: exam.title, admittedAtLocal: now.toLocaleString('en-IN', { timeZone: tenant?.timezone ?? 'Asia/Kolkata' }), receiptId: consumed[0].id },
  });
  const ident = await erpIdentity(trx, tenantId, userId);
  await recordIntegrationEvent(trx, { tenantId, type: 'attempt.admitted', aggregateType: 'exam_attempt', aggregateId: attemptId, data: { attemptId, examId: exam.id, examCode: exam.code, studentExternalId: ident?.external_id ?? null, admittedAt: now.toISOString(), deadlineAt: deadline.toISOString() } });
  return { attemptId, status: 'ACTIVE', serverNow: now.toISOString(), deadlineAt: deadline.toISOString(), authorizationGeneration: attempt.authorization_generation + 1, warningEpochId: epoch.id, deviceSessionId };
}

// ---------------------------------------------------------------------------
// Device-session binding: the exam is open on exactly one client per attempt.
// A second client is a server-observed CONCURRENT_SESSION incident (priority
// 90, human-confirmed), never an automatic warning; the write is refused.
// ---------------------------------------------------------------------------
export async function assertDeviceSession(deps: AppDeps, trx: Knex.Transaction, tenantId: string, attempt: { id: string; device_session_id: string | null }, presented: string | null): Promise<void> {
  if (!attempt.device_session_id) return; // unbound (after a proctor rebind) — reconnect binds it
  if (presented && presented === attempt.device_session_id) return;
  const { ingestEvents } = await import('../proctoring/service.js');
  const bucket = Math.floor(deps.clock.now().getTime() / 60_000);
  // Recorded in its own transaction so the evidence survives the rollback of the refused write.
  await withTenantTx(deps.db, tenantId, (evTrx) =>
    ingestEvents(deps, evTrx, tenantId, 'SERVER', [{ sourceEventId: `concurrent:${attempt.id}:${bucket}`, attemptId: attempt.id, signalClass: 'CONCURRENT_SESSION', metadata: { presentedDeviceSession: presented ? 'other' : 'none' } }]),
  );
  void trx;
  throw AppError.conflict('DEVICE_SESSION_MISMATCH', 'This exam is open on another device. If you changed devices, ask the invigilator to re-admit you.');
}

// ---------------------------------------------------------------------------
// Answers: versioned, idempotent, conflict-detecting
// ---------------------------------------------------------------------------
interface Block {
  id: string;
  kind: string;
  content: unknown;
}
interface AnswerContent {
  blocks: Block[];
}

export function applyOps(content: AnswerContent, ops: AnswerSave['ops']): AnswerContent {
  const blocks = [...content.blocks];
  for (const op of ops) {
    const idx = blocks.findIndex((b) => b.id === op.blockId);
    if (op.op === 'upsert-block') {
      const block: Block = { id: op.blockId, kind: op.kind ?? blocks[idx]?.kind ?? 'paragraph', content: op.content ?? null };
      if (idx >= 0) blocks[idx] = block;
      else blocks.push(block);
    } else if (op.op === 'delete-block') {
      if (idx >= 0) blocks.splice(idx, 1);
    } else if (op.op === 'reorder') {
      if (idx < 0) continue;
      const [b] = blocks.splice(idx, 1);
      if (op.after === null || op.after === undefined) blocks.unshift(b!);
      else {
        const after = blocks.findIndex((x) => x.id === op.after);
        blocks.splice(after < 0 ? blocks.length : after + 1, 0, b!);
      }
    }
  }
  return { blocks };
}

export function contentHash(content: AnswerContent): string {
  return sha256Hex(canonicalJson(content));
}

export async function saveAnswer(deps: AppDeps, trx: Knex.Transaction, tenantId: string, userId: string, attemptId: string, questionId: string, body: AnswerSave, deviceSession: string | null, net?: ClientNet) {
  const attempt = await trx('exam_attempts').where({ tenant_id: tenantId, id: attemptId }).forNoKeyUpdate().first();
  if (!attempt || attempt.user_id !== userId) throw AppError.notFound('ATTEMPT_NOT_FOUND');
  // Authority check inside the same transaction that locks the row (review §2 item 11).
  if (attempt.status !== 'ACTIVE') throw AppError.conflict('ATTEMPT_NOT_ACTIVE', `attempt is ${attempt.status}; writes are not accepted`);
  await assertDeviceSession(deps, trx, tenantId, attempt, deviceSession);
  if (net) await observeNetwork(deps, trx, tenantId, attempt, net, 'SAVE');
  const now = deps.clock.now();
  if (attempt.deadline_at && now > new Date(attempt.deadline_at)) throw AppError.conflict('DEADLINE_PASSED', 'The server deadline has passed');

  const dup = await trx('answer_revisions').where({ attempt_id: attemptId, question_id: questionId, client_operation_id: body.clientOperationId }).first();
  if (dup) {
    return { accepted: true as const, serverRevision: dup.revision, receiptId: dup.receipt_id, serverSavedAt: new Date(dup.server_saved_at).toISOString(), contentSha256: dup.content_sha256, duplicate: true };
  }
  let doc = await trx('answer_documents').where({ attempt_id: attemptId, question_id: questionId }).forUpdate().first();
  if (!doc) {
    const empty: AnswerContent = { blocks: [] };
    const [created] = await trx('answer_documents').insert({ tenant_id: tenantId, attempt_id: attemptId, question_id: questionId, current_revision: 0, content: JSON.stringify(empty), content_sha256: contentHash(empty) }).returning('*');
    doc = created;
  }
  if (doc.current_revision !== body.baseRevision) {
    throw new AppError(409, 'REVISION_CONFLICT', `Server revision is ${doc.current_revision}, client based on ${body.baseRevision}`, { retryable: false });
  }
  const next = applyOps(doc.content as AnswerContent, body.ops);
  const hash = contentHash(next);
  if (hash !== body.contentSha256) throw AppError.unprocessable('CONTENT_HASH_MISMATCH', 'Client and server documents differ after applying ops; resync from the server revision');
  const revision = doc.current_revision + 1;
  const [rev] = await trx('answer_revisions')
    .insert({ tenant_id: tenantId, attempt_id: attemptId, question_id: questionId, revision, client_operation_id: body.clientOperationId, ops: JSON.stringify(body.ops), content_sha256: hash })
    .returning(['receipt_id', 'server_saved_at']);
  await trx('answer_documents').where('id', doc.id).update({ current_revision: revision, content: JSON.stringify(next), content_sha256: hash, updated_at: trx.fn.now() });
  await logAttemptEvent(trx, { tenantId, attemptId, eventType: 'answer.revision_saved', actor: `USER:${userId}`, questionId, metadata: { revision, ops: body.ops.length, sha256: hash } });
  return { accepted: true as const, serverRevision: revision, receiptId: rev.receipt_id, serverSavedAt: new Date(rev.server_saved_at).toISOString(), contentSha256: hash, duplicate: false };
}

export async function getAnswer(trx: Knex.Transaction, tenantId: string, userId: string, attemptId: string, questionId: string) {
  const attempt = await trx('exam_attempts').where({ tenant_id: tenantId, id: attemptId }).first();
  if (!attempt || attempt.user_id !== userId) throw AppError.notFound('ATTEMPT_NOT_FOUND');
  const doc = await trx('answer_documents').where({ attempt_id: attemptId, question_id: questionId }).first();
  return doc ? { questionId, serverRevision: doc.current_revision, content: doc.content, contentSha256: doc.content_sha256 } : { questionId, serverRevision: 0, content: { blocks: [] }, contentSha256: contentHash({ blocks: [] }) };
}

export async function heartbeat(deps: AppDeps, trx: Knex.Transaction, tenantId: string, userId: string, attemptId: string, deviceSession: string | null, net: ClientNet | null) {
  const attempt = await trx('exam_attempts').where({ tenant_id: tenantId, id: attemptId }).first();
  if (!attempt || attempt.user_id !== userId) throw AppError.notFound('ATTEMPT_NOT_FOUND');
  if (attempt.status === 'ACTIVE') await assertDeviceSession(deps, trx, tenantId, attempt, deviceSession);
  // Network changes (Wi-Fi switch, hotspot, IPv6 flip) are durable transport context; the exam's ipPolicy decides
  // whether a human is asked to look (REVIEW) or the write is held to the admitted address (LOCK). Never a warning (spec §28).
  if (net) await observeNetwork(deps, trx, tenantId, attempt, net, 'HEARTBEAT');
  await deps.redis.set(`attempt:heartbeat:${attemptId}`, String(deps.clock.now().getTime()), 'EX', HEARTBEAT_GRACE_SECONDS * 4);
  return { status: attempt.status, serverNow: deps.clock.now().toISOString(), deadlineAt: attempt.deadline_at ? new Date(attempt.deadline_at).toISOString() : null, authorizationGeneration: attempt.authorization_generation };
}

/** A reconnect after RECOVERY_PENDING returns to ACTIVE; it never creates a new attempt or extra time (spec §6). */
export async function reconnect(deps: AppDeps, trx: Knex.Transaction, tenantId: string, userId: string, attemptId: string, deviceSession: string | null, net?: ClientNet) {
  const { attempt, exam } = await lockAttemptForUser(trx, tenantId, attemptId, userId);
  if (exam.status !== 'LIVE') throw AppError.conflict('EXAM_NOT_LIVE', 'The exam is not live');
  if (!['ACTIVE', 'RECOVERY_PENDING'].includes(attempt.status)) throw AppError.conflict('ATTEMPT_STATE', `attempt is ${attempt.status}`);
  if (deps.clock.now() > new Date(attempt.deadline_at)) throw AppError.conflict('DEADLINE_PASSED', 'The server deadline has passed');
  let boundDevice = attempt.device_session_id as string | null;
  if (!boundDevice) {
    // proctor re-admitted the student on a replacement device: the first reconnect binds it
    boundDevice = deviceSession ?? randomUUID();
    await trx('exam_attempts').where('id', attemptId).update({ device_session_id: boundDevice, updated_at: trx.fn.now() });
    await logAttemptEvent(trx, { tenantId, attemptId, eventType: 'device.rebound', actor: `USER:${userId}` });
  } else {
    await assertDeviceSession(deps, trx, tenantId, attempt, deviceSession);
  }
  if (net) {
    if (!attempt.admitted_ip && net.ip) {
      // A proctor resume with rebind cleared the admitted address: this connection becomes the reference.
      await trx('exam_attempts').where('id', attemptId).update({ admitted_ip: net.ip, admitted_user_agent: net.userAgent, updated_at: trx.fn.now() });
      await logAttemptEvent(trx, { tenantId, attemptId, eventType: 'network.rebound', actor: `USER:${userId}`, metadata: { ip: net.ip } });
      attempt.admitted_ip = net.ip;
    }
    await observeNetwork(deps, trx, tenantId, attempt, net, 'RECONNECT');
  }
  if (attempt.status === 'RECOVERY_PENDING') {
    assertTransition('attempt', ATTEMPT_TRANSITIONS, 'RECOVERY_PENDING', 'ACTIVE');
    await trx('exam_attempts').where('id', attemptId).update({ status: 'ACTIVE', updated_at: trx.fn.now() });
    await logAttemptEvent(trx, { tenantId, attemptId, eventType: 'attempt.reconnected', actor: `USER:${userId}` });
  }
  const docs = await trx('answer_documents').where({ attempt_id: attemptId }).select('question_id', 'current_revision', 'content_sha256');
  return { status: 'ACTIVE', deadlineAt: new Date(attempt.deadline_at).toISOString(), deviceSessionId: boundDevice, serverNow: deps.clock.now().toISOString(), answers: docs.map((d) => ({ questionId: d.question_id, serverRevision: d.current_revision, contentSha256: d.content_sha256 })) };
}

/**
 * Periodic in-exam system scan. The server derives the findings and keeps the
 * raw scan as append-only evidence; a blocking finding raises the mapped
 * proctor signal for a named human to decide on — the attempt is never
 * paused or penalised automatically. The student is told what to fix.
 */
export async function reportInExamScan(deps: AppDeps, trx: Knex.Transaction, tenantId: string, userId: string, attemptId: string, scan: DeviceScan, net: ClientNet | null) {
  const attempt = await trx('exam_attempts').where({ tenant_id: tenantId, id: attemptId }).first();
  if (!attempt || attempt.user_id !== userId) throw AppError.notFound('ATTEMPT_NOT_FOUND');
  if (!['ACTIVE', 'RECOVERY_PENDING', 'SUSPENDED'].includes(attempt.status)) throw AppError.conflict('ATTEMPT_STATE', `attempt is ${attempt.status}`);
  const { scanId, findings, verdict } = await recordDeviceScan(trx, { tenantId, attemptId, precheckRunId: null, phase: 'IN_EXAM', scan, ip: net?.ip ?? null, userAgent: net?.userAgent ?? null });
  const blocking = findings.filter((f: DeviceScanFinding) => DEVICE_SCAN_FINDINGS[f] === 'BLOCKING' && DEVICE_SCAN_SIGNAL[f]);
  if (blocking.length) {
    const { ingestEvents } = await import('../proctoring/service.js');
    await ingestEvents(deps, trx, tenantId, `CLIENT_SCAN:${userId}`, blocking.map((f) => ({ sourceEventId: `scan:${scanId}:${f}`, attemptId, signalClass: DEVICE_SCAN_SIGNAL[f]!, metadata: { finding: f, scanId, phase: 'IN_EXAM' } })));
  }
  await logAttemptEvent(trx, { tenantId, attemptId, eventType: 'device.scan', actor: `USER:${userId}`, metadata: { scanId, verdict, findings } });
  return { scanId, verdict, findings };
}

/** Worker sweep: ACTIVE attempts with no heartbeat beyond the grace move to RECOVERY_PENDING (technical, never a warning). */
export async function sweepStaleHeartbeats(deps: AppDeps, trx: Knex.Transaction, tenantId: string): Promise<number> {
  const active = await trx('exam_attempts').where({ tenant_id: tenantId, status: 'ACTIVE' }).select('id', 'user_id');
  let moved = 0;
  for (const a of active) {
    const hb = await deps.redis.get(`attempt:heartbeat:${a.id}`);
    const last = hb ? Number(hb) : 0;
    if (deps.clock.now().getTime() - last > HEARTBEAT_GRACE_SECONDS * 1000) {
      await trx('exam_attempts').where('id', a.id).update({ status: 'RECOVERY_PENDING', updated_at: trx.fn.now() });
      await logAttemptEvent(trx, { tenantId, attemptId: a.id, eventType: 'attempt.recovery_pending', actor: 'SYSTEM:heartbeat_sweep', metadata: { lastHeartbeatMs: last } });
      moved++;
    }
  }
  return moved;
}

// ---------------------------------------------------------------------------
// Submission / seal
// ---------------------------------------------------------------------------
export async function submit(deps: AppDeps, trx: Knex.Transaction, tenantId: string, userId: string, attemptId: string, idempotencyKey: string, net?: ClientNet) {
  const { attempt } = await lockAttemptForUser(trx, tenantId, attemptId, userId);
  if (net) await observeNetwork(deps, trx, tenantId, attempt, net, 'SUBMIT');
  const existing = await trx('submission_manifests').where({ attempt_id: attemptId }).first();
  if (existing) {
    if (existing.idempotency_key === idempotencyKey) return manifestReceipt(existing);
    throw AppError.conflict('ALREADY_SUBMITTED', 'This attempt is already sealed');
  }
  if (!['ACTIVE', 'RECOVERY_PENDING'].includes(attempt.status)) throw AppError.conflict('ATTEMPT_STATE', `attempt is ${attempt.status}`);
  assertTransition('attempt', ATTEMPT_TRANSITIONS, attempt.status as AttemptStatus, 'SUBMITTING');
  const manifest = await sealAttempt(trx, tenantId, attemptId, 'SUBMITTED', `USER:${userId}`, idempotencyKey);
  return manifestReceipt(manifest);
}

function manifestReceipt(m: { receipt_id: string; manifest_sha256: string; sealed_at: Date; manifest: unknown }) {
  return { receiptId: m.receipt_id, manifestSha256: m.manifest_sha256, sealedAt: new Date(m.sealed_at).toISOString(), manifest: m.manifest };
}

/**
 * Seals all server-acknowledged answer versions in one transaction, issues the
 * authoritative receipt and creates the candidate review packet (spec §7, §46).
 * Caller must hold the attempt row lock.
 */
export async function sealAttempt(trx: Knex.Transaction, tenantId: string, attemptId: string, finalStatus: 'SUBMITTED' | 'EXPIRED' | 'VOIDED_BY_AUTHORITY', actor: string, idempotencyKey: string | null) {
  const attempt = await trx('exam_attempts').where({ tenant_id: tenantId, id: attemptId }).first();
  if (!attempt) throw AppError.notFound('ATTEMPT_NOT_FOUND');
  if (SEALED_ATTEMPT_STATUSES.includes(attempt.status)) {
    const existing = await trx('submission_manifests').where({ attempt_id: attemptId }).first();
    if (existing) return existing;
  }
  const docs = await trx('answer_documents').where({ attempt_id: attemptId }).orderBy('question_id');
  const manifest = {
    attemptId,
    finalStatus,
    answers: docs.map((d) => ({ questionId: d.question_id, revision: d.current_revision, sha256: d.content_sha256 })),
    sealedBy: actor,
  };
  const manifestSha = sha256Hex(canonicalJson(manifest));
  const [m] = await trx('submission_manifests').insert({ tenant_id: tenantId, attempt_id: attemptId, manifest: JSON.stringify(manifest), manifest_sha256: manifestSha, idempotency_key: idempotencyKey ?? randomUUID() }).returning('*');
  await trx('warning_epochs').where({ attempt_id: attemptId }).whereNull('closed_at').update({ closed_at: trx.fn.now() });
  await trx('exam_attempts').where('id', attemptId).update({ status: finalStatus, submitted_at: finalStatus === 'SUBMITTED' ? trx.fn.now() : null, sealed_at: trx.fn.now(), suspension_kind: null, authorization_generation: attempt.authorization_generation + 1, updated_at: trx.fn.now() });
  await trx('candidate_review_packets').insert({ tenant_id: tenantId, attempt_id: attemptId, exam_id: attempt.exam_id, user_id: attempt.user_id, status: 'ATTEMPT_SEALED', sealed_submission_verified: true }).onConflict('attempt_id').ignore();
  await logAttemptEvent(trx, { tenantId, attemptId, eventType: 'attempt.sealed', actor, metadata: { finalStatus, manifestSha256: manifestSha, answers: manifest.answers.length } });
  const exam = await trx('exams').where('id', attempt.exam_id).first('code');
  const ident = await erpIdentity(trx, tenantId, attempt.user_id);
  await recordIntegrationEvent(trx, { tenantId, type: 'attempt.submitted', aggregateType: 'exam_attempt', aggregateId: attemptId, data: { attemptId, examId: attempt.exam_id, examCode: exam?.code, studentExternalId: ident?.external_id ?? null, finalStatus, manifestSha256: manifestSha, receiptId: m.receipt_id } });
  return m;
}
