import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EvaluateHomePage } from '@/features/evaluate/EvaluatePage';
import { EvaluationTab } from '@/features/examcell/EvaluationTab';
import { LedgerPage } from '@/features/student/LedgerPage';
import { mockFetch, renderApp, signInAs, TENANT } from './helpers';

const mockAssignments = [
  {
    assignmentId: 'asg-1',
    attemptId: 'att-1',
    examId: 'e-1',
    examTitle: 'Advanced Distributed Systems',
    examCode: 'CS601',
    examType: 'SEM_EXTERNAL',
    roleType: 'EVALUATOR_1',
    assignmentStatus: 'ASSIGNED',
    candidateStatus: 'ACADEMIC_MARKING_READY',
    isAnonymized: true,
    anonymizedIdentifier: 'ANON-E7D8A901',
    candidateName: null,
    candidateEmail: null,
    hallTicketNumber: null,
  },
  {
    assignmentId: 'asg-2',
    attemptId: 'att-2',
    examId: 'e-2',
    examTitle: 'Operating Systems',
    examCode: 'CS301',
    examType: 'MID_1',
    roleType: 'EVALUATOR_1',
    assignmentStatus: 'ASSIGNED',
    candidateStatus: 'ACADEMIC_MARKING_READY',
    isAnonymized: false,
    anonymizedIdentifier: null,
    candidateName: 'Rohan Sharma',
    candidateEmail: 'rohan@demo.local',
    hallTicketNumber: 'HT-301-042',
  },
];

const mockExamAssignments = {
  summaries: [
    {
      evaluatorId: 'u-eval-1',
      evaluatorName: 'Dr. Jane Smith',
      evaluatorEmail: 'jane.smith@demo.local',
      totalAssigned: 15,
      inProgress: 5,
      completed: 10,
    },
  ],
  assignments: [],
};

const mockModerationSamples = [
  {
    id: 'mod-1',
    attemptId: 'att-div-1',
    reason: 'DIVERGENCE_EXCEEDED',
    divergence: 25,
    evaluator1Marks: 85,
    evaluator2Marks: 60,
    evaluator1Name: 'Dr. Jane Smith',
    evaluator2Name: 'Prof. Alan Turing',
    moderatorName: null,
    status: 'PENDING',
    resolutionNote: null,
  },
];

const mockRevaluationRequests = [
  {
    id: 'rev-1',
    attemptId: 'att-rev-1',
    studentName: 'Priya Patel',
    studentEmail: 'priya.patel@demo.local',
    reason: 'Derivations in Q2 should receive partial credit.',
    feeRef: 'FEE-2026-001',
    status: 'REQUESTED',
    decisionNote: null,
    currentMarks: 55,
    maxMarks: 100,
  },
];

const mockLedgerData = {
  records: [
    {
      exam_type: 'MID_1',
      academic_year: '2026-27',
      semester: 6,
      marks: 68,
      max_marks: 100,
      grade: 'B',
      hall_ticket_number: 'HT-601-01',
      published_at: new Date().toISOString(),
      examCode: 'CS601',
      examTitle: 'Distributed Systems',
      courseCode: 'CS601',
      courseName: 'Distributed Systems',
      attempt_id: 'att-ledger-1',
    },
  ],
  semesters: [],
  overall: { exams: 1, semesters: 1, marks: 68, max_marks: 100, percentage: 68 },
};

