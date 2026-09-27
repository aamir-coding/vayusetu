/**
 * The four languages VayuSetu supports end to end (PRODUCT_SPEC: Hindi,
 * English, Punjabi, Marathi; Haryanvi handled as Hindi). Every Google API in
 * the chain (Gemini advisory language, Speech-to-Text, Text-to-Speech voices)
 * needs the full BCP-47 tag -- a bare "en" made TTS reject the voice name
 * `en-Chirp3-HD-Aoede` on the first live report.
 */
export const SUPPORTED_LANGUAGES = ['hi-IN', 'en-IN', 'mr-IN', 'pa-IN'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const DEFAULT_LANGUAGE: SupportedLanguage = 'en-IN';

/** "en", "EN-in", "en_IN", "hi" -> canonical tag; anything unsupported -> en-IN. */
export function normalizeLanguage(tag: string | undefined | null): SupportedLanguage {
  const primary = (tag ?? '').trim().replace('_', '-').split('-')[0]!.toLowerCase();
  // Haryanvi (bgc) is served as Hindi (PRODUCT_SPEC multilingual rules).
  const mapped = primary === 'bgc' ? 'hi' : primary;
  return SUPPORTED_LANGUAGES.find((l) => l.startsWith(`${mapped}-`)) ?? DEFAULT_LANGUAGE;
}
