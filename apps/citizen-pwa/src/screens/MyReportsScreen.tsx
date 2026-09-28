import * as React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, ImageOff, ListChecks, MapPin, Plus, RefreshCw } from 'lucide-react';
import type { SubmissionStatus } from '@vayusetu/shared-types';
import { Button, Card, EmptyState, Skeleton, SubmissionStatusBadge, cn, formatRelative, usePageTitle } from '@vayusetu/ui-components';
import { useAuth } from '../hooks/useAuth';
import { submissionsApi } from '../lib/apiClient';

/** Left edge colour: the report's state at a glance. */
const EDGE: Record<SubmissionStatus, string> = {
  queued: 'bg-slate-300',
  uploading: 'bg-slate-300',
  pending_analysis: 'bg-blue-600',
  analyzed: 'bg-brand-500',
  flagged_for_review: 'bg-accent-500',
  failed: 'bg-red-600',
};

export function MyReportsScreen() {
  const { t, i18n } = useTranslation();
  const { getToken, user, uid } = useAuth();
  const queryClient = useQueryClient();
  const isFieldWorker = user?.role === 'field_worker';
  const title = isFieldWorker ? t('reports.titleFieldWorker') : t('reports.title');
  usePageTitle(title, t('app.name'));

  const { data, isLoading } = useQuery({
    queryKey: ['submissions', uid],
    queryFn: async () => submissionsApi.list(await getToken(), { userId: uid ?? undefined, pageSize: 50 }),
    enabled: Boolean(uid),
  });

  async function retry(id: string) {
    await submissionsApi.retryAnalysis(await getToken(), id);
    queryClient.invalidateQueries({ queryKey: ['submissions', uid] });
  }

  const items = data?.items ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-ink">{title}</h1>
          {items.length > 0 && <p className="mt-0.5 text-sm text-slate-500">{t('reports.count', { count: items.length })}</p>}
        </div>
        {items.length > 0 && (
          <Button asChild size="sm" variant="outline">
            <Link to="/capture">
              <Plus className="h-4 w-4" aria-hidden="true" /> {t('reports.newReport')}
            </Link>
          </Button>
        )}
      </div>

      {isLoading && (
        <div className="flex flex-col gap-3" aria-label={t('common.loading')}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20 w-full rounded-xl2" />
          ))}
        </div>
      )}

      {!isLoading && items.length === 0 && (
        <EmptyState
          icon={ListChecks}
          title={t('reports.empty')}
          description={t('reports.emptyHint')}
          action={
            <Button asChild size="sm">
              <Link to="/capture">{t('reports.emptyAction')}</Link>
            </Button>
          }
        />
      )}

      <ul className="flex flex-col gap-3">
        {items.map((submission, i) => (
          <li key={submission.id} className="animate-in fade-in-0 slide-in-from-bottom-2 duration-300" style={{ animationDelay: `${Math.min(i, 8) * 40}ms`, animationFillMode: 'both' }}>
            <Card className="relative flex items-center gap-3 overflow-hidden p-3 pl-4 transition-shadow hover:shadow-card">
              <span className={cn('absolute inset-y-0 left-0 w-1', EDGE[submission.status] ?? 'bg-slate-300')} aria-hidden="true" />
              <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-slate-100">
                <ImageThumb src={submission.photoStorageUrl} />
              </div>
              <Link to={`/result/${submission.id}`} className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink">{formatRelative(submission.capturedAt, i18n.resolvedLanguage ?? 'en')}</p>
                <p className="mt-0.5 text-xs text-slate-400">
                  {new Date(submission.capturedAt).toLocaleString(i18n.resolvedLanguage, { dateStyle: 'medium', timeStyle: 'short' })}
                </p>
                <p className="mt-1 flex items-center gap-1 font-mono text-[11px] text-slate-400">
                  <MapPin className="h-3 w-3" aria-hidden="true" />
                  {submission.geo.lat.toFixed(3)}, {submission.geo.lng.toFixed(3)}
                </p>
              </Link>
              <div className="flex shrink-0 flex-col items-end gap-2">
                <SubmissionStatusBadge status={submission.status} />
                {awaitingAnswer(submission) ? (
                  <Link to={`/result/${submission.id}`} className="text-xs font-semibold text-accent-700 hover:underline">
                    {t('reports.awaitingAnswer')}
                  </Link>
                ) : submission.status === 'failed' || submission.status === 'flagged_for_review' ? (
                  <button
                    type="button"
                    onClick={() => retry(submission.id)}
                    className="flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline"
                  >
                    <RefreshCw className="h-3 w-3" /> {t('common.retry')}
                  </button>
                ) : (
                  <ChevronRight className="h-4 w-4 text-slate-300" aria-hidden="true" />
                )}
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Pipeline D asked a question the citizen hasn't answered yet. */
function awaitingAnswer(s: { status: string; clarifications?: Array<{ answeredAt?: string }> }): boolean {
  const last = s.clarifications?.[s.clarifications.length - 1];
  return s.status === 'flagged_for_review' && Boolean(last && !last.answeredAt);
}

function ImageThumb({ src }: { src: string }) {
  const [failed, setFailed] = React.useState(false);
  if (failed) return <ImageOff className="h-5 w-5 text-slate-300" aria-hidden="true" />;
  return <img src={src} alt="" loading="lazy" className="h-full w-full object-cover" onError={() => setFailed(true)} />;
}
