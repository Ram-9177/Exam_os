import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { formatDate } from '@/lib/time';
import { Button, Dialog, EmptyState, Field, PageTitle, Skeleton, Table, TextArea, TextInput, useToast, type Column } from '@/ui';
import { numberOf, useLedger, requestStudentRevaluation, type LedgerRecord, type LedgerSemester } from './api';

function pct(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  const n = numberOf(v);
  return `${n.toFixed(1)}%`;
}

export function LedgerPage() {
  const { me } = useAuth();
  const tz = me?.tenant.timezone ?? 'Asia/Kolkata';
  const ledger = useLedger();
  const { toast } = useToast();

  const [selectedRecord, setSelectedRecord] = useState<LedgerRecord | null>(null);
  const [reason, setReason] = useState('');
  const [feeRef, setFeeRef] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleRequestReval = async () => {
    if (!selectedRecord?.attempt_id || !reason.trim()) return;
    setSubmitting(true);
    try {
      await requestStudentRevaluation(selectedRecord.attempt_id, {
        reason: reason.trim(),
        feeRef: feeRef.trim() || undefined,
      });
      toast({
        tone: 'success',
        title: 'Revaluation Requested',
        description: `Your request for ${selectedRecord.examTitle} has been submitted for review.`,
      });
      setSelectedRecord(null);
      setReason('');
      setFeeRef('');
    } catch (err: any) {
      toast({
        tone: 'error',
        title: 'Request Failed',
        description: err?.problem?.detail || err?.message || 'Could not submit revaluation request',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const columns: Column<LedgerRecord>[] = [
    { key: 'exam', header: 'Exam', render: (r) => (
        <div>
          <p className="font-medium">{r.examTitle}</p>
          <p className="text-sm text-ink-2">{[r.courseCode, r.courseName].filter(Boolean).join(' · ') || r.examCode}</p>
        </div>
      ) },
    { key: 'type', header: 'Type', render: (r) => r.exam_type.replace(/_/g, ' ').toLowerCase(), hideOnMobile: true },
    { key: 'term', header: 'Term', render: (r) => `${r.academic_year ?? '—'}${r.semester ? ` · Sem ${r.semester}` : ''}`, hideOnMobile: true },
    { key: 'marks', header: 'Marks', align: 'right', render: (r) => (
        <span className="font-mono tabular">
          {numberOf(r.marks)} / {numberOf(r.max_marks)}
        </span>
      ) },
    { key: 'grade', header: 'Grade', align: 'right', render: (r) => <span className="font-mono">{r.grade ?? '—'}</span> },
    { key: 'published', header: 'Published', render: (r) => formatDate(r.published_at, tz), hideOnMobile: true },
    {
      key: 'revaluation',
      header: 'Revaluation',
      render: (r) => {
        if (!r.attempt_id) return null;
        return (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setSelectedRecord(r);
              setReason('');
              setFeeRef('');
            }}
          >
            Appeal / Revalue
          </Button>
        );
      },
    },
  ];

  return (
    <div className="max-w-5xl">
      <PageTitle title="Results" lede="Published results only. Each entry is the version the Controller authorised; corrections supersede, never overwrite." />
      {ledger.isLoading ? <Skeleton lines={5} /> : null}
      {ledger.isError ? <EmptyState title="Your results could not be loaded">Reload the page, or try again in a few minutes.</EmptyState> : null}
      {ledger.data ? (
        ledger.data.records.length === 0 ? (
          <EmptyState title="No published results yet">Results appear here after the Examination Cell approves and the Controller publishes them.</EmptyState>
        ) : (
          <>
            <section aria-labelledby="overall" className="mb-10">
              <h2 id="overall" className="visually-hidden">
                Overall
              </h2>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-rule border border-rule rounded-md overflow-hidden">
                <Stat label="Exams" value={String(numberOf(ledger.data.overall.exams))} />
                <Stat label="Semesters" value={String(numberOf(ledger.data.overall.semesters))} />
                <Stat label="Marks" value={`${numberOf(ledger.data.overall.marks)} / ${numberOf(ledger.data.overall.max_marks)}`} />
                <Stat label="Overall" value={pct(ledger.data.overall.percentage)} />
              </div>
            </section>

            <section aria-labelledby="semesters" className="mb-10">
              <h2 id="semesters" className="text-h3 mb-3">
                By semester
              </h2>
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {ledger.data.semesters.map((s: LedgerSemester) => (
                  <li key={`${s.academic_year}-${s.semester}`} className="sheet p-4">
                    <p className="text-ink-2 text-sm">{s.academic_year ?? '—'}</p>
                    <p className="font-serif text-h3">Semester {s.semester ?? '—'}</p>
                    <p className="mt-2 font-mono tabular">
                      {numberOf(s.marks)} / {numberOf(s.max_marks)} <span className="text-ink-2">· {pct(s.percentage)}</span>
                    </p>
                    <p className="text-sm text-ink-2">{numberOf(s.exams)} exams</p>
                  </li>
                ))}
              </ul>
            </section>

            <section aria-labelledby="examwise">
              <h2 id="examwise" className="text-h3 mb-3">
                Exam-wise
              </h2>
              <Table caption="Published results, exam-wise" columns={columns} rows={ledger.data.records} rowKey={(r) => `${r.examCode}-${r.published_at}`} />
            </section>
          </>
        )
      ) : null}

      {selectedRecord ? (
        <Dialog
          open={!!selectedRecord}
          onClose={() => setSelectedRecord(null)}
          title={`Request Revaluation — ${selectedRecord.examTitle}`}
        >
          <div className="space-y-4">
            <p className="text-sm text-ink-2">
              University regulations allow a 7-day window from publication for revaluation appeals.
              A revaluation request will be reviewed by the Examination Cell and Department Chair before entering academic re-marking.
            </p>
            <Field label="Academic Justification" hint="Detail questions or grading criteria requiring specific re-evaluation">
              {({ id, describedBy }) => (
                <TextArea
                  id={id}
                  rows={4}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Explain clearly which answers or rubrics should be reconsidered..."
                  aria-describedby={describedBy}
                />
              )}
            </Field>
            <Field label="Challan / Fee Reference" hint="Optional fee payment transaction identifier">
              {({ id, describedBy }) => (
                <TextInput
                  id={id}
                  value={feeRef}
                  onChange={(e) => setFeeRef(e.target.value)}
                  placeholder="e.g. SMRU-REV-2026-XXXX"
                  aria-describedby={describedBy}
                />
              )}
            </Field>
            <div className="flex justify-end gap-3 pt-2">
              <Button variant="ghost" onClick={() => setSelectedRecord(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={handleRequestReval}
                disabled={submitting || !reason.trim()}
              >
                {submitting ? 'Submitting...' : 'Submit Request'}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-sheet p-4">
      <p className="text-sm text-ink-2">{label}</p>
      <p className="font-mono tabular text-2xl mt-1">{value}</p>
    </div>
  );
}
