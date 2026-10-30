import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminPage } from '@/features/admin/AdminPage';
import { mockFetch, renderApp, signInAs, TENANT, type MockCall, type MockHandler } from './helpers';

/*
 * Tenant administration screen. Every fixture below has the shape the API
 * handler in apps/api/src/modules/tenants/routes.ts actually returns (column
 * aliases included), and every action asserts the exact request body sent.
 * Secrets (API keys, webhook signing secrets, mail/SSO secrets) are shown at
 * most once and never re-displayed.
 */

// GET /tenant/users → { users: [{ id, email, fullName, kind, status, registerNumber, createdAt }] }
const users = [
  { id: '6f1c2b0e-0000-4000-8000-000000000001', email: 'asha.rao@smru.edu.in', fullName: 'Asha Rao', kind: 'STUDENT', status: 'ACTIVE', registerNumber: '22CS1001', createdAt: '2026-10-01T04:30:00.000Z' },
  { id: '6f1c2b0e-0000-4000-8000-000000000002', email: 'examcell@smru.edu.in', fullName: 'Kiran Examcell', kind: 'STAFF', status: 'PENDING_ACTIVATION', registerNumber: null, createdAt: '2026-10-02T04:30:00.000Z' },
];

// GET /tenant/mail/health → getMailHealthMetrics()
const health = {
  totalDispatches: 42,
  accepted: 30,
  delivered: 5,
  bounced: 2,
  failed: 3,
  queued: 1,
  sending: 1,
  bounceRatePct: 5.41,
  byTransport: { 'smtp-relay': 30, 'power-automate': 12 },
  byLane: { TRANSACTIONAL: 20, BULK: 22 },
  dailyExternalQuota: { sentToday: 12, limit: 2000, remaining: 1988 },
};

// GET /tenant/mail-dispatches → { dispatches: [{ id, category, lane, toAddress, subject, status, attemptCount, transportKind, lastError, createdAt, acceptedAt }] }
const dispatches = [
  { id: 'd-1', category: 'ADMISSION_RECEIPT', lane: 'TRANSACTIONAL', toAddress: 'asha.rao@smru.edu.in', subject: 'Admission receipt — OS Mid-1', status: 'ACCEPTED', attemptCount: 1, transportKind: 'smtp-relay', lastError: null, createdAt: '2026-10-30T04:00:00.000Z', acceptedAt: '2026-10-30T04:00:02.000Z' },
  { id: 'd-2', category: 'PREFLIGHT_REMINDER', lane: 'BULK', toAddress: 'nobody@smru.edu.in', subject: 'Readiness check opens at 09:30', status: 'FAILED', attemptCount: 1, transportKind: 'smtp-relay', lastError: '550 5.1.1 Recipient address rejected', createdAt: '2026-10-30T03:00:00.000Z', acceptedAt: null },
];

// GET /tenant/webhooks/deliveries → { deliveries: [{ id, eventType, status, attempts, lastStatusCode, lastError, nextAttemptAt, deliveredAt, url }] }
const deliveries = [
  { id: '0d6c0d5a-0000-4000-8000-0000000000d1', eventType: 'result.published', status: 'DELIVERED', attempts: 1, lastStatusCode: 200, lastError: null, nextAttemptAt: null, deliveredAt: '2026-10-30T05:00:00.000Z', url: 'https://erp.smru.edu.in/examos/events' },
  { id: '0d6c0d5a-0000-4000-8000-0000000000d2', eventType: 'attempt.submitted', status: 'DEAD', attempts: 7, lastStatusCode: 503, lastError: 'HTTP 503', nextAttemptAt: null, deliveredAt: null, url: 'https://erp.smru.edu.in/examos/events' },
];

