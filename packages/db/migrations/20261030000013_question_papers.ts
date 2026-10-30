import type { Knex } from 'knex';

/**
 * 0013 — Question papers, questions, paper sets, and releases.
 *
 * Runs before 0099, so 0099's RLS and app role grants cover all four tables.
 * paper_releases is append-only (trigger examos_forbid_mutation).
 */
export async function up(db: Knex): Promise<void> {
  await db.raw(`
    CREATE TABLE question_papers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      exam_id uuid NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
      version integer NOT NULL DEFAULT 1,
      status text NOT NULL CHECK (status IN ('DRAFT','REVIEW','APPROVED','SUPERSEDED')) DEFAULT 'DRAFT',
      title text NOT NULL,
      instructions text,
      total_marks numeric NOT NULL,
      sections jsonb NOT NULL DEFAULT '[]'::jsonb,
      sealed_sha256 text,
      encrypted_body bytea,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      submitted_at timestamptz,
      approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
      approved_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, exam_id, version)
    );
    CREATE INDEX question_papers_exam_idx ON question_papers(tenant_id, exam_id, status);

    CREATE TABLE paper_questions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      paper_id uuid NOT NULL REFERENCES question_papers(id) ON DELETE CASCADE,
      question_id text NOT NULL,
      section_code text NOT NULL,
      number integer NOT NULL,
      kind text NOT NULL CHECK (kind IN ('DESCRIPTIVE','MCQ','NUMERIC','DRAWING')),
      prompt jsonb NOT NULL,
      options jsonb,
      max_marks numeric NOT NULL,
      rubric jsonb,
      expected_answer jsonb,
      attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (paper_id, question_id)
    );
    CREATE INDEX paper_questions_paper_idx ON paper_questions(tenant_id, paper_id);

    CREATE TABLE paper_sets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      paper_id uuid NOT NULL REFERENCES question_papers(id) ON DELETE CASCADE,
      set_code text NOT NULL,
      question_order jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (paper_id, set_code)
    );

    CREATE TABLE paper_releases (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      attempt_id uuid NOT NULL REFERENCES exam_attempts(id) ON DELETE CASCADE,
      paper_id uuid NOT NULL REFERENCES question_papers(id) ON DELETE RESTRICT,
      set_code text NOT NULL DEFAULT 'DEFAULT',
      released_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, attempt_id)
    );

    CREATE TRIGGER paper_releases_append_only BEFORE UPDATE OR DELETE ON paper_releases
      FOR EACH ROW EXECUTE FUNCTION examos_forbid_mutation();
  `);
}

export async function down(db: Knex): Promise<void> {
  await db.raw(`
    DROP TRIGGER IF EXISTS paper_releases_append_only ON paper_releases;
    DROP TABLE IF EXISTS paper_releases CASCADE;
    DROP TABLE IF EXISTS paper_sets CASCADE;
    DROP TABLE IF EXISTS paper_questions CASCADE;
    DROP TABLE IF EXISTS question_papers CASCADE;
  `);
}

