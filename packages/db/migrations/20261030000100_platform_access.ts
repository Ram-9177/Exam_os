import type { Knex } from 'knex';

export async function up(db: Knex): Promise<void> {
  await db.raw(`
    ALTER TABLE tenants ADD COLUMN staff_login_limit integer NOT NULL DEFAULT 4 CHECK (staff_login_limit IN (3,4));
    CREATE TABLE platform_admins (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      singleton boolean NOT NULL DEFAULT true UNIQUE CHECK (singleton),
      email text NOT NULL UNIQUE,
      password_hash text NOT NULL,
      totp_secret_ref text NOT NULL,
      last_totp_step bigint NOT NULL DEFAULT -1,
      failed_attempts integer NOT NULL DEFAULT 0,
      locked_until timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE platform_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      admin_id uuid NOT NULL REFERENCES platform_admins(id),
      token_hash text NOT NULL UNIQUE,
      ip text,
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    GRANT SELECT, INSERT, UPDATE ON platform_admins, platform_sessions TO examos_app;
    GRANT DELETE ON tenant_domains TO examos_app;
    CREATE FUNCTION enforce_staff_login_limit() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE cap integer;
    BEGIN
      IF NEW.kind = 'STAFF' AND NEW.status IN ('ACTIVE','PENDING_ACTIVATION') THEN
        SELECT staff_login_limit INTO cap FROM tenants WHERE id = NEW.tenant_id FOR NO KEY UPDATE;
        IF (SELECT count(*) FROM users WHERE tenant_id = NEW.tenant_id AND kind = 'STAFF'
            AND status IN ('ACTIVE','PENDING_ACTIVATION') AND id <> NEW.id) >= cap THEN
          RAISE EXCEPTION 'STAFF_LOGIN_LIMIT' USING ERRCODE = '23514';
        END IF;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER staff_login_limit BEFORE INSERT OR UPDATE OF kind,status ON users
      FOR EACH ROW EXECUTE FUNCTION enforce_staff_login_limit();
    CREATE FUNCTION enforce_student_roles() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE user_kind text;
    BEGIN
      SELECT kind INTO user_kind FROM users WHERE id = NEW.user_id AND tenant_id = NEW.tenant_id;
      IF user_kind IS NULL OR (user_kind = 'STUDENT') <> (NEW.role_code = 'STUDENT') THEN
        RAISE EXCEPTION 'ROLE_KIND_MISMATCH' USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER student_roles BEFORE INSERT OR UPDATE OF role_code,user_id ON role_grants
      FOR EACH ROW EXECUTE FUNCTION enforce_student_roles();
  `);
}

export async function down(db: Knex): Promise<void> {
  await db.raw(`DROP TRIGGER student_roles ON role_grants; DROP FUNCTION enforce_student_roles();
    DROP TRIGGER staff_login_limit ON users; DROP FUNCTION enforce_staff_login_limit();
    DROP TABLE platform_sessions, platform_admins; ALTER TABLE tenants DROP COLUMN staff_login_limit;`);
}
