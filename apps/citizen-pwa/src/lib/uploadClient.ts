import { submissionsApi } from './apiClient';

/**
 * Media goes straight to Cloud Storage via a V4 signed URL -- the binary
 * never passes through Cloud Run (ARCHITECTURE_OVERVIEW.md, Cloud Storage
 * row). Flow: POST /submissions/upload-url -> PUT blob with the EXACT signed
 * Content-Type -> hand the returned gs:// storageUrl to POST /submissions,
 * which rejects any URL that wasn't issued to this caller.
 */

export class UploadError extends Error {
  constructor(public status: number) {
    super(status === 403 ? 'Upload link expired or was rejected' : `Upload failed (${status})`);
    this.name = 'UploadError';
  }
}

/** Blob.type can be empty, or carry params the server allows ("audio/webm;codecs=opus"). */
function contentTypeFor(kind: 'photo' | 'audio', blob: Blob): string {
  if (blob.type) return blob.type;
  return kind === 'photo' ? 'image/jpeg' : 'audio/webm';
}

export async function uploadBlob(token: string, kind: 'photo' | 'audio', blob: Blob): Promise<string> {
  const contentType = contentTypeFor(kind, blob);
  const { uploadUrl, storageUrl } = await submissionsApi.uploadUrl(token, { kind, contentType });
  const put = await fetch(uploadUrl, { method: 'PUT', body: blob, headers: { 'Content-Type': contentType } });
  if (!put.ok) throw new UploadError(put.status);
  return storageUrl;
}
