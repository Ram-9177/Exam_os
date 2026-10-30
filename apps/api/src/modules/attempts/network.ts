import { withTenantTx, type Knex } from '@examos/db';
import type { IpPolicy } from '@examos/contracts';
import type { AppDeps } from '../../types.js';
import { AppError } from '../../lib/errors.js';
import { logAttemptEvent } from '../../lib/audit.js';
import type { ClientNet } from '../../lib/client-net.js';
import { isIpInSubnets } from '../seb/service.js';

/** Which request kind first showed an address (mirrors the DB check constraint). */
export type NetworkSource = 'PRECHECK' | 'ADMISSION' | 'HEARTBEAT' | 'SAVE' | 'RECONNECT' | 'SUBMIT' | 'SIGNAL';

/** Requests made while the paper is open; readiness and admission traffic is only logged. */
const IN_EXAM_SOURCES: readonly NetworkSource[] = ['HEARTBEAT', 'SAVE', 'RECONNECT', 'SUBMIT', 'SIGNAL'];

interface AttemptNetRow {
  id: string;
  exam_id: string;
  status: string;
  admitted_ip: string | null;
}

interface ExamNetPolicy {
  ipPolicy: IpPolicy;
  allowedSubnets: string[];
  requireManagedEndpoint: boolean;
}

export function examNetPolicy(policy: unknown): ExamNetPolicy {
  const p = (policy ?? {}) as Record<string, unknown>;
  const ipPolicy = p['ipPolicy'];
  return {
    ipPolicy: ipPolicy === 'REVIEW' || ipPolicy === 'LOCK' ? ipPolicy : 'LOG',
    allowedSubnets: Array.isArray(p['allowedSubnets']) ? (p['allowedSubnets'] as string[]) : [],
    requireManagedEndpoint: p['requireManagedEndpoint'] === true,
  };
}

interface ObserveOutcome {
  ip: string | null;
  changed: boolean;
  previousIp: string | null;
  inAllowedSubnet: boolean | null;
}

/**
 * Records one network observation for an attempt: a new row per distinct
 * address, otherwise last-seen and a counter. Returns whether this request
 * arrived from an address the attempt had not used before.
 */
async function upsertObservation(trx: Knex.Transaction, tenantId: string, attemptId: string, net: ClientNet, source: NetworkSource, inAllowedSubnet: boolean | null): Promise<ObserveOutcome> {
  if (!net.ip) return { ip: null, changed: false, previousIp: null, inAllowedSubnet };
  const previous = await trx('attempt_network_observations').where({ tenant_id: tenantId, attempt_id: attemptId }).orderBy('last_seen_at', 'desc').first('ip');
  const rows = await trx('attempt_network_observations')
    .insert({ tenant_id: tenantId, attempt_id: attemptId, ip: net.ip, user_agent: net.userAgent, first_source: source, in_allowed_subnet: inAllowedSubnet })
    .onConflict(['attempt_id', 'ip'])
    .merge({ last_seen_at: trx.fn.now(), observations: trx.raw('attempt_network_observations.observations + 1'), user_agent: net.userAgent })
    .returning<Array<{ inserted: boolean }>>(trx.raw('(xmax = 0) as inserted'));
  const inserted = rows[0]?.inserted === true;
  const changed = inserted && !!previous && previous.ip !== net.ip;
  return { ip: net.ip, changed, previousIp: previous?.ip ?? null, inAllowedSubnet };
}

/**
 * Observes the caller's network for an attempt request and applies the exam's
 * `ipPolicy`:
 *
 * - LOG    — every address change is an attempt_event_log row (transport context, never a warning).
 * - REVIEW — additionally raises a NETWORK_ADDRESS_CHANGED signal for a human during the exam.
 * - LOCK   — in-exam requests must come from the admitted address; a different one is
 *            recorded (own transaction) and refused until a proctor resumes the attempt.
 *
 * `requireManagedEndpoint` with `allowedSubnets` refuses in-exam requests from
 * outside the lab network the same way. Nothing here ever counts as a warning.
 */
