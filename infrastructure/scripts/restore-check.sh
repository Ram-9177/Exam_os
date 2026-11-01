#!/usr/bin/env bash
# Proves a backup can be restored: restores it into a scratch database, then compares row counts of every table
# with the source and checks the migration history is complete. Run it after every backup change and at least monthly.
#   SOURCE_DATABASE_URL=… ADMIN_DATABASE_URL=postgres://…/postgres  infrastructure/scripts/restore-check.sh backups/examos-….dump
set -euo pipefail
dump="${1:?usage: restore-check.sh <dump file>}"
: "${SOURCE_DATABASE_URL:?set SOURCE_DATABASE_URL (the database the dump came from)}"
: "${ADMIN_DATABASE_URL:?set ADMIN_DATABASE_URL (a role that may create databases)}"
sha256sum --check "$dump.sha256"
scratch="examos_restore_check_$$"
psql "$ADMIN_DATABASE_URL" -qc "CREATE DATABASE $scratch"
trap 'psql "$ADMIN_DATABASE_URL" -qc "DROP DATABASE IF EXISTS $scratch" >/dev/null' EXIT
target="${ADMIN_DATABASE_URL%/*}/$scratch"
pg_restore --no-owner --exit-on-error --dbname="$target" "$dump"
counts='SELECT string_agg(format($$%s=%s$$, t, (xpath($$/row/c/text()$$, query_to_xml(format($$SELECT count(*) AS c FROM public.%I$$, t), false, true, $$$$)))[1]::text), $$ $$ ORDER BY t) FROM (SELECT tablename AS t FROM pg_tables WHERE schemaname = $$public$$) x'
src=$(psql "$SOURCE_DATABASE_URL" -Atc "$counts")
dst=$(psql "$target" -Atc "$counts")
if [ "$src" != "$dst" ]; then echo "RESTORE MISMATCH"; diff <(tr ' ' '\n' <<<"$src") <(tr ' ' '\n' <<<"$dst") || true; exit 1; fi
echo "Restore OK: $(tr ' ' '\n' <<<"$dst" | wc -l) tables, row counts identical; migrations: $(psql "$target" -Atc 'SELECT count(*) FROM knex_migrations')"
