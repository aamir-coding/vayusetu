import { getStorage } from 'firebase-admin/storage';
import { getAdminApp } from './firestore.js';

export interface SignedUpload {
  uploadUrl: string;
  /** `gs://bucket/path` -- the form Vertex AI accepts directly as a Gemini
   *  `fileData.fileUri`, so analysis-service never has to re-download it. */
  storageUrl: string;
  expiresAt: string;
}

/**
 * V4 signed PUT URL. The client must send the exact Content-Type that was
 * signed, or GCS rejects the upload with a SignatureDoesNotMatch 403.
 *
 * On Cloud Run there is no private key to sign with: the SDK falls back to
 * the IAM Credentials `signBlob` API, which needs the runtime service
 * account to hold roles/iam.serviceAccountTokenCreator (granted in
 * infra/terraform iam.tf). With plain user ADC locally, signing fails with
 * "Cannot sign data without `client_email`" -- see WEEK2_SETUP.md.
 */
export async function createSignedUploadUrl(args: {
  bucket: string;
  objectPath: string;
  contentType: string;
  expiresInSeconds?: number;
}): Promise<SignedUpload> {
  const expiresMs = Date.now() + (args.expiresInSeconds ?? 900) * 1000;
  const [uploadUrl] = await getStorage(getAdminApp())
    .bucket(args.bucket)
    .file(args.objectPath)
    .getSignedUrl({ version: 'v4', action: 'write', expires: expiresMs, contentType: args.contentType });

  return {
    uploadUrl,
    storageUrl: `gs://${args.bucket}/${args.objectPath}`,
    expiresAt: new Date(expiresMs).toISOString(),
  };
}
