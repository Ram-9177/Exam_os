#!/usr/bin/env bash
# Database backup: a compressed custom-format dump that pg_restore can restore in full or table by table.
#   BACKUP_DATABASE_URL=postgres://backup_user:…@host/examos  BACKUP_DIR=/var/backups/examos  infrastructure/scripts/backup.sh
# Run it from cron or the platform scheduler at least daily, plus continuous WAL archiving / point-in-time recovery on
# the managed database. Copy the file off the server (another region or account): a backup on the same disk is not one.
# Documents (photos, PDFs) live in object storage: keep versioning on that bucket and replicate it too.
set -euo pipefail
: "${BACKUP_DATABASE_URL:?set BACKUP_DATABASE_URL (a role that can read every table, e.g. the migration role)}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
mkdir -p "$BACKUP_DIR"
umask 077 # the dump holds personal data and sealed secrets: owner-only
out="$BACKUP_DIR/examos-$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_dump --format=custom --compress=6 --no-owner --file="$out" "$BACKUP_DATABASE_URL"
sha256sum "$out" > "$out.sha256"
echo "$out"
