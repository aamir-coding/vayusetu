// FCM background handler for the officials' dashboard. alert-service sends
// `notification` + `data.link`; the SDK shows the notification itself, and a
// click opens the alert (webpush.fcmOptions.link, or data.link as fallback).
//
// Service workers can't read Vite env, so the (public) web-app config comes
// in on the registration URL -- see src/lib/pushNotifications.ts.
importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.2/firebase-messaging-compat.js');

const params = new URL(self.location.href).searchParams;
firebase.initializeApp({
  apiKey: params.get('apiKey'),
  projectId: params.get('projectId'),
  messagingSenderId: params.get('messagingSenderId'),
  appId: params.get('appId'),
});
firebase.messaging();

self.addEventListener('notificationclick', (event) => {
  const link = event.notification?.data?.FCM_MSG?.data?.link;
  if (!link) return;
  event.notification.close();
  event.waitUntil(self.clients.openWindow(link));
});