export async function observeNetwork(deps: AppDeps, trx: Knex.Transaction, tenantId: string, attempt: AttemptNetRow, net: ClientNet, source: NetworkSource): Promise<ObserveOutcome> {
  if (!net.ip) return { ip: null, changed: false, previousIp: null, inAllowedSubnet: null };
  const exam = await trx('exams').where({ tenant_id: tenantId, id: attempt.exam_id }).first('policy');
  const policy = examNetPolicy(exam?.policy);
  const inAllowedSubnet = policy.allowedSubnets.length ? isIpInSubnets(net.ip, policy.allowedSubnets) : null;
  const inExam = IN_EXAM_SOURCES.includes(source) && ['ACTIVE', 'RECOVERY_PENDING', 'SUSPENDED'].includes(attempt.status);

  const refusal: { code: string; message: string; eventType: string } | null =
    inExam && policy.requireManagedEndpoint && inAllowedSubnet === false
      ? { code: 'NETWORK_NOT_ALLOWED', message: 'This exam must be written from the examination network. Reconnect to the lab network or ask the invigilator.', eventType: 'network.refused_outside_lab' }
      : inExam && policy.ipPolicy === 'LOCK' && attempt.admitted_ip && attempt.admitted_ip !== net.ip
        ? { code: 'NETWORK_ADDRESS_LOCKED', message: 'Your exam is bound to the network you were admitted on. Ask the invigilator to resume your attempt on this connection.', eventType: 'network.refused_address_locked' }
        : null;

  if (refusal) {
    // Record, then refuse: the observation, the event and the review signal commit on their own
    // so the evidence survives the rollback of the refused request.
    await withTenantTx(deps.db, tenantId, async (evTrx) => {
      const seen = await upsertObservation(evTrx, tenantId, attempt.id, net, source, inAllowedSubnet);
      await logAttemptEvent(evTrx, { tenantId, attemptId: attempt.id, eventType: refusal.eventType, actor: 'SYSTEM:network', metadata: { ip: net.ip, admittedIp: attempt.admitted_ip, source, policy: policy.ipPolicy, firstSeen: seen.changed } });
      if (seen.changed) await raiseAddressChanged(deps, evTrx, tenantId, attempt.id, seen, source, policy.ipPolicy);
    });
    throw AppError.conflict(refusal.code, refusal.message);
  }

  const seen = await upsertObservation(trx, tenantId, attempt.id, net, source, inAllowedSubnet);
  if (seen.changed) {
    await logAttemptEvent(trx, { tenantId, attemptId: attempt.id, eventType: 'network.address_changed', actor: 'SYSTEM:network', metadata: { from: seen.previousIp, to: seen.ip, source, policy: policy.ipPolicy, inAllowedSubnet } });
    if (inExam && policy.ipPolicy !== 'LOG') await raiseAddressChanged(deps, trx, tenantId, attempt.id, seen, source, policy.ipPolicy);
  }
  return seen;
}

async function raiseAddressChanged(deps: AppDeps, trx: Knex.Transaction, tenantId: string, attemptId: string, seen: ObserveOutcome, source: NetworkSource, policy: IpPolicy): Promise<void> {
  const { ingestEvents } = await import('../proctoring/service.js');
  await ingestEvents(deps, trx, tenantId, 'SERVER', [{ sourceEventId: `net:${attemptId}:${seen.ip}`, attemptId, signalClass: 'NETWORK_ADDRESS_CHANGED', metadata: { from: seen.previousIp, to: seen.ip, source, policy } }]);
}

/** Every address an attempt was seen from, newest last; for the proctor console and the evidence pack. */
export async function listNetworkObservations(trx: Knex.Transaction, tenantId: string, attemptId: string) {
  return trx('attempt_network_observations').where({ tenant_id: tenantId, attempt_id: attemptId }).orderBy('first_seen_at').select('ip', 'user_agent', 'first_seen_at', 'last_seen_at', 'observations', 'first_source', 'in_allowed_subnet');
}
