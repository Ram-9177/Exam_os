import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useParams } from 'react-router';
import type { PaperQuestionInput, PaperSection } from '@examos/contracts';
import { useQuery } from '@tanstack/react-query';
import { api, isApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import type { AnswerDoc } from '@/lib/answers';
import { uuid } from '@/lib/ids';
import { SignalReporter } from '@/lib/signals';
import { AnswerSync, type QuestionSyncState, type SyncTransport } from '@/lib/sync';
import { formatDateTime } from '@/lib/time';
import { Button, cn, Dialog, KeyValue, LinkButton, Stamp, StatusChip, useToast, type Tone } from '@/ui';
import { AnswerEditor } from './AnswerEditor';
import { useAttemptSession } from './session';
import { Timer } from './Timer';

export interface WorkspaceQuestion {
  id: string;
  label: string;
  prompt?: PaperQuestionInput['prompt'];
  maxMarks?: number | null;
  kind?: string;
  options?: unknown;
  sectionId?: string;
}

interface StudentPaperResponse {
  paperId: string;
  title: string;
  instructions: string | null;
  totalMarks: number;
  sections: PaperSection[];
  setCode: string;
  questions: Array<Omit<PaperQuestionInput, 'rubric' | 'expectedAnswer'>>;
}

function useWorkspacePaper(attemptId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['student', 'attempt', attemptId, 'paper'],
    queryFn: () => api.get<StudentPaperResponse>(`/student/attempts/${attemptId}/paper`, { quiet: true }),
    enabled: !!attemptId && enabled,
    staleTime: 60_000,
  });

}

const SAVE_QUIET = ['REVISION_CONFLICT', 'CONTENT_HASH_MISMATCH', 'ATTEMPT_NOT_ACTIVE', 'DEVICE_SESSION_MISMATCH', 'DEADLINE_PASSED', 'NETWORK', 'RATE_LIMITED', 'ATTEMPT_STATE'] as const;

const SAVE_LABEL: Record<QuestionSyncState, { text: string; tone: Tone }> = {
  empty: { text: 'Saved to server', tone: 'ready' },
  'saved-local': { text: 'Saved locally', tone: 'neutral' },
  syncing: { text: 'Syncing', tone: 'accent' },
  'saved-server': { text: 'Saved to server', tone: 'ready' },
  recovery: { text: 'Recovery needed', tone: 'stop' },
  paused: { text: 'Paused', tone: 'fix' },
};

interface SubmitReceipt {
  receiptId: string;
  manifestSha256: string;
  sealedAt: string;
}

