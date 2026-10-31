import type { Knex } from 'knex';

/**
 * 0105 — every language, subject coding profiles, build-level questions.
 *
 * - courses.code_profile: the languages a subject's coding questions may allow ({languages, default}); set by the
 *   Examination Section, untouched by ERP roster sync. NULL = any catalogue language.
 * - paper_questions.code_check: the setter's reference solution run against the samples and hidden tests
 *   ({fingerprint, passed, total, results, checkedAt, checkedBy}); approval requires a passing check of the question as
 *   it stands (the fingerprint covers spec, tests and reference, so any edit needs a new check).
 */
export async function up(db: Knex): Promise<void> {
  await db.raw(`
    ALTER TABLE courses ADD COLUMN code_profile jsonb NULL;
    ALTER TABLE paper_questions ADD COLUMN code_check jsonb NULL;
  `);
}

export async function down(db: Knex): Promise<void> {
  await db.raw(`ALTER TABLE paper_questions DROP COLUMN code_check; ALTER TABLE courses DROP COLUMN code_profile;`);
}
