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
