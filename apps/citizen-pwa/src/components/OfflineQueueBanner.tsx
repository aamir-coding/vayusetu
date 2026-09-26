import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { CloudOff, RefreshCw } from 'lucide-react';
import { useToast } from '@vayusetu/ui-components';
import { countQueuedSubmissions, listQueuedSubmissions, removeQueuedSubmission } from '../lib/offlineQueue';
import { uploadBlob } from '../lib/uploadClient';
import { isRetryable, submissionsApi } from '../lib/apiClient';
import { networkType } from '../lib/media';
import { useAuth } from '../hooks/useAuth';

export function OfflineQueueBanner() {
  const { t } = useTranslation();
  const { getToken, ensureRegistered } = useAuth();
  const { push } = useToast();
  const queryClient = useQueryClient();
  const [count, setCount] = React.useState(0);
  const [syncing, setSyncing] = React.useState(false);
  const flushingRef = React.useRef(false);

  const refreshCount = React.useCallback(() => {
    countQueuedSubmissions().then(setCount).catch(() => undefined);
  }, []);

  const flush = React.useCallback(async () => {
    if (flushingRef.current || !navigator.onLine) return;
    flushingRef.current = true;
    setSyncing(true);
    try {
      const queued = await listQueuedSubmissions();
      let sentAny = false;
      for (const item of queued) {
        try {
          await ensureRegistered();
          const token = await getToken();
          const photoStorageUrl = await uploadBlob(token, 'photo', item.photoBlob);
          const audioStorageUrl = item.audioBlob ? await uploadBlob(token, 'audio', item.audioBlob) : undefined;
          await submissionsApi.create(token, {
            mediaType: audioStorageUrl ? 'photo_audio' : 'photo',
            photoStorageUrl,
            audioStorageUrl,
            geo: item.geo,
            capturedAt: item.capturedAt,
            deviceMeta: { platform: 'web', appVersion: __APP_VERSION__, networkType: networkType() },
            fieldSensorReading: item.fieldSensorReading,
          });
          await removeQueuedSubmission(item.localId);
          sentAny = true;
        } catch (error) {
          if (isRetryable(error)) {
            console.warn('Queued submission failed to send, will retry later', error);
            break; // offline again or server trouble -- try the rest next time
          }
          // Permanently rejected: drop it so it can't block every report queued after it.
          await removeQueuedSubmission(item.localId);
          push({ tone: 'error', title: t('offline.rejected', { reason: (error as Error).message }) });
        }
      }
      if (sentAny) {
        queryClient.invalidateQueries({ queryKey: ['submissions'] });
        push({ tone: 'success', title: t('offline.synced') });
      }
    } finally {
      setSyncing(false);
      flushingRef.current = false;
      refreshCount();
    }
  }, [ensureRegistered, getToken, push, queryClient, refreshCount, t]);

  React.useEffect(() => {
    refreshCount();
    const onOnline = () => flush();
    window.addEventListener('online', onOnline);
    const interval = window.setInterval(refreshCount, 4000);
    if (navigator.onLine) flush();
    return () => {
      window.removeEventListener('online', onOnline);
      window.clearInterval(interval);
    };
  }, [flush, refreshCount]);

  if (count === 0) return null;

  return (
    <div className="flex items-center gap-2.5 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
      {syncing ? (
        <RefreshCw className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
      ) : (
        <CloudOff className="h-4 w-4 shrink-0" aria-hidden="true" />
      )}
      <span className="flex-1">{t('offline.banner', { count })}</span>
      {!navigator.onLine && <span className="text-xs opacity-75">{t('offline.willSyncWhenOnline')}</span>}
    </div>
  );
}
