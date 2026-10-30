import type { Knex } from 'knex';

/**
 * 0008 — Proctoring: raw events, grouped incidents, warning epochs and the
 * countable-warning ledger (spec §9, §18, §30). A warning row can exist at most
 * once per incident per epoch, and only a decision row creates it.
 */
export async function up(db: Knex): Promise<void> {
  await db.raw(`
    CREATE TABLE proctor_incidents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      attempt_id uuid NOT NULL REFERENCES exam_attempts(id) ON DELETE RESTRICT,
      exam_id uuid NOT NULL REFERENCES exams(id) ON DELETE RESTRICT,
      signal_class text NOT NULL,
      status text NOT NULL DEFAULT 'PROCTOR_REVIEW' CHECK (status IN ('TECHNICAL','DISMISSED','PROCTOR_REVIEW','CONFIRMED_COUNTABLE_WARNING')),
      first_event_at timestamptz NOT NULL,
      last_event_at timestamptz NOT NULL,
      event_count int NOT NULL DEFAULT 1,
      priority int NOT NULL DEFAULT 50,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX proctor_incidents_queue_idx ON proctor_incidents(tenant_id, exam_id, status, priority DESC, created_at);
    CREATE INDEX proctor_incidents_attempt_idx ON proctor_incidents(attempt_id, signal_class, last_event_at DESC);

    CREATE TABLE proctor_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      attempt_id uuid NOT NULL REFERENCES exam_attempts(id) ON DELETE RESTRICT,
      source_id text NOT NULL,
      source_event_id text NOT NULL,
      signal_class text NOT NULL,
      client_recorded_at timestamptz NULL,
      client_sequence bigint NULL,
      server_received_at timestamptz NOT NULL DEFAULT now(),
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      incident_id uuid NULL REFERENCES proctor_incidents(id) ON DELETE RESTRICT,
      UNIQUE (tenant_id, source_id, source_event_id)
    );
    CREATE INDEX proctor_events_attempt_idx ON proctor_events(attempt_id, server_received_at);

    CREATE TABLE warning_epochs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      attempt_id uuid NOT NULL REFERENCES exam_attempts(id) ON DELETE RESTRICT,
      epoch_no int NOT NULL,
      confirmed_count int NOT NULL DEFAULT 0,
      opened_at timestamptz NOT NULL DEFAULT now(),
      closed_at timestamptz NULL,
      opened_by uuid NULL REFERENCES users(id),
      reason text NULL,
      UNIQUE (attempt_id, epoch_no)
    );
    CREATE UNIQUE INDEX warning_epochs_one_open ON warning_epochs(attempt_id) WHERE closed_at IS NULL;
    ALTER TABLE exam_attempts ADD CONSTRAINT exam_attempts_current_epoch_fk FOREIGN KEY (current_epoch_id) REFERENCES warning_epochs(id);

    CREATE TABLE proctor_decisions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      attempt_id uuid NOT NULL REFERENCES exam_attempts(id) ON DELETE RESTRICT,
      incident_id uuid NULL REFERENCES proctor_incidents(id) ON DELETE RESTRICT,
      actor_user_id uuid NULL REFERENCES users(id),
      actor_type text NOT NULL DEFAULT 'HUMAN' CHECK (actor_type IN ('HUMAN','SERVER_POLICY')),
      action text NOT NULL,
      reason_code text NOT NULL,
      notes text NULL,
      idempotency_key uuid NOT NULL,
      resulting_attempt_status text NOT NULL,
      warning_count_after int NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, idempotency_key)
    );

    CREATE TABLE proctor_warnings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      attempt_id uuid NOT NULL REFERENCES exam_attempts(id) ON DELETE RESTRICT,
      incident_id uuid NOT NULL REFERENCES proctor_incidents(id) ON DELETE RESTRICT,
      warning_epoch_id uuid NOT NULL REFERENCES warning_epochs(id) ON DELETE RESTRICT,
      warning_no int NOT NULL,
      decision_id uuid NOT NULL REFERENCES proctor_decisions(id) ON DELETE RESTRICT,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (incident_id, warning_epoch_id),
      UNIQUE (warning_epoch_id, warning_no)
    );

    CREATE TABLE resume_grants (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      attempt_id uuid NOT NULL REFERENCES exam_attempts(id) ON DELETE RESTRICT,
      decision_id uuid NOT NULL REFERENCES proctor_decisions(id) ON DELETE RESTRICT,
      actor_user_id uuid NOT NULL REFERENCES users(id),
      from_epoch_id uuid NULL REFERENCES warning_epochs(id),
      to_epoch_id uuid NULL REFERENCES warning_epochs(id),
      reason_code text NOT NULL,
      notes text NOT NULL,
      deadline_extension_minutes int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export async function down(db: Knex): Promise<void> {
  await db.raw('ALTER TABLE exam_attempts DROP CONSTRAINT IF EXISTS exam_attempts_current_epoch_fk');
  await db.raw('DROP TABLE IF EXISTS resume_grants, proctor_warnings, proctor_decisions, warning_epochs, proctor_events, proctor_incidents CASCADE');
}
