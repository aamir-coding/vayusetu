import * as React from 'react';
import { ArrowLeft, ArrowRight, ShieldCheck, UserCog, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Aurora, Button, Card, CardContent, Input, Label, ThemeToggle, usePageTitle, useToast } from '@vayusetu/ui-components';
import { useAuth } from '../hooks/useAuth';
import { PORTAL_URL } from '../lib/links';

/** This state's citizen app: <project>-admin.web.app -> <project>.web.app. */
function citizenAppUrl(): string {
  const { hostname, protocol } = window.location;
  return hostname.includes('-admin.') ? `${protocol}//${hostname.replace('-admin.', '.')}` : PORTAL_URL;
}

export function LoginScreen() {
  const { t } = useTranslation();
  const { isMockMode, signInMock, signInReal } = useAuth();
  const { push } = useToast();
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  usePageTitle(t('login.signIn'), 'VayuSetu');

  async function handleRealSignIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await signInReal(email, password);
    } catch (error) {
      push({ tone: 'error', title: t('login.failed'), description: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative isolate flex min-h-dvh items-center justify-center overflow-hidden bg-night px-4 py-16">
      <Aurora className="absolute inset-0 -z-10 opacity-70" />
      <div className="absolute inset-x-0 top-0 flex items-center justify-between px-4 py-3" style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}>
        <a href={PORTAL_URL} className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-white/60 transition-colors hover:bg-white/10 hover:text-white">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> {t('nav.home')}
        </a>
        <ThemeToggle labels={{ toDark: t('theme.toDark'), toLight: t('theme.toLight') }} className="text-white/60 hover:bg-white/10 hover:text-white" />
      </div>
      <div className="w-full max-w-sm animate-in fade-in-0 slide-in-from-bottom-4 duration-500">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <a href={PORTAL_URL} title={t('nav.home')} className="rounded-xl transition-transform hover:scale-105">
            <img src="/vayusetu-icon.svg" alt={t('nav.home')} className="h-12 w-12 rounded-xl shadow-glow" />
          </a>
          <h1 className="text-lg font-bold text-white">{t('app.loginTitle')}</h1>
          <p className="text-sm text-white/50">{t('app.loginSubtitle')}</p>
        </div>

        <Card>
          <CardContent className="flex flex-col gap-4 pt-5">
            {isMockMode ? (
              <>
                <p className="text-center text-xs text-slate-500">{t('login.mockHint')}</p>
                <Button size="lg" variant="outline" className="justify-start" onClick={() => signInMock('district_admin')}>
                  <ShieldCheck className="h-5 w-5 text-brand-600" />
                  <span className="flex flex-col items-start">
                    <span>Officer Deshmukh</span>
                    <span className="text-xs font-normal text-slate-400">{t('role.district_admin')} · DL-CENTRAL</span>
                  </span>
                </Button>
                <Button size="lg" variant="outline" className="justify-start" onClick={() => signInMock('state_admin')}>
                  <Users className="h-5 w-5 text-brand-600" />
                  <span className="flex flex-col items-start">
                    <span>Ms. Iyer</span>
                    <span className="text-xs font-normal text-slate-400">{t('role.state_admin')} · Delhi</span>
                  </span>
                </Button>
              </>
            ) : (
              <form onSubmit={handleRealSignIn} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="email">{t('login.email')}</Label>
                  <Input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="password">{t('login.password')}</Label>
                  <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
                </div>
                <Button type="submit" size="lg" loading={busy}>
                  <UserCog className="h-4 w-4" /> {t('login.signIn')}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>

        <a
          href={citizenAppUrl()}
          className="group mt-5 flex items-center justify-center gap-1.5 text-sm text-white/55 transition-colors hover:text-white"
        >
          {t('login.citizenLink')}
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
        </a>
      </div>
    </div>
  );
}
