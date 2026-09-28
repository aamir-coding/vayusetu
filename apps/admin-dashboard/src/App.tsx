import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Spinner, ToastProvider } from '@vayusetu/ui-components';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { LiteModeProvider } from './hooks/useLiteMode';
import { AppShell } from './components/AppShell';
import { LoginScreen } from './screens/LoginScreen';
import { AlertQueue } from './screens/AlertQueue';

// Route-level splitting: the map (h3-js + Maps loader), charts (recharts) and
// federation screens load on first visit, so the alert queue -- the screen an
// official opens on a slow connection -- ships without them.
const HotspotMap = React.lazy(() =>
  import('./screens/HotspotMap').then((m) => ({ default: m.HotspotMap })),
);
const ForecastView = React.lazy(() =>
  import('./screens/ForecastView').then((m) => ({ default: m.ForecastView })),
);
const FederationPanel = React.lazy(() =>
  import('./screens/FederationPanel').then((m) => ({ default: m.FederationPanel })),
);

function Lazy({ children }: { children: React.ReactNode }) {
  return (
    <React.Suspense
      fallback={
        <div className="flex h-64 items-center justify-center">
          <Spinner label="Loading" />
        </div>
      }
    >
      {children}
    </React.Suspense>
  );
}

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
                    {/* Notification deep links (alert-service: <dashboard>/alerts/<id>) and shared links. */}
                    <Route path="alerts/:alertId" element={<AlertQueue />} />
                    <Route
                      path="hotspots"
                      element={
                        <Lazy>
                          <HotspotMap />
                        </Lazy>
                      }
                    />
                    <Route
                      path="forecast"
                      element={
                        <Lazy>
                          <ForecastView />
                        </Lazy>
                      }
                    />
                    <Route
                      path="federation"
                      element={
                        <RequireStateAdmin>
                          <Lazy>
                            <FederationPanel />
                          </Lazy>
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
