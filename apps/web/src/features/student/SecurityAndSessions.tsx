import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/time';
import { Badge, Button, Dialog, Field, Skeleton, TextInput, useToast } from '@/ui';

export function SecurityAndSessions({ tz }: { tz: string }) {
  const { me, roles } = useAuth();
  const qc = useQueryClient();
  const { toast } = useToast();

  // MFA Status Query
  const mfaQuery = useQuery({
    queryKey: ['auth', 'mfa-status'],
    queryFn: () => api.get<{ enabled: boolean; required: boolean; privileged: boolean }>('/auth/mfa/status'),
  });

  // Sessions Query
  const sessionsQuery = useQuery({
    queryKey: ['auth', 'sessions'],
    queryFn: () =>
      api.get<{
        sessions: Array<{
          id: string;
          client_ip: string;
          user_agent: string;
          issued_at: string;
          expires_at: string;
        }>;
      }>('/auth/sessions'),
  });

  // Setup MFA state
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupData, setSetupData] = useState<{ secret: string; uri: string; recoveryCodes: string[] } | null>(null);
  const [verifyCode, setVerifyCode] = useState('');
  const [setupLoading, setSetupLoading] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);

  // Disable MFA state
  const [disableOpen, setDisableOpen] = useState(false);
  const [disableCode, setDisableCode] = useState('');
  const [disableLoading, setDisableLoading] = useState(false);
  const [disableError, setDisableError] = useState<string | null>(null);

  // Sessions revoke state
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokingOthers, setRevokingOthers] = useState(false);

  const isPrivileged = roles.has('CONTROLLER') || roles.has('SYSTEM_ADMIN') || roles.has('TENANT_ADMIN');

  const startMfaSetup = async () => {
    setSetupLoading(true);
    setSetupError(null);
    setVerifyCode('');
    try {
      const data = await api.post<{ secret: string; uri: string; recoveryCodes: string[] }>('/auth/mfa/setup', {});
      setSetupData(data);
      setSetupOpen(true);
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : 'Failed to initiate 2FA setup.');
    } finally {
      setSetupLoading(false);
    }
  };

  const handleActivateMfa = async (e: FormEvent) => {
    e.preventDefault();
    if (!verifyCode.trim()) {
      setSetupError('Please enter the 6-digit code from your authenticator.');
      return;
    }
    setSetupLoading(true);
    setSetupError(null);
    try {
      await api.post('/auth/mfa/activate', { code: verifyCode.trim() });
      toast({
        tone: 'success',
        title: 'Two-Factor Authentication enabled',
        description: 'Your account is now protected with TOTP two-factor authentication.',
      });
      setSetupOpen(false);
      void qc.invalidateQueries({ queryKey: ['auth', 'mfa-status'] });
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : 'Invalid verification code. Please check your authenticator clock.');
    } finally {
      setSetupLoading(false);
    }
  };

  const handleDisableMfa = async (e: FormEvent) => {
    e.preventDefault();
    if (!disableCode.trim()) {
      setDisableError('Please enter a 6-digit code or recovery code.');
      return;
    }
    setDisableLoading(true);
    setDisableError(null);
    try {
      await api.post('/auth/mfa/disable', { code: disableCode.trim() });
      toast({
        tone: 'info',
        title: 'Two-Factor Authentication disabled',
        description: '2FA has been turned off for your account.',
      });
      setDisableOpen(false);
      void qc.invalidateQueries({ queryKey: ['auth', 'mfa-status'] });
    } catch (err) {
      setDisableError(err instanceof Error ? err.message : 'Could not disable 2FA. Please verify the code.');
    } finally {
      setDisableLoading(false);
    }
  };

  const handleRevokeSession = async (id: string) => {
    setRevokingId(id);
    try {
      await api.del(`/auth/sessions/${id}`);
      toast({ tone: 'success', title: 'Session revoked', description: 'Selected device session has been signed out.' });
      void qc.invalidateQueries({ queryKey: ['auth', 'sessions'] });
    } catch {
      /* handled */
    } finally {
      setRevokingId(null);
    }
  };

  const handleRevokeOthers = async () => {
    setRevokingOthers(true);
    try {
      const res = await api.post<{ revokedCount: number }>('/auth/sessions/revoke-others', {});
      toast({
        tone: 'success',
        title: 'Other sessions logged out',
        description: `Successfully signed out of ${res.revokedCount} other active device(s).`,
      });
      void qc.invalidateQueries({ queryKey: ['auth', 'sessions'] });
    } catch {
      /* handled */
    } finally {
      setRevokingOthers(false);
    }
  };

  const copyToClipboard = (text: string, label: string) => {
    void navigator.clipboard.writeText(text);
    toast({ tone: 'success', title: 'Copied', description: `${label} copied to clipboard.` });
  };

  const mfaEnabled = mfaQuery.data?.enabled ?? false;
  const sessions = sessionsQuery.data?.sessions ?? [];

  return (
    <div className="space-y-6 no-print">
      {/* 2FA Security Section */}
      <section aria-labelledby="security-2fa-heading" className="sheet p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-rule pb-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 id="security-2fa-heading" className="text-lg font-serif text-ink font-semibold">
                Two-Factor Authentication (TOTP)
              </h2>
              <Badge tone={mfaEnabled ? 'ready' : isPrivileged ? 'stop' : 'neutral'}>
                {mfaEnabled ? 'Active' : isPrivileged ? 'Mandatory' : 'Disabled'}
              </Badge>
            </div>
            <p className="text-sm text-ink-2 mt-1">
              {isPrivileged
                ? 'Required for privileged university operations (step-up authorization before result publication, script exports, and security waivers).'
                : 'Protect your account using standard TOTP authenticators (Google Authenticator, Microsoft Authenticator, 1Password).'}
            </p>
          </div>

          <div>
            {mfaEnabled ? (
              <Button variant="ghost" onClick={() => { setDisableCode(''); setDisableError(null); setDisableOpen(true); }}>
                Disable 2FA
              </Button>
            ) : (
              <Button variant="primary" loading={setupLoading} onClick={() => void startMfaSetup()}>
                Set up Authenticator (2FA)
              </Button>
            )}
          </div>
        </div>

        {mfaEnabled ? (
          <div className="text-xs text-ink-2 bg-ready/5 border border-ready/20 rounded p-3 flex items-start gap-3">
            <span className="text-ready text-base leading-none">✓</span>
            <div>
              <p className="font-semibold text-ready">Your account is secured with Two-Factor Authentication</p>
              <p className="mt-0.5">
                Every login and privileged university examination step will require an authenticator token or single-use recovery code.
              </p>
            </div>
          </div>
        ) : isPrivileged ? (
          <div className="text-xs text-stop bg-stop/5 border border-stop/20 rounded p-3 flex items-start gap-3">
            <span className="text-stop text-base leading-none">⚠</span>
            <div>
              <p className="font-semibold text-stop">Action required for privileged staff</p>
              <p className="mt-0.5">
                Your role carries examination authority. You must configure 2FA to authorize result publications or export student script booklets.
              </p>
            </div>
          </div>
        ) : null}
      </section>

      {/* Active Device Sessions */}
      <section aria-labelledby="sessions-heading" className="sheet p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-rule pb-4">
          <div>
            <h2 id="sessions-heading" className="text-lg font-serif text-ink font-semibold">
              Active Device Sessions ({sessions.length})
            </h2>
            <p className="text-sm text-ink-2 mt-1">
              Devices and browsers currently authenticated with your account.
            </p>
          </div>
          {sessions.length > 1 ? (
            <Button variant="secondary" loading={revokingOthers} onClick={() => void handleRevokeOthers()}>
              Log out other devices
            </Button>
          ) : null}
        </div>

        {sessionsQuery.isLoading ? (
          <Skeleton lines={3} />
        ) : sessions.length === 0 ? (
          <p className="text-sm text-ink-3">No active sessions recorded.</p>
        ) : (
          <div className="divide-y divide-rule border border-rule rounded overflow-hidden">
            {sessions.map((s, idx) => (
              <div key={s.id} className="p-3 bg-sheet flex flex-wrap items-center justify-between gap-4 text-xs">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-ink">{idx === 0 ? 'Current Device' : 'Active Session'}</span>
                    {idx === 0 ? <Badge tone="accent">This browser</Badge> : null}
                  </div>
                  <p className="text-ink-2 mt-0.5 font-mono">{s.client_ip || 'IP Unknown'}</p>
                  <p className="text-ink-3 text-[11px] truncate max-w-sm" title={s.user_agent}>
                    {s.user_agent || 'Unknown browser'}
                  </p>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-ink-3 font-mono">Issued: {formatDateTime(s.issued_at, tz)}</span>
                  {idx > 0 ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={revokingId === s.id}
                      onClick={() => void handleRevokeSession(s.id)}
                    >
                      Revoke
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Setup 2FA Modal */}
      <Dialog
        open={setupOpen}
        onClose={() => setSetupOpen(false)}
        title="Set up Two-Factor Authentication"
        description="Connect your authenticator app to secure your university examination account."
      >
        {setupData ? (
          <form onSubmit={handleActivateMfa} className="space-y-5 py-2">
            <div>
              <span className="text-xs font-semibold uppercase tracking-wider text-ink-3 block mb-1">
                Step 1: Add to Authenticator App
              </span>
              <p className="text-xs text-ink-2 mb-2">
                Open Google Authenticator, Microsoft Authenticator, or 1Password and add an account using this secret key:
              </p>
              <div className="p-3 bg-sheet-2 border border-rule rounded flex items-center justify-between gap-2">
                <code className="font-mono text-sm font-bold text-accent tracking-widest break-all">
                  {setupData.secret}
                </code>
                <Button
                  size="sm"
                  variant="ghost"
                  type="button"
                  onClick={() => copyToClipboard(setupData.secret, 'Secret key')}
                >
                  Copy Key
                </Button>
              </div>
              <div className="mt-2 text-right">
                <Button
                  size="sm"
                  variant="ghost"
                  type="button"
                  onClick={() => copyToClipboard(setupData.uri, 'Authenticator URI')}
                >
                  Copy App URI (otpauth://)
                </Button>
              </div>
            </div>

            <div>
              <span className="text-xs font-semibold uppercase tracking-wider text-ink-3 block mb-1">
                Step 2: Save Single-Use Recovery Codes
              </span>
              <p className="text-xs text-ink-2 mb-2">
                Save these 10 recovery codes in a safe place. If you lose access to your device, each code can be used once to log in.
              </p>
              <div className="p-3 bg-sheet-2 border border-rule rounded grid grid-cols-2 gap-2 font-mono text-xs text-ink">
                {setupData.recoveryCodes.map((code) => (
                  <span key={code} className="p-1 bg-sheet rounded text-center border border-rule-2">
                    {code}
                  </span>
                ))}
              </div>
              <div className="mt-2 text-right">
                <Button
                  size="sm"
                  variant="ghost"
                  type="button"
                  onClick={() => copyToClipboard(setupData.recoveryCodes.join('\n'), 'Recovery codes')}
                >
                  Copy All Codes
                </Button>
              </div>
            </div>

            <div>
              <span className="text-xs font-semibold uppercase tracking-wider text-ink-3 block mb-1">
                Step 3: Confirm 6-Digit Code
              </span>
              <Field label="Verification Code">
                {({ id }) => (
                  <TextInput
                    id={id}
                    value={verifyCode}
                    onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="123456"
                    className="font-mono text-center tracking-widest text-lg"
                    maxLength={6}
                    autoFocus
                  />
                )}
              </Field>
            </div>

            {setupError ? (
              <p className="text-stop text-sm" role="alert">
                {setupError}
              </p>
            ) : null}

            <div className="flex justify-end gap-3 pt-2">
              <Button variant="ghost" type="button" onClick={() => setSetupOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" type="submit" loading={setupLoading} disabled={verifyCode.length < 6}>
                Verify &amp; Activate 2FA
              </Button>
            </div>
          </form>
        ) : (
          <Skeleton lines={4} />
        )}
      </Dialog>

      {/* Disable 2FA Modal */}
      <Dialog
        open={disableOpen}
        onClose={() => setDisableOpen(false)}
        title="Disable Two-Factor Authentication?"
        description="Verify your identity with an authenticator or recovery code to turn off 2FA."
      >
        <form onSubmit={handleDisableMfa} className="space-y-4 py-2">
          {isPrivileged ? (
            <p className="text-xs text-stop bg-stop/10 p-2.5 rounded border border-stop/20">
              Warning: Privileged roles require 2FA to authorize result publications, script exports, and waivers.
            </p>
          ) : null}

          <Field label="6-Digit Authenticator Code or Recovery Code">
            {({ id }) => (
              <TextInput
                id={id}
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value)}
                placeholder="123456 or A1B2C3D4"
                className="font-mono"
                autoFocus
              />
            )}
          </Field>

          {disableError ? (
            <p className="text-stop text-sm" role="alert">
              {disableError}
            </p>
          ) : null}

          <div className="flex justify-end gap-3 pt-2">
            <Button variant="ghost" type="button" onClick={() => setDisableOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" type="submit" loading={disableLoading} disabled={!disableCode.trim()}>
              Turn Off 2FA
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
