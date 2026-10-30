import { describe, expect, it } from 'vitest';
import { AnswerSync } from '@/lib/sync';
import type { AnswerDoc } from '@/lib/answers';

/** A Storage double with enumeration, like sessionStorage. */
function fakeStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
    keys: () => [...m.keys()],
  };
}
const transport = { save: async () => { throw new Error('offline'); }, load: async (q: string) => ({ questionId: q, serverRevision: 0, content: { blocks: [] }, contentSha256: '' }) } as unknown as ConstructorParameters<typeof AnswerSync>[0]['transport'];
const para = (id: string, text: string): AnswerDoc => ({ blocks: [{ id, kind: 'paragraph', content: text }] });

describe('draft persistence on the device', () => {
  it('keeps one entry per question, so an oversized drawing only loses its own persistence', () => {
    const storage = fakeStorage();
    const sync = new AnswerSync({ attemptId: 'a1', transport, storage });
    sync.edit('Q1', para('b1', 'kept'));
    sync.edit('Q2', para('b2', 'x'.repeat(1_600_000)));
    sync.edit('Q3', para('b3', 'also kept'));
    expect(storage.keys().filter((k) => !k.endsWith('.index')).sort()).toEqual(['examos.draft.a1.Q1', 'examos.draft.a1.Q3']);
    sync.dispose();

    const again = new AnswerSync({ attemptId: 'a1', transport, storage });
    expect([...again.restoredDraftIds()].sort()).toEqual(['Q1', 'Q3']);
    expect(again.getDoc('Q1')).toEqual(para('b1', 'kept'));
    expect(again.unsyncedQuestionIds().sort()).toEqual(['Q1', 'Q3']);
    again.clearPersisted();
    expect(storage.keys()).toEqual([]);
    again.dispose();
  });

  it('still restores the single-blob format written by earlier builds', () => {
    const storage = fakeStorage();
    storage.setItem('examos.draft.a2', JSON.stringify({ Q4: { localDoc: para('b4', 'legacy'), serverRevision: 2, serverDoc: { blocks: [] }, dirty: true } }));
    const sync = new AnswerSync({ attemptId: 'a2', transport, storage });
    expect(sync.restoredDraftIds()).toEqual(['Q4']);
    expect(sync.getDoc('Q4')).toEqual(para('b4', 'legacy'));
    sync.clearPersisted();
    expect(storage.keys()).toEqual([]);
    sync.dispose();
  });
});
