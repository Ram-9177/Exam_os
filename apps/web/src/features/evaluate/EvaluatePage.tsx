import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, isApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/time';
import { useBooklet } from '@/features/booklet/BookletPage';
import { BookletView, questionLabel, type Booklet, type BookletQuestion } from '@/features/booklet/BookletView';
import { useExams } from '@/features/examcell/api';
import { Button, EmptyState, Field, PageTitle, Skeleton, Stamp, Table, TextArea, TextInput, toneForExam, StatusChip, useToast } from '@/ui';
import { EXAM_STATUS_LABEL } from '@/features/examcell/api';

interface Criterion {
  code: string;
  max: string;
  awarded: string;
  evidence: string;
}
interface Entry {
  marks: string;
  maxMarks: string;
  explanation: string;
  criteria: Criterion[];
}

export function useEvaluatorAssignments(examId?: string) {
  return useQuery({
    queryKey: ['evaluator-assignments', examId],
    queryFn: () =>
      api.get<
        Array<{
          assignmentId: string;
          attemptId: string;
          examId: string;
          examTitle: string;
          examCode: string;
          examType: string;
          roleType: string;
          assignmentStatus: string;
          candidateStatus: string;
          isAnonymized: boolean;
          anonymizedIdentifier: string | null;
          candidateName: string | null;
          candidateEmail: string | null;
          hallTicketNumber: string | null;
        }>
      >(`/evaluator/me/assignments${examId ? `?examId=${examId}` : ''}`),
  });
}

/** Examiners land here: view their assigned marking queue, or open a candidate attempt by id. */
export function EvaluateHomePage() {
  const { me } = useAuth();
  const tz = me?.tenant.timezone ?? 'Asia/Kolkata';
  const exams = useExams({});
  const assignments = useEvaluatorAssignments();
  const navigate = useNavigate();
  const [attemptId, setAttemptId] = useState('');

  return (
    <div className="max-w-4xl space-y-8">
      <div>
        <PageTitle
          title="Marking & Evaluation"
          lede="Enter marks question by question with one explanation each. External evaluations are strictly anonymized."
        />
      </div>

      {/* Evaluator Assignment Queue */}
      <section aria-labelledby="queue-heading" className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 id="queue-heading" className="text-h3">
            Assigned Queue
          </h2>
          {assignments.data ? (
            <span className="text-sm text-ink-2 font-mono">
              {assignments.data.length} assigned
            </span>
          ) : null}
        </div>

        {assignments.isLoading ? <Skeleton lines={3} /> : null}
        {assignments.data && assignments.data.length > 0 ? (
          <Table
            caption="Candidates assigned for marking"
            columns={[
              {
                key: 'candidate',
                header: 'Candidate',
                render: (a) =>
                  a.isAnonymized ? (
                    <span className="px-2 py-0.5 rounded text-xs font-mono font-medium bg-amber-50 text-amber-900 border border-amber-300">
                      {a.anonymizedIdentifier ?? 'ANONYMIZED'}
                    </span>
                  ) : (
                    <div>
                      <p className="font-medium">{a.candidateName ?? 'Candidate'}</p>
                      <p className="text-xs text-ink-2 font-mono">{a.hallTicketNumber ?? a.candidateEmail}</p>
                    </div>
                  ),
              },
              {
                key: 'exam',
                header: 'Exam',
                render: (a) => (
                  <div>
                    <p className="font-medium">{a.examTitle}</p>
                    <p className="text-xs font-mono text-ink-2">{a.examCode}</p>
                  </div>
                ),
              },
              {
                key: 'role',
                header: 'Role',
                render: (a) => (
                  <span className="text-xs font-mono px-2 py-0.5 rounded bg-surface border border-rule">
                    {a.roleType}
                  </span>
                ),
              },
              {
                key: 'status',
                header: 'Status',
                render: (a) => (
                  <span className="text-xs font-medium">
                    {a.assignmentStatus}
                  </span>
                ),
              },
              {
                key: 'action',
                header: 'Action',
                align: 'right',
                render: (a) => (
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => navigate(`/evaluate/${a.attemptId}`)}
                  >
                    Evaluate
                  </Button>
                ),
              },
            ]}
            rows={assignments.data}
            rowKey={(a) => a.assignmentId}
            empty="No candidates assigned."
          />
        ) : (
          <div className="sheet p-5 text-center text-sm text-ink-2">
            You currently have no pending assigned candidates. Use the attempt id below to open a specific paper.
          </div>
        )}
      </section>

      {/* Manual Attempt Lookup */}
      <section className="sheet p-6">
        <h3 className="font-medium text-ink-1 mb-2">Open by Attempt ID</h3>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (attemptId.trim()) navigate(`/evaluate/${attemptId.trim()}`);
          }}
        >
          <Field
            label="Attempt UUID"
            hint="From your department allocation sheet"
            className="flex-1 min-w-64"
          >
            {({ id, describedBy }) => (
              <TextInput
                id={id}
                value={attemptId}
                onChange={(e) => setAttemptId(e.target.value)}
                aria-describedby={describedBy}
                className="font-mono"
                placeholder="00000000-0000-0000-0000-000000000000"
              />
            )}
          </Field>
          <Button type="submit" variant="ghost" disabled={!attemptId.trim()}>
            Open Attempt
          </Button>
        </form>
      </section>

      <section>
        <h2 className="text-h3 mb-3">All Exams</h2>
        {exams.isLoading ? <Skeleton lines={4} /> : null}
        {exams.data ? (
          <Table
            caption="Exams"
            columns={[
              { key: 'code', header: 'Code', render: (e) => <span className="font-mono">{e.code}</span> },
              { key: 'title', header: 'Title', render: (e) => e.title },
              { key: 'status', header: 'Status', render: (e) => <StatusChip tone={toneForExam(e.status)} icon={false}>{EXAM_STATUS_LABEL[e.status]}</StatusChip> },
              { key: 'window', header: 'Window', hideOnMobile: true, render: (e) => formatDateTime(e.windowStartAt, tz) },
            ]}
            rows={exams.data.exams}
            rowKey={(e) => e.id}
            empty="No exams yet."
          />
        ) : null}
      </section>
    </div>
  );
}

