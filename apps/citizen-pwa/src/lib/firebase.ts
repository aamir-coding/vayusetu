import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';

/**
 * True until Engineer 2's Terraform stands up a real Firebase project and
 * VITE_FIREBASE_API_KEY etc. are filled in (see .env.example). In mock mode,
 * `src/hooks/useAuth.tsx` uses an in-memory mock auth session instead of the
 * real Firebase SDK, and `src/mocks/handlers.ts` (MSW) stands in for
 * submission-service — so the whole capture → analyze → snapshot loop is
 * fully exercisable with zero real infrastructure.
 */
export const isFirebaseConfigured = Boolean(import.meta.env.VITE_FIREBASE_API_KEY);

let app: FirebaseApp | null = null;
let auth: Auth | null = null;

if (isFirebaseConfigured) {
  app = initializeApp({
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
  });
  auth = getAuth(app);
}

export { app as firebaseApp, auth as firebaseAuth };

/**
 * Firebase App Check (audit H1): proves API calls come from this PWA in a
 * real browser, not a script minting anonymous accounts. Only active when
 * Terraform ships VITE_RECAPTCHA_SITE_KEY (enable_app_check); the SDK is
 * loaded lazily so builds without a key carry none of it.
 */
const recaptchaSiteKey = import.meta.env.VITE_RECAPTCHA_SITE_KEY;
let appCheckReady: Promise<import('firebase/app-check').AppCheck | null> | null = null;

function appCheck() {
  if (!app || !recaptchaSiteKey) return null;
  const firebaseApp = app;
  appCheckReady ??= import('firebase/app-check')
    .then(({ initializeAppCheck, ReCaptchaEnterpriseProvider }) =>
      initializeAppCheck(firebaseApp, { provider: new ReCaptchaEnterpriseProvider(recaptchaSiteKey), isTokenAutoRefreshEnabled: true }),
    )
    .catch(() => null);
  return appCheckReady;
}

/**
 * `{ 'X-Firebase-AppCheck': token }`, or `{}` when App Check is off or the
 * token cannot be minted. Never throws: submission-service decides (monitor
 * logs, enforce rejects), so a reCAPTCHA hiccup in monitor mode costs nothing.
 */
export async function appCheckHeaders(): Promise<Record<string, string>> {
  const ready = appCheck();
  if (!ready) return {};
  try {
    const instance = await ready;
    if (!instance) return {};
    const { getToken } = await import('firebase/app-check');
    const { token } = await getToken(instance);
    return { 'X-Firebase-AppCheck': token };
  } catch {
    return {};
  }
}

// Start attestation at load, so the first report does not wait on reCAPTCHA.
void appCheck();
