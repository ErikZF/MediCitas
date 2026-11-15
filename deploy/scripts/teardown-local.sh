#!/usr/bin/env bash
set -euo pipefail

export MSYS_NO_PATHCONV=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CLUSTER_NAME="${KIND_CLUSTER_NAME:-medicitas}"
NAMESPACE="medicitas"

MODE="cluster"
for arg in "$@"; do
  case "$arg" in
    --resources-only) MODE="resources" ;;
    --cluster) MODE="cluster" ;;
    -h|--help)
      echo "Usage: $0 [--cluster | --resources-only]"
      echo "  --cluster         Delete the '${CLUSTER_NAME}' Kind cluster (default)."
      echo "  --resources-only  Delete MediCitas workloads/services/PVCs inside '${NAMESPACE}' without deleting the cluster."
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 1
      ;;
  esac
done

if [[ "$MODE" == "cluster" ]]; then
  if kind get clusters | grep -qx "$CLUSTER_NAME"; then
    echo "==> Deleting Kind cluster '${CLUSTER_NAME}'..."
    kind delete cluster --name "$CLUSTER_NAME"
  else
    echo "==> Kind cluster '${CLUSTER_NAME}' does not exist."
  fi
else
  echo "==> Deleting MediCitas resources in namespace '${NAMESPACE}'..."
  kubectl delete deployments,statefulsets,services,jobs,ingresses,networkpolicies,pdb,hpa,configmaps,secrets,pvc \
    -n "$NAMESPACE" -l app.kubernetes.io/part-of=medicitas --ignore-not-found=true
fi
