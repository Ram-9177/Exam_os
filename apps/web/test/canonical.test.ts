import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex, sha256OfCanonical } from '@/lib/canonical';
import { contentHash, EMPTY_DOC, type AnswerDoc } from '@/lib/answers';

function nodeSha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** The API's canonicalJson, copied verbatim from apps/api/src/lib/crypto.ts, as the reference. */
function apiCanonicalJson(value: unknown): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sortKeys(value));
}

describe('canonicalJson', () => {
  it('sorts keys recursively and emits no whitespace', () => {
    const v = { z: 1, a: { d: [3, { y: 1, x: 2 }], c: null }, m: 'text' };
    expect(canonicalJson(v)).toBe('{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"m":"text","z":1}');
    expect(canonicalJson(v)).toBe(apiCanonicalJson(v));
  });

  it('keeps array order and primitive encoding identical to JSON.stringify', () => {
    const v = [{ b: 2, a: 1 }, 'x', 3.5, true, null];
    expect(canonicalJson(v)).toBe(JSON.stringify([{ a: 1, b: 2 }, 'x', 3.5, true, null]));
  });

  it('drops undefined values the way JSON.stringify does', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

describe('sha256Hex', () => {
  it('matches node crypto for the reference answer document', async () => {
    const doc: AnswerDoc = { blocks: [{ id: 'b1', kind: 'paragraph', content: 'x' }] };
    const expected = nodeSha256(apiCanonicalJson(doc));
    expect(expected).toMatch(/^[a-f0-9]{64}$/);
    await expect(sha256OfCanonical(doc)).resolves.toBe(expected);
    await expect(contentHash(doc)).resolves.toBe(expected);
  });

  it('hashes the empty document like the API does', async () => {
    await expect(contentHash(EMPTY_DOC)).resolves.toBe(nodeSha256('{"blocks":[]}'));
  });

  it('is key-order independent', async () => {
    const a = await sha256OfCanonical({ blocks: [{ content: 'x', kind: 'paragraph', id: 'b1' }] });
    const b = await sha256OfCanonical({ blocks: [{ id: 'b1', kind: 'paragraph', content: 'x' }] });
    expect(a).toBe(b);
  });

  it('hashes raw strings', async () => {
    await expect(sha256Hex('hello')).resolves.toBe(nodeSha256('hello'));
  });
});
