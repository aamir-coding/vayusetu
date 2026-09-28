import * as React from 'react';

/** Sets the browser tab title to "<title> · <app>" while a screen is shown. */
export function usePageTitle(title: string | undefined, app: string): void {
  React.useEffect(() => {
    if (!title) return;
    const previous = document.title;
    document.title = `${title} · ${app}`;
    return () => {
      document.title = previous;
    };
  }, [title, app]);
}

/**
 * "5 min ago" / "5 मिनट पहले" in the reader's language, via
 * Intl.RelativeTimeFormat (no translation strings needed).
 */
export function formatRelative(iso: string, locale: string, now: number = Date.now()): string {
  const secs = Math.round((new Date(iso).getTime() - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  const abs = Math.abs(secs);
  if (abs < 60) return rtf.format(Math.round(secs), 'second');
  if (abs < 3600) return rtf.format(Math.round(secs / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(secs / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(secs / 86400), 'day');
  return new Date(iso).toLocaleDateString(locale, { dateStyle: 'medium' });
}
