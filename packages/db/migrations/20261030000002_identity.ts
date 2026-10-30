import type { Knex } from 'knex';

/**
 * 0002 — Identity. Users are tenant-scoped. The only stable external key is
 * external_identities(tenant_id, provider, external_id); e-mail is an attribute.
 * Permissions are derived from role_grants on every request (never JWT claims).
 */
export async function up(db: Knex): Promise<void> {
  await db.raw(`
    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      email text NOT NULL CHECK (email = lower(email)),
      full_name text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('STUDENT','STAFF')),
      status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE','SUSPENDED','PENDING_ACTIVATION')),
      password_hash text NULL,
      failed_login_count int NOT NULL DEFAULT 0,
      locked_until timestamptz NULL,
      last_login_at timestamptz NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, email)
    );
    CREATE INDEX users_tenant_kind_idx ON users(tenant_id, kind, status);

    CREATE TABLE external_identities (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      provider text NOT NULL,
      external_id text NOT NULL,
      attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, provider, external_id),
      UNIQUE (tenant_id, provider, user_id)
    );

    CREATE TABLE role_grants (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      role_code text NOT NULL,
      scope_type text NOT NULL DEFAULT 'TENANT' CHECK (scope_type IN ('TENANT','TENANT_GROUP','DEPARTMENT','PROGRAMME','COURSE','EXAM')),
      scope_id uuid NULL,
      effective_from timestamptz NOT NULL DEFAULT now(),
      effective_until timestamptz NULL,
      granted_by uuid NULL REFERENCES users(id),
      revoked_at timestamptz NULL,
      revoked_by uuid NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX role_grants_active_unique
      ON role_grants(tenant_id, user_id, role_code, scope_type, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid))
      WHERE revoked_at IS NULL;
    CREATE INDEX role_grants_user_idx ON role_grants(tenant_id, user_id) WHERE revoked_at IS NULL;

    CREATE TABLE auth_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      family_id uuid NOT NULL,
      refresh_token_hash text NOT NULL UNIQUE,
      parent_id uuid NULL REFERENCES auth_sessions(id),
      client_fingerprint text NULL,
      issued_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      rotated_at timestamptz NULL,
      revoked_at timestamptz NULL,
      revoked_reason text NULL
    );
    CREATE INDEX auth_sessions_family_idx ON auth_sessions(family_id);

    CREATE TABLE one_time_tokens (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      purpose text NOT NULL CHECK (purpose IN ('ACTIVATION','PASSWORD_RESET')),
      token_hash text NOT NULL UNIQUE,
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export async function down(db: Knex): Promise<void> {
  await db.raw('DROP TABLE IF EXISTS one_time_tokens, auth_sessions, role_grants, external_identities, users CASCADE');
}
