import type { Knex } from '@examos/db';

/**
 * Transaction-scoped PostgreSQL advisory locks for the few places where the
 * application builds something sequential out of concurrent requests (hash
 * chains, incident grouping). They are released at commit/rollback, cost one
 * round-trip, and never leak. Keep the namespaces here so lock ordering stays
 * visible: every path takes ATTEMPT_INCIDENTS before ATTEMPT_TIMELINE_CHAIN
 * before TENANT_AUDIT_CHAIN (or a subset of that order).
 */
export const LOCK_NS = {
  TENANT_AUDIT_CHAIN: 1,
  ATTEMPT_TIMELINE_CHAIN: 2,
  ATTEMPT_INCIDENTS: 3,
} as const;

export async function advisoryXactLock(trx: Knex.Transaction, ns: (typeof LOCK_NS)[keyof typeof LOCK_NS], key: string | null): Promise<void> {
  await trx.raw('select pg_advisory_xact_lock(?, hashtext(?))', [ns, key ?? 'platform']);
}