// GET /tenant/audit → { events: audit_events rows } (seq is a bigserial, so pg returns it as a string)
const auditEvents = [
  { id: 'a-2', seq: '1042', tenant_id: 't1', actor_type: 'USER', actor_id: '6f1c2b0e-0000-4000-8000-000000000009', action: 'tenant.mail_config.upserted', entity_type: 'tenant_mail_config', entity_id: null, request_id: 'req-2', metadata: { transportKind: 'smtp-relay', senderAddress: 'exam@smru.edu.in', category: null }, prev_hash: 'aa', hash: 'bb', created_at: '2026-10-30T05:10:00.000Z' },
  { id: 'a-1', seq: '1041', tenant_id: 't1', actor_type: 'SYSTEM', actor_id: null, action: 'webhook.delivery.replayed', entity_type: 'webhook_delivery', entity_id: '0d6c0d5a-0000-4000-8000-0000000000d2', request_id: null, metadata: {}, prev_hash: null, hash: 'aa', created_at: '2026-10-30T05:00:00.000Z' },
];

const ADMIN_CONTROLLER = ['TENANT_ADMIN', 'CONTROLLER', 'SECURITY_AUDITOR'];

function setup(roles: string[] = ADMIN_CONTROLLER, extra?: MockHandler) {
  const me = signInAs(roles);
  const { calls } = mockFetch((call) => {
    const own = extra?.(call);
    if (own) return own;
    const { method, path } = call;
    if (method === 'GET' && path === '/auth/me') return { json: me };
    if (method === 'GET' && path === '/tenant') return { json: TENANT };
    if (method === 'GET' && path.startsWith('/tenant/users?')) return { json: { users } };
    if (method === 'GET' && path === '/tenant/mail-dispatches') return { json: { dispatches } };
    if (method === 'GET' && path === '/tenant/mail/health') return { json: health };
    if (method === 'GET' && path === '/tenant/webhooks/deliveries') return { json: { deliveries } };
    if (method === 'GET' && path === '/tenant/audit') return { json: { events: auditEvents } };
    return undefined;
  });
  renderApp([{ path: '/admin', element: <AdminPage /> }], '/admin');
  return { calls, user: userEvent.setup() };
}

