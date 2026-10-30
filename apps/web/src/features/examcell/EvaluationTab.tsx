import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Button, Dialog, Field, Select, Skeleton, Table, TextArea, TextInput, useToast } from '@/ui';

interface EvaluatorSummary {
  evaluatorId: string;
  evaluatorName: string;
  evaluatorEmail: string;
  totalAssigned: number;
  inProgress: number;
  completed: number;
}

interface ModerationSample {
  id: string;
  attemptId: string;
  reason: string;
  divergence: number | null;
  evaluator1Marks: number | null;
  evaluator2Marks: number | null;
  evaluator1Name: string | null;
  evaluator2Name: string | null;
  moderatorName: string | null;
  status: 'PENDING' | 'RESOLVED';
  resolutionNote: string | null;
}

interface RevaluationRequest {
  id: string;
  attemptId: string;
  studentName: string;
  studentEmail: string;
  reason: string;
  feeRef: string | null;
  status: 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'DONE';
  decisionNote: string | null;
  currentMarks: number | null;
  maxMarks: number | null;
}

export function EvaluationTab({ examId }: { examId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const assignmentsQuery = useQuery({
    queryKey: ['exam-assignments', examId],
    queryFn: () => api.get<{ summaries: EvaluatorSummary[]; assignments: any[] }>(`/exams/${examId}/evaluators/assignments`),
  });

  const moderationQuery = useQuery({
    queryKey: ['exam-moderation', examId],
    queryFn: () => api.get<ModerationSample[]>(`/exams/${examId}/moderation/samples`),
  });

  const revaluationQuery = useQuery({
    queryKey: ['exam-revaluation', examId],
    queryFn: () => api.get<RevaluationRequest[]>(`/exams/${examId}/revaluation-requests`),
  });

  // Assign modal state
  const [assignOpen, setAssignOpen] = useState(false);
  const [evaluatorUserId, setEvaluatorUserId] = useState('');
  const [roleType, setRoleType] = useState<'EVALUATOR_1' | 'EVALUATOR_2' | 'MODERATOR'>('EVALUATOR_1');
  const [count, setCount] = useState('10');
  const [assigning, setAssigning] = useState(false);

  // Revaluation decision state
  const [selectedReval, setSelectedReval] = useState<RevaluationRequest | null>(null);
  const [decision, setDecision] = useState<'APPROVED' | 'REJECTED'>('APPROVED');
  const [decisionNote, setDecisionNote] = useState('');
  const [deciding, setDeciding] = useState(false);

  const handleAssign = async () => {
    if (!evaluatorUserId.trim()) return;
    setAssigning(true);
    try {
      const res = await api.post<{ assignedCount: number }>(`/exams/${examId}/evaluators/assign`, {
        evaluatorUserId: evaluatorUserId.trim(),
        roleType,
        count: Number(count) || 1,
      });
      toast({
        tone: 'success',
        title: 'Evaluator Assigned',
        description: `Assigned ${res.assignedCount} attempts as ${roleType}.`,
      });
      setAssignOpen(false);
      setEvaluatorUserId('');
      void qc.invalidateQueries({ queryKey: ['exam-assignments', examId] });
    } catch (err: any) {
      toast({
        tone: 'error',
        title: 'Assignment Failed',
        description: err?.problem?.detail || err?.message || 'Could not assign evaluator',
      });
    } finally {
      setAssigning(false);
    }
  };

  const handleDecideReval = async () => {
    if (!selectedReval) return;
    setDeciding(true);
    try {
      await api.post(`/revaluation-requests/${selectedReval.id}/decide`, {
        decision,
        note: decisionNote.trim() || undefined,
      });
      toast({
        tone: 'success',
        title: `Revaluation ${decision}`,
        description: `Candidate attempt has been updated.`,
      });
      setSelectedReval(null);
      setDecisionNote('');
      void qc.invalidateQueries({ queryKey: ['exam-revaluation', examId] });
      void qc.invalidateQueries({ queryKey: ['candidates', examId] });
    } catch (err: any) {
      toast({
        tone: 'error',
        title: 'Decision Failed',
        description: err?.problem?.detail || err?.message || 'Could not decide request',
      });
    } finally {
      setDeciding(false);
    }
  };

  return (
    <div className="space-y-10 max-w-5xl">
      {/* 1. Evaluator Workload & Balancing */}
      <section aria-labelledby="evaluators-heading" className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 id="evaluators-heading" className="text-h3">
              Evaluator Workload Balancing
            </h2>
            <p className="text-sm text-ink-2">
              Distribute unassigned sealed papers equally among external and internal examiners.
            </p>
          </div>
          <Button variant="primary" size="sm" onClick={() => setAssignOpen(true)}>
            Assign Evaluators
          </Button>
        </div>

        {assignmentsQuery.isLoading ? <Skeleton lines={3} /> : null}
        {assignmentsQuery.data ? (
          <Table
            caption="Evaluator workload breakdown"
            columns={[
              {
                key: 'name',
                header: 'Evaluator',
                render: (s) => (
                  <div>
                    <p className="font-medium">{s.evaluatorName}</p>
                    <p className="text-xs text-ink-2 font-mono">{s.evaluatorEmail}</p>
                  </div>
                ),
              },
              { key: 'assigned', header: 'Total Assigned', align: 'right', render: (s) => s.totalAssigned },
              { key: 'progress', header: 'In Progress', align: 'right', render: (s) => s.inProgress },
              { key: 'completed', header: 'Completed', align: 'right', render: (s) => s.completed },
            ]}
            rows={assignmentsQuery.data.summaries}
            rowKey={(s) => s.evaluatorId}
            empty="No evaluators assigned yet. Use 'Assign Evaluators' to allocate papers."
          />
        ) : null}
      </section>

      {/* 2. Moderation Samples (Double Evaluation Divergence) */}
      <section aria-labelledby="moderation-heading" className="space-y-4">
        <div>
          <h2 id="moderation-heading" className="text-h3">
            Moderation & Divergence Queue
          </h2>
          <p className="text-sm text-ink-2">
            Double evaluation divergence exceeding the threshold (15%) is escalated here for independent moderator resolution.
          </p>
        </div>

        {moderationQuery.isLoading ? <Skeleton lines={3} /> : null}
        {moderationQuery.data ? (
          <Table
            caption="Moderation review queue"
            columns={[
              {
                key: 'attempt',
                header: 'Attempt ID',
                render: (m) => <span className="font-mono text-xs">{m.attemptId.slice(0, 8)}...</span>,
              },
              { key: 'reason', header: 'Reason', render: (m) => m.reason },
              {
                key: 'marks',
                header: 'Marks (Eval 1 vs Eval 2)',
                render: (m) => (
                  <span className="font-mono text-xs">
                    {m.evaluator1Marks ?? '—'} vs {m.evaluator2Marks ?? '—'} (Δ {m.divergence ?? '0'})
                  </span>
                ),
              },
              {
                key: 'status',
                header: 'Status',
                render: (m) => (
                  <span
                    className={`px-2 py-0.5 rounded text-xs font-medium ${
                      m.status === 'RESOLVED'
                        ? 'bg-emerald-50 text-emerald-800'
                        : 'bg-amber-50 text-amber-800'
                    }`}
                  >
                    {m.status}
                  </span>
                ),
              },
              {
                key: 'resolution',
                header: 'Resolution',
                render: (m) => m.resolutionNote || 'Pending moderator',
              },
            ]}
            rows={moderationQuery.data}
            rowKey={(m) => m.id}
            empty="No divergent evaluations flagged for moderation."
          />
        ) : null}
      </section>

      {/* 3. Revaluation Requests */}
      <section aria-labelledby="revaluation-heading" className="space-y-4">
        <div>
          <h2 id="revaluation-heading" className="text-h3">
            Revaluation & Student Appeals
          </h2>
          <p className="text-sm text-ink-2">
            Student requests submitted within the 7-day appeal window. Approved requests return candidate packets to academic marking.
          </p>
        </div>

        {revaluationQuery.isLoading ? <Skeleton lines={3} /> : null}
        {revaluationQuery.data ? (
          <Table
            caption="Student revaluation requests"
            columns={[
              {
                key: 'student',
                header: 'Student',
                render: (r) => (
                  <div>
                    <p className="font-medium">{r.studentName}</p>
                    <p className="text-xs text-ink-2 font-mono">{r.studentEmail}</p>
                  </div>
                ),
              },
              {
                key: 'marks',
                header: 'Published Marks',
                render: (r) => (
                  <span className="font-mono text-xs">
                    {r.currentMarks ?? '—'} / {r.maxMarks ?? '—'}
                  </span>
                ),
              },
              { key: 'reason', header: 'Appeal Justification', render: (r) => r.reason },
              { key: 'fee', header: 'Fee Ref', render: (r) => r.feeRef || '—' },
              {
                key: 'status',
                header: 'Status',
                render: (r) => (
                  <span
                    className={`px-2 py-0.5 rounded text-xs font-medium ${
                      r.status === 'DONE'
                        ? 'bg-emerald-50 text-emerald-800'
                        : r.status === 'APPROVED'
                        ? 'bg-blue-50 text-blue-800'
                        : r.status === 'REJECTED'
                        ? 'bg-red-50 text-red-800'
                        : 'bg-amber-50 text-amber-800'
                    }`}
                  >
                    {r.status}
                  </span>
                ),
              },
              {
                key: 'action',
                header: 'Action',
                align: 'right',
                render: (r) =>
                  r.status === 'REQUESTED' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setSelectedReval(r);
                        setDecision('APPROVED');
                        setDecisionNote('');
                      }}
                    >
                      Decide
                    </Button>
                  ) : null,
              },
            ]}
            rows={revaluationQuery.data}
            rowKey={(r) => r.id}
            empty="No revaluation requests submitted."
          />
        ) : null}
      </section>

      {/* Assign Modal */}
      {assignOpen ? (
        <Dialog open onClose={() => setAssignOpen(false)} title="Assign Evaluator to Candidates">
          <div className="space-y-4">
            <Field label="Evaluator User ID" hint="UUID of the examiner registered in the system">
              {({ id, describedBy }) => (
                <TextInput
                  id={id}
                  value={evaluatorUserId}
                  onChange={(e) => setEvaluatorUserId(e.target.value)}
                  placeholder="00000000-0000-0000-0000-000000000000"
                  aria-describedby={describedBy}
                  className="font-mono"
                />
              )}
            </Field>

            <Field label="Evaluation Role" hint="Primary evaluator, secondary independent evaluator, or moderator">
              {({ id, describedBy }) => (
                <Select
                  id={id}
                  value={roleType}
                  onChange={(e) => setRoleType(e.target.value as any)}
                  aria-describedby={describedBy}
                >
                  <option value="EVALUATOR_1">EVALUATOR_1 (Primary Examiner)</option>
                  <option value="EVALUATOR_2">EVALUATOR_2 (Independent Double Evaluator)</option>
                  <option value="MODERATOR">MODERATOR (Senior Reviewer)</option>
                </Select>
              )}
            </Field>

            <Field label="Workload Batch Count" hint="Number of unassigned attempts to allocate">
              {({ id, describedBy }) => (
                <TextInput
                  id={id}
                  type="number"
                  min="1"
                  max="500"
                  value={count}
                  onChange={(e) => setCount(e.target.value)}
                  aria-describedby={describedBy}
                />
              )}
            </Field>

            <div className="flex justify-end gap-3 pt-3">
              <Button variant="ghost" onClick={() => setAssignOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={handleAssign}
                disabled={assigning || !evaluatorUserId.trim()}
              >
                {assigning ? 'Allocating...' : 'Allocate Workload'}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}

      {/* Revaluation Decision Modal */}
      {selectedReval ? (
        <Dialog open onClose={() => setSelectedReval(null)} title={`Decide Revaluation: ${selectedReval.studentName}`}>
          <div className="space-y-4">
            <div className="sheet p-3 text-sm bg-surface">
              <p className="font-medium text-ink-1">Student Appeal Justification:</p>
              <p className="text-ink-2 mt-1">{selectedReval.reason}</p>
              {selectedReval.feeRef ? (
                <p className="text-xs text-ink-2 mt-2 font-mono">Fee Ref: {selectedReval.feeRef}</p>
              ) : null}
            </div>

            <Field label="Decision">
              {({ id, describedBy }) => (
                <Select
                  id={id}
                  value={decision}
                  onChange={(e) => setDecision(e.target.value as any)}
                  aria-describedby={describedBy}
                >
                  <option value="APPROVED">Approve (Reopen for Academic Re-marking)</option>
                  <option value="REJECTED">Reject (Maintain Published Marks)</option>
                </Select>
              )}
            </Field>

            <Field label="Decision Explanation Note" hint="Sent to the candidate via email notice">
              {({ id, describedBy }) => (
                <TextArea
                  id={id}
                  rows={3}
                  value={decisionNote}
                  onChange={(e) => setDecisionNote(e.target.value)}
                  placeholder="Official comments regarding revaluation admissibility..."
                  aria-describedby={describedBy}
                />
              )}
            </Field>

            <div className="flex justify-end gap-3 pt-3">
              <Button variant="ghost" onClick={() => setSelectedReval(null)}>
                Cancel
              </Button>
              <Button
                variant={decision === 'APPROVED' ? 'primary' : 'danger'}
                onClick={handleDecideReval}
                disabled={deciding}
              >
                {deciding ? 'Recording...' : `Confirm ${decision}`}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
