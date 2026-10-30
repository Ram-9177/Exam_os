import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { isApiError, setDeviceSession } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime, formatTime } from '@/lib/time';
import { Badge, Button, EmptyState, PageTitle, Skeleton, StatusChip, useToast } from '@/ui';
import { EXAM_TYPE_LABEL, admit, requestEntryGrant, useLedger, useMyExams, type StudentExam } from './api';
import { HallTicketDrawer } from './HallTicketDrawer';

const LOBBY_POLL_MS = 10_000;

type Primary =
  | { kind: 'opens-at' }
  | { kind: 'start-readiness' }
  | { kind: 'lobby' }
  | { kind: 'enter' }
  | { kind: 'resume' }
  | { kind: 'paused' }
  | { kind: 'submitted' }
  | { kind: 'expired' }
  | { kind: 'voided' }
  | { kind: 'published' }
  | { kind: 'rerun-readiness'; why: string };

function primaryFor(e: StudentExam, published: boolean): Primary {
  if (published) return { kind: 'published' };
  switch (e.attemptStatus) {
    case 'SUBMITTED':
    case 'SUBMITTING':
      return { kind: 'submitted' };
    case 'EXPIRED':
      return { kind: 'expired' };
    case 'VOIDED_BY_AUTHORITY':
      return { kind: 'voided' };
    case 'ACTIVE':
    case 'RECOVERY_PENDING':
    case 'ADMITTED':
      return { kind: 'resume' };
    case 'SUSPENDED':
      return { kind: 'paused' };
    case 'READY':
      return e.examStatus === 'LIVE' ? { kind: 'enter' } : { kind: 'lobby' };
    case 'PRECHECK_AVAILABLE':
    case 'PRECHECK_RUNNING':
      return e.examStatus === 'PRECHECK' || e.examStatus === 'LIVE' ? { kind: 'start-readiness' } : { kind: 'opens-at' };
    case 'ALLOCATED':
    default:
      if (e.examStatus === 'CLOSED' || e.examStatus === 'ARCHIVED') return { kind: 'expired' };
      if (e.examStatus === 'CANCELLED') return { kind: 'voided' };
      return { kind: 'opens-at' };
  }
}

export function MyExamsPage() {
  const { me, user } = useAuth();
  const tz = me?.tenant.timezone ?? 'Asia/Kolkata';
  const ledger = useLedger();
  const publishedCodes = useMemo(() => new Set((ledger.data?.records ?? []).map((r) => r.examCode)), [ledger.data]);
  const [ticketFor, setTicketFor] = useState<StudentExam | null>(null);

  // Poll the list while any exam is in its lobby or live, so status changes made by the Examination Section arrive without a reload.
  const [polling, setPolling] = useState(false);
  const exams = useMyExams(polling ? LOBBY_POLL_MS : false);
  useEffect(() => {
    const list = exams.data?.exams ?? [];
    setPolling(list.some((e) => ['PRECHECK', 'LIVE'].includes(e.examStatus) && !['SUBMITTED', 'EXPIRED', 'VOIDED_BY_AUTHORITY'].includes(e.attemptStatus ?? '')));
  }, [exams.data]);

  const list = exams.data?.exams ?? [];
  const now = Date.now();
  const upcoming = list.filter((e) => Date.parse(e.windowEndAt) >= now || ['ACTIVE', 'RECOVERY_PENDING', 'SUSPENDED', 'READY'].includes(e.attemptStatus ?? ''));
  const past = list.filter((e) => !upcoming.includes(e));

  return (
    <div className="max-w-4xl">
      <PageTitle title="My exams" kicker={user?.fullName ?? me?.email} lede="Each exam shows exactly one next step. The exam timer starts only after you are admitted." />

      {exams.isLoading ? <Skeleton lines={5} /> : null}
      {exams.isError ? <EmptyState title="Your exam list could not be loaded">Check your connection and reload the page. If this keeps happening, tell the Examination Section desk.</EmptyState> : null}
      {exams.data && list.length === 0 ? <EmptyState title="No exams are allocated to you yet">When the Examination Section allocates you to an exam it appears here with its hall ticket.</EmptyState> : null}

      {upcoming.length > 0 ? (
        <section aria-labelledby="upcoming">
          <h2 id="upcoming" className="visually-hidden">
            Upcoming
          </h2>
          <ul className="hairline-rows border-y border-rule">
            {upcoming.map((e) => (
              <ExamRow key={e.examId} exam={e} tz={tz} primary={primaryFor(e, publishedCodes.has(e.code))} onTicket={() => setTicketFor(e)} />
            ))}
          </ul>
        </section>
      ) : null}

      {past.length > 0 ? (
        <section aria-labelledby="past" className="mt-12">
          <h2 id="past" className="text-h3 mb-3 text-ink-2">
            Earlier
          </h2>
          <ul className="hairline-rows border-y border-rule">
            {past.map((e) => (
              <ExamRow key={e.examId} exam={e} tz={tz} primary={primaryFor(e, publishedCodes.has(e.code))} onTicket={() => setTicketFor(e)} />
            ))}
          </ul>
        </section>
      ) : null}

      {ticketFor ? <HallTicketDrawer exam={ticketFor} open onClose={() => setTicketFor(null)} timeZone={tz} tenantName={me?.tenant.name ?? ''} /> : null}
    </div>
  );
}

