import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';

import './i18n';
import './index.css';
import { useMocks } from './lib/mockMode';

// The old service worker cached per-user API responses (incl. a stale 404
// for /users/me). Drop that cache on every device that still has it.
if ('caches' in window) void caches.delete('vayusetu-api-get').catch(() => undefined);

async function enableMockingIfNeeded() {
  if (!useMocks) return;
  const { worker } = await import('./mocks/browser');
  return worker.start({ onUnhandledRequest: 'bypass' });
}

enableMockingIfNeeded().finally(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
