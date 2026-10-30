/**
 * Canonical JSON for content hashing. MUST match the API's `canonicalJson`
 * (apps/api/src/lib/crypto.ts): `JSON.stringify` of the value with object keys
 * sorted recursively, arrays kept in order, no whitespace. Dates are not
 * expected in answer content; they would be serialised by JSON.stringify as
 * ISO strings on both sides.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = sortKeys(src[k]);
    return out;
  }
  return v;
}

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c || !c.subtle) throw new Error('WebCrypto is not available in this context (requires a secure origin)');
  return c.subtle;
}

/** SHA-256 as lowercase hex using WebCrypto. */
export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const buf = await subtle().digest('SHA-256', bytes as BufferSource);
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256OfCanonical(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}
