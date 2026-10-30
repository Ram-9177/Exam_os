import { Router } from 'express';
import { z } from 'zod';
import {
  TenantMailConfigSchema,
  ApiKeyCreateSchema,
  WebhookEndpointCreateSchema,
  UserCreateSchema,
  UserStatusSchema,
  ROLE_CODES,
  SCOPE_TYPES,
  ErpConnectionCreateSchema,
  ErpConnectionUpdateSchema,
  ErpSyncRequestSchema,
  XlsxPreviewRequestSchema,
  XlsxImportRequestSchema,
  MailBounceReconcileSchema,
} from '@examos/contracts';
import type { AppDeps } from '../../types.js';
import { asyncHandler, validateBody, body, uuidParam } from '../../lib/http.js';
import { AppError } from '../../lib/errors.js';
import { requireTenant, tenantTx } from '../../middleware/request-context.js';
import { requireUser, requirePermission, userPrincipal } from '../../middleware/auth.js';
import type { JwtService } from '../auth/jwt.js';
import { upsertMailConfig } from './service.js';
import { createApiKey, revokeApiKey } from '../integration/api-keys.js';
import { createWebhookEndpoint, disableWebhookEndpoint, replayDelivery } from '../integration/webhooks.js';
import {
  createErpConnection,
  listErpConnections,
  getErpConnection,
  updateErpConnection,
  executeErpSync,
} from '../integration/sync-service.js';
import { generateTemplate, previewRosterImport, executeRosterImport } from '../integration/csv-importer.js';
import { getMailHealthMetrics } from '../notifications/health.js';
import { reconcileBounce } from '../notifications/bounce.js';
import { createUserWithActivation, grantRole, revokeRole, setUserStatus, staffSeats } from '../users/service.js';
import { audit } from '../../lib/audit.js';

const MailConfigBody = TenantMailConfigSchema.extend({
  category: z.string().max(64).nullable().optional(),
  endpointSecret: z.string().max(4000).optional(),
  tokenSecret: z.string().max(4000).optional(),
  callbackSecret: z.string().max(4000).optional(),
});
const SsoConfigBody = z.object({
  provider: z.enum(['entra', 'google', 'generic']).default('entra'),
  issuer: z.string().url(),
  clientId: z.string().min(1).max(200),
  clientSecret: z.string().max(4000).optional(),
  clientSecretRef: z.string().max(200).optional(),
  allowedEmailDomains: z.array(z.string().min(3)).default([]),
  enabled: z.boolean().default(true),
});
const UserStatusBody = UserStatusSchema.extend({ reason: z.string().trim().max(500).optional() });
const RoleBody = z.object({ role: z.enum(ROLE_CODES), scopeType: z.enum(SCOPE_TYPES).default('TENANT'), scopeId: z.string().uuid().nullable().default(null) });

