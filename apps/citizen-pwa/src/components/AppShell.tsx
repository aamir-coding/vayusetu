import * as React from 'react';
import { NavLink, Outlet, useLocation, useNavigationType } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Camera, CircleHelp, FileText, ShieldCheck } from 'lucide-react';
import { Aurora, cn, ThemeToggle, Tour, useTour, type TourStep } from '@vayusetu/ui-components';
import { LanguageSwitcher } from './LanguageSwitcher';
import { OfflineQueueBanner } from './OfflineQueueBanner';
import { useAuth } from '../hooks/useAuth';
import { PORTAL_URL } from '../lib/links';


const NAV_ITEMS = [
  { to: '/capture', labelKey: 'nav.capture', icon: Camera, tour: 'nav-capture' },
  { to: '/reports', labelKey: 'nav.reports', icon: FileText, tour: 'nav-reports' },
] as const;

export function AppShell() {
  const { t } = useTranslation();
  const { isAnonymous } = useAuth();
  const location = useLocation();
  const navType = useNavigationType();
  // New screen -> start at the top; Back keeps where you were.
  React.useEffect(() => {
    if (navType === 'PUSH') window.scrollTo({ top: 0 });
  }, [location.pathname, navType]);
  // First visit: the guide opens on the Report screen, where it points at things.
  const tour = useTour('vayusetu-pwa:tour-v1', { autoStart: location.pathname === '/capture', delayMs: 900 });

  const steps = React.useMemo<TourStep[]>(
    () => [
      { title: t('tour.welcomeTitle'), body: t('tour.welcomeBody') },
      { target: 'photo', title: t('tour.photoTitle'), body: t('tour.photoBody') },
      { target: 'voice', title: t('tour.voiceTitle'), body: t('tour.voiceBody') },
      { target: 'location', title: t('tour.locationTitle'), body: t('tour.locationBody') },
      { target: 'send', title: t('tour.sendTitle'), body: t('tour.sendBody') },
      { target: 'nav-reports', title: t('tour.reportsTitle'), body: t('tour.reportsBody') },
      { target: 'help', title: t('tour.helpTitle'), body: t('tour.helpBody') },
    ],
    [t],
  );

  return (
    <div className="relative isolate flex min-h-dvh flex-col bg-paper">
      <Aurora className="fixed inset-0 -z-10" />
      <header
        className="sticky top-0 z-20 border-b border-slate-200/60 bg-surface/70 backdrop-blur-md"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <div className="mx-auto flex w-full max-w-md items-center gap-0.5 px-3 py-2">
          <a href={PORTAL_URL} className="group mr-auto flex items-center gap-2 rounded-lg py-1 pr-2" title={t('nav.home')}>
            <img src="/vayusetu-icon.svg" alt="" className="h-7 w-7 rounded-lg transition-transform group-hover:-rotate-6 group-hover:scale-105" />
            <span className="font-sans text-lg font-bold tracking-tight text-brand-800">{t('app.name')}</span>
          </a>
          {isAnonymous && (
            <NavLink
              to="/verify"
              className="flex items-center gap-1 rounded-lg px-2 py-2 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-brand-700"
              aria-label={t('common.verify')}
            >
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              <span className="hidden min-[400px]:inline">{t('common.verify')}</span>
            </NavLink>
          )}
          <ThemeToggle labels={{ toDark: t('theme.toDark'), toLight: t('theme.toLight') }} />
          <button
            type="button"
            data-tour="help"
            onClick={tour.start}
            aria-label={t('nav.help')}
            title={t('nav.help')}
            className="rounded-lg p-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-ink"
          >
            <CircleHelp className="h-[18px] w-[18px]" aria-hidden="true" />
          </button>
          <LanguageSwitcher />
        </div>
      </header>

      <OfflineQueueBanner />

      <main className="mx-auto w-full max-w-md flex-1 px-4 pb-28 pt-5">
        <div key={location.pathname} className="animate-in fade-in-0 slide-in-from-bottom-2 duration-300">
          <Outlet />
        </div>
        <p className="mt-10 text-center">
          <a href={PORTAL_URL} className="text-xs text-slate-400 underline-offset-4 transition-colors hover:text-brand-700 hover:underline">
            {t('nav.about')}
          </a>
        </p>
      </main>

      <nav
        className="fixed inset-x-0 bottom-0 z-20 mx-auto flex w-full max-w-md items-stretch border-t border-slate-200 bg-surface/95 backdrop-blur-md"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        aria-label={t('nav.primary')}
      >
        {NAV_ITEMS.map(({ to, labelKey, icon: Icon, tour: tourId }) => (
          <NavLink
            key={to}
            to={to}
            data-tour={tourId}
            className={({ isActive }) =>
              cn(
                'relative flex flex-1 flex-col items-center gap-1 py-2.5 text-xs font-medium transition-colors',
                isActive ? 'text-brand-700' : 'text-slate-400 hover:text-slate-600',
              )
            }
          >
            {({ isActive }) => (
              <>
                <span
                  className={cn(
                    'absolute top-0 h-0.5 w-10 rounded-full bg-brand-500 transition-all duration-300',
                    isActive ? 'opacity-100' : 'scale-x-0 opacity-0',
                  )}
                />
                <Icon className="h-6 w-6" strokeWidth={isActive ? 2.4 : 2} aria-hidden="true" />
                {t(labelKey)}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <Tour
        steps={steps}
        open={tour.open}
        onClose={tour.close}
        labels={{
          next: t('tour.next'),
          back: t('tour.back'),
          done: t('tour.done'),
          skip: t('tour.skip'),
          progress: (i, n) => t('tour.progress', { current: i, total: n }),
        }}
      />
    </div>
  );
}
