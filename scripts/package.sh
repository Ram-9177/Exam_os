#!/usr/bin/env bash
# Produces a source zip of the repository without dependencies or build output.
set -euo pipefail
cd "$(dirname "$0")/.."
out="${1:-/tmp/smru-examos-foundation.zip}"
rm -f "$out"
zip -qr "$out" . -x "node_modules/*" "*/node_modules/*" "*/dist/*" "dist/*" ".env" "*.log" "coverage/*" "*/coverage/*" ".git/*"
echo "wrote $out ($(du -h "$out" | cut -f1))"
