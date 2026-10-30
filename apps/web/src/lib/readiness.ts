import type { PrecheckCheckCode, PrecheckItemStatus, PrecheckStatus } from '@examos/contracts';

/**
 * Readiness check (spec §27): one screen, 7–9 checks, one recommended fix at a
 * time. This reducer owns the list state; the screen owns the API calls.
 */
export type CheckUiStatus = 'waiting' | 'checking' | 'ready' | 'fix' | 'unsupported' | 'help';

export interface PolicyCheck {
  code: PrecheckCheckCode;
  mandatory: boolean;
  serverMeasured: boolean;
  optional: boolean;
  securityRelevant: boolean;
}

export interface ApiCheck {
  code: PrecheckCheckCode;
  status: PrecheckItemStatus;
  source?: string;
  diagnosticCode?: string | null;
  remediationCode?: string | null;
  instruction?: string | null;
  optional?: boolean;
  mandatory?: boolean;
  coveredByException?: boolean;
}

export interface FinalizeResult {
  precheckId: string;
  status: PrecheckStatus;
  securityProfile: string;
  checks: ApiCheck[];
  examTimerStarted: boolean;
  readyUntil: string | null;
  helpAction: 'FIX_AND_RETRY' | 'CONTACT_EXAM_SECTION' | null;
}

export interface CheckRow {
  code: PrecheckCheckCode;
  label: string;
  mandatory: boolean;
  optional: boolean;
  serverMeasured: boolean;
  status: CheckUiStatus;
  instruction: string | null;
  diagnosticCode: string | null;
  coveredByException: boolean;
}

export type Phase = 'idle' | 'starting' | 'running' | 'finalizing' | 'done' | 'error';

export interface ReadinessState {
  phase: Phase;
  runId: string | null;
  checks: CheckRow[];
  activeCode: PrecheckCheckCode | null;
  result: FinalizeResult | null;
  error: string | null;
}

export type ReadinessAction =
  | { type: 'policy'; checks: PolicyCheck[] }
  | { type: 'start' }
  | { type: 'started'; runId: string; checks: ApiCheck[] }
  | { type: 'checking'; code: PrecheckCheckCode }
  | { type: 'checks'; checks: ApiCheck[] }
  | { type: 'finalizing' }
  | { type: 'finalized'; result: FinalizeResult }
  | { type: 'error'; message: string }
  | { type: 'reset' };

export const CHECK_LABELS: Record<PrecheckCheckCode, string> = {
  IDENTITY_SESSION: 'Account and session',
  ELIGIBILITY: 'Exam eligibility',
  CLIENT_VERSION: 'Exam client',
  CLOCK_SYNC: 'Device clock',
  NETWORK_SAVE_ROUNDTRIP: 'Connection and saving',
  KEYBOARD_INPUT: 'Keyboard',
  CANVAS_INPUT: 'Drawing',
  CAMERA: 'Camera',
  MICROPHONE: 'Microphone',
  CONSENT: 'Monitoring notice',
};

export const STATUS_LABELS: Record<CheckUiStatus, string> = {
  waiting: 'Waiting',
  checking: 'Checking',
  ready: 'Ready',
  fix: 'Fix required',
  unsupported: 'Not supported',
  help: 'Need help',
};

export const initialReadinessState: ReadinessState = { phase: 'idle', runId: null, checks: [], activeCode: null, result: null, error: null };

export function uiStatusOf(status: PrecheckItemStatus): CheckUiStatus {
  switch (status) {
    case 'PASS':
      return 'ready';
    case 'REMEDIATE':
      return 'fix';
    case 'UNVERIFIABLE':
      return 'unsupported';
    case 'NEED_HELP':
      return 'help';
    case 'PENDING':
    default:
      return 'waiting';
  }
}

