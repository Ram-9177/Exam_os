import type { RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { withTenantTx, type Knex } from '@examos/db';
import type { AppDeps, TenantContext } from '../types.js';
import { AppError } from '../lib/errors.js';

export function requestContext(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.header('x-request-id');
    const requestId = incoming && /^[A-Za-z0-9._-]{8,128}$/.test(incoming) ? incoming : randomUUID();
    req.ctx = { requestId };
    res.setHeader('x-request-id', requestId);
    next();
  };
}

/**
 * PostgreSQL text cannot hold U+0000: a NUL in a query string, path or JSON string would surface as a 500 from
 * the driver (22021) wherever it reaches a query. Refuse it once, at the edge, as a 400.
 */
const NUL_ESCAPE = Buffer.from('\\u0000');
function containsNul(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('\0');
  if (Array.isArray(value)) return value.some(containsNul);
  if (value && typeof value === 'object') return Object.entries(value).some(([k, v]) => k.includes('\0') || containsNul(v));
  return false;
}
export function rejectNulInJson(_req: unknown, _res: unknown, buf: Buffer): void {
  // Cheap pre-check on the raw bytes; only bodies that spell the escape are parsed again to be exact.
  if (!buf.includes(NUL_ESCAPE)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch {
    return; // the json parser reports malformed bodies itself
  }
  if (containsNul(parsed)) throw AppError.badRequest('INVALID_CHARACTERS', 'Text must not contain NUL characters');
}
export function rejectNulInUrl(): RequestHandler {
  return (req, _res, next) => {
    next(/%00/.test(req.originalUrl) || req.originalUrl.includes('\0') ? AppError.badRequest('INVALID_CHARACTERS', 'The URL must not contain NUL characters') : undefined);
  };
}

/**
 * Tenant resolution for browser/user traffic: the request host is looked up in
 * tenant_domains. API-key traffic resolves its tenant from the key instead
 * (see api-key middleware), and platform routes carry no tenant.
 */
export function resolveTenantByHost(deps: AppDeps): RequestHandler {
  return async (req, _res, next) => {
    try {
      const host = (req.hostname || '').toLowerCase();
      if (!host) throw AppError.notFound('TENANT_NOT_FOUND', 'No tenant for this host');
      const cacheKey = `tenant:host:${host}`;
      const cached = await deps.redis.get(cacheKey);
      let tenant: TenantContext | null = cached ? (JSON.parse(cached) as TenantContext) : null;
      if (!tenant) {
        const row = await deps.db('tenant_domains as d')
          .join('tenants as t', 't.id', 'd.tenant_id')
          .where('d.host', host)
          .where('t.status', 'ACTIVE')
          .select('t.id', 't.slug', 't.name', 't.timezone', 't.group_id as groupId')
          .first();
        if (!row) throw AppError.notFound('TENANT_NOT_FOUND', 'No tenant for this host');
        tenant = { id: row.id, slug: row.slug, name: row.name, timezone: row.timezone, groupId: row.groupId ?? null };
        await deps.redis.set(cacheKey, JSON.stringify(tenant), 'EX', 60);
      }
      req.ctx.tenant = tenant;
      next();
    } catch (e) {
      next(e);
    }
  };
}

export function requireTenant(req: { ctx: { tenant?: TenantContext } }): TenantContext {
  if (!req.ctx.tenant) throw AppError.notFound('TENANT_NOT_FOUND', 'No tenant in context');
  return req.ctx.tenant;
}

/** Convenience: run a tenant-scoped transaction for the current request. */
export function tenantTx<T>(deps: AppDeps, req: { ctx: { tenant?: TenantContext } }, fn: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
  return withTenantTx(deps.db, requireTenant(req).id, fn);
}
