import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ClipboardList, PlayCircle, XCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { Alert, AlertStatus } from '@vayusetu/shared-types';
import {
  AlertStatusBadge,
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
  SeverityBadge,
  Tabs,
  TabsList,
  TabsTrigger,
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

function relativeTime(iso: string, t: TFunction): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return t('alerts.justNow');
  if (mins < 60) return t('alerts.minutesAgo', { count: mins });
  const hours = Math.round(mins / 60);
  if (hours < 24) return t('alerts.hoursAgo', { count: hours });
  return t('alerts.daysAgo', { count: Math.round(hours / 24) });
}

export function AlertQueue() {
  const { t } = useTranslation();
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = React.useState<AlertStatus | 'all'>('all');
  const [selected, setSelected] = React.useState<Alert | null>(null);

  const live = useLiveAlerts();
  const { data, isLoading } = useQuery({
    queryKey: ['alerts', statusFilter],
    queryFn: async () => alertsApi.list(await getToken(), statusFilter === 'all' ? {} : { status: statusFilter }),
    // The Firestore listener pushes changes; poll only when it isn't live.
    refetchInterval: live ? false : 60_000,
  });

  const updateStatus = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: AlertStatus }) => {
      const token = await getToken();
      return alertsApi.updateStatus(token, id, { status });
    },
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ['alerts'] });
      setSelected((current) => (current?.id === updated.id ? updated : current));
    },
  });

  const items = data?.items ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-ink">{t('alerts.title')}</h1>
          <p className="flex items-center gap-2 text-sm text-slate-500">
            {t('alerts.subtitle')}
            <span className={live ? 'flex items-center gap-1 text-emerald-600' : 'flex items-center gap-1 text-slate-400'}>
              <span className={live ? 'h-2 w-2 animate-pulse rounded-full bg-emerald-500' : 'h-2 w-2 rounded-full bg-slate-300'} />
              {live ? t('alerts.live') : t('alerts.polling')}
            </span>
          </p>
        </div>
        <Tabs value={statusFilter} onValueChange={(v) => setStatusFilter(v as AlertStatus | 'all')}>
          <TabsList>
            <TabsTrigger value="all">{t('alerts.all')}</TabsTrigger>
            {(['new', 'acknowledged', 'in_progress', 'resolved'] as const).map((s) => (
              <TabsTrigger key={s} value={s}>
                {t(`alerts.status.${s}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      {isLoading && <p className="text-sm text-slate-400">{t('alerts.loading')}</p>}
      {!isLoading && items.length === 0 && (
        <EmptyState icon={ClipboardList} title={t('alerts.emptyTitle')} description={t('alerts.emptyHint')} />
      )}

      <ul className="flex flex-col gap-2">
        {items
          .slice()
          .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || b.createdAt.localeCompare(a.createdAt))
          .map((alert) => {
            const nextOptions = ALERT_STATUS_SUGGESTED_NEXT[alert.status];
            return (
              <li key={alert.id}>
                <Card className="flex items-center gap-4 p-4">
                  <GrapLadder stage={alert.impliedGrapStage} />
                  <button type="button" onClick={() => setSelected(alert)} className="min-w-0 flex-1 text-left">
                    <p className="truncate text-sm font-semibold text-ink">{alert.title}</p>
                    <p className="mt-0.5 truncate text-xs text-slate-400">
                      {t(`corridor.${alert.corridorId}`, { defaultValue: alert.corridorId })} · {relativeTime(alert.createdAt, t)}
                    </p>
                  </button>
                  <SeverityBadge severity={alert.severity} />
                  <AlertStatusBadge status={alert.status} />
                  <div className="flex shrink-0 gap-1.5">
                    {nextOptions.map((next) => {
                      const Icon = STATUS_ICON[next];
                      return (
                        <Button
                          key={next}
                          size="sm"
                          variant="outline"
                          onClick={() => updateStatus.mutate({ id: alert.id, status: next })}
                          loading={updateStatus.isPending && updateStatus.variables?.id === alert.id && updateStatus.variables.status === next}
                        >
                          <Icon className="h-3.5 w-3.5" />
                        </Button>
                      );
                    })}
                  </div>
                </Card>
              </li>
            );
          })}
      </ul>

      <Dialog open={Boolean(selected)} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-w-lg">
          {selected && (
            <>
              <DialogHeader>
                <div className="mb-1 flex items-center gap-2">
                  <SeverityBadge severity={selected.severity} />
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
                        <span>{h.byUserId}</span>
                        <span className="ml-auto font-mono">{new Date(h.at).toLocaleString()}</span>
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

              <DialogFooter>
                {ALERT_STATUS_SUGGESTED_NEXT[selected.status].map((next) => (
                  <Button
                    key={next}
                    variant={next === 'resolved' ? 'primary' : 'outline'}
                    onClick={() => updateStatus.mutate({ id: selected.id, status: next })}
                    loading={updateStatus.isPending}
                  >
                    {t('alerts.markAs', { status: t(`alerts.status.${next}`) })}
                  </Button>
                ))}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function severityRank(severity: Alert['severity']): number {
  return { info: 0, watch: 1, warning: 2, critical: 3 }[severity];
}
