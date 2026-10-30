import type { Knex } from 'knex';

/**
 * 0017 — Mail completeness and external bulk transports (Phase 7):
 * Add 'acs-email' and 'ses' to tenant_mail_configs transport_kind check constraint,
 * and add indexes for bounce reconciliation and mail quota/health analytics.
 */
export async function up(db: Knex): Promise<void> {
  await db.raw(`
    ALTER TABLE tenant_mail_configs
      DROP CONSTRAINT IF EXISTS tenant_mail_configs_transport_kind_check;

    ALTER TABLE tenant_mail_configs
      ADD CONSTRAINT tenant_mail_configs_transport_kind_check
      CHECK (transport_kind IN ('power-automate','smtp-oauth2','graph','smtp-relay','capture','acs-email','ses'));

    CREATE INDEX IF NOT EXISTS mail_dispatches_tenant_status_idx
      ON mail_dispatches(tenant_id, status, created_at DESC);

    CREATE INDEX IF NOT EXISTS mail_dispatches_tenant_to_address_idx
      ON mail_dispatches(tenant_id, to_address);
  `);
}

export async function down(db: Knex): Promise<void> {
  await db.raw(`
    DROP INDEX IF EXISTS mail_dispatches_tenant_to_address_idx;
    DROP INDEX IF EXISTS mail_dispatches_tenant_status_idx;

    ALTER TABLE tenant_mail_configs
      DROP CONSTRAINT IF EXISTS tenant_mail_configs_transport_kind_check;

    ALTER TABLE tenant_mail_configs
      ADD CONSTRAINT tenant_mail_configs_transport_kind_check
      CHECK (transport_kind IN ('power-automate','smtp-oauth2','graph','smtp-relay','capture'));
  `);
}

