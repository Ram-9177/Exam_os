import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ADMISSION_EXCEPTION_CODES, type PrecheckCheckCode } from '@examos/contracts';
import { api, isApiError } from '@/lib/api';
import { CHECK_LABELS } from '@/lib/readiness';
import { formatRelative, formatTime } from '@/lib/time';
import { Badge, Button, Checkbox, Dialog, EmptyState, Field, humanize, Select, Skeleton, StatusChip, Table, TextArea, TextInput, toneForAttempt, toneForPrecheckItem, useToast, type Column, type Tone } from '@/ui';
import { CHECK_SHORT, useReadinessBoard, type ReadinessCandidate } from './api';

const EXCEPTION_LABEL: Record<string, string> = {
  ACC_APPROVED: 'Approved accommodation',
  TECH_ALT_DEVICE: 'Alternative device (technical)',
  PROCTOR_OVERRIDE: 'Invigilator override',
  POLICY_INCOMPATIBILITY: 'Policy incompatibility',
};

function precheckTone(c: ReadinessCandidate): { tone: Tone; text: string } {
  if (['ACTIVE', 'ADMITTED'].includes(c.status)) return { tone: 'ready', text: 'In exam' };
  if (c.status === 'SUSPENDED') return { tone: 'fix', text: 'Paused' };
  if (['SUBMITTED', 'EXPIRED'].includes(c.status)) return { tone: 'accent', text: humanize(c.status) };
  if (!c.precheck) return { tone: 'neutral', text: 'Not started' };
  switch (c.precheck.status) {
    case 'READY':
      return { tone: 'ready', text: 'Ready' };
    case 'REMEDIATE':
      return { tone: 'fix', text: 'Needs fix' };
    case 'REVIEW':
      return { tone: 'stop', text: 'Needs review' };
    case 'RUNNING':
      return { tone: 'accent', text: 'Running' };
    default:
      return { tone: 'note', text: humanize(c.precheck.status) };
  }
}

