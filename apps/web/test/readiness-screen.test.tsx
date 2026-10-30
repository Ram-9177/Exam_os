import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReadinessPage } from '@/features/readiness/ReadinessPage';
import { KEYBOARD_SAMPLE } from '@/features/readiness/practice';
import { mockFetch, renderApp, signInAs, TENANT } from './helpers';

const ATTEMPT = '4eb9197e-432a-41a7-90d7-f0a1b5d8a3cf';
const RUN = 'run-1';

const policy = {
  attemptId: ATTEMPT,
  attemptStatus: 'PRECHECK_AVAILABLE',
  examId: 'e1',
  examTitle: 'Operating Systems — Mid 1',
  examStatus: 'PRECHECK',
  securityProfile: 'BASIC_BROWSER',
  policyVersion: 'v1-44136fa3',
  durationMinutes: 60,
  windowStartAt: '2026-10-29T20:29:58.079Z',
  windowEndAt: '2026-10-30T02:34:58.079Z',
  consentPurposes: [],
  checks: [
    { code: 'IDENTITY_SESSION', mandatory: true, serverMeasured: true, optional: false, securityRelevant: true },
    { code: 'ELIGIBILITY', mandatory: true, serverMeasured: true, optional: false, securityRelevant: true },
    { code: 'CLIENT_VERSION', mandatory: false, serverMeasured: false, optional: false, securityRelevant: true },
    { code: 'CLOCK_SYNC', mandatory: true, serverMeasured: false, optional: false, securityRelevant: false },
    { code: 'NETWORK_SAVE_ROUNDTRIP', mandatory: true, serverMeasured: false, optional: false, securityRelevant: false },
    { code: 'KEYBOARD_INPUT', mandatory: true, serverMeasured: false, optional: false, securityRelevant: false },
    { code: 'CANVAS_INPUT', mandatory: false, serverMeasured: false, optional: true, securityRelevant: false },
  ],
  allowedClientBuilds: [],
  monitoringNotice: 'Notice text.',
};

const check = (code: string, status: string, instruction = 'Ready') => ({ code, status, source: 'SERVER', diagnosticCode: null, remediationCode: null, instruction, optional: code === 'CANVAS_INPUT' });

