import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './index.css';
import './i18n';
import { useMocks } from './lib/mockMode';
import { applyTheme, readThemePreference } from '@vayusetu/ui-components';

applyTheme(readThemePreference());

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