/**
 * The marking sheet lists every question of the approved paper: the booklet
 * API already returns them all, answered or not (unanswered ones can only be
 * marked 0). Only a script with no paper on record (exams from before the
 * paper module) falls back to the answered questions plus a placeholder list
 * (`?questions=` or Q1..Q5); an explicit `?questions=` list always wins.
 * Padding a paper-backed script would add questions the server refuses
 * (UNKNOWN_QUESTION_ID), and the evaluator could not record marks at all.
 */
const byQuestionId = (a: BookletQuestion, b: BookletQuestion) => a.questionId.localeCompare(b.questionId, undefined, { numeric: true });
function withPlaceholderQuestions(booklet: Booklet, raw: string | null): Booklet {
  const fromPaper = booklet.questions.some((q) => q.prompt !== null && q.prompt !== undefined);
  if (fromPaper && !raw) return { ...booklet, questions: [...booklet.questions].sort(byQuestionId) };
  const ids = (raw ? raw.split(',') : ['Q1', 'Q2', 'Q3', 'Q4', 'Q5']).map((x) => x.trim()).filter((x) => /^[A-Za-z0-9._-]{1,64}$/.test(x));
  const known = new Set(booklet.questions.map((q) => q.questionId));
  const extra: BookletQuestion[] = ids.filter((id) => !known.has(id)).map((id) => ({ questionId: id, answer: { blocks: [] }, answerSha256: null, revision: 0, marks: null, maxMarks: null, explanation: null, criteria: null }));
  const questions = [...booklet.questions, ...extra].sort(byQuestionId);
  return { ...booklet, questions };
}

