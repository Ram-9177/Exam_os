import { assertClientSuppliedRef } from '../../lib/secrets.js';
import { withTenantTx, type Knex } from '@examos/db';
import type { z } from 'zod';
import type { TenantCreateSchema, TenantMailConfigSchema } from '@examos/contracts';
import type { AppDeps } from '../../types.js';
import { AppError } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { bundleRoles, createUserWithActivation } from '../users/service.js';

type TenantCreate = z.infer<typeof TenantCreateSchema>;
type TenantMailConfig = z.infer<typeof TenantMailConfigSchema>;

/**
 * Tenant provisioning (review §4): a migration-free admin action that creates
 * the tenant, its domains, the first TENANT_ADMIN user and the activation mail.
 * Platform tables (tenants, tenant_domains) are not RLS-protected; everything
 * tenant-scoped is created inside a tenant transaction.
 */
export async function provisionTenant(deps: AppDeps, input: TenantCreate, requestId: string): Promise<{ tenantId: string; adminUserId: string }> {
  // 1. platform-level rows
  const tenantId = await deps.db.transaction(async (trx) => {
    let groupId: string | null = null;
    if (input.groupCode) {
      const g = await trx('tenant_groups').where('code', input.groupCode).first('id');
      if (!g) throw AppError.unprocessable('GROUP_NOT_FOUND', `Tenant group ${input.groupCode} does not exist`);
      groupId = g.id;
    }
    const exists = await trx('tenants').where('slug', input.slug).first('id');
    if (exists) throw AppError.conflict('TENANT_EXISTS', `Tenant ${input.slug} already exists`);
    const [t] = await trx('tenants').insert({ slug: input.slug, name: input.name, group_id: groupId, timezone: input.timezone, staff_login_limit: input.staffLoginLimit ?? 4 }).returning('id');
    const domains = input.domains.length ? input.domains : [`${input.slug}.examos.local`];
    for (const [i, host] of domains.entries()) {
      await trx('tenant_domains').insert({ tenant_id: t.id, host, is_primary: i === 0 });
    }
    return t.id as string;
  });

  // 2. tenant-scoped rows
  const adminUserId = await withTenantTx(deps.db, tenantId, async (trx) => {
    const { userId } = await createUserWithActivation(deps, trx, {
      tenantId,
      email: input.adminEmail,
      fullName: input.adminFullName,
      kind: 'STAFF',
      // The super admin decides the first admin's duties; a tenant admin can never grant roles to themselves later.
      roles: bundleRoles(input.adminBundle ?? 'ADMIN_CONTROLLER', true),
      grantedBy: null,
      sendActivation: true,
    });
    await audit(trx, { tenantId, actorType: 'PLATFORM', actorId: null, action: 'tenant.provisioned', entityType: 'tenant', entityId: tenantId, requestId, metadata: { slug: input.slug, domains: input.domains, staffLoginLimit: input.staffLoginLimit ?? 4, adminBundle: input.adminBundle ?? 'ADMIN_CONTROLLER' } });
    return userId;
  });
  return { tenantId, adminUserId };
}

export async function upsertMailConfig(
  deps: AppDeps,
  trx: Knex.Transaction,
  tenantId: string,
  actorUserId: string,
  input: TenantMailConfig & { category?: string | null; endpointSecret?: string; tokenSecret?: string; callbackSecret?: string },
): Promise<void> {
  if (input.transportKind === 'capture' && deps.config.isProduction) throw AppError.unprocessable('TRANSPORT_NOT_ALLOWED', 'capture transport is not allowed in production');
  assertClientSuppliedRef(input.endpointRef, 'endpointRef');
  assertClientSuppliedRef(input.tokenRef, 'tokenRef');
  assertClientSuppliedRef(input.callbackSecretRef, 'callbackSecretRef');
  const endpointRef = input.endpointSecret ? deps.secrets.seal(input.endpointSecret) : (input.endpointRef ?? null);
  const tokenRef = input.tokenSecret ? deps.secrets.seal(input.tokenSecret) : (input.tokenRef ?? null);
  const callbackSecretRef = input.callbackSecret ? deps.secrets.seal(input.callbackSecret) : (input.callbackSecretRef ?? null);
  if (input.transportKind === 'power-automate' && !endpointRef) throw AppError.unprocessable('ENDPOINT_REQUIRED', 'power-automate transport requires the flow endpoint (as a secret or a vault reference)');

  const category = input.category ?? null;
  const existing = await trx('tenant_mail_configs').where('tenant_id', tenantId).andWhere((qb) => (category ? qb.where('category', category) : qb.whereNull('category'))).first('id');
  const row = {
    tenant_id: tenantId,
    category,
    transport_kind: input.transportKind,
    sender_address: input.senderAddress,
    sender_name: input.senderName,
    endpoint_ref: endpointRef,
    token_ref: tokenRef,
    callback_secret_ref: callbackSecretRef,
    settings: JSON.stringify(input.settings ?? {}),
    updated_at: trx.fn.now(),
  };
  if (existing) await trx('tenant_mail_configs').where('id', existing.id).update(row);
  else await trx('tenant_mail_configs').insert(row);
  await audit(trx, { tenantId, actorType: 'USER', actorId: actorUserId, action: 'tenant.mail_config.upserted', entityType: 'tenant_mail_config', entityId: null, metadata: { transportKind: input.transportKind, senderAddress: input.senderAddress, category } });
}

export async function tenantPrimaryHost(trx: Knex, tenantId: string): Promise<string> {
  const d = await trx('tenant_domains').where({ tenant_id: tenantId }).orderBy('is_primary', 'desc').first('host');
  return d?.host ?? 'examos.local';
}
