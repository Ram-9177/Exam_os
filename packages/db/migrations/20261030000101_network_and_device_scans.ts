import type { Knex } from 'knex';

/**
 * 0101 — IP tracking and device (system settings) scans.
 *
 * - auth_sessions and exam_attempts remember the network address and user agent
 *   they were created from (context for humans, never a verdict on its own).
 * - attempt_network_observations keeps one row per distinct address seen for an
 *   attempt (first/last seen, how often, through which request kind), so the
 *   proctor console and the evidence pack can show every network the exam was
 *   written from.
 * - device_scans is append-only evidence of the client's system scan (displays,
 *   automation, virtualisation hints, browser capabilities) at readiness and
 *   periodically during the exam. Clean client scans are never a PASS for a
 *   security check; findings only ever block or go to a human.
 *
 * Runs after 0099, so it enables and forces RLS for its own tables.
 */
const APP_ROLE = 'examos_app';

const POLICY = `
  FOR ALL TO ${APP_ROLE}
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.bypass_tenant', true) = 'worker')
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.bypass_tenant', true) = 'worker')`;

export async function up(db: Knex): Promise<void> {
  await db.raw(`
    ALTER TABLE auth_sessions ADD COLUMN ip text NULL, ADD COLUMN user_agent text NULL;
    ALTER TABLE exam_attempts ADD COLUMN admitted_ip text NULL, ADD COLUMN admitted_user_agent text NULL;

    CREATE TABLE attempt_network_observations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      attempt_id uuid NOT NULL REFERENCES exam_attempts(id) ON DELETE RESTRICT,
      ip text NOT NULL,
      user_agent text NULL,
      first_seen_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      observations integer NOT NULL DEFAULT 1,
      first_source text NOT NULL CHECK (first_source IN ('PRECHECK','ADMISSION','HEARTBEAT','SAVE','RECONNECT','SUBMIT','SIGNAL')),
      in_allowed_subnet boolean NULL,
      UNIQUE (attempt_id, ip)
    );
    CREATE INDEX attempt_network_observations_tenant_idx ON attempt_network_observations(tenant_id, attempt_id);

    CREATE TABLE device_scans (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      attempt_id uuid NOT NULL REFERENCES exam_attempts(id) ON DELETE RESTRICT,
      precheck_run_id uuid NULL REFERENCES precheck_runs(id) ON DELETE RESTRICT,
      phase text NOT NULL CHECK (phase IN ('PRECHECK','IN_EXAM')),
      verdict text NOT NULL CHECK (verdict IN ('CLEAN','REVIEW','BLOCKED')),
      findings jsonb NOT NULL DEFAULT '[]'::jsonb,
      scan jsonb NOT NULL,
      scan_sha256 text NOT NULL,
      ip text NULL,
      user_agent text NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX device_scans_attempt_idx ON device_scans(attempt_id, created_at DESC);
    CREATE TRIGGER device_scans_append_only BEFORE UPDATE OR DELETE ON device_scans
      FOR EACH ROW EXECUTE FUNCTION examos_forbid_mutation();
  `);
  await db.raw(`GRANT SELECT, INSERT, UPDATE ON attempt_network_observations TO ${APP_ROLE}`);
  await db.raw(`GRANT SELECT, INSERT ON device_scans TO ${APP_ROLE}`);
  for (const table of ['attempt_network_observations', 'device_scans']) {
    await db.raw(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    await db.raw(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    await db.raw(`CREATE POLICY tenant_isolation ON ${table} ${POLICY}`);
  }
}

export async function down(db: Knex): Promise<void> {
  await db.raw(`
    DROP TABLE device_scans;
    DROP TABLE attempt_network_observations;
    ALTER TABLE exam_attempts DROP COLUMN admitted_ip, DROP COLUMN admitted_user_agent;
    ALTER TABLE auth_sessions DROP COLUMN ip, DROP COLUMN user_agent;
  `);
}
