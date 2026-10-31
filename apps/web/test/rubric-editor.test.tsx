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

  it('MCQ options with the correct one; several correct for MCQ_MULTI; numeric values, unit and answer marks; maths expression', async () => {
    const user = userEvent.setup();
    let last: PaperQuestion | null = null;
    const a = render(<Harness initial={base({ kind: 'MCQ' })} onState={(q) => (last = q)} />);
    await user.click(screen.getByRole('button', { name: 'Add option' }));
    await user.click(screen.getByRole('button', { name: 'Add option' }));
    await user.type(screen.getByLabelText('Option A text'), 'Aspirin');
    await user.type(screen.getByLabelText('Option B text'), 'Heparin');
    await user.click(screen.getByLabelText('Option B is correct'));
    expect(last!).toMatchObject({ options: [{ key: 'A', text: 'Aspirin' }, { key: 'B', text: 'Heparin' }], expectedAnswer: 'B' });
    a.unmount();

    const b = render(<Harness initial={base({ kind: 'MCQ_MULTI', options: [{ key: 'A', text: 'x' }, { key: 'B', text: 'y' }, { key: 'C', text: 'z' }] })} onState={(q) => (last = q)} />);
    await user.click(screen.getByLabelText('Option C is correct'));
    await user.click(screen.getByLabelText('Option A is correct'));
    expect(last!.expectedAnswer).toEqual(['A', 'C']);
    b.unmount();

    const c = render(<Harness initial={base({ kind: 'NUMERIC' })} onState={(q) => (last = q)} />);
    await user.type(screen.getByLabelText('Expected values'), '9.33, 5.33');
    await user.type(screen.getByLabelText('Tolerance'), '0.05');
    await user.type(screen.getByLabelText('Unit'), 'ms');
    await user.type(screen.getByLabelText('Answer marks'), '2');
    expect(last!.expectedAnswer).toEqual({ values: [9.33, 5.33], tolerance: 0.05, unit: 'ms', answerMarks: 2 });
    c.unmount();

    render(<Harness initial={base({ kind: 'MATH' })} onState={(q) => (last = q)} />);
    await user.type(screen.getByLabelText('Answer (expression)'), 'x^2+2x+1');
    expect(last!.expectedAnswer).toEqual({ expression: 'x^2+2x+1' });
  });

  it('a coding question: languages, limits, sample tests students see, hidden tests with weights; a must-not-miss step', async () => {
    const user = userEvent.setup();
    let last: PaperQuestion | null = null;
    render(<Harness initial={base({ kind: 'CODE' })} onState={(q) => (last = q)} />);
    await user.click(screen.getByLabelText('C++'));
    await user.click(screen.getByRole('button', { name: 'Add sample' }));
    await user.type(screen.getByLabelText('Sample 1 input'), '3');
    await user.type(screen.getByLabelText('Sample 1 expected output'), '6');
    await user.click(screen.getByRole('button', { name: 'Add hidden test' }));
    await user.type(screen.getByLabelText('Hidden test 1 input'), '1000');
    await user.type(screen.getByLabelText('Hidden test 1 expected output'), '2000');
    await user.clear(screen.getByLabelText('Hidden test 1 weight'));
    await user.type(screen.getByLabelText('Hidden test 1 weight'), '3');
    expect(last!.codeSpec).toMatchObject({ languages: ['python', 'cpp'], samples: [{ input: '3', expected: '6' }] });
    expect(last!.expectedAnswer).toEqual({ tests: [{ input: '1000', expected: '2000', weight: 3 }] });
    await user.click(screen.getByRole('button', { name: 'Add marking step' }));
    await user.click(screen.getByLabelText(/Must not miss/));
    expect(last!.rubric![0]!.critical).toBe(true);
  });
});
