import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Spinner, ToastProvider } from '@vayusetu/ui-components';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { LiteModeProvider } from './hooks/useLiteMode';
import { AppShell } from './components/AppShell';
import { LoginScreen } from './screens/LoginScreen';
import { AlertQueue } from './screens/AlertQueue';
import { HotspotMap } from './screens/HotspotMap';
import { ForecastView } from './screens/ForecastView';
import { FederationPanel } from './screens/FederationPanel';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

function RequireSession({ children }: { children: React.ReactElement }) {
  const { ready, session } = useAuth();
  if (!ready) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner label="Loading" />
      </div>
    );
  }
  if (!session) return <LoginScreen />;
  return children;
}

/** GET /federation/models is state_admin+ only per §4.2 — mirror that gate
 *  in the router so a district_admin never even sees a 403 flash. */
function RequireStateAdmin({ children }: { children: React.ReactElement }) {
  const { session } = useAuth();
  if (session && session.role === 'district_admin') return <Navigate to="/alerts" replace />;
  return children;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthProvider>
          <LiteModeProvider>
            <BrowserRouter>
              <RequireSession>
                <Routes>
                  <Route element={<AppShell />}>
                    <Route index element={<Navigate to="/alerts" replace />} />
                    <Route path="alerts" element={<AlertQueue />} />
                    <Route path="hotspots" element={<HotspotMap />} />
                    <Route path="forecast" element={<ForecastView />} />
                    <Route
                      path="federation"
                      element={
                        <RequireStateAdmin>
                          <FederationPanel />
                        </RequireStateAdmin>
                      }
                    />
                    <Route path="*" element={<Navigate to="/alerts" replace />} />
                  </Route>
                </Routes>
              </RequireSession>
            </BrowserRouter>
          </LiteModeProvider>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
