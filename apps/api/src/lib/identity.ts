import type { Knex } from '@examos/db';

/**
 * The ERP identity of a user: the external id that leaves ExamOS in events and
 * result pulls. SSO identities (`oidc:*`) are login handles, never roster keys,
 * so they are excluded; when a tenant has several ERP providers the earliest
 * linked one is used unless a provider is named.
 */
export async function erpIdentity(trx: Knex, tenantId: string, userId: string, provider?: string | null): Promise<{ provider: string; external_id: string } | null> {
  const q = trx('external_identities').where({ tenant_id: tenantId, user_id: userId }).whereNot('provider', 'like', 'oidc:%').orderBy('created_at').select('provider', 'external_id');
  if (provider) q.where('provider', provider);
  const row = await q.first();
  return row ?? null;
}