function mergeChecks(rows: CheckRow[], incoming: ApiCheck[]): CheckRow[] {
  const byCode = new Map(incoming.map((c) => [c.code, c] as const));
  return rows.map((row) => {
    const c = byCode.get(row.code);
    if (!c) return row;
    return {
      ...row,
      status: uiStatusOf(c.status),
      instruction: c.status === 'PASS' ? null : (c.instruction ?? null),
      diagnosticCode: c.diagnosticCode ?? null,
      coveredByException: !!c.coveredByException,
    };
  });
}

export function readinessReducer(state: ReadinessState, action: ReadinessAction): ReadinessState {
  switch (action.type) {
    case 'policy': {
      const checks: CheckRow[] = action.checks.map((c) => ({
        code: c.code,
        label: CHECK_LABELS[c.code],
        mandatory: c.mandatory,
        optional: c.optional,
        serverMeasured: c.serverMeasured,
        status: 'waiting',
        instruction: null,
        diagnosticCode: null,
        coveredByException: false,
      }));
      return { ...state, checks };
    }
    case 'start':
      return { ...state, phase: 'starting', runId: null, result: null, error: null, activeCode: null, checks: state.checks.map((c) => ({ ...c, status: 'waiting', instruction: null, diagnosticCode: null })) };
    case 'started':
      return { ...state, phase: 'running', runId: action.runId, checks: mergeChecks(state.checks, action.checks) };
    case 'checking':
      return { ...state, activeCode: action.code, checks: state.checks.map((c) => (c.code === action.code ? { ...c, status: 'checking' } : c)) };
    case 'checks':
      return { ...state, activeCode: null, checks: mergeChecks(state.checks, action.checks) };
    case 'finalizing':
      return { ...state, phase: 'finalizing', activeCode: null };
    case 'finalized':
      return { ...state, phase: 'done', result: action.result, checks: mergeChecks(state.checks, action.result.checks) };
    case 'error':
      return { ...state, phase: 'error', error: action.message, activeCode: null };
    case 'reset':
      return { ...initialReadinessState, checks: state.checks.map((c) => ({ ...c, status: 'waiting', instruction: null, diagnosticCode: null })) };
    default:
      return state;
  }
}

/** The ONE recommended fix: the first mandatory check needing a fix, else the first optional one. */
export function nextFix(state: ReadinessState): CheckRow | null {
  const needing = state.checks.filter((c) => (c.status === 'fix' || c.status === 'help') && !c.coveredByException);
  return needing.find((c) => c.mandatory) ?? needing[0] ?? null;
}

export function countBy(state: ReadinessState): Record<CheckUiStatus, number> {
  const out: Record<CheckUiStatus, number> = { waiting: 0, checking: 0, ready: 0, fix: 0, unsupported: 0, help: 0 };
  for (const c of state.checks) out[c.status]++;
  return out;
}

/** Validates the keyboard practice sample locally with the same rule the server applies (letters, digits, punctuation, ≥ 20 chars). No speed is measured, ever. */
export function keyboardSampleOk(sample: string): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!/[a-zA-Z]/.test(sample)) missing.push('a letter');
  if (!/\d/.test(sample)) missing.push('a digit');
  if (!/[.,;:!?()-]/.test(sample)) missing.push('a punctuation mark');
  if (sample.length < 20) missing.push('at least 20 characters');
  return { ok: missing.length === 0, missing };
}

/** Summarises the user agent into a short, non-identifying client build string for the CLIENT_VERSION check. */
export function summariseClientBuild(ua: string): string {
  const seb = /SEB\/([\d.]+)/i.exec(ua);
  if (seb) return `SEB/${seb[1]}`;
  const m = /(Edg|OPR|Chrome|Firefox|Safari)\/([\d.]+)/.exec(ua);
  const os = /Windows NT ([\d.]+)/.exec(ua)?.[0] ?? /Mac OS X ([\d_]+)/.exec(ua)?.[0] ?? (/Linux/.test(ua) ? 'Linux' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : 'unknown');
  const browser = m ? `${m[1]}/${(m[2] ?? '').split('.')[0]}` : 'browser';
  return `${browser} ${os}`.replace(/_/g, '.').slice(0, 64);
}
