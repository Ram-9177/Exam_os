import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api, isApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { uuid } from '@/lib/ids';
import { formatDateTime } from '@/lib/time';
import { numberOf } from '@/features/student/api';
import { Badge, Button, CheckIcon, CopyIcon, CrossIcon, Dialog, EmptyState, Field, humanize, KeyValue, Select, Skeleton, StatusChip, Table, TextArea, TextInput, toneForCandidate, useToast, type Column, type Tone } from '@/ui';
import { useCandidates, useChecklist, type CandidateRow } from './api';

const HOLD_STATUSES = ['INTEGRITY_HOLD', 'TECHNICAL_REVIEW_REQUIRED', 'IDENTITY_REVIEW_REQUIRED', 'MARKING_MODERATION_REQUIRED'] as const;
const HOLD_LABEL: Record<(typeof HOLD_STATUSES)[number], string> = {
  INTEGRITY_HOLD: 'Integrity hold',
  TECHNICAL_REVIEW_REQUIRED: 'Technical review required',
  IDENTITY_REVIEW_REQUIRED: 'Identity review required',
  MARKING_MODERATION_REQUIRED: 'Marking moderation required',
};
const CHECK_LABEL: Record<string, string> = {
  ELIGIBILITY_AND_SEAT: 'Eligibility and seat',
  SEALED_SUBMISSION: 'Sealed submission',
  IDENTITY: 'Identity',
  MEDIA_QUALITY: 'Evidence quality',
  INCIDENTS_RESOLVED: 'Incidents resolved',
  INTEGRITY: 'Integrity',
  MARKS_HUMAN_APPROVED: 'Marks approved by a named examiner',
  MARK_SUM_RECOMPUTED: 'Total recomputed in the database',
  APPROVAL_CURRENT: 'Exam Cell approval current',
};

const approvalsKey = (attemptId: string) => `examos.approval.${attemptId}`;

