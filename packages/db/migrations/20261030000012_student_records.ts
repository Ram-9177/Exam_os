import type { Knex } from 'knex';

/**
 * 0012 — Lifelong student exam ledger (second brief, 30 Oct 2026).
 *
 * One row per PUBLISHED result, retention class PERMANENT: academic records
 * outlive proctoring media, which expires under the evidence retention policy.
 * Semester-wise and overall rollups are views over this table so the student
 * profile shows exam-wise → semester-wise cumulative → overall without a second
 * copy of the numbers. Grading rules (SGPA/CGPA formulae) are a tenant policy
 * decision; the views expose marks and weighted percentages, and the ERP
 * remains free to be the transcript authority (review §11, decision 4).
 */
export async function up(db: Knex): Promise<void> {
  await db.raw(`
    CREATE TABLE student_exam_records (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      exam_id uuid NOT NULL REFERENCES exams(id) ON DELETE RESTRICT,
      attempt_id uuid NOT NULL REFERENCES exam_attempts(id) ON DELETE RESTRICT,
      result_version_id uuid NOT NULL REFERENCES result_versions(id) ON DELETE RESTRICT,
      course_id uuid NULL REFERENCES courses(id) ON DELETE RESTRICT,
      exam_type text NOT NULL,
      academic_year text NULL,
      semester int NULL,
      marks numeric(8,2) NOT NULL CHECK (marks >= 0),
      max_marks numeric(8,2) NOT NULL CHECK (max_marks > 0),
      grade text NULL,
      hall_ticket_number text NULL,
      published_at timestamptz NOT NULL,
      superseded_at timestamptz NULL,
      retention_class text NOT NULL DEFAULT 'PERMANENT' CHECK (retention_class = 'PERMANENT'),
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK (marks <= max_marks)
    );
    -- exactly one live record per attempt; corrections supersede, never overwrite
    CREATE UNIQUE INDEX student_exam_records_live ON student_exam_records(attempt_id) WHERE superseded_at IS NULL;
    CREATE INDEX student_exam_records_profile_idx ON student_exam_records(tenant_id, user_id, academic_year, semester) WHERE superseded_at IS NULL;

    CREATE VIEW v_student_semester_summary WITH (security_invoker = true) AS
      SELECT tenant_id, user_id, academic_year, semester,
             count(*) AS exams,
             sum(marks) AS marks,
             sum(max_marks) AS max_marks,
             round(100.0 * sum(marks) / NULLIF(sum(max_marks), 0), 2) AS percentage
      FROM student_exam_records
      WHERE superseded_at IS NULL
      GROUP BY tenant_id, user_id, academic_year, semester;

    CREATE VIEW v_student_overall_summary WITH (security_invoker = true) AS
      SELECT tenant_id, user_id,
             count(*) AS exams,
             count(DISTINCT (academic_year, semester)) AS semesters,
             sum(marks) AS marks,
             sum(max_marks) AS max_marks,
             round(100.0 * sum(marks) / NULLIF(sum(max_marks), 0), 2) AS percentage
      FROM student_exam_records
      WHERE superseded_at IS NULL
      GROUP BY tenant_id, user_id;

    ALTER TABLE tenant_sso_configs ADD COLUMN provider text NOT NULL DEFAULT 'entra' CHECK (provider IN ('entra','google','generic'));
  `);
}

export async function down(db: Knex): Promise<void> {
  await db.raw(`
    ALTER TABLE tenant_sso_configs DROP COLUMN IF EXISTS provider;
    DROP VIEW IF EXISTS v_student_overall_summary;
    DROP VIEW IF EXISTS v_student_semester_summary;
    DROP TABLE IF EXISTS student_exam_records CASCADE;
  `);
}
