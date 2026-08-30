import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ShieldCheck } from 'lucide-react';
import { Button, Card, CardContent, Input, Label, useToast } from '@vayusetu/ui-components';
import { useAuth } from '../../hooks/useAuth';

export function PhoneAuthScreen() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { sendOtp, confirmOtp, isMockMode, user } = useAuth();
  const { push } = useToast();

  const [step, setStep] = React.useState<'phone' | 'code'>('phone');
  const [phone, setPhone] = React.useState('');
  const [code, setCode] = React.useState('');
  const [displayName, setDisplayName] = React.useState(user?.displayName ?? '');
  const [isFieldWorker, setIsFieldWorker] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const fullPhone = phone.startsWith('+') ? phone : `+91${phone.replace(/\D/g, '')}`;

  async function handleSendCode() {
    setBusy(true);
    try {
      await sendOtp(fullPhone);
      setStep('code');
    } catch (error) {
      push({ tone: 'error', title: 'Could not send code', description: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function handleVerify() {
    setBusy(true);
    try {
      await confirmOtp(code, {
        role: isFieldWorker ? 'field_worker' : 'citizen',
        displayName: displayName || undefined,
      });
      push({ tone: 'success', title: t('auth.verified') });
      navigate('/capture');
    } catch (error) {
      push({ tone: 'error', title: 'Verification failed', description: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col items-center gap-2 pt-4 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-brand-50">
          <ShieldCheck className="h-6 w-6 text-brand-600" aria-hidden="true" />
        </div>
        <h1 className="text-xl font-bold text-ink">{t('auth.verifyTitle')}</h1>
        <p className="max-w-xs text-sm text-slate-500">{t('auth.verifySubtitle')}</p>
      </div>

      <Card>
        <CardContent className="flex flex-col gap-4 pt-5">
          {step === 'phone' ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="phone">{t('auth.phoneLabel')}</Label>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-slate-400">+91</span>
                  <Input
                    id="phone"
                    inputMode="numeric"
                    placeholder={t('auth.phonePlaceholder')}
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </div>
              </div>
              <Button size="lg" onClick={handleSendCode} loading={busy} disabled={phone.replace(/\D/g, '').length < 10}>
                {t('auth.sendCode')}
              </Button>
            </>
          ) : (
            <>
              <p className="text-sm text-slate-500">{t('auth.codeSentTo', { phone: fullPhone })}</p>
              {isMockMode && <p className="text-xs text-amber-700">{t('auth.mockHint', { code: '123456' })}</p>}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="code">{t('auth.codeLabel')}</Label>
                <Input
                  id="code"
                  inputMode="numeric"
                  maxLength={6}
                  className="tracking-[0.4em]"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="name">{t('auth.nameLabel')}</Label>
                <Input id="name" placeholder={t('auth.namePlaceholder')} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
              </div>

              <label className="flex items-center gap-2 text-sm text-slate-600">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300 text-brand-600 focus-visible:ring-2 focus-visible:ring-brand-500"
                  checked={isFieldWorker}
                  onChange={(e) => setIsFieldWorker(e.target.checked)}
                />
                {t('auth.fieldWorkerQuestion')}
              </label>

              <Button size="lg" onClick={handleVerify} loading={busy} disabled={code.length !== 6}>
                {t('auth.verifyAndContinue')}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
