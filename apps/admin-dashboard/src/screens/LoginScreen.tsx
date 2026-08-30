import * as React from 'react';
import { ShieldCheck, UserCog, Users } from 'lucide-react';
import { Button, Card, CardContent, Input, Label, useToast } from '@vayusetu/ui-components';
import { useAuth } from '../hooks/useAuth';

export function LoginScreen() {
  const { isMockMode, signInMock, signInReal } = useAuth();
  const { push } = useToast();
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  async function handleRealSignIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await signInReal(email, password);
    } catch (error) {
      push({ tone: 'error', title: 'Sign-in failed', description: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-ink px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <img src="/vayusetu-icon.svg" alt="" className="h-12 w-12 rounded-xl" />
          <h1 className="text-lg font-bold text-white">VayuSetu Admin Console</h1>
          <p className="text-sm text-white/50">Jurisdiction-filtered alerts, hotspots, and forecasts.</p>
        </div>

        <Card>
          <CardContent className="flex flex-col gap-4 pt-5">
            {isMockMode ? (
              <>
                <p className="text-center text-xs text-slate-500">
                  Mock mode — accounts are normally provisioned out-of-band by a super_admin. Choose a persona to explore the console.
                </p>
                <Button size="lg" variant="outline" className="justify-start" onClick={() => signInMock('district_admin')}>
                  <ShieldCheck className="h-5 w-5 text-brand-600" />
                  <span className="flex flex-col items-start">
                    <span>Officer Deshmukh</span>
                    <span className="text-xs font-normal text-slate-400">District Admin · DL-CENTRAL</span>
                  </span>
                </Button>
                <Button size="lg" variant="outline" className="justify-start" onClick={() => signInMock('state_admin')}>
                  <Users className="h-5 w-5 text-brand-600" />
                  <span className="flex flex-col items-start">
                    <span>Ms. Iyer</span>
                    <span className="text-xs font-normal text-slate-400">State Admin · Delhi</span>
                  </span>
                </Button>
              </>
            ) : (
              <form onSubmit={handleRealSignIn} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="password">Password</Label>
                  <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
                </div>
                <Button type="submit" size="lg" loading={busy}>
                  <UserCog className="h-4 w-4" /> Sign In
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
