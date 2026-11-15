#!/usr/bin/env bash
set -euo pipefail

# Prevent Git Bash / MSYS2 on Windows from rewriting container paths (e.g. /assets/...).
export MSYS_NO_PATHCONV=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${DEPLOY_DIR}/.." && pwd)"

CLUSTER_NAME="${KIND_CLUSTER_NAME:-medicitas}"
NAMESPACE="medicitas"
KEEP_CLUSTER="${KEEP_CLUSTER:-false}"

for arg in "$@"; do
  case "$arg" in
    --keep-cluster) KEEP_CLUSTER="true" ;;
    --clean) KEEP_CLUSTER="false" ;;
    -h|--help)
      echo "Usage: $0 [--clean | --keep-cluster]"
      echo "  --clean         Delete any existing '${CLUSTER_NAME}' Kind cluster before deploying (default)."
      echo "  --keep-cluster  Reuse existing Kind cluster and re-apply manifests."
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 1
      ;;
  esac
done

for cmd in docker kind kubectl; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required CLI: $cmd" >&2
    exit 1
  fi
done

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon is not running. Start Docker Desktop / Docker Engine and retry." >&2
  exit 1
fi

cd "$REPO_ROOT"

if [[ "$KEEP_CLUSTER" == "false" ]] && kind get clusters | grep -qx "$CLUSTER_NAME"; then
  echo "==> Deleting previous Kind cluster '${CLUSTER_NAME}'..."
  kind delete cluster --name "$CLUSTER_NAME"
fi

if ! kind get clusters | grep -qx "$CLUSTER_NAME"; then
  NODE_IMAGE="${KIND_NODE_IMAGE:-}"
  if [[ -z "$NODE_IMAGE" ]]; then
    # Prefer an already-cached kindest/node image to avoid unnecessary multi-GB downloads.
    CACHED_ID="$(docker images --format '{{.Repository}} {{.ID}}' | awk '$1 == "kindest/node" {print $2; exit}')"
    if [[ -n "$CACHED_ID" ]]; then
      CACHED_DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "$CACHED_ID" 2>/dev/null || true)"
      if [[ -n "$CACHED_DIGEST" && "$CACHED_DIGEST" != "<no value>" ]]; then
        NODE_IMAGE="$CACHED_DIGEST"
      fi
    fi
  fi

  echo "==> Creating Kind cluster '${CLUSTER_NAME}'..."
  if [[ -n "$NODE_IMAGE" ]]; then
    kind create cluster --name "$CLUSTER_NAME" --config "${DEPLOY_DIR}/kind/kind-config.yaml" --image "$NODE_IMAGE"
  else
    kind create cluster --name "$CLUSTER_NAME" --config "${DEPLOY_DIR}/kind/kind-config.yaml"
  fi
else
  echo "==> Reusing existing Kind cluster '${CLUSTER_NAME}' (cleaning previous MediCitas workloads)..."
  kubectl delete job keycloak-seed -n "$NAMESPACE" --ignore-not-found=true
fi

echo "==> Building MediCitas container images..."
docker build -f deploy/docker/assets.Dockerfile -t medicitas/assets:local .

SERVICES=(
  clinics-service
  users-service
  appointments-service
  audit-service
  edge-gateway
)

for svc in "${SERVICES[@]}"; do
  echo "    -> Building medicitas/${svc}:local"
  docker build -f services/Dockerfile --build-arg "SERVICE=${svc}" -t "medicitas/${svc}:local" .
done

echo "==> Loading images into Kind cluster '${CLUSTER_NAME}'..."
IMAGES_TO_LOAD=(
  "medicitas/assets:local"
  "medicitas/clinics-service:local"
  "medicitas/users-service:local"
  "medicitas/appointments-service:local"
  "medicitas/audit-service:local"
  "medicitas/edge-gateway:local"
)

for base_img in "postgres:18-alpine" "redis:alpine3.23" "quay.io/keycloak/keycloak:26.7.0"; do
  if docker image inspect "$base_img" >/dev/null 2>&1; then
    # Kind/Docker 29 multi-arch OCI images can fail `kind load` if non-host platform blobs aren't present;
    # load best-effort individually and let kubelet pull via IfNotPresent if skipped.
    kind load docker-image --name "$CLUSTER_NAME" "$base_img" >/dev/null 2>&1 || true
  fi
done

kind load docker-image --name "$CLUSTER_NAME" "${IMAGES_TO_LOAD[@]}"

echo "==> Applying Kubernetes manifests (kustomize overlays/local)..."
kubectl apply -k "${DEPLOY_DIR}/k8s/overlays/local"

echo "==> Waiting for databases and Redis..."
kubectl rollout status statefulset/db-clinics -n "$NAMESPACE" --timeout=180s
kubectl rollout status statefulset/db-users -n "$NAMESPACE" --timeout=180s
kubectl rollout status statefulset/db-appointments -n "$NAMESPACE" --timeout=180s
kubectl rollout status statefulset/db-logs -n "$NAMESPACE" --timeout=180s
kubectl rollout status statefulset/redis -n "$NAMESPACE" --timeout=120s

echo "==> Waiting for Keycloak..."
kubectl rollout status deployment/keycloak -n "$NAMESPACE" --timeout=240s

echo "==> Waiting for Keycloak user seed job..."
kubectl wait --for=condition=complete job/keycloak-seed -n "$NAMESPACE" --timeout=180s

echo "==> Waiting for microservices and edge-gateway..."
for svc in "${SERVICES[@]}"; do
  kubectl rollout status "deployment/${svc}" -n "$NAMESPACE" --timeout=180s
done

echo ""
echo "MediCitas Kubernetes deployment is ready!"
echo "  API Gateway: http://localhost:3000 (health: http://localhost:3000/health)"
echo "  Keycloak:    http://localhost:8080 (realm: Sistema_Clinico)"
echo "  Verify with: ${SCRIPT_DIR}/verify.sh"
