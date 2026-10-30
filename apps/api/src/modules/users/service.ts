import type { Knex } from '@examos/db';
import { STAFF_BUNDLES, USER_TRANSITIONS, assertTransition, type RoleCode, type ScopeType, type StaffBundle } from '@examos/contracts';
import type { AppDeps } from '../../types.js';
import { AppError } from '../../lib/errors.js';
import { randomToken, sha256Hex } from '../../lib/crypto.js';
import { enqueueMail } from '../notifications/service.js';
import { audit } from '../../lib/audit.js';
import { tenantPrimaryHost } from '../tenants/service.js';

export interface CreateUserInput {
  tenantId: string;
  email: string;
  fullName: string;
  kind: 'STUDENT' | 'STAFF';
  externalId?: string;
  provider?: string;
  roles: Array<{ role: RoleCode; scopeType: ScopeType; scopeId: string | null }>;
  bundle?: StaffBundle;
  grantedBy: string | null;
  sendActivation: boolean;
}

/**
 * Creates a user in PENDING_ACTIVATION and, when requested, a single-use
 * activation token delivered through the mail outbox. Never mails a password
 * (spec §4); the stored token is a SHA-256 hash.
 */
export async function createUserWithActivation(deps: AppDeps, trx: Knex.Transaction, input: CreateUserInput): Promise<{ userId: string; activationDispatchId: string | null }> {
  if (input.bundle) {
    if (input.kind !== 'STAFF') throw AppError.unprocessable('ROLE_KIND_MISMATCH', 'Duty bundles are for staff accounts');
    const seen = new Set(input.roles.map((r) => `${r.role}:${r.scopeType}:${r.scopeId}`));
    input = { ...input, roles: [...input.roles, ...bundleRoles(input.bundle).filter((r) => !seen.has(`${r.role}:${r.scopeType}:${r.scopeId}`))] };
  }
  if (input.kind === 'STAFF' && input.roles.length === 0) throw AppError.unprocessable('ROLES_REQUIRED', 'A staff login needs at least one role or a duty bundle');
  if (input.kind === 'STAFF') await assertStaffCapacity(trx, input.tenantId);
  if (input.roles.some((r) => (r.role === 'STUDENT') !== (input.kind === 'STUDENT'))) throw AppError.unprocessable('ROLE_KIND_MISMATCH', 'Student accounts can only hold the student role');
  if (input.kind === 'STUDENT' && input.roles.length === 0) input = { ...input, roles: [{ role: 'STUDENT', scopeType: 'TENANT', scopeId: null }] };
  const email = input.email.toLowerCase();
  const dup = await trx('users').where({ tenant_id: input.tenantId, email }).first('id');
  if (dup) throw AppError.conflict('USER_EXISTS', `A user with ${email} already exists in this tenant`);
  const [u] = await trx('users')
    .insert({ tenant_id: input.tenantId, email, full_name: input.fullName, kind: input.kind, status: input.sendActivation ? 'PENDING_ACTIVATION' : 'ACTIVE' })
    .returning('id');
  const userId = u.id as string;
  if (input.externalId && input.provider) {
    await trx('external_identities').insert({ tenant_id: input.tenantId, user_id: userId, provider: input.provider, external_id: input.externalId });
  }
  for (const r of input.roles) {
    await trx('role_grants').insert({ tenant_id: input.tenantId, user_id: userId, role_code: r.role, scope_type: r.scopeType, scope_id: r.scopeId, granted_by: input.grantedBy });
  }
  if (input.kind === 'STUDENT') {
    await trx('student_profiles').insert({ tenant_id: input.tenantId, user_id: userId });
  }
  await audit(trx, { tenantId: input.tenantId, actorType: input.grantedBy ? 'USER' : 'PLATFORM', actorId: input.grantedBy, action: 'user.created', entityType: 'user', entityId: userId, metadata: { kind: input.kind, roles: input.roles.map((r) => r.role) } });

  let activationDispatchId: string | null = null;
  if (input.sendActivation) {
    activationDispatchId = await issueActivation(deps, trx, { tenantId: input.tenantId, userId, email, fullName: input.fullName });
  }
  return { userId, activationDispatchId };
}

