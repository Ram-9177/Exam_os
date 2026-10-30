import type { Knex } from 'knex';

/**
 * 0009 — Post-seal candidate pipeline (spec §46, review §3 and §2 item 9):
 * `candidate_review_packets` is the gate row locked FOR UPDATE; `result_versions`
 * is the immutable academic artifact; approvals bind to an exact result version
 * and are invalidated when a newer version appears.
 */
export async function up(db: Knex): Promise<void> {
  await db.raw(`
    CREATE TABLE result_versions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      attempt_id uuid NOT NULL REFERENCES exam_attempts(id) ON DELETE RESTRICT,
      version int NOT NULL,
      total_marks numeric(8,2) NOT NULL CHECK (total_marks >= 0),
      max_marks numeric(8,2) NOT NULL CHECK (max_marks >= 0),
      items jsonb NOT NULL,
      approved_by uuid NULL REFERENCES users(id),
      approved_at timestamptz NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (attempt_id, version),
      CHECK (total_marks <= max_marks)
    );

    CREATE TABLE candidate_review_packets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      attempt_id uuid NOT NULL UNIQUE REFERENCES exam_attempts(id) ON DELETE RESTRICT,
      exam_id uuid NOT NULL REFERENCES exams(id) ON DELETE RESTRICT,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      status text NOT NULL DEFAULT 'ATTEMPT_SEALED' CHECK (status IN (
        'ATTEMPT_SEALED','FORENSIC_CHECKS_RUNNING','FORENSIC_REVIEW_READY','ACADEMIC_MARKING_READY','EXAM_CELL_REVIEW',
        'CANDIDATE_APPROVED','CONTROLLER_AUTHORIZED','PUBLISHED','TECHNICAL_REVIEW_REQUIRED','IDENTITY_REVIEW_REQUIRED',
        'INTEGRITY_HOLD','MARKING_MODERATION_REQUIRED','REVALUATION_PENDING','RESCHEDULE_APPROVED','INVALIDATED_BY_AUTHORIZED_DECISION')),
      version int NOT NULL DEFAULT 1,
      result_version_id uuid NULL REFERENCES result_versions(id),
      academic_state text NOT NULL DEFAULT 'PENDING',
      identity_state text NOT NULL DEFAULT 'PENDING',
      integrity_state text NOT NULL DEFAULT 'PENDING',
      media_quality_state text NOT NULL DEFAULT 'PENDING',
      sealed_submission_verified boolean NOT NULL DEFAULT false,
      checklist_digest text NULL,
      hold_reason text NULL,
      published_at timestamptz NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX candidate_packets_exam_status_idx ON candidate_review_packets(tenant_id, exam_id, status);

    CREATE TABLE candidate_approvals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      packet_id uuid NOT NULL REFERENCES candidate_review_packets(id) ON DELETE RESTRICT,
      result_version_id uuid NOT NULL REFERENCES result_versions(id) ON DELETE RESTRICT,
      packet_version int NOT NULL,
      approver_user_id uuid NOT NULL REFERENCES users(id),
      decision text NOT NULL CHECK (decision IN ('APPROVED','RETURNED')),
      policy_version text NOT NULL,
      checklist_digest text NOT NULL,
      reason text NOT NULL,
      idempotency_key uuid NOT NULL,
      invalidated_at timestamptz NULL,
      invalidated_reason text NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, idempotency_key)
    );
    CREATE UNIQUE INDEX candidate_approvals_one_live ON candidate_approvals(packet_id) WHERE decision = 'APPROVED' AND invalidated_at IS NULL;

    CREATE TABLE controller_publication_grants (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      candidate_approval_id uuid NOT NULL UNIQUE REFERENCES candidate_approvals(id) ON DELETE RESTRICT,
      packet_id uuid NOT NULL REFERENCES candidate_review_packets(id) ON DELETE RESTRICT,
      result_version_id uuid NOT NULL REFERENCES result_versions(id) ON DELETE RESTRICT,
      controller_user_id uuid NOT NULL REFERENCES users(id),
      idempotency_key uuid NOT NULL,
      authorized_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, idempotency_key)
    );
  `);
}

export async function down(db: Knex): Promise<void> {
  await db.raw('DROP TABLE IF EXISTS controller_publication_grants, candidate_approvals, candidate_review_packets, result_versions CASCADE');
}
