import * as React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ClipboardList, Link2, PlayCircle, Search, X, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Alert, AlertStatus } from '@vayusetu/shared-types';
import {
  AlertStatusBadge,
  Aurora,
  Button,
  Card,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  GrapLadder,
  Input,
  SeverityBadge,
  Skeleton,
  cn,
  formatRelative,
  usePageTitle,
  useToast,
  ALERT_STATUS_SUGGESTED_NEXT,
} from '@vayusetu/ui-components';
import { useAuth } from '../hooks/useAuth';
import { useLiveAlerts } from '../hooks/useLiveAlerts';
import { alertsApi } from '../lib/apiClient';

const STATUS_ICON: Record<AlertStatus, React.ComponentType<{ className?: string }>> = {
  new: ClipboardList,
  acknowledged: PlayCircle,
  in_progress: PlayCircle,
  resolved: CheckCircle2,
  dismissed: XCircle,
};

/** Left edge of each card: urgency at a glance. */
const SEVERITY_EDGE: Record<Alert['severity'], string> = {
  info: 'bg-severity-info',
  watch: 'bg-severity-watch',
  warning: 'bg-severity-warning',
  critical: 'bg-severity-critical',
};

type Filter = AlertStatus | 'all';
const FILTERS: Filter[] = ['all', 'new', 'acknowledged', 'in_progress', 'resolved'];

function greetingKey(hour: number): string {
  return hour < 12 ? 'alerts.greetMorning' : hour < 17 ? 'alerts.greetAfternoon' : 'alerts.greetEvening';
}

