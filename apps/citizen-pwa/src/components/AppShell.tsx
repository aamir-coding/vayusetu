import * as React from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Camera, FileText, ShieldCheck } from 'lucide-react';
import { cn } from '@vayusetu/ui-components';
import { LanguageSwitcher } from './LanguageSwitcher';
import { OfflineQueueBanner } from './OfflineQueueBanner';
import { useAuth } from '../hooks/useAuth';

const NAV_ITEMS = [
  { to: '/capture', labelKey: 'nav.capture', icon: Camera },
  { to: '/reports', labelKey: 'nav.reports', icon: FileText },
] as const;

export function AppShell() {
  const { t } = useTranslation();
  const { isAnonymous } = useAuth();

  return (
    <div className="flex min-h-dvh flex-col bg-paper">
      <header className="flex items-center justify-between border-b border-slate-200/70 bg-white/80 px-4 py-3 backdrop-blur">
        <span className="font-sans text-lg font-bold tracking-tight text-brand-800">{t('app.name')}</span>
        <div className="flex items-center gap-1">
          {isAnonymous && (
            <NavLink
              to="/verify"
              className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-brand-700"
            >
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
              {t('common.verify')}
            </NavLink>
          )}
          <LanguageSwitcher />
        </div>
      </header>

      <OfflineQueueBanner />

      <main className="mx-auto w-full max-w-md flex-1 px-4 pb-24 pt-5">
        <Outlet />
      </main>

      <nav
        className="fixed inset-x-0 bottom-0 z-20 mx-auto flex w-full max-w-md items-stretch border-t border-slate-200 bg-white/95 backdrop-blur"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        aria-label="Primary"
      >
        {NAV_ITEMS.map(({ to, labelKey, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              cn(
                'flex flex-1 flex-col items-center gap-1 py-2.5 text-xs font-medium transition-colors',
                isActive ? 'text-brand-700' : 'text-slate-400 hover:text-slate-600',
              )
            }
          >
            {({ isActive }) => (
              <>
                <Icon className="h-6 w-6" strokeWidth={isActive ? 2.4 : 2} aria-hidden="true" />
                {t(labelKey)}
              </>
            )}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
