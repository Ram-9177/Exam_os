import type { Knex } from 'knex';

/** These three were protected by grants only; AGENTS.md rule 4 promises privilege and trigger on every evidence table. */
const TABLES = ['submission_manifests', 'resume_grants', 'controller_publication_grants'];

export async function up(knex: Knex): Promise<void> {
  for (const t of TABLES) {
    await knex.raw(`CREATE TRIGGER ${t}_append_only BEFORE UPDATE OR DELETE ON ${t} FOR EACH ROW EXECUTE FUNCTION examos_forbid_mutation()`);
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const t of TABLES) await knex.raw(`DROP TRIGGER IF EXISTS ${t}_append_only ON ${t}`);
}