function DateBlock({ iso, tz }: { iso: string; tz: string }) {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat('en-IN', { timeZone: tz, day: 'numeric' }).format(d);
  const mon = new Intl.DateTimeFormat('en-IN', { timeZone: tz, month: 'short' }).format(d);
  const wd = new Intl.DateTimeFormat('en-IN', { timeZone: tz, weekday: 'short' }).format(d);
  return (
    <div className="w-16 shrink-0 text-center sm:text-left">
      <p className="font-serif text-4xl leading-none tabular" style={{ fontVariationSettings: "'opsz' 72" }}>
        {day}
      </p>
      <p className="text-sm text-ink-2 mt-1">
        {mon} · {wd}
      </p>
    </div>
  );
}

function ExamRow({ exam, tz, primary, onTicket }: { exam: StudentExam; tz: string; primary: Primary; onTicket: () => void }) {
  return (
    <li className="py-5 flex flex-col sm:flex-row gap-4 sm:gap-6">
      <DateBlock iso={exam.windowStartAt} tz={tz} />
      <div className="flex-1 min-w-0">
        <h3 className="text-h3">{exam.title}</h3>
        <p className="text-ink-2 mt-0.5">
          {exam.courseCode ? `${exam.courseCode} · ` : ''}
          {exam.courseName ?? exam.code}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[15px]">
          <Badge>{EXAM_TYPE_LABEL[exam.examType]}</Badge>
          <span>
            {formatTime(exam.windowStartAt, tz)} to {formatTime(exam.windowEndAt, tz)}
          </span>
          <span className="text-ink-2">
            {exam.durationMinutes} min{exam.extraTimeMinutes ? ` + ${exam.extraTimeMinutes} extra` : ''}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 text-[15px]">
          <span className="text-ink-2">Hall ticket</span>
          <span className="font-mono tabular">{exam.hallTicketNumber ?? 'not issued yet'}</span>
          <button type="button" onClick={onTicket} className="text-accent underline underline-offset-4 decoration-rule-2 hover:decoration-accent rounded-sm">
            View hall ticket
          </button>
        </div>
        {exam.securityProfile === 'SECURE_BYOD' || exam.securityProfile === 'MANAGED_ENDPOINT' ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge tone="accent">Safe Exam Browser</Badge>
            <a
              href={`/api/v1/student/me/exams/${exam.examId}/seb-config`}
              download={`smru-exam-${exam.code}.seb`}
              className="text-xs text-accent underline underline-offset-2 hover:text-ink font-medium"
            >
              Download .seb configuration
            </a>
          </div>
        ) : null}
      </div>
      <div className="sm:w-64 shrink-0 flex flex-col items-stretch sm:items-end gap-2">
        <PrimaryAction exam={exam} primary={primary} tz={tz} />
      </div>
    </li>
  );
}

