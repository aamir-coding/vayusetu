/**
 * Product Spec Feature 1: "photo/voice to Cloud Storage" happens client-side
 * via a signed URL, *before* `POST /submissions` registers the resulting
 * metadata — the API contract is explicit that this endpoint only
 * registers already-uploaded media, it never accepts a raw file body.
 *
 * `submission-service` doesn't exist yet (Engineer 2, Week 1-2), so
 * `requestSignedUploadUrl` is intercepted by MSW in mock mode: it hands
 * back a same-origin `/mock-storage/...` URL that the mock PUT handler
 * accepts, so this function's real code path — get a URL, PUT the blob,
 * hand back the final storage URL — is fully exercised today and won't
 * need to change when the real signed-URL endpoint lands.
 */

interface SignedUploadUrlResponse {
  uploadUrl: string;
  storageUrl: string;
}

async function requestSignedUploadUrl(kind: 'photo' | 'audio', contentType: string): Promise<SignedUploadUrlResponse> {
  const id = `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const res = await fetch(`/mock-storage/sign?kind=${kind}&contentType=${encodeURIComponent(contentType)}&id=${id}`);
  if (!res.ok) throw new Error(`Failed to obtain an upload URL (${res.status})`);
  return (await res.json()) as SignedUploadUrlResponse;
}

export async function uploadBlob(kind: 'photo' | 'audio', blob: Blob): Promise<string> {
  const { uploadUrl, storageUrl } = await requestSignedUploadUrl(kind, blob.type || 'application/octet-stream');
  const put = await fetch(uploadUrl, { method: 'PUT', body: blob, headers: { 'Content-Type': blob.type } });
  if (!put.ok) throw new Error(`Upload failed (${put.status})`);
  return storageUrl;
}
