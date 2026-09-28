import * as React from 'react';
import { NavLink, Outlet, useLocation, useNavigationType } from 'react-router-dom';
import {
  AlertTriangle,
  Bell,
  BellOff,
  CircleHelp,
  Flame,
  House,
  LineChart,
  LogOut,
  Menu,
  Network,
  Rows3,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn, ThemeToggle, Tour, useTour, type TourStep } from '@vayusetu/ui-components';
import { LanguageSwitcher } from './LanguageSwitcher';
import { usePush } from '../hooks/usePush';
import { useAuth } from '../hooks/useAuth';
import { PORTAL_URL } from '../lib/links';
import { useLiteMode } from '../hooks/useLiteMode';


interface NavItem {
  to: string;
  labelKey: string;
  shortKey: string;
  tour: string;
  icon: LucideIcon;
  minRole?: 'state_admin';
}

const NAV_ITEMS: NavItem[] = [
  { to: '/alerts', labelKey: 'nav.alerts', shortKey: 'nav.alertsShort', tour: 'nav-alerts', icon: AlertTriangle },
  { to: '/hotspots', labelKey: 'nav.hotspots', shortKey: 'nav.hotspotsShort', tour: 'nav-hotspots', icon: Flame },
  { to: '/forecast', labelKey: 'nav.forecast', shortKey: 'nav.forecast', tour: 'nav-forecast', icon: LineChart },
  { to: '/federation', labelKey: 'nav.federation', shortKey: 'nav.federation', tour: 'nav-federation', icon: Network, minRole: 'state_admin' },
];

