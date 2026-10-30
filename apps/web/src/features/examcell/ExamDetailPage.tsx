import { useState } from 'react';
import { useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { EXAM_TRANSITIONS, type ExamStatus } from '@examos/contracts';
import { api, isApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/time';
import { EXAM_TYPE_LABEL } from '@/features/student/api';
import { Badge, Button, ConfirmDialog, EmptyState, Field, humanize, KeyValue, PageTitle, Skeleton, StatusChip, Table, Tabs, TextArea, TextInput, toneForExam, useToast, type TabDef } from '@/ui';
import { EXAM_STATUS_LABEL, generateSebConfig, transitionExam, updateClientPolicy, useExam, type ExamAction, type ExamRow } from './api';
import { ReadinessBoard } from './ReadinessBoard';
import { CandidatesTab } from './CandidatesTab';
import { PaperTab } from './PaperTab';
import { EvaluationTab } from './EvaluationTab';

type TabId = 'overview' | 'paper' | 'allocations' | 'readiness' | 'candidates' | 'evaluation' | 'exports';

interface Conduct {
  action: ExamAction;
  to: ExamStatus;
  label: string;
  title: string;
  body: string;
  tone: 'neutral' | 'danger';
  primary?: boolean;
}

const CONDUCT: Conduct[] = [
  { action: 'submit-for-review', to: 'PAPER_REVIEW', label: 'Submit for review', title: 'Submit the paper for review?', body: 'The exam moves to paper review. Students do not see it yet.', tone: 'neutral' },
  { action: 'approve', to: 'APPROVED', label: 'Approve', title: 'Approve the paper?', body: 'Marks the paper as approved so the exam can be scheduled.', tone: 'neutral' },
  { action: 'schedule', to: 'SCHEDULED', label: 'Schedule', title: 'Schedule this exam?', body: 'Allocated students see the window on their exams page, and the ERP is told the exam is scheduled.', tone: 'neutral', primary: true },
  { action: 'open-precheck', to: 'PRECHECK', label: 'Open readiness check', title: 'Open the readiness check?', body: 'Every allocated student can start their 15-minute readiness check from now. Allowed at most two hours before the window opens. Allocations lock from this point.', tone: 'neutral', primary: true },
  { action: 'start', to: 'LIVE', label: 'Start exam', title: 'Start the exam?', body: 'Students who are READY are admitted when they press “Enter exam”. Each student’s timer starts only when they are admitted, never now.', tone: 'neutral', primary: true },
  { action: 'close', to: 'CLOSED', label: 'Close', title: 'Close the exam?', body: 'Ends the exam for everyone. Any attempt still open is sealed with the answers the server has received and marked expired. This cannot be undone.', tone: 'danger', primary: true },
  { action: 'archive', to: 'ARCHIVED', label: 'Archive', title: 'Archive this exam?', body: 'Moves the closed exam into the archive. Results and booklets remain available.', tone: 'neutral' },
  { action: 'cancel', to: 'CANCELLED', label: 'Cancel exam', title: 'Cancel this exam?', body: 'Cancels the exam for all allocated students. This cannot be undone.', tone: 'danger' },
];

export function ExamDetailPage() {
  const { id = '' } = useParams();
  const { me } = useAuth();
  const tz = me?.tenant.timezone ?? 'Asia/Kolkata';
  const exam = useExam(id);
  const qc = useQueryClient();
  const { toast } = useToast();
  const [tab, setTab] = useState<TabId>('overview');
  const [confirm, setConfirm] = useState<Conduct | null>(null);
  const [busy, setBusy] = useState(false);

  if (exam.isLoading) return <Skeleton lines={8} />;
  if (exam.isError || !exam.data) return <EmptyState title="This exam could not be loaded">Check the link, or go back to the exam list.</EmptyState>;
  const e = exam.data.exam;
  const counts = exam.data.attemptCounts;
  const allowed = new Set(EXAM_TRANSITIONS[e.status]);
  const actions = CONDUCT.filter((c) => allowed.has(c.to));

  const runConduct = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      const out = await transitionExam(id, confirm.action);
      toast({ tone: 'success', title: `${confirm.label}: done`, description: `${EXAM_STATUS_LABEL[out.from]} → ${EXAM_STATUS_LABEL[out.to]}` });
      setConfirm(null);
      void qc.invalidateQueries({ queryKey: ['exam', id] });
      void qc.invalidateQueries({ queryKey: ['exams'] });
    } catch (err) {
      if (isApiError(err, 'OUTSIDE_WINDOW')) toast({ tone: 'warning', title: 'Outside the allowed window', description: err.problem.title });
      else if (isApiError(err, 'ILLEGAL_TRANSITION')) toast({ tone: 'warning', title: 'Not allowed from the current state', description: err.problem.title });
    } finally {
      setBusy(false);
    }
  };

  const tabs: TabDef<TabId>[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'paper', label: 'Question paper' },
    { id: 'allocations', label: 'Allocations and hall tickets' },
    { id: 'readiness', label: 'Readiness board' },
    { id: 'candidates', label: 'Candidates' },
    { id: 'evaluation', label: 'Evaluation & Moderation' },
    { id: 'exports', label: 'Exports' },
  ];

  return (
    <div>
      <PageTitle
        kicker={
          <span className="font-mono">
            {e.code} · {EXAM_TYPE_LABEL[e.exam_type]}
          </span>
        }
        title={e.title}
        lede={
          <span className="inline-flex flex-wrap items-center gap-3">
            <StatusChip tone={toneForExam(e.status)}>{EXAM_STATUS_LABEL[e.status]}</StatusChip>
            <span>
              {formatDateTime(e.window_start_at, tz)} to {formatDateTime(e.window_end_at, tz)}
            </span>
          </span>
        }
        actions={actions.map((c) => (
          <Button key={c.action} variant={c.tone === 'danger' ? 'danger' : c.primary ? 'primary' : 'secondary'} onClick={() => setConfirm(c)}>
            {c.label}
          </Button>
        ))}
      />

      <Tabs tabs={tabs} value={tab} onChange={setTab} label="Exam sections">
        {tab === 'overview' ? <Overview exam={e} counts={counts} tz={tz} onUpdated={() => void qc.invalidateQueries({ queryKey: ['exam', id] })} /> : null}
        {tab === 'paper' ? <PaperTab exam={e} /> : null}
        {tab === 'allocations' ? <Allocations examId={id} status={e.status} /> : null}
        {tab === 'readiness' ? <ReadinessBoard examId={id} tz={tz} active={tab === 'readiness'} /> : null}
        {tab === 'candidates' ? <CandidatesTab examId={id} tz={tz} active={tab === 'candidates'} /> : null}
        {tab === 'evaluation' ? <EvaluationTab examId={id} /> : null}
        {tab === 'exports' ? <Exports examId={id} status={e.status} tz={tz} /> : null}
      </Tabs>

      {confirm ? (
        <ConfirmDialog open onClose={() => setConfirm(null)} onConfirm={runConduct} title={confirm.title} confirmLabel={confirm.label} tone={confirm.tone} busy={busy}>
          <p>{confirm.body}</p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

const SEB_FROZEN = ['LIVE', 'CLOSED', 'ARCHIVED', 'CANCELLED'];
const lines = (v: string) => v.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

/**
 * Safe Exam Browser for a SECURE_BYOD exam: SEB force-quits chat, remote-access, recording and AI apps when it starts,
 * keeps them closed, blocks switching, second screens and capture, and only opens this exam site. The server refuses
 * entry, admission and reconnect without a valid SEB key, and flags a live session that loses it.
 */
function ClientSecurityPolicyCard({ exam, onUpdated }: { exam: ExamRow; onUpdated: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const policy = (exam.policy ?? {}) as Record<string, unknown>;
  const sebKey = typeof policy['sebConfigKey'] === 'string' ? policy['sebConfigKey'] : null;
  const generated = typeof policy['sebConfigXml'] === 'string';
  const frozen = SEB_FROZEN.includes(exam.status);
  const [quitPassword, setQuitPassword] = useState('');
  const [extra, setExtra] = useState(Array.isArray(policy['sebExtraProhibited']) ? (policy['sebExtraProhibited'] as string[]).join('\n') : '');
  const [beks, setBeks] = useState(Array.isArray(policy['sebBrowserExamKeys']) ? (policy['sebBrowserExamKeys'] as string[]).join('\n') : '');

  if (exam.security_profile !== 'SECURE_BYOD') {
    return (
      <section className="sheet p-6 space-y-2">
        <h2 className="text-h3">Safe Exam Browser</h2>
        <p className="text-sm text-ink-2">
          This exam runs in the browser ({humanize(exam.security_profile)}): the workspace requires full screen, hides the paper whenever the student leaves it, and reports every tab, window and display change to the proctors. A browser cannot close other apps; to force-close them, use the Secure BYOD profile with Safe Exam Browser.
        </p>
      </section>
    );
  }

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast({ tone: 'success', title: ok });
      onUpdated();
    } catch (err) {
      toast({ tone: 'warning', title: 'Not saved', description: isApiError(err) ? err.problem.title : err instanceof Error ? err.message : 'Error' });
    } finally {
      setBusy(false);
    }
  };
  const generate = () =>
    run(
      () => generateSebConfig(exam.id, { allowQuit: true, kioskMode: true, blockVirtualMachines: true, blockScreenCapture: true, blockClipboard: true, ...(quitPassword ? { quitPassword } : {}), prohibitedProcesses: lines(extra) }),
      'Safe Exam Browser configuration generated',
    );
  const saveBeks = () => run(() => updateClientPolicy(exam.id, { sebBrowserExamKeys: lines(beks) }), 'Browser Exam Keys saved');

  return (
    <section className="sheet p-6 space-y-4" aria-labelledby="seb-h">
      <div className="flex items-center justify-between gap-3">
        <h2 id="seb-h" className="text-h3">Safe Exam Browser</h2>
        <Badge tone={sebKey ? 'ready' : 'fix'}>{sebKey ? 'Required for this exam' : 'Not configured'}</Badge>
      </div>
      <p className="text-sm text-ink-2">
        When a student opens the configuration, Safe Exam Browser closes Teams, Zoom, WhatsApp, Discord, TeamViewer, AnyDesk, OBS, ChatGPT and similar apps without asking, keeps them closed, blocks app switching, a second screen, mirroring, screenshots and virtual machines, and opens only this exam site. Entry, admission and reconnect are refused without a valid SEB key; the refusal is recorded for the proctors.
      </p>

      {sebKey ? (
        <div className="p-3 bg-sheet-2 border border-rule rounded-md space-y-1">
          <span className="text-xs text-ink-3 uppercase block font-medium">Config Key</span>
          <span className="font-mono text-xs text-ink block break-all font-semibold select-all" data-testid="seb-config-key">
            {sebKey}
          </span>
          <span className="text-[11px] text-ink-3 block">
            {generated ? `${typeof policy['sebGeneratedAt'] === 'string' ? `Generated ${formatDateTime(policy['sebGeneratedAt'], 'Asia/Kolkata')}. ` : ''}At the rehearsal, open the file in the SEB Config Tool and check it shows this key.` : 'Set by hand from the institution’s own .seb file; distribute that file.'}
          </span>
        </div>
      ) : (
        <div className="p-3 bg-sheet-2 border border-dashed border-rule rounded-md text-sm text-ink-2">No configuration yet. Generate it before opening the readiness check.</div>
      )}

      {frozen ? (
        <p className="text-sm text-ink-2">The configuration is frozen while the exam is {humanize(exam.status)}: changing it now would lock every student out.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Quit password (optional)" hint="Lets the invigilator close SEB on a student’s machine. Stored only as a hash in the file.">
            {(ids) => <TextInput type="password" value={quitPassword} onChange={(e) => setQuitPassword(e.target.value)} autoComplete="new-password" {...ids} />}
          </Field>
          <Field label="Also force-close these apps" hint="One per line: Name.exe for Windows, a bundle id (com.vendor.app) for macOS. Added to the built-in list.">
            {(ids) => <TextArea rows={3} value={extra} onChange={(e) => setExtra(e.target.value)} {...ids} />}
          </Field>
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        {!frozen ? (
          <Button variant="primary" loading={busy} onClick={() => void generate()}>
            {generated ? 'Rebuild configuration' : 'Generate configuration'}
          </Button>
        ) : null}
        {generated ? (
          <Button onClick={() => void api.download(`/exams/${exam.id}/seb-config`, `smru-exam-${exam.code}.seb`)}>Download .seb file</Button>
        ) : null}
      </div>

      {sebKey && !frozen ? (
        <div className="border-t border-rule pt-4 space-y-2">
          <Field label="Browser Exam Keys (optional, stricter)" hint="From the SEB Config Tool, one per approved SEB version. When set, every gated request must also match one of them.">
            {(ids) => <TextArea rows={2} value={beks} onChange={(e) => setBeks(e.target.value)} className="font-mono text-xs" {...ids} />}
          </Field>
          <Button size="sm" loading={busy} onClick={() => void saveBeks()}>
            Save Browser Exam Keys
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/** Turns the on-device camera presence check on or off for this exam (before it goes live). */
function CameraPresenceCard({ exam, onUpdated }: { exam: ExamRow; onUpdated: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const on = ((exam.policy ?? {}) as { proctoring?: { cameraPresence?: boolean } }).proctoring?.cameraPresence === true;
  const frozen = SEB_FROZEN.includes(exam.status);
  const toggle = async () => {
    setBusy(true);
    try {
      await updateClientPolicy(exam.id, { cameraPresence: !on });
      toast({ tone: 'success', title: on ? 'Camera presence check turned off' : 'Camera presence check turned on', description: 'Students take the readiness check again under the new policy.' });
      onUpdated();
    } catch (err) {
      toast({ tone: 'warning', title: 'Not changed', description: isApiError(err) ? err.problem.title : 'Error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="sheet p-6 space-y-3" aria-labelledby="cam-h">
      <div className="flex items-center justify-between gap-3">
        <h2 id="cam-h" className="text-h3">Camera presence check</h2>
        <Badge tone={on ? 'ready' : 'note'}>{on ? 'On' : 'Off'}</Badge>
      </div>
      <p className="text-sm text-ink-2">
        A face detector runs on each student’s own device during the exam and flags, for the proctors, a face missing for 8 seconds, a covered camera, or a second face for 3 seconds. No image or video leaves the device. Students see a small self-view and consent at the readiness check. A signal never counts without a proctor’s decision. Confirm your data-protection assessment covers this before turning it on.
      </p>
      {frozen ? (
        <p className="text-sm text-ink-2">Fixed while the exam is {humanize(exam.status)}.</p>
      ) : (
        <Button loading={busy} onClick={() => void toggle()}>
          {on ? 'Turn off' : 'Turn on'}
        </Button>
      )}
    </section>
  );
}

function Overview({ exam, counts, tz, onUpdated }: { exam: ExamRow; counts: Record<string, number>; tz: string; onUpdated: () => void }) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return (
    <div className="space-y-8">
      <div className="grid gap-8 lg:grid-cols-2">
        <section className="sheet p-6">
          <h2 className="text-h3 mb-4">Details</h2>
          <KeyValue
            items={[
              { k: 'Security profile', v: humanize(exam.security_profile) },
              { k: 'Duration', v: `${exam.duration_minutes} minutes` },
              { k: 'Maximum marks', v: exam.max_marks ?? '—' },
              { k: 'Term', v: `${exam.academic_year ?? '—'}${exam.semester ? ` · Semester ${exam.semester}` : ''}` },
              { k: 'Warning threshold', v: `${exam.warning_threshold} per epoch` },
              { k: 'Policy version', v: exam.policy_version, mono: true },
              { k: 'Readiness opened', v: formatDateTime(exam.precheck_opened_at, tz) },
              { k: 'Started', v: formatDateTime(exam.started_at, tz) },
              { k: 'Closed', v: formatDateTime(exam.closed_at, tz) },
            ]}
          />
        </section>
        <section className="sheet p-6">
          <h2 className="text-h3 mb-4">Attempts</h2>
          {total === 0 ? (
            <p className="text-ink-2">No students allocated yet.</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {Object.entries(counts)
                .sort((a, b) => b[1] - a[1])
                .map(([status, n]) => (
                  <li key={status}>
                    <Badge>
                      <span className="font-mono tabular">{n}</span> {humanize(status)}
                    </Badge>
                  </li>
                ))}
            </ul>
          )}
          <p className="mt-4 text-sm text-ink-2">{total} allocated in total.</p>
          {Object.keys(exam.policy ?? {}).length ? (
            <details className="mt-6">
              <summary className="cursor-pointer text-sm text-ink-2">Policy JSON</summary>
              <pre className="mt-2 text-xs font-mono whitespace-pre-wrap bg-sheet-2 p-3 rounded-sm border border-rule">{JSON.stringify(exam.policy, null, 2)}</pre>
            </details>
          ) : null}
        </section>
      </div>

      <ClientSecurityPolicyCard exam={exam} onUpdated={onUpdated} />
      <CameraPresenceCard exam={exam} onUpdated={onUpdated} />
    </div>
  );
}

function Allocations({ examId, status }: { examId: string; status: ExamStatus }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [ids, setIds] = useState('');
  const [provider, setProvider] = useState('uos');
  const [extra, setExtra] = useState('0');
  const [busy, setBusy] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [result, setResult] = useState<{ allocated: number; skipped: Array<{ externalId: string; reason: string }> } | null>(null);
  const locked = ['PRECHECK', 'LIVE', 'CLOSED', 'ARCHIVED', 'CANCELLED'].includes(status);

  const allocate = async () => {
    const list = ids
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!list.length) return;
    setBusy(true);
    try {
      const out = await api.post<{ allocated: number; skipped: Array<{ externalId: string; reason: string }> }>(`/exams/${examId}/allocations`, { studentExternalIds: list, provider, extraTimeMinutes: Number(extra) || 0 }, { quiet: ['EXAM_LOCKED'] });
      setResult(out);
      void qc.invalidateQueries({ queryKey: ['exam', examId] });
      toast({ tone: 'success', title: `${out.allocated} allocated`, description: out.skipped.length ? `${out.skipped.length} skipped` : undefined });
    } catch (err) {
      if (isApiError(err, 'EXAM_LOCKED')) toast({ tone: 'warning', title: 'Allocations are locked', description: err.problem.title });
    } finally {
      setBusy(false);
    }
  };

  const issue = async () => {
    setIssuing(true);
    try {
      const out = await api.post<{ issued: number }>(`/exams/${examId}/hall-tickets`, {});
      toast({ tone: 'success', title: `${out.issued} hall ${out.issued === 1 ? 'ticket' : 'tickets'} issued`, description: out.issued === 0 ? 'Everyone allocated already has one.' : undefined });
    } finally {
      setIssuing(false);
    }
  };

  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <section className="sheet p-6 flex flex-col gap-4">
        <h2 className="text-h3">Allocate students</h2>
        <p className="text-sm text-ink-2">Paste the ERP’s student ids, one per line or comma-separated. Students must be enrolled and eligible for the course.</p>
        <Field label="Student ids (external)">
          {({ id }) => <TextArea id={id} value={ids} onChange={(e) => setIds(e.target.value)} rows={8} className="font-mono text-sm" placeholder={'STU-2024-001\nSTU-2024-002'} disabled={locked} />}
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Provider" hint="The ERP that issued the ids.">
            {({ id, describedBy }) => <TextInput id={id} value={provider} onChange={(e) => setProvider(e.target.value)} aria-describedby={describedBy} className="font-mono" disabled={locked} />}
          </Field>
          <Field label="Extra time (minutes)" hint="Approved accommodation for these students.">
            {({ id, describedBy }) => <TextInput id={id} type="number" min={0} max={240} value={extra} onChange={(e) => setExtra(e.target.value)} aria-describedby={describedBy} disabled={locked} />}
          </Field>
        </div>
        {locked ? <p className="text-sm text-fix">Allocations cannot change while the exam is {EXAM_STATUS_LABEL[status].toLowerCase()}.</p> : null}
        <div>
          <Button variant="primary" onClick={() => void allocate()} loading={busy} disabled={locked || !ids.trim()}>
            Allocate
          </Button>
        </div>
        {result ? (
          <div className="text-sm">
            <p>
              <span className="font-mono tabular">{result.allocated}</span> allocated.
            </p>
            {result.skipped.length ? (
              <ul className="mt-2 divide-y divide-rule border-y border-rule">
                {result.skipped.map((s) => (
                  <li key={s.externalId} className="py-1 flex gap-3">
                    <span className="font-mono">{s.externalId}</span>
                    <span className="text-ink-2">{humanize(s.reason)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </section>
      <section className="sheet p-6 flex flex-col gap-4">
        <h2 className="text-h3">Hall tickets</h2>
        <p className="text-sm text-ink-2">Issues a numbered hall ticket to every allocated student who does not have one, as {`<exam code>-<sequence>`}, with a verification hash. Students see it on their exams page.</p>
        <div>
          <Button onClick={() => void issue()} loading={issuing}>
            Issue hall tickets
          </Button>
        </div>
      </section>
    </div>
  );
}

function Exports({ examId, status, tz }: { examId: string; status: ExamStatus; tz: string }) {
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState<string | null>(null);
  const [scripts, setScripts] = useState<Array<{ attemptId: string; fullName: string; status: string; sealedAt: string | null }> | null>(null);
  const live = status === 'PRECHECK' || status === 'LIVE';

  const fetchScripts = async () => {
    setBusy(true);
    setLocked(null);
    try {
      const out = await api.get<{ scripts: Array<{ attemptId: string; fullName: string; status: string; sealedAt: string | null }> }>(`/exams/${examId}/exports/scripts`, { quiet: ['EXPORT_LOCKED'] });
      setScripts(out.scripts);
    } catch (err) {
      if (isApiError(err, 'EXPORT_LOCKED')) setLocked(err.problem.title);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-3xl flex flex-col gap-4">
      <p className="text-ink-2">Script exports list the sealed attempts of this exam. While the readiness check or the exam is live, exports are locked and every attempt to export is audited and reported to the Examination Section.</p>
      <div>
        <Button variant={live ? 'secondary' : 'primary'} onClick={() => void fetchScripts()} loading={busy}>
          Export scripts
        </Button>
      </div>
      {locked ? (
        <p className="text-stop" role="alert">
          {locked} (EXPORT_LOCKED)
        </p>
      ) : null}
      {scripts ? (
        <Table
          caption="Sealed scripts"
          columns={[
            { key: 'name', header: 'Candidate', render: (s) => s.fullName },
            { key: 'status', header: 'Status', render: (s) => humanize(s.status) },
            { key: 'sealed', header: 'Sealed', render: (s) => formatDateTime(s.sealedAt, tz) },
            { key: 'id', header: 'Attempt', render: (s) => <span className="font-mono text-xs">{s.attemptId}</span> },
          ]}
          rows={scripts}
          rowKey={(s) => s.attemptId}
          empty="No sealed scripts yet."
        />
      ) : null}
    </div>
  );
}
