import type { Knex } from 'knex';

/**
 * 0005 — Integration layer (review §5): idempotency, roster sync audit,
 * the transactional outbox, the integration event log, webhook endpoints and
 * deliveries.
 */
export async function up(db: Knex): Promise<void> {
  await db.raw(`
    CREATE TABLE idempotency_keys (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      scope text NOT NULL,
      key text NOT NULL,
      request_hash text NOT NULL,
      response_status int NULL,
      response_body jsonb NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      UNIQUE (tenant_id, scope, key)
    );
    CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys(expires_at);

    CREATE TABLE roster_sync_jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      source text NOT NULL CHECK (source IN ('PUSH_API','XLSX','ADAPTER')),
      connection_id uuid NULL REFERENCES tenant_erp_connections(id),
      api_key_id uuid NULL REFERENCES api_keys(id),
      actor_user_id uuid NULL REFERENCES users(id),
      entity text NOT NULL CHECK (entity IN ('PERSON','ACADEMIC_UNIT','COURSE','ENROLLMENT')),
      mode text NOT NULL CHECK (mode IN ('UPSERT','CREATE_ONLY','UPDATE_ONLY')),
      status text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','COMPLETED','COMPLETED_WITH_ERRORS','FAILED')),
      summary jsonb NOT NULL DEFAULT '{}'::jsonb,
      source_label text NULL,
      started_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz NULL
    );
    CREATE INDEX roster_sync_jobs_tenant_idx ON roster_sync_jobs(tenant_id, started_at DESC);

    CREATE TABLE roster_sync_rows (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      job_id uuid NOT NULL REFERENCES roster_sync_jobs(id) ON DELETE RESTRICT,
      row_index int NOT NULL,
      external_id text NULL,
      outcome text NOT NULL CHECK (outcome IN ('CREATED','UPDATED','UNCHANGED','REJECTED','IDENTITY_CONFLICT')),
      code text NULL,
      message text NULL,
      before_value jsonb NULL,
      after_value jsonb NULL,
      UNIQUE (job_id, row_index)
    );

    -- Canonical integration event log; the cursor feed reads it by seq.
    CREATE TABLE integration_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      seq bigserial NOT NULL UNIQUE,
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      type text NOT NULL,
      aggregate_type text NOT NULL,
      aggregate_id uuid NULL,
      occurred_at timestamptz NOT NULL DEFAULT now(),
      payload jsonb NOT NULL
    );
    CREATE INDEX integration_events_tenant_seq_idx ON integration_events(tenant_id, seq);

    -- Transactional outbox shared by webhooks, mail and internal jobs.
    CREATE TABLE outbox_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      channel text NOT NULL CHECK (channel IN ('WEBHOOK','MAIL','INTERNAL')),
      event_type text NOT NULL,
      aggregate_type text NOT NULL,
      aggregate_id uuid NULL,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','DONE','FAILED')),
      attempts int NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      locked_at timestamptz NULL,
      last_error text NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      processed_at timestamptz NULL
    );
    CREATE INDEX outbox_events_claim_idx ON outbox_events(status, next_attempt_at) WHERE status IN ('PENDING','PROCESSING');

    CREATE TABLE webhook_endpoints (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      connection_id uuid NULL REFERENCES tenant_erp_connections(id),
      url text NOT NULL,
      description text NULL,
      secret_ciphertext text NOT NULL,
      event_types text[] NOT NULL,
      status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
      created_by uuid NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE webhook_deliveries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      endpoint_id uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE RESTRICT,
      integration_event_id uuid NOT NULL REFERENCES integration_events(id) ON DELETE RESTRICT,
      event_type text NOT NULL,
      status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','DELIVERED','RETRYING','DEAD')),
      attempts int NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      locked_at timestamptz NULL,
      last_status_code int NULL,
      last_error text NULL,
      delivered_at timestamptz NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (endpoint_id, integration_event_id)
    );
    CREATE INDEX webhook_deliveries_claim_idx ON webhook_deliveries(status, next_attempt_at) WHERE status IN ('PENDING','RETRYING');
  `);
}

export async function down(db: Knex): Promise<void> {
  await db.raw('DROP TABLE IF EXISTS webhook_deliveries, webhook_endpoints, outbox_events, integration_events, roster_sync_rows, roster_sync_jobs, idempotency_keys CASCADE');
}
