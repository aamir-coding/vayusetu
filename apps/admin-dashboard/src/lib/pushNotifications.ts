import { getMessaging, getToken, isSupported, onMessage } from 'firebase/messaging';
import { firebaseApp } from './firebase';
import { usersApi } from './apiClient';
import { mergeToken } from './fcmTokens';

const VAPID_KEY = import.meta.env.VITE_FIREBASE_VAPID_KEY;

/** Web push needs: a real Firebase app, the project's VAPID key, and a
 *  browser with Push + service workers (not iOS Safari outside a PWA). */
export async function pushAvailable(): Promise<boolean> {
  return Boolean(firebaseApp && VAPID_KEY && 'Notification' in window && (await isSupported().catch(() => false)));
}

function swUrl(): string {
  const o = firebaseApp!.options;
  const q = new URLSearchParams({
    apiKey: o.apiKey ?? '',
    projectId: o.projectId ?? '',
    messagingSenderId: o.messagingSenderId ?? '',
    appId: o.appId ?? '',
  });
  return `/firebase-messaging-sw.js?${q.toString()}`;
}

/**
 * Registers (or refreshes) this browser for alert pushes. Call only after a
 * user gesture the first time -- browsers block unprompted permission asks.
 * Returns the permission state.
 */
export async function registerForPush(idToken: () => Promise<string>): Promise<NotificationPermission> {
  if (!(await pushAvailable())) return 'denied';
  const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  if (permission !== 'granted') return permission;
  const registration = await navigator.serviceWorker.register(swUrl(), { scope: '/firebase-cloud-messaging-push-scope' });
  const token = await getToken(getMessaging(firebaseApp!), { vapidKey: VAPID_KEY, serviceWorkerRegistration: registration });
  if (!token) return permission;
  const jwt = await idToken();
  const me = await usersApi.me(jwt);
  const next = mergeToken(me.fcmTokens, token);
  if (next) await usersApi.update(jwt, { fcmTokens: next });
  return permission;
}

/** Foreground pushes: the page is open, so just refresh the data (the
 *  Firestore listener already toasts new alerts). */
export async function onForegroundPush(handler: () => void): Promise<() => void> {
  if (!(await pushAvailable())) return () => undefined;
  return onMessage(getMessaging(firebaseApp!), () => handler());
}
