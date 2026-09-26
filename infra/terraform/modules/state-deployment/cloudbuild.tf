# Week 2 -- "Cloud Build CI/CD live and path-triggered for every app."
#
# Per app, two triggers pointing at the SAME infra/cloudbuild/<app>.yaml:
#   <app>-pr-<env>      PR into main  -> _DEPLOY=false (install, type-check, lint, test)
#   <app>-main-<env>    push to main  -> _DEPLOY=<ci_apps[app].deploy> (validate, then build/push/deploy)
# `included_files` makes them path-triggered: a PR touching only
# apps/citizen-pwa never builds alert-service. Shared packages and root
# workspace files fan out to every app that depends on them.
#
# ONE-TIME MANUAL PREREQUISITE (can't be Terraformed for 1st-gen GitHub
# triggers): install the "Google Cloud Build" GitHub App on the repo and
# connect it under Cloud Build > Triggers > Connect repository. Then set
# enable_ci_triggers = true, github_owner, github_repo.

locals {
  ci_shared_paths = {
    backend  = ["packages/shared-types/**", "packages/gcp-clients/**"]
    frontend = ["packages/shared-types/**", "packages/ui-components/**", "packages/config/**"] # config = shared Tailwind tokens
  }
  ci_root_paths = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "turbo.json", ".dockerignore"]

  # deploy = true only for Cloud Run services whose yaml builds an image.
  # Frontends validate only: their Firebase Hosting deploy is Engineer 1's
  # Week 4 deliverable. Engineer 3's services (analysis/hotspot/forecast)
  # join by adding infra/cloudbuild/<name>.yaml + one line here, once their
  # Dockerfiles exist -- see WEEK2_SETUP.md.
  ci_apps = {
    submission-service = { deploy = true, paths = local.ci_shared_paths.backend }
    alert-service      = { deploy = true, paths = local.ci_shared_paths.backend }
    citizen-pwa        = { deploy = false, paths = local.ci_shared_paths.frontend }
    admin-dashboard    = { deploy = false, paths = local.ci_shared_paths.frontend }
  }
  ci_deployable = { for k, v in local.ci_apps : k => v if v.deploy }
}

resource "google_service_account" "cloudbuild_deployer" {
  project      = var.project_id
  account_id   = "cloudbuild-${var.environment_name}"
  display_name = "Cloud Build deployer (${var.environment_name})"
  description  = "Runs CI builds and deploys Cloud Run images. Can act as ONLY the runtime SAs of services it deploys."
}

resource "google_project_iam_member" "cloudbuild_deployer" {
  for_each = toset([
    "roles/run.developer",           # deploy revisions (not change IAM on services)
    "roles/artifactregistry.writer", # push images
    "roles/logging.logWriter",       # required for builds with a user-specified SA
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.cloudbuild_deployer.email}"
}

# Deploying a revision that runs AS a service account requires actAs on
# that SA. Granted per runtime SA, not project-wide serviceAccountUser --
# which would let CI impersonate every account in the project.
resource "google_service_account_iam_member" "cloudbuild_act_as_runtime" {
  for_each           = local.ci_deployable
  service_account_id = google_service_account.service[each.key].name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.cloudbuild_deployer.email}"
}

# `gcloud builds submit --service-account=...` (manual builds, and the
# triggers below) makes Cloud Build run AS this SA for every step --
# including fetching the source tarball it just uploaded to the
# auto-created <project>_cloudbuild staging bucket. Only the default
# Cloud Build SA gets that access for free; a custom SA 403s on its own
# source without this grant (storage.objects.get on that bucket).
resource "google_storage_bucket_iam_member" "cloudbuild_deployer_source_access" {
  bucket = "${var.project_id}_cloudbuild"
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.cloudbuild_deployer.email}"
}

resource "google_cloudbuild_trigger" "pr" {
  for_each = var.enable_ci_triggers ? local.ci_apps : {}

  project     = var.project_id
  location    = "global"
  name        = "${each.key}-pr-${var.environment_name}"
  description = "Validate ${each.key} on PRs into ${var.ci_branch_regex}"

  github {
    owner = var.github_owner
    name  = var.github_repo
    pull_request {
      branch = var.ci_branch_regex
    }
  }

  filename       = "infra/cloudbuild/${each.key}.yaml"
  included_files = concat(["apps/${each.key}/**", "infra/cloudbuild/${each.key}.yaml"], each.value.paths, local.ci_root_paths)

  substitutions = {
    _DEPLOY = "false"
    _ENV    = var.environment_name
    _REGION = var.region
  }

  service_account = google_service_account.cloudbuild_deployer.id

  lifecycle {
    precondition {
      condition     = var.github_owner != "" && var.github_repo != ""
      error_message = "enable_ci_triggers = true requires github_owner and github_repo."
    }
  }

  depends_on = [google_project_iam_member.cloudbuild_deployer]
}

resource "google_cloudbuild_trigger" "main" {
  for_each = var.enable_ci_triggers ? local.ci_apps : {}

  project     = var.project_id
  location    = "global"
  name        = "${each.key}-main-${var.environment_name}"
  description = each.value.deploy ? "Validate + deploy ${each.key} on push to ${var.ci_branch_regex}" : "Validate ${each.key} on push to ${var.ci_branch_regex}"

  github {
    owner = var.github_owner
    name  = var.github_repo
    push {
      branch = var.ci_branch_regex
    }
  }

  filename       = "infra/cloudbuild/${each.key}.yaml"
  included_files = concat(["apps/${each.key}/**", "infra/cloudbuild/${each.key}.yaml"], each.value.paths, local.ci_root_paths)

  substitutions = {
    _DEPLOY = each.value.deploy ? "true" : "false"
    _ENV    = var.environment_name
    _REGION = var.region
  }

  service_account = google_service_account.cloudbuild_deployer.id

  lifecycle {
    precondition {
      condition     = var.github_owner != "" && var.github_repo != ""
      error_message = "enable_ci_triggers = true requires github_owner and github_repo."
    }
  }

  depends_on = [google_project_iam_member.cloudbuild_deployer]
}

# Whole-repo required check: every suite (Node, Python, Terraform) on every PR.
resource "google_cloudbuild_trigger" "repo_ci" {
  count = var.enable_ci_triggers ? 1 : 0

  project     = var.project_id
  location    = "global"
  name        = "repo-ci-${var.environment_name}"
  description = "All tests on PRs into ${var.ci_branch_regex} (make this the required status check)"

  github {
    owner = var.github_owner
    name  = var.github_repo
    pull_request {
      branch = var.ci_branch_regex
    }
  }

  filename        = "infra/cloudbuild/ci.yaml"
  service_account = google_service_account.cloudbuild_deployer.id

  depends_on = [google_project_iam_member.cloudbuild_deployer]
}