function PrimaryAction({ exam, primary, tz }: { exam: StudentExam; primary: Primary; tz: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [lobbyNote, setLobbyNote] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const attemptId = exam.attemptId;
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Lobby: ask for an entry grant every 10 s; 409 EXAM_NOT_STARTED simply means keep waiting.
  useEffect(() => {
    if (primary.kind !== 'lobby' || !attemptId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        await requestEntryGrant(attemptId);
        if (!cancelled) {
          setStarted(true);
          void qc.invalidateQueries({ queryKey: ['student', 'exams'] });
        }
      } catch (e) {
        if (cancelled) return;
        if (isApiError(e, 'EXAM_NOT_STARTED')) setLobbyNote(null);
        else if (isApiError(e, 'PRECHECK_STALE') || isApiError(e, 'POLICY_CHANGED')) setLobbyNote('Your readiness check has expired. Run it again before the exam starts.');
        else if (isApiError(e, 'NOT_READY')) setLobbyNote(null);
      }
    };
    void tick();
    timer.current = setInterval(() => void tick(), LOBBY_POLL_MS);
    return () => {
      cancelled = true;
      if (timer.current) clearInterval(timer.current);
    };
  }, [primary.kind, attemptId, qc]);

  const enter = async () => {
    if (!attemptId) return;
    setBusy(true);
    try {
      const grant = await requestEntryGrant(attemptId);
      const admitted = await admit(attemptId, grant.grantToken);
      setDeviceSession(admitted.deviceSessionId);
      sessionStorage.setItem(`examos.admit.${attemptId}`, JSON.stringify({ serverNow: admitted.serverNow, deadlineAt: admitted.deadlineAt, receivedAt: Date.now() }));
      navigate(`/student/attempts/${attemptId}/exam`);
    } catch (e) {
      if (isApiError(e, 'PRECHECK_STALE') || isApiError(e, 'POLICY_CHANGED')) toast({ tone: 'warning', title: 'Run the readiness check again', description: 'It expired before the exam started. This is not counted against you.' });
      else if (isApiError(e, 'ALREADY_ACTIVE')) navigate(`/student/attempts/${attemptId}/exam`);
      else if (isApiError(e, 'EXAM_NOT_STARTED')) toast({ tone: 'info', title: 'Not started yet', description: 'The Examination Section has not started the exam. Keep this page open.' });
      else toast({ tone: 'warning', title: 'Could not enter the exam', description: 'Ask the invigilator for help; your readiness is recorded.' });
    } finally {
      setBusy(false);
    }
  };

  switch (primary.kind) {
    case 'opens-at':
      return (
        <>
          <Button disabled size="lg">
            Readiness check opens at {formatTime(exam.windowStartAt, tz)}
          </Button>
          <p className="text-sm text-ink-2 sm:text-right">{formatDateTime(exam.windowStartAt, tz)}. The Examination Section may open it up to two hours earlier.</p>
        </>
      );
    case 'start-readiness':
      return (
        <>
          <Button variant="primary" size="lg" onClick={() => navigate(`/student/attempts/${attemptId}/readiness`)}>
            Start readiness check
          </Button>
          <p className="text-sm text-ink-2 sm:text-right">About 15 minutes. The exam timer does not run during it.</p>
        </>
      );
    case 'lobby':
      return started ? (
        <>
          <Button variant="primary" size="lg" onClick={() => void enter()} loading={busy}>
            Enter exam
          </Button>
          <p className="text-sm text-ink-2 sm:text-right">The exam has started. Your timer begins when you enter.</p>
        </>
      ) : (
        <>
          <StatusChip tone="ready" className="self-start sm:self-end">
            Ready
          </StatusChip>
          <p className="text-[15px] sm:text-right" role="status">
            Waiting for the Examination Section to start the exam
          </p>
          {lobbyNote ? (
            <>
              <p className="text-sm text-fix sm:text-right">{lobbyNote}</p>
              <Button size="sm" onClick={() => navigate(`/student/attempts/${attemptId}/readiness`)}>
                Run readiness check again
              </Button>
            </>
          ) : (
            <p className="text-sm text-ink-2 sm:text-right">Keep this page open; it checks every few seconds.</p>
          )}
        </>
      );
    case 'enter':
      return (
        <>
          <Button variant="primary" size="lg" onClick={() => void enter()} loading={busy}>
            Enter exam
          </Button>
          <p className="text-sm text-ink-2 sm:text-right">Your timer begins when you enter.</p>
        </>
      );
    case 'resume':
      return (
        <>
          <Button variant="primary" size="lg" onClick={() => navigate(`/student/attempts/${attemptId}/exam`)}>
            Return to exam
          </Button>
          <p className="text-sm text-ink-2 sm:text-right">Your answers are saved as you go.</p>
        </>
      );
    case 'paused':
      return (
        <>
          <StatusChip tone="fix" className="self-start sm:self-end">
            Paused by the invigilator
          </StatusChip>
          <Button size="lg" onClick={() => navigate(`/student/attempts/${attemptId}/exam`)}>
            Open exam
          </Button>
          <p className="text-sm text-ink-2 sm:text-right">Your answers are saved. Wait for the invigilator.</p>
        </>
      );
    case 'rerun-readiness':
      return (
        <>
          <Button variant="primary" size="lg" onClick={() => navigate(`/student/attempts/${attemptId}/readiness`)}>
            Run readiness check again
          </Button>
          <p className="text-sm text-ink-2 sm:text-right">{primary.why}</p>
        </>
      );
    case 'submitted':
      return (
        <StatusChip tone="accent" className="self-start sm:self-end">
          Submitted
        </StatusChip>
      );
    case 'expired':
      return (
        <>
          <StatusChip tone="note" className="self-start sm:self-end">
            Closed
          </StatusChip>
          <p className="text-sm text-ink-2 sm:text-right">The exam window has closed.</p>
        </>
      );
    case 'voided':
      return (
        <>
          <StatusChip tone="stop" className="self-start sm:self-end">
            Cancelled
          </StatusChip>
          <p className="text-sm text-ink-2 sm:text-right">Contact the Examination Section if this is unexpected.</p>
        </>
      );
    case 'published':
      return (
        <>
          <StatusChip tone="accent" className="self-start sm:self-end">
            Result published
          </StatusChip>
          <Button variant="primary" size="lg" onClick={() => navigate(`/student/attempts/${attemptId}/booklet`)}>
            Open booklet
          </Button>
        </>
      );
    default:
      return null;
  }
}
