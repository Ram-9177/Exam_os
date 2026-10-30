import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { INCIDENT_STATUSES, TECHNICAL_SIGNAL_CLASSES, type IncidentStatus, type ProctorSignalClass } from '@examos/contracts';
import { api, isApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { uuid } from '@/lib/ids';
import { formatDateTime, formatRelative, formatTime } from '@/lib/time';
import { useExams, type ExamListItem } from '@/features/examcell/api';
import { Badge, Button, Checkbox, Dialog, EmptyState, Field, humanize, KeyValue, PageTitle, Select, Skeleton, StatusChip, Table, TextArea, TextInput, toneForAttempt, useToast, type Column, type Tone } from '@/ui';

interface Incident {
  id: string;
  attempt_id: string;
  exam_id: string;
  signal_class: ProctorSignalClass;
  status: IncidentStatus;
  first_event_at: string;
  last_event_at: string;
  event_count: number;
  priority: number;
  attemptStatus: string;
  userId: string;
  studentName: string;
  currentWarnings: number | null;
  epochNo: number | null;
}

interface DecisionResult {
  decisionId: string;
  attemptStatus: string;
  suspensionKind: string | null;
  authorizationGeneration: number;
  epoch: { no: number; confirmedCount: number; open: boolean } | null;
  lifetimeWarnings: number;
}

interface Timeline {
  attempt: Record<string, unknown> & { status: string; deadline_at?: string | null; exam_id: string };
  events: Array<Record<string, unknown> & { seq: number; event_type: string; actor: string; metadata?: Record<string, unknown> | null }>;
  warnings: Array<Record<string, unknown> & { warning_no: number; epoch_no: number; created_at: string }>;
  epochs: Array<Record<string, unknown> & { epoch_no: number; confirmed_count: number; closed_at: string | null; reason: string | null }>;
  network: Array<{ ip: string; user_agent: string | null; first_seen_at: string; last_seen_at: string; observations: number; first_source: string; in_allowed_subnet: boolean | null }>;
  deviceScans: Array<{ id: string; phase: string; verdict: string; findings: string[]; ip: string | null; created_at: string }>;
}

const SIGNAL_LABEL: Record<ProctorSignalClass, string> = {
  FOCUS_LOST: 'Window focus lost',
  FULLSCREEN_EXIT: 'Left full screen',
  CONCURRENT_SESSION: 'Second device session',
  DISALLOWED_APP_DETECTED: 'Disallowed app detected',
  UNAPPROVED_DEVICE: 'Unapproved device',
  VIRTUAL_MACHINE_DETECTED: 'Virtual machine detected',
  DUAL_SCREEN_DETECTED: 'Dual/external screen detected',
  CLIPBOARD_ATTEMPT: 'Clipboard attempt',
  DEVTOOLS_ATTEMPT: 'Developer tools attempt',
  SCREEN_CAPTURE_ATTEMPT: 'Screen capture attempt',
  MULTIPLE_TABS: 'Multiple tabs',
  WINDOW_RESIZED: 'Window resized',
  AUTOMATION_DETECTED: 'Automation detected',
  NETWORK_ADDRESS_CHANGED: 'Network address changed',
  NETWORK_ANOMALY: 'Network anomaly',
  CAMERA_UNAVAILABLE: 'Camera unavailable',
  PERSON_POSSIBLE: 'Another person possible',
  MULTIPLE_PERSON_POSSIBLE: 'More than one person possible',
  RECORDING_GAP: 'Recording gap',
  VISUAL_ANOMALY: 'Visual anomaly',
  OTHER_MANUAL: 'Manual note',
};
const STATUS_LABEL: Record<IncidentStatus, string> = { TECHNICAL: 'Technical', DISMISSED: 'Dismissed', PROCTOR_REVIEW: 'Needs decision', CONFIRMED_COUNTABLE_WARNING: 'Warning confirmed' };
const REASON_SUGGESTIONS = ['SINGLE_INTERRUPTION', 'STUDENT_EXPLAINED', 'CONFIRMED_BY_ROOM_CHECK', 'TECHNICAL_FAULT', 'POWER_OUTAGE', 'NETWORK_OUTAGE', 'DEVICE_REPLACED', 'MEDICAL', 'INVIGILATOR_INSTRUCTION'];

function priorityTone(p: number): Tone {
  return p >= 90 ? 'stop' : p >= 60 ? 'fix' : p >= 50 ? 'accent' : 'note';
}

/** Priority-first incident queue, refreshed every 5 s. Signals are context; only a named person confirms a warning. */
export function ProctorPage() {
  const { me, hasRole } = useAuth();
  const tz = me?.tenant.timezone ?? 'Asia/Kolkata';
  const [examId, setExamId] = useState('');
  const [status, setStatus] = useState<string>('PROCTOR_REVIEW');
  const exams = useExams({});
  const examsById = useMemo(() => new Map((exams.data?.exams ?? []).map((e) => [e.id, e] as const)), [exams.data]);
  const thresholds = useThresholds([...new Set((exams.data?.exams ?? []).map((e) => e.id))]);

  const incidents = useQuery({
    queryKey: ['proctor', 'incidents', examId, status],
    queryFn: () => api.get<{ incidents: Incident[] }>(`/proctor/incidents?limit=200${examId ? `&examId=${examId}` : ''}${status ? `&status=${status}` : ''}`),
    refetchInterval: 5000,
  });
  const [open, setOpen] = useState<Incident | null>(null);
  const list = incidents.data?.incidents ?? [];

  const columns: Column<Incident>[] = [
    { key: 'priority', header: 'Priority', width: '6rem', render: (i) => <Badge tone={priorityTone(i.priority)}>{i.priority >= 90 ? 'Urgent' : i.priority >= 60 ? 'High' : i.priority >= 50 ? 'Normal' : 'Low'}</Badge> },
    {
      key: 'signal',
      header: 'Signal',
      render: (i) => (
        <div>
          <p className="font-medium">{SIGNAL_LABEL[i.signal_class] ?? humanize(i.signal_class)}</p>
          <p className="text-sm text-ink-2">
            {i.event_count} {i.event_count === 1 ? 'event' : 'events'} · last {formatRelative(i.last_event_at)}
            {TECHNICAL_SIGNAL_CLASSES.includes(i.signal_class) ? ' · technical, never countable' : ''}
          </p>
        </div>
      ),
    },
    {
      key: 'student',
      header: 'Student',
      render: (i) => (
        <div>
          <p>{i.studentName}</p>
          <p className="text-sm text-ink-2">{examsById.get(i.exam_id)?.code ?? '—'}</p>
        </div>
      ),
    },
    { key: 'attempt', header: 'Attempt', render: (i) => <StatusChip tone={toneForAttempt(i.attemptStatus)}>{humanize(i.attemptStatus)}</StatusChip> },
    { key: 'warnings', header: 'Warnings', hideOnMobile: true, render: (i) => <WarningsText current={i.currentWarnings} threshold={thresholds.get(i.exam_id)} epoch={i.epochNo} /> },
    { key: 'status', header: 'Status', hideOnMobile: true, render: (i) => <Badge tone={i.status === 'PROCTOR_REVIEW' ? 'fix' : i.status === 'CONFIRMED_COUNTABLE_WARNING' ? 'stop' : 'note'}>{STATUS_LABEL[i.status]}</Badge> },
    { key: 'open', header: '', align: 'right', render: (i) => (
        <Button size="sm" onClick={() => setOpen(i)}>
          Open
        </Button>
      ) },
  ];

  return (
    <div>
      <PageTitle title="Invigilation" lede="Signals grouped into incidents, most urgent first. Nothing here counts against a student until a person confirms it." />
      <div className="flex flex-wrap items-end gap-3 mb-6">
        <Field label="Exam">
          {({ id }) => (
            <Select id={id} value={examId} onChange={(e) => setExamId(e.target.value)} className="min-w-64">
              <option value="">All exams</option>
              {(exams.data?.exams ?? []).map((e) => (
                <option key={e.id} value={e.id}>
                  {e.code} · {e.title}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Status">
          {({ id }) => (
            <Select id={id} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Any</option>
              {INCIDENT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <span className="text-sm text-ink-2 ml-auto self-center" aria-live="polite">
          {incidents.isFetching ? 'Refreshing…' : `${list.length} shown · refreshes every 5 s`}
        </span>
      </div>
      {incidents.isLoading ? <Skeleton lines={6} /> : null}
      {incidents.isError ? <EmptyState title="Incidents could not be loaded">Try again in a moment.</EmptyState> : null}
      {incidents.data ? <Table caption="Incident queue" columns={columns} rows={list} rowKey={(i) => i.id} empty="The queue is clear." /> : null}
      {open ? <IncidentDrawer incident={open} exam={examsById.get(open.exam_id)} threshold={thresholds.get(open.exam_id)} tz={tz} chief={hasRole('CHIEF_PROCTOR')} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function useThresholds(examIds: string[]) {
  const q = useQuery({
    queryKey: ['proctor', 'thresholds', examIds],
    queryFn: async () => {
      const out = new Map<string, number>();
      await Promise.all(
        examIds.map(async (id) => {
          try {
            const r = await api.get<{ exam: { warning_threshold: number } }>(`/exams/${id}`, { quiet: true });
            out.set(id, r.exam.warning_threshold);
          } catch {
            /* keep unknown */
          }
        }),
      );
      return out;
    },
    enabled: examIds.length > 0,
    staleTime: 5 * 60_000,
  });
  return q.data ?? new Map<string, number>();
}

function WarningsText({ current, threshold, epoch, lifetime }: { current: number | null; threshold: number | undefined; epoch: number | null; lifetime?: number }) {
  const c = current ?? 0;
  return (
    <span className="tabular">
      {c} of {threshold ?? '—'} in this epoch{epoch ? ` (epoch ${epoch})` : ''}
      {lifetime !== undefined ? ` · ${lifetime} lifetime` : ''}
    </span>
  );
}

function IncidentDrawer({ incident, exam, threshold, tz, chief, onClose }: { incident: Incident; exam: ExamListItem | undefined; threshold: number | undefined; tz: string; chief: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [view, setView] = useState<'incident' | 'timeline'>('incident');
  const [action, setAction] = useState<'none' | 'DISMISS' | 'CONFIRM_WARNING' | 'MARK_TECHNICAL' | 'HOLD' | 'RESUME'>('none');
  const [reasonCode, setReasonCode] = useState('');
  const [notes, setNotes] = useState('');
  const [extension, setExtension] = useState('0');
  const [rebind, setRebind] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<DecisionResult | null>(null);
  const [incidentStatus, setIncidentStatus] = useState<IncidentStatus>(incident.status);
  // Loaded with the drawer: the lifetime warning count comes from it ("3 of 5 in this epoch · 5 lifetime").
  const timeline = useQuery({ queryKey: ['proctor', 'timeline', incident.attempt_id], queryFn: () => api.get<Timeline>(`/proctor/attempts/${incident.attempt_id}/timeline`) });
  const technical = TECHNICAL_SIGNAL_CLASSES.includes(incident.signal_class);
  const attemptStatus = last?.attemptStatus ?? incident.attemptStatus;

  const run = async (fn: () => Promise<DecisionResult>) => {
    setBusy(true);
    setError(null);
    try {
      const out = await fn();
      setLast(out);
      setAction('none');
      setReasonCode('');
      setNotes('');
      void qc.invalidateQueries({ queryKey: ['proctor', 'incidents'] });
      void qc.invalidateQueries({ queryKey: ['proctor', 'timeline', incident.attempt_id] });
      return out;
    } catch (e) {
      setError(isApiError(e) ? `${e.problem.title} (${e.code})` : 'The action failed. Try again.');
      return null;
    } finally {
      setBusy(false);
    }
  };
  const QUIET = ['TECHNICAL_NOT_COUNTABLE', 'ATTEMPT_STATE', 'NO_OPEN_EPOCH', 'EXAM_NOT_LIVE', 'ILLEGAL_TRANSITION'] as const;

  const decide = (a: 'DISMISS' | 'CONFIRM_WARNING' | 'MARK_TECHNICAL') =>
    run(async () => {
      const out = await api.post<DecisionResult>(`/proctor/incidents/${incident.id}/decision`, { action: a, reasonCode: reasonCode.trim(), notes: notes.trim() || undefined, idempotencyKey: uuid() }, { quiet: QUIET });
      setIncidentStatus(a === 'DISMISS' ? 'DISMISSED' : a === 'MARK_TECHNICAL' ? 'TECHNICAL' : 'CONFIRMED_COUNTABLE_WARNING');
      toast({ tone: a === 'CONFIRM_WARNING' ? 'warning' : 'info', title: a === 'DISMISS' ? 'Incident dismissed' : a === 'MARK_TECHNICAL' ? 'Marked technical' : `Warning confirmed: ${out.epoch?.confirmedCount ?? '?'} of ${threshold ?? '?'} in this epoch`, description: out.attemptStatus === 'SUSPENDED' ? 'The attempt is now paused; a chief invigilator can resume it.' : undefined });
      return out;
    });
  const hold = () =>
    run(async () => {
      const out = await api.post<DecisionResult>(`/proctor/attempts/${incident.attempt_id}/technical-holds`, { reasonCode: reasonCode.trim(), notes: notes.trim() || undefined, idempotencyKey: uuid() }, { quiet: QUIET });
      toast({ tone: 'info', title: 'Technical hold placed', description: 'The student sees a calm pause screen; answers are kept.' });
      return out;
    });
  const resume = () =>
    run(async () => {
      const out = await api.post<DecisionResult>(`/proctor/attempts/${incident.attempt_id}/resume`, { reasonCode: reasonCode.trim(), notes: notes.trim(), idempotencyKey: uuid(), deadlineExtensionMinutes: Number(extension) || 0, rebindDevice: rebind }, { quiet: QUIET });
      toast({ tone: 'success', title: 'Attempt resumed', description: `Epoch ${out.epoch?.no ?? '?'}, ${out.epoch?.confirmedCount ?? 0} warnings in it.` });
      return out;
    });

  return (
    <Dialog open onClose={onClose} variant="drawer" title={SIGNAL_LABEL[incident.signal_class] ?? humanize(incident.signal_class)} description={`${incident.studentName} · ${exam ? `${exam.code} · ${exam.title}` : 'exam'}`}>
      <div className="flex gap-1 mb-5" role="group" aria-label="View">
        <Button size="sm" variant={view === 'incident' ? 'secondary' : 'ghost'} aria-pressed={view === 'incident'} onClick={() => setView('incident')}>
          Incident
        </Button>
        <Button size="sm" variant={view === 'timeline' ? 'secondary' : 'ghost'} aria-pressed={view === 'timeline'} onClick={() => setView('timeline')}>
          Timeline
        </Button>
      </div>

      {view === 'incident' ? (
        <div className="flex flex-col gap-6">
          <KeyValue
            items={[
              { k: 'Attempt', v: <StatusChip tone={toneForAttempt(attemptStatus)}>{humanize(attemptStatus)}</StatusChip> },
              { k: 'Warnings', v: <WarningsText current={last?.epoch?.confirmedCount ?? incident.currentWarnings} threshold={threshold} epoch={last?.epoch?.no ?? incident.epochNo} lifetime={last?.lifetimeWarnings ?? timeline.data?.warnings.length} /> },
              { k: 'Events', v: `${incident.event_count}, first ${formatTime(incident.first_event_at, tz)}, last ${formatTime(incident.last_event_at, tz)}` },
              { k: 'Status', v: STATUS_LABEL[incidentStatus] },
              { k: 'Priority', v: String(incident.priority) },
            ]}
          />
          {technical ? <p className="text-sm text-ink-2">Technical signals (network, camera, recording) can never become a countable warning.</p> : null}

          <section className="flex flex-col gap-3" aria-labelledby="decide-h">
            <h3 id="decide-h" className="text-h3">
              Decide
            </h3>
            {incidentStatus === 'PROCTOR_REVIEW' || incidentStatus === 'TECHNICAL' ? (
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => setAction('DISMISS')}>Dismiss</Button>
                <Button variant="danger" onClick={() => setAction('CONFIRM_WARNING')} disabled={technical}>
                  Confirm warning
                </Button>
                <Button onClick={() => setAction('MARK_TECHNICAL')}>Mark technical</Button>
              </div>
            ) : (
              <p className="text-sm text-ink-2">This incident already has a decision.</p>
            )}
            <div className="flex flex-wrap gap-2 pt-2 border-t border-rule">
              <Button onClick={() => setAction('HOLD')} disabled={!['ACTIVE', 'RECOVERY_PENDING'].includes(attemptStatus)}>
                Technical hold
              </Button>
              {chief ? (
                <Button variant="primary" onClick={() => setAction('RESUME')} disabled={attemptStatus !== 'SUSPENDED'}>
                  Resume
                </Button>
              ) : null}
            </div>

            {action !== 'none' ? (
              <form
                className={`sheet p-4 flex flex-col gap-3 ${action === 'CONFIRM_WARNING' ? 'border-stop' : ''}`}
                onSubmit={(e) => {
                  e.preventDefault();
                  if (action === 'HOLD') void hold();
                  else if (action === 'RESUME') void resume();
                  else void decide(action);
                }}
              >
                <p className="font-medium">
                  {action === 'DISMISS' ? 'Dismiss this incident' : action === 'CONFIRM_WARNING' ? `Confirm a countable warning (${(last?.epoch?.confirmedCount ?? incident.currentWarnings ?? 0) + 1} of ${threshold ?? '?'})` : action === 'MARK_TECHNICAL' ? 'Mark as technical' : action === 'HOLD' ? 'Place a technical hold' : 'Resume the attempt'}
                </p>
                {action === 'CONFIRM_WARNING' ? <p className="text-sm text-ink-2">Reaching the threshold pauses the attempt automatically; the student is told to wait for the invigilator.</p> : null}
                {action === 'RESUME' ? <p className="text-sm text-ink-2">After a threshold pause, a new warning epoch opens at zero; history is kept.</p> : null}
                <Field label="Reason code" required>
                  {({ id }) => (
                    <>
                      <TextInput id={id} list="reason-codes" value={reasonCode} onChange={(e) => setReasonCode(e.target.value.toUpperCase().replace(/\s+/g, '_'))} className="font-mono" data-autofocus />
                      <datalist id="reason-codes">
                        {REASON_SUGGESTIONS.map((r) => (
                          <option key={r} value={r} />
                        ))}
                      </datalist>
                    </>
                  )}
                </Field>
                <Field label="Notes" required={action === 'RESUME'}>
                  {({ id }) => <TextArea id={id} value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />}
                </Field>
                {action === 'RESUME' ? (
                  <>
                    <Field label="Extend deadline by (minutes)" hint="Only to give back time lost to the pause; capped at the exam window.">
                      {({ id, describedBy }) => <TextInput id={id} type="number" min={0} max={240} value={extension} onChange={(e) => setExtension(e.target.value)} aria-describedby={describedBy} className="max-w-32" />}
                    </Field>
                    <Checkbox label="Student continues on a replacement device" description="Unbinds the current device; the next reconnect binds the new one." checked={rebind} onChange={(e) => setRebind(e.target.checked)} />
                  </>
                ) : null}
                {error ? (
                  <p className="text-stop text-sm" role="alert">
                    {error}
                  </p>
                ) : null}
                <div className="flex gap-2 justify-end">
                  <Button variant="ghost" type="button" onClick={() => setAction('none')} disabled={busy}>
                    Cancel
                  </Button>
                  <Button variant={action === 'CONFIRM_WARNING' ? 'danger' : 'primary'} type="submit" loading={busy} disabled={!reasonCode.trim() || (action === 'RESUME' && !notes.trim())}>
                    {action === 'DISMISS' ? 'Dismiss' : action === 'CONFIRM_WARNING' ? 'Confirm warning' : action === 'MARK_TECHNICAL' ? 'Mark technical' : action === 'HOLD' ? 'Place hold' : 'Resume'}
                  </Button>
                </div>
              </form>
            ) : null}
          </section>
        </div>
      ) : (
        <TimelineView timeline={timeline.data} loading={timeline.isLoading} tz={tz} threshold={threshold} />
      )}
    </Dialog>
  );
}

function TimelineView({ timeline, loading, tz, threshold }: { timeline: Timeline | undefined; loading: boolean; tz: string; threshold: number | undefined }) {
  if (loading) return <Skeleton lines={6} />;
  if (!timeline) return <p className="text-ink-2">No timeline yet.</p>;
  const when = (e: Record<string, unknown>) => String(e['server_received_at'] ?? e['created_at'] ?? e['occurred_at'] ?? '');
  return (
    <div className="flex flex-col gap-6">
      <KeyValue items={[{ k: 'Attempt', v: <StatusChip tone={toneForAttempt(timeline.attempt.status)}>{humanize(timeline.attempt.status)}</StatusChip> }, { k: 'Deadline', v: formatDateTime(timeline.attempt.deadline_at ?? null, tz) }, { k: 'Lifetime warnings', v: String(timeline.warnings.length) }]} />
      <section>
        <h3 className="text-h3 mb-2">Epochs</h3>
        <ul className="divide-y divide-rule border-y border-rule text-[15px]">
          {timeline.epochs.map((ep) => (
            <li key={ep.epoch_no} className="py-2 flex flex-wrap gap-x-4">
              <span className="font-medium">Epoch {ep.epoch_no}</span>
              <span className="tabular">
                {ep.confirmed_count} of {threshold ?? '—'} warnings
              </span>
              <span className="text-ink-2">{ep.closed_at ? `closed ${formatTime(ep.closed_at, tz)}` : 'open'}</span>
              {ep.reason ? <span className="text-ink-2">{humanize(ep.reason)}</span> : null}
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h3 className="text-h3 mb-2">Network addresses</h3>
        {timeline.network?.length ? (
          <ul className="divide-y divide-rule border-y border-rule text-sm" aria-label="Network addresses seen">
            {timeline.network.map((n) => (
              <li key={n.ip} className="py-2 flex flex-wrap gap-x-4 gap-y-1">
                <span className="font-mono">{n.ip}</span>
                <span className="text-ink-2">
                  first {formatTime(n.first_seen_at, tz)} via {humanize(n.first_source)} · last {formatTime(n.last_seen_at, tz)} · {n.observations} {n.observations === 1 ? 'request' : 'requests'}
                </span>
                {n.in_allowed_subnet === false ? <StatusChip tone="fix">Outside lab network</StatusChip> : null}
                {n.user_agent ? <span className="block w-full font-mono text-xs text-ink-3 break-all">{n.user_agent}</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ink-2 text-sm">No network observations yet.</p>
        )}
      </section>
      <section>
        <h3 className="text-h3 mb-2">Device scans</h3>
        <p className="text-sm text-ink-2 mb-2">Findings are derived by the server from what the browser reports. A clean scan is context, never proof; nothing here counts without your decision.</p>
        {timeline.deviceScans?.length ? (
          <ul className="divide-y divide-rule border-y border-rule text-sm" aria-label="Device scans">
            {timeline.deviceScans.map((d) => (
              <li key={d.id} className="py-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="text-ink-2 tabular">{formatTime(d.created_at, tz)}</span>
                <span>{humanize(d.phase)}</span>
                <StatusChip tone={d.verdict === 'CLEAN' ? 'ready' : d.verdict === 'REVIEW' ? 'note' : 'fix'}>{humanize(d.verdict)}</StatusChip>
                <span className="text-ink-2">{d.findings.length ? d.findings.map(humanize).join(', ') : 'No findings'}</span>
                {d.ip ? <span className="font-mono text-xs text-ink-3">{d.ip}</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ink-2 text-sm">No scans recorded.</p>
        )}
      </section>
      <section>
        <h3 className="text-h3 mb-2">Events</h3>
        <ol className="divide-y divide-rule border-y border-rule text-sm">
          {timeline.events.map((e) => (
            <li key={e.seq} className="py-2 grid grid-cols-[3rem_9rem_1fr] gap-3">
              <span className="font-mono text-ink-3 tabular">{e.seq}</span>
              <span className="text-ink-2 tabular">{formatTime(when(e), tz)}</span>
              <span>
                <span className="font-medium">{humanize(e.event_type)}</span>
                <span className="text-ink-2"> · {e.actor}</span>
                {e.metadata && Object.keys(e.metadata).length ? <span className="block font-mono text-xs text-ink-3 break-all">{JSON.stringify(e.metadata)}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