export function ExamWorkspace() {
  const { attemptId = '' } = useParams();
  const { me } = useAuth();
  const tz = me?.tenant.timezone ?? 'Asia/Kolkata';
  const { toast } = useToast();
  const { session, heartbeat } = useAttemptSession(attemptId);
  const paper = useWorkspacePaper(attemptId, ['active', 'paused', 'offline'].includes(session.kind));
  const questions = useMemo<WorkspaceQuestion[]>(() => (paper.data?.questions ?? []).map((q) => ({
    id: q.questionId, label: `Question ${q.number}`, prompt: q.prompt,
    maxMarks: q.maxMarks, kind: q.kind, options: q.options, sectionId: q.sectionCode,
  })), [paper.data]);
  const policy = useQuery({ queryKey: ['student', 'policy', attemptId], queryFn: () => api.get<{ examTitle: string; durationMinutes: number }>(`/student/attempts/${attemptId}/policy`, { quiet: true }), enabled: !!attemptId, staleTime: Infinity });

  // ---------- answer sync ----------
  const transport = useMemo<SyncTransport>(
    () => ({
      save: (q, body) => api.put(`/student/attempts/${attemptId}/answers/${q}`, body, { quiet: SAVE_QUIET }),
      load: (q) => api.get(`/student/attempts/${attemptId}/answers/${q}`, { quiet: ['NETWORK'] }),
    }),
    [attemptId],
  );
  const heartbeatRef = useRef(heartbeat);
  heartbeatRef.current = heartbeat;
  const sync = useMemo(() => new AnswerSync({ attemptId, transport, onBlocked: () => void heartbeatRef.current() }), [attemptId, transport]);
  useEffect(() => {
    sync.attach();
    return () => sync.dispose();
  }, [sync]);
  const snap = useSyncExternalStore(sync.subscribe, sync.getSnapshot, sync.getSnapshot);

  // Pull server truth for every question once the session is live, keeping any unsynced local draft.
  useEffect(() => {
    if (session.kind !== 'active') return;
    for (const q of questions) {
      if (!sync.isLoaded(q.id)) {
        void sync.load(q.id).catch(() => undefined);
      }
    }
  }, [session.kind, questions, sync]);

  // Pause/resume follows the invigilator's decisions as reported by the heartbeat.
  useEffect(() => {
    if (session.kind === 'paused' || session.kind === 'device-mismatch' || session.kind === 'sealed' || session.kind === 'expired') sync.pause(session.kind);
    else if (session.kind === 'active' && sync.isPaused()) sync.resume();
  }, [session.kind, sync]);

  // ---------- proctor signals (context, never a verdict) ----------
  const reporter = useMemo(() => new SignalReporter({ attemptId }), [attemptId]);
  useEffect(() => {
    if (session.kind !== 'active') return;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') reporter.report('FOCUS_LOST', { reason: 'hidden' });
    };
    const onBlur = () => reporter.report('FOCUS_LOST', { reason: 'blur' });
    const onFullscreen = () => {
      if (!document.fullscreenElement) reporter.report('FULLSCREEN_EXIT', {});
    };
    // Anti-inspection and DevTools restriction
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      toast({ tone: 'warning', title: 'Context menu disabled', description: 'Right-click inspection is disabled during the examination.' });
      reporter.report('VISUAL_ANOMALY', { reason: 'context_menu_attempt' });
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
      const mod = isMac ? e.metaKey : e.ctrlKey;
      const key = e.key.toLowerCase();

      // F12 or DevTools chords: Ctrl+Shift+I/J/C, Cmd+Option+I/J/C
      const isDevTools =
        e.key === 'F12' ||
        (mod && e.shiftKey && (key === 'i' || key === 'j' || key === 'c')) ||
        (isMac && e.altKey && e.metaKey && (key === 'i' || key === 'j' || key === 'c'));

      // View Source / Print / Save: Ctrl+U, Ctrl+P, Ctrl+S
      const isSourceOrPrint = mod && (key === 'u' || key === 'p' || key === 's');

      if (isDevTools || isSourceOrPrint) {
        e.preventDefault();
        e.stopPropagation();
        toast({ tone: 'warning', title: 'Action restricted', description: 'Developer tools, printing, and source inspection are restricted.' });
        reporter.report('VISUAL_ANOMALY', { reason: isDevTools ? 'devtools_shortcut_attempt' : 'source_print_shortcut_attempt', key: e.key });
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    document.addEventListener('fullscreenchange', onFullscreen);
    document.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('fullscreenchange', onFullscreen);
      document.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('keydown', onKeyDown, { capture: true });
    };
  }, [reporter, session.kind, toast]);

  // ---------- navigation state ----------
  const [index, setIndex] = useState(0);
  const current = questions[Math.min(index, Math.max(0, questions.length - 1))] ?? { id: 'Q1', label: 'Question 1' };
  const flagsKey = `examos.flags.${attemptId}`;
  const [flags, setFlags] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(sessionStorage.getItem(flagsKey) ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const toggleFlag = () => {
    setFlags((f) => {
      const n = new Set(f);
      if (n.has(current.id)) n.delete(current.id);
      else n.add(current.id);
      sessionStorage.setItem(flagsKey, JSON.stringify([...n]));
      return n;
    });
  };

  const doc = snap.questions[current.id]?.localDoc ?? sync.getDoc(current.id);
  // One stable placeholder paragraph id per question, so an empty answer renders the same textarea across re-renders.
  const placeholderId = useMemo(() => `b-${uuid()}`, [current.id]);
  const onChange = useCallback((next: AnswerDoc) => sync.edit(current.id, next), [sync, current.id]);

  const [timeOver, setTimeOver] = useState(false);
  const onExpired = useCallback(() => {
    setTimeOver(true);
    void sync.flushAll();
    void heartbeatRef.current();
  }, [sync]);

  // ---------- submit ----------
  const [submitOpen, setSubmitOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [receipt, setReceipt] = useState<SubmitReceipt | null>(() => {
    try {
      const raw = sessionStorage.getItem(`examos.receipt.${attemptId}`);
      return raw ? (JSON.parse(raw) as SubmitReceipt) : null;
    } catch {
      return null;
    }
  });
  const submit = async () => {
    setSubmitting(true);
    try {
      await Promise.race([sync.flushAll(), new Promise((r) => setTimeout(r, 8000))]);
      if (sync.unsyncedQuestionIds().length) {
        toast({ tone: 'warning', title: 'Answers are still saving', description: 'Submission is paused until every answer reaches the server. Keep this page open and try again.' });
        return;
      }
      const keyName = `examos.submit-key.${attemptId}`;
      let key = sessionStorage.getItem(keyName);
      if (!key) {
        key = uuid();
        sessionStorage.setItem(keyName, key);
      }
      const r = await api.post<SubmitReceipt & { manifest: unknown }>(`/student/attempts/${attemptId}/submit`, { idempotencyKey: key }, { quiet: ['ATTEMPT_STATE', 'ALREADY_SUBMITTED'] });
      const rec = { receiptId: r.receiptId, manifestSha256: r.manifestSha256, sealedAt: r.sealedAt };
      sessionStorage.setItem(`examos.receipt.${attemptId}`, JSON.stringify(rec));
      sync.clearPersisted();
      setReceipt(rec);
      setSubmitOpen(false);
      void heartbeatRef.current();
    } catch (e) {
      if (isApiError(e, 'ALREADY_SUBMITTED')) {
        setSubmitOpen(false);
        void heartbeatRef.current();
      } else if (isApiError(e, 'ATTEMPT_STATE')) toast({ tone: 'warning', title: 'Cannot submit right now', description: e.problem.title });
    } finally {
      setSubmitting(false);
    }
  };

  const examTitle = policy.data?.examTitle ?? 'Examination';
  const editing = session.kind === 'active' || session.kind === 'offline' || session.kind === 'connecting';
  const disabled = !editing || timeOver || submitting || !sync.isLoaded(current.id);
  const overall = snap.overall;
  const unsyncedLabels = snap.unsynced.map((id) => questions.find((q) => q.id === id)?.label ?? id);

  if (receipt || session.kind === 'sealed') return <SealedScreen receipt={receipt} tz={tz} examTitle={examTitle} />;
  if (session.kind === 'device-mismatch') return <FullScreenNotice tone="stop" stamp="Hold" title="This exam is open on another device" body="Ask the invigilator. If you changed devices, the invigilator can re-admit you on this one. Your saved answers are safe." />;
  if (session.kind === 'expired') return <FullScreenNotice tone="note" stamp="Closed" title="Time is over" body="The server has closed this attempt and sealed the answers it had received. You do not need to do anything else." />;
  if (session.kind === 'error') return <FullScreenNotice tone="fix" stamp="Paused" title="The exam could not be opened" body={session.detail ?? 'Try again in a moment, or ask the invigilator.'} action={<Button variant="primary" onClick={() => window.location.reload()}>Try again</Button>} />;
  if (!questions.length) return <FullScreenNotice tone="fix" stamp={paper.isError ? 'Unavailable' : 'Opening'} title="Opening your question paper" body={paper.isError ? 'The approved paper could not be loaded. Retry or ask the invigilator. Your saved answers are safe.' : 'Waiting for the server to release your approved question paper.'} action={paper.isError ? <Button onClick={() => void paper.refetch()}>Retry paper</Button> : undefined} />;

  return (
    <div className="min-h-dvh flex flex-col bg-paper">
      {session.kind === 'paused' ? <PausedOverlay /> : null}
      <header className="border-b border-rule bg-sheet">
        <div className="mx-auto max-w-350 px-4 sm:px-6 h-16 flex items-center gap-6">
          <div className="min-w-0 flex-1">
            <p className="font-serif text-xl truncate" style={{ fontVariationSettings: "'opsz' 36" }}>
              {examTitle}
            </p>
            <p className="text-sm text-ink-2">
              {current.label} of {questions.length}
            </p>
          </div>
          <Timer deadlineAt={session.deadlineAt} sync={session.sync} onExpired={onExpired} />
          <StatusChip tone={SAVE_LABEL[overall].tone} className="hidden sm:inline-flex" title={session.kind === 'offline' ? 'Connection lost; answers are kept on this device' : undefined}>
            {session.kind === 'offline' && overall !== 'recovery' ? 'Saved locally' : SAVE_LABEL[overall].text}
          </StatusChip>
        </div>
      </header>

      {session.kind === 'offline' ? (
        <p className="bg-fix-soft text-fix text-sm px-6 py-2 text-center" role="status">
          Connection lost. Keep writing — your answers stay on this device and sync as soon as the connection returns.
        </p>
      ) : null}
      {overall === 'recovery' && session.kind !== 'offline' ? (
        <p className="bg-stop-soft text-stop text-sm px-6 py-2 text-center" role="alert">
          Saving to the server has failed for over 30 seconds. Your answers are kept on this device; raise your hand so the invigilator can help.
        </p>
      ) : null}
      {timeOver ? (
        <p className="bg-note-soft text-note text-sm px-6 py-2 text-center" role="alert">
          Time is over. Your answers are being sealed; you do not need to do anything.
        </p>
      ) : null}

      <div className="flex-1 mx-auto w-full max-w-350 px-4 sm:px-6 py-6 grid gap-8 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <nav aria-label="Questions" className="lg:sticky lg:top-6 self-start">
          <ol className="flex lg:flex-col gap-1 overflow-x-auto">
            {questions.map((q, i) => {
              const qs = snap.questions[q.id];
              const answered = qs?.answered ?? false;
              const unsynced = snap.unsynced.includes(q.id);
              const flagged = flags.has(q.id);
              const isCurrent = i === index;
              const state = [answered ? 'answered' : 'not answered', flagged ? 'flagged for review' : null, unsynced ? 'not yet saved to server' : null].filter(Boolean).join(', ');
              return (
                <li key={q.id}>
                  <button
                    type="button"
                    onClick={() => setIndex(i)}
                    aria-current={isCurrent ? 'true' : undefined}
                    aria-label={`${q.label}, ${state}`}
                    className={cn('w-full flex items-center gap-3 px-3 py-2 rounded-md text-left border', isCurrent ? 'border-ink bg-sheet' : 'border-transparent hover:bg-sheet-2')}
                  >
                    <span className={cn('font-mono tabular text-sm w-6 text-center rounded-sm border', answered ? 'bg-ink text-paper border-ink' : 'border-rule-2 text-ink-2')}>{i + 1}</span>
                    <span className="text-sm text-ink-2 flex-1 truncate">{flagged ? 'Flagged' : answered ? 'Answered' : '—'}</span>
                    {q.maxMarks ? <span className="text-[11px] font-mono text-ink-3">{q.maxMarks}m</span> : null}
                    {unsynced ? <span className="size-1.5 rounded-full bg-fix" aria-hidden="true" /> : null}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        <section aria-labelledby="q-heading" className="min-w-0 max-w-[76ch]">
          <div className="flex items-baseline justify-between gap-4 mb-4">
            <div className="flex items-center gap-3">
              <h1 id="q-heading" className="text-h2">
                {current.label}
              </h1>
              {current.maxMarks ? (
                <span className="text-xs font-mono px-2 py-0.5 rounded border border-rule-2 bg-sheet-2 text-ink-2">
                  {current.maxMarks} marks
                </span>
              ) : null}
            </div>
            <StatusChip tone={SAVE_LABEL[snap.questions[current.id]?.state ?? 'empty'].tone} icon={false} className="sm:hidden">
              {SAVE_LABEL[snap.questions[current.id]?.state ?? 'empty'].text}
            </StatusChip>
          </div>
          {current.prompt ? (
            <div className="sheet p-4 mb-4 border border-rule-2 rounded-md bg-sheet-2 text-ink whitespace-pre-wrap leading-relaxed text-[15px] select-none">
              {current.prompt.blocks.map((b, i) => <div key={i}>{typeof b['text'] === 'string' ? b['text'] : typeof b['content'] === 'string' ? b['content'] : ''}</div>)}
            </div>
          ) : null}
          {Array.isArray(current.options) && current.options.length > 0 ? (
            <div className="mb-4 space-y-2">
              {(current.options as Array<{ key: string; text: string }>).map((opt, idx: number) => (
                <div key={idx} className="p-3 border border-rule-2 rounded bg-sheet text-sm flex items-start gap-2">
                  <span className="font-semibold text-ink-2">{String.fromCharCode(65 + idx)}.</span>
                  <span>{opt.text}</span>
                </div>
              ))}
            </div>
          ) : null}
          <p className="text-ink-2 mb-6">Write your answer below. Paragraphs and diagrams can be mixed in any order; everything is saved as you go.</p>
          {session.kind === 'connecting' && !sync.isLoaded(current.id) ? <p className="text-ink-2 mb-4">Opening your saved answers…</p> : null}
          <AnswerEditor questionId={current.id} doc={doc} placeholderId={placeholderId} onChange={onChange} disabled={disabled} onExternalPaste={() => {
              // Logged locally, never reported as a signal: pasting is refused, not punished.
              console.info('[examos] paste from outside the workspace was refused');
              toast({ tone: 'info', title: 'Pasting from outside the exam is not allowed', description: 'Text copied inside this workspace can still be pasted.' });
            }} />
        </section>
      </div>

      <footer className="sticky bottom-0 border-t border-rule bg-sheet">
        <div className="mx-auto max-w-350 px-4 sm:px-6 h-16 flex items-center gap-2">
          <Button onClick={() => setIndex((i) => Math.max(0, i - 1))} disabled={index === 0}>
            Previous
          </Button>
          <Button variant={flags.has(current.id) ? 'secondary' : 'ghost'} aria-pressed={flags.has(current.id)} onClick={toggleFlag}>
            {flags.has(current.id) ? 'Flagged for review' : 'Flag for review'}
          </Button>
          <Button
            onClick={() => {
              void sync.flush(current.id);
              setIndex((i) => Math.min(questions.length - 1, i + 1));
            }}
            disabled={index >= questions.length - 1 && disabled}
          >
            Save &amp; Next
          </Button>
          <div className="flex-1" />
          <Button variant="primary" onClick={() => setSubmitOpen(true)} disabled={session.kind === 'connecting'}>
            Submit
          </Button>
        </div>
      </footer>

      <Dialog
        open={submitOpen}
        onClose={() => (submitting ? undefined : setSubmitOpen(false))}
        title="Submit your answers?"
        description="Submission seals every answer the server has received. You cannot edit after this."
        size="sm"
        dismissable={!submitting}
        footer={
          <>
            <Button variant="ghost" onClick={() => setSubmitOpen(false)} disabled={submitting}>
              Keep writing
            </Button>
            <Button variant="primary" onClick={() => void submit()} loading={submitting} disabled={!editing || timeOver} data-autofocus>
              Submit exam
            </Button>
          </>
        }
      >
        <ul className="text-[15px] space-y-2">
          <li>
            {questions.filter((q) => snap.questions[q.id]?.answered).length} of {questions.length} questions have an answer.
          </li>
          {flags.size ? <li>Flagged for review: {[...flags].map((id) => questions.find((q) => q.id === id)?.label ?? id).join(', ')}.</li> : null}
          {unsyncedLabels.length ? (
            <li className="text-fix">Still syncing: {unsyncedLabels.join(', ')}. Submission waits until all answers are saved to the server.</li>
          ) : (
            <li className="text-ready">Everything is saved to the server.</li>
          )}
        </ul>
      </Dialog>
    </div>
  );
}

function PausedOverlay() {
  return (
    <div className="fixed inset-0 z-40 bg-paper/95 grid place-items-center p-6" role="alertdialog" aria-modal="true" aria-labelledby="paused-title" aria-describedby="paused-body">
      <div className="max-w-md text-center">
        <Stamp tone="fix" className="text-3xl">
          Paused
        </Stamp>
        <h2 id="paused-title" className="text-h2 mt-6">
          Paused by the invigilator
        </h2>
        <p id="paused-body" className="mt-3 text-ink-2">
          Your answers are saved. Wait for the invigilator; the exam resumes here automatically when they say so.
        </p>
      </div>
    </div>
  );
}

function FullScreenNotice({ tone, stamp, title, body, action }: { tone: Tone; stamp: string; title: string; body: string; action?: ReactNode }) {
  return (
    <main className="min-h-dvh grid place-items-center p-6">
      <div className="max-w-md text-center">
        <Stamp tone={tone === 'neutral' ? 'note' : tone} className="text-3xl">
          {stamp}
        </Stamp>
        <h1 className="text-h2 mt-6">{title}</h1>
        <p className="mt-3 text-ink-2">{body}</p>
        <div className="mt-6 flex justify-center gap-2">
          {action}
          <LinkButton to="/student">Back to my exams</LinkButton>
        </div>
      </div>
    </main>
  );
}

function SealedScreen({ receipt, tz, examTitle }: { receipt: SubmitReceipt | null; tz: string; examTitle: string }) {
  return (
    <main className="min-h-dvh grid place-items-center p-6">
      <div className="max-w-lg w-full">
        <div className="text-center">
          <Stamp tone="accent" className="text-3xl">
            Submitted
          </Stamp>
          <h1 className="text-h2 mt-6">Your answers are sealed</h1>
          <p className="mt-2 text-ink-2">{examTitle}. Keep the receipt number; it is your proof of submission.</p>
        </div>
        {receipt ? (
          <div className="sheet p-5 mt-8">
            <KeyValue items={[{ k: 'Receipt', v: receipt.receiptId, mono: true }, { k: 'Manifest', v: receipt.manifestSha256, mono: true }, { k: 'Sealed at', v: formatDateTime(receipt.sealedAt, tz) }]} />
          </div>
        ) : (
          <p className="mt-8 text-center text-ink-2">This attempt was submitted earlier; its receipt was issued at that time.</p>
        )}
        <div className="mt-8 flex justify-center">
          <LinkButton to="/student" variant="primary">
            Back to my exams
          </LinkButton>
        </div>
      </div>
    </main>
  );
}
