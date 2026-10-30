import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { PrecheckCheckCode } from '@examos/contracts';
import { api, isApiError } from '@/lib/api';
import { collectDeviceScan } from '@/lib/device-scan';
import { useAuth } from '@/lib/auth';
import { sha256Hex } from '@/lib/canonical';
import { formatDateTime } from '@/lib/time';
import { countBy, initialReadinessState, nextFix, readinessReducer, STATUS_LABELS, summariseClientBuild, type ApiCheck, type CheckRow, type CheckUiStatus, type FinalizeResult, type PolicyCheck } from '@/lib/readiness';
import { Button, cn, EmptyState, PageTitle, Skeleton, Stamp, StatusChip, type Tone } from '@/ui';
import { CanvasPractice, ConsentStep, KeyboardPractice, MediaStep } from './practice';

interface Policy {
  attemptId: string;
  attemptStatus: string;
  examId: string;
  examTitle: string;
  examStatus: string;
  securityProfile: string;
  policyVersion: string;
  durationMinutes: number;
  windowStartAt: string;
  windowEndAt: string;
  consentPurposes: string[];
  checks: PolicyCheck[];
  allowedClientBuilds: string[];
  monitoringNotice: string;
}

type StepId = 'KEYBOARD_INPUT' | 'CANVAS_INPUT' | 'CONSENT' | 'CAMERA' | 'MICROPHONE';
const STEP_ORDER: StepId[] = ['KEYBOARD_INPUT', 'CANVAS_INPUT', 'CONSENT', 'CAMERA', 'MICROPHONE'];
const QUIET = ['PRECHECK_NOT_OPEN', 'ATTEMPT_STATE', 'PRECHECK_FINALIZED', 'PRECHECK_NOT_FOUND', 'EVIDENCE_REQUIRED'] as const;

const toneFor: Record<CheckUiStatus, Tone> = { waiting: 'neutral', checking: 'accent', ready: 'ready', fix: 'fix', unsupported: 'note', help: 'stop' };