export async function issueActivation(deps: AppDeps, trx: Knex.Transaction, u: { tenantId: string; userId: string; email: string; fullName: string }): Promise<string | null> {
  const token = randomToken(32);
  const ttlHours = deps.config.ACTIVATION_TTL_HOURS;
  const [t] = await trx('one_time_tokens')
    .insert({ tenant_id: u.tenantId, user_id: u.userId, purpose: 'ACTIVATION', token_hash: sha256Hex(token), expires_at: new Date(deps.clock.now().getTime() + ttlHours * 3600_000) })
    .returning('id');
  const host = await tenantPrimaryHost(trx, u.tenantId);
  const tenant = await trx('tenants').where('id', u.tenantId).first('name');
  const { dispatchId } = await enqueueMail(trx, {
    tenantId: u.tenantId,
    category: 'ACCOUNT_ACTIVATION',
    to: { address: u.email, name: u.fullName },
    dedupeKey: `activation:${u.userId}:${t.id}`,
    vars: { fullName: u.fullName, tenantName: tenant?.name ?? 'ExamOS', expiresInHours: ttlHours, activationUrl: `https://${host}/activate?token=${encodeURIComponent(token)}` },
  });
  return dispatchId;
}

/** Tenant-wide role list for a staff duty bundle; the first admin login always keeps TENANT_ADMIN. */
export function bundleRoles(bundle: StaffBundle, withTenantAdmin = false): Array<{ role: RoleCode; scopeType: ScopeType; scopeId: null }> {
  const roles = new Set<RoleCode>(STAFF_BUNDLES[bundle]);
  if (withTenantAdmin) roles.add('TENANT_ADMIN');
  return [...roles].map((role) => ({ role, scopeType: 'TENANT' as const, scopeId: null }));
}

/** Maker-checker on accounts: nobody changes their own duties; the super admin or another admin must. */
function assertNotSelf(actorId: string, targetUserId: string): void {
  if (actorId === targetUserId) throw AppError.forbidden('SELF_ROLE_CHANGE_FORBIDDEN', 'You cannot change your own roles or account status; ask another administrator or the platform super admin');
}

export async function grantRole(trx: Knex.Transaction, input: { tenantId: string; userId: string; role: RoleCode; scopeType: ScopeType; scopeId: string | null; grantedBy: string }): Promise<string> {
  assertNotSelf(input.grantedBy, input.userId);
  const user = await trx('users').where({ id: input.userId, tenant_id: input.tenantId }).first('id', 'kind');
  if (!user) throw AppError.notFound('USER_NOT_FOUND');
  if ((user.kind === 'STUDENT') !== (input.role === 'STUDENT')) throw AppError.unprocessable('ROLE_KIND_MISMATCH', 'Student accounts can only hold the student role');
  const [g] = await trx('role_grants')
    .insert({ tenant_id: input.tenantId, user_id: input.userId, role_code: input.role, scope_type: input.scopeType, scope_id: input.scopeId, granted_by: input.grantedBy })
    .onConflict(trx.raw('(tenant_id, user_id, role_code, scope_type, COALESCE(scope_id, \'00000000-0000-0000-0000-000000000000\'::uuid)) WHERE revoked_at IS NULL'))
    .ignore()
    .returning('id');
  await audit(trx, { tenantId: input.tenantId, actorType: 'USER', actorId: input.grantedBy, action: 'role.granted', entityType: 'user', entityId: input.userId, metadata: { role: input.role, scopeType: input.scopeType, scopeId: input.scopeId } });
  return g?.id ?? 'existing';
}

export async function assertStaffCapacity(trx: Knex.Transaction, tenantId: string, excludingId?: string): Promise<void> {
  const tenant = await trx('tenants').where('id', tenantId).forNoKeyUpdate().first('staff_login_limit');
  const count = await trx('users').where({ tenant_id: tenantId, kind: 'STAFF' }).whereIn('status', ['ACTIVE', 'PENDING_ACTIVATION'])
    .modify((q) => { if (excludingId) q.whereNot('id', excludingId); }).count('* as count').first();
  if (Number(count?.count) >= tenant.staff_login_limit) throw AppError.conflict('STAFF_LOGIN_LIMIT', `This tenant allows ${tenant.staff_login_limit} active staff accounts. Assign multiple roles to an existing staff member.`);
}

