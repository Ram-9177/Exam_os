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
