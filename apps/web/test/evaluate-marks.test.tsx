import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EvaluatePage } from '@/features/evaluate/EvaluatePage';
import type { Booklet } from '@/features/booklet/BookletView';
import { mockFetch, renderApp, signInAs, TENANT } from './helpers';

const ATTEMPT = 'f4f68855-b14d-4309-af9e-fc818c0d3778';
const prompt = (text: string) => ({ blocks: [{ id: 'p', kind: 'paragraph', content: text }] });

/** A sealed script for a four-question paper: two answered, two not. The API lists all four. */
const booklet: Booklet = {
  tenant: { name: 'St. Mary’s University', slug: 'demo' },
  exam: { code: 'CS301-MID1', title: 'Operating Systems — Mid 1', examType: 'MID_1', academicYear: '2026-27', semester: 5, durationMinutes: 60 },
  student: { name: 'Student 01', registerNumber: '22CSE001', hallTicket: 'CS301-MID1-0001' },
  status: 'ACADEMIC_MARKING_READY',
  sealedAt: '2026-10-30T23:00:00.000Z',
  manifestSha256: 'ab'.repeat(32),
  questions: [
    { questionId: 'Q2', prompt: prompt('Describe the four Coffman conditions.'), answer: { blocks: [{ id: 'b1', kind: 'paragraph', content: 'Mutual exclusion, hold and wait, no preemption, circular wait.' }] }, answerSha256: 'cd'.repeat(32), revision: 1, marks: null, maxMarks: 5, explanation: null, criteria: null },
    { questionId: 'Q1', prompt: prompt('Explain the difference between a process and a thread.'), answer: { blocks: [{ id: 'b2', kind: 'paragraph', content: 'A process owns an address space; threads share it.' }] }, answerSha256: 'ef'.repeat(32), revision: 2, marks: null, maxMarks: 5, explanation: null, criteria: null },
    { questionId: 'Q3', prompt: prompt('Compute the average turnaround time.'), answer: { blocks: [] }, answerSha256: null, revision: 0, marks: null, maxMarks: 5, explanation: null, criteria: null },
    { questionId: 'Q4', prompt: prompt('Explain virtual memory paging.'), answer: { blocks: [] }, answerSha256: null, revision: 0, marks: null, maxMarks: 5, explanation: null, criteria: null },
  ],
  total: null,
  validation: { examiner: null, examinerApprovedAt: null, controller: null, publishedAt: null },
  verificationHash: '12'.repeat(32),
  verificationUrl: `/verify/${ATTEMPT}/0`,
} as unknown as Booklet;

