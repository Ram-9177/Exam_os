import type { Knex } from 'knex';

/**
 * 0104 — maths, health and coding question kinds.
 *
 * - paper_questions.kind adds MCQ_MULTI, MATH and CODE; code_spec holds what a CODE question shows students
 *   (languages, starter, sample tests, limits). Hidden tests stay in expected_answer, never sent to students.
 * - code_runs: every program run by the judge — SAMPLE runs a student asks for during the exam (visible samples only,
 *   limited per question) and GRADING runs after the script is sealed (hidden tests). Results feed mark proposals.
 */
const APP_ROLE = 'examos_app';
const POLICY = `
  FOR ALL TO ${APP_ROLE}
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.bypass_tenant', true) = 'worker')
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid OR current_setting('app.bypass_tenant', true) = 'worker')`;

export async function up(db: Knex): Promise<void> {
  await db.raw(`
    ALTER TABLE paper_questions DROP CONSTRAINT IF EXISTS paper_questions_kind_check;
    ALTER TABLE paper_questions ADD CONSTRAINT paper_questions_kind_check CHECK (kind IN ('DESCRIPTIVE','MCQ','MCQ_MULTI','NUMERIC','MATH','DRAWING','CODE'));
    ALTER TABLE paper_questions ADD COLUMN code_spec jsonb NULL;
    CREATE TABLE code_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      attempt_id uuid NOT NULL REFERENCES exam_attempts(id) ON DELETE RESTRICT,
      question_id text NOT NULL,
      purpose text NOT NULL CHECK (purpose IN ('SAMPLE','GRADING')),
      language text NOT NULL,
      source_sha256 text NOT NULL,
      status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','DONE','ERROR')),
      claimed_at timestamptz NULL,
      results jsonb NULL,
      passed_weight numeric NULL,
      total_weight numeric NULL,
      error text NULL,
      attempts integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz NULL
    );
    CREATE INDEX code_runs_attempt_idx ON code_runs(tenant_id, attempt_id, question_id, purpose);
    CREATE INDEX code_runs_queue_idx ON code_runs(status, created_at) WHERE status = 'QUEUED';
  `);
  await db.raw(`GRANT SELECT, INSERT, UPDATE ON code_runs TO ${APP_ROLE}`);
  await db.raw(`ALTER TABLE code_runs ENABLE ROW LEVEL SECURITY`);
  await db.raw(`ALTER TABLE code_runs FORCE ROW LEVEL SECURITY`);
  await db.raw(`CREATE POLICY tenant_isolation ON code_runs ${POLICY}`);
}

export async function down(db: Knex): Promise<void> {
  await db.raw(`DROP TABLE code_runs; ALTER TABLE paper_questions DROP COLUMN code_spec;
    ALTER TABLE paper_questions DROP CONSTRAINT IF EXISTS paper_questions_kind_check;
    ALTER TABLE paper_questions ADD CONSTRAINT paper_questions_kind_check CHECK (kind IN ('DESCRIPTIVE','MCQ','NUMERIC','DRAWING'));`);
}
