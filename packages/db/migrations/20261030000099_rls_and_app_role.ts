import type { Knex } from 'knex';
import { APPEND_ONLY_TABLES, TENANT_TABLES } from '../src/index.ts';

/**
 * 0099 — Application role and row-level security (review §4, isolation layer 2).
 *
 * The API connects as `examos_app`, which is not a superuser, does not own the
 * tables and has no BYPASSRLS. Every tenant table gets a policy that only sees
 * rows whose tenant_id equals the transaction-local GUC `app.tenant_id`. Workers
 * that claim jobs across tenants set `app.bypass_tenant = 'worker'`; request
 * handlers never do (see packages/db withWorkerTx docs).
 *
 * Append-only tables get INSERT/SELECT only at the privilege level, in addition
 * to the triggers from migration 0010.
 */
const APP_ROLE = 'examos_app';

function quoteLiteral(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

export async function up(db: Knex): Promise<void> {
  const password = process.env['EXAMOS_APP_DB_PASSWORD'] ?? 'examos_app';
  await db.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        EXECUTE 'CREATE ROLE ${APP_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD ' || ${quoteLiteral(quoteLiteral(password))};
      END IF;
    END $$;
  `);

  const dbNameRow = await db.raw('SELECT current_database() AS db');
  const dbName: string = dbNameRow.rows[0].db;
  await db.raw(`GRANT CONNECT ON DATABASE "${dbName}" TO ${APP_ROLE}`);
  await db.raw(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
  await db.raw(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`);

  // Platform-level tables: readable by the app, writable for tenant provisioning.
  await db.raw(`GRANT SELECT, INSERT, UPDATE ON tenant_groups, tenants, tenant_domains TO ${APP_ROLE}`);
  await db.raw(`GRANT SELECT, INSERT, UPDATE ON mail_templates TO ${APP_ROLE}`);
  await db.raw(`GRANT SELECT ON v_student_semester_summary, v_student_overall_summary TO ${APP_ROLE}`);

  const appendOnly = new Set<string>(APPEND_ONLY_TABLES);
  for (const table of TENANT_TABLES) {
    // Tables created by later migrations (0100+) enable RLS themselves.
    if (!(await db.schema.hasTable(table))) continue;
    if (appendOnly.has(table)) {
      await db.raw(`GRANT SELECT, INSERT ON ${table} TO ${APP_ROLE}`);
    } else if (table === 'proctor_events') {
      // raw events are immutable except for the grouping pointer
      await db.raw(`GRANT SELECT, INSERT ON ${table} TO ${APP_ROLE}`);
      await db.raw(`GRANT UPDATE (incident_id) ON ${table} TO ${APP_ROLE}`);
    } else {
      await db.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO ${APP_ROLE}`);
    }
    await db.raw(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
    await db.raw(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    await db.raw(`
      CREATE POLICY tenant_isolation ON ${table}
        FOR ALL TO ${APP_ROLE}
        USING (
          tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
          OR current_setting('app.bypass_tenant', true) = 'worker'
        )
        WITH CHECK (
          tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
          OR current_setting('app.bypass_tenant', true) = 'worker'
        )
    `);
  }

  // audit_events: append-only, tenant_id nullable (platform actions).
  await db.raw(`GRANT SELECT, INSERT ON audit_events TO ${APP_ROLE}`);
  await db.raw(`ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY`);
  await db.raw(`ALTER TABLE audit_events FORCE ROW LEVEL SECURITY`);
  await db.raw(`
    CREATE POLICY tenant_isolation ON audit_events
      FOR ALL TO ${APP_ROLE}
      USING (
        tenant_id IS NULL
        OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.bypass_tenant', true) IN ('worker','platform')
      )
      WITH CHECK (
        tenant_id IS NULL
        OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.bypass_tenant', true) IN ('worker','platform')
      )
  `);

  // mail_templates: platform defaults (tenant_id NULL) visible to every tenant.
  await db.raw(`ALTER TABLE mail_templates ENABLE ROW LEVEL SECURITY`);
  await db.raw(`ALTER TABLE mail_templates FORCE ROW LEVEL SECURITY`);
  await db.raw(`
    CREATE POLICY tenant_isolation ON mail_templates
      FOR ALL TO ${APP_ROLE}
      USING (
        tenant_id IS NULL
        OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.bypass_tenant', true) = 'worker'
      )
      WITH CHECK (
        tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
        OR current_setting('app.bypass_tenant', true) IN ('worker','platform')
      )
  `);
}

export async function down(db: Knex): Promise<void> {
  for (const table of [...TENANT_TABLES, 'audit_events', 'mail_templates']) {
    if (!(await db.schema.hasTable(table))) continue;
    await db.raw(`DROP POLICY IF EXISTS tenant_isolation ON ${table}`);
    await db.raw(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`);
    await db.raw(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`);
  }
  await db.raw(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${APP_ROLE}`);
  await db.raw(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${APP_ROLE}`);
  await db.raw(`REVOKE USAGE ON SCHEMA public FROM ${APP_ROLE}`);
}