export function ReadinessPage() {
  const { attemptId = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { me } = useAuth();
  const tz = me?.tenant.timezone ?? 'Asia/Kolkata';
  const policy = useQuery({ queryKey: ['student', 'policy', attemptId], queryFn: () => api.get<Policy>(`/student/attempts/${attemptId}/policy`), enabled: !!attemptId });

  const [state, dispatch] = useReducer(readinessReducer, initialReadinessState);
  const [stepIndex, setStepIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [keyboardText, setKeyboardText] = useState('');
  const [mediaNote, setMediaNote] = useState<Partial<Record<StepId, string>>>({});
  const runIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (policy.data) dispatch({ type: 'policy', checks: policy.data.checks });
  }, [policy.data]);

  const codes = useMemo(() => new Set(policy.data?.checks.map((c) => c.code) ?? []), [policy.data]);
  const steps = useMemo(() => STEP_ORDER.filter((s) => codes.has(s)), [codes]);
  const currentStep: StepId | null = state.phase === 'running' ? (steps[stepIndex] ?? null) : null;
  const interactiveDone = state.phase === 'running' && stepIndex >= steps.length;

  const verify = useCallback(
    async (code: PrecheckCheckCode, evidence: Record<string, unknown>): Promise<ApiCheck[]> => {
      const runId = runIdRef.current;
      if (!runId) throw new Error('no run');
      dispatch({ type: 'checking', code });
      const out = await api.post<{ checks: ApiCheck[] }>(`/student/prechecks/${runId}/items/verify`, { code, ...evidence }, { quiet: QUIET });
      dispatch({ type: 'checks', checks: out.checks });
      return out.checks;
    },
    [],
  );

  const start = useCallback(async () => {
    if (!policy.data) return;
    setStartError(null);
    setBusy(true);
    setStepIndex(0);
    setKeyboardText('');
    setMediaNote({});
    dispatch({ type: 'start' });
    try {
      const clientBuild = summariseClientBuild(navigator.userAgent);
      const started = await api.post<{ runId: string; checks: ApiCheck[] }>(`/student/attempts/${attemptId}/prechecks`, { clientBuild }, { quiet: QUIET });
      runIdRef.current = started.runId;
      dispatch({ type: 'started', runId: started.runId, checks: started.checks });
      // Automatic checks first. The Safe Exam Browser headers, when present, are added by the browser itself.
      if (codes.has('CLIENT_VERSION')) await verify('CLIENT_VERSION', { clientBuild });
      if (codes.has('CLOCK_SYNC')) await verify('CLOCK_SYNC', { clientClockMs: Date.now() });
      // System scan: the browser reports its settings, the server decides what they mean.
      if (codes.has('SYSTEM_SCAN')) await verify('SYSTEM_SCAN', { scan: await collectDeviceScan() });
    } catch (e) {
      runIdRef.current = null;
      if (isApiError(e, 'PRECHECK_NOT_OPEN')) setStartError('The Examination Section has not opened the readiness check for this exam yet. Come back closer to the exam time.');
      else if (isApiError(e, 'ATTEMPT_STATE')) setStartError(`The readiness check cannot run right now (${e.problem.title}).`);
      else setStartError('The readiness check could not start. Check your connection and try again; this is not counted against you.');
      dispatch({ type: 'error', message: 'start-failed' });
    } finally {
      setBusy(false);
    }
  }, [attemptId, codes, policy.data, verify]);

  const advance = () => setStepIndex((i) => i + 1);

  const runStep = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      if (isApiError(e, 'PRECHECK_FINALIZED') || isApiError(e, 'PRECHECK_NOT_FOUND')) dispatch({ type: 'error', message: 'This readiness run has ended. Start it again.' });
    } finally {
      setBusy(false);
    }
  };

  const submitKeyboard = () =>
    runStep(async () => {
      await verify('KEYBOARD_INPUT', { keyboardSample: keyboardText.slice(0, 2000) });
      // Durable save round-trip: a real save of the practice text, acknowledged by the server, then verified.
      if (codes.has('NETWORK_SAVE_ROUNDTRIP')) {
        dispatch({ type: 'checking', code: 'NETWORK_SAVE_ROUNDTRIP' });
        const digest = await sha256Hex(keyboardText);
        await api.post(`/student/prechecks/${runIdRef.current}/practice-saves`, { contentDigest: digest }, { quiet: QUIET });
        await verify('NETWORK_SAVE_ROUNDTRIP', {});
      }
      advance();
    });

  const rescan = () =>
    runStep(async () => {
      await verify('SYSTEM_SCAN', { scan: await collectDeviceScan() });
    });

  const submitCanvas = (ops: number) =>
    runStep(async () => {
      await verify('CANVAS_INPUT', { canvasOps: ops });
      advance();
    });

  const submitConsent = () =>
    runStep(async () => {
      await verify('CONSENT', { consentPolicyVersion: policy.data?.policyVersion });
      advance();
    });

  const submitMedia = (kind: 'CAMERA' | 'MICROPHONE') =>
    runStep(async () => {
      const checks = await verify(kind, {});
      const item = checks.find((c) => c.code === kind);
      if (item?.status === 'UNVERIFIABLE') setMediaNote((m) => ({ ...m, [kind]: 'Will be checked by the invigilator.' }));
      advance();
    });

  const finalize = () =>
    runStep(async () => {
      dispatch({ type: 'finalizing' });
      const result = await api.post<FinalizeResult>(`/student/prechecks/${runIdRef.current}/finalize`, {}, { quiet: QUIET });
      dispatch({ type: 'finalized', result });
    });

  if (policy.isLoading) return <Skeleton lines={6} className="max-w-3xl" />;
  if (policy.isError || !policy.data) return <EmptyState title="This readiness check could not be opened">Go back to your exams and try again. If it keeps failing, ask the Examination Section desk.</EmptyState>;

  const fix = nextFix(state);
  const counts = countBy(state);

  return (
    <div className="max-w-6xl">
      <PageTitle
        kicker={policy.data.examTitle}
        title="Readiness check"
        lede={
          <>
            About 15 minutes, one step at a time. <strong className="text-ink font-medium">The exam timer starts only after you are admitted</strong> — nothing here uses your exam time, and a failed check is never counted against you.
          </>
        }
        actions={
          state.phase === 'idle' || state.phase === 'error' ? (
            <Button variant="primary" size="lg" onClick={() => void start()} loading={busy}>
              {state.phase === 'error' ? 'Try again' : 'Start readiness check'}
            </Button>
          ) : state.phase === 'done' ? (
            <Button onClick={() => void start()} loading={busy}>
              Run again
            </Button>
          ) : null
        }
      />

      {startError ? (
        <p className="mb-6 text-fix" role="alert">
          {startError}
        </p>
      ) : null}

      <div className="grid gap-8 lg:grid-cols-12">
        <section aria-labelledby="checks-heading" className="lg:col-span-5">
          <h2 id="checks-heading" className="visually-hidden">
            Checks
          </h2>
          <ol className="sheet divide-y divide-rule" aria-label="Checks">
            {state.checks.map((c, i) => (
              <CheckLine key={c.code} index={i + 1} row={c} active={currentStep === c.code || state.activeCode === c.code} />
            ))}
          </ol>
          <p className="mt-3 text-sm text-ink-2" aria-live="polite">
            {counts.ready} ready{counts.fix ? `, ${counts.fix} to fix` : ''}
            {counts.unsupported ? `, ${counts.unsupported} not supported here` : ''}
            {counts.help ? `, ${counts.help} need help` : ''}.
          </p>
        </section>

        <section className="lg:col-span-7" aria-live="polite">
          {state.phase === 'idle' ? (
            <div className="sheet p-6">
              <h2 className="text-h3">Before you start</h2>
              <ul className="mt-3 list-disc pl-5 text-ink-2 space-y-1">
                <li>Sit where you will take the exam, on the same network.</li>
                <li>Use one screen only. Close screen-sharing, remote-desktop and automation tools; the system scan checks for them.</li>
                <li>Close video calls and other apps that use the camera or microphone, if this exam uses them.</li>
                <li>Keep your hall ticket handy. The desk can help with anything that does not pass.</li>
              </ul>
            </div>
          ) : null}

          {state.phase === 'starting' ? <p className="text-ink-2">Checking your account and exam…</p> : null}

          {state.phase === 'running' && currentStep ? (
            <StepPanel title={stepTitle(currentStep)} step={stepIndex + 1} of={steps.length}>
              {currentStep === 'KEYBOARD_INPUT' ? <KeyboardPractice value={keyboardText} onChange={setKeyboardText} onSubmit={() => void submitKeyboard()} busy={busy} /> : null}
              {currentStep === 'CANVAS_INPUT' ? <CanvasPractice onSubmit={(ops) => void submitCanvas(ops)} onSkip={advance} busy={busy} /> : null}
              {currentStep === 'CONSENT' ? <ConsentStep notice={policy.data.monitoringNotice} purposes={policy.data.consentPurposes} policyVersion={policy.data.policyVersion} onSubmit={() => void submitConsent()} busy={busy} /> : null}
              {currentStep === 'CAMERA' || currentStep === 'MICROPHONE' ? <MediaStep key={currentStep} kind={currentStep} onConfirm={() => void submitMedia(currentStep)} onCannot={advance} busy={busy} /> : null}
            </StepPanel>
          ) : null}

          {interactiveDone ? (
            <div className="sheet p-6 flex flex-col gap-4">
              <h2 className="text-h3">All steps done</h2>
              {fix ? <FixCard row={fix} onRetry={() => (fix.code === 'SYSTEM_SCAN' ? void rescan() : retryStep(fix.code, steps, setStepIndex))} /> : <p className="text-ink-2">Finish to record your readiness. You can run the check again at any time before the exam starts.</p>}
              {Object.values(mediaNote).map((n, i) => (
                <p key={i} className="text-ink-2 text-sm">
                  {n}
                </p>
              ))}
              <div>
                <Button variant="primary" size="lg" onClick={() => void finalize()} loading={busy}>
                  Finish readiness check
                </Button>
              </div>
            </div>
          ) : null}

          {state.phase === 'finalizing' ? <p className="text-ink-2">Recording your readiness…</p> : null}

          {state.phase === 'done' && state.result ? (
            <Verdict
              result={state.result}
              fix={fix}
              tz={tz}
              onRetry={() => void start()}
              onLobby={() => {
                void qc.invalidateQueries({ queryKey: ['student', 'exams'] });
                navigate('/student');
              }}
            />
          ) : null}

          {state.phase === 'error' && state.error && state.error !== 'start-failed' ? (
            <p className="text-fix" role="alert">
              {state.error}
            </p>
          ) : null}
        </section>
      </div>

      <p className="mt-10 text-sm text-ink-2">
        Need a person? The Examination Section desk can approve an exception or arrange a university device. <Link to="/student" className="underline underline-offset-4">Back to my exams</Link>
      </p>
    </div>
  );
}

