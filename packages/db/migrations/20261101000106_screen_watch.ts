import type { Knex } from 'knex';

/**
 * 0106 — screen watch.
 *
 * screen_frames: one row per picture of a student's shared screen, received during a live attempt of an exam whose
 * policy turns screen watch on. The picture itself is in document storage (bucket `screens`); the row holds what the
 * server knows: when it arrived (server clock), size, hash, and what the browser said it was sharing (context only).
 * Proctors look at the pictures; nothing is judged automatically.
 */
const APP_ROLE = 'examos_app';
const POLICY = `
  FOR ALL TO ${APP_ROLE}
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.bypass_tenant', true) = 'worker')
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.bypass_tenant', true) = 'worker')`;

export async function up(db: Knex): Promise<void> {
  await db.raw(`
    CREATE TABLE screen_frames (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      attempt_id uuid NOT NULL REFERENCES exam_attempts(id) ON DELETE RESTRICT,
      object_key text NOT NULL,
      sha256 text NOT NULL,
      byte_length integer NOT NULL,
      width integer NOT NULL,
      height integer NOT NULL,
      display_surface text NOT NULL CHECK (display_surface IN ('monitor','window','browser','unknown')),
      received_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX screen_frames_attempt_idx ON screen_frames(tenant_id, attempt_id, received_at DESC);
  `);
  await db.raw(`GRANT SELECT, INSERT, DELETE ON screen_frames TO ${APP_ROLE}`);
  await db.raw(`ALTER TABLE screen_frames ENABLE ROW LEVEL SECURITY`);
  await db.raw(`ALTER TABLE screen_frames FORCE ROW LEVEL SECURITY`);
  await db.raw(`CREATE POLICY tenant_isolation ON screen_frames ${POLICY}`);
}

export async function down(db: Knex): Promise<void> {
  await db.raw(`DROP TABLE screen_frames`);
}
