import knex, { type Knex } from 'knex';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type { Knex } from 'knex';

const here = path.dirname(fileURLToPath(import.meta.url));

export interface DbConfig {
  connectionString: string;
  /** Owner / migration role connection (superuser or table owner). */
  adminConnectionString?: string;
  poolMin?: number;
  poolMax?: number;
  /** Pool acquire timeout; knex's default of 60 s hides pool exhaustion behind slow requests. */
  acquireTimeoutMs?: number;
}

export function dbConfigFromEnv(): DbConfig {
  const connectionString = process.env['DATABASE_URL'] ?? 'postgres://examos_app:examos_app@127.0.0.1:5432/examos_dev';
  const adminConnectionString = process.env['DATABASE_ADMIN_URL'] ?? 'postgres://postgres:postgres@127.0.0.1:5432/examos_dev';
  return { connectionString, adminConnectionString, poolMin: 0, poolMax: Number(process.env['DB_POOL_MAX'] ?? 20) };
}

export function migrationConfig(connectionString: string): Knex.Config {
  return {
    client: 'pg',
    connection: connectionString,
    pool: { min: 0, max: 4 },
    migrations: {
      directory: path.resolve(here, '../migrations'),
      extension: 'ts',
      loadExtensions: ['.ts'],
      tableName: 'knex_migrations',
    },
  };
}

/** Application connection: runs as the non-superuser `examos_app` role so row-level security applies. */
export function createDb(cfg: DbConfig = dbConfigFromEnv()): Knex {
  return knex({
    client: 'pg',
    connection: cfg.connectionString,
    pool: { min: cfg.poolMin ?? 0, max: cfg.poolMax ?? 20 },
    acquireConnectionTimeout: cfg.acquireTimeoutMs ?? 10_000,
  });
}

/** Admin connection for migrations and test setup only. Never used by request handlers. */
export function createAdminDb(cfg: DbConfig = dbConfigFromEnv()): Knex {
  return knex(migrationConfig(cfg.adminConnectionString ?? cfg.connectionString));
}

/**
 * Every tenant-scoped unit of work runs inside a transaction that sets the
 * PostgreSQL GUC `app.tenant_id` with `is_local = true`, so the row-level
 * security policies (migration 0011) see exactly one tenant and the setting
 * disappears at COMMIT/ROLLBACK. The API layer resolves `tenantId` from the host
 * or the API key, never from a request body (review §4).
 */
export async function withTenantTx<T>(db: Knex, tenantId: string, fn: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (trx) => {
    await trx.raw("SELECT set_config('app.tenant_id', ?, true)", [tenantId]);
    return fn(trx);
  });
}

/**
 * Workers that claim jobs across tenants (outbox, mail, webhooks) open a
 * transaction flagged as worker context. This is a documented, deliberate
 * bypass used only by background processes; request handlers never call it.
 */
export async function withWorkerTx<T>(db: Knex, fn: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (trx) => {
    await trx.raw("SELECT set_config('app.bypass_tenant', 'worker', true)");
    return fn(trx);
  });
}

export async function setTenantOnTrx(trx: Knex.Transaction, tenantId: string): Promise<void> {
  await trx.raw("SELECT set_config('app.tenant_id', ?, true)", [tenantId]);
}

/** List of tables protected by tenant RLS; shared by migration 0011 and the RLS test. */
export const TENANT_TABLES = [
  'users',
  'external_identities',
  'role_grants',
  'auth_sessions',
  'one_time_tokens',
  'tenant_sso_configs',
  'tenant_mail_configs',
  'tenant_erp_connections',
  'api_keys',
  'schools',
  'departments',
  'programmes',
  'courses',
  'student_profiles',
  'course_enrollments',
  'idempotency_keys',
  'roster_sync_jobs',
  'roster_sync_rows',
  'integration_events',
  'outbox_events',
  'webhook_endpoints',
  'webhook_deliveries',
  'mail_dispatches',
  'exams',
  'hall_tickets',
  'exam_allocations',
  'exam_attempts',
  'precheck_runs',
  'precheck_items',
  'precheck_practice_saves',
  'admission_exceptions',
  'admission_grants',
  'answer_documents',
  'answer_revisions',
  'submission_manifests',
  'attempt_event_log',
  'proctor_events',
  'proctor_incidents',
  'warning_epochs',
  'proctor_warnings',
  'proctor_decisions',
  'resume_grants',
  'result_versions',
  'candidate_review_packets',
  'candidate_approvals',
  'controller_publication_grants',
  'consent_records',
  'student_exam_records',
  'question_papers',
  'paper_questions',
  'paper_sets',
  'paper_releases',
  'stored_documents',
  'student_documents',
  'evaluator_assignments',
  'moderation_samples',
  'revaluation_requests',
  // created after 0099 by 0101, which applies RLS itself
  'attempt_network_observations',
  'device_scans',
] as const;

/** Tables the application role may only INSERT into (append-only evidence and audit). */
export const APPEND_ONLY_TABLES = ['audit_events', 'answer_revisions', 'proctor_warnings', 'attempt_event_log', 'submission_manifests', 'resume_grants', 'controller_publication_grants', 'paper_releases', 'device_scans'] as const;