export async function revokeRole(trx: Knex.Transaction, input: { tenantId: string; userId: string; role: RoleCode; scopeType: ScopeType; scopeId: string | null; revokedBy: string }): Promise<number> {
  assertNotSelf(input.revokedBy, input.userId);
  const n = await trx('role_grants')
    .where({ tenant_id: input.tenantId, user_id: input.userId, role_code: input.role, scope_type: input.scopeType })
    .modify((qb) => (input.scopeId ? qb.where('scope_id', input.scopeId) : qb.whereNull('scope_id')))
    .whereNull('revoked_at')
    .update({ revoked_at: trx.fn.now(), revoked_by: input.revokedBy });
  await audit(trx, { tenantId: input.tenantId, actorType: 'USER', actorId: input.revokedBy, action: 'role.revoked', entityType: 'user', entityId: input.userId, metadata: { role: input.role, scopeType: input.scopeType, scopeId: input.scopeId, count: n } });
  return n;
}

/**
 * Enables or disables an account. Disabling a staff login frees its seat and
 * revokes every session at once; enabling one re-checks the seat limit (the
 * database trigger is the final arbiter under concurrency).
 */
export async function setUserStatus(trx: Knex.Transaction, input: { tenantId: string; userId: string; status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED' | 'PENDING_ACTIVATION'; actorId: string; reason?: string }): Promise<{ status: string }> {
  assertNotSelf(input.actorId, input.userId);
  const user = await trx('users').where({ id: input.userId, tenant_id: input.tenantId }).forNoKeyUpdate().first('id', 'kind', 'status', 'password_hash');
  if (!user) throw AppError.notFound('USER_NOT_FOUND');
  if (user.status === input.status) return { status: user.status };
  assertTransition('user', USER_TRANSITIONS, user.status, input.status);
  if (input.status === 'ACTIVE' && !user.password_hash) throw AppError.conflict('NOT_ACTIVATED', 'This account has not set a password yet; resend the activation mail instead');
  if (input.status === 'ACTIVE' && user.kind === 'STAFF') await assertStaffCapacity(trx, input.tenantId, user.id);
  await trx('users').where('id', user.id).update({ status: input.status, updated_at: trx.fn.now() });
  if (input.status !== 'ACTIVE') {
    await trx('auth_sessions').where({ tenant_id: input.tenantId, user_id: user.id }).whereNull('revoked_at').update({ revoked_at: trx.fn.now(), revoked_reason: 'account_disabled' });
  }
  await audit(trx, { tenantId: input.tenantId, actorType: 'USER', actorId: input.actorId, action: 'user.status_changed', entityType: 'user', entityId: user.id, metadata: { from: user.status, to: input.status, reason: input.reason ?? null } });
  return { status: input.status };
}

/** Seat usage for the tenant admin screen: who holds the 3–4 staff logins and with which duties. */
export async function staffSeats(trx: Knex.Transaction, tenantId: string) {
  const tenant = await trx('tenants').where('id', tenantId).first('staff_login_limit');
  const staff = await trx('users').where({ tenant_id: tenantId, kind: 'STAFF' }).orderBy('created_at').select('id', 'email', 'full_name as fullName', 'status', 'created_at as createdAt');
  const grants = staff.length ? await trx('role_grants').whereIn('user_id', staff.map((u) => u.id)).whereNull('revoked_at').select('user_id', 'role_code', 'scope_type', 'scope_id') : [];
  const used = staff.filter((u) => ['ACTIVE', 'PENDING_ACTIVATION'].includes(u.status)).length;
  return {
    limit: Number(tenant?.staff_login_limit ?? 4),
    used,
    free: Math.max(0, Number(tenant?.staff_login_limit ?? 4) - used),
    bundles: STAFF_BUNDLES,
    staff: staff.map((u) => ({ ...u, roles: grants.filter((g) => g.user_id === u.id).map((g) => ({ role: g.role_code, scopeType: g.scope_type, scopeId: g.scope_id })) })),
  };
}