describe('Evaluation at Scale, Moderation, and Revaluation UI', () => {
  it('renders evaluator assigned queue with anonymized candidate identifiers', async () => {
    signInAs(['EVALUATOR']);
    mockFetch((call) => {
      if (call.path === '/tenants/me') return { json: TENANT };
      if (call.path === '/auth/me') return { json: { userId: 'u-eval-1', email: 'eval@demo.local', kind: 'STAFF', grants: [{ role: 'EVALUATOR', scopeType: 'TENANT', scopeId: null }], tenant: TENANT } };
      if (call.path === '/evaluator/me/assignments') return { json: mockAssignments };
      if (call.path === '/exams') return { json: { exams: [] } };
      return undefined;
    });

    renderApp([{ path: '/evaluate', element: <EvaluateHomePage /> }], '/evaluate');

    // Asserts page title and queue table
    expect(await screen.findByRole('heading', { level: 1, name: /Marking & Evaluation/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: /Assigned Queue/i })).toBeInTheDocument();

    // Verifies anonymized external candidate identifier is shown
    expect(screen.getByText('ANON-E7D8A901')).toBeInTheDocument();

    // Verifies internal candidate name is shown
    expect(screen.getByText('Rohan Sharma')).toBeInTheDocument();

    // Check evaluate buttons
    const evalButtons = screen.getAllByRole('button', { name: /Evaluate/i });
    expect(evalButtons.length).toBe(2);
  });

  it('renders Exam Section Evaluation tab with workload balancing, moderation, and revaluation requests', async () => {
    signInAs(['EXAM_CELL_OPERATOR']);
    mockFetch((call) => {
      if (call.path === '/tenants/me') return { json: TENANT };
      if (call.path === '/auth/me') return { json: { userId: 'u-ec', email: 'examcell@demo.local', kind: 'STAFF', grants: [{ role: 'EXAM_CELL_OPERATOR', scopeType: 'TENANT', scopeId: null }], tenant: TENANT } };
      if (call.path === '/exams/e-1/evaluators/assignments') return { json: mockExamAssignments };
      if (call.path === '/exams/e-1/moderation/samples') return { json: mockModerationSamples };
      if (call.path === '/exams/e-1/revaluation-requests') return { json: mockRevaluationRequests };
      return undefined;
    });

    renderApp([{ path: '/examcell/exams/:id', element: <EvaluationTab examId="e-1" /> }], '/examcell/exams/e-1');

    // Section 1: Workload Balancing
    expect(await screen.findByRole('heading', { level: 2, name: /Evaluator Workload Balancing/i })).toBeInTheDocument();
    expect(await screen.findByText('Dr. Jane Smith')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Assign Evaluators/i })).toBeInTheDocument();

    // Section 2: Moderation & Divergence Queue
    expect(screen.getByRole('heading', { level: 2, name: /Moderation & Divergence Queue/i })).toBeInTheDocument();
    expect(await screen.findByText(/85 vs 60/)).toBeInTheDocument();
    expect(screen.getByText('DIVERGENCE_EXCEEDED')).toBeInTheDocument();

    // Section 3: Revaluation & Student Appeals
    expect(screen.getByRole('heading', { level: 2, name: /Revaluation & Student Appeals/i })).toBeInTheDocument();
    expect(await screen.findByText('Priya Patel')).toBeInTheDocument();
    expect(screen.getByText(/Derivations in Q2 should receive partial credit/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Decide/i })).toBeInTheDocument();
  });

  it('renders student ledger with Appeal / Revalue button and opens revaluation modal', async () => {
    signInAs(['STUDENT']);
    const user = userEvent.setup();
    mockFetch((call) => {
      if (call.path === '/tenants/me') return { json: TENANT };
      if (call.path === '/auth/me') return { json: { userId: 'u-std', email: 'student@demo.local', kind: 'STUDENT', grants: [{ role: 'STUDENT', scopeType: 'TENANT', scopeId: null }], tenant: TENANT } };
      if (call.path === '/student/me/ledger') return { json: mockLedgerData };
      return undefined;
    });

    renderApp([{ path: '/student/ledger', element: <LedgerPage /> }], '/student/ledger');

    expect(await screen.findByRole('heading', { level: 1, name: /Results/i })).toBeInTheDocument();
    expect(screen.getByText('Distributed Systems')).toBeInTheDocument();

    // Click Appeal / Revalue button
    const appealBtn = screen.getByRole('button', { name: /Appeal \/ Revalue/i });
    expect(appealBtn).toBeInTheDocument();
    await user.click(appealBtn);

    // Verify modal appears
    expect(await screen.findByText(/University regulations allow a 7-day window/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Submit Request/i })).toBeInTheDocument();
  });
});
