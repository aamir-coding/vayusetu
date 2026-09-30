import * as React from 'react';
import {
  RecaptchaVerifier,
  linkWithPhoneNumber,
  onAuthStateChanged,
  signInAnonymously,
  signInWithPhoneNumber,
  type ConfirmationResult,
} from 'firebase/auth';
import type { User, UserRole } from '@vayusetu/shared-types';
import { firebaseAuth, isFirebaseConfigured } from '../lib/firebase';
import { ApiClientError, usersApi } from '../lib/apiClient';
import i18n, { i18nCodeToBcp47 } from '../i18n';

/**
 * Product Spec Feature 1, Persona 1 (Rina): "no login wall that blocks a
 * first-time report." API_CONTRACTS.md §4.2: "no unauthenticated endpoint
 * exists ... because jurisdiction-correct routing requires a resolvable
 * identity." Both are true at once via Firebase anonymous auth: every
 * citizen gets a real, valid Firebase UID + ID token with zero visible UI,
 * satisfying the bearer-token requirement on every call, while phone
 * verification becomes an *optional* upgrade (`linkWithPhoneNumber` keeps
 * the same uid, so history carries over) rather than a gate. Field workers
 * are expected to verify their phone before their first report, since
 * their reports anchor the Hotspot Fusion Engine's confidence and need a
 * durable, accountable identity — see `role` note below.
 */

const MOCK_SESSION_KEY = 'vayusetu:mockAuthSession';
const MOCK_OTP = '123456';

interface MockSession {
  uid: string;
  phoneNumber: string | null;
}

function loadMockSession(): MockSession {
  try {
    const raw = localStorage.getItem(MOCK_SESSION_KEY);
    if (raw) return JSON.parse(raw) as MockSession;
  } catch {
    // corrupt/blocked storage — fall through to a fresh session
  }
  const fresh: MockSession = { uid: `mock-${Math.random().toString(36).slice(2, 10)}`, phoneNumber: null };
  localStorage.setItem(MOCK_SESSION_KEY, JSON.stringify(fresh));
  return fresh;
}

interface AuthContextValue {
  ready: boolean;
  uid: string | null;
  user: User | null;
  isAnonymous: boolean;
  isMockMode: boolean;
  getToken: () => Promise<string>;
  /** Idempotent: registers the backend User doc on first real need (lazy —
   *  not on every app boot) so a citizen who never submits never creates
   *  server-side state at all. */
  ensureRegistered: (opts?: {
    role?: Extract<UserRole, 'citizen' | 'field_worker'>;
    displayName?: string;
    preferredLanguage?: string;
  }) => Promise<User>;
  updateProfile: (patch: Partial<Pick<User, 'displayName' | 'preferredLanguage' | 'fcmTokens'>>) => Promise<User>;
  sendOtp: (phoneNumber: string) => Promise<void>;
  /** role/displayName are ONLY applied if this is the account's first
   *  registration — API_CONTRACTS.md's PATCH /users/me cannot change role
   *  after the fact, so a citizen cannot "become" a field worker later via
   *  this client alone. That's a real contract gap worth raising with
   *  Engineer 2, not something to silently work around here. */
  confirmOtp: (code: string, opts?: { role?: Extract<UserRole, 'citizen' | 'field_worker'>; displayName?: string }) => Promise<User>;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = React.useState(false);
  const [uid, setUid] = React.useState<string | null>(null);
  const [isAnonymous, setIsAnonymous] = React.useState(true);
  const [user, setUser] = React.useState<User | null>(null);
  const confirmationRef = React.useRef<ConfirmationResult | null>(null);
  const recaptchaRef = React.useRef<RecaptchaVerifier | null>(null);

  // Resolves once the first signed-in identity exists (real or mock).
  // getToken() awaits it: on a fresh load / deep link (e.g. /result/:id from
  // My Reports or a notification) queries run before Firebase restores the
  // session, and throwing there rendered "couldn't be analyzed" (27 Sep).
  const identityReady = React.useRef<{ promise: Promise<void>; resolve: () => void } | null>(null);
  if (!identityReady.current) {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    identityReady.current = { promise, resolve };
  }