/** Tenant administration: users, roles, mail, SSO, integration keys and webhooks. */
export function tenantAdminRoutes(deps: AppDeps, jwt: JwtService): Router {
  const r = Router();
  const user = requireUser({ deps, jwt });

  r.get(
    '/',
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const sso = await tenantTx(deps, req, (trx) => trx('tenant_sso_configs').where({ tenant_id: t.id, enabled: true }).first('provider'));
      res.json({ id: t.id, slug: t.slug, name: t.name, timezone: t.timezone, ssoProvider: sso?.provider ?? null });
    }),
  );

  r.post(
    '/users',
    user,
    requirePermission('users:write'),
    validateBody(UserCreateSchema),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const input = body<typeof UserCreateSchema>(req);
      const out = await tenantTx(deps, req, (trx) =>
        createUserWithActivation(deps, trx, { tenantId: t.id, email: input.email, fullName: input.fullName, kind: input.kind, externalId: input.externalId, provider: input.provider, roles: input.roles.map((x) => ({ role: x.role, scopeType: x.scopeType, scopeId: x.scopeId ?? null })), bundle: input.bundle, grantedBy: p.userId, sendActivation: input.sendActivation }),
      );
      res.status(201).json(out);
    }),
  );
  r.get(
    '/users',
    user,
    requirePermission('users:read'),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const q = String(req.query['q'] ?? '').trim().toLowerCase();
      const kind = String(req.query['kind'] ?? '');
      const rows = await tenantTx(deps, req, (trx) =>
        trx('users as u')
          .leftJoin('student_profiles as sp', 'sp.user_id', 'u.id')
          .where('u.tenant_id', t.id)
          .modify((qb) => {
            if (q) qb.andWhere((w) => w.whereILike('u.email', `%${q}%`).orWhereILike('u.full_name', `%${q}%`).orWhereILike('sp.register_number', `%${q}%`));
            if (kind) qb.where('u.kind', kind);
          })
          .select('u.id', 'u.email', 'u.full_name as fullName', 'u.kind', 'u.status', 'sp.register_number as registerNumber', 'u.created_at as createdAt')
          .orderBy('u.full_name')
          .limit(200),
      );
      res.json({ users: rows });
    }),
  );
  r.get(
    '/staff-seats',
    user,
    requirePermission('users:read'),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      res.json(await tenantTx(deps, req, (trx) => staffSeats(trx, t.id)));
    }),
  );
  r.patch(
    '/users/:id/status',
    user,
    requirePermission('users:write'),
    validateBody(UserStatusBody),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const input = body<typeof UserStatusBody>(req);
      res.json(await tenantTx(deps, req, (trx) => setUserStatus(trx, { tenantId: t.id, userId: uuidParam(req, 'id'), status: input.status, actorId: p.userId, reason: input.reason })));
    }),
  );
  r.post(
    '/users/:id/roles',
    user,
    requirePermission('users:write'),
    validateBody(RoleBody),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const input = body<typeof RoleBody>(req);
      const id = await tenantTx(deps, req, (trx) => grantRole(trx, { tenantId: t.id, userId: uuidParam(req, 'id'), role: input.role, scopeType: input.scopeType, scopeId: input.scopeId, grantedBy: p.userId }));
      res.status(201).json({ grantId: id });
    }),
  );
  r.delete(
    '/users/:id/roles',
    user,
    requirePermission('users:write'),
    validateBody(RoleBody),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const input = body<typeof RoleBody>(req);
      const n = await tenantTx(deps, req, (trx) => revokeRole(trx, { tenantId: t.id, userId: uuidParam(req, 'id'), role: input.role, scopeType: input.scopeType, scopeId: input.scopeId, revokedBy: p.userId }));
      res.json({ revoked: n });
    }),
  );

  r.put(
    '/mail-config',
    user,
    requirePermission('mail:manage'),
    validateBody(MailConfigBody),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      await tenantTx(deps, req, (trx) => upsertMailConfig(deps, trx, t.id, p.userId, body<typeof MailConfigBody>(req)));
      res.status(204).end();
    }),
  );
  r.get(
    '/mail-dispatches',
    user,
    requirePermission('mail:manage'),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const rows = await tenantTx(deps, req, (trx) => trx('mail_dispatches').where('tenant_id', t.id).orderBy('created_at', 'desc').limit(200).select('id', 'category', 'lane', 'to_address as toAddress', 'subject', 'status', 'attempt_count as attemptCount', 'transport_kind as transportKind', 'last_error as lastError', 'created_at as createdAt', 'accepted_at as acceptedAt'));
      res.json({ dispatches: rows });
    }),
  );

  r.put(
    '/sso-config',
    user,
    requirePermission('tenant:manage'),
    validateBody(SsoConfigBody),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const input = body<typeof SsoConfigBody>(req);
      await tenantTx(deps, req, async (trx) => {
        const secretRef = input.clientSecret ? deps.secrets.seal(input.clientSecret) : (input.clientSecretRef ?? null);
        await trx('tenant_sso_configs').insert({ tenant_id: t.id, provider: input.provider, issuer: input.issuer, client_id: input.clientId, client_secret_ref: secretRef, allowed_email_domains: input.allowedEmailDomains, enabled: input.enabled }).onConflict('tenant_id').merge({ provider: input.provider, issuer: input.issuer, client_id: input.clientId, client_secret_ref: secretRef, allowed_email_domains: input.allowedEmailDomains, enabled: input.enabled, updated_at: trx.fn.now() });
        await audit(trx, { tenantId: t.id, actorType: 'USER', actorId: p.userId, action: 'tenant.sso_config.upserted', entityType: 'tenant', entityId: t.id, metadata: { provider: input.provider, issuer: input.issuer } });
      });
      res.status(204).end();
    }),
  );

  r.post(
    '/api-keys',
    user,
    requirePermission('integration:manage'),
    validateBody(ApiKeyCreateSchema.extend({ connectionId: z.string().uuid().nullable().optional(), env: z.enum(['live', 'test']).default('live') })),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const input = body<typeof ApiKeyCreateSchema>(req) as z.infer<typeof ApiKeyCreateSchema> & { connectionId?: string | null; env: 'live' | 'test' };
      const out = await tenantTx(deps, req, (trx) => createApiKey(trx, { tenantId: t.id, label: input.label, scopes: input.scopes, expiresAt: input.expiresAt, allowedIps: input.allowedIps, connectionId: input.connectionId ?? null, createdBy: p.userId, env: input.env }));
      res.status(201).json({ id: out.id, keyId: out.keyId, apiKey: out.plaintext, note: 'Store this key now; it is not retrievable later.' });
    }),
  );
  r.get(
    '/api-keys',
    user,
    requirePermission('integration:manage'),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const rows = await tenantTx(deps, req, (trx) => trx('api_keys').where('tenant_id', t.id).orderBy('created_at', 'desc').select('id', 'label', 'key_id as keyId', 'scopes', 'expires_at as expiresAt', 'last_used_at as lastUsedAt', 'revoked_at as revokedAt', 'created_at as createdAt'));
      res.json({ apiKeys: rows });
    }),
  );
  r.get(
    '/webhooks',
    user,
    requirePermission('integration:manage'),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const rows = await tenantTx(deps, req, (trx) => trx('webhook_endpoints').where('tenant_id', t.id).orderBy('created_at', 'desc').select('id', 'url', 'description', 'event_types as eventTypes', 'status', 'created_at as createdAt'));
      res.json({ webhooks: rows });
    }),
  );
  r.get(
    '/users/:id/roles',
    user,
    requirePermission('users:read'),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const rows = await tenantTx(deps, req, (trx) => trx('role_grants').where({ tenant_id: t.id, user_id: uuidParam(req, 'id') }).whereNull('revoked_at').select('id', 'role_code as role', 'scope_type as scopeType', 'scope_id as scopeId', 'effective_from as effectiveFrom', 'effective_until as effectiveUntil'));
      res.json({ roles: rows });
    }),
  );
  r.delete(
    '/api-keys/:id',
    user,
    requirePermission('integration:manage'),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      await tenantTx(deps, req, (trx) => revokeApiKey(trx, t.id, uuidParam(req, 'id'), p.userId));
      res.status(204).end();
    }),
  );
  r.post(
    '/webhooks',
    user,
    requirePermission('integration:manage'),
    validateBody(WebhookEndpointCreateSchema),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const input = body<typeof WebhookEndpointCreateSchema>(req);
      const out = await tenantTx(deps, req, (trx) => createWebhookEndpoint(deps, trx, { tenantId: t.id, url: input.url, description: input.description, eventTypes: input.eventTypes, createdBy: p.userId }));
      res.status(201).json({ id: out.id, signingSecret: out.secret, note: 'Store this secret now; it is not retrievable later.' });
    }),
  );
  r.delete(
    '/webhooks/:id',
    user,
    requirePermission('integration:manage'),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      await tenantTx(deps, req, (trx) => disableWebhookEndpoint(trx, t.id, uuidParam(req, 'id'), p.userId));
      res.status(204).end();
    }),
  );
  r.get(
    '/webhooks/deliveries',
    user,
    requirePermission('integration:manage'),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const rows = await tenantTx(deps, req, (trx) => trx('webhook_deliveries as d').join('webhook_endpoints as e', 'e.id', 'd.endpoint_id').where('d.tenant_id', t.id).orderBy('d.created_at', 'desc').limit(200).select('d.id', 'd.event_type as eventType', 'd.status', 'd.attempts', 'd.last_status_code as lastStatusCode', 'd.last_error as lastError', 'd.next_attempt_at as nextAttemptAt', 'd.delivered_at as deliveredAt', 'e.url'));
      res.json({ deliveries: rows });
    }),
  );
  r.post(
    '/webhooks/deliveries/:id/replay',
    user,
    requirePermission('integration:manage'),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      await tenantTx(deps, req, (trx) => replayDelivery(trx, t.id, uuidParam(req, 'id'), p.userId));
      res.status(202).end();
    }),
  );
  r.get(
    '/audit',
    user,
    requirePermission('audit:read'),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const rows = await tenantTx(deps, req, (trx) => trx('audit_events').where('tenant_id', t.id).orderBy('seq', 'desc').limit(500));
      res.json({ events: rows });
    }),
  );

  // ---------------------------------------------------------------- Phase 7: ERP Connections
  r.post(
    '/erp-connections',
    user,
    requirePermission('integration:manage'),
    validateBody(ErpConnectionCreateSchema),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const input = body<typeof ErpConnectionCreateSchema>(req);
      const result = await tenantTx(deps, req, (trx) =>
        createErpConnection(deps, trx, t.id, input, p.userId),
      );
      res.status(201).json(result);
    }),
  );

  r.get(
    '/erp-connections',
    user,
    requirePermission('integration:manage'),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const rows = await tenantTx(deps, req, (trx) => listErpConnections(trx, t.id));
      res.json({ connections: rows });
    }),
  );

  r.get(
    '/erp-connections/:id',
    user,
    requirePermission('integration:manage'),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const conn = await tenantTx(deps, req, (trx) => getErpConnection(trx, t.id, uuidParam(req, 'id')));
      const { credential_ref, webhook_secret_ref, ...safe } = conn;
      res.json({ connection: safe });
    }),
  );

  r.put(
    '/erp-connections/:id',
    user,
    requirePermission('integration:manage'),
    validateBody(ErpConnectionUpdateSchema),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const input = body<typeof ErpConnectionUpdateSchema>(req);
      await tenantTx(deps, req, (trx) =>
        updateErpConnection(deps, trx, t.id, uuidParam(req, 'id'), input, p.userId),
      );
      res.status(204).end();
    }),
  );

  r.post(
    '/erp-connections/:id/sync',
    user,
    requirePermission('integration:manage'),
    validateBody(ErpSyncRequestSchema),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const input = body<typeof ErpSyncRequestSchema>(req);
      const result = await tenantTx(deps, req, (trx) =>
        executeErpSync(deps, trx, t.id, uuidParam(req, 'id'), input, p.userId),
      );
      res.json(result);
    }),
  );

  r.get(
    '/erp-connections/:id/jobs',
    user,
    requirePermission('integration:manage'),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const rows = await tenantTx(deps, req, (trx) =>
        trx('roster_sync_jobs')
          .where({ tenant_id: t.id, connection_id: uuidParam(req, 'id') })
          .orderBy('started_at', 'desc')
          .limit(100),
      );
      res.json({ jobs: rows });
    }),
  );

  // ---------------------------------------------------------------- Phase 7: Mail Health & Bounces
  r.get(
    '/mail/health',
    user,
    requirePermission('mail:manage'),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const metrics = await tenantTx(deps, req, (trx) => getMailHealthMetrics(trx, t.id));
      res.json(metrics);
    }),
  );

  r.post(
    '/mail/bounces',
    user,
    requirePermission('mail:manage'),
    validateBody(MailBounceReconcileSchema),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const input = body<typeof MailBounceReconcileSchema>(req);
      const result = await tenantTx(deps, req, (trx) =>
        reconcileBounce(deps, trx, t.id, input, p.userId),
      );
      res.json(result);
    }),
  );

  // ---------------------------------------------------------------- Phase 7: Staff CSV/XLSX Ingestion
  r.get(
    '/roster/templates/:entity',
    user,
    requirePermission('roster:read'),
    asyncHandler(async (req, res) => {
      const entityParam = req.params['entity']?.toUpperCase();
      if (!['PERSON', 'ACADEMIC_UNIT', 'COURSE', 'ENROLLMENT'].includes(entityParam ?? '')) {
        throw AppError.badRequest('INVALID_ENTITY', 'Valid entities are PERSON, ACADEMIC_UNIT, COURSE, ENROLLMENT');
      }
      const template = generateTemplate(entityParam as 'PERSON' | 'ACADEMIC_UNIT' | 'COURSE' | 'ENROLLMENT');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="template-${entityParam?.toLowerCase()}.csv"`);
      res.send(template);
    }),
  );

  r.post(
    '/roster/preview',
    user,
    requirePermission('roster:write'),
    validateBody(XlsxPreviewRequestSchema),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const input = body<typeof XlsxPreviewRequestSchema>(req);
      const result = await tenantTx(deps, req, (trx) =>
        previewRosterImport(deps, trx, t.id, input.entity, input.csvContent, input.mode, input.provider),
      );
      res.json(result);
    }),
  );

  r.post(
    '/roster/import',
    user,
    requirePermission('roster:write'),
    validateBody(XlsxImportRequestSchema),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const input = body<typeof XlsxImportRequestSchema>(req);
      const result = await tenantTx(deps, req, (trx) =>
        executeRosterImport(
          deps,
          trx,
          t.id,
          input.entity,
          input.csvContent,
          input.mode,
          input.provider,
          p.userId,
          input.sourceLabel,
        ),
      );
      res.json(result);
    }),
  );

  r.get(
    '/roster/sync-jobs',
    user,
    requirePermission('roster:read'),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const source = req.query['source'] ? String(req.query['source']) : undefined;
      const rows = await tenantTx(deps, req, (trx) =>
        trx('roster_sync_jobs')
          .where('tenant_id', t.id)
          .modify((qb) => {
            if (source) qb.where('source', source);
          })
          .orderBy('started_at', 'desc')
          .limit(100),
      );
      res.json({ jobs: rows });
    }),
  );

  return r;
}
