import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { useTenant } from '@/app/queries';
import { api, isApiError, type TokenPair } from '@/lib/api';
import { homeFor, useAuth } from '@/lib/auth';
import { Button, Field, TextInput } from '@/ui';
import { AuthFrame } from './AuthFrame';

const OIDC_STATE_KEY = 'examos.oidc.state';

function ssoLabel(provider: string | null | undefined): string {
  switch (provider) {
    case 'entra':
      return 'Sign in with Microsoft';
    case 'google':
      return 'Sign in with Google';
    default:
      return 'Sign in with your university account';
  }
}

export function LoginPage() {
  const { status, roles, login } = useAuth();
  const tenant = useTenant();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ssoBusy, setSsoBusy] = useState(false);

  if (status === 'authenticated') return <Navigate to={next && next.startsWith('/') ? next : homeFor(roles)} replace />;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const me = await login(email, password);
      const home = homeFor(new Set(me.grants.map((g) => g.role)));
      navigate(next && next.startsWith('/') ? next : home, { replace: true });
    } catch (err) {
      if (isApiError(err, 'INVALID_CREDENTIALS')) setError('The e-mail or password is not right. Check both and try again.');
      else if (isApiError(err, 'RATE_LIMITED')) setError('Too many attempts. Wait a few minutes, then try again.');
      else if (isApiError(err) && err.status === 400) setError('Enter the e-mail address and password you were given.');
      else setError('Could not sign in right now. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  };

  const startSso = async () => {
    setSsoBusy(true);
    try {
      const redirectUri = `${window.location.origin}/auth/callback`;
      const out = await api.get<{ authorizationUrl: string; state: string }>(`/auth/oidc/start?redirectUri=${encodeURIComponent(redirectUri)}`, { auth: false });
      sessionStorage.setItem(OIDC_STATE_KEY, JSON.stringify({ state: out.state, next }));
      window.location.assign(out.authorizationUrl);
    } catch {
      setSsoBusy(false);
    }
  };

  return (
    <AuthFrame title="Sign in" lede="Use the account the Examination Section gave you.">
      <form onSubmit={(e) => void onSubmit(e)} noValidate className="flex flex-col gap-4">
        <Field label="E-mail">{({ id, describedBy, invalid }) => <TextInput id={id} type="email" name="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid || undefined} autoFocus />}</Field>
        <Field label="Password" error={error}>
          {({ id, describedBy, invalid }) => <TextInput id={id} type="password" name="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid || undefined} />}
        </Field>
        <Button type="submit" variant="primary" size="lg" loading={busy} className="mt-2">
          Sign in
        </Button>
      </form>
      {tenant.data?.ssoProvider ? (
        <div className="mt-6 pt-6 border-t border-rule">
          <Button variant="secondary" size="lg" className="w-full" onClick={() => void startSso()} loading={ssoBusy}>
            {ssoLabel(tenant.data.ssoProvider)}
          </Button>
        </div>
      ) : null}
      <p className="mt-6 text-sm text-ink-2">Received an activation e-mail? Open the link in it to set your password.</p>
    </AuthFrame>
  );
}

export function OidcCallbackPage() {
  const { adoptTokens } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const code = params.get('code');
    const state = params.get('state');
    let stored: { state: string; next: string | null } | null = null;
    try {
      stored = JSON.parse(sessionStorage.getItem(OIDC_STATE_KEY) ?? 'null') as { state: string; next: string | null } | null;
    } catch {
      stored = null;
    }
    if (!code || !state) {
      setError('The sign-in link is incomplete. Start again from the sign-in page.');
      return;
    }
    if (stored && stored.state !== state) {
      setError('The sign-in response did not match this browser session. Start again from the sign-in page.');
      return;
    }
    const next = stored?.next ?? null;
    void api
      .post<TokenPair>('/auth/oidc/callback', { code, state }, { auth: false })
      .then((pair) => adoptTokens(pair))
      .then((me) => {
        sessionStorage.removeItem(OIDC_STATE_KEY);
        navigate(next && next.startsWith('/') ? next : homeFor(new Set(me.grants.map((g) => g.role))), { replace: true });
      })
      .catch(() => setError('The university sign-in could not be completed. Start again from the sign-in page.'));
  }, [params, adoptTokens, navigate]);

  return (
    <AuthFrame title="Finishing sign-in">
      {error ? (
        <div className="flex flex-col gap-4">
          <p className="text-stop" role="alert">
            {error}
          </p>
          <Button variant="primary" onClick={() => navigate('/login', { replace: true })}>
            Back to sign in
          </Button>
        </div>
      ) : (
        <p className="text-ink-2" role="status">
          Checking your university account…
        </p>
      )}
    </AuthFrame>
  );
}

export function ActivatePage() {
  const { adoptTokens } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 12) return setError('Use at least 12 characters. A short sentence works well.');
    if (password !== confirm) return setError('The two passwords do not match.');
    setBusy(true);
    try {
      const pair = await api.post<TokenPair>('/auth/activate', { token, password }, { auth: false, quiet: true });
      const me = await adoptTokens(pair);
      navigate(homeFor(new Set(me.grants.map((g) => g.role))), { replace: true });
    } catch (err) {
      if (isApiError(err) && (err.status === 401 || err.status === 404 || err.status === 409)) setError('This activation link has expired or was already used. Ask the Examination Section for a new one.');
      else setError('Could not activate the account right now. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame title="Set your password" lede="This activates your account. You will use this password together with your e-mail address.">
      {!token ? (
        <p className="text-stop" role="alert">
          The activation link is missing its token. Open the link from the e-mail again.
        </p>
      ) : (
        <form onSubmit={(e) => void onSubmit(e)} noValidate className="flex flex-col gap-4">
          <Field label="New password" hint="At least 12 characters.">
            {({ id, describedBy }) => <TextInput id={id} type="password" autoComplete="new-password" minLength={12} required value={password} onChange={(e) => setPassword(e.target.value)} aria-describedby={describedBy} autoFocus />}
          </Field>
          <Field label="Repeat the password" error={error}>
            {({ id, describedBy, invalid }) => <TextInput id={id} type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid || undefined} />}
          </Field>
          <Button type="submit" variant="primary" size="lg" loading={busy} className="mt-2">
            Activate account
          </Button>
        </form>
      )}
    </AuthFrame>
  );
}
