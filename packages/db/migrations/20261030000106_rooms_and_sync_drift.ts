import type { Knex } from 'knex';

/**
 * 0106 — Physical rooms and ERP sync drift tracking.
 *
 * - `rooms` stores examination rooms/halls with capacity, building, floor,
 *   and status, isolated per tenant with row-level security.
 * - Roster sync drift is calculated across ERP connections, sync jobs,
 *   and outbox deliveries.
 */
const APP_ROLE = 'examos_app';

const POLICY = `
  FOR ALL TO ${APP_ROLE}
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.bypass_tenant', true) = 'worker')
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.bypass_tenant', true) = 'worker')`;

export async function up(db: Knex): Promise<void> {
  await db.raw(`
    CREATE TABLE rooms (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      code varchar(64) NOT NULL,
      name varchar(255) NOT NULL,
      building varchar(128) NOT NULL,
      floor varchar(32) NULL,
      capacity integer NOT NULL DEFAULT 30,
      active boolean NOT NULL DEFAULT true,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, code)
    );
    CREATE INDEX rooms_tenant_idx ON rooms(tenant_id);

    GRANT SELECT, INSERT, UPDATE, DELETE ON rooms TO ${APP_ROLE};

    ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
    ALTER TABLE rooms FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON rooms ${POLICY};

    ALTER TABLE roster_sync_jobs DROP CONSTRAINT IF EXISTS roster_sync_jobs_entity_check;
    ALTER TABLE roster_sync_jobs ADD CONSTRAINT roster_sync_jobs_entity_check CHECK (entity IN ('PERSON','ACADEMIC_UNIT','COURSE','ENROLLMENT','ROOM'));
  `);
}

export async function down(db: Knex): Promise<void> {
  await db.raw(`
    ALTER TABLE roster_sync_jobs DROP CONSTRAINT IF EXISTS roster_sync_jobs_entity_check;
    ALTER TABLE roster_sync_jobs ADD CONSTRAINT roster_sync_jobs_entity_check CHECK (entity IN ('PERSON','ACADEMIC_UNIT','COURSE','ENROLLMENT'));
    DROP TABLE IF EXISTS rooms;
  `);
}
