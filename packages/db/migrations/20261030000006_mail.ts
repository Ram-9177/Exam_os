import type { Knex } from 'knex';

/** 0006 — Mail templates and the mail outbox (review §6). */
export async function up(db: Knex): Promise<void> {
  await db.raw(`
    CREATE TABLE mail_templates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      code text NOT NULL,
      version int NOT NULL DEFAULT 1,
      locale text NOT NULL DEFAULT 'en',
      subject text NOT NULL,
      html text NOT NULL,
      text text NOT NULL,
      created_by uuid NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX mail_templates_unique
      ON mail_templates(COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), code, version, locale);

    CREATE TABLE mail_dispatches (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      category text NOT NULL,
      lane text NOT NULL CHECK (lane IN ('TRANSACTIONAL','BULK')),
      template_code text NOT NULL,
      template_version int NOT NULL,
      to_address text NOT NULL,
      to_name text NULL,
      subject text NOT NULL,
      body_html text NOT NULL,
      body_text text NOT NULL,
      dedupe_key text NOT NULL,
      status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','SENDING','ACCEPTED','DELIVERED','BOUNCED','FAILED')),
      attempt_count int NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      locked_at timestamptz NULL,
      transport_kind text NULL,
      provider_message_id text NULL,
      last_error text NULL,
      sent_at timestamptz NOT NULL DEFAULT 'epoch',
      accepted_at timestamptz NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, dedupe_key)
    );
    CREATE INDEX mail_dispatches_claim_idx ON mail_dispatches(lane, status, next_attempt_at) WHERE status IN ('QUEUED','SENDING');
    CREATE INDEX mail_dispatches_provider_idx ON mail_dispatches(provider_message_id) WHERE provider_message_id IS NOT NULL;
  `);
}

export async function down(db: Knex): Promise<void> {
  await db.raw('DROP TABLE IF EXISTS mail_dispatches, mail_templates CASCADE');
}
