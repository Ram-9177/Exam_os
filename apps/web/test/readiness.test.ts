import { describe, expect, it } from 'vitest';
import { countBy, initialReadinessState, keyboardSampleOk, nextFix, readinessReducer, summariseClientBuild, type PolicyCheck, type ReadinessState } from '@/lib/readiness';

const policy: PolicyCheck[] = [
  { code: 'IDENTITY_SESSION', mandatory: true, serverMeasured: true, optional: false, securityRelevant: true },
  { code: 'ELIGIBILITY', mandatory: true, serverMeasured: true, optional: false, securityRelevant: true },
  { code: 'CLIENT_VERSION', mandatory: false, serverMeasured: false, optional: false, securityRelevant: true },
  { code: 'CLOCK_SYNC', mandatory: true, serverMeasured: false, optional: false, securityRelevant: false },
  { code: 'NETWORK_SAVE_ROUNDTRIP', mandatory: true, serverMeasured: false, optional: false, securityRelevant: false },
  { code: 'KEYBOARD_INPUT', mandatory: true, serverMeasured: false, optional: false, securityRelevant: false },
  { code: 'CANVAS_INPUT', mandatory: false, serverMeasured: false, optional: true, securityRelevant: false },
];

function run(...actions: Parameters<typeof readinessReducer>[1][]): ReadinessState {
  return actions.reduce((s, a) => readinessReducer(s, a), initialReadinessState);
}

describe('readiness reducer', () => {
  it('builds the list from the policy in order, all waiting', () => {
    const s = run({ type: 'policy', checks: policy });
    expect(s.checks.map((c) => c.code)).toEqual(policy.map((p) => p.code));
    expect(s.checks.every((c) => c.status === 'waiting')).toBe(true);
    expect(s.checks.find((c) => c.code === 'CANVAS_INPUT')?.optional).toBe(true);
    expect(s.checks[0]?.label).toBe('Account and session');
  });

  it('merges server statuses on start and keeps unknown checks untouched', () => {
    const s = run({ type: 'policy', checks: policy }, { type: 'start' }, { type: 'started', runId: 'r1', checks: [{ code: 'IDENTITY_SESSION', status: 'PASS' }, { code: 'ELIGIBILITY', status: 'REMEDIATE', instruction: 'Contact the desk.' }] });
    expect(s.phase).toBe('running');
    expect(s.runId).toBe('r1');
    expect(s.checks.find((c) => c.code === 'IDENTITY_SESSION')?.status).toBe('ready');
    expect(s.checks.find((c) => c.code === 'ELIGIBILITY')).toMatchObject({ status: 'fix', instruction: 'Contact the desk.' });
    expect(s.checks.find((c) => c.code === 'CLOCK_SYNC')?.status).toBe('waiting');
  });

  it('marks a check as checking while it runs, then takes the server verdict', () => {
    let s = run({ type: 'policy', checks: policy }, { type: 'start' }, { type: 'started', runId: 'r1', checks: [] }, { type: 'checking', code: 'CLOCK_SYNC' });
    expect(s.activeCode).toBe('CLOCK_SYNC');
    expect(s.checks.find((c) => c.code === 'CLOCK_SYNC')?.status).toBe('checking');
    s = readinessReducer(s, { type: 'checks', checks: [{ code: 'CLOCK_SYNC', status: 'UNVERIFIABLE', instruction: 'Cannot verify.' }] });
    expect(s.activeCode).toBeNull();
    expect(s.checks.find((c) => c.code === 'CLOCK_SYNC')?.status).toBe('unsupported');
  });

  it('nextFix returns exactly one fix, mandatory before optional, and none when all pass', () => {
    const s = run(
      { type: 'policy', checks: policy },
      { type: 'start' },
      { type: 'started', runId: 'r1', checks: [{ code: 'CANVAS_INPUT', status: 'REMEDIATE', instruction: 'Draw three shapes.' }, { code: 'KEYBOARD_INPUT', status: 'REMEDIATE', instruction: 'Type the sample.' }, { code: 'IDENTITY_SESSION', status: 'PASS' }] },
    );
    expect(nextFix(s)?.code).toBe('KEYBOARD_INPUT');
    const fixed = readinessReducer(s, { type: 'checks', checks: [{ code: 'KEYBOARD_INPUT', status: 'PASS' }] });
    expect(nextFix(fixed)?.code).toBe('CANVAS_INPUT');
    const all = readinessReducer(fixed, { type: 'checks', checks: [{ code: 'CANVAS_INPUT', status: 'PASS' }] });
    expect(nextFix(all)).toBeNull();
    expect(countBy(all).ready).toBe(3);
  });

  it('ignores checks covered by an exception when choosing the fix', () => {
    const s = run({ type: 'policy', checks: policy }, { type: 'start' }, { type: 'started', runId: 'r1', checks: [] }, { type: 'finalizing' }, {
      type: 'finalized',
      result: { precheckId: 'r1', status: 'READY', securityProfile: 'BASIC_BROWSER', checks: [{ code: 'CLOCK_SYNC', status: 'REMEDIATE', instruction: 'Fix clock.', coveredByException: true }], examTimerStarted: false, readyUntil: null, helpAction: null },
    });
    expect(s.phase).toBe('done');
    expect(nextFix(s)).toBeNull();
    expect(s.checks.find((c) => c.code === 'CLOCK_SYNC')?.coveredByException).toBe(true);
  });

  it('reset keeps the list but clears statuses and the result', () => {
    const s = run({ type: 'policy', checks: policy }, { type: 'start' }, { type: 'started', runId: 'r1', checks: [{ code: 'IDENTITY_SESSION', status: 'PASS' }] }, { type: 'reset' });
    expect(s.phase).toBe('idle');
    expect(s.runId).toBeNull();
    expect(s.checks).toHaveLength(policy.length);
    expect(s.checks.every((c) => c.status === 'waiting')).toBe(true);
  });
});

describe('keyboard sample check', () => {
  it('needs letters, digits, punctuation and 20 characters — never speed', () => {
    expect(keyboardSampleOk('The quick brown fox jumps over 13 lazy dogs; ready, set, go!').ok).toBe(true);
    expect(keyboardSampleOk('short 1.')).toMatchObject({ ok: false, missing: ['at least 20 characters'] });
    expect(keyboardSampleOk('no digits here at all, honestly.').missing).toEqual(['a digit']);
  });
});

describe('client build summary', () => {
  it('prefers the Safe Exam Browser marker and otherwise summarises browser and OS', () => {
    expect(summariseClientBuild('Mozilla/5.0 (Windows NT 10.0) SEB/3.7.0 Chrome/120')).toBe('SEB/3.7.0');
    expect(summariseClientBuild('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')).toBe('Chrome/131 Windows NT 10.0');
    expect(summariseClientBuild('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15')).toBe('Safari/605 Mac OS X 10.15.7');
  });
});
