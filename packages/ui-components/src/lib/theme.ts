import * as React from 'react';

/**
 * Light / dark theme. The preference is 'light', 'dark', or 'system' (follow
 * the device, the default). The resolved theme is the `dark` class on <html>,
 * which theme.css (@vayusetu/config) turns into colour variables.
 *
 * Each app's public/theme-boot.js (loaded blocking in index.html <head>)
 * applies the saved theme before first paint, so a dark-mode user never sees
 * a white flash; keep it in step with this file (same key, same rule).
 */
export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'vayusetu:theme';

const systemDark = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true;

export function readThemePreference(): ThemePreference {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    /* storage blocked: follow the device */
  }
  return 'system';
}

export function resolveTheme(pref: ThemePreference): ResolvedTheme {
  return pref === 'dark' || (pref === 'system' && systemDark()) ? 'dark' : 'light';
}

export function applyTheme(pref: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(pref);
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  root.style.colorScheme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'dark' ? '#0A1015' : '#F5F8F7');
  return resolved;
}

const listeners = new Set<() => void>();

export function setThemePreference(pref: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    /* still applies for this page view */
  }
  applyTheme(pref);
  listeners.forEach((l) => l());
}

/** Current preference + resolved theme; re-renders on change and when the
 *  device theme flips while following 'system'. */
export function useTheme(): { preference: ThemePreference; resolved: ResolvedTheme; setPreference: (p: ThemePreference) => void; toggle: () => void } {
  const [preference, setPref] = React.useState<ThemePreference>(readThemePreference);
  const [resolved, setResolved] = React.useState<ResolvedTheme>(() => resolveTheme(readThemePreference()));

  React.useEffect(() => {
    const sync = () => {
      const p = readThemePreference();
      setPref(p);
      setResolved(resolveTheme(p));
    };
    listeners.add(sync);
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onSystem = () => {
      if (readThemePreference() === 'system') {
        applyTheme('system');
        sync();
      }
    };
    mq?.addEventListener?.('change', onSystem);
    return () => {
      listeners.delete(sync);
      mq?.removeEventListener?.('change', onSystem);
    };
  }, []);

  const setPreference = React.useCallback((p: ThemePreference) => setThemePreference(p), []);
  // One tap flips what you SEE; an explicit choice then sticks over the device setting.
  const toggle = React.useCallback(() => setThemePreference(resolveTheme(readThemePreference()) === 'dark' ? 'light' : 'dark'), []);
  return { preference, resolved, setPreference, toggle };
}
