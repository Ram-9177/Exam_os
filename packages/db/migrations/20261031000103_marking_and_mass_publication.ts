import type { Knex } from 'knex';

/**
 * 0103 — automatic evaluation snapshots and mass publication.
 *
 * - mark_proposals: the system's evaluation of each sealed script, computed when forensics hand the script to marking
 *   (or re-run by the Examination Section). One current row per attempt: what the examiner sees in the queue before
 *   opening a script. The proposal that counts is recomputed at recording time and stored in the result version.
 * - exams.results_published_at/by: results of an exam are released together by the Controller of Examinations. Until
 *   then no single result can be published; after it, only a released hold or a revaluation outcome is.
 */
const APP_ROLE = 'examos_app';
const POLICY = `
  FOR ALL TO ${APP_ROLE}
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.bypass_tenant', true) = 'worker')
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.bypass_tenant', true) = 'worker')`;

export async function up(db: Knex): Promise<void> {
  await db.raw(`
    CREATE TABLE mark_proposals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      exam_id uuid NOT NULL REFERENCES exams(id) ON DELETE RESTRICT,
      attempt_id uuid NOT NULL REFERENCES exam_attempts(id) ON DELETE RESTRICT,
      proposals jsonb NOT NULL,
      proposed_total numeric(8,2) NOT NULL,
      max_total numeric(8,2) NOT NULL,
      needs_examiner integer NOT NULL DEFAULT 0,
      check_carefully integer NOT NULL DEFAULT 0,
      computed_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (attempt_id)
    );
    CREATE INDEX mark_proposals_exam_idx ON mark_proposals(tenant_id, exam_id);
    ALTER TABLE exams ADD COLUMN results_published_at timestamptz NULL, ADD COLUMN results_published_by uuid NULL REFERENCES users(id);
  `);
  await db.raw(`GRANT SELECT, INSERT, UPDATE ON mark_proposals TO ${APP_ROLE}`);
  await db.raw(`ALTER TABLE mark_proposals ENABLE ROW LEVEL SECURITY`);
  await db.raw(`ALTER TABLE mark_proposals FORCE ROW LEVEL SECURITY`);
  await db.raw(`CREATE POLICY tenant_isolation ON mark_proposals ${POLICY}`);
}

export async function down(db: Knex): Promise<void> {
  await db.raw(`ALTER TABLE exams DROP COLUMN results_published_by, DROP COLUMN results_published_at; DROP TABLE mark_proposals;`);
}
