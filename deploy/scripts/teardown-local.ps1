<#
.SYNOPSIS
  Tears down the local MediCitas Kind cluster or its Kubernetes resources.
.PARAMETER ResourcesOnly
  Delete MediCitas workloads/services/PVCs inside namespace 'medicitas' without deleting the cluster.
#>
[CmdletBinding()]
param(
  [switch]$ResourcesOnly
)

$ErrorActionPreference = "Stop"
$ClusterName = if ($env:KIND_CLUSTER_NAME) { $env:KIND_CLUSTER_NAME } else { "medicitas" }
$Namespace = "medicitas"

if ($ResourcesOnly) {
  Write-Host "==> Deleting MediCitas resources in namespace '$Namespace'..."
  kubectl delete deployments,statefulsets,services,jobs,ingresses,networkpolicies,pdb,hpa,configmaps,secrets,pvc `
    -n $Namespace -l app.kubernetes.io/part-of=medicitas --ignore-not-found=true
} else {
  $clusters = kind get clusters
  if ($LASTEXITCODE -eq 0 -and ($clusters -contains $ClusterName)) {
    Write-Host "==> Deleting Kind cluster '$ClusterName'..."
    kind delete cluster --name $ClusterName
  } else {
    Write-Host "==> Kind cluster '$ClusterName' does not exist."
  }
}
