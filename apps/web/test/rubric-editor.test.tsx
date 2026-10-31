import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RubricEditor } from '@/features/examcell/PaperTab';
import type { PaperQuestion } from '@/features/examcell/api';

function Harness({ initial, onState }: { initial: PaperQuestion; onState: (q: PaperQuestion) => void }) {
  const [q, setQ] = useState(initial);
  return (
    <RubricEditor
      question={q}
      disabled={false}
      onChange={(patch) => {
        const next = { ...q, ...patch };
        setQ(next);
        onState(next);
      }}
    />
  );
}
const base = (over: Partial<PaperQuestion>): PaperQuestion => ({ questionId: 'Q1', sectionCode: 'A', number: 1, kind: 'DESCRIPTIVE', prompt: { blocks: [] }, maxMarks: 5, rubric: [], attachments: [], ...over }) as PaperQuestion;

describe('marking steps editor', () => {
  it('each step takes marks, a difficulty 1–10 and key terms; the total is checked against the question', async () => {
    const user = userEvent.setup();
    let last: PaperQuestion | null = null;
    render(<Harness initial={base({})} onState={(q) => (last = q)} />);
    await user.click(screen.getByRole('button', { name: 'Add marking step' }));
    const step = screen.getByRole('group', { name: 'Step 1' });
    await user.clear(within(step).getByLabelText('Code'));
    await user.type(within(step).getByLabelText('Code'), 'COND');
    await user.clear(within(step).getByLabelText('Marks'));
    await user.type(within(step).getByLabelText('Marks'), '3');
    await user.selectOptions(within(step).getByLabelText('Difficulty (1–10)'), '8');
    await user.type(within(step).getByLabelText(/Key terms a full answer mentions/), 'mutual exclusion{Enter}hold and wait|hold-and-wait');
    expect(last!.rubric![0]).toMatchObject({ code: 'COND', max: 3, difficulty: 8, keywords: ['mutual exclusion', 'hold and wait|hold-and-wait'] });
    expect(screen.getByRole('status')).toHaveTextContent('Steps add up to 3; the question is worth 5');
  });

  it('an MCQ takes its answer key; a numeric question its expected values and tolerance', async () => {
    const user = userEvent.setup();
    let last: PaperQuestion | null = null;
    const { unmount } = render(<Harness initial={base({ kind: 'MCQ' })} onState={(q) => (last = q)} />);
    await user.type(screen.getByLabelText('Answer key (option)'), 'b');
    expect(last!.expectedAnswer).toBe('B');
    unmount();
    render(<Harness initial={base({ kind: 'NUMERIC' })} onState={(q) => (last = q)} />);
    await user.type(screen.getByLabelText('Expected values'), '9.33, 5.33');
    await user.type(screen.getByLabelText('Tolerance'), '0.05');
    expect(last!.expectedAnswer).toEqual({ values: [9.33, 5.33], tolerance: 0.05 });
  });
});
