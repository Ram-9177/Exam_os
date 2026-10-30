import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { BookletView, type Booklet } from '@/features/booklet/BookletView';

const booklet: Booklet = {
  tenant: { name: 'St. Mary’s University', slug: 'demo' },
  exam: { code: 'CS301-MID1', title: 'Operating Systems — Mid 1', examType: 'MID_1', academicYear: '2026-27', semester: 5, durationMinutes: 60 },
  student: { name: 'Asha Rao', registerNumber: 'REG-001', hallTicket: 'CS301-MID1-0001' },
  status: 'PUBLISHED',
  sealedAt: '2026-10-29T21:40:00.000Z',
  manifestSha256: 'ab'.repeat(32),
  questions: [
    {
      questionId: 'Q1',
      prompt: 'Define a process and describe its structure in memory.',
      answer: { blocks: [{ id: 'b1', kind: 'paragraph', content: 'A process is a program in execution.\nIt has a PCB.' }] },
      answerSha256: 'cd'.repeat(32),
      revision: 4,
      marks: 7,
      maxMarks: 10,
      explanation: 'Definition correct; the states diagram is missing.',
      criteria: [
        { code: 'DEFINITION', max: 5, awarded: 5 },
        { code: 'STATES', max: 5, awarded: 2, evidence: 'Only two states named.' },
      ],
    },
    {
      questionId: 'Q2',
      answer: {
        blocks: [
          { id: 'b2', kind: 'paragraph', content: 'See the diagram.' },
          { id: 'b3', kind: 'canvas', content: { width: 100, height: 50, strokes: [{ tool: 'pen', width: 2, points: [[1, 1], [50, 25], [99, 49]] }, { tool: 'eraser', width: 10, points: [[50, 25], [60, 30]] }] } },
        ],
      },
      answerSha256: 'ef'.repeat(32),
      revision: 2,
      marks: 3,
      maxMarks: 5,
      explanation: 'Diagram shows the idea; labels are incomplete.',
      criteria: null,
    },
  ],
  total: { marks: 10, max: 15, version: 1 },
  validation: { examiner: 'Dr. Meena Iyer', examinerApprovedAt: '2026-10-30T05:00:00.000Z', controller: 'Prof. R. Nair', publishedAt: '2026-10-30T09:00:00.000Z' },
  verificationHash: '12'.repeat(32),
  verificationUrl: '/verify/attempt-1/1',
};

describe('Booklet print layout', () => {
  it('renders header, one page per question, answers with diagrams as SVG, marks, explanations, totals, validation and verification', () => {
    const { container } = render(<BookletView booklet={booklet} tz="Asia/Kolkata" />);
    const article = screen.getByRole('article', { name: 'Digital answer booklet' });
    expect(article).toHaveClass('booklet');
    expect(within(article).getByText('St. Mary’s University')).toBeInTheDocument();
    expect(within(article).getByText('Asha Rao')).toBeInTheDocument();
    expect(within(article).getByText('REG-001')).toBeInTheDocument();
    expect(within(article).getByText('CS301-MID1-0001')).toBeInTheDocument();

    // Print structure: cover page, a page-breaking section per question, a closing page.
    expect(container.querySelectorAll('.booklet-cover')).toHaveLength(1);
    expect(container.querySelectorAll('.booklet-end')).toHaveLength(1);
    const questions = container.querySelectorAll('.booklet-question');
    expect(questions).toHaveLength(2);
    expect(within(questions[0] as HTMLElement).getByRole('heading', { name: 'Question 1' })).toBeInTheDocument();
    expect(within(questions[1] as HTMLElement).getByRole('heading', { name: 'Question 2' })).toBeInTheDocument();

    // The answer is on ruled paper; the diagram is a vector re-render with an eraser mask.
    expect(within(questions[0] as HTMLElement).getByText('Define a process and describe its structure in memory.')).toBeInTheDocument();
    expect(container.querySelectorAll('.ruled').length).toBeGreaterThanOrEqual(2);
    const svg = within(questions[1] as HTMLElement).getByRole('img', { name: /Diagram 2, 1 stroke\b/ });
    expect(svg.tagName.toLowerCase()).toBe('svg');
    expect(svg.querySelector('mask')).not.toBeNull();
    expect(svg.querySelectorAll('path')).toHaveLength(2);

    // Marks, explanation box, criteria.
    expect(within(questions[0] as HTMLElement).getByText('7')).toBeInTheDocument();
    expect(within(questions[0] as HTMLElement).getByText('/ 10')).toBeInTheDocument();
    expect(within(questions[0] as HTMLElement).getByText('Marks explanation')).toBeInTheDocument();
    expect(within(questions[0] as HTMLElement).getByText('Definition correct; the states diagram is missing.')).toBeInTheDocument();
    expect(within(questions[0] as HTMLElement).getByText('Only two states named.')).toBeInTheDocument();

    // Totals and validation.
    expect(within(article).getByText('10')).toBeInTheDocument();
    expect(within(article).getByText('/ 15')).toBeInTheDocument();
    expect(within(article).getByText(/Dr\. Meena Iyer/)).toBeInTheDocument();
    expect(within(article).getByText('Prof. R. Nair')).toBeInTheDocument();
    expect(within(article).getByText('Authorised by (Controller)')).toBeInTheDocument();
    expect(within(article).getByText('12'.repeat(32))).toBeInTheDocument();
    expect(within(article).getByText(/\/verify\/attempt-1\/1/)).toBeInTheDocument();
  });

  it('lets the marking screen replace the marks block with its own controls', () => {
    render(<BookletView booklet={booklet} tz="Asia/Kolkata" marks={(q) => <div data-testid={`marks-${q.questionId}`}>inputs</div>} />);
    expect(screen.getByTestId('marks-Q1')).toBeInTheDocument();
    expect(screen.getByTestId('marks-Q2')).toBeInTheDocument();
    expect(screen.queryByText('Marks explanation')).not.toBeInTheDocument();
  });
});
