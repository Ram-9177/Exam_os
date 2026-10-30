import type { RequestHandler, Request } from 'express';
import type { ApiKeyScope } from '@examos/contracts';
import { withTenantTx, withWorkerTx } from '@examos/db';
import type { AppDeps, Principal } from '../types.js';
import { AppError } from '../lib/errors.js';
import { sha256Hex, safeEqual } from '../lib/crypto.js';
import { isIP } from 'node:net';

const KEY_RE = /^exk_(live|test)_([a-z0-9]{12})_([A-Za-z0-9_-]{32,64})$/;

interface ApiKeyRow {
  id: string;
  tenant_id: string;
  connection_id: string | null;
  label: string;
  secret_hash: string;
  scopes: string[];
  allowed_ips: string[] | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  tenant_slug: string;
  tenant_name: string;
  tenant_timezone: string;
  tenant_group_id: string | null;
  tenant_status: string;
}

/**
 * Integration API authentication (review §5). The key id is public and indexes
 * the row; the secret is compared as SHA-256 in constant time. The tenant is
 * taken from the key, so integration routes never depend on the host header.
 *
 * The key lookup itself necessarily runs before a tenant is known, so it is the
 * one request-path query that uses the worker context; it reads a single row
 * by its unique key id and nothing else.
 */
export function requireApiKey(deps: AppDeps, requiredScopes: ApiKeyScope[]): RequestHandler {
  return async (req, _res, next) => {
    try {
      const header = req.header('authorization') ?? '';
      const raw = header.startsWith('Bearer ') ? header.slice(7).trim() : (req.header('x-api-key') ?? '').trim();
      const m = KEY_RE.exec(raw);
      if (!m) throw AppError.unauthorized('API_KEY_INVALID', 'Missing or malformed API key');
      const keyId = m[2]!;
      const secret = m[3]!;

      const found = await withWorkerTx(deps.db, (trx) =>
        trx('api_keys as k')
          .join('tenants as t', 't.id', 'k.tenant_id')
          .where('k.key_id', keyId)
          .select<ApiKeyRow>('k.*', 't.slug as tenant_slug', 't.name as tenant_name', 't.timezone as tenant_timezone', 't.group_id as tenant_group_id', 't.status as tenant_status')
          .first(),
      );
      if (!found || !safeEqual(found.secret_hash, sha256Hex(secret))) throw AppError.unauthorized('API_KEY_INVALID', 'Invalid API key');
      if (found.revoked_at) throw AppError.unauthorized('API_KEY_REVOKED', 'API key revoked');
      if (found.expires_at && new Date(found.expires_at) < deps.clock.now()) throw AppError.unauthorized('API_KEY_EXPIRED', 'API key expired');
      if (found.tenant_status !== 'ACTIVE') throw AppError.forbidden('TENANT_SUSPENDED', 'Tenant suspended');
      if (found.allowed_ips && found.allowed_ips.length > 0) {
        const ip = req.ip ?? '';
        const ok = isIP(ip) !== 0 && found.allowed_ips.some((entry) => entry.split('/')[0] === ip);
        if (!ok) throw AppError.forbidden('IP_NOT_ALLOWED', 'Source address not allowed for this key');
      }
      const scopes = found.scopes as ApiKeyScope[];
      const missing = requiredScopes.filter((s) => !scopes.includes(s));
      if (missing.length) throw AppError.forbidden('SCOPE_MISSING', `API key lacks scope ${missing.join(', ')}`);

      req.ctx.tenant = { id: found.tenant_id, slug: found.tenant_slug, name: found.tenant_name, timezone: found.tenant_timezone, groupId: found.tenant_group_id ?? null };
      const principal: Principal = { type: 'API_KEY', apiKeyId: found.id, label: found.label, scopes, connectionId: found.connection_id ?? null };
      req.ctx.principal = principal;
      await withTenantTx(deps.db, found.tenant_id, (trx) => trx('api_keys').where({ id: found.id }).update({ last_used_at: trx.fn.now() }));
      next();
    } catch (e) {
      next(e);
    }
  };
}

export function apiKeyPrincipal(req: Request): Extract<Principal, { type: 'API_KEY' }> {
  const p = req.ctx.principal;
  if (!p || p.type !== 'API_KEY') throw AppError.unauthorized();
  return p;
}
