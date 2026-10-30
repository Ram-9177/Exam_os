import type { Knex } from 'knex';

/**
 * 0001 — Tenancy root (review §4). Tenants are campuses/institutions; a tenant
 * group is St. Mary's Group for read-only cross-campus reporting.
 */
export async function up(db: Knex): Promise<void> {
  await db.raw('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await db.raw(`
    CREATE TABLE tenant_groups (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code text NOT NULL UNIQUE,
      name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE tenants (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$'),
      name text NOT NULL,
      group_id uuid NULL REFERENCES tenant_groups(id) ON DELETE RESTRICT,
      timezone text NOT NULL DEFAULT 'Asia/Kolkata',
      locale text NOT NULL DEFAULT 'en-IN',
      status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED')),
      settings jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE tenant_domains (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      host text NOT NULL UNIQUE CHECK (host = lower(host)),
      is_primary boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX tenant_domains_one_primary ON tenant_domains(tenant_id) WHERE is_primary;
  `);
}

export async function down(db: Knex): Promise<void> {
  await db.raw('DROP TABLE IF EXISTS tenant_domains, tenants, tenant_groups CASCADE');
}
