import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useParams } from 'react-router';
import type { PaperQuestionInput, PaperSection } from '@examos/contracts';
import { useQuery } from '@tanstack/react-query';
import { api, isApiError, timeoutSignal } from '@/lib/api';
import { collectDeviceScan } from '@/lib/device-scan';
import { useAuth } from '@/lib/auth';
import { INTERNAL_MIME, type AnswerDoc } from '@/lib/answers';
import { uuid } from '@/lib/ids';
import { SignalReporter } from '@/lib/signals';
import { AnswerSync, type QuestionSyncState, type SyncTransport } from '@/lib/sync';
import { formatDateTime, remainingMs } from '@/lib/time';
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

const SCAN_INTERVAL_MS = 60_000;
const SCAN_NOTICE: Record<string, string> = {
  MULTIPLE_DISPLAYS: 'A second display is connected. Disconnect it and keep working; the invigilator has been informed.',
  SCREEN_SHARING_ACTIVE: 'Screen sharing is active. Stop it and keep working; the invigilator has been informed.',
  AUTOMATION_CONTROLLED: 'This browser is under automation control. Close automation tools and keep working; the invigilator has been informed.',
  VIRTUAL_MACHINE_SUSPECTED: 'This looks like a virtual machine. Keep working; the invigilator has been informed and may come to check.',
  FULLSCREEN_UNSUPPORTED: 'Full-screen mode is not available in this browser. Keep working; the invigilator has been informed.',
  COOKIES_DISABLED: 'Cookies are disabled in this browser. Keep working; the invigilator has been informed.',
};
function scanNoticeFor(findings: string[]): string {
  return SCAN_NOTICE[findings[0] ?? ''] ?? 'Your device settings need attention. Keep working; the invigilator has been informed.';
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
      // A dead socket surfaces as NETWORK within 15 s and is retried with the same clientOperationId.
      save: (q, body) => api.put(`/student/attempts/${attemptId}/answers/${q}`, body, { quiet: SAVE_QUIET, signal: timeoutSignal(15_000) }),
      load: (q) => api.get(`/student/attempts/${attemptId}/answers/${q}`, { quiet: ['NETWORK'], signal: timeoutSignal(15_000) }),
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
  // Drafts kept on this device across a reload/crash: say so, show which questions, and let the student push them now.
  const restored = useMemo(() => sync.restoredDraftIds(), [sync]);
  const [restoredDismissed, setRestoredDismissed] = useState(false);
  const restoredPending = restored.filter((id) => snap.unsynced.includes(id));

  // Pull server truth for every question once the session is live, keeping any unsynced local draft.
  useEffect(() => {
    if (session.kind !== 'active') return;
    for (const q of questions) {
      if (!sync.isLoaded(q.id)) {
        void sync.load(q.id).catch(() => undefined);
      }
    }
  }, [session.kind, questions, sync]);


  // ---------- periodic system scan (evidence for a human; the student is told what to fix) ----------
  const [scanNotice, setScanNotice] = useState<string | null>(null);
  useEffect(() => {
    if (session.kind !== 'active') return;
    let cancelled = false;
    const run = async () => {
      try {
        const scan = await collectDeviceScan();
        const out = await api.post<{ verdict: 'CLEAN' | 'REVIEW' | 'BLOCKED'; findings: string[] }>(`/student/attempts/${attemptId}/device-scans`, { scan }, { quiet: true });
        if (!cancelled) setScanNotice(out.verdict === 'BLOCKED' ? scanNoticeFor(out.findings) : null);
      } catch {
        /* a failed scan is a technical gap, never a mark against the student */
      }
    };
    void run();
    const timer = setInterval(() => void run(), SCAN_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [attemptId, session.kind]);

  // ---------- proctor signals & real-time monitoring ----------
  const [tabSwitchCount, setTabSwitchCount] = useState(0);
  const [tabWarningModal, setTabWarningModal] = useState<{ count: number; time: string; reason: string } | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenWarning, setFullscreenWarning] = useState(false);
  const [cameraActive, setCameraActive] = useState<boolean | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [showCameraWidget, setShowCameraWidget] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const reporter = useMemo(() => new SignalReporter({ attemptId }), [attemptId]);

  useEffect(() => {
    if (session.kind !== 'active') return;
    let active = true;

    async function initCamera() {
      try {
        if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
          setCameraActive(false);
          setCameraError('Webcam is not available on this device');
          return;
        }
        const s = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 320 }, height: { ideal: 240 }, facingMode: 'user' },
          audio: false,
        });
        if (!active) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = s;
        setCameraActive(true);
        setCameraError(null);
        if (videoRef.current) {
          videoRef.current.srcObject = s;
        }
      } catch (err: any) {
        if (!active) return;
        setCameraActive(false);
        const msg = err.name === 'NotAllowedError' ? 'Camera permission was denied. Please allow camera in browser.' : (err.message || 'Camera offline');
        setCameraError(msg);
        reporter.report('CAMERA_UNAVAILABLE', { reason: err.name || 'error' });
      }
    }

    void initCamera();

    return () => {
      active = false;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
    };
  }, [session.kind, reporter]);

  useEffect(() => {
    if (videoRef.current && streamRef.current && cameraActive) {
      videoRef.current.srcObject = streamRef.current;
    }
  }, [cameraActive, showCameraWidget]);

  useEffect(() => {
    if (session.kind !== 'active') return;

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        setTabSwitchCount((prev) => {
          const next = prev + 1;
          reporter.report('FOCUS_LOST', { reason: 'tab_switched', count: next });
          return next;
        });
      } else if (document.visibilityState === 'visible') {
        setTabSwitchCount((c) => {
          if (c > 0) {
            setTabWarningModal({
              count: c,
              time: new Date().toLocaleTimeString(),
              reason: 'Tab Switch / Background Transition',
            });
          }
          return c;
        });
      }
    };

    const isJsdom = typeof navigator !== 'undefined' && navigator.userAgent.includes('jsdom');

    const onBlur = () => {
      if (isJsdom) return;
      if (typeof document !== 'undefined' && document.hasFocus && !document.hasFocus()) {
        if (document.activeElement?.tagName === 'IFRAME') return;
        setTabSwitchCount((prev) => {
          const next = prev + 1;
          reporter.report('FOCUS_LOST', { reason: 'window_blur', count: next });
          return next;
        });
      }
    };

    const onFocus = () => {
      if (isJsdom) return;
      setTabSwitchCount((c) => {
        if (c > 0) {
          setTabWarningModal({
            count: c,
            time: new Date().toLocaleTimeString(),
            reason: 'Window Focus Lost / App Switch',
          });
        }
        return c;
      });
    };

    const onFullscreen = () => {
      const isFs = typeof document !== 'undefined' && !!document.fullscreenElement;
      setIsFullscreen(isFs);
      if (!isFs && session.kind === 'active') {
        setFullscreenWarning(true);
        reporter.report('FULLSCREEN_EXIT', { at: new Date().toISOString() });
      }
    };

    const onContextMenu = (e: MouseEvent) => e.preventDefault();
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
        if (isDevTools) reporter.report('DEVTOOLS_ATTEMPT', { key: e.key });
      }
    };

    const onGlobalPaste = (e: ClipboardEvent) => {
      const types = e.clipboardData ? Array.from(e.clipboardData.types) : [];
      if (!types.includes(INTERNAL_MIME)) {
        e.preventDefault();
        e.stopPropagation();
        reporter.report('CLIPBOARD_ATTEMPT', { action: 'paste', source: 'external' });
        toast({
          tone: 'error',
          title: '⛔ External paste blocked & logged',
          description: 'Pasting from external applications is strictly prohibited. This incident has been logged in the proctor audit trail.',
        });
      }
    };

    const onGlobalDrop = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      reporter.report('CLIPBOARD_ATTEMPT', { action: 'drop', source: 'external' });
      toast({
        tone: 'error',
        title: '⛔ Drag & drop blocked',
        description: 'Dragging content into the exam is prohibited.',
      });
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    document.addEventListener('fullscreenchange', onFullscreen);
    document.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('keydown', onKeyDown, { capture: true });
    window.addEventListener('paste', onGlobalPaste, { capture: true });
    window.addEventListener('drop', onGlobalDrop, { capture: true });
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('fullscreenchange', onFullscreen);
      document.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      window.removeEventListener('paste', onGlobalPaste, { capture: true });
      window.removeEventListener('drop', onGlobalDrop, { capture: true });
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
  // A deadline moved later (proctor extension, corrected clock) re-opens the editor; nothing stays locked on a stale local verdict.
  useEffect(() => {
    if (timeOver && remainingMs(session.deadlineAt, session.sync) > 5_000) setTimeOver(false);
  }, [timeOver, session.deadlineAt, session.sync]);
  // Last call: push whatever is unsaved ten seconds before the deadline so the final words are acknowledged in time.
  const lastCallFor = useRef<string | null>(null);
  useEffect(() => {
    if (!session.deadlineAt || session.kind !== 'active') return;
    const left = remainingMs(session.deadlineAt, session.sync);
    if (left <= 0 || lastCallFor.current === session.deadlineAt) return;
    const t = setTimeout(() => {
      lastCallFor.current = session.deadlineAt;
      void sync.flushAll();
    }, Math.max(0, left - 10_000));
    return () => clearTimeout(t);
  }, [session.deadlineAt, session.sync, session.kind, sync]);
  // Pause/resume follows the server: every heartbeat that reports ACTIVE lifts a pause (a refused save during a
  // recovery, a reconnect that restored the attempt), not only a change of session kind.
  useEffect(() => {
    if (session.kind === 'paused' || session.kind === 'device-mismatch' || session.kind === 'sealed' || session.kind === 'expired' || session.kind === 'voided') sync.pause(session.kind);
    else if (session.kind === 'active' && sync.isPaused() && !timeOver) sync.resume();
  }, [session.kind, session.sync, sync, timeOver]);

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
  // The server reports the seal receipt through the heartbeat once an attempt is sealed (submitted or expired).
  useEffect(() => {
    if (!session.receipt || receipt) return;
    try {
      sessionStorage.setItem(`examos.receipt.${attemptId}`, JSON.stringify(session.receipt));
    } catch {
      /* memory copy is enough */
    }
    setReceipt(session.receipt);
  }, [session.receipt, receipt, attemptId]);
  const submit = async () => {
    setSubmitting(true);
    try {
      await Promise.race([sync.flushAll(), new Promise((r) => setTimeout(r, 8000))]);
      if (sync.unsyncedQuestionIds().length && !timeOver) {
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
      } else if (isApiError(e, 'ATTEMPT_STATE')) {
        toast({ tone: 'warning', title: 'Cannot submit right now', description: e.problem.title });
      } else {
        const desc = (e as any)?.problem?.detail || (e as any)?.problem?.title || (e as any)?.message || 'Submission could not be completed. Please try again.';
        toast({ tone: 'error', title: 'Submission failed', description: desc });
      }
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
  if (session.kind === 'voided') return <FullScreenNotice tone="stop" stamp="Closed" title="This attempt was closed by the Examination Section" body="Contact the Examination Section desk. Your saved answers are kept." />;
  if (session.kind === 'expired') {
    const sealed = receipt ?? session.receipt;
    return <FullScreenNotice tone="note" stamp="Closed" title="Time is over" body={sealed ? `The server sealed the answers it had received before the deadline at ${formatDateTime(sealed.sealedAt, tz)}. Receipt ${sealed.receiptId}. You do not need to do anything else.` : 'The server is sealing the answers it received before the deadline; your receipt appears here within a minute. You do not need to do anything else.'} />;
  }
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
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'hidden md:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border select-none',
                tabSwitchCount === 0 ? 'bg-ready-soft text-ready border-ready/40' : 'bg-stop-soft text-stop border-stop/40'
              )}
              title="Tab switches & window focus losses recorded"
            >
              <span className={cn('h-1.5 w-1.5 rounded-full', tabSwitchCount === 0 ? 'bg-ready' : 'bg-stop animate-ping')} />
              Tab switches: {tabSwitchCount}
            </span>
            <span
              className={cn(
                'hidden md:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border select-none',
                cameraActive ? 'bg-ready-soft text-ready border-ready/40' : 'bg-stop-soft text-stop border-stop/40'
              )}
            >
              <span className={cn('h-1.5 w-1.5 rounded-full', cameraActive ? 'bg-ready animate-pulse' : 'bg-stop')} />
              {cameraActive ? 'Camera Live' : 'Camera Disconnected'}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                if (!document.fullscreenElement) {
                  try {
                    await document.documentElement.requestFullscreen();
                    setIsFullscreen(true);
                  } catch {
                    /* denied */
                  }
                } else {
                  try {
                    await document.exitFullscreen();
                    setIsFullscreen(false);
                  } catch {
                    /* ignore */
                  }
                }
              }}
              title="Toggle Fullscreen Proctored Mode"
              className="hidden sm:inline-flex items-center gap-1 text-xs"
            >
              {isFullscreen ? 'Exit Fullscreen' : '⛶ Fullscreen'}
            </Button>
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
      {snap.paused && session.kind === 'active' && !timeOver ? (
        <p className="bg-fix-soft text-fix text-sm px-6 py-2 text-center flex flex-wrap items-center justify-center gap-x-3 gap-y-1" role="alert">
          <span>Saving is paused while the server re-admits this session. Your answers stay on this device.</span>
          <Button size="sm" onClick={() => void heartbeatRef.current()}>
            Try again
          </Button>
        </p>
      ) : null}
      {scanNotice ? (
        <p className="bg-fix-soft text-fix text-sm px-6 py-2 text-center" role="alert">
          {scanNotice}
        </p>
      ) : null}
      {restored.length > 0 && !restoredDismissed ? (
        <p className="bg-accent-soft text-ink text-sm px-6 py-2 text-center flex flex-wrap items-center justify-center gap-x-3 gap-y-1" role="status">
          <span>
            Restored {restored.length} unsaved {restored.length === 1 ? 'answer' : 'answers'} kept on this device ({restored.map((id) => questions.find((q) => q.id === id)?.label ?? id).join(', ')}).
            {restoredPending.length ? ' Sending to the server now.' : ' All saved to the server.'}
          </span>
          {restoredPending.length ? (
            <Button size="sm" onClick={() => void sync.flushAll()}>
              Retry now
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setRestoredDismissed(true)}>
              Dismiss
            </Button>
          )}
        </p>
      ) : null}
      {overall === 'recovery' && session.kind !== 'offline' ? (
        <p className="bg-stop-soft text-stop text-sm px-6 py-2 text-center flex flex-wrap items-center justify-center gap-x-3 gap-y-1" role="alert">
          <span>Saving to the server has failed for over 30 seconds. Your answers are kept on this device; raise your hand so the invigilator can help.</span>
          <Button size="sm" variant="danger" onClick={() => void sync.flushAll()}>
            Retry saving now
          </Button>
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
          <AnswerEditor
            questionId={current.id}
            doc={doc}
            placeholderId={placeholderId}
            onChange={onChange}
            disabled={disabled}
            onExternalPaste={() => {
              reporter.report('CLIPBOARD_ATTEMPT', { action: 'paste', source: 'external' });
              toast({
                tone: 'error',
                title: '⛔ External paste blocked & logged',
                description: 'Pasting from external applications is strictly prohibited. This incident has been logged in the proctor audit trail.',
              });
            }}
          />
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
            <Button variant="primary" onClick={() => void submit()} loading={submitting} disabled={!(editing || timeOver) || submitting} data-autofocus>
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
            <li className="text-fix">{timeOver ? `Changes made after the deadline to ${unsyncedLabels.join(', ')} could not be saved; everything the server acknowledged before the deadline is sealed.` : `Still syncing: ${unsyncedLabels.join(', ')}. Submission waits until all answers are saved to the server.`}</li>
          ) : (
            <li className="text-ready">Everything is saved to the server.</li>
          )}
        </ul>
      </Dialog>

      {/* Live Proctor Camera Feed Widget */}
      {showCameraWidget && session.kind === 'active' ? (
        <aside
          role="complementary"
          aria-label="Live proctor webcam monitor"
          className="fixed bottom-20 right-4 z-40 bg-sheet/95 backdrop-blur-md border border-rule-2 rounded-md shadow-2xl overflow-hidden w-44 sm:w-52 transition-all select-none"
        >
          <div className="flex items-center justify-between px-2.5 py-1 bg-sheet-2 border-b border-rule text-[11px] font-medium">
            <div className="flex items-center gap-1.5">
              <span className={cn('h-2 w-2 rounded-full', cameraActive ? 'bg-ready animate-pulse' : 'bg-stop')} />
              <span className="text-ink-2 font-mono uppercase tracking-wider text-[10px]">
                {cameraActive ? 'Live Proctor' : 'Camera Lost'}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setShowCameraWidget(false)}
              className="text-ink-3 hover:text-ink text-xs px-1 cursor-pointer"
              title="Minimize camera preview (monitoring continues in background)"
            >
              —
            </button>
          </div>
          <div className="relative aspect-4/3 bg-black/90 flex items-center justify-center overflow-hidden">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className={cn('w-full h-full object-cover -scale-x-100', !cameraActive && 'hidden')}
            />
            {!cameraActive ? (
              <div className="p-3 text-center text-xs text-paper-2">
                <p className="text-stop font-semibold text-[11px] mb-1">Camera Inactive</p>
                <p className="text-[10px] text-paper-3 mb-2 leading-tight">
                  {cameraError ?? 'Webcam feed required for live proctoring'}
                </p>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      if (!navigator.mediaDevices?.getUserMedia) return;
                      const s = await navigator.mediaDevices.getUserMedia({
                        video: { width: { ideal: 320 }, height: { ideal: 240 }, facingMode: 'user' },
                        audio: false,
                      });
                      streamRef.current = s;
                      setCameraActive(true);
                      setCameraError(null);
                      if (videoRef.current) videoRef.current.srcObject = s;
                    } catch (e: any) {
                      setCameraError(e.message || 'Access denied');
                    }
                  }}
                  className="px-2 py-0.5 rounded bg-sheet text-ink text-[10px] font-medium hover:bg-sheet-2 border border-rule cursor-pointer"
                >
                  Enable Camera
                </button>
              </div>
            ) : null}
          </div>
          <div className="px-2 py-1 bg-sheet-2 text-[10px] text-ink-3 flex items-center justify-between font-mono">
            <span>Tab logs: {tabSwitchCount}</span>
            <span className="text-ready text-[9px] uppercase font-bold tracking-wider">AI Guard On</span>
          </div>
        </aside>
      ) : null}

      {!showCameraWidget && session.kind === 'active' ? (
        <button
          type="button"
          onClick={() => setShowCameraWidget(true)}
          className="fixed bottom-20 right-4 z-40 bg-sheet border border-rule-2 rounded-full shadow-lg px-3 py-1.5 text-xs text-ink flex items-center gap-1.5 hover:bg-sheet-2 cursor-pointer"
          aria-label="Restore camera preview"
        >
          <span className={cn('h-2 w-2 rounded-full', cameraActive ? 'bg-ready animate-pulse' : 'bg-stop')} />
          <span>Show Camera</span>
        </button>
      ) : null}

      {/* Proctor Tab Switch / Focus Loss Warning Modal */}
      {tabWarningModal ? (
        <div role="alertdialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4 animate-in fade-in">
          <div className="w-full max-w-md bg-sheet border-2 border-stop rounded-md shadow-2xl p-6 text-center animate-in zoom-in-95">
            <div className="w-12 h-12 rounded-full bg-stop/15 text-stop flex items-center justify-center mx-auto mb-3 text-2xl font-bold">
              ⚠️
            </div>
            <h3 className="text-lg font-serif font-bold text-ink mb-1">
              Proctor Warning: {tabWarningModal.reason}
            </h3>
            <p className="text-xs text-stop font-mono uppercase tracking-wider mb-3">
              Infraction #{tabWarningModal.count} Recorded at {tabWarningModal.time}
            </p>
            <p className="text-sm text-ink-2 mb-4 leading-relaxed">
              You navigated away from the exam workspace. Leaving the exam window, minimizing, or switching browser tabs is strictly monitored and has been logged to the Proctor Audit Trail.
            </p>
            <div className="p-3 bg-sheet-2 border border-rule rounded text-xs text-left mb-4 space-y-1 text-ink-3">
              <div>• <strong>Recorded Data:</strong> Timestamp, sequence number, and duration.</div>
              <div>• <strong>Threshold:</strong> Repeated infractions will be flagged directly to the proctoring committee.</div>
            </div>
            <Button
              variant="primary"
              className="w-full justify-center"
              onClick={() => setTabWarningModal(null)}
            >
              I Acknowledge &amp; Return to Exam
            </Button>
          </div>
        </div>
      ) : null}

      {/* Full Screen Mode Required Modal */}
      {fullscreenWarning ? (
        <div role="alertdialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4 animate-in fade-in">
          <div className="w-full max-w-md bg-sheet border-2 border-accent rounded-md shadow-2xl p-6 text-center animate-in zoom-in-95">
            <div className="w-12 h-12 rounded-full bg-accent/15 text-accent flex items-center justify-center mx-auto mb-3 text-2xl font-bold">
              ⛶
            </div>
            <h3 className="text-lg font-serif font-bold text-ink mb-1">
              Full Screen Mode Required
            </h3>
            <p className="text-sm text-ink-2 mb-4 leading-relaxed">
              Exiting full screen is flagged as an exam infraction. Please return to full screen mode to continue writing your exam.
            </p>
            <Button
              variant="primary"
              className="w-full justify-center"
              onClick={async () => {
                try {
                  await document.documentElement.requestFullscreen();
                } catch {
                  /* ignore */
                }
                setFullscreenWarning(false);
              }}
            >
              Return to Full Screen
            </Button>
          </div>
        </div>
      ) : null}
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
