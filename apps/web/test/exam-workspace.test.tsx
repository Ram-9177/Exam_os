import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExamWorkspace } from '@/features/exam/ExamWorkspace';
import { canonicalJson } from '@/lib/canonical';
import { mockFetch, renderApp, signInAs, TENANT } from './helpers';

const ATTEMPT = 'c938b02f-05ea-41dc-8aa0-fd578eb399be';
const sha = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');

interface ServerDoc {
  revision: number;
  blocks: Array<{ id: string; kind: string; content: unknown }>;
}

function setup() {
  const me = signInAs(['STUDENT'], { id: 'u1', email: 'student01@demo.local', fullName: 'Student One', kind: 'STUDENT' });
  const docs = new Map<string, ServerDoc>();
  const puts: Array<{ body: Record<string, unknown>; headers: Record<string, string> }> = [];
  let conflictNext = false;
  const serverNow = () => new Date().toISOString();
  const deadlineAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const { calls } = mockFetch(({ method, path, body, headers }) => {
    if (method === 'GET' && path === '/auth/me') return { json: me };
    if (method === 'GET' && path === '/tenant') return { json: TENANT };
    if (method === 'GET' && path === `/student/attempts/${ATTEMPT}/policy`) return { json: { examTitle: 'Operating Systems — Mid 1', durationMinutes: 60 } };
    if (method === 'GET' && path === `/student/attempts/${ATTEMPT}/paper`) {
      return {
        json: {
          paperId: 'p1', title: 'Operating Systems — Mid 1', instructions: 'Answer all questions.', totalMarks: 50, setCode: 'A',
          sections: [{ code: 'A', title: 'Section A' }],
          questions: [1, 2, 3, 4, 5].map((n) => ({ questionId: `Q${n}`, sectionCode: 'A', number: n, kind: 'DESCRIPTIVE', prompt: { blocks: [{ type: 'paragraph', text: `Prompt ${n}` }] }, maxMarks: 10, attachments: [] })),
        },
      };
    }
    if (method === 'POST' && path === `/student/attempts/${ATTEMPT}/reconnect`) return { json: { status: 'ACTIVE', deadlineAt, deviceSessionId: 'dev-1', serverNow: serverNow(), answers: [] } };
    if (method === 'POST' && path === `/student/attempts/${ATTEMPT}/heartbeat`) return { json: { status: 'ACTIVE', serverNow: serverNow(), deadlineAt, authorizationGeneration: 1 } };
    const m = /^\/student\/attempts\/[^/]+\/answers\/([^/?]+)$/.exec(path);
    if (m) {
      const q = m[1]!;
      const d = docs.get(q) ?? { revision: 0, blocks: [] };
      if (method === 'GET') return { json: { questionId: q, serverRevision: d.revision, content: { blocks: d.blocks }, contentSha256: sha({ blocks: d.blocks }) } };
      if (method === 'PUT') {
        const b = body as { baseRevision: number; ops: Array<{ op: string; blockId: string; kind?: string; content?: unknown }>; contentSha256: string; clientOperationId: string };
        puts.push({ body: b as unknown as Record<string, unknown>, headers });
        if (conflictNext) {
          conflictNext = false;
          return { status: 409, json: { type: 'x', title: 'Server revision is 3, client based on 1', status: 409, code: 'REVISION_CONFLICT', requestId: 't' } };
        }
        if (b.baseRevision !== d.revision) return { status: 409, json: { type: 'x', title: 'conflict', status: 409, code: 'REVISION_CONFLICT', requestId: 't' } };
        const blocks = [...d.blocks];
        for (const op of b.ops) {
          const idx = blocks.findIndex((x) => x.id === op.blockId);
          if (op.op === 'upsert-block') {
            const blk = { id: op.blockId, kind: op.kind ?? 'paragraph', content: op.content ?? null };
            if (idx >= 0) blocks[idx] = blk;
            else blocks.push(blk);
          } else if (op.op === 'delete-block' && idx >= 0) blocks.splice(idx, 1);
        }
        if (sha({ blocks }) !== b.contentSha256) return { status: 422, json: { type: 'x', title: 'hash mismatch', status: 422, code: 'CONTENT_HASH_MISMATCH', requestId: 't' } };
        docs.set(q, { revision: d.revision + 1, blocks });
        return { json: { accepted: true, serverRevision: d.revision + 1, receiptId: `rcpt-${d.revision + 1}`, serverSavedAt: serverNow(), contentSha256: b.contentSha256, duplicate: false } };
      }
    }
    return undefined;
  });
  return { calls, puts, docs, conflict: () => (conflictNext = true) };
}

