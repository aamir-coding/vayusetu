import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Camera, MessageCircleQuestion, Send, X } from 'lucide-react';
import { Button, Card, CardContent, useToast } from '@vayusetu/ui-components';
import type { AnalysisResult } from '@vayusetu/shared-types';
import { useAuth } from '../hooks/useAuth';
import { submissionsApi } from '../lib/apiClient';
import { uploadBlob } from '../lib/uploadClient';
import { compressPhoto } from '../lib/media';

/**
 * Pipeline D (AI_PIPELINES.md): when Gemini can't tell the source from the
 * photo, it asks the citizen ONE short question, in their language, at most
 * twice per report. The answer (text and/or one more photo) goes to
 * POST /submissions/:id/clarify, which re-queues analysis -- the result
 * screen's polling picks the new assessment up.
 */
export function ClarifyCard({
  submissionId,
  pending,
}: {
  submissionId: string;
  pending: NonNullable<AnalysisResult['pendingClarification']>;
}) {
  const { t } = useTranslation();
  const { getToken } = useAuth();
  const { push } = useToast();
  const queryClient = useQueryClient();
  const [answer, setAnswer] = React.useState('');
  const [photo, setPhoto] = React.useState<Blob | null>(null);
  const [sending, setSending] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const photoUrl = React.useMemo(() => (photo ? URL.createObjectURL(photo) : null), [photo]);
  React.useEffect(() => () => void (photoUrl && URL.revokeObjectURL(photoUrl)), [photoUrl]);

  async function send() {
    if (!answer.trim() && !photo) return;
    setSending(true);
    try {
      const token = await getToken();
      const answerPhotoStorageUrl = photo ? await uploadBlob(token, 'photo', photo) : undefined;
      await submissionsApi.clarify(token, submissionId, {
        ...(answer.trim() ? { answerText: answer.trim() } : {}),
        ...(answerPhotoStorageUrl ? { answerPhotoStorageUrl } : {}),
      });
      push({ tone: 'success', title: t('result.clarifySent') });
      await queryClient.invalidateQueries({ queryKey: ['analysis', submissionId] });
    } catch (error) {
      push({ tone: 'error', title: t('result.clarifyFailed'), description: (error as Error).message });
    } finally {
      setSending(false);
    }
  }

  return (
    <Card className="border-accent-200 bg-accent-50/40">
      <CardContent className="flex flex-col gap-3 pt-5">
        <p className="flex items-center gap-2 text-sm font-semibold text-ink">
          <MessageCircleQuestion className="h-4 w-4 text-accent-600" aria-hidden="true" />
          {t('result.clarifyTitle')}
          <span className="ml-auto text-xs font-normal text-slate-400">{pending.turn}/2</span>
        </p>
        <p lang={pending.language} className="text-base leading-relaxed text-ink">
          {pending.question}
        </p>
        <textarea
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          maxLength={500}
          rows={3}
          placeholder={t('result.clarifyPlaceholder')}
          aria-label={t('result.clarifyPlaceholder')}
          className="w-full resize-none rounded-lg border border-slate-200 bg-surface p-3 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
        />
        <p className="text-xs text-slate-500">{t('result.clarifyHint')}</p>
        {photoUrl ? (
          <div className="relative w-24">
            <img src={photoUrl} alt="" className="h-24 w-24 rounded-lg object-cover" />
            <button
              type="button"
              onClick={() => setPhoto(null)}
              aria-label={t('common.remove')}
              className="absolute -right-2 -top-2 rounded-full bg-surface p-1 shadow"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => fileRef.current?.click()}>
            <Camera className="h-4 w-4" /> {t('result.clarifyAddPhoto')}
          </Button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (file) setPhoto(await compressPhoto(file));
            e.target.value = '';
          }}
        />
        <Button onClick={send} loading={sending} disabled={!answer.trim() && !photo}>
          <Send className="h-4 w-4" /> {t('result.clarifySend')}
        </Button>
      </CardContent>
    </Card>
  );
}
