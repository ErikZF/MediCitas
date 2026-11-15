#!/usr/bin/env bash
set -euo pipefail

export MSYS_NO_PATHCONV=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SECRETS_FILE="${DEPLOY_DIR}/k8s/overlays/local/secrets.env"

for cmd in curl kubectl node; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required CLI: $cmd" >&2
    exit 1
  fi
done

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -f "${TMP_DIR}/services.json" "${TMP_DIR}/professionals.json" "${TMP_DIR}/avail.json"
  rmdir "$TMP_DIR" 2>/dev/null || true
}
trap cleanup EXIT

GATEWAY_URL="${GATEWAY_URL:-http://localhost:3000}"
KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:8080}"
REALM="${REALM_NAME:-Sistema_Clinico}"
CLIENT_ID="${KEYCLOAK_TEST_CLIENT_ID:-integration-tests}"
NAMESPACE="medicitas"

if [[ -f "$SECRETS_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a && source "$SECRETS_FILE" && set +a
fi
TEST_PASSWORD="${KEYCLOAK_TEST_PASSWORD:-your_test_password}"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

echo "==> 1. Checking Kubernetes resources in namespace '${NAMESPACE}'..."
kubectl get pods,svc,pvc,jobs -n "$NAMESPACE"

NOT_READY="$(kubectl get pods -n "$NAMESPACE" --no-headers | awk '$3 !~ /^(Running|Completed|Succeeded)$/ {print $1 ":" $3}')"
if [[ -n "$NOT_READY" ]]; then
  fail "Pods not in Running/Completed state: $NOT_READY"
fi

echo "==> 2. Checking Edge Gateway on ${GATEWAY_URL}..."
ROOT_BODY="$(curl -sf "${GATEWAY_URL}/")" || fail "Gateway root unreachable"
[[ "$ROOT_BODY" == "Hello World!" ]] || fail "Unexpected root body: $ROOT_BODY"

HEALTH_BODY="$(curl -sf "${GATEWAY_URL}/health")" || fail "Gateway /health unreachable"
echo "    Gateway /health -> ${HEALTH_BODY}"
echo "$HEALTH_BODY" | grep -q '"status":"ok"' || fail "Unexpected health body: $HEALTH_BODY"

echo "==> 3. Checking Keycloak OIDC discovery on ${KEYCLOAK_URL}..."
OIDC_JSON="$(curl -sf "${KEYCLOAK_URL}/realms/${REALM}/.well-known/openid-configuration")" || fail "Keycloak OIDC discovery unreachable"
echo "$OIDC_JSON" | grep -q "\"issuer\":\"${KEYCLOAK_URL}/realms/${REALM}\"" || fail "Issuer mismatch in OIDC discovery"
echo "    Keycloak OIDC issuer verified."

echo "==> 4. Verifying unauthenticated request rejection (401)..."
UNAUTH_CODE="$(curl -s -o /dev/null -w '%{http_code}' "${GATEWAY_URL}/audit/logs")"
[[ "$UNAUTH_CODE" == "401" ]] || fail "Expected 401 for unauthenticated /audit/logs, got ${UNAUTH_CODE}"
echo "    GET /audit/logs without token -> 401"

get_token() {
  local username="$1"
  node -e '
    (async () => {
      const r = await fetch(process.argv[1], {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "password",
          client_id: process.argv[2],
          username: process.argv[3],
          password: process.argv[4],
        }),
      });
      if (!r.ok) { console.error(await r.text()); process.exit(1); }
      const d = await r.json();
      if (!d.access_token) process.exit(1);
      process.stdout.write(d.access_token);
    })();
  ' "${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/token" "$CLIENT_ID" "$username" "$TEST_PASSWORD"
}

echo "==> 5. Obtaining OIDC tokens for seeded users..."
CLINIC_ADMIN_TOKEN="$(get_token "admin.sj")" || fail "Could not obtain token for admin.sj"
RECEPTIONIST_TOKEN="$(get_token "reception.sj")" || fail "Could not obtain token for reception.sj"
echo "    Tokens issued for admin.sj and reception.sj."

echo "==> 6. Testing RBAC and microservices through Edge Gateway..."
# Audit service: clinic_admin -> 200, receptionist -> 403
AUDIT_ADMIN_CODE="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${CLINIC_ADMIN_TOKEN}" "${GATEWAY_URL}/audit/logs")"
[[ "$AUDIT_ADMIN_CODE" == "200" ]] || fail "Expected 200 on /audit/logs for clinic_admin, got ${AUDIT_ADMIN_CODE}"
echo "    GET /audit/logs (clinic_admin) -> 200"

AUDIT_RECEP_CODE="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${RECEPTIONIST_TOKEN}" "${GATEWAY_URL}/audit/logs")"
[[ "$AUDIT_RECEP_CODE" == "403" ]] || fail "Expected 403 on /audit/logs for receptionist, got ${AUDIT_RECEP_CODE}"
echo "    GET /audit/logs (receptionist) -> 403"

# Clinics service via gateway (specific service + clinic specialties)
SERVICE_ID="019a0000-0000-7000-8000-000000000301"
SERVICES_CODE="$(curl -s -o "${TMP_DIR}/services.json" -w '%{http_code}' -H "Authorization: Bearer ${RECEPTIONIST_TOKEN}" "${GATEWAY_URL}/services/${SERVICE_ID}")"
[[ "$SERVICES_CODE" == "200" ]] || fail "Expected 200 on /services/${SERVICE_ID}, got ${SERVICES_CODE}"
echo "    GET /services/${SERVICE_ID} (clinics-service) -> 200"

# Users service via gateway (professional & patient lookups)
PROFESSIONAL_ID="019a0000-0000-7000-8000-000000000501"
PROF_CODE="$(curl -s -o "${TMP_DIR}/professionals.json" -w '%{http_code}' -H "Authorization: Bearer ${RECEPTIONIST_TOKEN}" "${GATEWAY_URL}/professionals/${PROFESSIONAL_ID}")"
[[ "$PROF_CODE" == "200" ]] || fail "Expected 200 on /professionals/${PROFESSIONAL_ID}, got ${PROF_CODE}"
echo "    GET /professionals/${PROFESSIONAL_ID} (users-service) -> 200"

# Appointments service + Redis cache via gateway (RF8 availability check)
DAY_FROM="$(node -e 'process.stdout.write(new Date().toISOString().slice(0, 10))')"
DAY_TO="$(node -e 'process.stdout.write(new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10))')"
AVAIL_CODE="$(curl -s -o "${TMP_DIR}/avail.json" -w '%{http_code}' -H "Authorization: Bearer ${RECEPTIONIST_TOKEN}" "${GATEWAY_URL}/availability?serviceId=${SERVICE_ID}&from=${DAY_FROM}&to=${DAY_TO}")"
[[ "$AVAIL_CODE" == "200" ]] || fail "Expected 200 on /availability, got ${AVAIL_CODE}"
echo "    GET /availability (appointments-service + clinics + users + redis) -> 200"

echo "==> 7. Checking Redis availability cache keys..."
REDIS_KEYS="$(kubectl exec -n "$NAMESPACE" redis-0 -- sh -c 'redis-cli -p "$REDIS_PORT" keys "avail:*"' | wc -l)"
echo "    Redis cached keys matching avail:* -> ${REDIS_KEYS}"
[[ "$REDIS_KEYS" -gt 0 ]] || fail "Expected Redis to hold cached availability keys after /availability query"

echo ""
echo "ALL KUBERNETES END-TO-END CHECKS PASSED!"
