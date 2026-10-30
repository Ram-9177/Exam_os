import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function newTotpSecret(): string {
  return [...randomBytes(32)].map((n) => ALPHABET[n & 31]).join('');
}
function decode(secret: string): Buffer {
  let bits = 0, value = 0;
  const bytes: number[] = [];
  for (const c of secret.toUpperCase().replace(/=+$/, '')) {
    const n = ALPHABET.indexOf(c);
    if (n < 0) throw new Error('Invalid TOTP secret');
    value = (value << 5) | n; bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); }
  }
  return Buffer.from(bytes);
}
export function totp(secret: string, step: number): string {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', decode(secret)).update(counter).digest();
  const n = h.readUInt32BE(h[19]! & 15) & 0x7fffffff;
  return String(n % 1_000_000).padStart(6, '0');
}
export function verifyTotp(secret: string, code: string, now: Date, lastStep: number): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const step = Math.floor(now.getTime() / 30_000);
  for (const offset of [0, -1, 1]) {
    const candidate = step + offset;
    if (candidate > lastStep && timingSafeEqual(Buffer.from(totp(secret, candidate)), Buffer.from(code))) return candidate;
  }
  return null;
}
