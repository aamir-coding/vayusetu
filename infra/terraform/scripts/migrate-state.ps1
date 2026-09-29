# One-time: move each environment's LOCAL Terraform state (and tfvars) into a
# versioned GCS bucket in that environment's own project. Run by a person, from
# the repo root of the checkout you will apply from from now on:
#
#   powershell -ExecutionPolicy Bypass -File infra\terraform\scripts\migrate-state.ps1 -From "<old checkout root>"
#
# -From is the checkout that holds the current terraform.tfstate/.tfvars files
# (e.g. "C:\Users\<you>\OneDrive - ...\Desktop\Vayusetu\vayusetu").
#
# Safe to re-run: existing buckets are reused, and an environment whose state is
# already in GCS is skipped. The old local state is renamed to
# terraform.tfstate.pre-gcs-backup so nobody can apply against it by mistake.
param(
  [Parameter(Mandatory = $true)][string]$From,
  [string[]]$Envs = @('ncr', 'mh', 'exchange'),
  [string]$Region = 'asia-south1'
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$projects = @{ ncr = 'vayusetu-ncr-dev'; mh = 'vayusetu-mh-dev'; exchange = 'vayusetu-exchange-dev' }

foreach ($envName in $Envs) {
  $project = $projects[$envName]
  $bucket = "gs://$project-tfstate"
  $src = Join-Path $From "infra\terraform\environments\$envName"
  $dst = Join-Path $repo "infra\terraform\environments\$envName"
  Write-Host "`n=== $envName ($project)" -ForegroundColor Cyan

  # 1. The bucket: versioned (every state write is recoverable), never public.
  gcloud storage buckets describe $bucket --project $project --format='value(name)' 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    gcloud storage buckets create $bucket --project $project --location $Region --uniform-bucket-level-access --public-access-prevention
    if ($LASTEXITCODE -ne 0) { throw "could not create $bucket" }
  }
  gcloud storage buckets update $bucket --versioning | Out-Null

  # 2. Already migrated? Then there is nothing to copy.
  gcloud storage ls "$bucket/terraform/state/default.tfstate" 2>$null | Out-Null
  $already = ($LASTEXITCODE -eq 0)

  # 3. tfvars travel too: into this checkout, with a copy in the bucket.
  if (Test-Path "$src\terraform.tfvars") {
    Copy-Item "$src\terraform.tfvars" "$dst\terraform.tfvars" -Force
    gcloud storage cp "$src\terraform.tfvars" "$bucket/tfvars/terraform.tfvars" | Out-Null
  } elseif (-not (Test-Path "$dst\terraform.tfvars")) {
    throw "no terraform.tfvars in $src or $dst"
  }

  Push-Location $dst
  try {
    if ($already) {
      Write-Host "state already in $bucket -- just initialising"
      terraform init -input=false -reconfigure | Out-Null
    } else {
      if (-not (Test-Path "$src\terraform.tfstate")) { throw "no terraform.tfstate in $src" }
      Copy-Item "$src\terraform.tfstate" "$dst\terraform.tfstate" -Force
      terraform init -input=false -migrate-state -force-copy
      if ($LASTEXITCODE -ne 0) { throw "terraform init -migrate-state failed for $envName" }
      Remove-Item "$dst\terraform.tfstate", "$dst\terraform.tfstate.backup" -ErrorAction SilentlyContinue
      Rename-Item "$src\terraform.tfstate" 'terraform.tfstate.pre-gcs-backup'
    }
    # 4. Proof: the resource count read back from GCS.
    $count = (terraform state list | Measure-Object -Line).Lines
    Write-Host "${envName}: $count resources now tracked in $bucket" -ForegroundColor Green
  } finally { Pop-Location }
}
Write-Host "`nDone. Plan/apply from $repo\infra\terraform\environments\<env> with plain 'terraform plan' -- no -state flag." -ForegroundColor Cyan
