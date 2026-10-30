import { buildDeps } from './deps.js';
import { runMailWorkerOnce } from './modules/notifications/worker.js';
import { runOutboxDispatcherOnce, runWebhookWorkerOnce } from './modules/integration/webhooks.js';
import { runForensicsOnce } from './modules/candidates/service.js';
import { sweepStaleHeartbeats } from './modules/attempts/service.js';
import { withTenantTx, withWorkerTx } from '@examos/db';

/**
 * Background worker: outbox fan-out, webhook delivery, mail (two lanes),
 * forensic checks for sealed attempts, heartbeat sweep. Each pass is
 * idempotent; several worker processes may run concurrently (SKIP LOCKED).
 */
const deps = buildDeps();
let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => (stopping = true));

async function loop(name: string, fn: () => Promise<unknown>, everyMs: number) {
  while (!stopping) {
    try {
      const out = await fn();
      if (out && typeof out === 'object' && Object.values(out as Record<string, number>).some((v) => v > 0)) deps.logger.info({ worker: name, out }, 'pass');
    } catch (e) {
      deps.logger.error({ err: e, worker: name }, 'worker pass failed');
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

async function sweepAllTenants() {
  const tenants = await withWorkerTx(deps.db, (trx) => trx('exams').where('status', 'LIVE').distinct('tenant_id'));
  let moved = 0;
  for (const t of tenants) moved += await withTenantTx(deps.db, t.tenant_id, (trx) => sweepStaleHeartbeats(deps, trx, t.tenant_id));
  return { moved };
}

await Promise.all([
  loop('outbox', () => runOutboxDispatcherOnce(deps), 1000),
  loop('webhooks', () => runWebhookWorkerOnce(deps), 2000),
  loop('mail-transactional', () => runMailWorkerOnce(deps, 'TRANSACTIONAL'), 1000),
  loop('mail-bulk', () => runMailWorkerOnce(deps, 'BULK'), 5000),
  loop('forensics', () => runForensicsOnce(deps), 5000),
  loop('heartbeat-sweep', sweepAllTenants, 30_000),
]);
deps.logger.info('worker stopped');
process.exit(0);
