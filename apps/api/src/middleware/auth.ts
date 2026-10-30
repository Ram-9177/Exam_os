import type { RequestHandler, Request } from 'express';
import { ROLE_PERMISSIONS, type Permission, type RoleCode, type ScopeType } from '@examos/contracts';
import type { AppDeps, Grant, Principal } from '../types.js';
import { AppError } from '../lib/errors.js';
import type { JwtService } from '../modules/auth/jwt.js';
import { withTenantTx } from '@examos/db';

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
        const user = await trx('users').where({ id: claims.sub, tenant_id: tenant.id }).first();
        if (!user || user.status !== 'ACTIVE') return null;
        const family = await trx('auth_sessions').where({ family_id: claims.sfm }).whereNull('revoked_at').first('id');
        if (!family) return null;
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
