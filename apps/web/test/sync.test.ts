import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { ApiError } from '@/lib/api';
import { canonicalJson } from '@/lib/canonical';
import { AnswerSync, type AnswerLoadResponse, type AnswerSaveBody, type SyncTransport } from '@/lib/sync';
import { SignalReporter } from '@/lib/signals';

const sha = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');
const problem = (status: number, code: string) => new ApiError({ type: 'x', title: code, status, code, requestId: 't', retryable: false });

/** A tiny in-memory server that behaves like PUT/GET answers, including REVISION_CONFLICT. */
function fakeServer() {
  const docs = new Map<string, { revision: number; blocks: Array<{ id: string; kind: string; content: unknown }> }>();
  const seen = new Set<string>();
  const puts: AnswerSaveBody[] = [];
  let failNext: ApiError | 'network' | null = null;
  const transport: SyncTransport = {
    async load(q): Promise<AnswerLoadResponse> {
      const d = docs.get(q) ?? { revision: 0, blocks: [] };
      return { questionId: q, serverRevision: d.revision, content: { blocks: d.blocks.map((b) => ({ ...b, kind: b.kind as 'paragraph' })) }, contentSha256: sha({ blocks: d.blocks }) };
    },
    async save(q, body) {
      puts.push(body);
      if (failNext) {
        const f = failNext;
        failNext = null;
        if (f === 'network') throw problem(0, 'NETWORK');
        throw f;
      }
      const d = docs.get(q) ?? { revision: 0, blocks: [] };
      if (seen.has(body.clientOperationId)) return { accepted: true, serverRevision: d.revision, receiptId: 'dup', serverSavedAt: new Date().toISOString(), contentSha256: sha({ blocks: d.blocks }), duplicate: true };
      if (d.revision !== body.baseRevision) throw problem(409, 'REVISION_CONFLICT');
      const blocks = [...d.blocks];
      for (const op of body.ops) {
        const idx = blocks.findIndex((b) => b.id === op.blockId);
        if (op.op === 'upsert-block') {
          const block = { id: op.blockId, kind: op.kind ?? blocks[idx]?.kind ?? 'paragraph', content: op.content ?? null };
          if (idx >= 0) blocks[idx] = block;
          else blocks.push(block);
        } else if (op.op === 'delete-block' && idx >= 0) blocks.splice(idx, 1);
      }
      const hash = sha({ blocks });
      if (hash !== body.contentSha256) throw problem(422, 'CONTENT_HASH_MISMATCH');
      seen.add(body.clientOperationId);
      docs.set(q, { revision: d.revision + 1, blocks });
      return { accepted: true, serverRevision: d.revision + 1, receiptId: `r${d.revision + 1}`, serverSavedAt: new Date().toISOString(), contentSha256: hash, duplicate: false };
    },
  };
  return { transport, docs, puts, fail: (f: ApiError | 'network') => (failNext = f) };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('AnswerSync', () => {
  let storage: Map<string, string>;
  const fakeStorage = () => ({ getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) });
  beforeEach(() => {
    storage = new Map();
  });
  afterEach(() => vi.useRealTimers());

  it('debounces typing into one PUT with baseRevision 0, the changed block as an upsert op, and the matching contentSha256', async () => {
    const srv = fakeServer();
    const sync = new AnswerSync({ attemptId: 'a1', transport: srv.transport, debounceMs: 20, maxWaitMs: 200, storage: fakeStorage() });
    await sync.load('Q1');
    sync.edit('Q1', { blocks: [{ id: 'b1', kind: 'paragraph', content: 'h' }] });
    sync.edit('Q1', { blocks: [{ id: 'b1', kind: 'paragraph', content: 'he' }] });
    sync.edit('Q1', { blocks: [{ id: 'b1', kind: 'paragraph', content: 'hello' }] });
    expect(sync.getSnapshot().overall).toBe('saved-local');
    await wait(60);
    expect(srv.puts).toHaveLength(1);
    expect(srv.puts[0]).toMatchObject({ baseRevision: 0, answerFormat: 'hybrid-v1', ops: [{ op: 'upsert-block', blockId: 'b1', kind: 'paragraph', content: 'hello' }] });
    expect(srv.puts[0]?.contentSha256).toBe(sha({ blocks: [{ id: 'b1', kind: 'paragraph', content: 'hello' }] }));
    expect(sync.getSnapshot().overall).toBe('saved-server');
    expect(sync.getSnapshot().questions['Q1']?.serverRevision).toBe(1);
    sync.dispose();
  });

  it('sends the next save against the new server revision', async () => {
    const srv = fakeServer();
    const sync = new AnswerSync({ attemptId: 'a1', transport: srv.transport, debounceMs: 10, storage: fakeStorage() });
    await sync.load('Q1');
    sync.edit('Q1', { blocks: [{ id: 'b1', kind: 'paragraph', content: 'one' }] });
    await waitFor(() => expect(srv.puts.length).toBe(1));
    sync.edit('Q1', { blocks: [{ id: 'b1', kind: 'paragraph', content: 'one two' }] });
    await waitFor(() => expect(srv.puts.map((p) => p.baseRevision)).toEqual([0, 1]));
    expect(srv.docs.get('Q1')?.revision).toBe(2);
    sync.dispose();
  });

  it('on 409 REVISION_CONFLICT it reloads the server document and rebases the local draft onto the new revision', async () => {
    const srv = fakeServer();
    const sync = new AnswerSync({ attemptId: 'a1', transport: srv.transport, debounceMs: 10, storage: fakeStorage() });
    await sync.load('Q1');
    // Another client (or a proctor-side correction) moved the server to revision 3.
    srv.docs.set('Q1', { revision: 3, blocks: [{ id: 'b0', kind: 'paragraph', content: 'from server' }] });
    sync.edit('Q1', { blocks: [{ id: 'b1', kind: 'paragraph', content: 'local' }] });
    await wait(60);
    expect(srv.puts[0]?.baseRevision).toBe(0);
    const last = srv.puts[srv.puts.length - 1]!;
    expect(last.baseRevision).toBe(3);
    // The local draft wins for the blocks it holds; the server's extra block is removed because it is not in the draft.
    expect(last.ops).toEqual(expect.arrayContaining([{ op: 'upsert-block', blockId: 'b1', kind: 'paragraph', content: 'local' }, { op: 'delete-block', blockId: 'b0' }]));
    expect(srv.docs.get('Q1')).toEqual({ revision: 4, blocks: [{ id: 'b1', kind: 'paragraph', content: 'local' }] });
    expect(sync.getSnapshot().overall).toBe('saved-server');
    sync.dispose();
  });

  it('retries a transport failure with the same clientOperationId, so a duplicate is harmless', async () => {
    const srv = fakeServer();
    const sync = new AnswerSync({ attemptId: 'a1', transport: srv.transport, debounceMs: 10, retryMs: 80, storage: fakeStorage() });
    await sync.load('Q1');
    srv.fail('network');
    sync.edit('Q1', { blocks: [{ id: 'b1', kind: 'paragraph', content: 'keep me' }] });
    await wait(25);
    expect(srv.puts).toHaveLength(1);
    expect(sync.getSnapshot().overall).toBe('saved-local');
    await wait(85);
    expect(srv.puts).toHaveLength(2);
    expect(srv.puts[1]?.clientOperationId).toBe(srv.puts[0]?.clientOperationId);
    expect(sync.getSnapshot().overall).toBe('saved-server');
    sync.dispose();
  });

  it('reports Recovery needed after failing for longer than the recovery window, and keeps the draft locally', async () => {
    const srv = fakeServer();
    let now = 1_000_000;
    const sync = new AnswerSync({ attemptId: 'a1', transport: srv.transport, debounceMs: 5, retryMs: 5, recoveryAfterMs: 100, now: () => now, storage: fakeStorage() });
    await sync.load('Q1');
    srv.transport.save = async () => {
      throw problem(0, 'NETWORK');
    };
    sync.edit('Q1', { blocks: [{ id: 'b1', kind: 'paragraph', content: 'still here' }] });
    await wait(30);
    expect(sync.getSnapshot().overall).toBe('saved-local');
    now += 150;
    await wait(30);
    expect(sync.getSnapshot().overall).toBe('recovery');
    expect(sync.getDoc('Q1').blocks[0]?.content).toBe('still here');
    expect(JSON.parse(storage.get('examos.draft.a1.Q1') ?? '{}').dirty).toBe(true);
    sync.dispose();
  });

  it('pauses on ATTEMPT_NOT_ACTIVE and resumes the pending save on resume()', async () => {
    const srv = fakeServer();
    const blocked: string[] = [];
    const sync = new AnswerSync({ attemptId: 'a1', transport: srv.transport, debounceMs: 5, storage: fakeStorage(), onBlocked: (c) => blocked.push(c) });
    await sync.load('Q1');
    srv.fail(problem(409, 'ATTEMPT_NOT_ACTIVE'));
    sync.edit('Q1', { blocks: [{ id: 'b1', kind: 'paragraph', content: 'paused text' }] });
    await wait(30);
    expect(blocked).toEqual(['ATTEMPT_NOT_ACTIVE']);
    expect(sync.getSnapshot().overall).toBe('paused');
    expect(sync.unsyncedQuestionIds()).toEqual(['Q1']);
    sync.resume();
    await wait(30);
    expect(sync.getSnapshot().overall).toBe('saved-server');
    expect(srv.docs.get('Q1')?.blocks[0]?.content).toBe('paused text');
    sync.dispose();
  });

  it('restores an unsynced draft from storage and syncs it after load()', async () => {
    const srv = fakeServer();
    const s1 = new AnswerSync({ attemptId: 'a1', transport: srv.transport, debounceMs: 10_000, storage: fakeStorage() });
    await s1.load('Q1');
    s1.edit('Q1', { blocks: [{ id: 'b1', kind: 'paragraph', content: 'typed before the crash' }] });
    s1.dispose();
    const s2 = new AnswerSync({ attemptId: 'a1', transport: srv.transport, debounceMs: 5, storage: fakeStorage() });
    expect(s2.getDoc('Q1').blocks[0]?.content).toBe('typed before the crash');
    await s2.load('Q1');
    await wait(30);
    expect(srv.docs.get('Q1')?.blocks[0]?.content).toBe('typed before the crash');
    s2.dispose();
  });
});

describe('SignalReporter', () => {
  it('sends at most one event per class per 5 s with uuid source ids', () => {
    let now = 0;
    const sent: unknown[] = [];
    const r = new SignalReporter({ attemptId: 'a1', now: () => now, send: async (ev) => void sent.push(...ev) });
    const first = r.report('FOCUS_LOST');
    expect(first?.sourceEventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.report('FOCUS_LOST')).toBeNull();
    expect(r.report('FULLSCREEN_EXIT')).not.toBeNull();
    now = 5001;
    expect(r.report('FOCUS_LOST')).not.toBeNull();
    expect(sent).toHaveLength(3);
  });
});
