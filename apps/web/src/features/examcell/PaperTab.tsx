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

                {/* Rubric Criteria if any */}
                {q.rubric && q.rubric.length > 0 ? (
                  <div className="text-xs text-ink-2 space-y-1">
                    <span className="font-semibold text-ink">Evaluation Rubric:</span>
                    <ul className="list-disc pl-4 space-y-0.5">
                      {q.rubric.map((rc, rci) => (
                        <li key={rci}>
                          <span className="font-mono font-bold">{rc.code}</span> ({rc.max} marks): {rc.description}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
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
