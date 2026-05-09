#!/usr/bin/env bash
# Lightweight end-to-end smoke runner. Exercises the bridge HTTP surface
# without requiring a real WhatsApp pairing — relies on the in-memory
# fake-Baileys mode (FAKE_WHATSAPP=1) when one is wired up.
#
# Usage:
#   ./tests/e2e.sh                   # uses an already-running bridge
#   FAKE_WHATSAPP=1 ./tests/e2e.sh   # boots compose first

set -euo pipefail

: "${BRIDGE_URL:=http://127.0.0.1:3001}"
: "${BRIDGE_API_KEY:?BRIDGE_API_KEY env var required}"

H="Authorization: Bearer ${BRIDGE_API_KEY}"
PASS=0
FAIL=0

step() {
  local name="$1"; shift
  if "$@"; then
    echo "PASS: $name"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name"
    FAIL=$((FAIL + 1))
  fi
}

call() {
  local method="$1" path="$2" body="${3:-}"
  if [ -z "${body}" ]; then
    curl -fsS -H "${H}" "${BRIDGE_URL}${path}"
  else
    curl -fsS -H "${H}" -H "Content-Type: application/json" -X "${method}" -d "${body}" "${BRIDGE_URL}${path}"
  fi
}

probe_status() { call GET /status >/dev/null; }
probe_metrics() { call GET /metrics | grep -q whatsapp_bridge_http_requests_total; }
probe_audit_empty_initially() { call GET /audit?limit=5 >/dev/null; }
probe_search_400_on_missing_q() {
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" -H "${H}" "${BRIDGE_URL}/messages/search")
  [ "${code}" = "400" ]
}
probe_send_400_on_missing_target() {
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" -H "${H}" -H "Content-Type: application/json" -X POST -d '{"message":"hi"}' "${BRIDGE_URL}/send")
  [ "${code}" = "400" ]
}

step "GET /status"          probe_status
step "GET /metrics"         probe_metrics
step "GET /audit"           probe_audit_empty_initially
step "search 400 no q"      probe_search_400_on_missing_q
step "send 400 no target"   probe_send_400_on_missing_target

echo
echo "Total: PASS=${PASS} FAIL=${FAIL}"
if [ "${FAIL}" -gt 0 ]; then
  exit 1
fi
