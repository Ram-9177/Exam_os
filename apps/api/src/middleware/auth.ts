import type { RequestHandler, Request } from 'express';
import { ROLE_PERMISSIONS, PRIVILEGED_MFA_ROLES, type Permission, type RoleCode, type ScopeType } from '@examos/contracts';
import type { AppDeps, Grant, Principal } from '../types.js';
import { AppError } from '../lib/errors.js';
import type { JwtService } from '../modules/auth/jwt.js';
import { withTenantTx } from '@examos/db';
import { verifyTotp } from '../modules/platform/totp.js';

export interface AuthDeps {
  deps: AppDeps;
  jwt: JwtService;
}

/**
 * Authenticates a user bearer token and loads the user's active grants for the
 * resolved tenant on every request. A token whose `tid` does not match the host
 * tenant is rejected (review §4). A revoked grant takes effect on the next
 * request because nothing authorisation-related is cached in the token.
 */
export function requireUser({ deps, jwt }: AuthDeps): RequestHandler {
  return async (req, _res, next) => {
    try {
      const tenant = req.ctx.tenant;
      if (!tenant) throw AppError.notFound('TENANT_NOT_FOUND', 'No tenant in context');
      const header = req.header('authorization') ?? '';
      // Bearer header only: a token in a URL ends up in access logs, history and Referer headers.
      const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      if (!token) throw AppError.unauthorized();
      let claims;
      try {
        claims = await jwt.verifyAccessToken(token);
      } catch {
        throw AppError.unauthorized('TOKEN_INVALID', 'Invalid or expired token');
      }
      if (claims.tid !== tenant.id) throw AppError.unauthorized('TENANT_MISMATCH', 'Token not issued for this tenant');

      const revokedFamily = await deps.redis.get(`auth:family-revoked:${claims.sfm}`);
      if (revokedFamily) throw AppError.unauthorized('SESSION_REVOKED', 'Session revoked');

      const principal = await withTenantTx(deps.db, tenant.id, async (trx) => {
        const tenantRow = await trx('tenants').where('id', tenant.id).first('sessions_revoked_at');
        const user = await trx('users').where({ id: claims.sub, tenant_id: tenant.id }).first();
        if (!user || user.status !== 'ACTIVE') return null;
        const family = await trx('auth_sessions').where({ family_id: claims.sfm }).whereNull('revoked_at').first('id', 'issued_at');
        if (!family) return null;
        if (tenantRow?.sessions_revoked_at && new Date(family.issued_at) <= new Date(tenantRow.sessions_revoked_at)) {
          return null;
        }
        const grants = await trx('role_grants')
          .where({ tenant_id: tenant.id, user_id: user.id })
          .whereNull('revoked_at')
          .where('effective_from', '<=', trx.fn.now())
          .andWhere((qb) => qb.whereNull('effective_until').orWhere('effective_until', '>', trx.fn.now()))
          .select('role_code', 'scope_type', 'scope_id');
        const p: Principal = {
          type: 'USER',
          userId: user.id,
          kind: user.kind,
          email: user.email,
          sessionFamilyId: claims.sfm,
          grants: grants.map((g) => ({ role: g.role_code as RoleCode, scopeType: g.scope_type as ScopeType, scopeId: g.scope_id ?? null })),
        };
        return p;
      });
      if (!principal) throw AppError.unauthorized('SESSION_REVOKED', 'Session or account no longer valid');
      req.ctx.principal = principal;
      next();
    } catch (e) {
      next(e);
    }
  };
}

export interface ScopeTarget {
  examId?: string;
  departmentId?: string;
  courseId?: string;
}

export function grantsAllow(grants: Grant[], permission: Permission, target: ScopeTarget = {}): boolean {
  for (const g of grants) {
    const perms = ROLE_PERMISSIONS[g.role];
    if (!perms || !perms.includes(permission)) continue;
    if (g.scopeType === 'TENANT' || g.scopeType === 'TENANT_GROUP') return true;
    if (g.scopeType === 'EXAM' && target.examId && g.scopeId === target.examId) return true;
    if (g.scopeType === 'DEPARTMENT' && target.departmentId && g.scopeId === target.departmentId) return true;
    if (g.scopeType === 'COURSE' && target.courseId && g.scopeId === target.courseId) return true;
  }
  return false;
}

/** Which departments a person may read under `permission`: everything, a list, or nothing. */
export function departmentScopeOf(grants: Grant[], permission: Permission): 'ALL' | 'NONE' | string[] {
  const ids: string[] = [];
  for (const g of grants) {
    if (!ROLE_PERMISSIONS[g.role]?.includes(permission)) continue;
    if (g.scopeType === 'TENANT' || g.scopeType === 'TENANT_GROUP') return 'ALL';
    if (g.scopeType === 'DEPARTMENT' && g.scopeId) ids.push(g.scopeId);
  }
  return ids.length ? ids : 'NONE';
}

/**
 * Permission gate. `targetOf` lets a route scope the check to the exam or
 * department named in the request (RBAC + scoped ABAC, spec §3).
 */
export function requirePermission(permission: Permission, targetOf?: (req: Request) => ScopeTarget): RequestHandler {
  return (req, _res, next) => {
    const p = req.ctx.principal;
    if (!p || p.type !== 'USER') return next(AppError.unauthorized());
    const target = targetOf ? targetOf(req) : {};
    if (!grantsAllow(p.grants, permission, target)) return next(AppError.forbidden('PERMISSION_DENIED', `Missing permission ${permission}`));
    req.ctx.permission = permission;
    next();
  };
}

export function userPrincipal(req: Request): Extract<Principal, { type: 'USER' }> {
  const p = req.ctx.principal;
  if (!p || p.type !== 'USER') throw AppError.unauthorized();
  return p;
}

/**
 * Step-up MFA verification: privileged operations (results publication, security
 * waiver override, and script exports) require a fresh 6-digit TOTP code passed
 * via the `x-mfa-code` header (or request body `mfaCode`).
 */
export function requireStepUpMfa(deps: AppDeps): RequestHandler {
  return async (req, _res, next) => {
    try {
      const p = req.ctx.principal;
      if (!p || p.type !== 'USER') return next();

      const isPrivileged = p.grants.some((g) => PRIVILEGED_MFA_ROLES.includes(g.role as any));
      if (!isPrivileged) return next();

      const tenantId = req.ctx.tenant!.id;
      const user = await withTenantTx(deps.db, tenantId, async (trx) => {
        return trx('users').where({ id: p.userId, tenant_id: tenantId }).first();
      });

      // If user has not enabled TOTP MFA on their account yet, allow request;
      // if TOTP MFA is enabled, strictly require and verify step-up code.
      if (!user || !user.totp_enabled || !user.totp_secret_ref) {
        return next();
      }

      const code = req.header('x-mfa-code') ?? (req.body as Record<string, any> | undefined)?.['mfaCode'];
      if (!code || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
        throw AppError.forbidden('MFA_STEP_UP_REQUIRED', 'Step-up multi-factor authentication (TOTP) is required for this operation');
      }

      const secret = await deps.secrets.resolve(user.totp_secret_ref);
      const step = verifyTotp(secret, code, deps.clock.now(), Number(user.totp_last_step ?? -1));
      if (step === null) {
        throw AppError.forbidden('MFA_CODE_INVALID', 'Invalid or replayed two-factor authentication code');
      }

      await withTenantTx(deps.db, tenantId, async (trx) => {
        await trx('users').where('id', user.id).update({ totp_last_step: step });
      });

      next();
    } catch (err) {
      next(err);
    }
  };
}
