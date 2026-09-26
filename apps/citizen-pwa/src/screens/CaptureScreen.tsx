import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Camera,
  Image as ImageIcon,
  Mic,
  MapPin,
  RotateCcw,
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

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-bold text-ink">{t('capture.title')}</h1>
        <p className="mt-1 text-sm text-slate-500">{t('capture.subtitle')}</p>
      </div>

      {isFieldWorker && (
        <StatusPill className="w-fit bg-brand-50 text-brand-700">
          {t('capture.reportingAs')}: {t('capture.roleFieldWorker')}
        </StatusPill>
      )}

      {/* ---------------- Photo ---------------- */}
      <Card className="overflow-hidden">
        <div className="relative aspect-[4/3] w-full bg-ink">
          {photoUrl ? (
            <img src={photoUrl} alt="" className="h-full w-full object-cover" />
          ) : cameraActive ? (
            <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-4 p-6 text-center">
              <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-brand-500/20 shadow-glow animate-breathe">
                <Camera className="h-8 w-8 text-brand-200" aria-hidden="true" />
              </div>
              {cameraUnavailable && <p className="text-sm text-white/70">{t('capture.cameraUnavailable')}</p>}
            </div>
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
              <Button variant="outline" size="lg" onClick={() => fileInputRef.current?.click()} aria-label={t('capture.choosePhoto')}>
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
      <Card>
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
              <Square className="h-4 w-4" /> {t('capture.voiceRecording')} ({MAX_VOICE_SECONDS - recordSeconds}s)
            </Button>
          ) : (
            <Button variant="outline" className="w-full" onClick={startRecording}>
              <Mic className="h-4 w-4" /> {t('capture.voiceNote')}
            </Button>
          )}
        </CardContent>
      </Card>

      {/* ---------------- Location ---------------- */}
      <Card>
        <CardContent className="flex flex-col gap-3 pt-5">
          <div className="flex items-center gap-2 text-sm">
            <MapPin className="h-4 w-4 shrink-0 text-brand-600" aria-hidden="true" />
            {geoState === 'locating' && <span className="text-slate-500">{t('capture.locating')}</span>}
            {geoState === 'found' && geo && (
              <span className="text-slate-700">
                {t('capture.locationFound')} · {geo.lat.toFixed(4)}, {geo.lng.toFixed(4)}
              </span>
            )}
            {geoState === 'denied' && <span className="text-red-600">{t('capture.locationDenied')}</span>}
            {geoState === 'manual' && <span className="text-slate-500">{t('capture.enterLocationManually')}</span>}
            {geoState !== 'manual' && (
              <button type="button" onClick={() => setGeoState('manual')} className="ml-auto text-xs font-medium text-brand-700 underline-offset-2 hover:underline">
                {t('common.change')}
              </button>
            )}
          </div>
          {geoState === 'manual' && (
            <div className="grid grid-cols-2 gap-2">
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

      <Button size="lg" onClick={handleSubmit} loading={submitting} disabled={cameraActive}>
        {submitting ? t('capture.submitting') : t('capture.submit')}
      </Button>
    </div>
  );
}