describe('Exam workspace', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reconnects, shows the clock and the question map, autosaves typing as ops with baseRevision 0, and rebases after a 409', async () => {
    const srv = setup();
    renderApp([{ path: '/student/attempts/:attemptId/exam', element: <ExamWorkspace /> }], `/student/attempts/${ATTEMPT}/exam`);
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });

    expect(await screen.findByText('Operating Systems — Mid 1')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Question 1' })).toBeInTheDocument();
    expect(screen.getByText('Question 1 of 5')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Questions' }).querySelectorAll('li')).toHaveLength(5);
    await waitFor(() => expect(screen.getByText('remaining')).toBeInTheDocument());
    await waitFor(() => expect(srv.calls.filter((c) => c.method === 'GET' && /\/answers\/Q\d$/.test(c.path))).toHaveLength(5));

    const textarea = await screen.findByLabelText('Answer paragraph 1');
    await user.click(textarea);
    await user.type(textarea, 'A process is a program in execution.');
    expect(textarea).toHaveValue('A process is a program in execution.');
    expect(screen.getAllByText('Saved locally').length).toBeGreaterThan(0);

    // Debounce (3 s) elapses → exactly one PUT with baseRevision 0 and an upsert of the typed paragraph.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3300);
    });
    await waitFor(() => expect(srv.puts).toHaveLength(1));
    const first = srv.puts[0]!;
    expect(first.headers['x-device-session']).toBe('dev-1');
    expect(first.headers['authorization']).toBe('Bearer access');
    expect(first.body['baseRevision']).toBe(0);
    expect(first.body['answerFormat']).toBe('hybrid-v1');
    const ops = first.body['ops'] as Array<{ op: string; blockId: string; kind: string; content: unknown }>;
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: 'upsert-block', kind: 'paragraph', content: 'A process is a program in execution.' });
    expect(first.body['contentSha256']).toBe(sha({ blocks: [{ id: ops[0]!.blockId, kind: 'paragraph', content: 'A process is a program in execution.' }] }));
    expect(srv.docs.get('Q1')?.revision).toBe(1);
    await waitFor(() => expect(screen.getAllByText('Saved to server').length).toBeGreaterThan(0));

    // Server moves on to revision 3 behind our back; our next save gets a 409, we GET the server copy and rebase onto it.
    srv.docs.set('Q1', { revision: 3, blocks: [{ id: 'srv', kind: 'paragraph', content: 'server copy' }] });
    srv.conflict();
    await user.type(textarea, ' It has a PCB.');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3300);
    });
    await waitFor(() => expect(srv.puts.length).toBeGreaterThanOrEqual(3));
    const conflicted = srv.puts[1]!;
    expect(conflicted.body['baseRevision']).toBe(1);
    const rebased = srv.puts[srv.puts.length - 1]!;
    expect(rebased.body['baseRevision']).toBe(3);
    const rebasedOps = rebased.body['ops'] as Array<{ op: string; blockId: string; content?: unknown }>;
    expect(rebasedOps).toEqual(expect.arrayContaining([expect.objectContaining({ op: 'upsert-block', blockId: ops[0]!.blockId, content: 'A process is a program in execution. It has a PCB.' }), { op: 'delete-block', blockId: 'srv' }]));
    expect(srv.docs.get('Q1')).toEqual({ revision: 4, blocks: [{ id: ops[0]!.blockId, kind: 'paragraph', content: 'A process is a program in execution. It has a PCB.' }] });
    expect(srv.calls.filter((c) => c.method === 'GET' && c.path.endsWith('/answers/Q1'))).toHaveLength(2);
    await waitFor(() => expect(screen.getAllByText('Saved to server').length).toBeGreaterThan(0));
  });

  it('restores unsaved drafts kept on this device after a reload, says which questions, and sends them to the server', async () => {
    sessionStorage.setItem(`examos.draft.${ATTEMPT}`, JSON.stringify({ Q2: { localDoc: { blocks: [{ id: 'b-off', kind: 'paragraph', content: 'kept offline' }] }, serverRevision: 0, serverDoc: { blocks: [] }, dirty: true } }));
    const srv = setup();
    renderApp([{ path: '/student/attempts/:attemptId/exam', element: <ExamWorkspace /> }], `/student/attempts/${ATTEMPT}/exam`);
    const notice = await screen.findByRole('status', { name: '' });
    expect(notice).toHaveTextContent('Restored 1 unsaved answer kept on this device (Question 2). Sending to the server now.');
    expect(screen.getByRole('button', { name: 'Retry now' })).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    await waitFor(() => expect(srv.puts.some((p) => JSON.stringify(p.body['ops']).includes('kept offline'))).toBe(true));
    await waitFor(() => expect(srv.docs.get('Q2')?.blocks).toEqual([{ id: 'b-off', kind: 'paragraph', content: 'kept offline' }]));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('All saved to the server.'));
    await userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) }).click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/Restored 1 unsaved answer/)).not.toBeInTheDocument();
  });

  it('lists unsynced questions in the submit confirmation and never shows AI scores or the word cheating', async () => {
    setup();
    renderApp([{ path: '/student/attempts/:attemptId/exam', element: <ExamWorkspace /> }], `/student/attempts/${ATTEMPT}/exam`);
    const user = userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
    const textarea = await screen.findByLabelText('Answer paragraph 1');
    // the editor stays read-only until the server copy of the answer has loaded (nothing typed can be overwritten)
    await waitFor(() => expect(screen.getByLabelText('Answer paragraph 1')).toBeEnabled());
    await user.type(screen.getByLabelText('Answer paragraph 1'), 'draft');
    expect(screen.getByLabelText('Answer paragraph 1')).toHaveValue('draft');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAccessibleName('Submit your answers?');
    expect(dialog).toHaveTextContent('Still syncing: Question 1');
    expect(document.body.textContent).not.toMatch(/cheat/i);
    expect(document.body.textContent).not.toMatch(/score/i);
    await user.click(screen.getByRole('button', { name: 'Keep writing' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Submit' }));
  });
});
