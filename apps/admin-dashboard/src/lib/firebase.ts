import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';

/**
 * Architecture doc: officials authenticate via "email/SSO + custom claims
 * (role, stateCode, districtCode)". Real SSO (SAML/OIDC) is a Firebase Auth
 * provider Engineer 2 configures at the project level — out of scope for
 * this app's code either way. Email/password here is the nearest
 * SDK-native stand-in so the sign-in *screen* and session plumbing are
 * real and ready; swapping the provider later doesn't touch this file's
 * shape, just which `signInWith*` call `LoginScreen` makes.
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
