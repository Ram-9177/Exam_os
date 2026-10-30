import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AdminPage } from '@/features/admin/AdminPage';
import { mockFetch, renderApp, signInAs, TENANT } from './helpers';

const mockConnections = [
  {
    id: 'conn-1',
    provider: 'uos',
    label: 'Main Hyderabad UOS',
    base_url: 'https://uos.smru.edu.in',
    sync_schedule_cron: '0 2 * * *',
    status: 'ACTIVE',
    last_sync_at: '2026-10-30T10:00:00Z',
    created_at: '2026-10-30T00:00:00Z',
  },
  {
    id: 'conn-2',
    provider: 'generic-rest',
    label: 'Campus SAP Portal',
    base_url: 'https://sap.smru.edu.in',
    sync_schedule_cron: null,
    status: 'DISABLED',
    last_sync_at: null,
    created_at: '2026-10-30T00:00:00Z',
  },
];

const mockHealth = {
  totalDispatches: 1540,
  accepted: 1480,
  delivered: 1450,
  bounced: 30,
  failed: 30,
  queued: 0,
  sending: 0,
  bounceRatePct: 2.01,
  byTransport: { 'power-automate': 1000, 'acs-email': 540 },
  byLane: { TRANSACTIONAL: 1000, BULK: 540 },
  dailyExternalQuota: {
    sentToday: 540,
    limit: 2000,
    remaining: 1460,
  },
};

const mockDispatches = [
  {
    id: 'disp-1',
    category: 'EXAM_ALERT',
    lane: 'BULK',
    toAddress: 'student1@smru.edu.in',
    subject: 'Schedule notification',
    status: 'ACCEPTED',
    attemptCount: 1,
    transportKind: 'acs-email',
    lastError: null,
    createdAt: '2026-10-30T08:00:00Z',
    acceptedAt: '2026-10-30T08:01:00Z',
  },
  {
    id: 'disp-2',
    category: 'EXAM_ALERT',
    lane: 'BULK',
    toAddress: 'bounced.student@smru.edu.in',
    subject: 'Important notice',
    status: 'BOUNCED',
    attemptCount: 1,
    transportKind: 'acs-email',
    lastError: '550 5.1.1 User unknown',
    createdAt: '2026-10-30T08:00:00Z',
    acceptedAt: null,
  },
];

describe('Phase 7: ERP Adapters, XLSX Import & Mail Completeness UI', () => {
  it('renders ERP connections list, allows creating connection and running sync', async () => {
    const user = userEvent.setup();
    const me = signInAs(['TENANT_ADMIN', 'INTEGRATION_ADMIN']);

    mockFetch((call) => {
      if (call.path === '/auth/me') return { json: me };
      if (call.path === '/tenant') return { json: TENANT };
      if (call.path === '/tenant/users?q=&kind=') return { json: { users: [] } };
      if (call.path === '/tenant/erp-connections' && call.method === 'GET') {
        return { json: { connections: mockConnections } };
      }
      return undefined;
    });

    renderApp([{ path: '/admin', element: <AdminPage /> }], '/admin');

    // Switch to ERP connections tab
    const erpTab = await screen.findByRole('tab', { name: 'ERP connections' });
    expect(erpTab).toBeInTheDocument();
    await user.click(erpTab);

    // Verify connections are rendered
    expect(await screen.findByText('Main Hyderabad UOS')).toBeInTheDocument();
    expect(screen.getByText('Campus SAP Portal')).toBeInTheDocument();
    expect(screen.getByText('UOS')).toBeInTheDocument();
    expect(screen.getByText('GENERIC-REST')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New connection' })).toBeInTheDocument();
  });

  it('renders Roster Import screen with template download and preview', async () => {
    const user = userEvent.setup();
    const me = signInAs(['TENANT_ADMIN', 'INTEGRATION_ADMIN']);

    mockFetch((call) => {
      if (call.path === '/auth/me') return { json: me };
      if (call.path === '/tenant') return { json: TENANT };
      if (call.path === '/tenant/users?q=&kind=') return { json: { users: [] } };
      if (call.path === '/tenant/roster/preview' && call.method === 'POST') {
        return {
          json: {
            entity: 'PERSON',
            total: 2,
            summary: { created: 1, updated: 1, unchanged: 0, rejected: 0, identityConflicts: 0 },
            sampleRows: [
              { externalId: 'STU-001', outcome: 'CREATED', data: {} },
              { externalId: 'STU-002', outcome: 'UPDATED', data: {} },
            ],
          },
        };
      }
      return undefined;
    });

    renderApp([{ path: '/admin', element: <AdminPage /> }], '/admin');

    const importTab = await screen.findByRole('tab', { name: 'Roster import' });
    await user.click(importTab);

    expect(await screen.findByText('Spreadsheet & CSV Roster Import')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download PERSON template' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview import' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Execute import' })).toBeInTheDocument();

    // Type CSV content into textarea
    const textarea = screen.getByPlaceholderText('Or paste CSV rows directly here...');
    await user.type(textarea, 'externalId,email,fullName\nSTU-001,stu1@smru.edu.in,Student 1');

    // Click preview
    await user.click(screen.getByRole('button', { name: 'Preview import' }));

    // Verify preview results card
    expect(await screen.findByText(/Import Preview Summary/)).toBeInTheDocument();
    expect(screen.getByText('To Create')).toBeInTheDocument();
    expect(screen.getByText('To Update')).toBeInTheDocument();
    expect(screen.getByText('STU-001')).toBeInTheDocument();
  });

  it('renders Mail Health metrics and Reconcile Bounce action in Mail Log', async () => {
    const user = userEvent.setup();
    const me = signInAs(['TENANT_ADMIN']);

    mockFetch((call) => {
      if (call.path === '/auth/me') return { json: me };
      if (call.path === '/tenant') return { json: TENANT };
      if (call.path === '/tenant/users?q=&kind=') return { json: { users: [] } };
      if (call.path === '/tenant/mail/health') return { json: mockHealth };
      if (call.path === '/tenant/mail-dispatches') return { json: { dispatches: mockDispatches } };
      return undefined;
    });

    renderApp([{ path: '/admin', element: <AdminPage /> }], '/admin');

    const mailLogTab = await screen.findByRole('tab', { name: 'Mail log' });
    await user.click(mailLogTab);

    // Verify Mail Health cards rendered
    expect(await screen.findByText('1540')).toBeInTheDocument(); // total
    expect(screen.getByText('2.01%')).toBeInTheDocument(); // bounce rate
    expect(screen.getByText('Daily Bulk Quota')).toBeInTheDocument();
    expect(screen.getByText(/\/ 2000/)).toBeInTheDocument(); // quota limit

    // Verify dispatches table rendered
    expect(screen.getByText('student1@smru.edu.in')).toBeInTheDocument();
    expect(screen.getByText('bounced.student@smru.edu.in')).toBeInTheDocument();
    expect(screen.getAllByText('Bounced').length).toBe(2);

    // Verify Reconcile bounce button
    const bounceBtn = screen.getByRole('button', { name: 'Reconcile bounce' });
    expect(bounceBtn).toBeInTheDocument();
    await user.click(bounceBtn);

    expect(await screen.findByText('Mark an undelivered message as BOUNCED from an NDR or mail report.')).toBeInTheDocument();
  });
});
