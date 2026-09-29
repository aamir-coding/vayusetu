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

# Windows PowerShell 5.1 turns ANY stderr line from a native program into a
# terminating error under 'Stop' -- even with 2>$null -- and gcloud writes
# expected "not found" answers and plain progress messages to stderr. So
# native commands run with 'Continue', and success is judged by exit code.
function Invoke-Native([scriptblock]$Cmd) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $Cmd 2>&1 | ForEach-Object { "$_" }
    return [pscustomobject]@{ Code = $LASTEXITCODE; Out = ($out -join "`n") }
  } finally { $ErrorActionPreference = $prev }
}
function Assert-Native([string]$What, [scriptblock]$Cmd) {
  $r = Invoke-Native $Cmd
  if ($r.Code -ne 0) { throw "$What failed (exit $($r.Code)):`n$($r.Out)" }
  return $r
}

foreach ($envName in $Envs) {
  $project = $projects[$envName]
  $bucket = "gs://$project-tfstate"
  $src = Join-Path $From "infra\terraform\environments\$envName"
  $dst = Join-Path $repo "infra\terraform\environments\$envName"
  Write-Host "`n=== $envName ($project)" -ForegroundColor Cyan

  # 1. The bucket: versioned (every state write is recoverable), never public.
  #    A 404 from describe just means "not created yet".
  if ((Invoke-Native { gcloud storage buckets describe $bucket --project $project --format='value(name)' }).Code -ne 0) {
    Assert-Native "create $bucket" { gcloud storage buckets create $bucket --project $project --location $Region --uniform-bucket-level-access --public-access-prevention } | Out-Null
    Write-Host "created $bucket"
  } else {
    Write-Host "$bucket exists"
  }
  Assert-Native "enable versioning on $bucket" { gcloud storage buckets update $bucket --versioning } | Out-Null

  # 2. Already migrated? Then there is nothing to copy.
  $already = ((Invoke-Native { gcloud storage ls "$bucket/terraform/state/default.tfstate" }).Code -eq 0)

  # 3. tfvars travel too: into this checkout, with a copy in the bucket.
  if (Test-Path "$src\terraform.tfvars") {
    Copy-Item "$src\terraform.tfvars" "$dst\terraform.tfvars" -Force
    Assert-Native "back up tfvars to $bucket" { gcloud storage cp "$src\terraform.tfvars" "$bucket/tfvars/terraform.tfvars" } | Out-Null
  } elseif (-not (Test-Path "$dst\terraform.tfvars")) {
    throw "no terraform.tfvars in $src or $dst"
  }

  Push-Location $dst
  try {
    if ($already) {
      Write-Host "state already in $bucket -- just initialising"
      Assert-Native "terraform init ($envName)" { terraform init -input=false -reconfigure } | Out-Null
    } else {
      if (-not (Test-Path "$src\terraform.tfstate")) { throw "no terraform.tfstate in $src" }
      Copy-Item "$src\terraform.tfstate" "$dst\terraform.tfstate" -Force
      Assert-Native "terraform init -migrate-state ($envName)" { terraform init -input=false -migrate-state -force-copy } | Out-Null
      Remove-Item "$dst\terraform.tfstate", "$dst\terraform.tfstate.backup" -ErrorAction SilentlyContinue
      Rename-Item "$src\terraform.tfstate" 'terraform.tfstate.pre-gcs-backup'
    }
    # 4. Proof: the resource count read back from GCS.
    $list = Assert-Native "terraform state list ($envName)" { terraform state list }
    $count = ($list.Out -split "`n" | Where-Object { $_ -match '\S' }).Count
    Write-Host "${envName}: $count resources now tracked in $bucket" -ForegroundColor Green
  } finally { Pop-Location }
}
Write-Host "`nDone. Plan/apply from $repo\infra\terraform\environments\<env> with plain 'terraform plan' -- no -state flag." -ForegroundColor Cyan
