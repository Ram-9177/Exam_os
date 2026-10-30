import { describe, expect, it } from 'vitest';
import { applyOps, buildOps, docsEqual, type AnswerDoc } from '@/lib/answers';

const base: AnswerDoc = {
  blocks: [
    { id: 'p1', kind: 'paragraph', content: 'first' },
    { id: 'c1', kind: 'canvas', content: { width: 10, height: 10, strokes: [] } },
    { id: 'p2', kind: 'paragraph', content: 'second' },
  ],
};

describe('buildOps (autosave op builder)', () => {
  it('emits nothing when the documents are equal', () => {
    expect(buildOps(base, { blocks: base.blocks.map((b) => ({ ...b })) })).toEqual([]);
  });

  it('upserts only the changed block', () => {
    const next: AnswerDoc = { blocks: [base.blocks[0]!, base.blocks[1]!, { id: 'p2', kind: 'paragraph', content: 'second, edited' }] };
    const ops = buildOps(base, next);
    expect(ops).toEqual([{ op: 'upsert-block', blockId: 'p2', kind: 'paragraph', content: 'second, edited' }]);
    expect(docsEqual(applyOps(base, ops), next)).toBe(true);
  });

  it('appends a new block at the end with a single upsert', () => {
    const next: AnswerDoc = { blocks: [...base.blocks, { id: 'p3', kind: 'paragraph', content: 'third' }] };
    const ops = buildOps(base, next);
    expect(ops).toEqual([{ op: 'upsert-block', blockId: 'p3', kind: 'paragraph', content: 'third' }]);
    expect(docsEqual(applyOps(base, ops), next)).toBe(true);
  });

  it('deletes removed blocks', () => {
    const next: AnswerDoc = { blocks: [base.blocks[0]!, base.blocks[2]!] };
    const ops = buildOps(base, next);
    expect(ops).toEqual([{ op: 'delete-block', blockId: 'c1' }]);
    expect(docsEqual(applyOps(base, ops), next)).toBe(true);
  });

  it('inserts in the middle with an upsert followed by reorders, and the server-side apply reproduces the order', () => {
    const next: AnswerDoc = { blocks: [base.blocks[0]!, { id: 'c2', kind: 'canvas', content: { width: 5, height: 5, strokes: [] } }, base.blocks[1]!, base.blocks[2]!] };
    const ops = buildOps(base, next);
    expect(ops[0]).toEqual({ op: 'upsert-block', blockId: 'c2', kind: 'canvas', content: { width: 5, height: 5, strokes: [] } });
    expect(ops.slice(1).every((o) => o.op === 'reorder')).toBe(true);
    expect(ops.slice(1)[0]).toEqual({ op: 'reorder', blockId: 'p1', after: null });
    expect(applyOps(base, ops).blocks.map((b) => b.id)).toEqual(['p1', 'c2', 'c1', 'p2']);
  });

  it('treats a changed kind as an upsert and undefined content as null', () => {
    const next: AnswerDoc = { blocks: [{ id: 'p1', kind: 'equation', content: undefined }, base.blocks[1]!, base.blocks[2]!] };
    const ops = buildOps(base, next);
    expect(ops).toEqual([{ op: 'upsert-block', blockId: 'p1', kind: 'equation', content: null }]);
  });

  it('round-trips a complex edit (edit + delete + move) through applyOps', () => {
    const next: AnswerDoc = { blocks: [{ id: 'p2', kind: 'paragraph', content: 'second' }, { id: 'p1', kind: 'paragraph', content: 'first!' }] };
    const ops = buildOps(base, next);
    expect(docsEqual(applyOps(base, ops), next)).toBe(true);
  });
});

describe('applyOps (mirror of the API)', () => {
  it('reorder with after=null moves to the front; unknown after appends', () => {
    const r1 = applyOps(base, [{ op: 'reorder', blockId: 'p2', after: null }]);
    expect(r1.blocks.map((b) => b.id)).toEqual(['p2', 'p1', 'c1']);
    const r2 = applyOps(base, [{ op: 'reorder', blockId: 'p1', after: 'nope' }]);
    expect(r2.blocks.map((b) => b.id)).toEqual(['c1', 'p2', 'p1']);
  });
  it('upsert keeps the existing kind when none is given', () => {
    const r = applyOps(base, [{ op: 'upsert-block', blockId: 'c1', content: { width: 1, height: 1, strokes: [] } }]);
    expect(r.blocks[1]).toEqual({ id: 'c1', kind: 'canvas', content: { width: 1, height: 1, strokes: [] } });
  });
});
