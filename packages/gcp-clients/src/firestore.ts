import { type App, getApps, initializeApp } from 'firebase-admin/app';
import { type Auth, getAuth } from 'firebase-admin/auth';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';
import { type Messaging, getMessaging } from 'firebase-admin/messaging';
import { getProjectId } from './env.js';

/**
 * One Admin SDK app per process. `initializeApp()` with no explicit
 * credential resolves Application Default Credentials: the Cloud Run
 * service's attached service account in production, or whatever
 * `gcloud auth application-default login` / GOOGLE_APPLICATION_CREDENTIALS
 * resolved to locally. Never construct a second `App` elsewhere in a
 * service -- always go through `getAdminApp()` so ID-token verification
 * (Auth), document reads (Firestore) and FCM (Messaging) share one credential.
 */
let app: App | undefined;

export function getAdminApp(): App {
  if (app) return app;
  const existing = getApps();
  if (existing.length > 0) {
    app = existing[0];
    return app!;
  }
  app = initializeApp({ projectId: getProjectId() });
  return app;
}

export function getDb(): Firestore {
  return getFirestore(getAdminApp());
}

export function getAdminAuth(): Auth {
  return getAuth(getAdminApp());
}

/** FCM. There is no FCM emulator -- this always talks to the real project,
 *  which is why alert-service defaults PUSH_CHANNEL_MODE=stub for local dev. */
export function getAdminMessaging(): Messaging {
  return getMessaging(getAdminApp());
}
