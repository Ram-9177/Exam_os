import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StructuredAnswer, StructuredRender, type StructuredQuestion } from '@/features/exam/StructuredAnswer';
import type { AnswerDoc } from '@/lib/answers';
import { mockFetch, renderApp, signInAs, TENANT } from './helpers';

function Harness({ q, onDoc }: { q: StructuredQuestion; onDoc: (d: AnswerDoc) => void }) {
  const [doc, setDoc] = useState<AnswerDoc>({ blocks: [{ id: 'p', kind: 'paragraph', content: '' }] });
  return <StructuredAnswer question={q} doc={doc} attemptId="a1" disabled={false} onChange={(d) => { setDoc(d); onDoc(d); }} />;
}
const setup = (handler?: Parameters<typeof mockFetch>[0]) => {
  const me = signInAs(['STUDENT']);
  mockFetch((call) => (call.path === '/auth/me' ? { json: me } : call.path === '/tenant' ? { json: TENANT } : handler?.(call)));
};
const opts = [{ key: 'A', text: 'C' }, { key: 'B', text: 'Python' }, { key: 'C', text: 'C++' }];
const block = (d: AnswerDoc | null, kind: string) => d!.blocks.find((b) => b.kind === kind)?.content;

describe('structured answers in the workspace', () => {
  it('MCQ is answered with option buttons; choosing again clears; MCQ_MULTI takes several', async () => {
    setup();
    let doc: AnswerDoc | null = null;
    const user = userEvent.setup();
    const view = renderApp([{ path: '/', element: <Harness q={{ id: 'Q1', kind: 'MCQ', options: opts }} onDoc={(d) => (doc = d)} /> }], '/');
    await user.click(await screen.findByRole('radio', { name: /Python/ }));
    expect(block(doc, 'choice')).toEqual({ selected: 'B' });
    expect(doc!.blocks.map((b) => b.kind)).toEqual(['choice', 'paragraph']); // the working paragraph is kept
    await user.click(screen.getByRole('radio', { name: /Python/ }));
    expect(block(doc, 'choice')).toEqual({ selected: null });
    view.unmount();
    renderApp([{ path: '/', element: <Harness q={{ id: 'Q2', kind: 'MCQ_MULTI', options: opts }} onDoc={(d) => (doc = d)} /> }], '/');
    await user.click(await screen.findByRole('checkbox', { name: /C\+\+/ }));
    await user.click(screen.getByRole('checkbox', { name: /^A\.\s*C$/ }));
    expect(block(doc, 'choice')).toEqual({ selected: ['A', 'C'] });
    expect(screen.getByText(/never below zero/)).toBeInTheDocument();
  });

  it('NUMERIC/MATH take a final answer beside the working', async () => {
    setup();
    let doc: AnswerDoc | null = null;
    const user = userEvent.setup();
    renderApp([{ path: '/', element: <Harness q={{ id: 'Q3', kind: 'MATH' }} onDoc={(d) => (doc = d)} /> }], '/');
    await user.type(await screen.findByLabelText('Final answer'), '2(x+1)');
    expect(block(doc, 'final')).toEqual({ text: '2(x+1)' });
    expect(screen.getByText(/Any equivalent form is accepted/)).toBeInTheDocument();
  });

  it('CODE: language, program with Tab indentation, sample runs with their results and the runs left', async () => {
    const posts: unknown[] = [];
    setup(({ method, path, body }) => {
      if (method === 'POST' && path === '/student/attempts/a1/code-runs') {
        posts.push(body);
        return { json: { runId: 'r1', remaining: 1, error: null, results: [{ test: 1, passed: false, verdict: 'wrong answer', output: '5', expected: '6' }] } };
      }
      return undefined;
    });
    let doc: AnswerDoc | null = null;
    const user = userEvent.setup();
    renderApp([{ path: '/', element: <Harness q={{ id: 'Q4', kind: 'CODE', codeSpec: { languages: ['python', 'c'], samples: [{ input: '3', expected: '6' }], sampleRunsAllowed: 2 } }} onDoc={(d) => (doc = d)} /> }], '/');
    await user.selectOptions(await screen.findByLabelText('Language'), 'c');
    await user.type(screen.getByLabelText('Program'), 'int main(){{{Enter}{Tab}return 0;');
    expect(block(doc, 'code')).toEqual({ language: 'c', source: 'int main(){\n    return 0;' });
    await user.click(screen.getByRole('button', { name: 'Run sample tests' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ questionId: 'Q4', language: 'c', source: 'int main(){\n    return 0;' });
    expect(await screen.findByText('Sample 1: wrong answer')).toBeInTheDocument();
    expect(screen.getByText('1 of 2 runs left')).toBeInTheDocument();
  });

  it('the booklet shows what was chosen, the final answer and the program', () => {
    setup();
    renderApp([{ path: '/', element: <div><StructuredRender block={{ id: '1', kind: 'choice', content: { selected: ['A', 'C'] } }} /><StructuredRender block={{ id: '2', kind: 'final', content: { text: '9.33 ms' } }} /><StructuredRender block={{ id: '3', kind: 'code', content: { language: 'cpp', source: 'int main(){}' } }} /></div> }], '/');
    expect(screen.getByText('Chosen: A, C')).toBeInTheDocument();
    expect(screen.getByText('9.33 ms')).toBeInTheDocument();
    expect(screen.getByText('Program (C++)')).toBeInTheDocument();
  });
});
