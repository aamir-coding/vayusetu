import * as React from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import {
  AlertTriangle,
  Bell,
  BellOff,
  Flame,
  LineChart,
  LogOut,
  Network,
  Rows3,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@vayusetu/ui-components';
import { LanguageSwitcher } from './LanguageSwitcher';
import { usePush } from '../hooks/usePush';
import { useAuth } from '../hooks/useAuth';
import { useLiteMode } from '../hooks/useLiteMode';

interface NavItem {
  to: string;
  labelKey: string;
  icon: React.ComponentType<{ className?: string }>;
  minRole?: 'state_admin';
}

const NAV_ITEMS: NavItem[] = [
  { to: '/alerts', labelKey: 'nav.alerts', icon: AlertTriangle },
  { to: '/hotspots', labelKey: 'nav.hotspots', icon: Flame },
  { to: '/forecast', labelKey: 'nav.forecast', icon: LineChart },
  { to: '/federation', labelKey: 'nav.federation', icon: Network, minRole: 'state_admin' },
];

export function AppShell() {
  const { t } = useTranslation();
  const { session, signOutUser } = useAuth();
  const { liteMode, setLiteMode } = useLiteMode();
  const push = usePush();

  const canSeeFederation = session?.role === 'state_admin' || session?.role === 'super_admin';

  return (
    <div className="flex min-h-dvh bg-paper">
      <aside className="flex w-64 shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-4">
          <img src="/vayusetu-icon.svg" alt="" className="h-7 w-7 rounded-md" />
          <div>
            <p className="font-sans text-sm font-bold leading-none text-brand-800">VayuSetu</p>
            <p className="mt-1 text-[11px] leading-none text-slate-400">{t('app.console')}</p>
          </div>
        </div>

        <nav className="flex flex-1 flex-col gap-0.5 p-3">
          {NAV_ITEMS.filter((item) => !item.minRole || canSeeFederation).map(({ to, labelKey, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                  isActive ? 'bg-brand-50 text-brand-800' : 'text-slate-600 hover:bg-slate-50',
                )
              }
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {t(labelKey)}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-slate-100 p-3">
          <div className="mb-2 px-1">
            <LanguageSwitcher />
          </div>
          {push.available && (
            <button
              type="button"
              onClick={() => void push.enable()}
              disabled={push.permission !== 'default'}
              className="mb-1 flex w-full items-center gap-1.5 rounded-lg px-3 py-2 text-left text-xs text-slate-500 hover:bg-slate-50 disabled:hover:bg-transparent"
            >
              {push.permission === 'denied' ? <BellOff className="h-3.5 w-3.5" aria-hidden="true" /> : <Bell className="h-3.5 w-3.5" aria-hidden="true" />}
              {push.permission === 'granted' ? t('nav.pushOn') : push.permission === 'denied' ? t('nav.pushBlocked') : t('nav.enablePush')}
            </button>
          )}
          <label className="flex items-center justify-between rounded-lg px-3 py-2 text-xs text-slate-500">
            <span className="flex items-center gap-1.5">
              <Rows3 className="h-3.5 w-3.5" aria-hidden="true" /> {t('nav.liteMode')}
            </span>
            <input
              type="checkbox"
              checked={liteMode}
              onChange={(e) => setLiteMode(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-brand-600 focus-visible:ring-2 focus-visible:ring-brand-500"
              aria-label={t('nav.liteModeToggle')}
            />
          </label>

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
                className="shrink-0 rounded-md p-1.5 text-slate-400 hover:bg-white hover:text-slate-700"
                aria-label={t('nav.signOut')}
              >
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <main className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto max-w-6xl">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
