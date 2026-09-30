import { getStorage } from 'firebase-admin/storage';
import { getAdminApp } from './firestore.js';

export interface SignedUpload {
  uploadUrl: string;
  /** `gs://bucket/path` -- the form Vertex AI accepts directly as a Gemini
   *  `fileData.fileUri`, so analysis-service never has to re-download it. */
  storageUrl: string;
  expiresAt: string;
  /** Headers the PUT must carry exactly as given (they are part of the signature). */
  uploadHeaders: Record<string, string>;
}

/**
 * V4 signed PUT URL. The client must send the exact Content-Type that was
 * signed, or GCS rejects the upload with a SignatureDoesNotMatch 403.
 *
 * On Cloud Run there is no private key to sign with: the SDK falls back to
 * the IAM Credentials `signBlob` API, which needs the runtime service
 * account to hold roles/iam.serviceAccountTokenCreator (granted in
 * infra/terraform iam.tf). With plain user ADC locally, signing fails with
 * "Cannot sign data without `client_email`".
 */
export async function createSignedUploadUrl(args: {
  bucket: string;
  objectPath: string;
  contentType: string;
  /** Upper bound on the object's size, enforced by Cloud Storage itself (audit H2). */
  maxBytes: number;
  expiresInSeconds?: number;
}): Promise<SignedUpload> {
  const expiresMs = Date.now() + (args.expiresInSeconds ?? 900) * 1000;
  // x-goog-content-length-range is signed into the URL: GCS rejects a PUT
  // whose body is outside the range, so a caller can't store a multi-GB
  // object on our bill. The client must send the header verbatim.
  const uploadHeaders = { 'x-goog-content-length-range': `0,${args.maxBytes}` };
  const [uploadUrl] = await getStorage(getAdminApp())
    .bucket(args.bucket)
    .file(args.objectPath)
    .getSignedUrl({ version: 'v4', action: 'write', expires: expiresMs, contentType: args.contentType, extensionHeaders: uploadHeaders });

  return {
    uploadUrl,
    storageUrl: `gs://${args.bucket}/${args.objectPath}`,
    expiresAt: new Date(expiresMs).toISOString(),
    uploadHeaders,
  };
}

/** `gs://bucket/path` -> { bucket, path }, or undefined for anything else. */
export function parseGsUrl(url: string): { bucket: string; path: string } | undefined {
  const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(url);
  return m ? { bucket: m[1]!, path: m[2]! } : undefined;
}

/**
 * Short-lived V4 signed GET URL for a private object. Advisory audio is
 * stored as gs:// (never public); services hand browsers this instead.
 */
export async function createSignedReadUrl(gsUrl: string, expiresInSeconds = 3600): Promise<string> {
  const parsed = parseGsUrl(gsUrl);
  if (!parsed) throw new Error(`Not a gs:// URL: ${gsUrl}`);
  const [url] = await getStorage(getAdminApp())
    .bucket(parsed.bucket)
    .file(parsed.path)
    .getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + expiresInSeconds * 1000 });
  return url;
}
