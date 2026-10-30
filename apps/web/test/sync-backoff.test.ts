import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import { AnswerSync } from '@/lib/sync';
import type { AnswerDoc } from '@/lib/answers';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const problem = (code: string, status: number) => new ApiError({ type: `urn:examos:error:${code}`, title: code, status, code, requestId: 't', retryable: false });
const para = (text: string): AnswerDoc => ({ blocks: [{ id: 'b1', kind: 'paragraph', content: text }] });
const load = async (q: string) => ({ questionId: q, serverRevision: 0, content: { blocks: [] }, contentSha256: '' });

/**
 * Two thousand clients must never retry in lock-step after an outage, loop on
 * a conflict at network speed, or resend content the server has refused.
 * Real timers (as in sync.test.ts): hashing runs off the event loop. Jitter is
 * pinned to the middle of its range so the schedule is deterministic.
 */
describe('save retries under failure', () => {
  it('backs off exponentially on transport failures and keeps the same clientOperationId', async () => {
    const attempts: string[] = [];
    let fail = true;
    const sync = new AnswerSync({
      attemptId: 'a1',
      storage: null,
      debounceMs: 5,
      retryMs: 100,
      jitter: () => 0.5,
      transport: {
        save: async (_q, body) => {
          attempts.push(body.clientOperationId);
          if (fail) throw problem('NETWORK', 0);
          return { accepted: true, serverRevision: 1, receiptId: 'r1', serverSavedAt: new Date().toISOString(), contentSha256: body.contentSha256, duplicate: false };
        },
        load,
      },
    });
    sync.edit('Q1', para('hello'));
    await wait(40); // debounce → first attempt
    expect(attempts).toHaveLength(1);
    await wait(110); // +100 ms → second attempt
    expect(attempts).toHaveLength(2);
    await wait(100); // the third waits 200 ms (2 × retryMs), so not yet
    expect(attempts).toHaveLength(2);
    await wait(150);
    expect(attempts).toHaveLength(3);
    expect(new Set(attempts).size).toBe(1); // identical request each time: idempotent on the server
    fail = false;
    await wait(500); // fourth attempt after 400 ms succeeds
    expect(attempts.length).toBeGreaterThanOrEqual(4);
    expect(sync.unsyncedQuestionIds()).toEqual([]);
    sync.dispose();
  });

  it('stops retrying content the server refused, shows it as needing attention, and tries again only after the student edits', async () => {
    const saves: string[] = [];
    const sync = new AnswerSync({
      attemptId: 'a2',
      storage: null,
      debounceMs: 5,
      retryMs: 20,
      jitter: () => 0.5,
      transport: {
        save: async (_q, body) => {
          const op = body.ops[0] as { content: string };
          saves.push(op.content);
          if (op.content.length > 10) throw problem('ANSWER_TOO_LARGE', 422);
          return { accepted: true, serverRevision: saves.length, receiptId: `r${saves.length}`, serverSavedAt: new Date().toISOString(), contentSha256: body.contentSha256, duplicate: false };
        },
        load,
      },
    });
    sync.edit('Q1', para('far too long for the server'));
    await wait(40);
    expect(saves).toHaveLength(1);
    expect(sync.getSnapshot().questions['Q1']!.state).toBe('recovery');
    await wait(300);
    expect(saves).toHaveLength(1); // no blind retries of refused content
    sync.edit('Q1', para('short'));
    await wait(40);
    expect(saves).toEqual(['far too long for the server', 'short']);
    expect(sync.getSnapshot().questions['Q1']!.state).toBe('saved-server');
    sync.dispose();
  });

  it('caps immediate rebases: a conflict that never resolves slows down instead of looping at network speed', async () => {
    let saves = 0;
    const sync = new AnswerSync({
      attemptId: 'a3',
      storage: null,
      debounceMs: 5,
      retryMs: 200,
      jitter: () => 0.5,
      transport: {
        save: async () => {
          saves++;
          throw problem('REVISION_CONFLICT', 409);
        },
        load: async (q) => ({ questionId: q, serverRevision: saves, content: { blocks: [{ id: 'srv', kind: 'paragraph', content: `server ${saves}` }] }, contentSha256: '' }),
      },
    });
    sync.edit('Q1', para('mine'));
    await wait(120); // first try + three immediate rebases
    const afterBurst = saves;
    expect(afterBurst).toBe(4);
    expect(sync.getSnapshot().questions['Q1']!.state).toBe('recovery');
    await wait(60); // the next try waits retryMs (200 ms) after the burst
    expect(saves).toBe(4);
    await wait(140);
    expect(saves).toBe(5);
    sync.dispose();
  });
});
