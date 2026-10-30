import { useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { API_KEY_SCOPES, MAIL_TRANSPORT_KINDS, ROLE_CODES, ROLE_PERMISSIONS, WEBHOOK_EVENT_TYPES, type Permission, type RoleCode } from '@examos/contracts';
import { api, isApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/time';
import { Badge, Button, Checkbox, CopyIcon, Dialog, EmptyState, Field, humanize, PageTitle, Select, Skeleton, StatusChip, Table, Tabs, TextArea, TextInput, useToast, type Column, type TabDef, type Tone } from '@/ui';

type TabId = 'users' | 'mail' | 'dispatches' | 'sso' | 'keys' | 'webhooks' | 'deliveries' | 'audit' | 'erp' | 'import';

const TAB_PERMISSION: Record<TabId, Permission> = {
  users: 'users:read',
  mail: 'mail:manage',
  dispatches: 'mail:manage',
  sso: 'tenant:manage',
  keys: 'integration:manage',
  webhooks: 'integration:manage',
  deliveries: 'integration:manage',
  audit: 'audit:read',
  erp: 'integration:manage',
  import: 'roster:write',
};

export function AdminPage() {
  const { roles, me } = useAuth();
  const tz = me?.tenant.timezone ?? 'Asia/Kolkata';
  const perms = useMemo(() => {
    const s = new Set<Permission>();
    for (const r of roles) for (const p of ROLE_PERMISSIONS[r]) s.add(p);
    return s;
  }, [roles]);
  const tabs: TabDef<TabId>[] = (
    [
      ['users', 'Users'],
      ['mail', 'Mail'],
      ['dispatches', 'Mail log'],
      ['erp', 'ERP connections'],
      ['import', 'Roster import'],
      ['sso', 'Single sign-on'],
      ['keys', 'API keys'],
      ['webhooks', 'Webhooks'],
      ['deliveries', 'Deliveries'],
      ['audit', 'Audit log'],
    ] as const
  )
    .filter(([id]) => perms.has(TAB_PERMISSION[id]))
    .map(([id, label]) => ({ id, label }));
  const [tab, setTab] = useState<TabId>(tabs[0]?.id ?? 'users');

  if (tabs.length === 0) return <EmptyState title="No administration sections for your role">Ask a tenant administrator if you need access.</EmptyState>;

  return (
    <div>
      <PageTitle title="Administration" lede={me?.tenant.name} />
      <Tabs tabs={tabs} value={tab} onChange={setTab} label="Administration sections">
        {tab === 'users' ? <Users canWrite={perms.has('users:write')} tz={tz} /> : null}
        {tab === 'mail' ? <MailConfig /> : null}
        {tab === 'dispatches' ? <Dispatches tz={tz} /> : null}
        {tab === 'erp' ? <ErpConnections tz={tz} /> : null}
        {tab === 'import' ? <RosterImport /> : null}
        {tab === 'sso' ? <SsoConfig /> : null}
        {tab === 'keys' ? <ApiKeys /> : null}
        {tab === 'webhooks' ? <Webhooks /> : null}
        {tab === 'deliveries' ? <Deliveries tz={tz} /> : null}
        {tab === 'audit' ? <Audit tz={tz} /> : null}
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------- users
interface UserRow {
  id: string;
  email: string;
  fullName: string;
  kind: 'STUDENT' | 'STAFF';
  status: string;
  registerNumber: string | null;
  createdAt: string;
}

function Users({ canWrite, tz }: { canWrite: boolean; tz: string }) {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [create, setCreate] = useState(false);
  const [roleFor, setRoleFor] = useState<UserRow | null>(null);
  const users = useQuery({ queryKey: ['tenant', 'users', q, kind], queryFn: () => api.get<{ users: UserRow[] }>(`/tenant/users?q=${encodeURIComponent(q)}&kind=${kind}`) });
  const columns: Column<UserRow>[] = [
    { key: 'name', header: 'Name', render: (u) => (
        <div>
          <p className="font-medium">{u.fullName}</p>
          <p className="text-sm text-ink-2">{u.email}</p>
        </div>
      ) },
    { key: 'kind', header: 'Kind', render: (u) => <Badge>{humanize(u.kind)}</Badge> },
    { key: 'reg', header: 'Register number', hideOnMobile: true, render: (u) => <span className="font-mono">{u.registerNumber ?? '—'}</span> },
    { key: 'status', header: 'Status', render: (u) => <StatusChip tone={u.status === 'ACTIVE' ? 'ready' : u.status === 'PENDING_ACTIVATION' ? 'fix' : 'note'} icon={false}>{humanize(u.status)}</StatusChip> },
    { key: 'created', header: 'Created', hideOnMobile: true, render: (u) => formatDateTime(u.createdAt, tz) },
    { key: 'roles', header: '', align: 'right', render: (u) => (canWrite ? <Button size="sm" onClick={() => setRoleFor(u)}>Roles</Button> : null) },
  ];
  return (
    <div>
      <div className="flex flex-wrap items-end gap-3 mb-5">
        <Field label="Search" hideLabel className="min-w-64">
          {({ id }) => <TextInput id={id} type="search" placeholder="Name, e-mail or register number" value={q} onChange={(e) => setQ(e.target.value)} />}
        </Field>
        <Field label="Kind" hideLabel>
          {({ id }) => (
            <Select id={id} value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">Students and staff</option>
              <option value="STUDENT">Students</option>
              <option value="STAFF">Staff</option>
            </Select>
          )}
        </Field>
        {canWrite ? (
          <Button variant="primary" className="ml-auto" onClick={() => setCreate(true)}>
            Create user
          </Button>
        ) : null}
      </div>
      {users.isLoading ? <Skeleton lines={5} /> : null}
      {users.data ? <Table caption="Users" columns={columns} rows={users.data.users} rowKey={(u) => u.id} empty="No users match." /> : null}
      {create ? <CreateUserDialog onClose={() => setCreate(false)} /> : null}
      {roleFor ? <RoleDialog user={roleFor} onClose={() => setRoleFor(null)} /> : null}
    </div>
  );
}

function CreateUserDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [f, setF] = useState({ email: '', fullName: '', kind: 'STAFF', externalId: '', provider: '', sendActivation: true });
  const [roles, setRoles] = useState<Set<RoleCode>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const out = await api.post<{ userId: string; activationDispatchId: string | null }>(
        '/tenant/users',
        { email: f.email.trim(), fullName: f.fullName.trim(), kind: f.kind, externalId: f.externalId.trim() || undefined, provider: f.provider.trim() || undefined, roles: [...roles].map((role) => ({ role, scopeType: 'TENANT' })), sendActivation: f.sendActivation },
        { quiet: ['CONFLICT', 'USER_EXISTS', 'VALIDATION'] },
      );
      toast({ tone: 'success', title: 'User created', description: out.activationDispatchId ? 'An activation e-mail is queued.' : 'No activation e-mail was sent.' });
      void qc.invalidateQueries({ queryKey: ['tenant', 'users'] });
      onClose();
    } catch (err) {
      setError(isApiError(err) ? (err.problem.errors?.map((x) => `${x.path}: ${x.message}`).join('; ') ?? `${err.problem.title} (${err.code})`) : 'Could not create the user.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title="Create user"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="create-user" loading={busy}>
            Create user
          </Button>
        </>
      }
    >
      <form id="create-user" onSubmit={(e) => void submit(e)} noValidate className="grid gap-4 sm:grid-cols-2">
        <Field label="Full name" required>
          {({ id }) => <TextInput id={id} value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} data-autofocus />}
        </Field>
        <Field label="E-mail" required>
          {({ id }) => <TextInput id={id} type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />}
        </Field>
        <Field label="Kind">
          {({ id }) => (
            <Select id={id} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
              <option value="STAFF">Staff</option>
              <option value="STUDENT">Student</option>
            </Select>
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="External id" hint="ERP person id">
            {({ id, describedBy }) => <TextInput id={id} value={f.externalId} onChange={(e) => setF({ ...f, externalId: e.target.value })} aria-describedby={describedBy} className="font-mono" />}
          </Field>
          <Field label="Provider">
            {({ id }) => <TextInput id={id} value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })} className="font-mono" placeholder="uos" />}
          </Field>
        </div>
        <fieldset className="sm:col-span-2">
          <legend className="text-sm font-medium mb-2">Roles (tenant-wide)</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {ROLE_CODES.map((r) => (
              <Checkbox
                key={r}
                label={humanize(r)}
                checked={roles.has(r)}
                onChange={(e) => {
                  const n = new Set(roles);
                  if (e.target.checked) n.add(r);
                  else n.delete(r);
                  setRoles(n);
                }}
              />
            ))}
          </div>
        </fieldset>
        <Checkbox className="sm:col-span-2" label="Send an activation e-mail" description="The person sets their password from the link." checked={f.sendActivation} onChange={(e) => setF({ ...f, sendActivation: e.target.checked })} />
        {error ? (
          <p className="sm:col-span-2 text-stop text-sm" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}

function RoleDialog({ user, onClose }: { user: UserRow; onClose: () => void }) {
  const { toast } = useToast();
  const [role, setRole] = useState<RoleCode>('STUDENT');
  const [busy, setBusy] = useState(false);
  const act = async (method: 'grant' | 'revoke') => {
    setBusy(true);
    try {
      if (method === 'grant') await api.post(`/tenant/users/${user.id}/roles`, { role, scopeType: 'TENANT', scopeId: null });
      else await api.del(`/tenant/users/${user.id}/roles`, { role, scopeType: 'TENANT', scopeId: null });
      toast({ tone: 'success', title: method === 'grant' ? `${humanize(role)} granted` : `${humanize(role)} revoked`, description: user.email });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} title={`Roles for ${user.fullName}`} description="Grants and revocations take effect on the person's next request. The API does not list current grants, so choose the role you mean to change." size="sm">
      <div className="flex flex-col gap-4">
        <Field label="Role">
          {({ id }) => (
            <Select id={id} value={role} onChange={(e) => setRole(e.target.value as RoleCode)} data-autofocus>
              {ROLE_CODES.map((r) => (
                <option key={r} value={r}>
                  {humanize(r)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => void act('grant')} loading={busy}>
            Grant
          </Button>
          <Button variant="danger" onClick={() => void act('revoke')} loading={busy}>
            Revoke
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- mail
const TRANSPORT_HELP: Record<string, string> = {
  'power-automate': 'An HTTP-triggered Power Automate flow sends on the university’s behalf. Needs the flow URL (sealed) and a callback secret.',
  graph: 'Microsoft Graph sendMail with an application token. Needs the token secret (sealed).',
  'smtp-oauth2': 'SMTP with OAuth 2 (XOAUTH2). Needs the token secret (sealed).',
  'smtp-relay': 'A plain SMTP relay inside the campus network. Settings carry host and port.',
  capture: 'Development only: mail is captured, not sent.',
  'acs-email': 'Azure Communication Services Email for external bulk delivery (Phase 7).',
  ses: 'AWS Simple Email Service (SES) for external transactional and bulk delivery (Phase 7).',
};

function MailConfig() {
  const { toast } = useToast();
  const [f, setF] = useState({ transportKind: 'power-automate', senderAddress: '', senderName: 'Examination Cell', endpointSecret: '', tokenSecret: '', callbackSecret: '', category: '', settings: '{}' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    let settings: Record<string, unknown> = {};
    try {
      settings = f.settings.trim() ? (JSON.parse(f.settings) as Record<string, unknown>) : {};
    } catch {
      return setError('Settings must be valid JSON.');
    }
    setBusy(true);
    try {
      await api.put('/tenant/mail-config', { transportKind: f.transportKind, senderAddress: f.senderAddress.trim(), senderName: f.senderName.trim() || 'Examination Cell', endpointSecret: f.endpointSecret || undefined, tokenSecret: f.tokenSecret || undefined, callbackSecret: f.callbackSecret || undefined, category: f.category || null, settings });
      toast({ tone: 'success', title: 'Mail configuration saved', description: 'Secrets were sealed and cannot be read back.' });
      setF({ ...f, endpointSecret: '', tokenSecret: '', callbackSecret: '' });
    } catch (err) {
      setError(isApiError(err) ? `${err.problem.title} (${err.code})` : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="max-w-2xl flex flex-col gap-4">
      <p className="text-ink-2">How ExamOS sends activation links, admission receipts and result notices. Secrets are sealed on save and never shown again; leave a secret blank to keep the stored one.</p>
      <Field label="Transport" hint={TRANSPORT_HELP[f.transportKind]}>
        {({ id, describedBy }) => (
          <Select id={id} value={f.transportKind} onChange={(e) => setF({ ...f, transportKind: e.target.value })} aria-describedby={describedBy}>
            {MAIL_TRANSPORT_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Sender address" required>
          {({ id }) => <TextInput id={id} type="email" value={f.senderAddress} onChange={(e) => setF({ ...f, senderAddress: e.target.value })} placeholder="examcell@university.edu" />}
        </Field>
        <Field label="Sender name">
          {({ id }) => <TextInput id={id} value={f.senderName} onChange={(e) => setF({ ...f, senderName: e.target.value })} />}
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Endpoint secret" hint="Flow URL or endpoint; sealed.">
          {({ id, describedBy }) => <TextInput id={id} type="password" autoComplete="new-password" value={f.endpointSecret} onChange={(e) => setF({ ...f, endpointSecret: e.target.value })} aria-describedby={describedBy} />}
        </Field>
        <Field label="Token secret" hint="Sealed on save.">
          {({ id, describedBy }) => <TextInput id={id} type="password" autoComplete="new-password" value={f.tokenSecret} onChange={(e) => setF({ ...f, tokenSecret: e.target.value })} aria-describedby={describedBy} />}
        </Field>
        <Field label="Callback secret" hint="Verifies delivery callbacks; sealed.">
          {({ id, describedBy }) => <TextInput id={id} type="password" autoComplete="new-password" value={f.callbackSecret} onChange={(e) => setF({ ...f, callbackSecret: e.target.value })} aria-describedby={describedBy} />}
        </Field>
      </div>
      <Field label="Category (optional)" hint="Restrict this transport to one mail category; blank applies to all.">
        {({ id, describedBy }) => <TextInput id={id} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} aria-describedby={describedBy} className="font-mono" />}
      </Field>
      <Field label="Settings (JSON)" hint="Transport-specific, e.g. host and port for a relay.">
        {({ id, describedBy }) => <TextArea id={id} value={f.settings} onChange={(e) => setF({ ...f, settings: e.target.value })} aria-describedby={describedBy} className="font-mono text-sm" rows={3} />}
      </Field>
      {error ? (
        <p className="text-stop text-sm" role="alert">
          {error}
        </p>
      ) : null}
      <div>
        <Button type="submit" variant="primary" loading={busy}>
          Save mail configuration
        </Button>
      </div>
    </form>
  );
}

interface Dispatch {
  id: string;
  category: string;
  lane: string;
  toAddress: string;
  subject: string;
  status: string;
  attemptCount: number;
  transportKind: string | null;
  lastError: string | null;
  createdAt: string;
  acceptedAt: string | null;
}

interface MailHealthData {
  totalDispatches: number;
  accepted: number;
  delivered: number;
  bounced: number;
  failed: number;
  queued: number;
  sending: number;
  bounceRatePct: number;
  byTransport: Record<string, number>;
  byLane: Record<string, number>;
  dailyExternalQuota: {
    sentToday: number;
    limit: number;
    remaining: number;
  };
}

function Dispatches({ tz }: { tz: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [bounceModal, setBounceModal] = useState(false);
  const [bounceForm, setBounceForm] = useState({ toAddress: '', reason: '', diagnosticCode: '' });
  const [submittingBounce, setSubmittingBounce] = useState(false);

  const q = useQuery({
    queryKey: ['tenant', 'dispatches'],
    queryFn: () => api.get<{ dispatches: Dispatch[] }>('/tenant/mail-dispatches'),
    refetchInterval: 15_000,
  });

  const healthQ = useQuery({
    queryKey: ['tenant', 'mail', 'health'],
    queryFn: () => api.get<MailHealthData>('/tenant/mail/health'),
    refetchInterval: 15_000,
  });

  const handleReconcileBounce = async (e: FormEvent) => {
    e.preventDefault();
    setSubmittingBounce(true);
    try {
      const res = await api.post<{ reconciled: boolean; dispatchId?: string }>('/tenant/mail/bounces', {
        toAddress: bounceForm.toAddress.trim(),
        reason: bounceForm.reason.trim() || undefined,
        diagnosticCode: bounceForm.diagnosticCode.trim() || undefined,
      });
      if (res.reconciled) {
        toast({ tone: 'success', title: 'Bounce reconciled', description: `Dispatch ${res.dispatchId?.slice(0, 8)} marked as BOUNCED.` });
      } else {
        toast({ tone: 'error', title: 'No matching dispatch', description: 'Could not find an active dispatch for this address.' });
      }
      setBounceModal(false);
      setBounceForm({ toAddress: '', reason: '', diagnosticCode: '' });
      void qc.invalidateQueries({ queryKey: ['tenant', 'dispatches'] });
      void qc.invalidateQueries({ queryKey: ['tenant', 'mail', 'health'] });
    } catch (err) {
      toast({ tone: 'error', title: 'Failed to reconcile bounce', description: isApiError(err) ? err.message : 'Error submitting bounce.' });
    } finally {
      setSubmittingBounce(false);
    }
  };

  const tone = (s: string): Tone =>
    s === 'DELIVERED' || s === 'ACCEPTED'
      ? 'ready'
      : s === 'FAILED' || s === 'BOUNCED'
        ? 'stop'
        : s === 'SENDING'
          ? 'accent'
          : 'neutral';

  const h = healthQ.data;

  return (
    <div className="flex flex-col gap-6">
      {/* Mail Health & Quota Cards */}
      {h ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <div className="rounded-lg border border-line bg-surface p-4">
            <span className="text-xs uppercase tracking-wider text-ink-3">Total Dispatched</span>
            <p className="mt-1 text-2xl font-semibold tabular text-ink">{h.totalDispatches}</p>
          </div>
          <div className="rounded-lg border border-line bg-surface p-4">
            <span className="text-xs uppercase tracking-wider text-ink-3">Accepted / Sent</span>
            <p className="mt-1 text-2xl font-semibold tabular text-ready">{h.accepted + h.delivered}</p>
          </div>
          <div className="rounded-lg border border-line bg-surface p-4">
            <span className="text-xs uppercase tracking-wider text-ink-3">Bounced</span>
            <p className="mt-1 text-2xl font-semibold tabular text-stop">{h.bounced}</p>
          </div>
          <div className="rounded-lg border border-line bg-surface p-4">
            <span className="text-xs uppercase tracking-wider text-ink-3">Failed</span>
            <p className="mt-1 text-2xl font-semibold tabular text-stop">{h.failed}</p>
          </div>
          <div className="rounded-lg border border-line bg-surface p-4">
            <span className="text-xs uppercase tracking-wider text-ink-3">Bounce Rate</span>
            <p className="mt-1 text-2xl font-semibold tabular text-ink">{h.bounceRatePct}%</p>
          </div>
          <div className="rounded-lg border border-line bg-surface p-4">
            <span className="text-xs uppercase tracking-wider text-ink-3">Daily Bulk Quota</span>
            <p className="mt-1 text-lg font-semibold tabular text-ink">
              {h.dailyExternalQuota.sentToday} <span className="text-sm font-normal text-ink-3">/ {h.dailyExternalQuota.limit}</span>
            </p>
          </div>
        </div>
      ) : null}

      <div className="flex items-center justify-between">
        <h3 className="text-base font-medium text-ink">Dispatches</h3>
        <Button variant="secondary" size="sm" onClick={() => setBounceModal(true)}>
          Reconcile bounce
        </Button>
      </div>

      {q.isLoading ? (
        <Skeleton lines={5} />
      ) : (
        <Table
          caption="Mail dispatches"
          columns={[
            {
              key: 'to',
              header: 'To',
              render: (d) => (
                <div>
                  <p className="font-medium">{d.toAddress}</p>
                  <p className="text-sm text-ink-2">{d.subject}</p>
                </div>
              ),
            },
            { key: 'cat', header: 'Category', hideOnMobile: true, render: (d) => <Badge>{humanize(d.category)}</Badge> },
            { key: 'status', header: 'Status', render: (d) => <StatusChip tone={tone(d.status)} icon={false}>{humanize(d.status)}</StatusChip> },
            { key: 'attempts', header: 'Attempts', align: 'right', hideOnMobile: true, render: (d) => <span className="tabular">{d.attemptCount}</span> },
            { key: 'transport', header: 'Transport', hideOnMobile: true, render: (d) => d.transportKind ?? '—' },
            { key: 'when', header: 'Queued', hideOnMobile: true, render: (d) => formatDateTime(d.createdAt, tz) },
            { key: 'err', header: 'Last error', hideOnMobile: true, render: (d) => <span className="text-sm text-stop">{d.lastError ?? ''}</span> },
          ]}
          rows={q.data?.dispatches ?? []}
          rowKey={(d) => d.id}
          empty="Nothing has been sent yet."
        />
      )}

      {/* Bounce Reconciliation Dialog */}
      <Dialog
        open={bounceModal}
        onClose={() => setBounceModal(false)}
        title="Reconcile bounce"
        description="Mark an undelivered message as BOUNCED from an NDR or mail report."
      >
        <form onSubmit={(e) => void handleReconcileBounce(e)} className="flex flex-col gap-4">
          <Field label="Recipient email address" required>
            {({ id }) => (
              <TextInput
                id={id}
                type="email"
                required
                value={bounceForm.toAddress}
                onChange={(e) => setBounceForm({ ...bounceForm, toAddress: e.target.value })}
                placeholder="student@university.edu"
              />
            )}
          </Field>
          <Field label="Bounce reason / error">
            {({ id }) => (
              <TextInput
                id={id}
                value={bounceForm.reason}
                onChange={(e) => setBounceForm({ ...bounceForm, reason: e.target.value })}
                placeholder="550 5.1.1 User unknown"
              />
            )}
          </Field>
          <Field label="Diagnostic code (optional)">
            {({ id }) => (
              <TextInput
                id={id}
                value={bounceForm.diagnosticCode}
                onChange={(e) => setBounceForm({ ...bounceForm, diagnosticCode: e.target.value })}
                placeholder="smtp; 550 5.1.1 resolver.rst.badrecipient"
              />
            )}
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setBounceModal(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={submittingBounce}>
              Confirm bounce
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------- sso
function SsoConfig() {
  const { toast } = useToast();
  const [f, setF] = useState({ provider: 'entra', issuer: '', clientId: '', clientSecret: '', allowedEmailDomains: '', enabled: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.put('/tenant/sso-config', { provider: f.provider, issuer: f.issuer.trim(), clientId: f.clientId.trim(), clientSecret: f.clientSecret || undefined, allowedEmailDomains: f.allowedEmailDomains.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean), enabled: f.enabled }, { quiet: ['VALIDATION'] });
      toast({ tone: 'success', title: 'Single sign-on saved', description: f.enabled ? 'The sign-in page now offers it.' : 'Disabled.' });
      setF({ ...f, clientSecret: '' });
    } catch (err) {
      setError(isApiError(err) ? (err.problem.errors?.map((x) => `${x.path}: ${x.message}`).join('; ') ?? `${err.problem.title} (${err.code})`) : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="max-w-2xl flex flex-col gap-4">
      <p className="text-ink-2">OpenID Connect sign-in with the university identity provider. The client secret is sealed on save.</p>
      <Field label="Provider">
        {({ id }) => (
          <Select id={id} value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })}>
            <option value="entra">Microsoft Entra ID</option>
            <option value="google">Google Workspace</option>
            <option value="generic">Generic OpenID Connect</option>
          </Select>
        )}
      </Field>
      <Field label="Issuer URL" required hint="For Entra: https://login.microsoftonline.com/<tenant-id>/v2.0">
        {({ id, describedBy }) => <TextInput id={id} type="url" value={f.issuer} onChange={(e) => setF({ ...f, issuer: e.target.value })} aria-describedby={describedBy} className="font-mono" />}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Client id" required>
          {({ id }) => <TextInput id={id} value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })} className="font-mono" />}
        </Field>
        <Field label="Client secret" hint="Sealed; blank keeps the stored one.">
          {({ id, describedBy }) => <TextInput id={id} type="password" autoComplete="new-password" value={f.clientSecret} onChange={(e) => setF({ ...f, clientSecret: e.target.value })} aria-describedby={describedBy} />}
        </Field>
      </div>
      <Field label="Allowed e-mail domains" hint="Comma-separated. Accounts from other domains are refused.">
        {({ id, describedBy }) => <TextInput id={id} value={f.allowedEmailDomains} onChange={(e) => setF({ ...f, allowedEmailDomains: e.target.value })} aria-describedby={describedBy} placeholder="university.edu, students.university.edu" />}
      </Field>
      <Checkbox label="Enabled" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />
      {error ? (
        <p className="text-stop text-sm" role="alert">
          {error}
        </p>
      ) : null}
      <div>
        <Button type="submit" variant="primary" loading={busy}>
          Save single sign-on
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- api keys
interface CreatedKey {
  id: string;
  keyId: string;
  apiKey: string;
  label: string;
}
function ApiKeys() {
  const { toast } = useToast();
  const [label, setLabel] = useState('');
  const [scopes, setScopes] = useState<Set<string>>(new Set(['roster:write', 'roster:read']));
  const [env, setEnv] = useState<'live' | 'test'>('live');
  const [expiresAt, setExpiresAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreatedKey[]>([]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!label.trim() || scopes.size === 0) return;
    setBusy(true);
    try {
      const out = await api.post<{ id: string; keyId: string; apiKey: string }>('/tenant/api-keys', { label: label.trim(), scopes: [...scopes], env, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined });
      setCreated((c) => [{ ...out, label: label.trim() }, ...c]);
      setLabel('');
      toast({ tone: 'success', title: 'API key created', description: 'Copy it now; it is not shown again.' });
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (id: string) => {
    await api.del(`/tenant/api-keys/${id}`);
    setCreated((c) => c.filter((k) => k.id !== id));
    toast({ tone: 'info', title: 'API key revoked' });
  };
  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <form onSubmit={(e) => void submit(e)} noValidate className="sheet p-6 flex flex-col gap-4">
        <h2 className="text-h3">Create a key</h2>
        <p className="text-sm text-ink-2">For the ERP integration. The key is shown exactly once.</p>
        <Field label="Label" required>
          {({ id }) => <TextInput id={id} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="UOS roster sync" />}
        </Field>
        <fieldset>
          <legend className="text-sm font-medium mb-2">Scopes</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {API_KEY_SCOPES.map((s) => (
              <Checkbox
                key={s}
                label={<span className="font-mono text-sm">{s}</span>}
                checked={scopes.has(s)}
                onChange={(e) => {
                  const n = new Set(scopes);
                  if (e.target.checked) n.add(s);
                  else n.delete(s);
                  setScopes(n);
                }}
              />
            ))}
          </div>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Environment">
            {({ id }) => (
              <Select id={id} value={env} onChange={(e) => setEnv(e.target.value as 'live' | 'test')}>
                <option value="live">live</option>
                <option value="test">test</option>
              </Select>
            )}
          </Field>
          <Field label="Expires (optional)">
            {({ id }) => <TextInput id={id} type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />}
          </Field>
        </div>
        <div>
          <Button type="submit" variant="primary" loading={busy} disabled={!label.trim() || scopes.size === 0}>
            Create key
          </Button>
        </div>
      </form>
      <section className="flex flex-col gap-3">
        <h2 className="text-h3">Keys created in this session</h2>
        <p className="text-sm text-ink-2">The API does not list existing keys; revoke by id from the audit log if needed.</p>
        {created.length === 0 ? <p className="text-ink-2">None yet.</p> : null}
        {created.map((k) => (
          <SecretCard key={k.id} title={k.label} subtitle={`key id ${k.keyId}`} secret={k.apiKey} onRevoke={() => void revoke(k.id)} />
        ))}
      </section>
    </div>
  );
}

function SecretCard({ title, subtitle, secret, onRevoke }: { title: string; subtitle: string; secret: string; onRevoke?: () => void }) {
  const { toast } = useToast();
  return (
    <div className="sheet p-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-medium">{title}</p>
        <p className="text-sm text-ink-2 font-mono">{subtitle}</p>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <code className="flex-1 min-w-0 break-all font-mono text-sm bg-sheet-2 border border-rule rounded-sm px-2 py-1">{secret}</code>
        <Button
          size="sm"
          leading={<CopyIcon />}
          onClick={() => {
            void navigator.clipboard?.writeText(secret);
            toast({ tone: 'success', title: 'Copied' });
          }}
        >
          Copy
        </Button>
        {onRevoke ? (
          <Button size="sm" variant="danger" onClick={onRevoke}>
            Revoke
          </Button>
        ) : null}
      </div>
      <p className="mt-2 text-xs text-ink-2">Shown once. Store it in the ERP’s secret store now.</p>
    </div>
  );
}

// ---------------------------------------------------------------- webhooks
function Webhooks() {
  const { toast } = useToast();
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [types, setTypes] = useState<Set<string>>(new Set(['result.published']));
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Array<{ id: string; signingSecret: string; url: string }>>([]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!url.trim() || types.size === 0) return;
    setBusy(true);
    try {
      const out = await api.post<{ id: string; signingSecret: string }>('/tenant/webhooks', { url: url.trim(), description: description.trim() || undefined, eventTypes: [...types] }, { quiet: ['VALIDATION'] });
      setCreated((c) => [{ ...out, url: url.trim() }, ...c]);
      setUrl('');
      toast({ tone: 'success', title: 'Webhook created', description: 'Copy the signing secret now; it is not shown again.' });
    } catch (err) {
      if (isApiError(err)) toast({ tone: 'warning', title: 'Webhook not created', description: err.problem.errors?.map((x) => x.message).join('; ') ?? err.problem.title });
    } finally {
      setBusy(false);
    }
  };
  const disable = async (id: string) => {
    await api.del(`/tenant/webhooks/${id}`);
    setCreated((c) => c.filter((w) => w.id !== id));
    toast({ tone: 'info', title: 'Webhook disabled' });
  };
  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <form onSubmit={(e) => void submit(e)} noValidate className="sheet p-6 flex flex-col gap-4">
        <h2 className="text-h3">Add an endpoint</h2>
        <p className="text-sm text-ink-2">Signed events are delivered to the ERP over HTTPS, with retries. The signature header is t=&lt;unix&gt;,v1=&lt;HMAC-SHA256&gt;.</p>
        <Field label="URL" required>
          {({ id }) => <TextInput id={id} type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://erp.university.edu/examos/events" className="font-mono" />}
        </Field>
        <Field label="Description">
          {({ id }) => <TextInput id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
        <fieldset>
          <legend className="text-sm font-medium mb-2">Events</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {WEBHOOK_EVENT_TYPES.map((t) => (
              <Checkbox
                key={t}
                label={<span className="font-mono text-sm">{t}</span>}
                checked={types.has(t)}
                onChange={(e) => {
                  const n = new Set(types);
                  if (e.target.checked) n.add(t);
                  else n.delete(t);
                  setTypes(n);
                }}
              />
            ))}
          </div>
        </fieldset>
        <div>
          <Button type="submit" variant="primary" loading={busy} disabled={!url.trim() || types.size === 0}>
            Create webhook
          </Button>
        </div>
      </form>
      <section className="flex flex-col gap-3">
        <h2 className="text-h3">Endpoints created in this session</h2>
        {created.length === 0 ? <p className="text-ink-2">None yet.</p> : null}
        {created.map((w) => (
          <SecretCard key={w.id} title={w.url} subtitle={w.id} secret={w.signingSecret} onRevoke={() => void disable(w.id)} />
        ))}
      </section>
    </div>
  );
}

interface Delivery {
  id: string;
  eventType: string;
  status: string;
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  url: string;
}
function Deliveries({ tz }: { tz: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ['tenant', 'deliveries'], queryFn: () => api.get<{ deliveries: Delivery[] }>('/tenant/webhooks/deliveries'), refetchInterval: 15_000 });
  const replay = async (id: string) => {
    await api.post(`/tenant/webhooks/deliveries/${id}/replay`, {});
    toast({ tone: 'info', title: 'Replay queued' });
    void qc.invalidateQueries({ queryKey: ['tenant', 'deliveries'] });
  };
  const tone = (s: string): Tone => (s === 'DELIVERED' ? 'ready' : s === 'DEAD' ? 'stop' : s === 'RETRYING' ? 'fix' : 'neutral');
  if (q.isLoading) return <Skeleton lines={5} />;
  return (
    <Table
      caption="Webhook deliveries"
      columns={[
        { key: 'event', header: 'Event', render: (d) => (
            <div>
              <p className="font-mono text-sm">{d.eventType}</p>
              <p className="text-sm text-ink-2 break-all">{d.url}</p>
            </div>
          ) },
        { key: 'status', header: 'Status', render: (d) => <StatusChip tone={tone(d.status)} icon={false}>{humanize(d.status)}</StatusChip> },
        { key: 'attempts', header: 'Attempts', align: 'right', hideOnMobile: true, render: (d) => <span className="tabular">{d.attempts}</span> },
        { key: 'code', header: 'Last code', hideOnMobile: true, render: (d) => <span className="font-mono">{d.lastStatusCode ?? '—'}</span> },
        { key: 'next', header: 'Next / delivered', hideOnMobile: true, render: (d) => (d.deliveredAt ? formatDateTime(d.deliveredAt, tz) : d.nextAttemptAt ? `next ${formatDateTime(d.nextAttemptAt, tz)}` : '—') },
        { key: 'replay', header: '', align: 'right', render: (d) => (
            <Button size="sm" onClick={() => void replay(d.id)}>
              Replay
            </Button>
          ) },
      ]}
      rows={q.data?.deliveries ?? []}
      rowKey={(d) => d.id}
      empty="No deliveries yet."
    />
  );
}

// ---------------------------------------------------------------- audit
interface AuditEvent {
  id: string;
  seq: number;
  actor_type: string;
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  request_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}
function Audit({ tz }: { tz: string }) {
  const q = useQuery({ queryKey: ['tenant', 'audit'], queryFn: () => api.get<{ events: AuditEvent[] }>('/tenant/audit') });
  const [filter, setFilter] = useState('');
  if (q.isLoading) return <Skeleton lines={6} />;
  const rows = (q.data?.events ?? []).filter((e) => !filter || `${e.action} ${e.entity_type} ${e.entity_id ?? ''} ${e.actor_id ?? ''}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div>
      <Field label="Filter" hideLabel className="max-w-sm mb-4">
        {({ id }) => <TextInput id={id} type="search" placeholder="Action, entity or actor" value={filter} onChange={(e) => setFilter(e.target.value)} />}
      </Field>
      <Table
        caption="Audit log (append-only, hash-chained)"
        dense
        columns={[
          { key: 'seq', header: '#', width: '4rem', render: (e) => <span className="font-mono tabular text-ink-2">{e.seq}</span> },
          { key: 'when', header: 'When', render: (e) => <span className="tabular whitespace-nowrap">{formatDateTime(e.created_at, tz)}</span> },
          { key: 'action', header: 'Action', render: (e) => <span className="font-mono text-sm">{e.action}</span> },
          { key: 'actor', header: 'Actor', hideOnMobile: true, render: (e) => (
              <span className="text-sm">
                {humanize(e.actor_type)} <span className="font-mono text-ink-2">{e.actor_id ? e.actor_id.slice(0, 8) : ''}</span>
              </span>
            ) },
          { key: 'entity', header: 'Entity', hideOnMobile: true, render: (e) => (
              <span className="text-sm">
                {humanize(e.entity_type)} <span className="font-mono text-ink-2">{e.entity_id ? e.entity_id.slice(0, 8) : ''}</span>
              </span>
            ) },
          { key: 'meta', header: 'Details', hideOnMobile: true, render: (e) => <Meta value={e.metadata} /> },
        ]}
        rows={rows}
        rowKey={(e) => e.id}
        empty="No audit events."
      />
    </div>
  );
}

function Meta({ value }: { value: Record<string, unknown> }): ReactNode {
  const s = JSON.stringify(value);
  if (!s || s === '{}') return <span className="text-ink-3">—</span>;
  return <code className="font-mono text-xs text-ink-2 break-all">{s.length > 160 ? `${s.slice(0, 160)}…` : s}</code>;
}

// ---------------------------------------------------------------- Phase 7: ERP connections
interface ErpConnection {
  id: string;
  provider: string;
  label: string;
  base_url: string;
  sync_schedule_cron: string | null;
  status: 'ACTIVE' | 'DISABLED';
  last_sync_at: string | null;
  created_at: string;
}

interface ErpSyncJob {
  id: string;
  entity: string;
  mode: string;
  source: string;
  status: string;
  summary: {
    created?: number;
    updated?: number;
    unchanged?: number;
    rejected?: number;
    identityConflicts?: number;
  };
  started_at: string;
  completed_at: string | null;
}

interface DryRunSummary {
  dryRun: boolean;
  entity: string;
  total: number;
  summary: {
    created: number;
    updated: number;
    unchanged: number;
    rejected: number;
    identityConflicts: number;
  };
  sampleRows: Array<{
    externalId: string;
    outcome: 'CREATED' | 'UPDATED' | 'UNCHANGED' | 'REJECTED' | 'IDENTITY_CONFLICT';
    code?: string;
    message?: string;
  }>;
}

function ErpConnections({ tz }: { tz: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [syncConn, setSyncConn] = useState<ErpConnection | null>(null);
  const [jobsConn, setJobsConn] = useState<ErpConnection | null>(null);

  const [form, setForm] = useState({
    provider: 'uos',
    label: '',
    baseUrl: '',
    credentialSecret: '',
    syncScheduleCron: '',
    mappingJson: '{}',
  });
  const [busy, setBusy] = useState(false);
  const [syncOptions, setSyncOptions] = useState({ entity: 'ALL', mode: 'UPSERT', dryRun: true });
  const [syncing, setSyncing] = useState(false);
  const [dryRunResult, setDryRunResult] = useState<DryRunSummary | null>(null);

  const q = useQuery({
    queryKey: ['tenant', 'erp-connections'],
    queryFn: () => api.get<{ connections: ErpConnection[] }>('/tenant/erp-connections'),
  });

  const jobsQ = useQuery({
    queryKey: ['tenant', 'erp-connections', jobsConn?.id, 'jobs'],
    queryFn: () => api.get<{ jobs: ErpSyncJob[] }>(`/tenant/erp-connections/${jobsConn?.id}/jobs`),
    enabled: Boolean(jobsConn),
  });

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    let mapping = {};
    try {
      if (form.mappingJson.trim()) mapping = JSON.parse(form.mappingJson);
    } catch {
      toast({ tone: 'error', title: 'Invalid JSON', description: 'Mapping must be a valid JSON object.' });
      setBusy(false);
      return;
    }
    try {
      await api.post('/tenant/erp-connections', {
        provider: form.provider,
        label: form.label.trim(),
        baseUrl: form.baseUrl.trim(),
        credentialSecret: form.credentialSecret || undefined,
        syncScheduleCron: form.syncScheduleCron.trim() || null,
        mapping,
      });
      toast({ tone: 'success', title: 'ERP Connection created', description: `${form.label} configured.` });
      setCreateOpen(false);
      setForm({ provider: 'uos', label: '', baseUrl: '', credentialSecret: '', syncScheduleCron: '', mappingJson: '{}' });
      void qc.invalidateQueries({ queryKey: ['tenant', 'erp-connections'] });
    } catch (err) {
      toast({ tone: 'error', title: 'Failed to create connection', description: isApiError(err) ? err.message : 'Error creating connection' });
    } finally {
      setBusy(false);
    }
  };

  const handleRunSync = async (dryRun: boolean) => {
    if (!syncConn) return;
    setSyncing(true);
    try {
      const res = await api.post<DryRunSummary | { dryRun: false; results: Record<string, unknown> }>(
        `/tenant/erp-connections/${syncConn.id}/sync`,
        { entity: syncOptions.entity, mode: syncOptions.mode, dryRun },
      );
      if (res.dryRun) {
        setDryRunResult(res as DryRunSummary);
        toast({ tone: 'info', title: 'Dry run completed', description: `Simulation: ${(res as DryRunSummary).summary.created} to create.` });
      } else {
        toast({ tone: 'success', title: 'ERP Sync completed', description: 'Roster records successfully updated.' });
        setSyncConn(null);
        setDryRunResult(null);
        void qc.invalidateQueries({ queryKey: ['tenant', 'erp-connections'] });
      }
    } catch (err) {
      toast({ tone: 'error', title: 'Sync failed', description: isApiError(err) ? err.message : 'Error executing sync' });
    } finally {
      setSyncing(false);
    }
  };

  const columns: Column<ErpConnection>[] = [
    {
      key: 'label',
      header: 'Connection',
      render: (c) => (
        <div>
          <p className="font-medium text-ink">{c.label}</p>
          <p className="text-xs text-ink-3 truncate max-w-xs">{c.base_url}</p>
        </div>
      ),
    },
    {
      key: 'provider',
      header: 'Provider',
      render: (c) => <Badge>{c.provider.toUpperCase()}</Badge>,
    },
    {
      key: 'status',
      header: 'Status',
      render: (c) => (
        <StatusChip tone={c.status === 'ACTIVE' ? 'ready' : 'neutral'} icon={false}>
          {c.status}
        </StatusChip>
      ),
    },
    {
      key: 'last_sync',
      header: 'Last Synced',
      hideOnMobile: true,
      render: (c) => (c.last_sync_at ? formatDateTime(c.last_sync_at, tz) : 'Never'),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (c) => (
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setJobsConn(c);
            }}
          >
            History
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              setSyncConn(c);
              setDryRunResult(null);
            }}
          >
            Sync
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-medium text-ink">Configured ERP Connections</h3>
          <p className="text-sm text-ink-2">Pull student roster, courses, and department hierarchy directly from campus systems.</p>
        </div>
        <Button variant="primary" onClick={() => setCreateOpen(true)}>
          New connection
        </Button>
      </div>

      {q.isLoading ? (
        <Skeleton lines={4} />
      ) : (
        <Table
          caption="ERP Connections"
          columns={columns}
          rows={q.data?.connections ?? []}
          rowKey={(c) => c.id}
          empty="No ERP connections configured yet."
        />
      )}

      {/* New Connection Dialog */}
      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New ERP connection"
        description="Connect ExamOS to UOS or any student information system via REST API."
      >
        <form onSubmit={(e) => void handleCreate(e)} className="flex flex-col gap-4">
          <Field label="ERP Provider" required>
            {({ id }) => (
              <Select id={id} value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })}>
                <option value="uos">UOS (University Operating System)</option>
                <option value="generic-rest">Generic REST / JSON</option>
                <option value="sap">SAP Campus Management</option>
                <option value="ellucian">Ellucian Banner / Colleague</option>
              </Select>
            )}
          </Field>
          <Field label="Label / Name" required>
            {({ id }) => (
              <TextInput
                id={id}
                required
                placeholder="e.g. Hyderabad Campus UOS"
                value={form.label}
                onChange={(e) => setForm({ ...form, label: e.target.value })}
              />
            )}
          </Field>
          <Field label="Base API URL" required>
            {({ id }) => (
              <TextInput
                id={id}
                type="url"
                required
                placeholder="https://uos.smru.edu.in"
                value={form.baseUrl}
                onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              />
            )}
          </Field>
          <Field label="Credential Secret (Bearer Token or API Key)" hint="Encrypted at rest with AES-256-GCM.">
            {({ id, describedBy }) => (
              <TextInput
                id={id}
                type="password"
                placeholder="Leave blank if unauthenticated"
                value={form.credentialSecret}
                onChange={(e) => setForm({ ...form, credentialSecret: e.target.value })}
                aria-describedby={describedBy}
              />
            )}
          </Field>
          <Field label="Sync Schedule (Cron expression, optional)" hint="e.g. 0 2 * * * for 2 AM daily">
            {({ id, describedBy }) => (
              <TextInput
                id={id}
                placeholder="0 2 * * *"
                value={form.syncScheduleCron}
                onChange={(e) => setForm({ ...form, syncScheduleCron: e.target.value })}
                aria-describedby={describedBy}
              />
            )}
          </Field>
          <Field label="Custom Endpoint & Field Mapping (JSON)" hint="For generic-rest adapters.">
            {({ id, describedBy }) => (
              <TextArea
                id={id}
                rows={3}
                className="font-mono text-xs"
                value={form.mappingJson}
                onChange={(e) => setForm({ ...form, mappingJson: e.target.value })}
                aria-describedby={describedBy}
              />
            )}
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={busy}>
              Create connection
            </Button>
          </div>
        </form>
      </Dialog>

      {/* Sync Execution Dialog */}
      <Dialog
        open={Boolean(syncConn)}
        onClose={() => {
          setSyncConn(null);
          setDryRunResult(null);
        }}
        title={`Sync ${syncConn?.label ?? ''}`}
        description="Pull data from the ERP. Test in Dry-Run mode before making permanent changes."
      >
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Entity to Pull">
              {({ id }) => (
                <Select
                  id={id}
                  value={syncOptions.entity}
                  onChange={(e) => setSyncOptions({ ...syncOptions, entity: e.target.value })}
                >
                  <option value="ALL">All Entities</option>
                  <option value="PERSON">Students & Staff</option>
                  <option value="ACADEMIC_UNIT">Schools & Depts</option>
                  <option value="COURSE">Courses</option>
                  <option value="ENROLLMENT">Enrollments</option>
                </Select>
              )}
            </Field>
            <Field label="Conflict Mode">
              {({ id }) => (
                <Select
                  id={id}
                  value={syncOptions.mode}
                  onChange={(e) => setSyncOptions({ ...syncOptions, mode: e.target.value as 'UPSERT' })}
                >
                  <option value="UPSERT">Upsert (Create & Update)</option>
                  <option value="CREATE_ONLY">Create Only (Skip existing)</option>
                  <option value="UPDATE_ONLY">Update Only (Ignore new)</option>
                </Select>
              )}
            </Field>
          </div>

          {dryRunResult ? (
            <div className="rounded-lg border border-line bg-surface p-4 flex flex-col gap-3">
              <h4 className="text-sm font-semibold text-ink">Dry-Run Preview Result</h4>
              <div className="grid grid-cols-5 gap-2 text-center text-xs">
                <div className="p-2 rounded bg-ready/10 text-ready font-medium">
                  Created: {dryRunResult.summary.created}
                </div>
                <div className="p-2 rounded bg-accent/10 text-accent font-medium">
                  Updated: {dryRunResult.summary.updated}
                </div>
                <div className="p-2 rounded bg-surface-2 text-ink-2 font-medium">
                  Unchanged: {dryRunResult.summary.unchanged}
                </div>
                <div className="p-2 rounded bg-stop/10 text-stop font-medium">
                  Conflicts: {dryRunResult.summary.identityConflicts}
                </div>
                <div className="p-2 rounded bg-stop/10 text-stop font-medium">
                  Rejected: {dryRunResult.summary.rejected}
                </div>
              </div>

              {dryRunResult.sampleRows.length > 0 ? (
                <div className="max-h-40 overflow-y-auto text-xs border border-line rounded">
                  {dryRunResult.sampleRows.slice(0, 10).map((r, idx) => (
                    <div key={idx} className="flex justify-between p-2 border-b border-line last:border-b-0">
                      <span className="font-mono">{r.externalId}</span>
                      <StatusChip
                        tone={
                          r.outcome === 'CREATED'
                            ? 'ready'
                            : r.outcome === 'UPDATED'
                              ? 'accent'
                              : r.outcome === 'IDENTITY_CONFLICT' || r.outcome === 'REJECTED'
                                ? 'stop'
                                : 'neutral'
                        }
                        icon={false}
                      >
                        {r.outcome}
                      </StatusChip>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="secondary"
              onClick={() => {
                setSyncConn(null);
                setDryRunResult(null);
              }}
            >
              Close
            </Button>
            <Button variant="secondary" onClick={() => void handleRunSync(true)} loading={syncing}>
              Dry run (preview)
            </Button>
            <Button variant="primary" onClick={() => void handleRunSync(false)} loading={syncing}>
              Execute live sync
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Sync Jobs History Dialog */}
      <Dialog
        open={Boolean(jobsConn)}
        onClose={() => setJobsConn(null)}
        title={`Sync History: ${jobsConn?.label ?? ''}`}
        description="Audit trail of previous sync executions."
      >
        <div className="max-h-96 overflow-y-auto">
          {jobsQ.isLoading ? (
            <Skeleton lines={4} />
          ) : (
            <Table
              caption="Sync history"
              dense
              columns={[
                { key: 'entity', header: 'Entity', render: (j) => <Badge>{j.entity}</Badge> },
                {
                  key: 'status',
                  header: 'Status',
                  render: (j) => (
                    <StatusChip tone={j.status === 'COMPLETED' ? 'ready' : j.status === 'RUNNING' ? 'accent' : 'stop'} icon={false}>
                      {j.status}
                    </StatusChip>
                  ),
                },
                {
                  key: 'summary',
                  header: 'Outcomes',
                  render: (j) => (
                    <span className="text-xs font-mono">
                      +{j.summary?.created ?? 0} / ~{j.summary?.updated ?? 0} / !{j.summary?.identityConflicts ?? 0}
                    </span>
                  ),
                },
                { key: 'when', header: 'Started', render: (j) => formatDateTime(j.started_at, tz) },
              ]}
              rows={jobsQ.data?.jobs ?? []}
              rowKey={(j) => j.id}
              empty="No past sync jobs found."
            />
          )}
        </div>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------- Phase 7: Roster import (XLSX / CSV)
function RosterImport() {
  const { toast } = useToast();
  const [entity, setEntity] = useState<'PERSON' | 'ACADEMIC_UNIT' | 'COURSE' | 'ENROLLMENT'>('PERSON');
  const [mode, setMode] = useState<'UPSERT' | 'CREATE_ONLY' | 'UPDATE_ONLY'>('UPSERT');
  const [csvContent, setCsvContent] = useState('');
  const [provider, setProvider] = useState('xlsx');
  const [previewResult, setPreviewResult] = useState<DryRunSummary | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [importing, setImporting] = useState(false);

  const handleDownloadTemplate = () => {
    window.open(`/api/v1/tenant/roster/templates/${entity}`, '_blank');
  };

  const handlePreview = async () => {
    if (!csvContent.trim()) {
      toast({ tone: 'error', title: 'CSV required', description: 'Please paste or upload CSV data first.' });
      return;
    }
    setPreviewing(true);
    try {
      const res = await api.post<DryRunSummary>('/tenant/roster/preview', {
        entity,
        mode,
        csvContent,
        provider,
      });
      setPreviewResult(res);
      toast({ tone: 'info', title: 'Preview generated', description: `Analyzed ${res.total} rows.` });
    } catch (err) {
      toast({ tone: 'error', title: 'Preview failed', description: isApiError(err) ? err.message : 'Error validating CSV' });
    } finally {
      setPreviewing(false);
    }
  };

  const handleExecuteImport = async () => {
    if (!csvContent.trim()) return;
    setImporting(true);
    try {
      const res = await api.post<{ syncJobId: string; summary: { created: number; updated: number; identityConflicts: number; rejected: number } }>(
        '/tenant/roster/import',
        { entity, mode, csvContent, provider },
      );
      toast({
        tone: 'success',
        title: 'Import completed',
        description: `Created: ${res.summary.created}, Updated: ${res.summary.updated}, Conflicts: ${res.summary.identityConflicts}`,
      });
      setPreviewResult(null);
      setCsvContent('');
    } catch (err) {
      toast({ tone: 'error', title: 'Import failed', description: isApiError(err) ? err.message : 'Error executing import' });
    } finally {
      setImporting(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      setCsvContent(text ?? '');
      setPreviewResult(null);
    };
    reader.readAsText(file);
  };

  return (
    <div className="max-w-4xl flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h3 className="text-base font-medium text-ink">Spreadsheet & CSV Roster Import</h3>
          <p className="text-sm text-ink-2">Upload student admissions, departments, or course registrations with identity conflict protection.</p>
        </div>
        <Button variant="secondary" onClick={handleDownloadTemplate}>
          Download {entity} template
        </Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Field label="Roster Entity" required>
          {({ id }) => (
            <Select
              id={id}
              value={entity}
              onChange={(e) => {
                setEntity(e.target.value as typeof entity);
                setPreviewResult(null);
              }}
            >
              <option value="PERSON">Students & Staff</option>
              <option value="ACADEMIC_UNIT">Schools & Departments</option>
              <option value="COURSE">Courses</option>
              <option value="ENROLLMENT">Course Enrollments</option>
            </Select>
          )}
        </Field>

        <Field label="Conflict Resolution Mode">
          {({ id }) => (
            <Select
              id={id}
              value={mode}
              onChange={(e) => {
                setMode(e.target.value as typeof mode);
                setPreviewResult(null);
              }}
            >
              <option value="UPSERT">Upsert (Create & Update)</option>
              <option value="CREATE_ONLY">Create Only (Skip existing)</option>
              <option value="UPDATE_ONLY">Update Only (Ignore new)</option>
            </Select>
          )}
        </Field>

        <Field label="Identity Provider Code" hint="Identifier namespace for external IDs">
          {({ id, describedBy }) => (
            <TextInput
              id={id}
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              aria-describedby={describedBy}
            />
          )}
        </Field>
      </div>

      <Field label="Upload CSV / Spreadsheet" hint="Upload .csv file or paste raw CSV text below.">
        {({ id, describedBy }) => (
          <div className="flex flex-col gap-2">
            <input
              id={id}
              type="file"
              accept=".csv,.txt"
              onChange={handleFileUpload}
              className="text-sm text-ink file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-primary file:text-surface hover:file:opacity-90"
              aria-describedby={describedBy}
            />
            <TextArea
              rows={6}
              className="font-mono text-xs mt-2"
              placeholder="Or paste CSV rows directly here..."
              value={csvContent}
              onChange={(e) => {
                setCsvContent(e.target.value);
                setPreviewResult(null);
              }}
            />
          </div>
        )}
      </Field>

      <div className="flex gap-3">
        <Button variant="secondary" onClick={() => void handlePreview()} loading={previewing} disabled={!csvContent.trim()}>
          Preview import
        </Button>
        <Button variant="primary" onClick={() => void handleExecuteImport()} loading={importing} disabled={!csvContent.trim()}>
          Execute import
        </Button>
      </div>

      {/* Preview Inspection Box */}
      {previewResult ? (
        <div className="rounded-lg border border-line bg-surface p-5 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-ink">Import Preview Summary ({previewResult.total} Rows)</h4>
            {previewResult.summary.identityConflicts > 0 ? (
              <Badge tone="stop">{previewResult.summary.identityConflicts} Identity Conflicts Detected</Badge>
            ) : null}
          </div>

          <div className="grid grid-cols-5 gap-3 text-center text-xs">
            <div className="p-3 rounded-md bg-ready/10 text-ready font-semibold">
              <span className="block text-lg font-bold">{previewResult.summary.created}</span>
              To Create
            </div>
            <div className="p-3 rounded-md bg-accent/10 text-accent font-semibold">
              <span className="block text-lg font-bold">{previewResult.summary.updated}</span>
              To Update
            </div>
            <div className="p-3 rounded-md bg-surface-2 text-ink-2 font-semibold">
              <span className="block text-lg font-bold">{previewResult.summary.unchanged}</span>
              Unchanged
            </div>
            <div className="p-3 rounded-md bg-stop/10 text-stop font-semibold">
              <span className="block text-lg font-bold">{previewResult.summary.identityConflicts}</span>
              Conflicts
            </div>
            <div className="p-3 rounded-md bg-stop/10 text-stop font-semibold">
              <span className="block text-lg font-bold">{previewResult.summary.rejected}</span>
              Rejected
            </div>
          </div>

          {previewResult.sampleRows.length > 0 ? (
            <div className="mt-2 border border-line rounded-md overflow-hidden">
              <div className="bg-surface-2 px-3 py-2 text-xs font-semibold text-ink-2 border-b border-line">
                Sample Validated Rows
              </div>
              <div className="max-h-60 overflow-y-auto divide-y divide-line">
                {previewResult.sampleRows.map((r, i) => (
                  <div key={i} className="p-2.5 flex items-center justify-between text-xs">
                    <div>
                      <span className="font-mono font-medium text-ink">{r.externalId}</span>
                      {r.message ? <p className="text-stop mt-0.5">{r.message}</p> : null}
                    </div>
                    <StatusChip
                      tone={
                        r.outcome === 'CREATED'
                          ? 'ready'
                          : r.outcome === 'UPDATED'
                            ? 'accent'
                            : r.outcome === 'IDENTITY_CONFLICT' || r.outcome === 'REJECTED'
                              ? 'stop'
                              : 'neutral'
                      }
                      icon={false}
                    >
                      {r.outcome}
                    </StatusChip>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
