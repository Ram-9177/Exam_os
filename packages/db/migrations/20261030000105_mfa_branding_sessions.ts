import type { Knex } from 'knex';

export async function up(db: Knex): Promise<void> {
  await db.raw(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS totp_secret_ref text NULL,
      ADD COLUMN IF NOT EXISTS totp_enabled boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS totp_last_step bigint NOT NULL DEFAULT -1,
      ADD COLUMN IF NOT EXISTS recovery_codes text[] NULL;

    ALTER TABLE tenants
      ADD COLUMN IF NOT EXISTS branding jsonb NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS sessions_revoked_at timestamptz NULL;
  `);
}

export async function down(db: Knex): Promise<void> {
  await db.raw(`
    ALTER TABLE users
      DROP COLUMN IF EXISTS totp_secret_ref,
      DROP COLUMN IF EXISTS totp_enabled,
      DROP COLUMN IF EXISTS totp_last_step,
      DROP COLUMN IF EXISTS recovery_codes;

    ALTER TABLE tenants
      DROP COLUMN IF EXISTS branding,
      DROP COLUMN IF EXISTS sessions_revoked_at;
  `);
}
