import type { Knex } from 'knex';

export async function up(db: Knex): Promise<void> {
  await db.raw(`
    CREATE TABLE evaluator_assignments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      exam_id uuid NOT NULL REFERENCES exams(id) ON DELETE RESTRICT,
      attempt_id uuid NOT NULL REFERENCES exam_attempts(id) ON DELETE RESTRICT,
      evaluator_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      role_type text NOT NULL DEFAULT 'EVALUATOR_1' CHECK (role_type IN ('EVALUATOR_1', 'EVALUATOR_2', 'MODERATOR')),
      status text NOT NULL DEFAULT 'ASSIGNED' CHECK (status IN ('ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'REVOKED')),
      result_version_id uuid NULL REFERENCES result_versions(id) ON DELETE RESTRICT,
      assigned_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, attempt_id, role_type)
    );
    CREATE INDEX evaluator_assignments_evaluator_idx ON evaluator_assignments(tenant_id, evaluator_user_id, status);
    CREATE INDEX evaluator_assignments_exam_idx ON evaluator_assignments(tenant_id, exam_id);

    CREATE TABLE moderation_samples (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      exam_id uuid NOT NULL REFERENCES exams(id) ON DELETE RESTRICT,
      attempt_id uuid NOT NULL REFERENCES exam_attempts(id) ON DELETE RESTRICT,
      evaluator_1_user_id uuid NULL REFERENCES users(id),
      evaluator_2_user_id uuid NULL REFERENCES users(id),
      moderator_user_id uuid NULL REFERENCES users(id),
      reason text NOT NULL CHECK (reason IN ('RANDOM_SAMPLE', 'DIVERGENCE_EXCEEDED', 'MANUAL')),
      divergence numeric(8,2) NULL,
      evaluator_1_marks numeric(8,2) NULL,
      evaluator_2_marks numeric(8,2) NULL,
      status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RESOLVED')),
      resolution_note text NULL,
      resolved_version_id uuid NULL REFERENCES result_versions(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      resolved_at timestamptz NULL
    );
    CREATE INDEX moderation_samples_exam_idx ON moderation_samples(tenant_id, exam_id, status);

    CREATE TABLE revaluation_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      attempt_id uuid NOT NULL REFERENCES exam_attempts(id) ON DELETE RESTRICT,
      requested_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      reason text NOT NULL,
      fee_ref text NULL,
      status text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED', 'APPROVED', 'REJECTED', 'DONE')),
      decision_note text NULL,
      decided_by uuid NULL REFERENCES users(id),
      decided_at timestamptz NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, attempt_id)
    );
    CREATE INDEX revaluation_requests_lookup_idx ON revaluation_requests(tenant_id, status);

    -- Row level security
    ALTER TABLE evaluator_assignments ENABLE ROW LEVEL SECURITY;
    ALTER TABLE evaluator_assignments FORCE ROW LEVEL SECURITY;

    CREATE POLICY evaluator_assignments_tenant_isolation ON evaluator_assignments
      FOR ALL
      TO examos_app
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

    GRANT SELECT, INSERT, UPDATE, DELETE ON evaluator_assignments TO examos_app;

    ALTER TABLE moderation_samples ENABLE ROW LEVEL SECURITY;
    ALTER TABLE moderation_samples FORCE ROW LEVEL SECURITY;

    CREATE POLICY moderation_samples_tenant_isolation ON moderation_samples
      FOR ALL
      TO examos_app
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

    GRANT SELECT, INSERT, UPDATE, DELETE ON moderation_samples TO examos_app;

    ALTER TABLE revaluation_requests ENABLE ROW LEVEL SECURITY;
    ALTER TABLE revaluation_requests FORCE ROW LEVEL SECURITY;

    CREATE POLICY revaluation_requests_tenant_isolation ON revaluation_requests
      FOR ALL
      TO examos_app
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

    GRANT SELECT, INSERT, UPDATE, DELETE ON revaluation_requests TO examos_app;
  `);
}

export async function down(db: Knex): Promise<void> {
  await db.raw('DROP TABLE IF EXISTS revaluation_requests, moderation_samples, evaluator_assignments CASCADE;');
}

