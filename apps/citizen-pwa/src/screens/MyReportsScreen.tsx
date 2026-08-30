import * as React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ImageOff, ListChecks, RefreshCw } from 'lucide-react';
import { Button, Card, EmptyState, SubmissionStatusBadge } from '@vayusetu/ui-components';
import { useAuth } from '../hooks/useAuth';
import { submissionsApi } from '../lib/apiClient';

export function MyReportsScreen() {
  const { t } = useTranslation();
  const { getToken, user, uid } = useAuth();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['submissions', uid],
    queryFn: async () => submissionsApi.list(await getToken(), { userId: uid ?? undefined, pageSize: 50 }),
    enabled: Boolean(uid),
  });

  async function retry(id: string) {
    await submissionsApi.retryAnalysis(await getToken(), id);
    queryClient.invalidateQueries({ queryKey: ['submissions', uid] });
  }

  const isFieldWorker = user?.role === 'field_worker';
  const items = data?.items ?? [];

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-bold text-ink">
        {isFieldWorker ? t('reports.titleFieldWorker') : t('reports.title')}
      </h1>

      {isLoading && <p className="text-sm text-slate-400">{t('common.loading')}</p>}

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
        {items.map((submission) => (
          <li key={submission.id}>
            <Card className="flex items-center gap-3 p-3">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-slate-100">
                <ImageThumb src={submission.photoStorageUrl} />
              </div>
              <Link to={`/result/${submission.id}`} className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink">
                  {new Date(submission.capturedAt).toLocaleString(undefined, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  {submission.geo.lat.toFixed(3)}, {submission.geo.lng.toFixed(3)}
                </p>
              </Link>
              <div className="flex shrink-0 flex-col items-end gap-2">
                <SubmissionStatusBadge status={submission.status} />
                {(submission.status === 'failed' || submission.status === 'flagged_for_review') && (
                  <button
                    type="button"
                    onClick={() => retry(submission.id)}
                    className="flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline"
                  >
                    <RefreshCw className="h-3 w-3" /> {t('common.retry')}
                  </button>
                )}
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ImageThumb({ src }: { src: string }) {
  const [failed, setFailed] = React.useState(false);
  if (failed) return <ImageOff className="h-5 w-5 text-slate-300" aria-hidden="true" />;
  return <img src={src} alt="" className="h-full w-full object-cover" onError={() => setFailed(true)} />;
}
