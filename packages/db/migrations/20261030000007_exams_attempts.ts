import type { Knex } from 'knex';

/**
 * 0007 — Exams, allocations, attempts, preflight/admission and versioned
 * answers (spec §5–§7, §27, §32; review §3). PostgreSQL is the only authority
 * for attempt state; `authorization_generation` invalidates any cached grant.
 */
export async function up(db: Knex): Promise<void> {
  await db.raw(`
    CREATE TABLE exams (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      code text NOT NULL,
      title text NOT NULL,
      course_id uuid NULL REFERENCES courses(id) ON DELETE RESTRICT,
      status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PAPER_REVIEW','APPROVED','SCHEDULED','PRECHECK','LIVE','CLOSED','ARCHIVED','CANCELLED')),
      exam_type text NOT NULL DEFAULT 'SEM_INTERNAL' CHECK (exam_type IN ('MID_1','MID_2','SEM_INTERNAL','SEM_EXTERNAL','SUPPLEMENTARY','PRACTICAL','VIVA','ASSIGNMENT','OTHER')),
      academic_year text NULL,
      semester int NULL CHECK (semester IS NULL OR semester BETWEEN 1 AND 20),
      max_marks numeric(8,2) NULL CHECK (max_marks IS NULL OR max_marks > 0),
      security_profile text NOT NULL CHECK (security_profile IN ('PRACTICE','BASIC_BROWSER','SECURE_BYOD','MANAGED_ENDPOINT')),
      duration_minutes int NOT NULL CHECK (duration_minutes BETWEEN 5 AND 600),
      window_start_at timestamptz NOT NULL,
      window_end_at timestamptz NOT NULL,
      warning_threshold int NOT NULL DEFAULT 5 CHECK (warning_threshold BETWEEN 1 AND 20),
      policy jsonb NOT NULL DEFAULT '{}'::jsonb,
      policy_version text NOT NULL DEFAULT 'v1',
      -- human-triggered conduct (second brief, 30 Oct): nothing starts on a timer alone
      precheck_opened_at timestamptz NULL,
      precheck_opened_by uuid NULL REFERENCES users(id),
      started_at timestamptz NULL,
      started_by uuid NULL REFERENCES users(id),
      closed_at timestamptz NULL,
      closed_by uuid NULL REFERENCES users(id),
      created_by uuid NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, code),
      CHECK (window_end_at > window_start_at)
    );
    CREATE INDEX exams_hierarchy_idx ON exams(tenant_id, academic_year, semester, exam_type, status);

    -- Hall tickets are issued per exam by the Examination Section and shown per exam in the student portal.
    CREATE TABLE hall_tickets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      exam_id uuid NOT NULL REFERENCES exams(id) ON DELETE RESTRICT,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      number text NOT NULL,
      issued_by uuid NULL REFERENCES users(id),
      issued_at timestamptz NOT NULL DEFAULT now(),
      pdf_object_ref text NULL,
      verification_hash text NOT NULL,
      revoked_at timestamptz NULL,
      revoked_reason text NULL,
      UNIQUE (tenant_id, exam_id, user_id),
      UNIQUE (tenant_id, number)
    );

    CREATE TABLE exam_allocations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      exam_id uuid NOT NULL REFERENCES exams(id) ON DELETE RESTRICT,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      extra_time_minutes int NOT NULL DEFAULT 0 CHECK (extra_time_minutes BETWEEN 0 AND 240),
      accommodation_ref text NULL,
      status text NOT NULL DEFAULT 'ALLOCATED' CHECK (status IN ('ALLOCATED','REVOKED')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, exam_id, user_id)
    );

    CREATE TABLE exam_attempts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      exam_id uuid NOT NULL REFERENCES exams(id) ON DELETE RESTRICT,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      attempt_no int NOT NULL DEFAULT 1,
      status text NOT NULL DEFAULT 'ALLOCATED' CHECK (status IN ('ALLOCATED','PRECHECK_AVAILABLE','PRECHECK_RUNNING','READY','ADMITTED','ACTIVE','RECOVERY_PENDING','SUSPENDED','SUBMITTING','SUBMITTED','EXPIRED','VOIDED_BY_AUTHORITY')),
      suspension_kind text NULL CHECK (suspension_kind IS NULL OR suspension_kind IN ('WARNING_THRESHOLD','TECHNICAL_HOLD','PROCTOR_MANUAL')),
      authorization_generation int NOT NULL DEFAULT 0,
      current_epoch_id uuid NULL,
      device_session_id uuid NULL,
      admitted_at timestamptz NULL,
      started_at timestamptz NULL,
      deadline_at timestamptz NULL,
      suspended_at timestamptz NULL,
      submitted_at timestamptz NULL,
      sealed_at timestamptz NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, exam_id, user_id, attempt_no),
      CHECK ((status = 'SUSPENDED') = (suspension_kind IS NOT NULL))
    );
    CREATE UNIQUE INDEX exam_attempts_one_open
      ON exam_attempts(tenant_id, exam_id, user_id)
      WHERE status NOT IN ('SUBMITTED','EXPIRED','VOIDED_BY_AUTHORITY');
    CREATE INDEX exam_attempts_exam_status_idx ON exam_attempts(tenant_id, exam_id, status);

    CREATE TABLE precheck_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      attempt_id uuid NOT NULL REFERENCES exam_attempts(id) ON DELETE RESTRICT,
      exam_id uuid NOT NULL REFERENCES exams(id) ON DELETE RESTRICT,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      security_profile text NOT NULL,
      client_build text NULL,
      status text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','READY','REMEDIATE','REVIEW','EXPIRED')),
      ready_until timestamptz NULL,
      policy_version text NOT NULL,
      started_at timestamptz NOT NULL DEFAULT now(),
      ended_at timestamptz NULL
    );
    CREATE INDEX precheck_runs_attempt_idx ON precheck_runs(tenant_id, attempt_id, started_at DESC);

    CREATE TABLE precheck_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      precheck_run_id uuid NOT NULL REFERENCES precheck_runs(id) ON DELETE RESTRICT,
      check_code text NOT NULL,
      iteration int NOT NULL DEFAULT 1,
      status text NOT NULL CHECK (status IN ('PENDING','PASS','REMEDIATE','UNVERIFIABLE','NEED_HELP')),
      source text NOT NULL CHECK (source IN ('SERVER','SECURE_CLIENT','PRACTICE','CLIENT_DECLARED','HUMAN')),
      diagnostic_code text NULL,
      remediation_code text NULL,
      measured jsonb NOT NULL DEFAULT '{}'::jsonb,
      checked_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (precheck_run_id, check_code, iteration)
    );

    CREATE TABLE precheck_practice_saves (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      precheck_run_id uuid NOT NULL REFERENCES precheck_runs(id) ON DELETE RESTRICT,
      revision int NOT NULL,
      content_digest text NOT NULL,
      ack_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (precheck_run_id, revision)
    );

    -- Examination Section exceptions (spec §27): named, scoped, time-bounded, justified, auditable.
    CREATE TABLE admission_exceptions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      attempt_id uuid NOT NULL REFERENCES exam_attempts(id) ON DELETE RESTRICT,
      exception_code text NOT NULL CHECK (exception_code IN ('ACC_APPROVED','TECH_ALT_DEVICE','PROCTOR_OVERRIDE','POLICY_INCOMPATIBILITY')),
      covers_checks text[] NOT NULL,
      approved_by uuid NOT NULL REFERENCES users(id),
      reason text NOT NULL,
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX admission_exceptions_attempt_idx ON admission_exceptions(attempt_id) WHERE revoked_at IS NULL;

    CREATE TABLE admission_grants (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      attempt_id uuid NOT NULL REFERENCES exam_attempts(id) ON DELETE RESTRICT,
      precheck_run_id uuid NOT NULL REFERENCES precheck_runs(id) ON DELETE RESTRICT,
      exception_id uuid NULL REFERENCES admission_exceptions(id),
      jti_hash text NOT NULL UNIQUE,
      policy_version text NOT NULL,
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz NULL,
      revoked_at timestamptz NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE answer_documents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      attempt_id uuid NOT NULL REFERENCES exam_attempts(id) ON DELETE RESTRICT,
      question_id text NOT NULL,
      current_revision int NOT NULL DEFAULT 0,
      content jsonb NOT NULL DEFAULT '{"blocks":[]}'::jsonb,
      content_sha256 text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (attempt_id, question_id)
    );

    CREATE TABLE answer_revisions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      attempt_id uuid NOT NULL REFERENCES exam_attempts(id) ON DELETE RESTRICT,
      question_id text NOT NULL,
      revision int NOT NULL,
      client_operation_id uuid NOT NULL,
      ops jsonb NOT NULL,
      content_sha256 text NOT NULL,
      receipt_id uuid NOT NULL DEFAULT gen_random_uuid(),
      server_saved_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (attempt_id, question_id, revision),
      UNIQUE (attempt_id, question_id, client_operation_id)
    );
    CREATE INDEX answer_revisions_lookup_idx ON answer_revisions(attempt_id, question_id, revision DESC);

    CREATE TABLE submission_manifests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      attempt_id uuid NOT NULL UNIQUE REFERENCES exam_attempts(id) ON DELETE RESTRICT,
      manifest jsonb NOT NULL,
      manifest_sha256 text NOT NULL,
      receipt_id uuid NOT NULL DEFAULT gen_random_uuid(),
      idempotency_key uuid NOT NULL UNIQUE,
      sealed_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE attempt_event_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      attempt_id uuid NOT NULL REFERENCES exam_attempts(id) ON DELETE RESTRICT,
      seq bigserial NOT NULL,
      event_type text NOT NULL,
      actor text NOT NULL,
      question_id text NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      prev_hash text NULL,
      hash text NOT NULL,
      server_received_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX attempt_event_log_attempt_idx ON attempt_event_log(attempt_id, seq);
  `);
}

export async function down(db: Knex): Promise<void> {
  await db.raw(
    'DROP TABLE IF EXISTS attempt_event_log, submission_manifests, answer_revisions, answer_documents, admission_grants, admission_exceptions, precheck_practice_saves, precheck_items, precheck_runs, exam_attempts, exam_allocations, hall_tickets, exams CASCADE',
  );
}
