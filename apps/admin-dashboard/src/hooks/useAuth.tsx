import * as React from 'react';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import type { Jurisdiction, UserRole } from '@vayusetu/shared-types';
import { firebaseAuth, isFirebaseConfigured } from '../lib/firebase';

/**
 * API_CONTRACTS.md: "district_admin/state_admin/super_admin accounts are
 * provisioned out-of-band by a super_admin, never self-registered." There
 * is no client-side registration flow to build here, by design — this
 * context only *resolves* an already-provisioned identity (real custom
 * claims once Engineer 2's provisioning exists; a chosen mock persona
 * until then).
 */

export interface OfficialSession {
  uid: string;
  displayName: string;
  role: Extract<UserRole, 'district_admin' | 'state_admin' | 'super_admin'>;
  jurisdiction: Jurisdiction;
}

const MOCK_PERSONAS: Record<string, OfficialSession> = {
  district_admin: {
    uid: 'mock-deshmukh',
    displayName: 'Officer Deshmukh',
    role: 'district_admin',
    jurisdiction: { stateCode: 'DL', districtCode: 'DL-CENTRAL' },
  },
  state_admin: {
    uid: 'mock-iyer',
    displayName: 'Ms. Iyer',
    role: 'state_admin',
    jurisdiction: { stateCode: 'DL' },
  },
};

const MOCK_SESSION_KEY = 'vayusetu-admin:mockSession';

interface AuthContextValue {
  ready: boolean;
  session: OfficialSession | null;
  isMockMode: boolean;
  getToken: () => Promise<string>;
  signInMock: (persona: 'district_admin' | 'state_admin') => void;
  signInReal: (email: string, password: string) => Promise<void>;
  signOutUser: () => Promise<void>;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = React.useState(false);
  const [session, setSession] = React.useState<OfficialSession | null>(null);

  React.useEffect(() => {
    if (!isFirebaseConfigured || !firebaseAuth) {
      const stored = localStorage.getItem(MOCK_SESSION_KEY);
      if (stored) setSession(JSON.parse(stored) as OfficialSession);
      setReady(true);
      return;
    }
    const unsubscribe = onAuthStateChanged(firebaseAuth, async (firebaseUser) => {
      if (!firebaseUser) {
        setSession(null);
        setReady(true);
        return;
      }
      const idTokenResult = await firebaseUser.getIdTokenResult();
      const claims = idTokenResult.claims as { role?: string; stateCode?: string; districtCode?: string };
      if (claims.role && claims.stateCode) {
        setSession({
          uid: firebaseUser.uid,
          displayName: firebaseUser.email ?? firebaseUser.uid,
          role: claims.role as OfficialSession['role'],
          jurisdiction: { stateCode: claims.stateCode, districtCode: claims.districtCode },
        });
      } else {
        // Signed in, but no custom claims yet — a super_admin hasn't
        // provisioned this account. Surface as "no session" rather than
        // guessing a role.
        setSession(null);
      }
      setReady(true);
    });
    return unsubscribe;
  }, []);

  const getToken = React.useCallback(async (): Promise<string> => {
    if (isFirebaseConfigured && firebaseAuth?.currentUser) {
      return firebaseAuth.currentUser.getIdToken();
    }
    if (!session) throw new Error('Not signed in');
    return `mock-token:${session.uid}`;
  }, [session]);

  const signInMock = React.useCallback((persona: 'district_admin' | 'state_admin') => {
    const chosen = MOCK_PERSONAS[persona]!;
    localStorage.setItem(MOCK_SESSION_KEY, JSON.stringify(chosen));
    setSession(chosen);
  }, []);

  const signInReal = React.useCallback(async (email: string, password: string) => {
    if (!firebaseAuth) throw new Error('Firebase is not configured');
    await signInWithEmailAndPassword(firebaseAuth, email, password);
  }, []);

  const signOutUser = React.useCallback(async () => {
    if (isFirebaseConfigured && firebaseAuth) {
      await signOut(firebaseAuth);
    } else {
      localStorage.removeItem(MOCK_SESSION_KEY);
      setSession(null);
    }
  }, []);

  const value = React.useMemo<AuthContextValue>(
    () => ({ ready, session, isMockMode: !isFirebaseConfigured, getToken, signInMock, signInReal, signOutUser }),
    [ready, session, getToken, signInMock, signInReal, signOutUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
