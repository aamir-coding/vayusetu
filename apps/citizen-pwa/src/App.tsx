import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '@vayusetu/ui-components';
import { AuthProvider } from './hooks/useAuth';
import { AppShell } from './components/AppShell';
import { CaptureScreen } from './screens/CaptureScreen';
import { SnapshotResult } from './screens/SnapshotResult';
import { MyReportsScreen } from './screens/MyReportsScreen';
import { PhoneAuthScreen } from './screens/auth/PhoneAuthScreen';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthProvider>
          <BrowserRouter>
            <Routes>
              <Route element={<AppShell />}>
                <Route index element={<Navigate to="/capture" replace />} />
                <Route path="capture" element={<CaptureScreen />} />
                <Route path="result/:submissionId" element={<SnapshotResult />} />
                <Route path="reports" element={<MyReportsScreen />} />
                <Route path="verify" element={<PhoneAuthScreen />} />
                <Route path="*" element={<Navigate to="/capture" replace />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