export function AppShell() {
  const { t } = useTranslation();
  const { session } = useAuth();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const tour = useTour('vayusetu-admin:tour-v1');

  const canSeeFederation = session?.role === 'state_admin' || session?.role === 'super_admin';
  const items = NAV_ITEMS.filter((item) => !item.minRole || canSeeFederation);
  const current = items.find((i) => location.pathname.startsWith(i.to));

  React.useEffect(() => setMenuOpen(false), [location.pathname]);
  // New screen -> start at the top; Back keeps where you were.
  const navType = useNavigationType();
  React.useEffect(() => {
    if (navType === 'PUSH') window.scrollTo({ top: 0 });
  }, [location.pathname, navType]);

  const steps = React.useMemo<TourStep[]>(
    () => [
      { title: t('tour.welcomeTitle', { name: session?.displayName ?? '' }), body: t('tour.welcomeBody') },
      { target: 'nav-alerts', title: t('nav.alerts'), body: t('tour.alertsBody') },
      { target: 'nav-hotspots', title: t('nav.hotspots'), body: t('tour.hotspotsBody') },
      { target: 'nav-forecast', title: t('nav.forecast'), body: t('tour.forecastBody') },
      ...(canSeeFederation ? [{ target: 'nav-federation', title: t('nav.federation'), body: t('tour.federationBody') }] : []),
      { target: 'push', title: t('tour.pushTitle'), body: t('tour.pushBody') },
      { target: 'help', title: t('tour.helpTitle'), body: t('tour.helpBody') },
    ],
    [t, session?.displayName, canSeeFederation],
  );

  const startTour = () => {
    setMenuOpen(false);
    tour.start();
  };

  return (
    <div className="flex min-h-dvh bg-paper">
      {/* Desktop / tablet-landscape: sidebar */}
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-slate-200 bg-surface lg:flex">
        <Brand subtitle={t('app.console')} homeLabel={t('nav.home')} />
        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-3" aria-label={t('nav.primary')}>
          {items.map(({ to, labelKey, tour: tourId, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              data-tour={tourId}
              className={({ isActive }) =>
                cn(
                  'group flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                  isActive ? 'bg-brand-50 text-brand-800' : 'text-slate-600 hover:bg-slate-50 hover:text-ink',
                )
              }
            >
              <Icon className="h-4 w-4 transition-transform group-hover:scale-110" aria-hidden="true" />
              {t(labelKey)}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-slate-100 p-3">
          <SettingsPanel onHelp={startTour} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Phones and small tablets: top bar */}
        <header
          className="sticky top-0 z-30 flex items-center gap-2 border-b border-slate-200/70 bg-surface/85 px-3 pb-2 backdrop-blur-md lg:hidden"
          style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }}
        >
          <a href={PORTAL_URL} title={t('nav.home')} className="shrink-0 rounded-lg">
            <img src="/vayusetu-icon.svg" alt={t('nav.home')} className="h-8 w-8 rounded-lg" />
          </a>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-bold leading-tight text-ink">{current ? t(current.labelKey) : 'VayuSetu'}</p>
            <p className="truncate text-[11px] leading-tight text-slate-400">
              {session ? `${t(`role.${session.role}`)} · ${session.jurisdiction.districtCode ?? session.jurisdiction.stateCode}` : t('app.console')}
            </p>
          </div>
          <ThemeToggle labels={{ toDark: t('theme.toDark'), toLight: t('theme.toLight') }} />
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            data-tour="help"
            aria-label={t('nav.menu')}
            aria-expanded={menuOpen}
            className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 hover:text-ink"
          >
            <Menu className="h-5 w-5" aria-hidden="true" />
          </button>
        </header>

        <main className="flex-1 px-4 pb-28 pt-4 sm:px-6 lg:p-6">
          <div key={location.pathname} className="mx-auto max-w-6xl animate-in fade-in-0 slide-in-from-bottom-2 duration-300">
            <Outlet />
          </div>
        </main>
      </div>

      {/* Phones: bottom tabs, one thumb away */}
      <nav
        className="fixed inset-x-0 bottom-0 z-30 flex border-t border-slate-200 bg-surface/95 backdrop-blur-md lg:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        aria-label={t('nav.primary')}
      >
        {items.map(({ to, shortKey, tour: tourId, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            data-tour={tourId}
            className={({ isActive }) =>
              cn(
                'relative flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium transition-colors',
                isActive ? 'text-brand-700' : 'text-slate-400 hover:text-slate-600',
              )
            }
          >
            {({ isActive }) => (
              <>
                <span
                  className={cn(
                    'absolute top-0 h-0.5 w-8 rounded-full bg-brand-500 transition-all duration-300',
                    isActive ? 'opacity-100' : 'scale-x-0 opacity-0',
                  )}
                />
                <Icon className="h-[22px] w-[22px]" strokeWidth={isActive ? 2.4 : 2} aria-hidden="true" />
                {t(shortKey)}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {menuOpen && <MobileMenu onClose={() => setMenuOpen(false)} onHelp={startTour} />}

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

function Brand({ subtitle, homeLabel }: { subtitle: string; homeLabel: string }) {
  return (
    <a href={PORTAL_URL} title={homeLabel} className="group flex items-center gap-2 border-b border-slate-100 px-5 py-4">
      <img src="/vayusetu-icon.svg" alt="" className="h-7 w-7 rounded-md transition-transform group-hover:-rotate-6 group-hover:scale-105" />
      <div>
        <p className="font-sans text-sm font-bold leading-none text-brand-800">VayuSetu</p>
        <p className="mt-1 text-[11px] leading-none text-slate-400">{subtitle}</p>
      </div>
    </a>
  );
}

/** Settings + account: the sidebar footer on desktop, the menu sheet on phones. */
function SettingsPanel({ onHelp }: { onHelp: () => void }) {
  const { t } = useTranslation();
  const { session, signOutUser } = useAuth();
  const { liteMode, setLiteMode } = useLiteMode();
  const push = usePush();
  const row = 'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-slate-600 transition-colors hover:bg-slate-50 hover:text-ink';

  return (
    <div className="flex flex-col gap-0.5">
      <div className="mb-1.5 px-1">
        <LanguageSwitcher />
      </div>
      <ThemeToggle showLabel labels={{ toDark: t('theme.toDark'), toLight: t('theme.toLight') }} className={row} />
      {push.available && (
        <button
          type="button"
          data-tour="push"
          onClick={() => void push.enable()}
          disabled={push.permission !== 'default'}
          className={cn(row, 'disabled:hover:bg-transparent')}
        >
          {push.permission === 'denied' ? <BellOff className="h-4 w-4" aria-hidden="true" /> : <Bell className="h-4 w-4" aria-hidden="true" />}
          {push.permission === 'granted' ? t('nav.pushOn') : push.permission === 'denied' ? t('nav.pushBlocked') : t('nav.enablePush')}
        </button>
      )}
      <label className={cn(row, 'cursor-pointer justify-between')}>
        <span className="flex items-center gap-2">
          <Rows3 className="h-4 w-4" aria-hidden="true" /> {t('nav.liteMode')}
        </span>
        <input
          type="checkbox"
          checked={liteMode}
          onChange={(e) => setLiteMode(e.target.checked)}
          className="h-4 w-4 rounded border-slate-300 text-brand-600 focus-visible:ring-2 focus-visible:ring-brand-500"
          aria-label={t('nav.liteModeToggle')}
        />
      </label>
      <button type="button" data-tour="help" onClick={onHelp} className={row}>
        <CircleHelp className="h-4 w-4" aria-hidden="true" />
        {t('nav.help')}
      </button>
      <a href={PORTAL_URL} className={row}>
        <House className="h-4 w-4" aria-hidden="true" />
        {t('nav.home')}
      </a>

      {session && (
        <div className="mt-2 flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2.5">
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold text-ink">{session.displayName}</p>
            <p className="truncate text-[11px] text-slate-400">
              {t(`role.${session.role}`)} · {session.jurisdiction.districtCode ?? session.jurisdiction.stateCode}
            </p>
          </div>
          <button
            type="button"
            onClick={() => signOutUser()}
            className="shrink-0 rounded-md p-1.5 text-slate-400 hover:bg-surface hover:text-ink"
            aria-label={t('nav.signOut')}
            title={t('nav.signOut')}
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}

function MobileMenu({ onClose, onHelp }: { onClose: () => void; onHelp: () => void }) {
  const { t } = useTranslation();
  const panelRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label={t('nav.menu')}>
      <button type="button" aria-label={t('nav.closeMenu')} onClick={onClose} className="absolute inset-0 bg-night/50 backdrop-blur-[2px] animate-in fade-in-0" />
      <div
        ref={panelRef}
        tabIndex={-1}
        className="absolute inset-y-0 right-0 flex w-[min(20rem,86vw)] flex-col bg-surface shadow-2xl outline-none animate-in slide-in-from-right duration-300"
        style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <p className="text-sm font-bold text-ink">{t('nav.settings')}</p>
          <button type="button" onClick={onClose} aria-label={t('nav.closeMenu')} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-ink">
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          <SettingsPanel onHelp={onHelp} />
        </div>
      </div>
    </div>
  );
}
