import { createHash } from 'node:crypto';
import { v2 } from '@google-cloud/speech';
import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import { getAdminApp } from '@vayusetu/gcp-clients';
import { getStorage } from 'firebase-admin/storage';

/**
 * Cloud Speech's language codes differ from the app's BCP-47 tags for
 * Punjabi: the API rejects `pa-IN` and needs the script-qualified
 * `pa-Guru-IN` (verified live, 26 Sep 2026).
 */
export function speechLanguageCode(tag: string): string {
  return tag === 'pa-IN' ? 'pa-Guru-IN' : tag;
}

/** `gs://bucket/path/to/object` -> { bucket, path }; undefined for anything else. */
export function parseGsUrl(url: string): { bucket: string; path: string } | undefined {
  const m = /^gs:\/\/([^/]+)\/(.+)$/.exec(url);
  return m ? { bucket: m[1]!, path: m[2]! } : undefined;
}

/** Voice notes are capped at 10 s by the PWA; anything far larger is not one. */
export const MAX_VOICE_NOTE_BYTES = 2 * 1024 * 1024;

/**
 * Cloud Speech-to-Text v2 (Chirp). Short voice notes (<= 10 s) -> synchronous
 * recognize with the audio sent INLINE. Passing the gs:// URI made Speech
 * read the object as ITS service agent (service-<n>@gcp-sa-speech), which has
 * no access to the private citizen-media bucket -- every voice note lost its
 * transcript with a 403 (29 Sep live test). This service can already read
 * the bucket, so it downloads the note and no extra grant is needed.
 */
export function createTranscriber(cfg: { project: string; location: string; model: string }) {
  // REST transport (`fallback`): over gRPC the `us` multi-region endpoint
  // answers NOT_FOUND for the same request REST serves fine (verified live).
  const client = new v2.SpeechClient({ apiEndpoint: `${cfg.location}-speech.googleapis.com`, fallback: true });
  const storage = () => getStorage(getAdminApp());
  return async (audioGsUrl: string, language: string): Promise<string | undefined> => {
    const loc = parseGsUrl(audioGsUrl);
    if (!loc) throw new Error(`not a gs:// URL: ${audioGsUrl}`);
    const file = storage().bucket(loc.bucket).file(loc.path);
    const [meta] = await file.getMetadata();
    if (Number(meta.size ?? 0) > MAX_VOICE_NOTE_BYTES) throw new Error(`voice note too large (${meta.size} bytes)`);
    const [content] = await file.download();
    const [response] = await client.recognize({
      recognizer: `projects/${cfg.project}/locations/${cfg.location}/recognizers/_`,
      config: { autoDecodingConfig: {}, languageCodes: [speechLanguageCode(language)], model: cfg.model },
      content,
    });
    const text = (response.results ?? [])
      .map((r) => r.alternatives?.[0]?.transcript?.trim())
      .filter(Boolean)
      .join(' ');
    return text || undefined;
  };
}

/** Pipeline B cache key: identical advisory text + language + voice is never re-synthesized. */
export function ttsCacheKey(text: string, language: string, voice: string): string {
  return createHash('sha256').update(`${voice}\u0000${language}\u0000${text}`).digest('hex');
}

/**
 * Pipeline B: Cloud Text-to-Speech (Chirp 3 HD, available for hi/pa/mr/en-IN)
 * cached in the advisory-audio bucket, keyed by content hash. Stores gs://;
 * submission-service signs a short-lived URL when the citizen reads it.
 */
export function createSynthesizer(cfg: { bucket: string; voiceSuffix: string }) {
  const client = new TextToSpeechClient();
  const bucket = () => getStorage(getAdminApp()).bucket(cfg.bucket);
  return async (text: string, language: string): Promise<string | undefined> => {
    const voice = `${language}-${cfg.voiceSuffix}`;
    const path = `tts/${language}/${ttsCacheKey(text, language, voice)}.mp3`;
    const file = bucket().file(path);
    const [exists] = await file.exists();
    if (!exists) {
      const [res] = await client.synthesizeSpeech({
        input: { text },
        voice: { languageCode: language, name: voice },
        audioConfig: { audioEncoding: 'MP3' },
      });
      if (!res.audioContent) return undefined;
      await file.save(Buffer.from(res.audioContent as Uint8Array), {
        contentType: 'audio/mpeg',
        metadata: { cacheControl: 'private, max-age=31536000, immutable' },
        resumable: false,
      });
    }
    return `gs://${cfg.bucket}/${path}`;
  };
}

/** Full raw model response(s), for the audit trail (AnalysisResult.rawResponseStorageUrl). */
export function createArchiver(cfg: { bucket: string }) {
  return async (submissionId: string, raw: unknown): Promise<string | undefined> => {
    const path = `analysis-raw/${submissionId}/${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    await getStorage(getAdminApp())
      .bucket(cfg.bucket)
      .file(path)
      .save(JSON.stringify(raw, null, 2), { contentType: 'application/json', resumable: false });
    return `gs://${cfg.bucket}/${path}`;
  };
}
