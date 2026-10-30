import type { Knex } from 'knex';

/**
 * 0003 — Per-tenant configuration: SSO, mail transport, ERP connections and
 * integration API keys (review §4, §5, §6). Secrets are vault references or
 * AES-GCM ciphertext, never plaintext columns.
 */
export async function up(db: Knex): Promise<void> {
  await db.raw(`
    CREATE TABLE tenant_sso_configs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE RESTRICT,
      issuer text NOT NULL,
      client_id text NOT NULL,
      client_secret_ref text NULL,
      allowed_email_domains text[] NOT NULL DEFAULT '{}',
      enabled boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE tenant_mail_configs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      category text NULL,
      transport_kind text NOT NULL CHECK (transport_kind IN ('power-automate','smtp-oauth2','graph','smtp-relay','capture')),
      sender_address text NOT NULL CHECK (sender_address = lower(sender_address)),
      sender_name text NOT NULL DEFAULT 'Examination Cell',
      endpoint_ref text NULL,
      token_ref text NULL,
      callback_secret_ref text NULL,
      settings jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX tenant_mail_configs_unique ON tenant_mail_configs(tenant_id, COALESCE(category, ''));

    CREATE TABLE tenant_erp_connections (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      provider text NOT NULL,
      label text NOT NULL,
      base_url text NULL,
      credential_ref text NULL,
      webhook_secret_ref text NULL,
      sync_schedule_cron text NULL,
      mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
      status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
      last_sync_at timestamptz NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, provider, label)
    );

    CREATE TABLE api_keys (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      connection_id uuid NULL REFERENCES tenant_erp_connections(id) ON DELETE RESTRICT,
      label text NOT NULL,
      key_id text NOT NULL UNIQUE,
      secret_hash text NOT NULL,
      scopes text[] NOT NULL,
      allowed_ips inet[] NULL,
      expires_at timestamptz NULL,
      last_used_at timestamptz NULL,
      revoked_at timestamptz NULL,
      created_by uuid NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export async function down(db: Knex): Promise<void> {
  await db.raw('DROP TABLE IF EXISTS api_keys, tenant_erp_connections, tenant_mail_configs, tenant_sso_configs CASCADE');
}
