<#
.SYNOPSIS
  Deploys MediCitas to a local Kind Kubernetes cluster on Windows (PowerShell).
.PARAMETER KeepCluster
  Reuse an existing Kind cluster instead of deleting and recreating it.
#>
[CmdletBinding()]
param(
  [switch]$KeepCluster
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DeployDir = Split-Path -Parent $ScriptDir
$RepoRoot = Split-Path -Parent $DeployDir

$ClusterName = if ($env:KIND_CLUSTER_NAME) { $env:KIND_CLUSTER_NAME } else { "medicitas" }
$Namespace = "medicitas"

function Invoke-Checked {
  param([string]$Description, [scriptblock]$Command)
  Write-Host $Description
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code $LASTEXITCODE"
  }
}

foreach ($cmd in @("docker", "kind", "kubectl")) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    throw "Missing required CLI: $cmd"
  }
}

docker info *> $null
if ($LASTEXITCODE -ne 0) {
  throw "Docker daemon is not running. Start Docker Desktop and retry."
}

Push-Location $RepoRoot
try {
  $clusters = kind get clusters
  if ($LASTEXITCODE -ne 0) { $clusters = @() }

  if (-not $KeepCluster -and ($clusters -contains $ClusterName)) {
    Invoke-Checked "==> Deleting previous Kind cluster '$ClusterName'..." {
      kind delete cluster --name $ClusterName
    }
    $clusters = @()
  }

  if (-not ($clusters -contains $ClusterName)) {
    $NodeImage = $env:KIND_NODE_IMAGE
    if (-not $NodeImage) {
      $cachedId = (docker images --format "{{.Repository}} {{.ID}}" | Where-Object { $_ -match "^kindest/node " } | Select-Object -First 1)
      if ($cachedId) {
        $idOnly = ($cachedId -split "\s+")[1]
        $digest = docker inspect --format "{{index .RepoDigests 0}}" $idOnly 2>$null
        if ($LASTEXITCODE -eq 0 -and $digest -and $digest -ne "<no value>") {
          $NodeImage = $digest.Trim()
        }
      }
    }

    Invoke-Checked "==> Creating Kind cluster '$ClusterName'..." {
      if ($NodeImage) {
        kind create cluster --name $ClusterName --config "$DeployDir/kind/kind-config.yaml" --image $NodeImage
      } else {
        kind create cluster --name $ClusterName --config "$DeployDir/kind/kind-config.yaml"
      }
    }
  } else {
    Write-Host "==> Reusing existing Kind cluster '$ClusterName'..."
    kubectl delete job keycloak-seed -n $Namespace --ignore-not-found=true | Out-Null
  }

  Invoke-Checked "==> Building MediCitas container images..." {
    docker build -f deploy/docker/assets.Dockerfile -t medicitas/assets:local .
  }

  $Services = @("clinics-service", "users-service", "appointments-service", "audit-service", "edge-gateway")
  foreach ($svc in $Services) {
    Invoke-Checked "    -> Building medicitas/${svc}:local" {
      docker build -f services/Dockerfile --build-arg "SERVICE=$svc" -t "medicitas/${svc}:local" .
    }
  }

  Write-Host "==> Loading images into Kind cluster '$ClusterName'..."
  foreach ($baseImg in @("postgres:18-alpine", "redis:alpine3.23", "quay.io/keycloak/keycloak:26.7.0")) {
    docker image inspect $baseImg *> $null
    if ($LASTEXITCODE -eq 0) {
      kind load docker-image --name $ClusterName $baseImg *> $null
    }
  }

  $LocalImages = @("medicitas/assets:local") + ($Services | ForEach-Object { "medicitas/${_}:local" })
  Invoke-Checked "==> Loading MediCitas images into Kind..." {
    kind load docker-image --name $ClusterName @LocalImages
  }

  Invoke-Checked "==> Applying Kubernetes manifests (kustomize overlays/local)..." {
    kubectl apply -k "$DeployDir/k8s/overlays/local"
  }

  Write-Host "==> Waiting for databases and Redis..."
  foreach ($sts in @("db-clinics", "db-users", "db-appointments", "db-logs")) {
    Invoke-Checked "    -> Waiting for statefulset/$sts" {
      kubectl rollout status "statefulset/$sts" -n $Namespace --timeout=180s
    }
  }
  Invoke-Checked "    -> Waiting for statefulset/redis" {
    kubectl rollout status statefulset/redis -n $Namespace --timeout=120s
  }

  Invoke-Checked "==> Waiting for Keycloak..." {
    kubectl rollout status deployment/keycloak -n $Namespace --timeout=240s
  }

  Invoke-Checked "==> Waiting for Keycloak user seed job..." {
    kubectl wait --for=condition=complete job/keycloak-seed -n $Namespace --timeout=180s
  }

  Write-Host "==> Waiting for microservices and edge-gateway..."
  foreach ($svc in $Services) {
    Invoke-Checked "    -> Waiting for deployment/$svc" {
      kubectl rollout status "deployment/$svc" -n $Namespace --timeout=180s
    }
  }

  Write-Host ""
  Write-Host "MediCitas Kubernetes deployment is ready!"
  Write-Host "  API Gateway: http://localhost:3000 (health: http://localhost:3000/health)"
  Write-Host "  Keycloak:    http://localhost:8080 (realm: Sistema_Clinico)"
  Write-Host "  Verify all:  node deploy/scripts/test-all-endpoints.mjs"
} finally {
  Pop-Location
}
