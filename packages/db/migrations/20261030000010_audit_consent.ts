import type { Knex } from 'knex';

/**
 * 0010 — Append-only audit log with a per-tenant hash chain, and consent
 * records for camera/microphone/face-reference capture (review §2 item 13).
 * A trigger refuses UPDATE/DELETE on audit_events regardless of role; migration
 * 0011 additionally revokes those privileges from the application role.
 */
export async function up(db: Knex): Promise<void> {
  await db.raw(`
    CREATE TABLE audit_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      seq bigserial NOT NULL UNIQUE,
      tenant_id uuid NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      actor_type text NOT NULL CHECK (actor_type IN ('USER','API_KEY','SYSTEM','PLATFORM')),
      actor_id text NULL,
      action text NOT NULL,
      entity_type text NOT NULL,
      entity_id text NULL,
      request_id text NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      prev_hash text NULL,
      hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX audit_events_tenant_idx ON audit_events(tenant_id, seq);
    CREATE INDEX audit_events_entity_idx ON audit_events(entity_type, entity_id);

    CREATE OR REPLACE FUNCTION examos_forbid_mutation() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
      FOR EACH ROW EXECUTE FUNCTION examos_forbid_mutation();
    CREATE TRIGGER answer_revisions_append_only BEFORE UPDATE OR DELETE ON answer_revisions
      FOR EACH ROW EXECUTE FUNCTION examos_forbid_mutation();
    CREATE TRIGGER proctor_warnings_append_only BEFORE UPDATE OR DELETE ON proctor_warnings
      FOR EACH ROW EXECUTE FUNCTION examos_forbid_mutation();
    CREATE TRIGGER attempt_event_log_append_only BEFORE UPDATE OR DELETE ON attempt_event_log
      FOR EACH ROW EXECUTE FUNCTION examos_forbid_mutation();

    CREATE TABLE consent_records (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      exam_id uuid NULL REFERENCES exams(id) ON DELETE RESTRICT,
      policy_version text NOT NULL,
      purpose text NOT NULL CHECK (purpose IN ('CAMERA','MICROPHONE','FACE_REFERENCE','SCREEN')),
      given_at timestamptz NOT NULL DEFAULT now(),
      withdrawn_at timestamptz NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX consent_records_lookup_idx ON consent_records(tenant_id, user_id, exam_id, purpose) WHERE withdrawn_at IS NULL;
  `);
}

export async function down(db: Knex): Promise<void> {
  await db.raw(`
    DROP TABLE IF EXISTS consent_records CASCADE;
    DROP TRIGGER IF EXISTS attempt_event_log_append_only ON attempt_event_log;
    DROP TRIGGER IF EXISTS proctor_warnings_append_only ON proctor_warnings;
    DROP TRIGGER IF EXISTS answer_revisions_append_only ON answer_revisions;
    DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events;
    DROP TABLE IF EXISTS audit_events CASCADE;
    DROP FUNCTION IF EXISTS examos_forbid_mutation();
  `);
}
