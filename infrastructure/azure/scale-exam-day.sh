#!/usr/bin/env bash
# SMRU ExamOS — exam-day scale up / scale down (TEMPLATE, untested against a live subscription).
#
# Pays for 1,000-student capacity only on exam days:
#   up   : PostgreSQL Flexible Server Burstable -> General Purpose, add burst API nodes to the backend pool
#   down : reverse
#
# Run `up` the evening before (the PostgreSQL tier change restarts the server, ~1-2 min),
# never inside a readiness or writing window. Run `down` the day after, once seals/forensics drained.
#
# Requires: az CLI logged in with Contributor on the resource group. Fill in the variables or export them.
set -euo pipefail

ACTION="${1:-}"
RG="${EXAMOS_RG:-examos-prod}"
PG_SERVER="${EXAMOS_PG_SERVER:-examos-pg}"
PG_BASE_SKU="${EXAMOS_PG_BASE_SKU:-Standard_B2ms}"          # always-on tier
PG_BASE_TIER="${EXAMOS_PG_BASE_TIER:-Burstable}"
PG_BURST_SKU="${EXAMOS_PG_BURST_SKU:-Standard_D4ds_v5}"     # 1,000 concurrent; use Standard_D8ds_v5 for ~3,000
PG_BURST_TIER="${EXAMOS_PG_BURST_TIER:-GeneralPurpose}"
VMSS="${EXAMOS_API_VMSS:-examos-api-vmss}"                  # API/worker scale set behind the load balancer
API_BASE_COUNT="${EXAMOS_API_BASE_COUNT:-1}"
API_BURST_COUNT="${EXAMOS_API_BURST_COUNT:-3}"              # baseline node + 2 burst nodes for 1,000; 4 for ~3,000
HEALTH_URL="${EXAMOS_HEALTH_URL:-}"                          # e.g. https://exams.smru.edu.in/api/v1/health

usage() { echo "usage: $0 up|down|status"; exit 2; }

pg_scale() {
  local tier="$1" sku="$2"
  echo ">> PostgreSQL ${PG_SERVER}: tier=${tier} sku=${sku} (server restarts)"
  az postgres flexible-server update -g "$RG" -n "$PG_SERVER" --tier "$tier" --sku-name "$sku" -o none
  az postgres flexible-server wait -g "$RG" -n "$PG_SERVER" --custom "state=='Ready'"
}

api_scale() {
  local count="$1"
  echo ">> API scale set ${VMSS}: capacity=${count}"
  az vmss scale -g "$RG" -n "$VMSS" --new-capacity "$count" -o none
  az vmss wait -g "$RG" -n "$VMSS" --updated
}

health() {
  [[ -z "$HEALTH_URL" ]] && return 0
  echo ">> health: $HEALTH_URL"
  for i in $(seq 1 30); do
    if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null; then echo "   ok"; return 0; fi
    sleep 5
  done
  echo "   health check failed after 150 s" >&2; return 1
}

case "$ACTION" in
  up)
    pg_scale "$PG_BURST_TIER" "$PG_BURST_SKU"
    api_scale "$API_BURST_COUNT"
    health
    echo ">> next: npm run security:probes against production, 100-user k6 dress rehearsal, test mail via Power Automate, ERP webhook health, mailbox quota."
    ;;
  down)
    api_scale "$API_BASE_COUNT"
    pg_scale "$PG_BASE_TIER" "$PG_BASE_SKU"
    health
    ;;
  status)
    az postgres flexible-server show -g "$RG" -n "$PG_SERVER" --query '{tier:sku.tier,sku:sku.name,state:state}' -o table
    az vmss show -g "$RG" -n "$VMSS" --query '{capacity:sku.capacity}' -o table
    ;;
  *) usage ;;
esac