describe('Readiness screen', () => {
  it('runs the whole check as one screen, one step at a time, never showing speed, and ends with a READY stamp', async () => {
    const me = signInAs(['STUDENT']);
    const verified = new Map<string, string>([
      ['IDENTITY_SESSION', 'PASS'],
      ['ELIGIBILITY', 'PASS'],
    ]);
    const checksNow = () => [...verified.entries()].map(([code, status]) => check(code, status, status === 'PASS' ? 'Ready' : 'Fix it'));
    const { calls } = mockFetch(({ method, path, body }) => {
      if (method === 'GET' && path === '/auth/me') return { json: me };
      if (method === 'GET' && path === '/tenant') return { json: TENANT };
      if (method === 'GET' && path === `/student/attempts/${ATTEMPT}/policy`) return { json: policy };
      if (method === 'POST' && path === `/student/attempts/${ATTEMPT}/prechecks`) return { status: 201, json: { runId: RUN, checks: checksNow() } };
      if (method === 'POST' && path === `/student/prechecks/${RUN}/items/verify`) {
        const b = body as { code: string; clientClockMs?: number; keyboardSample?: string };
        if (b.code === 'CLIENT_VERSION') verified.set(b.code, 'UNVERIFIABLE');
        else if (b.code === 'KEYBOARD_INPUT') verified.set(b.code, b.keyboardSample && b.keyboardSample.length >= 20 ? 'PASS' : 'REMEDIATE');
        else verified.set(b.code, 'PASS');
        return { json: { checks: checksNow() } };
      }
      if (method === 'POST' && path === `/student/prechecks/${RUN}/practice-saves`) return { json: { revision: 1, ackAt: new Date().toISOString() } };
      if (method === 'POST' && path === `/student/prechecks/${RUN}/finalize`) return { json: { precheckId: RUN, status: 'READY', securityProfile: 'BASIC_BROWSER', checks: checksNow().map((c) => ({ ...c, mandatory: true, coveredByException: false, securityRelevant: false })), examTimerStarted: false, readyUntil: '2026-10-30T01:00:00.000Z', helpAction: null } };
      return undefined;
    });
    renderApp([{ path: '/student/attempts/:attemptId/readiness', element: <ReadinessPage /> }], `/student/attempts/${ATTEMPT}/readiness`);

    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Readiness check' })).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Checks' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(7);
    expect(screen.getByText(/The exam timer starts only after you are admitted/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Start readiness check' }));

    // Automatic checks ran with real evidence.
    const keyboardHeading = await screen.findByRole('heading', { name: 'Keyboard' });
    expect(keyboardHeading).toBeInTheDocument();
    const verifyCalls = () => calls.filter((c) => c.path.endsWith('/items/verify')).map((c) => c.body as { code: string; clientClockMs?: number; clientBuild?: string; keyboardSample?: string; canvasOps?: number });
    expect(verifyCalls().map((v) => v.code)).toEqual(['CLIENT_VERSION', 'CLOCK_SYNC']);
    expect(typeof verifyCalls()[1]?.clientClockMs).toBe('number');
    expect(verifyCalls()[0]?.clientBuild).toBeTruthy();
    const start = calls.find((c) => c.path.endsWith('/prechecks'));
    expect((start?.body as { clientBuild: string }).clientBuild).toBeTruthy();

    // Not-supported is honest, not an error.
    expect(within(list).getByText('Not supported')).toBeInTheDocument();
    expect(within(list).getAllByText('Ready').length).toBeGreaterThanOrEqual(3);

    // Keyboard practice: the button only enables once the sample is functionally complete. No WPM anywhere.
    const checkKeyboard = screen.getByRole('button', { name: 'Check keyboard' });
    expect(checkKeyboard).toBeDisabled();
    await user.type(screen.getByLabelText('Practice box'), KEYBOARD_SAMPLE);
    expect(checkKeyboard).toBeEnabled();
    await user.click(checkKeyboard);

    // Drawing is optional and can be skipped.
    expect(await screen.findByRole('heading', { name: 'Drawing (optional)' })).toBeInTheDocument();
    expect(screen.getByText(/a stylus is optional/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Skip/ }));

    // The practice save happened and NETWORK_SAVE_ROUNDTRIP was verified after it.
    expect(calls.some((c) => c.path.endsWith('/practice-saves') && /^[a-f0-9]{64}$/.test((c.body as { contentDigest: string }).contentDigest))).toBe(true);
    expect(verifyCalls().map((v) => v.code)).toEqual(['CLIENT_VERSION', 'CLOCK_SYNC', 'KEYBOARD_INPUT', 'NETWORK_SAVE_ROUNDTRIP']);
    expect(verifyCalls()[2]?.keyboardSample).toBe(KEYBOARD_SAMPLE);

    await user.click(await screen.findByRole('button', { name: 'Finish readiness check' }));
    expect(await screen.findByText('Ready', { selector: '.stamp' })).toBeInTheDocument();
    expect(screen.getByText(/You are ready for the exam/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/wpm|words per minute/i);
  });

  it('explains plainly when the Examination Section has not opened the check', async () => {
    const me = signInAs(['STUDENT']);
    mockFetch(({ method, path }) => {
      if (method === 'GET' && path === '/auth/me') return { json: me };
      if (method === 'GET' && path === '/tenant') return { json: TENANT };
      if (method === 'GET' && path === `/student/attempts/${ATTEMPT}/policy`) return { json: policy };
      if (method === 'POST' && path === `/student/attempts/${ATTEMPT}/prechecks`) return { status: 409, json: { type: 'x', title: 'The readiness check has not been opened by the Examination Section yet', status: 409, code: 'PRECHECK_NOT_OPEN', requestId: 't' } };
      return undefined;
    });
    renderApp([{ path: '/student/attempts/:attemptId/readiness', element: <ReadinessPage /> }], `/student/attempts/${ATTEMPT}/readiness`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Start readiness check' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('has not opened the readiness check');
  });
});
