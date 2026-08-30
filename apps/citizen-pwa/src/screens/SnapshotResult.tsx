import * as React from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, Eye, Pause, Play, Wind } from 'lucide-react';
import {
  AqiBadge,
  Button,
  Card,
  CardContent,
  Skeleton,
  Spinner,
  severityWord,
} from '@vayusetu/ui-components';
import { useAuth } from '../hooks/useAuth';
import { analysisApi } from '../lib/apiClient';

export function SnapshotResult() {
  const { submissionId = '' } = useParams();
  const { t } = useTranslation();
  const { getToken } = useAuth();
  const [speaking, setSpeaking] = React.useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['analysis', submissionId],
    queryFn: async () => analysisApi.get(await getToken(), submissionId),
    enabled: Boolean(submissionId),
    refetchInterval: (query) => (query.state.data?.status === 'pending_analysis' ? 1500 : false),
  });

  const status = data?.status;
  const result = data?.result;

  function playAdvisory() {
    if (!result) return;
    if (result.advisory.audioStorageUrl) {
      // Cached Cloud TTS render, once alert/analysis-service actually produces one.
      new Audio(result.advisory.audioStorageUrl).play().catch(() => undefined);
      return;
    }
    if (!('speechSynthesis' in window)) return;
    const utterance = new SpeechSynthesisUtterance(result.advisory.text);
    utterance.lang = result.advisory.language || 'en-IN';
    utterance.onend = () => setSpeaking(false);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
    setSpeaking(true);
  }

  function stopAdvisory() {
    window.speechSynthesis?.cancel();
    setSpeaking(false);
  }

  if (isLoading || status === 'queued' || status === 'uploading' || status === 'pending_analysis') {
    return (
      <div className="flex flex-col items-center gap-4 py-16 text-center">
        <div className="flex h-20 w-20 items-center justify-center rounded-full bg-brand-500/15 shadow-glow animate-breathe">
          <Wind className="h-8 w-8 text-brand-600" aria-hidden="true" />
        </div>
        <div>
          <p className="font-semibold text-ink">{t('result.analyzing')}</p>
          <p className="mt-1 text-sm text-slate-500">{t('result.analyzingHint')}</p>
        </div>
        <Skeleton className="h-32 w-full max-w-sm" />
      </div>
    );
  }

  if (status === 'failed' || (!result && status !== 'flagged_for_review')) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <AlertCircle className="h-8 w-8 text-red-500" aria-hidden="true" />
        <p className="font-semibold text-ink">{t('result.failed')}</p>
        <Button asChild variant="outline">
          <Link to="/capture">{t('result.reportAnother')}</Link>
        </Button>
      </div>
    );
  }

  if (!result) return <Spinner className="mx-auto mt-16" />;

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-xl font-bold text-ink">{t('result.title')}</h1>

      <Card>
        <CardContent className="flex flex-col gap-4 pt-5">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-slate-500">
              {t(`pollutionSource.${result.sourceClassification}`)}
            </p>
            {result.estimatedAQICategory && <AqiBadge category={result.estimatedAQICategory} />}
          </div>

          <div className="flex items-center gap-3">
            <div className="flex-1">
              <div className="flex gap-1">
                {[1, 2, 3, 4, 5].map((n) => (
                  <span
                    key={n}
                    className={`h-2 flex-1 rounded-full ${n <= result.severityEstimate ? 'bg-accent-500' : 'bg-slate-100'}`}
                  />
                ))}
              </div>
              <p className="mt-1 text-xs text-slate-500">{severityWord(result.severityEstimate)}</p>
            </div>
          </div>

          {result.visibilityMeters !== undefined && (
            <p className="flex items-center gap-1.5 text-xs text-slate-500">
              <Eye className="h-3.5 w-3.5" aria-hidden="true" />
              {t('result.visibility', { meters: result.visibilityMeters })}
            </p>
          )}

          <div className="rounded-lg bg-brand-50/70 p-4">
            <p className="text-sm leading-relaxed text-ink">{result.advisory.text}</p>
            <Button
              variant="link"
              size="sm"
              className="mt-2 px-0"
              onClick={speaking ? stopAdvisory : playAdvisory}
            >
              {speaking ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              {speaking ? t('result.pause') : t('result.play')}
            </Button>
          </div>

          {result.sourceClassification === 'indeterminate' && (
            <p className="text-sm text-slate-500">{t('result.indeterminate')}</p>
          )}
          {result.needsHumanReview && result.sourceClassification !== 'indeterminate' && (
            <p className="text-sm text-slate-500">{t('result.needsReview')}</p>
          )}
        </CardContent>
      </Card>

      <Button asChild size="lg" variant="outline">
        <Link to="/capture">{t('result.reportAnother')}</Link>
      </Button>
    </div>
  );
}