function retryStep(code: PrecheckCheckCode, steps: StepId[], setStepIndex: (i: number) => void) {
  const idx = steps.indexOf(code as StepId);
  if (idx >= 0) setStepIndex(idx);
}

function stepTitle(step: StepId): string {
  switch (step) {
    case 'KEYBOARD_INPUT':
      return 'Keyboard';
    case 'CANVAS_INPUT':
      return 'Drawing (optional)';
    case 'CONSENT':
      return 'Monitoring notice';
    case 'CAMERA':
      return 'Camera';
    case 'MICROPHONE':
      return 'Microphone';
  }
}

function CheckLine({ index, row, active }: { index: number; row: CheckRow; active: boolean }) {
  return (
    <li className={cn('flex items-start gap-3 px-4 py-3', active && 'bg-accent-soft/40')} aria-current={active ? 'step' : undefined}>
      <span className="font-mono text-sm text-ink-3 tabular w-5 pt-1">{index}</span>
      <div className="flex-1 min-w-0">
        <p className="font-medium">
          {row.label}
          {row.optional ? <span className="text-ink-2 font-normal"> · optional</span> : null}
        </p>
        {row.instruction && row.status !== 'ready' ? <p className="text-sm text-ink-2 mt-0.5">{row.instruction}</p> : null}
        {row.coveredByException ? <p className="text-sm text-ink-2 mt-0.5">Covered by an approved exception.</p> : null}
      </div>
      <StatusChip tone={toneFor[row.status]} className="shrink-0">
        {STATUS_LABELS[row.status]}
      </StatusChip>
    </li>
  );
}

