import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import en from './locales/en.json';
import hi from './locales/hi.json';
import pa from './locales/pa.json';
import mr from './locales/mr.json';

/**
 * Product Spec: "Gemini generates dynamic, per-event content directly in
 * preferredLanguage ... Cloud Translation API handles static, cacheable UI
 * strings only." This i18next setup is the client-side half of that split
 * — it owns every static UI string (buttons, labels, form copy). Dynamic
 * content (the AnalysisResult.advisory text) arrives already-localized
 * from the backend and is rendered as-is, never routed through these
 * bundles.
 *
 * Supported set matches Product Spec's multilingual rules exactly: Hindi,
 * English, Punjabi, Marathi (Haryanvi is a Hindi dialect variant, so it
 * shares the `hi` bundle).
 */
export const SUPPORTED_LANGUAGES = [
  { tag: 'en-IN', code: 'en', label: 'English' },
  { tag: 'hi-IN', code: 'hi', label: 'हिन्दी' },
  { tag: 'pa-IN', code: 'pa', label: 'ਪੰਜਾਬੀ' },
  { tag: 'mr-IN', code: 'mr', label: 'मराठी' },
] as const;

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      hi: { translation: hi },
      pa: { translation: pa },
      mr: { translation: mr },
    },
    fallbackLng: 'en',
    supportedLngs: ['en', 'hi', 'pa', 'mr'],
    interpolation: { escapeValue: false },
    detection: { order: ['localStorage', 'navigator'], caches: ['localStorage'] },
  });

export default i18n;

/** BCP-47 tag (what the backend User.preferredLanguage stores) <-> i18next's 2-letter code. */
export function bcp47ToI18nCode(tag: string): string {
  return tag.split('-')[0] ?? 'en';
}

export function i18nCodeToBcp47(code: string): string {
  return SUPPORTED_LANGUAGES.find((l) => l.code === code)?.tag ?? 'en-IN';
}
