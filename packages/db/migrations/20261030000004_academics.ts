import type { Knex } from 'knex';

/**
 * 0004 — Academic master data owned by the ERP, mirrored in canonical form
 * (spec §5, review §5). Hierarchy: tenant → school → department → programme;
 * courses hang off departments; enrolments bind students to courses per term.
 */
export async function up(db: Knex): Promise<void> {
  await db.raw(`
    CREATE TABLE schools (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      code text NOT NULL,
      name text NOT NULL,
      status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, code)
    );
    CREATE TABLE departments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      school_id uuid NULL REFERENCES schools(id) ON DELETE RESTRICT,
      code text NOT NULL,
      name text NOT NULL,
      status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, code)
    );
    CREATE TABLE programmes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      code text NOT NULL,
      name text NOT NULL,
      department_id uuid NULL REFERENCES departments(id) ON DELETE RESTRICT,
      status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, code)
    );
    CREATE TABLE courses (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      code text NOT NULL,
      name text NOT NULL,
      department_id uuid NULL REFERENCES departments(id) ON DELETE RESTRICT,
      credits numeric(5,2) NULL,
      status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, code)
    );
    CREATE TABLE student_profiles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
      department_id uuid NULL REFERENCES departments(id) ON DELETE RESTRICT,
      programme_id uuid NULL REFERENCES programmes(id) ON DELETE RESTRICT,
      admission_batch text NULL,
      current_semester int NULL CHECK (current_semester BETWEEN 1 AND 20),
      section text NULL,
      register_number text NULL,
      photo_object_ref text NULL,
      preferred_language text NULL,
      attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX student_profiles_register_number ON student_profiles(tenant_id, register_number) WHERE register_number IS NOT NULL;
    CREATE TABLE course_enrollments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      course_id uuid NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
      academic_year text NOT NULL,
      term text NOT NULL,
      section text NULL,
      eligibility_status text NOT NULL DEFAULT 'ELIGIBLE' CHECK (eligibility_status IN ('ELIGIBLE','INELIGIBLE','DETAINED','PENDING')),
      source text NOT NULL DEFAULT 'PUSH_API',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, user_id, course_id, academic_year, term)
    );
    CREATE INDEX course_enrollments_course_idx ON course_enrollments(tenant_id, course_id, academic_year, term);
  `);
}

export async function down(db: Knex): Promise<void> {
  await db.raw('DROP TABLE IF EXISTS course_enrollments, student_profiles, courses, programmes, departments, schools CASCADE');
}