export function EvaluatePage() {
  const { attemptId = '' } = useParams();
  const [params] = useSearchParams();
  const { me } = useAuth();
  const tz = me?.tenant.timezone ?? 'Asia/Kolkata';
  const bookletQuery = useBooklet(attemptId);
  const questionsParam = params.get('questions');
  const bookletData = useMemo(() => (bookletQuery.data ? withPlaceholderQuestions(bookletQuery.data, questionsParam) : undefined), [bookletQuery.data, questionsParam]);
  const booklet = { isLoading: bookletQuery.isLoading, isError: bookletQuery.isError, error: bookletQuery.error, data: bookletData };
  const qc = useQueryClient();
  const { toast } = useToast();
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [proposalsBusy, setProposalsBusy] = useState(false);
  const [done, setDone] = useState<{ resultVersionId: string; version: number; total: number; max: number; invalidatedApprovals: number } | null>(null);

  const fetchRubricProposals = async () => {
    setProposalsBusy(true);
    try {
      const res = await api.get<{
        attemptId: string;
        proposals: Array<{
          questionId: string;
          maxMarks: number;
          suggestedMarks: number;
          suggestionExplanation: string;
          criteriaSuggestions: Array<{ code: string; max: number; awarded: number }>;
        }>;
      }>(`/candidates/${attemptId}/rubric-proposals`);

      for (const p of res.proposals) {
        update(p.questionId, {
          marks: String(p.suggestedMarks),
          maxMarks: String(p.maxMarks),
          explanation: p.suggestionExplanation,
          criteria: p.criteriaSuggestions.map((c) => ({
            code: c.code,
            max: String(c.max),
            awarded: String(c.awarded),
            evidence: '',
          })),
        });
      }
      toast({
        tone: 'info',
        title: 'Rubric Proposals Applied',
        description: 'Review and adjust suggested marks and explanations before saving.',
      });
    } catch {
      toast({
        tone: 'error',
        title: 'Could not load proposals',
        description: 'No approved paper rubric was available for this attempt.',
      });
    } finally {
      setProposalsBusy(false);
    }
  };

  useEffect(() => {
    const data = booklet.data;
    if (!data) return;
    setEntries((prev) => {
      const next = { ...prev };
      for (const q of data.questions) {
        if (!next[q.questionId]) {
          next[q.questionId] = {
            marks: q.marks !== null ? String(q.marks) : '',
            maxMarks: q.maxMarks !== null ? String(q.maxMarks) : '',
            explanation: q.explanation ?? '',
            criteria: (q.criteria ?? []).map((c) => ({ code: c.code, max: String(c.max), awarded: String(c.awarded), evidence: c.evidence ?? '' })),
          };
        }
      }
      return next;
    });
  }, [booklet.data]);

  const totals = useMemo(() => {
    let marks = 0;
    let max = 0;
    for (const e of Object.values(entries)) {
      marks += Number(e.marks) || 0;
      max += Number(e.maxMarks) || 0;
    }
    return { marks: Math.round(marks * 100) / 100, max: Math.round(max * 100) / 100 };
  }, [entries]);

  const update = (qid: string, patch: Partial<Entry>) => setEntries((x) => ({ ...x, [qid]: { ...(x[qid] ?? { marks: '', maxMarks: '', explanation: '', criteria: [] }), ...patch } }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!booklet.data) return;
    const errs: Record<string, string> = {};
    const items = booklet.data.questions.map((q) => {
      const en = entries[q.questionId] ?? { marks: '', maxMarks: '', explanation: '', criteria: [] };
      const marks = Number(en.marks);
      const maxMarks = Number(en.maxMarks);
      if (en.maxMarks === '' || !Number.isFinite(maxMarks) || maxMarks < 0) errs[q.questionId] = 'Set the maximum marks.';
      else if (en.marks === '' || !Number.isFinite(marks) || marks < 0 || marks > maxMarks) errs[q.questionId] = `Marks must be between 0 and ${maxMarks}.`;
      else if (!en.explanation.trim()) errs[q.questionId] = 'An explanation is required for every question.';
      const criteria = en.criteria.filter((c) => c.code.trim());
      if (criteria.length) {
        const sum = criteria.reduce((a, c) => a + (Number(c.awarded) || 0), 0);
        if (Math.abs(sum - marks) > 0.001) errs[q.questionId] = `Criteria add up to ${sum}, but marks are ${marks}.`;
        if (criteria.some((c) => (Number(c.awarded) || 0) > (Number(c.max) || 0))) errs[q.questionId] = 'A criterion awards more than its maximum.';
      }
      return { questionId: q.questionId, maxMarks, marks, explanation: en.explanation.trim(), ...(criteria.length ? { criteria: criteria.map((c) => ({ code: c.code.trim(), max: Number(c.max) || 0, awarded: Number(c.awarded) || 0, ...(c.evidence.trim() ? { evidence: c.evidence.trim() } : {}) })) } : {}) };
    });
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const out = await api.post<{ resultVersionId: string; version: number; total: number; max: number; invalidatedApprovals: number }>(`/candidates/${attemptId}/result-versions`, { items }, { quiet: ['PACKET_STATE', 'MARK_OUT_OF_RANGE', 'CRITERIA_SUM_MISMATCH', 'CRITERION_OUT_OF_RANGE', 'EXPLANATION_REQUIRED', 'MARKS_WITHOUT_ANSWER'] });
      setDone(out);
      void qc.invalidateQueries({ queryKey: ['booklet', attemptId] });
      toast({ tone: 'success', title: `Result version ${out.version} recorded`, description: `${out.total} / ${out.max}${out.invalidatedApprovals ? ` · ${out.invalidatedApprovals} earlier approval invalidated` : ''}` });
    } catch (err) {
      if (isApiError(err, 'PACKET_STATE')) setErrors({ _: `Marks cannot be recorded now: ${err.problem.title}.` });
      else if (isApiError(err)) setErrors({ _: `${err.problem.title} (${err.code})` });
    } finally {
      setBusy(false);
    }
  };

  if (booklet.isLoading) return <Skeleton lines={8} className="max-w-3xl" />;
  if (booklet.isError || !booklet.data) {
    return <EmptyState title="This attempt could not be opened">{isApiError(booklet.error, 'PACKET_NOT_FOUND') ? 'No review packet exists for this attempt; it is created when the attempt is sealed.' : 'Check the attempt id.'}</EmptyState>;
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate>
      <div className="max-w-[210mm] mx-auto mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-h2">Marks entry</h1>
          <p className="text-ink-2">Each question needs marks, a maximum and one explanation. Criteria rows are optional and must add up to the marks.</p>
        </div>
        <div className="flex items-center gap-4">
          <Button
            size="sm"
            variant="ghost"
            type="button"
            onClick={fetchRubricProposals}
            disabled={proposalsBusy}
          >
            {proposalsBusy ? 'Analyzing Rubrics...' : 'Suggest Rubric Marks (AI)'}
          </Button>
          <div className="text-right">
            <p className="text-sm text-ink-2">Running total</p>
            <p className="font-mono tabular text-2xl">
              {totals.marks} / {totals.max}
            </p>
          </div>
        </div>
      </div>

      {done ? (
        <div className="max-w-[210mm] mx-auto mb-6 sheet p-5 flex items-center gap-5">
          <Stamp tone="ready" className="text-xl">
            Recorded
          </Stamp>
          <div>
            <p className="font-medium">
              Version {done.version}: {done.total} / {done.max}
            </p>
            <p className="text-sm text-ink-2 font-mono">{done.resultVersionId}</p>
          </div>
        </div>
      ) : null}
      {errors['_'] ? (
        <p className="max-w-[210mm] mx-auto mb-6 text-stop" role="alert">
          {errors['_']}
        </p>
      ) : null}

      <BookletView
        booklet={booklet.data}
        tz={tz}
        marks={(q: BookletQuestion, i: number) => {
          const en = entries[q.questionId] ?? { marks: '', maxMarks: '', explanation: '', criteria: [] };
          const err = errors[q.questionId];
          return (
            <fieldset className="border border-rule-2 rounded-sm p-4 bg-sheet-2 flex flex-col gap-3">
              <legend className="px-1 text-sm font-medium">Marks for {questionLabel(q.questionId, i).toLowerCase()}</legend>
              <div className="grid grid-cols-2 gap-3 max-w-xs">
                <Field label="Marks">
                  {({ id }) => <TextInput id={id} type="number" min={0} step="0.5" value={en.marks} onChange={(e) => update(q.questionId, { marks: e.target.value })} className="font-mono" aria-invalid={!!err || undefined} />}
                </Field>
                <Field label="Out of">
                  {({ id }) => <TextInput id={id} type="number" min={0} step="0.5" value={en.maxMarks} onChange={(e) => update(q.questionId, { maxMarks: e.target.value })} className="font-mono" />}
                </Field>
              </div>
              <Field label="Marks explanation" required hint={q.answerSha256 ? 'Shown to the student in the booklet.' : 'No answer was written; the server accepts 0 marks only.'}>
                {({ id, describedBy }) => <TextArea id={id} value={en.explanation} onChange={(e) => update(q.questionId, { explanation: e.target.value })} aria-describedby={describedBy} rows={3} />}
              </Field>
              <div>
                <p className="text-sm font-medium mb-2">Criteria (optional)</p>
                {en.criteria.length ? (
                  <ul className="flex flex-col gap-2">
                    {en.criteria.map((c, ci) => (
                      <li key={ci} className="grid grid-cols-[1fr_5rem_5rem_1fr_auto] gap-2 items-end">
                        <Field label="Code" hideLabel>
                          {({ id }) => <TextInput id={id} value={c.code} placeholder="Code" onChange={(e) => update(q.questionId, { criteria: en.criteria.map((x, k) => (k === ci ? { ...x, code: e.target.value } : x)) })} className="font-mono text-sm" />}
                        </Field>
                        <Field label="Max" hideLabel>
                          {({ id }) => <TextInput id={id} type="number" min={0} step="0.5" value={c.max} placeholder="Max" onChange={(e) => update(q.questionId, { criteria: en.criteria.map((x, k) => (k === ci ? { ...x, max: e.target.value } : x)) })} className="font-mono text-sm" />}
                        </Field>
                        <Field label="Awarded" hideLabel>
                          {({ id }) => <TextInput id={id} type="number" min={0} step="0.5" value={c.awarded} placeholder="Awarded" onChange={(e) => update(q.questionId, { criteria: en.criteria.map((x, k) => (k === ci ? { ...x, awarded: e.target.value } : x)) })} className="font-mono text-sm" />}
                        </Field>
                        <Field label="Evidence" hideLabel>
                          {({ id }) => <TextInput id={id} value={c.evidence} placeholder="Evidence" onChange={(e) => update(q.questionId, { criteria: en.criteria.map((x, k) => (k === ci ? { ...x, evidence: e.target.value } : x)) })} className="text-sm" />}
                        </Field>
                        <Button size="sm" variant="ghost" onClick={() => update(q.questionId, { criteria: en.criteria.filter((_, k) => k !== ci) })} aria-label={`Remove criterion ${ci + 1}`}>
                          Remove
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <Button size="sm" className="mt-2" onClick={() => update(q.questionId, { criteria: [...en.criteria, { code: '', max: '', awarded: '', evidence: '' }] })}>
                  Add criterion
                </Button>
              </div>
              {err ? (
                <p className="text-stop text-sm" role="alert">
                  {err}
                </p>
              ) : null}
            </fieldset>
          );
        }}
      />

      <div className="max-w-[210mm] mx-auto mt-6 flex justify-end">
        <Button type="submit" variant="primary" size="lg" loading={busy}>
          Record marks as version {(booklet.data.total?.version ?? 0) + 1}
        </Button>
      </div>
    </form>
  );
}