export function AlertQueue() {
  const { t, i18n } = useTranslation();
  const { getToken, session } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { alertId } = useParams();
  const { push } = useToast();
  const [statusFilter, setStatusFilter] = React.useState<Filter>('all');
  const [search, setSearch] = React.useState('');
  usePageTitle(t('alerts.title'), 'VayuSetu');

  const live = useLiveAlerts();
  // One query for everything: the tiles count by status, the list filters locally.
  const { data, isLoading } = useQuery({
    queryKey: ['alerts', 'all'],
    queryFn: async () => alertsApi.list(await getToken(), {}),
    // The Firestore listener pushes changes; poll only when it isn't live.
    refetchInterval: live ? false : 60_000,
  });
  const all = React.useMemo(() => data?.items ?? [], [data]);

  // An alert opened by address (/alerts/:id: notification links, shared links).
  const inList = alertId ? all.find((a) => a.id === alertId) : undefined;
  const { data: fetched, isError: fetchFailed } = useQuery({
    queryKey: ['alert', alertId],
    queryFn: async () => alertsApi.get(await getToken(), alertId!),
    enabled: Boolean(alertId) && !inList && !isLoading,
    retry: false,
  });
  const selected = inList ?? (fetched?.id === alertId ? fetched : undefined) ?? null;
  const open = (a: Alert) => navigate(`/alerts/${encodeURIComponent(a.id)}`);
  const close = () => navigate('/alerts');

  const updateStatus = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: AlertStatus }) => {
      const token = await getToken();
      return alertsApi.updateStatus(token, id, { status });
    },
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ['alerts'] });
      queryClient.setQueryData(['alert', updated.id], updated);
      push({ tone: 'success', title: t('alerts.updated', { status: t(`alerts.status.${updated.status}`) }) });
    },
    onError: (error) => push({ tone: 'error', title: t('alerts.updateFailed'), description: (error as Error).message }),
  });

  // Alerts that arrive while the screen is open glow briefly.
  const seen = React.useRef<Set<string> | null>(null);
  const fresh = React.useMemo(() => {
    if (!data) return new Set<string>();
    const ids = new Set(all.map((a) => a.id));
    if (seen.current === null) {
      seen.current = ids;
      return new Set<string>();
    }
    const arrived = new Set([...ids].filter((id) => !seen.current!.has(id)));
    seen.current = ids;
    return arrived;
  }, [all, data]);

  const counts = React.useMemo(() => {
    const c: Record<string, number> = { all: all.length };
    for (const a of all) c[a.status] = (c[a.status] ?? 0) + 1;
    return c;
  }, [all]);

  const q = search.trim().toLowerCase();
  const items = all
    .filter((a) => statusFilter === 'all' || a.status === statusFilter)
    .filter(
      (a) =>
        !q ||
        a.title.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q) ||
        t(`corridor.${a.corridorId}`, { defaultValue: a.corridorId }).toLowerCase().includes(q),
    )
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || b.createdAt.localeCompare(a.createdAt));

  const place = session?.jurisdiction.districtCode ?? session?.jurisdiction.stateCode ?? '';

  async function copyLink(a: Alert) {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/alerts/${encodeURIComponent(a.id)}`);
      push({ tone: 'success', title: t('alerts.linkCopied') });
    } catch {
      /* clipboard blocked */
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Greeting band */}
      <section className="relative isolate overflow-hidden rounded-2xl border border-slate-200 bg-surface p-5 sm:p-6">
        <Aurora className="absolute inset-0 -z-10" hexGrid={false} />
        <p className="text-sm text-slate-500">{t(greetingKey(new Date().getHours()), { name: session?.displayName ?? '' })}</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="text-xl font-bold text-ink sm:text-2xl">{t('alerts.title')}</h1>
          <span className={live ? 'flex items-center gap-1.5 text-xs font-medium text-emerald-600' : 'flex items-center gap-1.5 text-xs text-slate-400'}>
            <span className={live ? 'h-2 w-2 animate-pulse rounded-full bg-emerald-500' : 'h-2 w-2 rounded-full bg-slate-300'} />
            {live ? t('alerts.live') : t('alerts.polling')}
          </span>
        </div>
        <p className="mt-0.5 text-sm text-slate-500">
          {t('alerts.subtitle')}
          {place && <span className="ml-1 font-medium text-slate-600">· {place}</span>}
        </p>

        {/* Status tiles: counts and the filter, one tap each */}
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5" role="group" aria-label={t('alerts.filterLabel')}>
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={statusFilter === f}
              onClick={() => setStatusFilter(f)}
              className={cn(
                'rounded-xl border px-3 py-2.5 text-left transition-all',
                statusFilter === f ? 'border-brand-500 bg-brand-50 shadow-sm' : 'border-slate-200 bg-surface/70 hover:border-slate-300 hover:bg-surface',
                f === 'resolved' && 'hidden sm:block',
              )}
            >
              <span className="block text-xl font-bold leading-none tabular-nums text-ink">{isLoading ? '–' : (counts[f] ?? 0)}</span>
              <span className="mt-1 block truncate text-xs text-slate-500">{f === 'all' ? t('alerts.all') : t(`alerts.status.${f}`)}</span>
            </button>
          ))}
        </div>
      </section>

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
        <Input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('alerts.searchPlaceholder')}
          aria-label={t('alerts.searchPlaceholder')}
          className="pl-9"
        />
        {search && (
          <button
            type="button"
            onClick={() => setSearch('')}
            aria-label={t('common.close')}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {isLoading && (
        <div className="flex flex-col gap-2" aria-label={t('alerts.loading')}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20 w-full rounded-xl2" />
          ))}
        </div>
      )}
      {!isLoading && items.length === 0 && (
        <EmptyState
          icon={ClipboardList}
          title={q ? t('alerts.noMatchTitle') : t('alerts.emptyTitle')}
          description={q ? t('alerts.noMatchHint') : t('alerts.emptyHint')}
        />
      )}

      <ul className="flex flex-col gap-2">
        {items.map((alert, i) => {
          const nextOptions = ALERT_STATUS_SUGGESTED_NEXT[alert.status];
          return (
            <li
              key={alert.id}
              className="animate-in fade-in-0 slide-in-from-bottom-1 duration-300"
              style={{ animationDelay: `${Math.min(i, 8) * 30}ms`, animationFillMode: 'both' }}
            >
              <Card
                className={cn(
                  'relative flex flex-col gap-3 overflow-hidden p-4 pl-5 transition-shadow hover:shadow-md sm:flex-row sm:items-center sm:gap-4',
                  fresh.has(alert.id) && 'animate-arrive',
                  (alert.status === 'resolved' || alert.status === 'dismissed') && 'opacity-75',
                )}
              >
                <span className={cn('absolute inset-y-0 left-0 w-1', SEVERITY_EDGE[alert.severity])} aria-hidden="true" />
                <div className="flex min-w-0 flex-1 items-center gap-3 sm:gap-4">
                  <GrapLadder stage={alert.impliedGrapStage} />
                  <button type="button" onClick={() => open(alert)} className="min-w-0 flex-1 text-left">
                    <p className="line-clamp-2 text-sm font-semibold text-ink hover:text-brand-700 sm:truncate">{alert.title}</p>
                    <p className="mt-0.5 truncate text-xs text-slate-400">
                      {t(`corridor.${alert.corridorId}`, { defaultValue: alert.corridorId })} · {formatRelative(alert.createdAt, i18n.resolvedLanguage ?? 'en')}
                    </p>
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <SeverityBadge severity={alert.severity} />
                  <AlertStatusBadge status={alert.status} />
                  <div className="ml-auto flex shrink-0 gap-1.5 sm:ml-0">
                    {nextOptions.map((next) => {
                      const Icon = STATUS_ICON[next];
                      const label = t(`alerts.action.${next}`);
                      return (
                        <Button
                          key={next}
                          size="sm"
                          variant="outline"
                          aria-label={label}
                          title={label}
                          onClick={() => updateStatus.mutate({ id: alert.id, status: next })}
                          loading={updateStatus.isPending && updateStatus.variables?.id === alert.id && updateStatus.variables.status === next}
                        >
                          <Icon className="h-3.5 w-3.5" />
                          <span className="sm:hidden xl:inline">{label}</span>
                        </Button>
                      );
                    })}
                  </div>
                </div>
              </Card>
            </li>
          );
        })}
      </ul>

      <Dialog open={Boolean(alertId)} onOpenChange={(o) => !o && close()}>
        <DialogContent className="sm:max-w-lg">
          {selected ? (
            <>
              <DialogHeader>
                <div className="mb-1 flex flex-wrap items-center gap-2 pr-8">
                  <SeverityBadge severity={selected.severity} />
                  <AlertStatusBadge status={selected.status} />
                  <GrapLadder stage={selected.impliedGrapStage} />
                </div>
                <DialogTitle>{selected.title}</DialogTitle>
                <DialogDescription>{selected.description}</DialogDescription>
              </DialogHeader>

              <div className="flex flex-col gap-4 text-sm">
                <div>
                  <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">{t('alerts.recommendedActions')}</p>
                  <ul className="list-inside list-disc space-y-1 text-slate-700">
                    {selected.recommendedActions.map((action) => (
                      <li key={action}>{action}</li>
                    ))}
                  </ul>
                </div>

                <div>
                  <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">{t('alerts.publicAdvisory')}</p>
                  <p className="rounded-lg bg-brand-50/70 p-3 text-ink">{selected.publicAdvisory}</p>
                </div>

                <div>
                  <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">{t('alerts.auditTrail')}</p>
                  <ul className="space-y-1.5">
                    {selected.statusHistory.map((h, i) => (
                      <li key={i} className="flex items-center gap-2 text-xs text-slate-500">
                        <AlertStatusBadge status={h.status} />
                        <span className="truncate">{h.byUserId}</span>
                        <span className="ml-auto shrink-0 font-mono">{new Date(h.at).toLocaleString()}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="flex flex-wrap gap-1.5 font-mono text-[11px] text-slate-400">
                  {selected.citedSignals.map((s) => (
                    <span key={s} className="rounded bg-slate-100 px-1.5 py-0.5">
                      {s}
                    </span>
                  ))}
                </div>
              </div>

              <DialogFooter className="sm:justify-between">
                <Button variant="ghost" size="sm" onClick={() => void copyLink(selected)}>
                  <Link2 className="h-4 w-4" /> {t('alerts.copyLink')}
                </Button>
                <div className="flex flex-col-reverse gap-2 sm:flex-row">
                  {ALERT_STATUS_SUGGESTED_NEXT[selected.status].map((next) => (
                    <Button
                      key={next}
                      variant={next === 'resolved' ? 'primary' : 'outline'}
                      onClick={() => updateStatus.mutate({ id: selected.id, status: next })}
                      loading={updateStatus.isPending && updateStatus.variables?.status === next}
                    >
                      {t('alerts.markAs', { status: t(`alerts.status.${next}`) })}
                    </Button>
                  ))}
                </div>
              </DialogFooter>
            </>
          ) : (
            <div className="py-6 text-center">
              <DialogTitle className="text-base">{fetchFailed ? t('alerts.notFound') : t('alerts.loading')}</DialogTitle>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function severityRank(severity: Alert['severity']): number {
  return { info: 0, watch: 1, warning: 2, critical: 3 }[severity];
}