const sent = (calls: MockCall[], method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const gets = (calls: MockCall[], prefix: string) => calls.filter((c) => c.method === 'GET' && c.path.startsWith(prefix)).length;

describe('Tenant administration', () => {
  it('shows only the sections the signed-in roles allow', async () => {
    // a security auditor holds audit:read but not users:read: the first section it may open is the audit log
    const { calls } = setup(['SECURITY_AUDITOR']);
    expect(await screen.findByRole('tab', { name: 'Audit log' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect(await screen.findByText('tenant.mail_config.upserted')).toBeInTheDocument();
    // the users section it may not open is never rendered, so no request it would be refused is made
    expect(gets(calls, '/tenant/users')).toBe(0);
  });

  it('lists the admin-and-controller sections in order', async () => {
    setup();
    await screen.findByRole('tab', { name: 'Users' });
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Users', 'Mail', 'Mail log', 'ERP connections', 'Roster import', 'Single sign-on', 'API keys', 'Webhooks', 'Deliveries', 'Audit log']);
  });

  it('lists users and creates a staff user with tenant-wide roles and an activation e-mail', async () => {
    const { calls, user } = setup(ADMIN_CONTROLLER, ({ method, path }) => (method === 'POST' && path === '/tenant/users' ? { status: 201, json: { userId: '6f1c2b0e-0000-4000-8000-000000000003', activationDispatchId: '7a7a7a7a-0000-4000-8000-000000000001' } } : undefined));
    const table = await screen.findByRole('table', { name: 'Users' });
    expect(within(table).getByText('Asha Rao')).toBeInTheDocument();
    expect(within(table).getByText('22CS1001')).toBeInTheDocument();
    expect(within(table).getByText('Pending activation')).toBeInTheDocument();
    expect(within(table).getByText('Student')).toBeInTheDocument();

    const before = gets(calls, '/tenant/users?');
    await user.click(screen.getByRole('button', { name: 'Create user' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create user' });
    await user.type(within(dialog).getByLabelText(/^Full name/), '  Meera Iyer ');
    await user.type(within(dialog).getByLabelText(/^E-mail/), 'meera.iyer@smru.edu.in');
    await user.type(within(dialog).getByLabelText('External id'), 'UOS-STAFF-77');
    await user.type(within(dialog).getByLabelText('Provider'), 'uos');
    await user.click(within(dialog).getByLabelText('Exam cell operator'));
    await user.click(within(dialog).getByLabelText('Chief proctor'));
    await user.click(within(dialog).getByRole('button', { name: 'Create user' }));

    await waitFor(() => expect(sent(calls, 'POST', '/tenant/users')).toHaveLength(1));
    expect(sent(calls, 'POST', '/tenant/users')[0]!.body).toEqual({
      email: 'meera.iyer@smru.edu.in',
      fullName: 'Meera Iyer',
      kind: 'STAFF',
      externalId: 'UOS-STAFF-77',
      provider: 'uos',
      roles: [
        { role: 'EXAM_CELL_OPERATOR', scopeType: 'TENANT' },
        { role: 'CHIEF_PROCTOR', scopeType: 'TENANT' },
      ],
      sendActivation: true,
    });
    expect(await screen.findByText('An activation e-mail is queued.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create user' })).not.toBeInTheDocument());
    await waitFor(() => expect(gets(calls, '/tenant/users?')).toBeGreaterThan(before)); // list refreshed
  });

  it('shows the validation errors the API returns and keeps the dialog open', async () => {
    const { calls, user } = setup(ADMIN_CONTROLLER, ({ method, path }) =>
      method === 'POST' && path === '/tenant/users' ? { status: 422, json: { type: 'urn:examos:error:VALIDATION', title: 'Validation failed', status: 422, code: 'VALIDATION', requestId: 'r', retryable: false, errors: [{ path: 'email', message: 'Invalid email address' }] } } : undefined,
    );
    await screen.findByRole('table', { name: 'Users' });
    await user.click(screen.getByRole('button', { name: 'Create user' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create user' });
    await user.type(within(dialog).getByLabelText(/^Full name/), 'No Mail');
    await user.click(within(dialog).getByLabelText('Send an activation e-mail'));
    await user.click(within(dialog).getByRole('button', { name: 'Create user' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('email: Invalid email address');
    expect(sent(calls, 'POST', '/tenant/users')[0]!.body).toMatchObject({ email: '', fullName: 'No Mail', roles: [], sendActivation: false });
    expect(screen.getByRole('dialog', { name: 'Create user' })).toBeInTheDocument();
  });

  it('grants and revokes a tenant-wide role for a user', async () => {
    const id = users[1]!.id;
    const { calls, user } = setup(ADMIN_CONTROLLER, ({ method, path }) => {
      if (method === 'POST' && path === `/tenant/users/${id}/roles`) return { status: 201, json: { grantId: '9b9b9b9b-0000-4000-8000-000000000001' } };
      if (method === 'DELETE' && path === `/tenant/users/${id}/roles`) return { json: { revoked: 1 } };
      return undefined;
    });
    const table = await screen.findByRole('table', { name: 'Users' });
    const row = within(table).getByText('Kiran Examcell').closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Roles' }));
    const dialog = await screen.findByRole('dialog', { name: 'Roles for Kiran Examcell' });
    await user.selectOptions(within(dialog).getByLabelText('Role'), 'EXAM_CELL_OPERATOR');
    await user.click(within(dialog).getByRole('button', { name: 'Grant' }));
    await waitFor(() => expect(sent(calls, 'POST', `/tenant/users/${id}/roles`)).toHaveLength(1));
    expect(sent(calls, 'POST', `/tenant/users/${id}/roles`)[0]!.body).toEqual({ role: 'EXAM_CELL_OPERATOR', scopeType: 'TENANT', scopeId: null });
    expect(await screen.findByText('Exam cell operator granted')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(sent(calls, 'DELETE', `/tenant/users/${id}/roles`)).toHaveLength(1));
    expect(sent(calls, 'DELETE', `/tenant/users/${id}/roles`)[0]!.body).toEqual({ role: 'EXAM_CELL_OPERATOR', scopeType: 'TENANT', scopeId: null });
    expect(await screen.findByText('Exam cell operator revoked')).toBeInTheDocument();
  });

  it('saves the mail transport with sealed secrets and clears the secret fields afterwards', async () => {
    const { calls, user } = setup(ADMIN_CONTROLLER, ({ method, path }) => (method === 'PUT' && path === '/tenant/mail-config' ? { status: 204 } : undefined));
    await user.click(await screen.findByRole('tab', { name: 'Mail' }));
    await user.selectOptions(screen.getByLabelText('Transport'), 'smtp-relay');
    expect(screen.getByText(/A plain SMTP relay inside the campus network/)).toBeInTheDocument();
    await user.type(screen.getByLabelText(/^Sender address/), 'exam@smru.edu.in');
    await user.type(screen.getByLabelText('Token secret'), 'relay-shared-secret-1');
    await user.type(screen.getByLabelText('Category (optional)'), 'ADMISSION_RECEIPT');
    const settings = screen.getByLabelText('Settings (JSON)');

    // invalid JSON is refused in the browser; nothing is sent
    await user.clear(settings);
    await user.click(settings);
    await user.paste('{"host": ');
    await user.click(screen.getByRole('button', { name: 'Save mail configuration' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Settings must be valid JSON.');
    expect(sent(calls, 'PUT', '/tenant/mail-config')).toHaveLength(0);

    await user.clear(settings);
    await user.click(settings);
    await user.paste('{"host":"relay.smru.edu.in","port":25,"requireTls":true}');
    await user.click(screen.getByRole('button', { name: 'Save mail configuration' }));
    await waitFor(() => expect(sent(calls, 'PUT', '/tenant/mail-config')).toHaveLength(1));
    expect(sent(calls, 'PUT', '/tenant/mail-config')[0]!.body).toEqual({
      transportKind: 'smtp-relay',
      senderAddress: 'exam@smru.edu.in',
      senderName: 'Examination Cell',
      tokenSecret: 'relay-shared-secret-1',
      category: 'ADMISSION_RECEIPT',
      settings: { host: 'relay.smru.edu.in', port: 25, requireTls: true },
    });
    expect(await screen.findByText('Secrets were sealed and cannot be read back.')).toBeInTheDocument();
    expect(screen.getByLabelText('Token secret')).toHaveValue('');
    expect(screen.getByLabelText('Endpoint secret')).toHaveValue('');
    expect(screen.getByLabelText('Callback secret')).toHaveValue('');
  });

  it('shows the mail log with delivery health and the provider error of a failed dispatch', async () => {
    const { user } = setup();
    await user.click(await screen.findByRole('tab', { name: 'Mail log' }));
    const table = await screen.findByRole('table', { name: 'Mail dispatches' });
    expect(within(table).getByText('asha.rao@smru.edu.in')).toBeInTheDocument();
    expect(within(table).getByText('Admission receipt — OS Mid-1')).toBeInTheDocument();
    expect(within(table).getByText('Accepted')).toBeInTheDocument();
    expect(within(table).getByText('Failed')).toBeInTheDocument();
    expect(within(table).getByText('550 5.1.1 Recipient address rejected')).toBeInTheDocument();
    expect(within(table).getByText('Preflight reminder')).toBeInTheDocument();
    expect(within(table).getAllByText('smtp-relay')).toHaveLength(2);
    expect(await screen.findByText('5.41%')).toBeInTheDocument();
    expect(screen.getByText('35')).toBeInTheDocument(); // accepted + delivered
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('saves single sign-on with a sealed client secret', async () => {
    const { calls, user } = setup(ADMIN_CONTROLLER, ({ method, path }) => (method === 'PUT' && path === '/tenant/sso-config' ? { status: 204 } : undefined));
    await user.click(await screen.findByRole('tab', { name: 'Single sign-on' }));
    await user.type(screen.getByLabelText(/^Issuer URL/), 'https://login.microsoftonline.com/0000-tenant/v2.0');
    await user.type(screen.getByLabelText(/^Client id/), 'client-abc');
    await user.type(screen.getByLabelText('Client secret'), 'sso-client-secret-xyz');
    await user.type(screen.getByLabelText('Allowed e-mail domains'), 'smru.edu.in, students.smru.edu.in');
    await user.click(screen.getByRole('button', { name: 'Save single sign-on' }));
    await waitFor(() => expect(sent(calls, 'PUT', '/tenant/sso-config')).toHaveLength(1));
    expect(sent(calls, 'PUT', '/tenant/sso-config')[0]!.body).toEqual({
      provider: 'entra',
      issuer: 'https://login.microsoftonline.com/0000-tenant/v2.0',
      clientId: 'client-abc',
      clientSecret: 'sso-client-secret-xyz',
      allowedEmailDomains: ['smru.edu.in', 'students.smru.edu.in'],
      enabled: true,
    });
    expect(await screen.findByText('The sign-in page now offers it.')).toBeInTheDocument();
    expect(screen.getByLabelText('Client secret')).toHaveValue('');
  });

  it('creates an API key, shows its secret exactly once, and revokes it', async () => {
    const plaintext = 'exk_test_k1_3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c';
    const { calls, user } = setup(ADMIN_CONTROLLER, ({ method, path }) => {
      if (method === 'POST' && path === '/tenant/api-keys') return { status: 201, json: { id: '5e5e5e5e-0000-4000-8000-000000000001', keyId: 'k1', apiKey: plaintext, note: 'Store this key now; it is not retrievable later.' } };
      if (method === 'DELETE' && path === '/tenant/api-keys/5e5e5e5e-0000-4000-8000-000000000001') return { status: 204 };
      return undefined;
    });
    await user.click(await screen.findByRole('tab', { name: 'API keys' }));
    const create = screen.getByRole('button', { name: 'Create key' });
    expect(create).toBeDisabled(); // no label yet
    await user.type(screen.getByLabelText(/^Label/), 'UOS roster sync');
    await user.click(screen.getByLabelText('results:read'));
    await user.click(screen.getByLabelText('roster:read')); // untick a default scope
    await user.selectOptions(screen.getByLabelText('Environment'), 'test');
    await user.click(create);

    await waitFor(() => expect(sent(calls, 'POST', '/tenant/api-keys')).toHaveLength(1));
    expect(sent(calls, 'POST', '/tenant/api-keys')[0]!.body).toEqual({ label: 'UOS roster sync', scopes: ['roster:write', 'results:read'], env: 'test' });
    expect(await screen.findByText(plaintext)).toBeInTheDocument();
    expect(screen.getByText('key id k1')).toBeInTheDocument();
    expect(screen.getByText(/Shown once/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Label/)).toHaveValue('');

    // leaving the section drops the plaintext; coming back does not show it again
    await user.click(screen.getByRole('tab', { name: 'Webhooks' }));
    await user.click(screen.getByRole('tab', { name: 'API keys' }));
    expect(screen.queryByText(plaintext)).not.toBeInTheDocument();
    expect(screen.getByText('None yet.')).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'GET' && c.path.startsWith('/tenant/api-keys'))).toHaveLength(0);
  });

  it('revokes a key created in this session', async () => {
    const plaintext = 'exk_live_k2_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const { calls, user } = setup(ADMIN_CONTROLLER, ({ method, path }) => {
      if (method === 'POST' && path === '/tenant/api-keys') return { status: 201, json: { id: '5e5e5e5e-0000-4000-8000-000000000002', keyId: 'k2', apiKey: plaintext, note: '' } };
      if (method === 'DELETE' && path === '/tenant/api-keys/5e5e5e5e-0000-4000-8000-000000000002') return { status: 204 };
      return undefined;
    });
    await user.click(await screen.findByRole('tab', { name: 'API keys' }));
    await user.type(screen.getByLabelText(/^Label/), 'Results pull');
    await user.click(screen.getByRole('button', { name: 'Create key' }));
    expect(await screen.findByText(plaintext)).toBeInTheDocument();
    expect(sent(calls, 'POST', '/tenant/api-keys')[0]!.body).toEqual({ label: 'Results pull', scopes: ['roster:write', 'roster:read'], env: 'live' });
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(sent(calls, 'DELETE', '/tenant/api-keys/5e5e5e5e-0000-4000-8000-000000000002')).toHaveLength(1));
    expect(screen.queryByText(plaintext)).not.toBeInTheDocument();
    expect(await screen.findByText('API key revoked')).toBeInTheDocument();
  });

  it('adds a webhook endpoint and shows the signing secret only once', async () => {
    const secret = 'whsec_0123456789abcdef0123456789abcdef';
    const { calls, user } = setup(ADMIN_CONTROLLER, ({ method, path }) => (method === 'POST' && path === '/tenant/webhooks' ? { status: 201, json: { id: '3c3c3c3c-0000-4000-8000-000000000001', signingSecret: secret, note: 'Store this secret now; it is not retrievable later.' } } : undefined));
    await user.click(await screen.findByRole('tab', { name: 'Webhooks' }));
    expect(screen.getByLabelText('result.published')).toBeChecked();
    await user.type(screen.getByLabelText(/^URL/), 'https://erp.smru.edu.in/examos/events');
    await user.type(screen.getByLabelText('Description'), 'UOS results listener');
    await user.click(screen.getByLabelText('attempt.submitted'));
    await user.click(screen.getByRole('button', { name: 'Create webhook' }));

    await waitFor(() => expect(sent(calls, 'POST', '/tenant/webhooks')).toHaveLength(1));
    expect(sent(calls, 'POST', '/tenant/webhooks')[0]!.body).toEqual({ url: 'https://erp.smru.edu.in/examos/events', description: 'UOS results listener', eventTypes: ['result.published', 'attempt.submitted'] });
    expect(await screen.findByText(secret)).toBeInTheDocument();
    expect(screen.getByText('3c3c3c3c-0000-4000-8000-000000000001')).toBeInTheDocument();
    expect(screen.getByLabelText(/^URL/)).toHaveValue('');

    await user.click(screen.getByRole('tab', { name: 'Deliveries' }));
    await user.click(screen.getByRole('tab', { name: 'Webhooks' }));
    expect(screen.queryByText(secret)).not.toBeInTheDocument();
  });

  it('lists webhook deliveries and replays a dead one', async () => {
    const dead = deliveries[1]!;
    const { calls, user } = setup(ADMIN_CONTROLLER, ({ method, path }) => (method === 'POST' && path === `/tenant/webhooks/deliveries/${dead.id}/replay` ? { status: 202 } : undefined));
    await user.click(await screen.findByRole('tab', { name: 'Deliveries' }));
    const table = await screen.findByRole('table', { name: 'Webhook deliveries' });
    expect(within(table).getByText('result.published')).toBeInTheDocument();
    expect(within(table).getByText('Delivered')).toBeInTheDocument();
    expect(within(table).getByText('Dead')).toBeInTheDocument();
    expect(within(table).getByText('503')).toBeInTheDocument();
    expect(within(table).getByText('7')).toBeInTheDocument();

    const before = gets(calls, '/tenant/webhooks/deliveries');
    const row = within(table).getByText('attempt.submitted').closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Replay' }));
    await waitFor(() => expect(sent(calls, 'POST', `/tenant/webhooks/deliveries/${dead.id}/replay`)).toHaveLength(1));
    expect(sent(calls, 'POST', `/tenant/webhooks/deliveries/${dead.id}/replay`)[0]!.body).toEqual({});
    expect(sent(calls, 'POST', `/tenant/webhooks/deliveries/${deliveries[0]!.id}/replay`)).toHaveLength(0);
    expect(await screen.findByText('Replay queued')).toBeInTheDocument();
    await waitFor(() => expect(gets(calls, '/tenant/webhooks/deliveries')).toBeGreaterThan(before));
  });

  it('shows the append-only audit log and filters it', async () => {
    const { user } = setup();
    await user.click(await screen.findByRole('tab', { name: 'Audit log' }));
    const table = await screen.findByRole('table', { name: 'Audit log (append-only, hash-chained)' });
    expect(within(table).getByText('1042')).toBeInTheDocument();
    expect(within(table).getByText('tenant.mail_config.upserted')).toBeInTheDocument();
    expect(within(table).getByText('webhook.delivery.replayed')).toBeInTheDocument();
    expect(within(table).getByText('6f1c2b0e')).toBeInTheDocument(); // actor id shortened
    expect(within(table).getByText(/"transportKind":"smtp-relay"/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Filter'), 'webhook');
    await waitFor(() => expect(within(table).queryByText('tenant.mail_config.upserted')).not.toBeInTheDocument());
    expect(within(table).getByText('webhook.delivery.replayed')).toBeInTheDocument();
  });
});
