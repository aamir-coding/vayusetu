import * as React from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, Camera, Check, Eye, Gauge, Pause, Play, Satellite, Share2, Wind } from 'lucide-react';
import {
  AqiBadge,
  Button,
  Card,
  CardContent,
  Skeleton,
  Spinner,
  cn,
  severityWord,
  usePageTitle,
  useToast,
} from '@vayusetu/ui-components';
import { useAuth } from '../hooks/useAuth';
import { analysisApi, submissionsApi } from '../lib/apiClient';
import { ClarifyCard } from '../components/ClarifyCard';
import { BackLink } from '../components/BackLink';
import { PORTAL_URL } from '../lib/links';

const IN_FLIGHT = new Set(['queued', 'uploading', 'pending_analysis']);

export function SnapshotResult() {
  const { submissionId = '' } = useParams();
  const { t } = useTranslation();
  const { getToken } = useAuth();
  const { push: toast } = useToast();
  usePageTitle(t('result.title'), t('app.name'));
  const [speaking, setSpeaking] = React.useState(false);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  React.useEffect(() => () => audioRef.current?.pause(), []);

  const { data, isLoading } = useQuery({
    queryKey: ['analysis', submissionId],
    queryFn: async () => analysisApi.get(await getToken(), submissionId),
    enabled: Boolean(submissionId),
    // Keep polling until analysis is done. A fresh report is `queued` until
    // analysis-service picks it up (a Cloud Run cold start is ~10 s); polling
    // only on `pending_analysis` stopped at the first `queued` read and the
    // screen spun forever (27 Sep rehearsal).
    refetchInterval: (query) => (IN_FLIGHT.has(query.state.data?.status ?? 'queued') ? 1500 : false),
  });

  const status = data?.status;
  const result = data?.result;

  // The report itself (once): the field worker's own sensor reading.
  const { data: detail } = useQuery({
    queryKey: ['submission', submissionId],
    queryFn: async () => submissionsApi.get(await getToken(), submissionId),
    enabled: Boolean(submissionId && result),
    staleTime: Infinity,
  });
  const sensor = detail?.submission.fieldSensorReading;

  function playAdvisory() {
    if (!result) return;
    if (result.advisory.audioStorageUrl) {
      // Cloud TTS (Chirp 3 HD) render in the citizen's language; the API
      // hands out a short-lived signed URL. Browser speech is the fallback.
      const audio = audioRef.current ?? new Audio();
      audioRef.current = audio;
      audio.src = result.advisory.audioStorageUrl;
      audio.onended = () => setSpeaking(false);
      audio.onerror = () => setSpeaking(false);
      audio.play().then(
        () => setSpeaking(true),
        () => setSpeaking(false),
      );
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
    audioRef.current?.pause();
    window.speechSynthesis?.cancel();
    setSpeaking(false);
  }

  if (isLoading || status === 'queued' || status === 'uploading' || status === 'pending_analysis') {
    return (
      <div className="flex flex-col items-center gap-5 py-14 text-center">
        <div className="relative flex h-24 w-24 items-center justify-center">
          <span className="absolute inset-0 rounded-full bg-brand-400/20 motion-safe:animate-ping" />
          <span className="absolute inset-2 rounded-full bg-brand-500/15 shadow-glow animate-breathe" />
          <Wind className="relative h-9 w-9 text-brand-600" aria-hidden="true" />
        </div>
        <div>
          <p className="text-lg font-bold text-ink">{t('result.analyzing')}</p>
          <p className="mt-1 text-sm text-slate-500">{t('result.analyzingHint')}</p>
        </div>
        <div className="w-full max-w-sm space-y-2">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-12 w-4/5" />
        </div>
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

  const xv = result.crossValidation ?? {};
  const pending = status === 'flagged_for_review' ? result.pendingClarification : undefined;
  const band = BAND[result.estimatedAQICategory ?? ''] ?? 'from-brand-500 to-brand-600';
  const source = t(`pollutionSource.${result.sourceClassification}`);
  const reviewed = status === 'flagged_for_review' || result.needsHumanReview;

  async function share() {
    const text = t('result.shareText', { source: source.toLowerCase() });
    try {
      if (navigator.share) {
        await navigator.share({ title: 'VayuSetu', text, url: PORTAL_URL });
      } else {
        await navigator.clipboard.writeText(`${text} ${PORTAL_URL}`);
        toast({ tone: 'success', title: t('result.shareCopied') });
      }
    } catch {
      /* the user closed the share sheet */
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <BackLink fallback="/reports" label={t('common.back')} />
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">{t('result.title')}</h1>
      </div>

      {pending && <ClarifyCard submissionId={submissionId} pending={pending} />}

      <Card className="overflow-hidden shadow-card animate-in fade-in-0 slide-in-from-bottom-3 duration-500">
        {/* A band in the colour of what was found: readable at a glance. */}
        <div className={cn('relative bg-gradient-to-br px-5 pb-5 pt-4 text-white', band)}>
          <div className="absolute inset-0 opacity-20 [background:radial-gradient(circle_at_85%_20%,white,transparent_45%)]" aria-hidden="true" />
          <p className="relative text-xs font-semibold uppercase tracking-[0.14em] text-white/80">{t('result.found')}</p>
          <div className="relative mt-1 flex items-start justify-between gap-3">
            <p className="text-xl font-extrabold leading-tight">{source}</p>
            {result.estimatedAQICategory && <AqiBadge category={result.estimatedAQICategory} className="shrink-0 ring-2 ring-white/60" />}
          </div>
        </div>

        <CardContent className="flex flex-col gap-4 pt-4">
          <div>
            <div className="flex gap-1">
              {[1, 2, 3, 4, 5].map((n) => (
                <span key={n} className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                  {n <= result.severityEstimate && (
                    <span className="block h-full origin-left rounded-full bg-accent-500 animate-grow" style={{ animationDelay: `${120 + n * 90}ms` }} />
                  )}
                </span>
              ))}
            </div>
            <div className="mt-1.5 flex items-center justify-between text-xs text-slate-500">
              <span>{severityWord(result.severityEstimate)}</span>
              {result.visibilityMeters !== undefined && (
                <span className="flex items-center gap-1">
                  <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                  {t('result.visibility', { meters: result.visibilityMeters })}
                </span>
              )}
            </div>
          </div>

          <div className="flex gap-3 rounded-xl bg-brand-50/80 p-4">
            <button
              type="button"
              onClick={speaking ? stopAdvisory : playAdvisory}
              aria-label={speaking ? t('result.pause') : t('result.play')}
              className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-600 text-white shadow-md transition-transform hover:scale-105 active:scale-95 dark:hover:bg-brand-500"
            >
              {speaking && <span className="absolute inset-0 rounded-full bg-brand-500/50 motion-safe:animate-ping" />}
              {speaking ? <Pause className="relative h-5 w-5" /> : <Play className="relative ml-0.5 h-5 w-5" />}
            </button>
            <div className="min-w-0">
              <p className="text-sm leading-relaxed text-ink">{result.advisory.text}</p>
              <p className="mt-1 text-xs font-medium text-brand-700">{speaking ? t('result.pause') : t('result.play')}</p>
            </div>
          </div>

          {result.sourceClassification === 'indeterminate' && !pending && (
            <p className="text-sm text-slate-500">{t('result.indeterminate')}</p>
          )}
          {result.needsHumanReview && result.sourceClassification !== 'indeterminate' && (
            <p className="text-sm text-slate-500">{t('result.needsReview')}</p>
          )}
        </CardContent>
      </Card>

      {/* What happens next: so a report never feels like it vanished. */}
      <Card className="animate-in fade-in-0 slide-in-from-bottom-3 duration-500 [animation-delay:120ms] [animation-fill-mode:both]">
        <CardContent className="pt-5">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-400">{t('result.nextTitle')}</p>
          <div className="flex flex-col">
            {[
              { done: true, text: t('result.stepReceived') },
              { done: true, text: t('result.stepAnalysed') },
              { done: true, text: reviewed ? t('result.stepReview') : t('result.stepOfficials') },
              { done: false, text: t('result.stepFollow') },
            ].map((step, i, all) => (
              <div key={i} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <span className={cn('flex h-5 w-5 items-center justify-center rounded-full', step.done ? 'bg-brand-500 text-white' : 'border-2 border-slate-300 bg-surface')}>
                    {step.done && <Check className="h-3 w-3" strokeWidth={3} aria-hidden="true" />}
                  </span>
                  {i < all.length - 1 && <span className="my-0.5 w-0.5 flex-1 bg-slate-200" />}
                </div>
                <p className={cn('pb-3 text-sm', step.done ? 'text-slate-700' : 'text-slate-500')}>{step.text}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {(xv.nearestMonitorAQI !== undefined || xv.satelliteAODAtCell !== undefined || sensor) && (
        <Card>
          <CardContent className="flex flex-col gap-2 pt-5 text-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t('result.sensorsTitle')}</p>
            {xv.nearestMonitorAQI !== undefined && (
              <p className="flex items-center gap-2 text-slate-600">
                <Gauge className="h-4 w-4 text-slate-400" aria-hidden="true" />
                {t('result.nearestMonitor', { aqi: Math.round(xv.nearestMonitorAQI) })}
              </p>
            )}
            {xv.satelliteAODAtCell !== undefined && (
              <p className="flex items-center gap-2 text-slate-600">
                <Satellite className="h-4 w-4 text-slate-400" aria-hidden="true" />
                {t('result.satelliteAod', { aod: xv.satelliteAODAtCell.toFixed(2) })}
              </p>
            )}
            {sensor?.pm25 !== undefined && <p className="text-slate-600">{t('result.yourSensorPm25', { value: sensor.pm25 })}</p>}
            {sensor?.pm10 !== undefined && <p className="text-slate-600">{t('result.yourSensorPm10', { value: sensor.pm10 })}</p>}
            {xv.agreementScore !== undefined && (
              <p className="text-xs text-slate-400">{t('result.agreement', { pct: Math.round(xv.agreementScore * 100) })}</p>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Button asChild size="lg">
          <Link to="/capture">
            <Camera className="h-4 w-4" aria-hidden="true" /> {t('result.reportAnother')}
          </Link>
        </Button>
        <Button size="lg" variant="outline" onClick={() => void share()}>
          <Share2 className="h-4 w-4" aria-hidden="true" /> {t('result.shareCta')}
        </Button>
      </div>
      <Link to="/reports" className="-mt-1 text-center text-sm font-medium text-slate-500 underline-offset-4 hover:text-brand-700 hover:underline">
        {t('nav.reports')} →
      </Link>
    </div>
  );
}

/** Header band colour for the estimated AQI category (the CPCB palette). */
const BAND: Record<string, string> = {
  good: 'from-aqi-good to-emerald-700',
  satisfactory: 'from-aqi-satisfactory to-aqi-good',
  moderate: 'from-amber-500 to-aqi-poor',
  poor: 'from-aqi-poor to-orange-700',
  very_poor: 'from-aqi-veryPoor to-red-800',
  severe: 'from-aqi-severe to-[#3d0011]',
};
