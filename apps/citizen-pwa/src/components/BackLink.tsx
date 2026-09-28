import * as React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

/**
 * "Back" that does the expected thing: returns to the previous screen, or --
 * when this screen was opened directly (a shared link, a notification, a
 * reload) and there is nothing to go back to -- to `fallback`.
 */
export function BackLink({ fallback, label }: { fallback: string; label: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const hasHistory = location.key !== 'default';
  return (
    <button
      type="button"
      onClick={() => (hasHistory ? navigate(-1) : navigate(fallback))}
      className="-ml-2 flex w-fit items-center gap-1 rounded-lg px-2 py-1.5 text-sm font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-ink"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      {label}
    </button>
  );
}
