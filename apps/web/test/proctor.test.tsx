import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProctorPage } from '@/features/proctor/ProctorPage';
import { mockFetch, renderApp, signInAs, TENANT } from './helpers';

const exam = { id: 'e1', code: 'CS301-MID1', title: 'Operating Systems — Mid 1', status: 'LIVE', examType: 'MID_1', academicYear: '2026-27', semester: 5, securityProfile: 'BASIC_BROWSER', durationMinutes: 60, windowStartAt: '2026-10-30T04:00:00.000Z', windowEndAt: '2026-10-30T10:00:00.000Z', courseCode: 'CS301', courseName: 'Operating Systems', departmentCode: 'CSE' };
const incident = { id: 'i1', attempt_id: 'a1', exam_id: 'e1', signal_class: 'NETWORK_ADDRESS_CHANGED', status: 'PROCTOR_REVIEW', first_event_at: '2026-10-30T05:00:00.000Z', last_event_at: '2026-10-30T05:02:00.000Z', event_count: 2, priority: 60, attemptStatus: 'ACTIVE', userId: 'u9', studentName: 'Asha Rao', currentWarnings: 0, epochNo: 1 };
const timeline = {
  attempt: { id: 'a1', status: 'ACTIVE', deadline_at: '2026-10-30T06:00:00.000Z', exam_id: 'e1' },
  events: [{ seq: 1, event_type: 'attempt.admitted', actor: 'USER:u9', server_received_at: '2026-10-30T04:58:00.000Z', metadata: {} }],
  warnings: [],
  epochs: [{ epoch_no: 1, confirmed_count: 0, closed_at: null, reason: 'admission' }],
  network: [
    { ip: '10.10.1.20', user_agent: 'Chrome/130 Windows', first_seen_at: '2026-10-30T04:40:00.000Z', last_seen_at: '2026-10-30T05:00:00.000Z', observations: 14, first_source: 'PRECHECK', in_allowed_subnet: true },
    { ip: '10.10.9.9', user_agent: 'Chrome/130 Windows', first_seen_at: '2026-10-30T05:02:00.000Z', last_seen_at: '2026-10-30T05:02:00.000Z', observations: 1, first_source: 'HEARTBEAT', in_allowed_subnet: false },
  ],
  deviceScans: [
    { id: 's1', phase: 'PRECHECK', verdict: 'CLEAN', findings: [], ip: '10.10.1.20', created_at: '2026-10-30T04:41:00.000Z' },
    { id: 's2', phase: 'IN_EXAM', verdict: 'BLOCKED', findings: ['MULTIPLE_DISPLAYS'], ip: '10.10.9.9', created_at: '2026-10-30T05:03:00.000Z' },
  ],
};

function setup() {
  const me = signInAs(['CHIEF_PROCTOR']);
  mockFetch(({ method, path }) => {
    if (method === 'GET' && path === '/auth/me') return { json: me };
    if (method === 'GET' && path === '/tenant') return { json: TENANT };
    if (method === 'GET' && path.startsWith('/exams/e1')) return { json: { exam: { ...exam, warning_threshold: 5 }, attemptCounts: {} } };
    if (method === 'GET' && path.startsWith('/exams')) return { json: { exams: [exam] } };
    if (method === 'GET' && path.startsWith('/proctor/incidents')) return { json: { incidents: [incident] } };
    if (method === 'GET' && path === '/proctor/attempts/a1/timeline') return { json: timeline };
    return undefined;
  });
}

describe('Proctor console', () => {
  it('queues incidents as context for a person and shows every address and device scan on the timeline', async () => {
    setup();
    renderApp([{ path: '/proctor', element: <ProctorPage /> }], '/proctor');
    const user = userEvent.setup();

    expect(await screen.findByText('Network address changed')).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getByText('Asha Rao')).toBeInTheDocument();
    expect(within(table).getByText('Needs decision')).toBeInTheDocument();
    expect(within(table).getByText(/2 events/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing here counts against a student until a person confirms it/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAccessibleName('Network address changed');
    await user.click(within(dialog).getByRole('button', { name: 'Timeline' }));

    expect(await within(dialog).findByRole('heading', { name: 'Network addresses' })).toBeInTheDocument();
    const addresses = within(dialog).getByRole('list', { name: 'Network addresses seen' });
    expect(within(addresses).getByText('10.10.1.20')).toBeInTheDocument();
    expect(within(addresses).getByText('10.10.9.9')).toBeInTheDocument();
    expect(within(addresses).getByText('Outside lab network')).toBeInTheDocument();
    expect(within(addresses).getByText(/14 requests/)).toBeInTheDocument();

    expect(within(dialog).getByRole('heading', { name: 'Device scans' })).toBeInTheDocument();
    const scans = within(dialog).getByRole('list', { name: 'Device scans' });
    expect(within(scans).getByText('Clean')).toBeInTheDocument();
    expect(within(scans).getByText('Blocked')).toBeInTheDocument();
    expect(within(scans).getByText('Multiple displays')).toBeInTheDocument();
    expect(within(scans).getByText('No findings')).toBeInTheDocument();
    expect(within(dialog).getByText(/A clean scan is context, never proof/)).toBeInTheDocument();

    expect(document.body.textContent).not.toMatch(/cheat/i);
  });
});
