import * as React from 'react';

const STORAGE_KEY = 'vayusetu-admin:liteMode';

interface LiteModeContextValue {
  liteMode: boolean;
  setLiteMode: (value: boolean) => void;
}

const LiteModeContext = React.createContext<LiteModeContextValue | null>(null);

export function LiteModeProvider({ children }: { children: React.ReactNode }) {
  const [liteMode, setLiteModeState] = React.useState(() => localStorage.getItem(STORAGE_KEY) === 'true');

  const setLiteMode = React.useCallback((value: boolean) => {
    setLiteModeState(value);
    localStorage.setItem(STORAGE_KEY, String(value));
  }, []);

  const value = React.useMemo(() => ({ liteMode, setLiteMode }), [liteMode, setLiteMode]);
  return <LiteModeContext.Provider value={value}>{children}</LiteModeContext.Provider>;
}

export function useLiteMode() {
  const ctx = React.useContext(LiteModeContext);
  if (!ctx) throw new Error('useLiteMode must be used within a LiteModeProvider');
  return ctx;
}
