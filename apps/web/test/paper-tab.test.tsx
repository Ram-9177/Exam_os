import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PaperTab } from '@/features/examcell/PaperTab';
import type { ExamRow } from '@/features/examcell/api';
import { mockFetch, renderApp, signInAs, TENANT } from './helpers';

const EXAM: ExamRow = {
  id: 'e100',
  code: 'CS301-MID1',
  title: 'Operating Systems — Mid 1',
  exam_type: 'MID_1',
  academic_year: '2026-27',
  semester: 5,
  max_marks: 20,
  security_profile: 'BASIC_BROWSER',
  duration_minutes: 60,
  window_start_at: '2026-10-30T09:00:00.000Z',
  window_end_at: '2026-10-30T12:00:00.000Z',
  status: 'DRAFT',
  precheck_opened_at: null,
  started_at: null,
  closed_at: null,
  warning_threshold: 3,
  policy: {},
  policy_version: 'v1',
  created_at: '2026-10-30T08:00:00.000Z',
};

const PAPER_DRAFT = {
  paper: {
    id: 'p1',
    examId: 'e100',
    title: 'Operating Systems — Mid 1 Question Paper',
    status: 'DRAFT',
    version: 1,
    instructions: 'Answer all questions.',
    totalMarks: 20,
    sealedSha256: null,
    sections: [{ code: 'A', title: 'Section A' }],
    questions: [
      {
        questionId: 'Q1',
        sectionCode: 'A',
        number: 1,
        kind: 'DESCRIPTIVE',
        prompt: { blocks: [{ id: 'b1', kind: 'paragraph', content: 'Explain PCB structure.' }] },
        maxMarks: 10,
        rubric: [{ code: 'DEF', description: 'Definition', max: 5 }],
      },
      {
        questionId: 'Q2',
        sectionCode: 'A',
        number: 2,
        kind: 'DESCRIPTIVE',
        prompt: { blocks: [{ id: 'b2', kind: 'paragraph', content: 'Explain Round Robin.' }] },
        maxMarks: 10,
        rubric: [{ code: 'ALG', description: 'Algorithm', max: 5 }],
      },
    ],
  },
};

describe('PaperTab', () => {
  beforeEach(() => {
    vi.stubGlobal('scrollTo', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it('renders paper status, questions, marks matching, and allows draft saving', async () => {
    const me = signInAs(['EXAM_CELL_OPERATOR'], { id: 'u-setter', email: 'setter@demo.local', fullName: 'Question Setter', kind: 'STAFF' });
    let savedBody: unknown = null;

    mockFetch(({ method, path, body }) => {
      if (method === 'GET' && path === '/auth/me') return { json: me };
      if (method === 'GET' && path === '/tenant') return { json: TENANT };
      if (method === 'GET' && path === '/exams/e100/paper') return { json: PAPER_DRAFT };
      if (method === 'PUT' && path === '/exams/e100/paper') {
        savedBody = body;
        return { json: { status: 'DRAFT', paperId: 'p1', totalMarks: 20, questionCount: 2 } };
      }
      return undefined;
    });

    renderApp([{ path: '/exams/:id', element: <PaperTab exam={EXAM} /> }], '/exams/e100');

    await waitFor(() => {
      expect(screen.getByDisplayValue('Operating Systems — Mid 1 Question Paper')).toBeInTheDocument();
    });

    expect(screen.getByText('DRAFT')).toBeInTheDocument();
    expect(screen.getByText('Marks Match')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Explain PCB structure.')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Explain Round Robin.')).toBeInTheDocument();

    const saveBtn = screen.getByRole('button', { name: 'Save Draft' });
    expect(saveBtn).not.toBeDisabled();
    await userEvent.click(saveBtn);

    await waitFor(() => {
      expect(savedBody).not.toBeNull();
    });
  });

  it('renders reviewer approve dialog when paper review is pending', async () => {
    const me = signInAs(['PAPER_REVIEWER'], { id: 'u-rev', email: 'reviewer@demo.local', fullName: 'Paper Reviewer', kind: 'STAFF' });
    const reviewPaper = {
      paper: {
        ...PAPER_DRAFT.paper,
        status: 'REVIEW',
      },
    };
    let approved = false;

    mockFetch(({ method, path }) => {
      if (method === 'GET' && path === '/auth/me') return { json: me };
      if (method === 'GET' && path === '/tenant') return { json: TENANT };
      if (method === 'GET' && path === '/exams/e100/paper') return { json: reviewPaper };
      if (method === 'POST' && path === '/exams/e100/paper/approve') {
        approved = true;
        return { json: { status: 'APPROVED', sealedSha256: 'ab'.repeat(32) } };
      }
      return undefined;
    });

    renderApp([{ path: '/exams/:id', element: <PaperTab exam={{ ...EXAM, status: 'PAPER_REVIEW' }} /> }], '/exams/e100');

    await waitFor(() => {
      expect(screen.getByText('Paper Review Pending')).toBeInTheDocument();
    });

    const approveBtn = screen.getByRole('button', { name: 'Approve Paper' });
    await userEvent.click(approveBtn);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();

    const confirmApprove = within(dialog).getByRole('button', { name: 'Approve Paper' });
    await userEvent.click(confirmApprove);

    await waitFor(() => {
      expect(approved).toBe(true);
    });
  });
});
