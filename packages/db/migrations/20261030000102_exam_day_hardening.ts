import type { Knex } from 'knex';

/**
 * 0102 — exam-day hardening.
 *
 * - Tripwires on both hash chains: appends are serialised by an advisory lock in
 *   the application; should anything ever append to the same tail twice, the
 *   unique index turns it into a hard error instead of a silently forked chain
 *   that forensics would later read as tampering. Skipped (with a warning) when
 *   a database already holds forked history — that history must be examined,
 *   not hidden.
 * - Role-level timeouts for the app role: a request that waits more than 5 s for
 *   a row lock, runs one statement for more than 30 s or sits idle in a
 *   transaction for a minute fails fast (the API maps that to 503 DB_BUSY,
 *   retryable) instead of holding a pooled connection while 2,000 students queue.
 * - Index for the per-attempt deadline sweep.
 */
const APP_ROLE = 'examos_app';

export async function up(db: Knex): Promise<void> {
  await db.raw(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM attempt_event_log WHERE prev_hash IS NOT NULL GROUP BY attempt_id, prev_hash HAVING count(*) > 1) THEN
        RAISE WARNING 'attempt_event_log already contains forked chains; tripwire index not created — examine before go-live';
      ELSE
        CREATE UNIQUE INDEX IF NOT EXISTS attempt_event_log_chain_tripwire ON attempt_event_log(attempt_id, prev_hash) WHERE prev_hash IS NOT NULL;
      END IF;
      IF EXISTS (SELECT 1 FROM audit_events WHERE prev_hash IS NOT NULL GROUP BY COALESCE(tenant_id::text, 'platform'), prev_hash HAVING count(*) > 1) THEN
        RAISE WARNING 'audit_events already contains forked chains; tripwire index not created — examine before go-live';
      ELSE
        CREATE UNIQUE INDEX IF NOT EXISTS audit_events_chain_tripwire ON audit_events((COALESCE(tenant_id::text, 'platform')), prev_hash) WHERE prev_hash IS NOT NULL;
      END IF;
    END $$;
  `);
  await db.raw(`ALTER ROLE ${APP_ROLE} SET lock_timeout = '5s'`);
  await db.raw(`ALTER ROLE ${APP_ROLE} SET statement_timeout = '30s'`);
  await db.raw(`ALTER ROLE ${APP_ROLE} SET idle_in_transaction_session_timeout = '60s'`);
  await db.raw(`CREATE INDEX IF NOT EXISTS exam_attempts_deadline_idx ON exam_attempts(tenant_id, status, deadline_at)`);
}

export async function down(db: Knex): Promise<void> {
  await db.raw(`DROP INDEX IF EXISTS exam_attempts_deadline_idx`);
  await db.raw(`ALTER ROLE ${APP_ROLE} RESET idle_in_transaction_session_timeout`);
  await db.raw(`ALTER ROLE ${APP_ROLE} RESET statement_timeout`);
  await db.raw(`ALTER ROLE ${APP_ROLE} RESET lock_timeout`);
  await db.raw(`DROP INDEX IF EXISTS audit_events_chain_tripwire`);
  await db.raw(`DROP INDEX IF EXISTS attempt_event_log_chain_tripwire`);
}