describe('Evaluator marking sheet', () => {
  it('lists exactly the questions of the approved paper (no placeholders) and records marks for each of them', async () => {
    const me = signInAs(['EVALUATOR'], { id: 'u-ev', email: 'evaluator@demo.local', fullName: 'Examiner', kind: 'STAFF' });
    const posted: Array<{ items: Array<{ questionId: string; marks: number; maxMarks: number; explanation: string }> }> = [];
    mockFetch(({ method, path, body }) => {
      if (method === 'GET' && path === '/auth/me') return { json: me };
      if (method === 'GET' && path === '/tenant') return { json: TENANT };
      if (method === 'GET' && path === `/student/attempts/${ATTEMPT}/booklet`) return { json: booklet };
      if (method === 'POST' && path === `/candidates/${ATTEMPT}/result-versions`) {
        posted.push(body as (typeof posted)[number]);
        return { status: 201, json: { resultVersionId: 'rv-1', version: 1, total: 8.5, max: 20, invalidatedApprovals: 0 } };
      }
      return undefined;
    });
    renderApp([{ path: '/evaluate/:attemptId', element: <EvaluatePage /> }], `/evaluate/${ATTEMPT}`);
    const user = userEvent.setup();

    const submit = await screen.findByRole('button', { name: 'Record marks as version 1' });
    const sheets = document.querySelectorAll('fieldset');
    expect(sheets).toHaveLength(4);
    expect([...sheets].map((f) => f.querySelector('legend')?.textContent)).toEqual(['Marks for question 1', 'Marks for question 2', 'Marks for question 3', 'Marks for question 4']);
    expect(screen.queryByText(/question 5/i)).not.toBeInTheDocument();
    expect(screen.getByText('Explain the difference between a process and a thread.')).toBeInTheDocument();

    const values: Array<[string, string]> = [
      ['4', 'Correct distinction; context-switch cost not quantified.'],
      ['4.5', 'All four conditions; resource ordering breaks circular wait.'],
      ['0', 'No answer was written.'],
      ['0', 'No answer was written.'],
    ];
    for (const [i, sheet] of [...sheets].entries()) {
      const s = within(sheet as HTMLElement);
      await user.type(s.getByLabelText('Marks', { exact: true }), values[i]![0]);
      await user.type(s.getByLabelText(/Marks explanation/), values[i]![1]);
    }
    await user.click(submit);
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.items.map((it) => it.questionId)).toEqual(['Q1', 'Q2', 'Q3', 'Q4']);
    expect(posted[0]!.items.map((it) => it.marks)).toEqual([4, 4.5, 0, 0]);
    expect(posted[0]!.items.every((it) => it.maxMarks === 5)).toBe(true);
  });

  it('proposes marks automatically; changing a proposal needs a reason, which is sent with the marks', async () => {
    const me = signInAs(['EVALUATOR'], { id: 'u-ev', email: 'evaluator@demo.local', fullName: 'Examiner', kind: 'STAFF' });
    const posted: Array<{ items: Array<Record<string, unknown>> }> = [];
    const proposals = [
      { questionId: 'Q1', maxMarks: 5, proposedMarks: 4.5, method: 'RUBRIC_TERMS', basis: 'Key terms of the rubric found in the answer, per criterion.', criteria: [{ code: 'DEF', max: 2.5, awarded: 2.5, evidence: 'Process vs thread: 4/4 key terms' }, { code: 'PCB', max: 2.5, awarded: 2, evidence: 'PCB: 4/5 key terms (missing: open files)' }] },
      { questionId: 'Q2', maxMarks: 5, proposedMarks: 3, method: 'RUBRIC_TERMS', basis: 'Key terms of the rubric found in the answer, per criterion.', criteria: [{ code: 'COND', max: 3, awarded: 3, evidence: '4/4' }, { code: 'PREV', max: 2, awarded: 0, evidence: '0/2' }] },
      { questionId: 'Q3', maxMarks: 5, proposedMarks: 0, method: 'NO_ANSWER', basis: 'No answer was written.' },
      { questionId: 'Q4', maxMarks: 5, proposedMarks: null, method: 'EXAMINER', basis: 'Drawings are marked by the examiner.' },
    ];
    mockFetch(({ method, path, body }) => {
      if (method === 'GET' && path === '/auth/me') return { json: me };
      if (method === 'GET' && path === '/tenant') return { json: TENANT };
      if (method === 'GET' && path === `/student/attempts/${ATTEMPT}/booklet`) return { json: booklet };
      if (method === 'GET' && path === `/candidates/${ATTEMPT}/rubric-proposals`) return { json: { attemptId: ATTEMPT, proposals, proposedTotal: 7.5, needsExaminer: ['Q4'] } };
      if (method === 'POST' && path === `/candidates/${ATTEMPT}/result-versions`) {
        posted.push(body as (typeof posted)[number]);
        return { status: 201, json: { resultVersionId: 'rv-1', version: 1, total: 9, max: 20, invalidatedApprovals: 0 } };
      }
      return undefined;
    });
    renderApp([{ path: '/evaluate/:attemptId', element: <EvaluatePage /> }], `/evaluate/${ATTEMPT}`);
    const user = userEvent.setup();
    expect(await screen.findByText(/Proposed total 7.5 · 1 question needs your judgement/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Suggest Rubric Marks/ })).not.toBeInTheDocument();
    const sheets = [...document.querySelectorAll('fieldset')] as HTMLElement[];
    const [s1, s2, , s4] = sheets.map((f) => within(f));
    await waitFor(() => expect(s1!.getByLabelText('Marks', { exact: true })).toHaveValue(4.5));
    expect(s1!.getByText('Proposed: 4.5 / 5')).toBeInTheDocument();
    expect(within(s1!.getByLabelText('Proposal for question 1')).getByText(/PCB: 4\/5 key terms \(missing: open files\)/)).toBeInTheDocument();
    expect(s4!.getByText('No proposal')).toBeInTheDocument();
    expect(s4!.getByLabelText('Marks', { exact: true })).toHaveValue(null);

    // the examiner disagrees with Q2: a reason becomes mandatory
    expect(s2!.queryByLabelText(/Reason for changing the proposed mark/)).not.toBeInTheDocument();
    await user.clear(s2!.getByLabelText('Marks', { exact: true }));
    await user.type(s2!.getByLabelText('Marks', { exact: true }), '4');
    const reason = s2!.getByLabelText(/Reason for changing the proposed mark/);
    // criteria rows came from the proposal; adjust them to the new total so the sheet stays consistent
    const awarded = s2!.getAllByPlaceholderText('Awarded');
    await user.clear(awarded[1]!);
    await user.type(awarded[1]!, '1');
    await user.type(s4!.getByLabelText('Marks', { exact: true }), '1.5');
    await user.type(s4!.getByLabelText('Out of'), '5');
    await user.type(s4!.getByLabelText(/Marks explanation/), 'Diagram shows paging but no TLB.');

    await user.click(screen.getByRole('button', { name: 'Record marks as version 1' }));
    expect(await s2!.findByText(/You changed the proposed mark: say why/)).toBeInTheDocument();
    expect(posted).toHaveLength(0);
    await user.type(reason, 'Explains release-and-retry, which the key terms miss.');
    await user.click(screen.getByRole('button', { name: 'Record marks as version 1' }));
    await waitFor(() => expect(posted).toHaveLength(1));
    const items = posted[0]!.items;
    expect(items.map((it) => it['marks'])).toEqual([4.5, 4, 0, 1.5]);
    expect(items[1]).toMatchObject({ questionId: 'Q2', overrideReason: 'Explains release-and-retry, which the key terms miss.' });
    expect(items.filter((it) => 'overrideReason' in it)).toHaveLength(1);
  });
});
