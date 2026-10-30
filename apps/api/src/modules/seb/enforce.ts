import type { Knex } from '@examos/db';
import { withTenantTx } from '@examos/db';
import type { AppDeps } from '../../types.js';
import { AppError } from '../../lib/errors.js';
import { sebPolicyOf, verifySeb, type SebEvidence, type SebOutcome } from './verify.js';

type ExamLike = { security_profile: string; policy: unknown };

async function recordMissing(deps: AppDeps, trx: Knex.Transaction, tenantId: string, attemptId: string, route: string, reason: string) {
  const { ingestEvents } = await import('../proctoring/service.js');
  const bucket = Math.floor(deps.clock.now().getTime() / 60_000);
  await ingestEvents(deps, trx, tenantId, 'SERVER', [{ sourceEventId: `seb:${attemptId}:${route}:${bucket}`, attemptId, signalClass: 'SECURE_CLIENT_MISSING', metadata: { route, reason } }]);
}

/**
 * Gate for the doors into an exam that requires Safe Exam Browser: entry grant, admission and reconnect. A request
 * without a valid SEB key is recorded first (its own transaction, so the evidence survives the refusal) and then
 * refused — the exam is never opened outside SEB, whatever the readiness check said earlier.
 */
export async function requireSeb(deps: AppDeps, tenantId: string, attemptId: string, exam: ExamLike, ev: SebEvidence | undefined, route: 'entry-grant' | 'admit' | 'reconnect'): Promise<SebOutcome | null> {
  const policy = sebPolicyOf(exam);
  if (!policy) return null;
  const out = verifySeb(policy, ev ?? { requestUrl: '', host: '' });
  if (out.ok) return out;
  await withTenantTx(deps.db, tenantId, (evTrx) => recordMissing(deps, evTrx, tenantId, attemptId, route, out.reason));
  throw AppError.forbidden('SECURE_CLIENT_REQUIRED', 'This exam can only be opened in Safe Exam Browser with the configuration from the Examination Section. Download the .seb file from your exam card and open it.');
}

/**
 * During the exam the device session already binds the attempt to the SEB instance that was admitted. A live request
 * that arrives without the SEB key is not refused (a student's saved work is never put at risk by a header) but it is
 * a server-observed signal for a human, at most one per minute per route.
 */
export async function observeSeb(deps: AppDeps, trx: Knex.Transaction, tenantId: string, attemptId: string, exam: ExamLike, ev: SebEvidence | undefined, route: 'heartbeat'): Promise<SebOutcome | null> {
  const policy = sebPolicyOf(exam);
  if (!policy) return null;
  const out = verifySeb(policy, ev ?? { requestUrl: '', host: '' });
  if (!out.ok) await recordMissing(deps, trx, tenantId, attemptId, route, out.reason);
  return out;
}
