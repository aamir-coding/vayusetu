import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Camera,
  Check,
  Image as ImageIcon,
  Mic,
  MapPin,
  RotateCcw,
  Send,
  Square,
  Trash2,
} from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  Input,
  Label,
  StatusPill,
  cn,
  usePageTitle,
  useToast,
} from '@vayusetu/ui-components';
import type { GeoPoint } from '@vayusetu/shared-types';
import { useAuth } from '../hooks/useAuth';
import { getCurrentGeo } from '../lib/geolocation';
import { uploadBlob } from '../lib/uploadClient';
import { submissionsApi, isRetryable } from '../lib/apiClient';
import { compressPhoto, networkType, pickAudioMimeType } from '../lib/media';
import { enqueueSubmission } from '../lib/offlineQueue';

const MAX_VOICE_SECONDS = 10;

export function CaptureScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { getToken, ensureRegistered, user } = useAuth();
  const { push } = useToast();

  // ---- photo ----
  const [photoBlob, setPhotoBlob] = React.useState<Blob | null>(null);
  const [photoUrl, setPhotoUrl] = React.useState<string | null>(null);
  const [cameraActive, setCameraActive] = React.useState(false);
  const [cameraUnavailable, setCameraUnavailable] = React.useState(false);
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // ---- voice note ----
  const [audioBlob, setAudioBlob] = React.useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = React.useState<string | null>(null);
  const [recording, setRecording] = React.useState(false);
  const [recordSeconds, setRecordSeconds] = React.useState(0);
  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const recordTimerRef = React.useRef<number | null>(null);
  const audioChunksRef = React.useRef<Blob[]>([]);

  // ---- location ----
  const [geo, setGeo] = React.useState<GeoPoint | null>(null);
  const [geoState, setGeoState] = React.useState<'locating' | 'found' | 'denied' | 'manual'>('locating');
  const [manualLat, setManualLat] = React.useState('');
  const [manualLng, setManualLng] = React.useState('');

  // ---- field worker sensor reading ----
  const [pm25, setPm25] = React.useState('');
  const [pm10, setPm10] = React.useState('');

  const [submitting, setSubmitting] = React.useState(false);

  const isFieldWorker = user?.role === 'field_worker';
  usePageTitle(t('capture.title'), t('app.name'));

  React.useEffect(() => {
    getCurrentGeo().then((result) => {
      if (result.status === 'success') {
        setGeo(result.geo);
        setGeoState('found');
      } else {
        setGeoState('denied');
      }
    });
  }, []);

  React.useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (photoUrl) URL.revokeObjectURL(photoUrl);
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      streamRef.current = stream;
      setCameraActive(true);
      setCameraUnavailable(false);
      // video element mounts on next render — attach once it exists
      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => undefined);
        }
      });
    } catch {
      setCameraUnavailable(true);
    }
  }

  function stopCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraActive(false);
  }

  function acceptPhoto(blob: Blob) {
    navigator.vibrate?.(30); // a tiny "got it" on phones that support it
    setPhotoBlob(blob);
    setPhotoUrl(URL.createObjectURL(blob));
  }

  async function capturePhoto() {
    const video = videoRef.current;
    if (!video) return;
    try {
      acceptPhoto(await compressPhoto(video));
      stopCamera();
    } catch (error) {
      push({ tone: 'error', title: (error as Error).message });
    }
  }

  async function handleFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      acceptPhoto(await compressPhoto(file));
    } catch (error) {
      push({ tone: 'error', title: (error as Error).message });
    }
  }

  function retakePhoto() {
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    setPhotoBlob(null);
    setPhotoUrl(null);
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickAudioMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || mimeType || 'audio/webm' });
        setAudioBlob(blob);
        setAudioUrl(URL.createObjectURL(blob));
      };
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
      setRecordSeconds(0);
      recordTimerRef.current = window.setInterval(() => {
        setRecordSeconds((s) => {
          if (s + 1 >= MAX_VOICE_SECONDS) {
            stopRecording();
            return MAX_VOICE_SECONDS;
          }
          return s + 1;
        });
      }, 1000);
    } catch {
      push({ tone: 'error', title: 'Microphone unavailable' });
    }
  }

  function stopRecording() {
    recorderRef.current?.stop();
    setRecording(false);
    if (recordTimerRef.current) window.clearInterval(recordTimerRef.current);
  }

  function removeVoiceNote() {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioBlob(null);
    setAudioUrl(null);
  }

  function resolvedGeo(): GeoPoint | null {
    if (geoState === 'manual') {
      const lat = Number(manualLat);
      const lng = Number(manualLng);
      if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
      return null;
    }
    return geo;
  }

  async function handleSubmit() {
    const finalGeo = resolvedGeo();
    if (!photoBlob) {
      push({ tone: 'error', title: t('capture.missingPhoto') });
      return;
    }
    if (!finalGeo) {
      push({ tone: 'error', title: t('capture.missingLocation') });
      return;
    }

    const fieldSensorReading =
      isFieldWorker && (pm25 || pm10)
        ? { pm25: pm25 ? Number(pm25) : undefined, pm10: pm10 ? Number(pm10) : undefined }
        : undefined;

    setSubmitting(true);
    try {
      if (!navigator.onLine) throw new TypeError('offline');

      await ensureRegistered();
      const token = await getToken();
      const photoStorageUrl = await uploadBlob(token, 'photo', photoBlob);
      const audioStorageUrl = audioBlob ? await uploadBlob(token, 'audio', audioBlob) : undefined;

      const { submission } = await submissionsApi.create(token, {
        mediaType: audioStorageUrl ? 'photo_audio' : 'photo',
        photoStorageUrl,
        audioStorageUrl,
        geo: finalGeo,
        capturedAt: new Date().toISOString(),
        deviceMeta: { platform: 'web', appVersion: __APP_VERSION__, networkType: networkType() },
        fieldSensorReading,
      });
      navigator.vibrate?.([20, 40, 20]);
      navigate(`/result/${submission.id}`);
    } catch (error) {
      if (!isRetryable(error)) {
        // Will fail the same way on every retry (validation, permissions):
        // tell the user now rather than parking it in the offline queue forever.
        push({ tone: 'error', title: t('capture.sendFailed'), description: (error as Error).message });
      } else {
        // Offline, network failure or a transient server error -- queue it locally instead of losing the report.
        await enqueueSubmission({
          mediaType: audioBlob ? 'photo_audio' : 'photo',
          photoBlob,
          audioBlob: audioBlob ?? undefined,
          geo: finalGeo,
          capturedAt: new Date().toISOString(),
          fieldSensorReading,
        });
        push({ tone: 'info', title: t('capture.queuedOffline') });
        resetForm();
      }
    } finally {
      setSubmitting(false);
    }
  }

  function resetForm() {
    retakePhoto();
    removeVoiceNote();
    setPm25('');
    setPm10('');
  }

  const placeReady = geoState === 'manual' ? Boolean(resolvedGeo()) : geoState === 'found';
  const steps = [
    { done: Boolean(photoBlob), label: t('capture.stepPhoto') },
    { done: placeReady, label: t('capture.stepPlace') },
    { done: false, label: t('capture.stepSend') },
  ];
  const hint = !photoBlob ? t('capture.needPhoto') : !placeReady ? t('capture.needPlace') : t('capture.readyToSend');

  return (
    <div className="flex flex-col gap-4 pb-28">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand-600">{t('capture.eyebrow')}</p>
        <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-ink">{t('capture.title')}</h1>
        <p className="mt-1 text-sm text-slate-500">{t('capture.subtitle')}</p>
        {/* Where you are in the report: a glance says what's still missing. */}
        <div className="mt-4 flex items-center gap-2" aria-hidden="true">
          {steps.map((step, i) => (
            <React.Fragment key={step.label}>
              <div className="flex items-center gap-1.5">
                <span
                  className={cn(
                    'flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold transition-all duration-300',
                    step.done ? 'scale-105 bg-brand-500 text-white' : 'bg-slate-200 text-slate-500',
                  )}
                >
                  {step.done ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : i + 1}
                </span>
                <span className={cn('text-xs font-medium transition-colors', step.done ? 'text-brand-700' : 'text-slate-500')}>{step.label}</span>
              </div>
              {i < steps.length - 1 && (
                <span className="h-0.5 flex-1 overflow-hidden rounded-full bg-slate-200">
                  <span className={cn('block h-full origin-left bg-brand-500 transition-transform duration-500', step.done ? 'scale-x-100' : 'scale-x-0')} />
                </span>
              )}
            </React.Fragment>
          ))}
        </div>
      </header>

      {isFieldWorker && (
        <StatusPill className="w-fit bg-brand-50 text-brand-700">
          {t('capture.reportingAs')}: {t('capture.roleFieldWorker')}
        </StatusPill>
      )}

      {/* ---------------- Photo ---------------- */}
      <Card className="overflow-hidden shadow-card" data-tour="photo">
        <div className="relative aspect-[4/3] w-full overflow-hidden bg-night">
          {photoUrl ? (
            <>
              <img src={photoUrl} alt="" className="h-full w-full object-cover animate-in fade-in-0 zoom-in-105 duration-500" />
              <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/50 to-transparent" />
              <span className="absolute left-3 top-3 inline-flex items-center gap-1 rounded-full bg-brand-600/90 px-2.5 py-1 text-xs font-semibold text-white shadow animate-in zoom-in-50 duration-300">
                <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden="true" /> {t('capture.photoReady')}
              </span>
            </>
          ) : cameraActive ? (
            <>
              <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
              <Viewfinder scanning />
            </>
          ) : (
            <button type="button" onClick={startCamera} className="group relative flex h-full w-full flex-col items-center justify-center gap-4 p-6 text-center">
              <Viewfinder />
              <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-brand-500/20 shadow-glow animate-breathe transition-transform group-hover:scale-105 group-active:scale-95">
                <Camera className="h-8 w-8 text-brand-200" aria-hidden="true" />
              </div>
              <p className="text-sm font-medium text-white/75">{cameraUnavailable ? t('capture.cameraUnavailable') : t('capture.tapToOpen')}</p>
            </button>
          )}
        </div>

        <CardContent className="flex flex-wrap gap-2 pt-4">
          {photoUrl ? (
            <Button variant="outline" size="sm" onClick={retakePhoto}>
              <RotateCcw className="h-4 w-4" /> {t('capture.retakePhoto')}
            </Button>
          ) : cameraActive ? (
            <Button variant="accent" size="lg" className="w-full" onClick={capturePhoto}>
              <Camera className="h-5 w-5" /> {t('capture.takePhoto')}
            </Button>
          ) : (
            <>
              <Button variant="accent" size="lg" className="flex-1" onClick={startCamera}>
                <Camera className="h-5 w-5" /> {t('capture.takePhoto')}
              </Button>
              <Button variant="outline" size="lg" onClick={() => fileInputRef.current?.click()} aria-label={t('capture.choosePhoto')} title={t('capture.choosePhoto')}>
                <ImageIcon className="h-5 w-5" />
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={handleFileChosen}
              />
            </>
          )}
        </CardContent>
      </Card>

      {/* ---------------- Voice note ---------------- */}
      <Card data-tour="voice">
        <CardContent className="flex items-center gap-3 pt-5">
          {audioUrl ? (
            <>
              <audio src={audioUrl} controls className="h-10 flex-1" />
              <Button variant="ghost" size="icon" onClick={removeVoiceNote} aria-label={t('capture.removeVoice')}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </>
          ) : recording ? (
            <Button variant="destructive" className="w-full" onClick={stopRecording}>
              <span className="flex h-4 items-end gap-0.5" aria-hidden="true">
                {[0, 1, 2, 3].map((i) => (
                  <span key={i} className="h-full w-0.5 origin-bottom rounded-full bg-white animate-level" style={{ animationDelay: `${i * 0.15}s` }} />
                ))}
              </span>
              <Square className="h-4 w-4" /> {t('capture.voiceRecording')} ({MAX_VOICE_SECONDS - recordSeconds}s)
            </Button>
          ) : (
            <Button variant="outline" className="h-auto w-full justify-start gap-3 py-3" onClick={startRecording}>
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700">
                <Mic className="h-4 w-4" />
              </span>
              <span className="flex flex-col items-start text-left">
                <span>{t('capture.voiceNote')}</span>
                <span className="text-xs font-normal text-slate-500">{t('capture.voiceHint')}</span>
              </span>
            </Button>
          )}
        </CardContent>
      </Card>

      {/* ---------------- Location ---------------- */}
      <Card data-tour="location">
        <CardContent className="flex flex-col gap-3 pt-5">
          <div className="flex items-center gap-2.5 text-sm">
            <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-600">
              {geoState === 'locating' && <span className="absolute inset-0 rounded-full bg-brand-400/40 motion-safe:animate-ping" />}
              {geoState === 'found' ? <Check className="h-4 w-4" strokeWidth={3} aria-hidden="true" /> : <MapPin className="h-4 w-4" aria-hidden="true" />}
            </span>
            <span className="min-w-0 flex-1">
              {geoState === 'locating' && <span className="text-slate-500">{t('capture.locating')}</span>}
              {geoState === 'found' && geo && (
                <span className="text-slate-700">
                  {t('capture.locationFound')} · <span className="font-mono text-xs">{geo.lat.toFixed(4)}, {geo.lng.toFixed(4)}</span>
                </span>
              )}
              {geoState === 'denied' && <span className="text-red-600">{t('capture.locationDenied')}</span>}
              {geoState === 'manual' && <span className="text-slate-500">{t('capture.enterLocationManually')}</span>}
            </span>
            {geoState !== 'manual' && (
              <button type="button" onClick={() => setGeoState('manual')} className="rounded-md px-2 py-1 text-xs font-semibold text-brand-700 underline-offset-2 hover:bg-brand-50 hover:underline">
                {t('common.change')}
              </button>
            )}
          </div>
          {geoState === 'manual' && (
            <div className="grid grid-cols-2 gap-2 animate-in fade-in-0 slide-in-from-top-1">
              <Input
                inputMode="decimal"
                placeholder={t('capture.latitude')}
                value={manualLat}
                onChange={(e) => setManualLat(e.target.value)}
              />
              <Input
                inputMode="decimal"
                placeholder={t('capture.longitude')}
                value={manualLng}
                onChange={(e) => setManualLng(e.target.value)}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---------------- Field worker sensor reading ---------------- */}
      {isFieldWorker && (
        <Card>
          <CardContent className="flex flex-col gap-3 pt-5">
            <Label>{t('capture.sensorReadingTitle')}</Label>
            <div className="grid grid-cols-2 gap-2">
              <Input inputMode="decimal" placeholder={t('capture.pm25')} value={pm25} onChange={(e) => setPm25(e.target.value)} />
              <Input inputMode="decimal" placeholder={t('capture.pm10')} value={pm10} onChange={(e) => setPm10(e.target.value)} />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Send stays one thumb away, just above the tabs, and says what's missing. */}
      <div className="fixed inset-x-0 z-10 mx-auto w-full max-w-md px-3" style={{ bottom: 'calc(4.4rem + env(safe-area-inset-bottom))' }}>
        <div className="rounded-2xl border border-slate-200/70 bg-surface/85 p-2 shadow-card backdrop-blur-md">
          <p className={cn('px-2 pb-1.5 text-center text-xs transition-colors', photoBlob && placeReady ? 'font-medium text-brand-700' : 'text-slate-500')} aria-live="polite">
            {hint}
          </p>
          <Button size="lg" className="w-full" data-tour="send" onClick={handleSubmit} loading={submitting} disabled={cameraActive}>
            {submitting ? t('capture.submitting') : t('capture.submit')}
            {!submitting && <Send className="h-4 w-4" aria-hidden="true" />}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Camera-style corner brackets; a slow scan line while the camera is live. */
function Viewfinder({ scanning = false }: { scanning?: boolean }) {
  const corner = 'absolute h-7 w-7 border-white/70';
  return (
    <div className="pointer-events-none absolute inset-4" aria-hidden="true">
      <span className={cn(corner, 'left-0 top-0 rounded-tl-lg border-l-2 border-t-2')} />
      <span className={cn(corner, 'right-0 top-0 rounded-tr-lg border-r-2 border-t-2')} />
      <span className={cn(corner, 'bottom-0 left-0 rounded-bl-lg border-b-2 border-l-2')} />
      <span className={cn(corner, 'bottom-0 right-0 rounded-br-lg border-b-2 border-r-2')} />
      {scanning && (
        <span className="absolute inset-x-2 top-0 h-full motion-safe:animate-scan">
          <span className="block h-0.5 bg-gradient-to-r from-transparent via-brand-300 to-transparent shadow-[0_0_12px_2px_rgba(116,207,198,0.6)]" />
        </span>
      )}
    </div>
  );
}
