import type { Knex } from 'knex';

/**
 * 0103 — User signatures for digital document mapping (hall tickets, booklets, examiner validations).
 */
export async function up(db: Knex): Promise<void> {
  await db.raw(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS signature_data_url text NULL,
      ADD COLUMN IF NOT EXISTS signature_updated_at timestamptz NULL;
  `);
}

export async function down(db: Knex): Promise<void> {
  await db.raw(`
    ALTER TABLE users
      DROP COLUMN IF EXISTS signature_data_url,
      DROP COLUMN IF EXISTS signature_updated_at;
  `);
}

