import type { Submission } from '@vayusetu/shared-types';

/**
 * PRODUCT_SPEC multilingual/low-bandwidth rules: "photo uploads
 * client-compressed, quality auto-scaled on 2G/3G". Every photo -- camera
 * frame or gallery file -- is re-encoded to JPEG here, which also turns
 * formats the server rejects (HEIC, GIF, ...) into one it accepts.
 */

type NetworkType = NonNullable<NonNullable<Submission['deviceMeta']>['networkType']>;

interface NetworkInformationLike {
  effectiveType?: string;
  type?: string;
}

export function networkType(): NetworkType {
  const conn = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
  if (!conn) return 'unknown';
  if (conn.type === 'wifi') return 'wifi';
  switch (conn.effectiveType) {
    case 'slow-2g':
    case '2g':
      return '2g';
    case '3g':
      return '3g';
    case '4g':
      return '4g';
    default:
      return 'unknown';
  }
}

const PROFILES: Record<NetworkType, { maxEdge: number; quality: number }> = {
  '2g': { maxEdge: 960, quality: 0.6 },
  '3g': { maxEdge: 1280, quality: 0.7 },
  '4g': { maxEdge: 1600, quality: 0.82 },
  '5g': { maxEdge: 1600, quality: 0.82 },
  wifi: { maxEdge: 1920, quality: 0.85 },
  unknown: { maxEdge: 1280, quality: 0.75 },
};

export class UnsupportedImageError extends Error {
  constructor() {
    super('This photo format could not be read. Please take the photo with the camera button instead.');
    this.name = 'UnsupportedImageError';
  }
}

export async function compressPhoto(source: Blob | HTMLVideoElement): Promise<Blob> {
  let width: number;
  let height: number;
  let drawable: CanvasImageSource;
  if (source instanceof Blob) {
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(source);
    } catch {
      throw new UnsupportedImageError();
    }
    drawable = bitmap;
    width = bitmap.width;
    height = bitmap.height;
  } else {
    drawable = source;
    width = source.videoWidth;
    height = source.videoHeight;
  }

  const { maxEdge, quality } = PROFILES[networkType()];
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext('2d')?.drawImage(drawable, 0, 0, canvas.width, canvas.height);
  if ('close' in drawable && typeof drawable.close === 'function') drawable.close();

  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new UnsupportedImageError())), 'image/jpeg', quality),
  );
}

/** Voice notes: prefer Opus-in-WebM, fall back to whatever the browser can
 *  record (Safari: audio/mp4). The Blob must carry the REAL type -- it is
 *  the Content-Type the upload URL is signed for. */
export function pickAudioMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find((t) =>
    MediaRecorder.isTypeSupported(t),
  );
}
