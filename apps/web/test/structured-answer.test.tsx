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
    expect(screen.getByText('Program (C++ (GCC 9.2.0))')).toBeInTheDocument();
  });

  it('a project question: file tabs, read-only harness, only the editable files are the answer and are sent to run', async () => {
    const posts: unknown[] = [];
    setup(({ method, path, body }) => {
      if (method === 'POST' && path === '/student/attempts/a1/code-runs') {
        posts.push(body);
        return { json: { runId: 'r1', remaining: 2, error: null, results: [{ test: 1, passed: false, verdict: 'build failed', output: '', expected: '6', compileOutput: 'Solution.java:3: error: missing return' }] } };
      }
      return undefined;
    });
    let doc: AnswerDoc | null = null;
    const user = userEvent.setup();
    const project = { files: [{ path: 'Main.java', content: 'class Main {}', editable: false }, { path: 'Solution.java', content: 'class Solution {', editable: true }], build: 'javac -d out *.java', run: 'java -cp out Main' };
    renderApp([{ path: '/', element: <Harness q={{ id: 'Q5', kind: 'CODE', codeSpec: { languages: ['java'], samples: [{ input: '3', expected: '6' }], sampleRunsAllowed: 3, project } }} onDoc={(d) => (doc = d)} /> }], '/');
    // opens on the student's file; the toolchain is fixed and shown with its version
    expect(await screen.findByRole('tab', { name: /Solution\.java · yours/, selected: true })).toBeInTheDocument();
    expect(screen.getByText('Java (OpenJDK 13.0.1)')).toBeInTheDocument();
    expect(screen.queryByLabelText('Language')).toBeNull();
    expect(screen.getByText('javac -d out *.java')).toBeInTheDocument();
    await user.type(screen.getByLabelText('File Solution.java'), '{Enter}{Tab}int x;');
    expect(block(doc, 'code')).toEqual({ language: 'java', source: '', files: { 'Solution.java': 'class Solution {\n    int x;' } });
    // the harness is visible but cannot be changed
    await user.click(screen.getByRole('tab', { name: /Main\.java · read-only/ }));
    const harness = screen.getByLabelText('File Main.java');
    expect(harness).toHaveValue('class Main {}');
    expect(harness).toHaveAttribute('readonly');
    await user.type(harness, 'x');
    expect(harness).toHaveValue('class Main {}');
    await user.click(screen.getByRole('button', { name: 'Run sample tests' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ questionId: 'Q5', language: 'java', source: '', files: { 'Solution.java': 'class Solution {\n    int x;' } });
    expect(await screen.findByText('Sample 1: build failed')).toBeInTheDocument();
    expect(screen.getByText('Solution.java:3: error: missing return')).toBeInTheDocument();
  });

  it('the booklet shows each file of a project answer', () => {
    setup();
    renderApp([{ path: '/', element: <StructuredRender block={{ id: '3', kind: 'code', content: { language: 'java', source: '', files: { 'Solution.java': 'class Solution {}', 'util/Helper.java': 'class Helper {}' } } }} /> }], '/');
    expect(screen.getByText('Solution.java')).toBeInTheDocument();
    expect(screen.getByText('util/Helper.java')).toBeInTheDocument();
    expect(screen.getByText('class Helper {}')).toBeInTheDocument();
  });
});