function StepPanel({ title, step, of, children }: { title: string; step: number; of: number; children: ReactNode }) {
  return (
    <div className="sheet p-6">
      <p className="text-sm text-ink-2">
        Step {step} of {of}
      </p>
      <h2 className="text-h3 mt-0.5 mb-4">{title}</h2>
      {children}
    </div>
  );
}

/** Exactly one fix, phrased as the thing to do next. */
function FixCard({ row, onRetry }: { row: CheckRow; onRetry?: () => void }) {
  return (
    <div className="border-l-2 border-fix pl-4 py-1">
      <p className="text-sm text-fix font-medium">Do this next</p>
      <p className="font-serif text-xl mt-1" style={{ fontVariationSettings: "'opsz' 24" }}>
        {row.label}
      </p>
      <p className="text-ink-2 mt-1">{row.instruction ?? 'Ask the Examination Section desk for help.'}</p>
      {onRetry && ['KEYBOARD_INPUT', 'CANVAS_INPUT', 'CONSENT', 'CAMERA', 'MICROPHONE', 'SYSTEM_SCAN'].includes(row.code) ? (
        <Button size="sm" className="mt-3" onClick={onRetry}>
          {row.code === 'SYSTEM_SCAN' ? 'Scan again' : 'Retry this step'}
        </Button>
      ) : null}
    </div>
  );
}

function Verdict({ result, fix, tz, onRetry, onLobby }: { result: FinalizeResult; fix: CheckRow | null; tz: string; onRetry: () => void; onLobby: () => void }) {
  const tone: Tone = result.status === 'READY' ? 'ready' : result.status === 'REMEDIATE' ? 'fix' : 'stop';
  const word = result.status === 'READY' ? 'Ready' : result.status === 'REMEDIATE' ? 'Fix' : 'Need support';
  return (
    <div className="sheet p-6 sm:p-8" role="status">
      <div className="flex flex-wrap items-center gap-6">
        <Stamp tone={tone} className="text-3xl">
          {word}
        </Stamp>
        <div className="flex-1 min-w-56">
          {result.status === 'READY' ? (
            <>
              <h2 className="text-h3">You are ready for the exam</h2>
              <p className="text-ink-2 mt-1">
                Readiness is valid until {formatDateTime(result.readyUntil, tz)}. The exam timer starts only after you are admitted; wait on your exams page for the Examination Section to start the exam.
              </p>
            </>
          ) : result.status === 'REMEDIATE' ? (
            <>
              <h2 className="text-h3">One thing to fix, then run again</h2>
              <p className="text-ink-2 mt-1">Fix the item below and run the check again. This is not counted against you.</p>
            </>
          ) : (
            <>
              <h2 className="text-h3">Ask the Examination Section desk</h2>
              <p className="text-ink-2 mt-1">Something here cannot be verified on this device. The desk can approve an exception or arrange a university device. This is not counted against you.</p>
            </>
          )}
        </div>
      </div>
      {fix && result.status !== 'READY' ? (
        <div className="mt-6">
          <FixCard row={fix} />
        </div>
      ) : null}
      <div className="mt-6 flex flex-wrap gap-2">
        {result.status === 'READY' ? (
          <Button variant="primary" size="lg" onClick={onLobby}>
            Go to my exams
          </Button>
        ) : (
          <Button variant="primary" size="lg" onClick={onRetry}>
            Run the check again
          </Button>
        )}
        {result.status !== 'READY' ? (
          <Button variant="ghost" size="lg" onClick={onLobby}>
            Back to my exams
          </Button>
        ) : null}
      </div>
    </div>
  );
}