/** Candidate-by-candidate approval (spec §46.4): essential chips, a table, and a drawer with the deterministic checklist. */
export function CandidatesTab({ examId, tz, active }: { examId: string; tz: string; active: boolean }) {
  const list = useCandidates(examId, active);
  const [open, setOpen] = useState<CandidateRow | null>(null);
  const [q, setQ] = useState('');

  if (list.isLoading) return <Skeleton lines={6} />;
  if (list.isError || !list.data) return <EmptyState title="Candidates could not be loaded">Try again in a moment.</EmptyState>;
  const { summary } = list.data;
  const rows = list.data.candidates.filter((c) => !q || `${c.fullName} ${c.registerNumber ?? ''} ${c.hallTicket ?? ''}`.toLowerCase().includes(q.toLowerCase()));

  const columns: Column<CandidateRow>[] = [
    {
      key: 'student',
      header: 'Candidate',
      render: (c) => (
        <div>
          <p className="font-medium">{c.fullName}</p>
          <p className="text-sm text-ink-2 font-mono">{[c.registerNumber, c.hallTicket].filter(Boolean).join(' · ')}</p>
        </div>
      ),
    },
    { key: 'status', header: 'Approval state', render: (c) => <StatusChip tone={toneForCandidate(c.status)}>{humanize(c.status)}</StatusChip> },
    { key: 'marks', header: 'Marks', align: 'right', render: (c) => (c.resultVersion ? <span className="font-mono tabular">{numberOf(c.totalMarks)} / {numberOf(c.maxMarks)} <span className="text-ink-2 text-xs">v{c.resultVersion}</span></span> : <span className="text-ink-2 text-sm">awaiting</span>) },
    { key: 'identity', header: 'Identity', hideOnMobile: true, render: (c) => <Lane v={c.identity_state} /> },
    { key: 'integrity', header: 'Integrity', hideOnMobile: true, render: (c) => <Lane v={c.integrity_state} /> },
    { key: 'media', header: 'Evidence', hideOnMobile: true, render: (c) => <Lane v={c.media_quality_state} /> },
    { key: 'published', header: 'Published', hideOnMobile: true, render: (c) => (c.published_at ? formatDateTime(c.published_at, tz) : '—') },
    { key: 'open', header: '', align: 'right', render: (c) => (
        <Button size="sm" onClick={() => setOpen(c)}>
          Open
        </Button>
      ) },
  ];

  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-5">
        <Sum label="Ready for review" n={summary.ready} tone="ready" />
        <Sum label="Approved" n={summary.approved} tone="accent" />
        <Sum label="Published" n={summary.published} tone="accent" />
        <Sum label="Needs review" n={summary.needsReview} tone="fix" />
        <Sum label="On hold" n={summary.onHold} tone="stop" />
        <Sum label="Awaiting marks" n={summary.awaitingMarks} />
      </div>
      <Field label="Search" hideLabel className="max-w-sm mb-4">
        {({ id }) => <TextInput id={id} type="search" placeholder="Register number, hall ticket or name" value={q} onChange={(e) => setQ(e.target.value)} />}
      </Field>
      <Table caption="Candidates" columns={columns} rows={rows} rowKey={(c) => c.attempt_id} empty="No sealed attempts yet. Candidates appear here after submission." />
      {open ? <CandidateDrawer examId={examId} candidate={open} tz={tz} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function Lane({ v }: { v: string | null }) {
  const tone: Tone = !v ? 'neutral' : /CLEAR|VERIFIED|NOT_APPLICABLE|COMPLETE|REVIEWED|HUMAN_APPROVED/.test(v) ? 'ready' : /PENDING|REQUIRED/.test(v) ? 'fix' : /CONFIRMED|FAILED/.test(v) ? 'stop' : 'neutral';
  return <Badge tone={tone}>{humanize(v).replace(/ by session$/, ' (session)')}</Badge>;
}

function Sum({ label, n, tone = 'neutral' }: { label: string; n: number; tone?: Tone }) {
  return (
    <StatusChip tone={n === 0 ? 'neutral' : tone} icon={false} className="text-sm">
      <span className="tabular font-mono">{n}</span> {label}
    </StatusChip>
  );
}

function CandidateDrawer({ examId, candidate, tz, onClose }: { examId: string; candidate: CandidateRow; tz: string; onClose: () => void }) {
  const { hasRole } = useAuth();
  const qc = useQueryClient();
  const { toast } = useToast();
  const navigate = useNavigate();
  const checklist = useChecklist(candidate.attempt_id);
  const [mode, setMode] = useState<'none' | 'approve' | 'hold' | 'release' | 'authorize'>('none');
  const [reason, setReason] = useState('');
  const [holdStatus, setHoldStatus] = useState<(typeof HOLD_STATUSES)[number]>('INTEGRITY_HOLD');
  const [approvalId, setApprovalId] = useState(() => sessionStorage.getItem(approvalsKey(candidate.attempt_id)) ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastApproval, setLastApproval] = useState<string | null>(() => sessionStorage.getItem(approvalsKey(candidate.attempt_id)));

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['exam', examId, 'candidates'] });
    void qc.invalidateQueries({ queryKey: ['candidate', candidate.attempt_id, 'checklist'] });
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setMode('none');
      setReason('');
      refresh();
    } catch (e) {
      setError(isApiError(e) ? `${e.problem.title} (${e.code})` : 'The action failed. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const approve = () =>
    run(async () => {
      const rv = checklist.data?.packet.result_version_id;
      if (!rv) throw new Error('no result version');
      const out = await api.post<{ approvalId: string; status: string }>(`/candidates/${candidate.attempt_id}/approvals`, { reviewedResultVersionId: rv, reason: reason.trim(), idempotencyKey: uuid() }, { quiet: ['PACKET_STATE', 'STALE_REVIEW', 'SEAL_UNVERIFIED', 'CHECKLIST_INCOMPLETE'] });
      sessionStorage.setItem(approvalsKey(candidate.attempt_id), out.approvalId);
      setLastApproval(out.approvalId);
      setApprovalId(out.approvalId);
      toast({ tone: 'success', title: 'Candidate approved', description: `Approval ${out.approvalId}. Give this id to the Controller for publication.`, duration: 0 });
    });
  const hold = () => run(async () => {
      await api.post(`/candidates/${candidate.attempt_id}/holds`, { status: holdStatus, reason: reason.trim() }, { quiet: ['ILLEGAL_TRANSITION'] });
      toast({ tone: 'info', title: 'Hold recorded', description: HOLD_LABEL[holdStatus] });
    });
  const release = () => run(async () => {
      await api.post(`/candidates/${candidate.attempt_id}/holds/release`, { reason: reason.trim() }, { quiet: ['ILLEGAL_TRANSITION'] });
      toast({ tone: 'info', title: 'Hold released' });
    });
  const liveApprovalId = checklist.data?.liveApproval?.id ?? null;
  const authorize = () => run(async () => {
      const id = (liveApprovalId ?? approvalId).trim();
      await api.post(`/candidates/${candidate.attempt_id}/authorize-publication`, { candidateApprovalId: id, idempotencyKey: uuid() }, { quiet: ['PACKET_STATE', 'APPROVAL_INVALID', 'STALE_APPROVAL'] });
      toast({ tone: 'success', title: 'Result published', description: `${candidate.fullName} can open the booklet.` });
    });
  const forensics = () => run(async () => {
      await api.post(`/candidates/${candidate.attempt_id}/forensics/run`, {});
      toast({ tone: 'info', title: 'Checks run' });
    });

  const c = checklist.data;
  const isHeld = ['INTEGRITY_HOLD', 'TECHNICAL_REVIEW_REQUIRED', 'IDENTITY_REVIEW_REQUIRED', 'MARKING_MODERATION_REQUIRED'].includes(candidate.status);

  return (
    <Dialog open onClose={onClose} variant="drawer" title={candidate.fullName} description={[candidate.registerNumber, candidate.hallTicket].filter(Boolean).join(' · ')}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip tone={toneForCandidate(candidate.status)}>{humanize(candidate.status)}</StatusChip>
          {candidate.hold_reason ? <span className="text-sm text-ink-2">Hold reason: {candidate.hold_reason}</span> : null}
        </div>

        <section aria-labelledby="checklist-h">
          <h3 id="checklist-h" className="text-h3 mb-2">
            Approval checklist
          </h3>
          {checklist.isLoading ? <Skeleton lines={5} /> : null}
          {checklist.isError ? <p className="text-ink-2 text-sm">No review packet yet. It is created when the attempt is sealed.</p> : null}
          {c ? (
            <ul className="divide-y divide-rule border-y border-rule">
              {c.checks.map((ch) => (
                <li key={ch.code} className="flex items-start gap-3 py-2 text-[15px]">
                  <span className={ch.ok ? 'text-ready mt-1' : 'text-stop mt-1'} aria-hidden="true">
                    {ch.ok ? <CheckIcon /> : <CrossIcon />}
                  </span>
                  <span className="flex-1">
                    {CHECK_LABEL[ch.code] ?? ch.code}
                    <span className="text-ink-2 text-sm"> — {/^[A-Z_]+$/.test(ch.detail) ? humanize(ch.detail) : ch.detail}</span>
                  </span>
                  <span className="visually-hidden">{ch.ok ? 'passed' : 'not passed'}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {c ? <p className="mt-2 text-sm text-ink-2">{c.publishable ? 'All deterministic checks pass.' : 'Blocking checks remain; approval is refused by the server until they pass.'}</p> : null}
        </section>

        {c?.resultVersion ? (
          <KeyValue
            items={[
              { k: 'Result version', v: `v${c.resultVersion.version} · ${numberOf(c.resultVersion.total_marks)} / ${numberOf(c.resultVersion.max_marks)}` },
              { k: 'Approved at', v: formatDateTime(c.resultVersion.approved_at, tz) },
              { k: 'Version id', v: c.resultVersion.id, mono: true },
            ]}
          />
        ) : null}

        {lastApproval ? (
          <div className="sheet p-3 bg-sheet-2 text-sm flex items-center gap-2">
            <span className="text-ink-2">Approval id</span>
            <span className="font-mono break-all flex-1">{lastApproval}</span>
            <Button size="sm" variant="ghost" leading={<CopyIcon />} onClick={() => void navigator.clipboard?.writeText(lastApproval)}>
              Copy
            </Button>
          </div>
        ) : null}

        <section aria-labelledby="actions-h" className="flex flex-col gap-3">
          <h3 id="actions-h" className="text-h3">
            Actions
          </h3>
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" onClick={() => navigate(`/student/attempts/${candidate.attempt_id}/booklet`)}>
              View answers
            </Button>
            <Button
              variant="ghost"
              onClick={() => void api.download(`/candidates/${candidate.attempt_id}/booklet.pdf`, `booklet-${candidate.registerNumber ?? candidate.attempt_id}.pdf`)}
            >
              Download Booklet (PDF)
            </Button>
            <Button
              variant="ghost"
              onClick={() => void api.download(`/candidates/${candidate.attempt_id}/evidence.pdf`, `evidence-${candidate.registerNumber ?? candidate.attempt_id}.pdf`)}
            >
              Download Evidence Dossier (PDF)
            </Button>
            {candidate.status === 'ATTEMPT_SEALED' ? (
              <Button onClick={() => void forensics()} loading={busy}>
                Run completeness checks
              </Button>
            ) : null}
            {hasRole('EXAM_CELL_OPERATOR') && candidate.status === 'EXAM_CELL_REVIEW' ? (
              <Button variant="primary" onClick={() => setMode('approve')}>
                Approve
              </Button>
            ) : null}
            {hasRole('EXAM_CELL_OPERATOR') && !isHeld && !['PUBLISHED', 'INVALIDATED_BY_AUTHORIZED_DECISION', 'RESCHEDULE_APPROVED'].includes(candidate.status) ? (
              <Button variant="danger" onClick={() => setMode('hold')}>
                Hold
              </Button>
            ) : null}
            {hasRole('EXAM_CELL_OPERATOR') && isHeld ? <Button onClick={() => setMode('release')}>Release hold</Button> : null}
            {hasRole('CONTROLLER') && candidate.status === 'CANDIDATE_APPROVED' ? (
              <Button variant="primary" onClick={() => setMode('authorize')}>
                Authorize publication
              </Button>
            ) : null}
          </div>

          {mode === 'approve' ? (
            <ActionForm title="Approve this candidate" onCancel={() => setMode('none')} onSubmit={() => void approve()} busy={busy} error={error} label="Approve">
              <p className="text-sm text-ink-2">Records a formal Exam Cell approval of result version {c?.resultVersion?.version ?? '—'} with the checklist digest. A newer result version invalidates it.</p>
              <Field label="Reason" required>
                {({ id }) => <TextArea id={id} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} data-autofocus />}
              </Field>
            </ActionForm>
          ) : null}
          {mode === 'hold' ? (
            <ActionForm title="Place on hold" onCancel={() => setMode('none')} onSubmit={() => void hold()} busy={busy} error={error} label="Record hold" tone="danger">
              <Field label="Hold status">
                {({ id }) => (
                  <Select id={id} value={holdStatus} onChange={(e) => setHoldStatus(e.target.value as (typeof HOLD_STATUSES)[number])} data-autofocus>
                    {HOLD_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {HOLD_LABEL[s]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Reason" required hint="The candidate is notified with this reason.">
                {({ id, describedBy }) => <TextArea id={id} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} aria-describedby={describedBy} />}
              </Field>
            </ActionForm>
          ) : null}
          {mode === 'release' ? (
            <ActionForm title="Release the hold" onCancel={() => setMode('none')} onSubmit={() => void release()} busy={busy} error={error} label="Release hold">
              <Field label="Reason" required>
                {({ id }) => <TextArea id={id} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} data-autofocus />}
              </Field>
            </ActionForm>
          ) : null}
          {mode === 'authorize' ? (
            <ActionForm title="Authorize publication" onCancel={() => setMode('none')} onSubmit={() => void authorize()} busy={busy} error={error} label="Publish result" disabled={!liveApprovalId && !approvalId.trim()}>
              <p className="text-sm text-ink-2">Publishes the approved result version to the student, the permanent ledger and the ERP. Only the current Exam Cell approval can be published; a newer mark version would have invalidated it.</p>
              {liveApprovalId ? (
                <p className="text-sm">
                  Current approval <span className="font-mono">{liveApprovalId}</span>
                  {checklist.data?.liveApproval?.createdAt ? <span className="text-ink-2"> · recorded {new Date(checklist.data.liveApproval.createdAt).toLocaleString('en-IN', { timeZone: tz })}</span> : null}
                </p>
              ) : (
                <Field label="Candidate approval id" required>
                  {({ id }) => <TextInput id={id} value={approvalId} onChange={(e) => setApprovalId(e.target.value)} className="font-mono" data-autofocus />}
                </Field>
              )}
            </ActionForm>
          ) : null}
        </section>
      </div>
    </Dialog>
  );
}

function ActionForm({ title, children, onCancel, onSubmit, busy, error, label, tone = 'neutral', disabled }: { title: string; children: ReactNode; onCancel: () => void; onSubmit: () => void; busy: boolean; error: string | null; label: string; tone?: 'neutral' | 'danger'; disabled?: boolean }) {
  return (
    <form
      className={`sheet p-4 flex flex-col gap-3 ${tone === 'danger' ? 'border-stop' : ''}`}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <p className="font-medium">{title}</p>
      {children}
      {error ? (
        <p className="text-stop text-sm" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2 justify-end">
        <Button variant="ghost" type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant={tone === 'danger' ? 'danger' : 'primary'} type="submit" loading={busy} disabled={disabled}>
          {label}
        </Button>
      </div>
    </form>
  );
}