  // --- boot: sign in anonymously (real) or load the mock session ---
  React.useEffect(() => {
    if (!isFirebaseConfigured || !firebaseAuth) {
      const session = loadMockSession();
      setUid(session.uid);
      setIsAnonymous(!session.phoneNumber);
      setReady(true);
      identityReady.current?.resolve();
      return;
    }

    const auth = firebaseAuth;
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (!firebaseUser) {
        try {
          await signInAnonymously(auth);
        } catch (err) {
          console.error('Anonymous sign-in failed', err);
          setReady(true);
        }
        return; // onAuthStateChanged will fire again with the new user
      }
      setUid(firebaseUser.uid);
      setIsAnonymous(firebaseUser.isAnonymous);
      setReady(true);
      identityReady.current?.resolve();
    });
    return unsubscribe;
  }, []);

  const getToken = React.useCallback(async (): Promise<string> => {
    // Wait (bounded) for the session instead of failing the first queries.
    await Promise.race([identityReady.current!.promise, new Promise((r) => setTimeout(r, 15_000))]);
    if (isFirebaseConfigured && firebaseAuth?.currentUser) {
      return firebaseAuth.currentUser.getIdToken();
    }
    const mockUid = uid ?? (isFirebaseConfigured ? null : loadMockSession().uid);
    if (!mockUid) throw new Error('Not signed in yet');
    return `mock-token:${mockUid}`;
  }, [uid]);

  const ensureRegistered = React.useCallback<AuthContextValue['ensureRegistered']>(
    async (opts) => {
      const token = await getToken();
      // The language the citizen is USING -- the UI language. The switcher can
      // only PATCH a profile it has loaded, so a choice made before the first
      // report (or after a reload, before any API call) never reached
      // User.preferredLanguage, and Gemini/TTS answered in the old language
      // (29 Sep live tests: Hindi UI -> English advisory; Marathi UI -> Hindi).
      // The UI control is the single source of truth, so sync it here, where
      // every report passes. i18next falls back to the browser language.
      const uiLang = i18nCodeToBcp47(i18n.resolvedLanguage ?? i18n.language);
      try {
        let existing = await usersApi.me(token);
        if (existing.preferredLanguage !== uiLang) {
          existing = await usersApi.update(token, { preferredLanguage: uiLang });
        }
        setUser(existing);
        return existing;
      } catch (err) {
        if (!(err instanceof ApiClientError) || err.status !== 404) throw err;
      }
      let created: User;
      try {
        created = await usersApi.register(token, {
          displayName: opts?.displayName?.trim() || 'Citizen Reporter',
          preferredLanguage: opts?.preferredLanguage ?? uiLang,
          role: opts?.role ?? 'citizen',
        });
      } catch (err) {
        // 409 = the profile exists (e.g. a stale "not found" earlier, or a
        // registration that raced another tab): registration is idempotent.
        if (!(err instanceof ApiClientError) || err.status !== 409) throw err;
        created = await usersApi.me(token);
      }
      setUser(created);
      return created;
    },
    [getToken],
  );

  const updateProfile = React.useCallback<AuthContextValue['updateProfile']>(
    async (patch) => {
      const token = await getToken();
      const updated = await usersApi.update(token, patch);
      setUser(updated);
      return updated;
    },
    [getToken],
  );

  const sendOtp = React.useCallback(async (phoneNumber: string) => {
    if (isFirebaseConfigured && firebaseAuth) {
      if (!recaptchaRef.current) {
        recaptchaRef.current = new RecaptchaVerifier(firebaseAuth, 'recaptcha-container', { size: 'invisible' });
      }
      const currentUser = firebaseAuth.currentUser;
      confirmationRef.current =
        currentUser && currentUser.isAnonymous
          ? await linkWithPhoneNumber(currentUser, phoneNumber, recaptchaRef.current)
          : await signInWithPhoneNumber(firebaseAuth, phoneNumber, recaptchaRef.current);
      return;
    }
    // Mock mode: simulate network latency, no real SMS is ever sent.
    await new Promise((resolve) => setTimeout(resolve, 700));
    const session = loadMockSession();
    session.phoneNumber = phoneNumber;
    localStorage.setItem(MOCK_SESSION_KEY, JSON.stringify(session));
  }, []);

  const confirmOtp = React.useCallback<AuthContextValue['confirmOtp']>(
    async (code, opts) => {
      if (isFirebaseConfigured && firebaseAuth) {
        if (!confirmationRef.current) throw new Error('Call sendOtp() first');
        const result = await confirmationRef.current.confirm(code);
        setUid(result.user.uid);
        setIsAnonymous(false);
        return ensureRegistered(opts);
      }
      // Mock mode: fixed dev OTP, documented in .env.example / README.
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (code !== MOCK_OTP) throw new Error(`Incorrect code. Use ${MOCK_OTP} in mock mode.`);
      setIsAnonymous(false);
      return ensureRegistered(opts);
    },
    [ensureRegistered],
  );

  const value = React.useMemo<AuthContextValue>(
    () => ({
      ready,
      uid,
      user,
      isAnonymous,
      isMockMode: !isFirebaseConfigured,
      getToken,
      ensureRegistered,
      updateProfile,
      sendOtp,
      confirmOtp,
    }),
    [ready, uid, user, isAnonymous, getToken, ensureRegistered, updateProfile, sendOtp, confirmOtp],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = React.useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
