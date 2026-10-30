import type { RequestHandler } from 'express';
import { withTenantTx } from '@examos/db';
import type { AppDeps } from '../types.js';
import { AppError } from '../lib/errors.js';
import { canonicalJson, sha256Hex } from '../lib/crypto.js';

const TTL_HOURS = 24;

/**
 * Idempotency for integration batch writes (review §5): the same key with the
 * same body replays the stored response; the same key with a different body
 * is 409. Scope = the API key (or user) that sent it.
 */
export function idempotent(deps: AppDeps): RequestHandler {
  return async (req, res, next) => {
    try {
      const key = req.header('idempotency-key');
      if (!key || key.length < 8 || key.length > 128) throw AppError.badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header (8–128 chars) is required');
      const tenant = req.ctx.tenant;
      const p = req.ctx.principal;
      if (!tenant || !p) throw AppError.unauthorized();
      const scope = p.type === 'API_KEY' ? `apikey:${p.apiKeyId}` : p.type === 'USER' ? `user:${p.userId}` : 'platform';
      const requestHash = sha256Hex(`${req.method} ${req.path} ${canonicalJson(req.body ?? null)}`);
      const existing = await withTenantTx(deps.db, tenant.id, (trx) => trx('idempotency_keys').where({ tenant_id: tenant.id, scope, key }).first());
      if (existing) {
        if (existing.request_hash !== requestHash) throw AppError.conflict('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different request body');
        if (existing.response_status) {
          res.setHeader('idempotent-replayed', 'true');
          res.status(existing.response_status).json(existing.response_body);
          return;
        }
        throw AppError.conflict('REQUEST_IN_FLIGHT', 'A request with this Idempotency-Key is still being processed');
      }
      await withTenantTx(deps.db, tenant.id, (trx) =>
        trx('idempotency_keys').insert({ tenant_id: tenant.id, scope, key, request_hash: requestHash, expires_at: new Date(deps.clock.now().getTime() + TTL_HOURS * 3600_000) }).onConflict(['tenant_id', 'scope', 'key']).ignore(),
      );
      const originalJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        const status = res.statusCode;
        void withTenantTx(deps.db, tenant.id, (trx) => trx('idempotency_keys').where({ tenant_id: tenant.id, scope, key }).update({ response_status: status, response_body: JSON.stringify(body) })).catch((e) => deps.logger.warn({ err: e }, 'idempotency store failed'));
        return originalJson(body);
      }) as typeof res.json;
      next();
    } catch (e) {
      next(e);
    }
  };
}
