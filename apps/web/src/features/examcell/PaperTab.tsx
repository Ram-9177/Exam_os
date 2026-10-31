import { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, isApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  KeyValue,
  Skeleton,
  StatusChip,
  TextInput,
  TextArea,
  Select,
  useToast,
  type Tone,
} from '@/ui';
import { useExamPaper, type ExamRow, type PaperQuestion, type PaperSection } from './api';

const STATUS_TONE: Record<string, Tone> = {
  DRAFT: 'neutral',
  REVIEW: 'accent',
  APPROVED: 'ready',
  SUPERSEDED: 'stop',
};

export function PaperTab({ exam }: { exam: ExamRow }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const { toast } = useToast();
  const paperQuery = useExamPaper(exam.id);

  const [title, setTitle] = useState('');
  const [instructions, setInstructions] = useState('');
  const [sections, setSections] = useState<PaperSection[]>([{ code: 'A', title: 'Section A' }]);
  const [questions, setQuestions] = useState<PaperQuestion[]>([]);
  const [saving, setSaving] = useState(false);
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectFeedback, setRejectFeedback] = useState('');

  const paper = paperQuery.data?.paper;

  useEffect(() => {
    if (paper) {
      setTitle(paper.title);
      setInstructions(paper.instructions ?? '');
      setSections(paper.sections.length > 0 ? paper.sections : [{ code: 'A', title: 'Section A' }]);
      setQuestions(paper.questions);
    } else {
      setTitle(`${exam.title} Question Paper`);
      setSections([{ code: 'A', title: 'Section A' }]);
      setQuestions([
        {
          questionId: 'Q1',
          sectionCode: 'A',
          number: 1,
          kind: 'DESCRIPTIVE',
          prompt: { blocks: [{ id: 'b1', kind: 'paragraph', content: '' }] },
          maxMarks: Number(exam.max_marks ?? 10),
          rubric: [],
          attachments: [],
        },
      ]);
    }
  }, [paper, exam.title, exam.max_marks]);

  if (paperQuery.isLoading) return <Skeleton lines={6} />;

  const totalMarks = questions.reduce((sum, q) => sum + (Number(q.maxMarks) || 0), 0);
  const examMaxMarks = exam.max_marks != null ? Number(exam.max_marks) : null;
  const marksMatch = examMaxMarks == null || totalMarks === examMaxMarks;
  const isApproved = paper?.status === 'APPROVED';
  const isReview = paper?.status === 'REVIEW';
  const canEdit = (!paper || paper.status === 'DRAFT' || paper.status === 'REVIEW') && ['DRAFT', 'PAPER_REVIEW'].includes(exam.status);

  const savePaper = async (thenSubmit = false) => {
    setSaving(true);
    try {
      await api.put(`/exams/${exam.id}/paper`, {
        title,
        instructions: instructions.trim() || undefined,
        sections,
        questions: questions.map((q, i) => ({
          questionId: q.questionId.trim() || `Q${i + 1}`,
          sectionCode: q.sectionCode || 'A',
          number: i + 1,
          kind: q.kind,
          prompt: q.prompt,
          options: q.options,
          maxMarks: Number(q.maxMarks) || 1,
          rubric: q.rubric,
          expectedAnswer: q.expectedAnswer,
          attachments: q.attachments ?? [],
        })),
      });

      if (thenSubmit) {
        await api.post(`/exams/${exam.id}/paper/submit-for-review`, {});
        toast({ tone: 'success', title: 'Submitted for review', description: 'Paper is now awaiting reviewer approval' });
      } else {
        toast({ tone: 'success', title: 'Draft saved', description: `${questions.length} questions saved` });
      }
      await qc.invalidateQueries({ queryKey: ['exam', exam.id] });
    } catch (e) {
      if (isApiError(e)) {
        toast({ tone: 'warning', title: 'Could not save paper', description: e.problem.detail ?? e.problem.title });
      } else {
        toast({ tone: 'warning', title: 'Could not save paper', description: 'Network or server error' });
      }
    } finally {
      setSaving(false);
    }
  };

  const handleApprove = async () => {
    try {
      await api.post(`/exams/${exam.id}/paper/approve`, {});
      toast({ tone: 'success', title: 'Paper approved', description: 'Question paper sealed and ready for exam conduct' });
      setConfirmApprove(false);
      await qc.invalidateQueries({ queryKey: ['exam', exam.id] });
    } catch (e) {
      if (isApiError(e)) {
        toast({ tone: 'warning', title: 'Approval refused', description: e.problem.detail ?? e.problem.title });
      }
    }
  };

  const handleReject = async () => {
    try {
      await api.post(`/exams/${exam.id}/paper/reject`, { feedback: rejectFeedback });
      toast({ tone: 'info', title: 'Paper rejected', description: 'Returned to draft with reviewer feedback' });
      setRejectOpen(false);
      setRejectFeedback('');
      await qc.invalidateQueries({ queryKey: ['exam', exam.id] });
    } catch (e) {
      if (isApiError(e)) {
        toast({ tone: 'warning', title: 'Action refused', description: e.problem.detail ?? e.problem.title });
      }
    }
  };

  const addQuestion = () => {
    const nextNum = questions.length + 1;
    setQuestions([
      ...questions,
      {
        questionId: `Q${nextNum}`,
        sectionCode: sections[0]?.code ?? 'A',
        number: nextNum,
        kind: 'DESCRIPTIVE',
        prompt: { blocks: [{ id: `b${nextNum}`, kind: 'paragraph', content: '' }] },
        maxMarks: 5,
        rubric: [],
        attachments: [],
      },
    ]);
  };

  const updateQuestion = (index: number, patch: Partial<PaperQuestion>) => {
    setQuestions(questions.map((q, i) => (i === index ? { ...q, ...patch } : q)));
  };

  const removeQuestion = (index: number) => {
    setQuestions(questions.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-8 max-w-4xl">
      {/* Paper Status Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-lg bg-sheet border border-rule">
        <div className="flex items-center gap-3">
          <StatusChip tone={STATUS_TONE[paper?.status ?? 'DRAFT'] ?? 'neutral'}>
            {paper?.status ?? 'DRAFT'}
          </StatusChip>
          <span className="font-mono text-sm text-ink-2">
            Version {paper?.version ?? 1}
          </span>
          {paper?.sealedSha256 ? (
            <Badge tone="ready" title={paper.sealedSha256}>
              Sealed: {paper.sealedSha256.slice(0, 8)}…
            </Badge>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <span className="text-sm text-ink-2">Total Marks:</span>
          <span className={`font-mono font-semibold ${marksMatch ? 'text-ink' : 'text-stop'}`}>
            {totalMarks} {examMaxMarks != null ? `/ ${examMaxMarks}` : ''}
          </span>
          {!marksMatch ? (
            <Badge tone="stop">Marks Mismatch</Badge>
          ) : (
            <Badge tone="ready">Marks Match</Badge>
          )}
        </div>
      </div>

      {/* Review Actions (if in review or examcell/reviewer) */}
      {isReview && ['DRAFT', 'PAPER_REVIEW'].includes(exam.status) ? (
        <div className="p-4 rounded-lg bg-sheet-2 border border-accent space-y-3">
          <p className="font-semibold text-accent">Paper Review Pending</p>
          <p className="text-sm text-ink-2">
            This question paper has been submitted for review. An authorized reviewer or Exam Cell operator can approve or reject it.
          </p>
          <div className="flex gap-3">
            <Button variant="primary" onClick={() => setConfirmApprove(true)}>
              Approve Paper
            </Button>
            <Button variant="secondary" onClick={() => setRejectOpen(true)}>
              Reject Paper
            </Button>
          </div>
        </div>
      ) : null}

      {/* Form Fields */}
      <div className="space-y-6">
        <Field label="Paper Title" required>
          {({ id, describedBy }) => (
            <TextInput
              id={id}
              aria-describedby={describedBy}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={!canEdit}
              placeholder="e.g. Mid Examination — Autumn 2026"
            />
          )}
        </Field>

        <Field label="Instructions to Candidates">
          {({ id, describedBy }) => (
            <TextArea
              id={id}
              aria-describedby={describedBy}
              rows={2}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              disabled={!canEdit}
              placeholder="e.g. Answer all questions. All questions carry equal marks."
            />
          )}
        </Field>

        {/* Questions Section */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-h3 font-serif">Questions ({questions.length})</h2>
            {canEdit ? (
              <Button variant="secondary" onClick={addQuestion}>
                + Add Question
              </Button>
            ) : null}
          </div>

          <div className="space-y-6">
            {questions.map((q, idx) => (
              <div key={idx} className="p-4 rounded-lg border border-rule bg-sheet space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule pb-3">
                  <div className="flex items-center gap-3">
                    <span className="font-mono font-bold text-ink">Q{idx + 1}</span>
                    <Field label="ID" className="w-24">
                      {({ id }) => (
                        <TextInput
                          id={id}
                          value={q.questionId}
                          onChange={(e) => updateQuestion(idx, { questionId: e.target.value })}
                          disabled={!canEdit}
                          placeholder="Q1"
                        />
                      )}
                    </Field>
                    <Field label="Kind" className="w-36">
                      {({ id }) => (
                        <Select
                          id={id}
                          value={q.kind}
                          onChange={(e) => updateQuestion(idx, { kind: e.target.value as PaperQuestion['kind'] })}
                          disabled={!canEdit}
                        >
                          <option value="DESCRIPTIVE">Descriptive</option>
                          <option value="MCQ">MCQ</option>
                          <option value="NUMERIC">Numeric</option>
                          <option value="DRAWING">Drawing</option>
                        </Select>
                      )}
                    </Field>
                    <Field label="Max Marks" className="w-24">
                      {({ id }) => (
                        <TextInput
                          id={id}
                          type="number"
                          min="1"
                          max="1000"
                          value={q.maxMarks}
                          onChange={(e) => updateQuestion(idx, { maxMarks: Number(e.target.value) })}
                          disabled={!canEdit}
                        />
                      )}
                    </Field>
                  </div>

                  {canEdit && questions.length > 1 ? (
                    <Button variant="ghost" onClick={() => removeQuestion(idx)} className="text-stop">
                      Delete
                    </Button>
                  ) : null}
                </div>

                <Field label="Question Prompt">
                  {({ id, describedBy }) => (
                    <TextArea
                      id={id}
                      aria-describedby={describedBy}
                      rows={3}
                      value={typeof q.prompt.blocks[0]?.content === 'string' ? q.prompt.blocks[0].content : ''}
                      onChange={(e) =>
                        updateQuestion(idx, {
                          prompt: { blocks: [{ id: `b${idx + 1}`, kind: 'paragraph', content: e.target.value }] },
                        })
                      }
                      disabled={!canEdit}
                      placeholder="Enter the question text here…"
                    />
                  )}
                </Field>

                <RubricEditor question={q} disabled={!canEdit} onChange={(patch) => updateQuestion(idx, patch)} />
              </div>
            ))}
          </div>
        </div>

        {/* Action Buttons */}
        {canEdit ? (
          <div className="flex gap-3 pt-4 border-t border-rule">
            <Button variant="primary" disabled={saving || !marksMatch} onClick={() => savePaper(false)}>
              {saving ? 'Saving…' : 'Save Draft'}
            </Button>
            <Button
              variant="secondary"
              disabled={saving || !marksMatch || questions.length === 0}
              onClick={() => savePaper(true)}
            >
              Save & Submit for Review
            </Button>
            {!marksMatch ? (
              <span className="self-center text-sm text-stop">
                Total marks must match {examMaxMarks} before submission
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Confirm Approve Dialog */}
      <ConfirmDialog
        open={confirmApprove}
        title="Approve Question Paper?"
        confirmLabel="Approve Paper"
        tone="neutral"
        onConfirm={handleApprove}
        onClose={() => setConfirmApprove(false)}
      >
        <p>Approving this paper locks its questions and seals its content. Total marks: {totalMarks}. The exam will be ready to schedule.</p>
      </ConfirmDialog>

      {/* Reject Dialog */}
      <Dialog
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        title="Reject Question Paper"
      >
        <div className="space-y-4">
          <p className="text-sm text-ink-2">
            The paper will be returned to DRAFT status for revision by the question setter.
          </p>
          <Field label="Reviewer Feedback / Revision Notes">
            {({ id, describedBy }) => (
              <TextArea
                id={id}
                aria-describedby={describedBy}
                rows={3}
                value={rejectFeedback}
                onChange={(e) => setRejectFeedback(e.target.value)}
                placeholder="Explain the required changes…"
              />
            )}
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setRejectOpen(false)}>
              Cancel
            </Button>
            <Button variant="secondary" onClick={handleReject}>
              Reject with Feedback
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

type Rubric = NonNullable<PaperQuestion['rubric']>;
const DIFFICULTY_HINT: Record<number, string> = { 1: 'recall', 3: 'explain', 5: 'apply', 7: 'analyse', 10: 'hardest' };

/**
 * The marking scheme of one question, step by step. Each step has its marks, a difficulty 1–10 and the key terms a
 * full answer mentions; the system proposes marks from them and the examiner decides. Harder steps need fewer of
 * their key terms for full credit (every term at 1, 80 % at 5, 55 % at 10). MCQ and numeric questions take an answer key.
 */
export function RubricEditor({ question, disabled, onChange }: { question: PaperQuestion; disabled: boolean; onChange: (patch: Partial<PaperQuestion>) => void }) {
  const rubric: Rubric = question.rubric ?? [];
  const setStep = (i: number, patch: Partial<Rubric[number]>) => onChange({ rubric: rubric.map((r, k) => (k === i ? { ...r, ...patch } : r)) });
  const sum = rubric.reduce((a, r) => a + (Number(r.max) || 0), 0);
  const ea = question.expectedAnswer as unknown;
  const keyText = question.kind === 'MCQ' ? (Array.isArray(ea) ? ea.join(', ') : typeof ea === 'string' ? ea : '') : question.kind === 'NUMERIC' ? (ea && typeof ea === 'object' && Array.isArray((ea as { values?: number[] }).values) ? (ea as { values: number[] }).values.join(', ') : typeof ea === 'number' ? String(ea) : '') : '';
  const tolerance = ea && typeof ea === 'object' && typeof (ea as { tolerance?: number }).tolerance === 'number' ? String((ea as { tolerance: number }).tolerance) : '';
  return (
    <section className="space-y-3 border-t border-rule pt-3" aria-label={`Marking scheme for ${question.questionId}`}>
      {question.kind === 'MCQ' || question.kind === 'NUMERIC' ? (
        <div className="flex flex-wrap gap-3">
          <Field label={question.kind === 'MCQ' ? 'Answer key (option)' : 'Expected values'} hint={question.kind === 'MCQ' ? 'e.g. B, or B, D when either is correct' : 'e.g. 9.33, 5.33'} className="w-56">
            {({ id, describedBy }) => (
              <RawListInput
                id={id}
                describedBy={describedBy}
                initial={keyText}
                separator=","
                disabled={disabled}
                onList={(parts) => {
                  if (question.kind === 'MCQ') onChange({ expectedAnswer: parts.length > 1 ? parts.map((x) => x.toUpperCase()) : (parts[0] ?? '').toUpperCase() || undefined });
                  else {
                    const values = parts.map(Number).filter((n) => Number.isFinite(n));
                    onChange({ expectedAnswer: values.length ? { values, ...(tolerance ? { tolerance: Number(tolerance) } : {}) } : undefined });
                  }
                }}
              />
            )}
          </Field>
          {question.kind === 'NUMERIC' ? (
            <Field label="Tolerance" hint="± per value; default 1 %" className="w-32">
              {({ id, describedBy }) => <TextInput id={id} aria-describedby={describedBy} type="number" step="0.01" min={0} value={tolerance} disabled={disabled} onChange={(e) => onChange({ expectedAnswer: { values: keyText.split(',').map((x) => x.trim()).filter(Boolean).map(Number).filter((n) => Number.isFinite(n)), ...(e.target.value ? { tolerance: Number(e.target.value) } : {}) } })} />}
            </Field>
          ) : null}
        </div>
      ) : null}
      <div className="flex items-baseline justify-between gap-3">
        <h4 className="text-sm font-semibold">Marking steps</h4>
        {rubric.length ? <span className={sum === Number(question.maxMarks) ? 'text-xs text-ink-2' : 'text-xs text-fix'} role="status">{sum === Number(question.maxMarks) ? `Steps add up to ${sum} marks` : `Steps add up to ${sum}; the question is worth ${question.maxMarks}`}</span> : null}
      </div>
      {rubric.map((r, i) => (
        <fieldset key={i} className="grid gap-2 sm:grid-cols-[6rem_5rem_1fr_9rem] items-start border border-rule rounded-sm p-3">
          <legend className="px-1 text-xs text-ink-2">Step {i + 1}</legend>
          <Field label="Code">{({ id }) => <TextInput id={id} value={r.code} disabled={disabled} onChange={(e) => setStep(i, { code: e.target.value })} className="font-mono" />}</Field>
          <Field label="Marks">{({ id }) => <TextInput id={id} type="number" min={0.5} step="0.5" value={r.max} disabled={disabled} onChange={(e) => setStep(i, { max: Number(e.target.value) })} />}</Field>
          <Field label="What this step rewards">{({ id }) => <TextInput id={id} value={r.description} disabled={disabled} onChange={(e) => setStep(i, { description: e.target.value })} />}</Field>
          <Field label="Difficulty (1–10)">
            {({ id }) => (
              <select id={id} value={r.difficulty ?? 5} disabled={disabled} onChange={(e) => setStep(i, { difficulty: Number(e.target.value) })} className="h-10 rounded-md border border-rule-2 bg-sheet px-2">
                {Array.from({ length: 10 }, (_, k) => k + 1).map((d) => (
                  <option key={d} value={d}>
                    {d}
                    {DIFFICULTY_HINT[d] ? ` · ${DIFFICULTY_HINT[d]}` : ''}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Key terms a full answer mentions" hint="One per line; use | for alternatives (hold and wait|hold-and-wait)" className="sm:col-span-4">
            {({ id, describedBy }) => <RawListInput id={id} describedBy={describedBy} rows={2} initial={(r.keywords ?? []).join('\n')} separator={'\n'} disabled={disabled} onList={(xs) => setStep(i, { keywords: xs })} />}
          </Field>
          {!disabled ? (
            <div className="sm:col-span-4">
              <Button size="sm" variant="ghost" onClick={() => onChange({ rubric: rubric.filter((_, k) => k !== i) })}>
                Remove step {i + 1}
              </Button>
            </div>
          ) : null}
        </fieldset>
      ))}
      {!disabled ? (
        <Button size="sm" onClick={() => onChange({ rubric: [...rubric, { code: `S${rubric.length + 1}`, max: 1, description: 'Step', difficulty: 5, keywords: [] }] })}>
          Add marking step
        </Button>
      ) : null}
      {rubric.length && rubric.some((r) => !r.keywords?.length) ? <p className="text-xs text-ink-2">Steps without key terms are marked by the examiner without a system proposal.</p> : null}
    </section>
  );
}

/** A list typed as text: the text stays exactly as typed (new lines, "9." mid-number); the parsed list goes up. */
function RawListInput({ id, describedBy, initial, separator, disabled, onList, rows }: { id: string; describedBy?: string; initial: string; separator: string; disabled: boolean; onList: (xs: string[]) => void; rows?: number }) {
  const [raw, setRaw] = useState(initial);
  const change = (v: string) => {
    setRaw(v);
    onList(v.split(separator).map((x) => x.trim()).filter(Boolean));
  };
  return rows ? <TextArea id={id} aria-describedby={describedBy} rows={rows} value={raw} disabled={disabled} onChange={(e) => change(e.target.value)} /> : <TextInput id={id} aria-describedby={describedBy} value={raw} disabled={disabled} onChange={(e) => change(e.target.value)} />;
}
