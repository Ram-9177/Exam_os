import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReadinessBoard } from '@/features/examcell/ReadinessBoard';
import { mockFetch, renderApp, signInAs, TENANT } from './helpers';

const EXAM = 'e1';
const board = {
  exam: { id: EXAM, code: 'CS301-MID1', title: 'Operating Systems — Mid 1', status: 'PRECHECK', securityProfile: 'BASIC_BROWSER', startedAt: null, precheckOpenedAt: '2026-10-29T20:30:00.000Z' },
  summary: { total: 3, ready: 1, needsFix: 1, needsReview: 0, notStarted: 1, active: 0, suspended: 0, submitted: 0 },
  candidates: [
    {
      attemptId: 'a-ready',
      status: 'READY',
      suspensionKind: null,
      fullName: 'Asha Rao',
      email: 'asha@demo.local',
      registerNumber: 'REG-001',
      hallTicket: 'CS301-MID1-0001',
      precheck: { runId: 'r1', status: 'READY', clientBuild: 'Chrome/131 Windows NT 10.0', startedAt: '2026-10-29T20:35:00.000Z', readyUntil: '2026-10-29T21:20:00.000Z' },
      checks: [
        { code: 'IDENTITY_SESSION', status: 'PASS', source: 'SERVER', diagnosticCode: null, remediationCode: null, instruction: 'Ready', securityRelevant: true },
        { code: 'KEYBOARD_INPUT', status: 'PASS', source: 'PRACTICE', diagnosticCode: null, remediationCode: null, instruction: 'Ready', securityRelevant: false },
      ],
      blocking: [],
      exceptions: [],
    },
    {
      attemptId: 'a-fix',
      status: 'PRECHECK_RUNNING',
      suspensionKind: null,
      fullName: 'Bala Krishnan',
      email: 'bala@demo.local',
      registerNumber: 'REG-002',
      hallTicket: 'CS301-MID1-0002',
      precheck: { runId: 'r2', status: 'REMEDIATE', clientBuild: null, startedAt: '2026-10-29T20:36:00.000Z', readyUntil: null },
      checks: [
        { code: 'IDENTITY_SESSION', status: 'PASS', source: 'SERVER', diagnosticCode: null, remediationCode: null, instruction: 'Ready', securityRelevant: true },
        { code: 'CLOCK_SYNC', status: 'REMEDIATE', source: 'SERVER', diagnosticCode: 'CLOCK_SKEW', remediationCode: 'ENABLE_AUTOMATIC_TIME', instruction: 'Your laptop clock is off. Enable automatic time in system settings and retry. [ENABLE_AUTOMATIC_TIME]', securityRelevant: false },
        { code: 'CLIENT_VERSION', status: 'UNVERIFIABLE', source: 'SERVER', diagnosticCode: 'NO_CLIENT_POLICY', remediationCode: null, instruction: 'Open the exam in the approved exam client. (This check cannot be verified on your device; the Examination Section may approve an exception.)', securityRelevant: true },
      ],
      blocking: ['CLOCK_SYNC', 'CLIENT_VERSION'],
      exceptions: [],
    },
    { attemptId: 'a-new', status: 'PRECHECK_AVAILABLE', suspensionKind: null, fullName: 'Chitra Devi', email: 'chitra@demo.local', registerNumber: 'REG-003', hallTicket: null, precheck: null, checks: [], blocking: [], exceptions: [] },
  ],
};

describe('Readiness Board', () => {
  it('shows summary chips, per-check chips, the student-facing instruction, and surfaces SECURITY_OVERRIDE_REQUIRED plainly', async () => {
    const me = signInAs(['EXAM_CELL_OPERATOR']);
    const { calls } = mockFetch(({ method, path, body }) => {
      if (method === 'GET' && path === '/auth/me') return { json: me };
      if (method === 'GET' && path === '/tenant') return { json: TENANT };
      if (method === 'GET' && path === `/exams/${EXAM}/readiness`) return { json: board };
      if (method === 'POST' && path === `/exams/${EXAM}/attempts/a-fix/admission-exceptions`) {
        const b = body as { coversChecks: string[] };
        if (b.coversChecks.includes('CLIENT_VERSION')) return { status: 403, json: { type: 'x', title: 'Only a Controller-level approver may waive identity, eligibility, client or consent checks', status: 403, code: 'SECURITY_OVERRIDE_REQUIRED', requestId: 't' } };
        return { status: 201, json: { exceptionId: 'x1' } };
      }
      return undefined;
    });
    renderApp([{ path: '/x', element: <ReadinessBoard examId={EXAM} tz="Asia/Kolkata" active /> }], '/x');

    const table = await screen.findByRole('table', { name: 'Readiness board' });
    const chipWithText = (text: string) => screen.getAllByText((_, el) => el?.tagName === 'SPAN' && el.textContent?.replace(/\s+/g, ' ').trim() === text);
    expect(chipWithText('3 Total')).toHaveLength(1);
    expect(chipWithText('1 Ready')).toHaveLength(1);
    expect(chipWithText('1 Needs fix')).toHaveLength(1);
    expect(chipWithText('1 Not started')).toHaveLength(1);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);

    // Per-check chips carry text (not colour alone) and the instruction the student sees.
    const bala = rows[1]!;
    expect(within(bala).getByText(/Clock !/)).toBeInTheDocument();
    expect(within(bala).getByText(/Client \?/)).toBeInTheDocument();
    expect(within(bala).getByText(/Your laptop clock is off/)).toBeInTheDocument();
    expect(within(bala).getByText('security')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Ready')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Not started')).toBeInTheDocument();

    // Approve exception: blocking checks preselected; a security check without Controller rights → plain 403 message.
    const user = userEvent.setup();
    await user.click(within(bala).getByRole('button', { name: 'Approve exception' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAccessibleName(/Approve an exception for Bala Krishnan/);
    expect(within(dialog).getByRole('checkbox', { name: /Device clock/ })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: /Exam client/ })).toBeChecked();
    await user.type(within(dialog).getByLabelText(/Reason/), 'Loaner laptop issued at the desk');
    await user.click(within(dialog).getByRole('button', { name: 'Approve exception' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Only a Controller-level approver may waive');
    expect(within(dialog).getByRole('alert')).toHaveTextContent('SECURITY_OVERRIDE_REQUIRED');

    // Without the security check it succeeds and the dialog closes.
    await user.click(within(dialog).getByRole('checkbox', { name: /Exam client/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Approve exception' }));
    await screen.findByRole('status', {}, { timeout: 2000 }).catch(() => undefined);
    const posts = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/admission-exceptions'));
    expect(posts).toHaveLength(2);
    expect(posts[1]?.body).toMatchObject({ exceptionCode: 'TECH_ALT_DEVICE', coversChecks: ['CLOCK_SYNC'], reason: 'Loaner laptop issued at the desk', expiresInMinutes: 120 });
  });
});
