import type { Knex } from '@examos/db';
import type { ApiKeyScope } from '@examos/contracts';
import { randomBytes } from 'node:crypto';
import { randomToken, sha256Hex } from '../../lib/crypto.js';
import { audit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
function keyId(): string {
  const bytes = randomBytes(12);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/**
 * Creates a tenant-scoped integration key. The plaintext is returned exactly
 * once; only its SHA-256 is stored (review §5). Two live keys per connection
 * are allowed so an ERP can rotate without downtime.
 */
export async function createApiKey(
  trx: Knex.Transaction,
  input: { tenantId: string; label: string; scopes: ApiKeyScope[]; expiresAt?: string; allowedIps?: string[]; connectionId?: string | null; createdBy: string | null; env?: 'live' | 'test' },
): Promise<{ id: string; keyId: string; plaintext: string }> {
  if (input.connectionId) {
    const live = await trx('api_keys').where({ tenant_id: input.tenantId, connection_id: input.connectionId }).whereNull('revoked_at').count<{ count: string }[]>('id as count');
    if (Number(live[0]?.count ?? 0) >= 2) throw AppError.conflict('KEY_LIMIT', 'A connection may have at most two live keys; revoke one first');
  }
  const kid = keyId();
  const secret = randomToken(32);
  const plaintext = `exk_${input.env ?? 'live'}_${kid}_${secret}`;
  const [row] = await trx('api_keys')
    .insert({
      tenant_id: input.tenantId,
      connection_id: input.connectionId ?? null,
      label: input.label,
      key_id: kid,
      secret_hash: sha256Hex(secret),
      scopes: input.scopes,
      allowed_ips: input.allowedIps && input.allowedIps.length ? input.allowedIps : null,
      expires_at: input.expiresAt ? new Date(input.expiresAt) : null,
      created_by: input.createdBy,
    })
    .returning('id');
  await audit(trx, { tenantId: input.tenantId, actorType: input.createdBy ? 'USER' : 'PLATFORM', actorId: input.createdBy, action: 'api_key.created', entityType: 'api_key', entityId: row.id, metadata: { label: input.label, scopes: input.scopes, keyId: kid } });
  return { id: row.id, keyId: kid, plaintext };
}

export async function revokeApiKey(trx: Knex.Transaction, tenantId: string, id: string, revokedBy: string): Promise<void> {
  const n = await trx('api_keys').where({ tenant_id: tenantId, id }).whereNull('revoked_at').update({ revoked_at: trx.fn.now() });
  if (!n) throw AppError.notFound('API_KEY_NOT_FOUND');
  await audit(trx, { tenantId, actorType: 'USER', actorId: revokedBy, action: 'api_key.revoked', entityType: 'api_key', entityId: id });
}
