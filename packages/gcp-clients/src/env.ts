/**
 * Every service in this monorepo resolves its GCP project the same way:
 * `GOOGLE_CLOUD_PROJECT` -- the variable Cloud Run injects automatically
 * in production, and the one every service's `.env.example` sets for
 * local dev. Never read `GCLOUD_PROJECT` / `GCP_PROJECT` directly in a
 * service; funnel through here so there is exactly one fallback chain,
 * matching turbo.json's `globalEnv` list.
 */
export function getProjectId(): string {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT;
  if (!projectId) {
    throw new Error(
      'GOOGLE_CLOUD_PROJECT is not set. Set it in .env.local (see .env.example) -- on ' +
        'Cloud Run this is injected automatically, so this only fires in local dev or a ' +
        'misconfigured deploy.',
    );
  }
  return projectId;
}

/** True when FIRESTORE_EMULATOR_HOST or PUBSUB_EMULATOR_HOST is set -- the client
 *  libraries themselves read these env vars automatically, this is purely for
 *  services that want to log/branch on "am I talking to the emulator". */
export function isUsingEmulators(): boolean {
  return Boolean(process.env.FIRESTORE_EMULATOR_HOST || process.env.PUBSUB_EMULATOR_HOST);
}
