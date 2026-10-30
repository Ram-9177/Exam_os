import type { Knex } from 'knex';

const KINDS = ['PHOTO', 'ID_CARD', 'HALL_TICKET'] as const;

export async function up(db: Knex): Promise<void> {
  const kindsList = KINDS.map((k) => `'${k}'`).join(',');
  await db.raw(`
    CREATE TABLE student_documents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      kind text NOT NULL CHECK (kind IN (${kindsList})),
      blob_ref text NOT NULL,
      sha256 text NOT NULL,
      mime_type text NOT NULL,
      byte_length int NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, user_id, kind)
    );
    CREATE INDEX student_documents_lookup_idx ON student_documents(tenant_id, user_id, kind);

    ALTER TABLE student_documents ENABLE ROW LEVEL SECURITY;
    ALTER TABLE student_documents FORCE ROW LEVEL SECURITY;

    CREATE POLICY student_documents_tenant_isolation ON student_documents
      FOR ALL
      TO examos_app
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

    GRANT SELECT, INSERT, UPDATE, DELETE ON student_documents TO examos_app;
  `);
}

export async function down(db: Knex): Promise<void> {
  await db.raw('DROP TABLE IF EXISTS student_documents CASCADE;');
}

