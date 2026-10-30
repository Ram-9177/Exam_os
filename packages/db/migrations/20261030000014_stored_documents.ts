import type { Knex } from 'knex';

const DOC_KINDS = ['BOOKLET_PDF', 'HALL_TICKET_PDF', 'EVIDENCE_PDF'] as const;

export async function up(db: Knex): Promise<void> {
  const kindsList = DOC_KINDS.map((k) => `'${k}'`).join(',');
  await db.raw(`
    CREATE TABLE stored_documents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      doc_kind text NOT NULL CHECK (doc_kind IN (${kindsList})),
      entity_id text NOT NULL,
      blob_ref text NOT NULL,
      sha256 text NOT NULL,
      byte_length int NOT NULL,
      mime_type text NOT NULL DEFAULT 'application/pdf',
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, doc_kind, entity_id)
    );
    CREATE INDEX stored_documents_lookup_idx ON stored_documents(tenant_id, doc_kind, entity_id);

    ALTER TABLE stored_documents ENABLE ROW LEVEL SECURITY;
    ALTER TABLE stored_documents FORCE ROW LEVEL SECURITY;

    CREATE POLICY stored_documents_tenant_isolation ON stored_documents
      FOR ALL
      TO examos_app
      USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

    GRANT SELECT, INSERT, UPDATE, DELETE ON stored_documents TO examos_app;
  `);
}

export async function down(db: Knex): Promise<void> {
  await db.raw('DROP TABLE IF EXISTS stored_documents CASCADE;');
}