/** Every candidate × every check, refreshed every 10 s. Nothing is admitted that is not READY or covered by an approved exception. */
export function ReadinessBoard({ examId, tz, active }: { examId: string; tz: string; active: boolean }) {
  const board = useReadinessBoard(examId, active);
  const [exceptionFor, setExceptionFor] = useState<ReadinessCandidate | null>(null);
  const [filter, setFilter] = useState<'all' | 'blocking' | 'not-started'>('all');

  if (board.isLoading) return <Skeleton lines={6} />;
  if (board.isError || !board.data) return <EmptyState title="The readiness board could not be loaded">Try again in a moment.</EmptyState>;
  const { summary, candidates } = board.data;
  const rows = candidates.filter((c) => (filter === 'blocking' ? c.blocking.length > 0 : filter === 'not-started' ? !c.precheck : true));

  const columns: Column<ReadinessCandidate>[] = [
    {
      key: 'student',
      header: 'Candidate',
      render: (c) => (
        <div>
          <p className="font-medium">{c.fullName}</p>
          <p className="text-sm text-ink-2 font-mono">{[c.registerNumber, c.hallTicket].filter(Boolean).join(' · ') || c.email}</p>
        </div>
      ),
    },
    {
      key: 'state',
      header: 'Readiness',
      render: (c) => {
        const t = precheckTone(c);
        return (
          <div className="flex flex-col gap-1 items-start">
            <StatusChip tone={t.tone}>{t.text}</StatusChip>
            {c.precheck?.readyUntil && c.precheck.status === 'READY' && c.status === 'READY' ? <span className="text-xs text-ink-2">until {formatTime(c.precheck.readyUntil, tz)}</span> : null}
            {c.status !== 'PRECHECK_AVAILABLE' && c.status !== 'PRECHECK_RUNNING' && c.status !== 'READY' ? <Badge tone={toneForAttempt(c.status)}>{humanize(c.status)}</Badge> : null}
          </div>
        );
      },
    },
    {
      key: 'checks',
      header: 'Checks',
      render: (c) => (
        <ul className="flex flex-wrap gap-1" aria-label="Checks">
          {c.checks.map((ch) => (
            <li key={ch.code}>
              <Badge tone={toneForPrecheckItem(ch.status)} title={`${CHECK_LABELS[ch.code]}: ${humanize(ch.status)}${ch.diagnosticCode ? ` (${ch.diagnosticCode})` : ''}`}>
                {CHECK_SHORT[ch.code]} {ch.status === 'PASS' ? '✓' : ch.status === 'REMEDIATE' ? '!' : ch.status === 'UNVERIFIABLE' ? '?' : ch.status === 'NEED_HELP' ? '✕' : '…'}
              </Badge>
            </li>
          ))}
        </ul>
      ),
    },
    {
      key: 'blocking',
      header: 'Blocking and instruction',
      render: (c) => {
        const blocking = c.checks.filter((ch) => c.blocking.includes(ch.code));
        if (blocking.length === 0) return c.exceptions.length ? <span className="text-sm text-ink-2">Exception in force</span> : <span className="text-sm text-ink-2">—</span>;
        return (
          <ul className="text-sm space-y-1 max-w-md">
            {blocking.map((ch) => (
              <li key={ch.code}>
                <span className="font-medium">{CHECK_LABELS[ch.code]}</span>
                {ch.securityRelevant ? <Badge tone="note" className="ml-1">security</Badge> : null}
                <span className="text-ink-2"> — {ch.instruction}</span>
              </li>
            ))}
          </ul>
        );
      },
    },
    {
      key: 'exceptions',
      header: 'Exceptions',
      hideOnMobile: true,
      render: (c) =>
        c.exceptions.length ? (
          <ul className="text-sm space-y-1">
            {c.exceptions.map((x) => (
              <li key={x.id}>
                {EXCEPTION_LABEL[x.code] ?? x.code}
                <span className="text-ink-2"> · {x.coversChecks.map((k) => CHECK_SHORT[k]).join(', ')} · expires {formatRelative(x.expiresAt)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-sm text-ink-2">—</span>
        ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (c) => (
        <Button size="sm" onClick={() => setExceptionFor(c)} disabled={['SUBMITTED', 'EXPIRED', 'VOIDED_BY_AUTHORITY'].includes(c.status)}>
          Approve exception
        </Button>
      ),
    },
  ];

  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-5" aria-label="Summary">
        <Sum label="Total" n={summary.total} />
        <Sum label="Ready" n={summary.ready} tone="ready" />
        <Sum label="Needs fix" n={summary.needsFix} tone="fix" />
        <Sum label="Needs review" n={summary.needsReview} tone="stop" />
        <Sum label="Not started" n={summary.notStarted} />
        <Sum label="Active" n={summary.active} tone="accent" />
        <Sum label="Paused" n={summary.suspended} tone="fix" />
        <Sum label="Submitted" n={summary.submitted} tone="note" />
        <span className="ml-auto text-sm text-ink-2 self-center" aria-live="polite">
          {board.isFetching ? 'Refreshing…' : 'Refreshes every 10 s'}
        </span>
      </div>
      <div className="flex gap-1 mb-4" role="group" aria-label="Show">
        {(
          [
            ['all', 'All'],
            ['blocking', 'With blocking checks'],
            ['not-started', 'Not started'],
          ] as const
        ).map(([k, label]) => (
          <Button key={k} size="sm" variant={filter === k ? 'secondary' : 'ghost'} aria-pressed={filter === k} onClick={() => setFilter(k)}>
            {label}
          </Button>
        ))}
      </div>
      <Table caption="Readiness board" columns={columns} rows={rows} rowKey={(c) => c.attemptId} empty="No candidates match." />
      {exceptionFor ? <ExceptionDialog examId={examId} candidate={exceptionFor} onClose={() => setExceptionFor(null)} /> : null}
    </div>
  );
}

function Sum({ label, n, tone = 'neutral' }: { label: string; n: number; tone?: Tone }) {
  return (
    <StatusChip tone={n === 0 ? 'neutral' : tone} icon={false} className="text-sm">
      <span className="tabular font-mono">{n}</span> {label}
    </StatusChip>
  );
}

function ExceptionDialog({ examId, candidate, onClose }: { examId: string; candidate: ReadinessCandidate; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [code, setCode] = useState<string>('TECH_ALT_DEVICE');
  const [covers, setCovers] = useState<Set<PrecheckCheckCode>>(() => new Set(candidate.blocking));
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState('120');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const candidateChecks = candidate.checks.length ? candidate.checks : [];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (covers.size === 0) return setError('Choose at least one check the exception covers.');
    if (reason.trim().length < 5) return setError('Give a reason of at least five characters; it is audited.');
    setBusy(true);
    try {
      await api.post(`/exams/${examId}/attempts/${candidate.attemptId}/admission-exceptions`, { exceptionCode: code, coversChecks: [...covers], reason: reason.trim(), expiresInMinutes: Number(minutes) || 120 }, { quiet: ['SECURITY_OVERRIDE_REQUIRED'] });
      toast({ tone: 'success', title: 'Exception approved', description: `${candidate.fullName}: ${[...covers].map((c) => CHECK_SHORT[c]).join(', ')}` });
      void qc.invalidateQueries({ queryKey: ['exam', examId, 'readiness'] });
      onClose();
    } catch (err) {
      if (isApiError(err, 'SECURITY_OVERRIDE_REQUIRED')) setError(`${err.problem.title} (SECURITY_OVERRIDE_REQUIRED). Ask the Controller to approve this exception.`);
      else setError('The exception could not be recorded. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Approve an exception for ${candidate.fullName}`}
      description="Scoped to this attempt, time-bound and audited. Identity, eligibility, client and consent checks can only be waived by a Controller."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="exception-form" loading={busy}>
            Approve exception
          </Button>
        </>
      }
    >
      <form id="exception-form" onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
        <Field label="Exception code">
          {({ id }) => (
            <Select id={id} value={code} onChange={(e) => setCode(e.target.value)} data-autofocus>
              {ADMISSION_EXCEPTION_CODES.map((c) => (
                <option key={c} value={c}>
                  {EXCEPTION_LABEL[c]} ({c})
                </option>
              ))}
            </Select>
          )}
        </Field>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium mb-1">Covers these checks</legend>
          {(candidateChecks.length ? candidateChecks : (Object.keys(CHECK_LABELS) as PrecheckCheckCode[]).map((c) => ({ code: c, status: 'PENDING', securityRelevant: false, instruction: '' }))).map((ch) => (
            <Checkbox
              key={ch.code}
              label={
                <span>
                  {CHECK_LABELS[ch.code]} <span className="text-ink-2">· {humanize(ch.status)}</span>
                  {ch.securityRelevant ? <Badge tone="note" className="ml-2">Controller only</Badge> : null}
                </span>
              }
              checked={covers.has(ch.code)}
              onChange={(e) => {
                const n = new Set(covers);
                if (e.target.checked) n.add(ch.code);
                else n.delete(ch.code);
                setCovers(n);
              }}
            />
          ))}
        </fieldset>
        <Field label="Reason" required hint="Recorded in the audit log with your name.">
          {({ id, describedBy }) => <TextArea id={id} value={reason} onChange={(e) => setReason(e.target.value)} aria-describedby={describedBy} rows={3} />}
        </Field>
        <Field label="Valid for (minutes)">
          {({ id }) => <TextInput id={id} type="number" min={5} max={600} value={minutes} onChange={(e) => setMinutes(e.target.value)} className="max-w-32" />}
        </Field>
        {error ? (
          <p className="text-stop" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}
