import { describe, expect, it } from 'vitest';
import { answerText, proposeMark } from '../src/modules/evaluation/auto-marks.js';

const doc = (...paras: string[]) => ({ blocks: paras.map((p, i) => ({ id: `b${i}`, kind: 'paragraph', content: p })) });
const q = (over: Record<string, unknown>) => ({ question_id: 'Q1', kind: 'DESCRIPTIVE', max_marks: 5, options: null, rubric: null, expected_answer: null, ...over });
const mcq = (key: unknown) => q({ kind: 'MCQ', max_marks: 2, expected_answer: key, options: [{ key: 'A', text: 'Round robin' }, { key: 'B', text: 'Shortest job first' }, { key: 'C', text: 'First come first served' }, { key: 'D', text: 'Priority' }] });

describe('automatic mark proposals', () => {
  it('no answer is a proposal of 0; a drawing or a question without a key is left to the examiner', () => {
    expect(proposeMark(q({}), { blocks: [] })).toMatchObject({ proposedMarks: 0, method: 'NO_ANSWER' });
    expect(proposeMark(q({}), doc('   '))).toMatchObject({ proposedMarks: 0, method: 'NO_ANSWER' });
    expect(proposeMark(q({ kind: 'DRAWING' }), { blocks: [{ id: 'c', kind: 'canvas', content: { strokes: [{ tool: 'pen', points: [[1, 1], [2, 2]] }] } }] })).toMatchObject({ proposedMarks: null, method: 'EXAMINER' });
    expect(proposeMark(q({ rubric: [{ code: 'X', max: 5, description: 'Explanation' }] }), doc('Some answer'))).toMatchObject({ proposedMarks: null, method: 'EXAMINER' });
  });

  it('MCQ: reads only an explicit choice and compares it with the key', () => {
    expect(proposeMark(mcq('B'), doc('B'))).toMatchObject({ proposedMarks: 2, method: 'ANSWER_KEY', basis: 'Chose B, which is the answer key.' });
    expect(proposeMark(mcq('B'), doc('My answer is (B) because it minimises waiting time.'))).toMatchObject({ proposedMarks: 2 });
    expect(proposeMark(mcq('B'), doc('Option C'))).toMatchObject({ proposedMarks: 0, basis: 'Chose C; the answer key is B.' });
    expect(proposeMark(mcq('B'), doc('Shortest job first gives the lowest average waiting time.'))).toMatchObject({ proposedMarks: 2 });
    // "A process…" is a sentence, not option A; "(a)" numbering a point is not option A either
    expect(proposeMark(mcq('B'), doc('A process waits less. (a) less waiting (b) more throughput. Answer: B'))).toMatchObject({ proposedMarks: 2 });
    expect(proposeMark(mcq('B'), doc('B or D'))).toMatchObject({ proposedMarks: null, method: 'EXAMINER' });
    expect(proposeMark(mcq('B'), doc('(B)', '(D)'))).toMatchObject({ proposedMarks: 0, basis: expect.stringContaining('More than one option chosen') });
    expect(proposeMark(mcq(['B', 'D']), doc('D'))).toMatchObject({ proposedMarks: 2 });
  });

  it('NUMERIC: share of expected values found within tolerance, half-mark steps', () => {
    const n = q({ kind: 'NUMERIC', expected_answer: { values: [9.33, 5.33], tolerance: 0.05 } });
    expect(proposeMark(n, doc('Average turnaround = 28/3 = 9.33 ms; average waiting = 16/3 = 5.33 ms'))).toMatchObject({ proposedMarks: 5, method: 'NUMERIC_KEY' });
    expect(proposeMark(n, doc('turnaround 9.3, waiting 6'))).toMatchObject({ proposedMarks: 2.5 });
    expect(proposeMark(n, doc('turnaround 12, waiting 8'))).toMatchObject({ proposedMarks: 0 });
    expect(proposeMark(q({ kind: 'NUMERIC', expected_answer: 1500 }), doc('1,500 bytes'))).toMatchObject({ proposedMarks: 5 });
  });

  it('rubric key terms: phrases and alternatives per criterion, with what was found and missing', () => {
    const r = q({
      max_marks: 5,
      rubric: [
        { code: 'COND', max: 3, description: 'Four Coffman conditions', keywords: ['mutual exclusion', 'hold and wait', 'no preemption|non-preemption', 'circular wait'] },
        { code: 'PREV', max: 2, description: 'Prevention', keywords: ['request all|all resources at once', 'release'] },
      ],
    });
    const full = proposeMark(r, doc('Mutual exclusion, hold-and-wait, non-preemption and circular wait. Prevention: request all resources at once, or release what you hold.'));
    expect(full).toMatchObject({ proposedMarks: 5, method: 'RUBRIC_TERMS' });
    const part = proposeMark(r, doc('Mutual exclusion and circular wait are needed.'));
    // default difficulty 5: full credit at 80 % of the terms; 2/4 = 62.5 % of that → 1.875 → nearest half 2
    expect(part.proposedMarks).toBe(2);
    expect(part.review).toBe('CHECK_CAREFULLY');
    expect(part.criteria).toEqual([
      { code: 'COND', max: 3, awarded: 2, evidence: 'Four Coffman conditions · difficulty 5/10, full credit at 80 % of key terms: 2/4 found (mutual exclusion, circular wait); missing: hold and wait, no preemption' },
      { code: 'PREV', max: 2, awarded: 0, evidence: 'Prevention · difficulty 5/10, full credit at 80 % of key terms: 0/2 found; missing: request all, release' },
    ]);
    // length earns nothing: a long answer without the terms gets 0
    expect(proposeMark(r, doc('word '.repeat(400))).proposedMarks).toBe(0);
  });

  it('reads the text a student placed on a diagram too', () => {
    expect(answerText({ blocks: [{ id: 'c', kind: 'canvas', content: { strokes: [{ tool: 'text', text: 'circular wait' }] } }] })).toEqual({ text: 'circular wait', hasDrawing: true });
  });

  it('difficulty per rubric step (1–10) sets how much of the step must be covered for full credit', () => {
    const terms = ['page table', 'frame', 'TLB', 'page fault'];
    const step = (difficulty?: number) => q({ max_marks: 4, rubric: [{ code: 'S', max: 4, description: 'Paging', keywords: terms, ...(difficulty ? { difficulty } : {}) }] });
    const answer = doc('The page table maps each page to a frame; the TLB caches translations.'); // 3 of 4 terms
    expect(proposeMark(step(1), answer).proposedMarks).toBe(3); // basic step: every term needed → 3/4 × 4
    expect(proposeMark(step(), answer).proposedMarks).toBe(4); // difficulty 5: 75 % of 80 % → 3.75 → 4
    expect(proposeMark(step(10), answer).proposedMarks).toBe(4); // hardest: 55 % is full credit
    expect(proposeMark(step(10), answer).review).toBe('ROUTINE');
    expect(proposeMark(step(1), answer).criteria![0]!.evidence).toContain('difficulty 1/10, full credit at 100 % of key terms: 3/4 found');
    const one = doc('Only the page table.');
    expect(proposeMark(step(1), one).proposedMarks).toBe(1);
    expect(proposeMark(step(10), one).proposedMarks).toBe(2); // 25 % / 55 % × 4 = 1.82 → 2
    // nothing relevant earns nothing at any difficulty
    expect(proposeMark(step(10), doc('I do not know.')).proposedMarks).toBe(0);
  });
});
