import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import {
  PersonBatchSchema,
  AcademicUnitBatchSchema,
  CourseBatchSchema,
  EnrollmentBatchSchema,
  MailCallbackSchema,
  EventsFeedQuerySchema,
  WebhookEndpointCreateSchema,
  XlsxPreviewRequestSchema,
  XlsxImportRequestSchema,
  MailBounceReconcileSchema,
} from '@examos/contracts';
import type { AppDeps } from '../../types.js';
import { asyncHandler, validateBody, body, validateQuery, query, uuidParam } from '../../lib/http.js';
import { requireApiKey, apiKeyPrincipal } from '../../middleware/api-key.js';
import { idempotent } from '../../middleware/idempotency.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { requireTenant, tenantTx } from '../../middleware/request-context.js';
import { upsertPersons, upsertAcademicUnits, upsertCourses, upsertEnrollments, type RosterActor } from './roster.js';
import { readEventFeed } from './events.js';
import { applyMailCallback } from '../notifications/worker.js';
import { createWebhookEndpoint } from './webhooks.js';
import { generateTemplate, previewRosterImport, executeRosterImport } from './csv-importer.js';
import { reconcileBounce } from '../notifications/bounce.js';
import { AppError } from '../../lib/errors.js';
import { safeEqual } from '../../lib/crypto.js';

/** Mail provider callbacks authenticate with the tenant's callback secret; an anonymous caller gets 401 before any body validation. */
const requireCallbackToken: RequestHandler = (req, _res, next) => {
  const presented = (req.header('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  next(presented ? undefined : AppError.unauthorized('CALLBACK_TOKEN_REQUIRED'));
};

const ProviderHeader = 'x-examos-provider';

/**
 * Simple Integration API (review §5). Authenticated by tenant API keys; the
 * provider (ERP) name comes from the key's connection or the X-ExamOS-Provider
 * header; defaults to `erp`.
 */
export function integrationRoutes(deps: AppDeps): Router {
  const r = Router();
  const limiter = rateLimit(deps, { pool: 'integration', limit: 600, windowSeconds: 60, keyOf: (req) => (req.ctx.principal?.type === 'API_KEY' ? req.ctx.principal.apiKeyId : req.ip ?? 'anon') });

  async function actorFor(req: Request, source: RosterActor['source'] = 'PUSH_API'): Promise<RosterActor> {
    const t = requireTenant(req);
    const p = apiKeyPrincipal(req);
    let provider = (req.header(ProviderHeader) ?? '').trim().toLowerCase();
    if (!provider && p.connectionId) {
      const c = await tenantTx(deps, req, (trx) => trx('tenant_erp_connections').where({ id: p.connectionId }).first('provider'));
      provider = c?.provider ?? '';
    }
    if (!provider) provider = 'erp';
    if (!/^[a-z0-9-]{2,32}$/.test(provider)) throw AppError.badRequest('PROVIDER_INVALID', 'X-ExamOS-Provider must be a short lowercase code');
    return { tenantId: t.id, provider, source, apiKeyId: p.apiKeyId, connectionId: p.connectionId, sourceLabel: p.label };
  }

  r.put(
    '/roster/persons/batch',
    requireApiKey(deps, ['roster:write']),
    limiter,
    idempotent(deps),
    validateBody(PersonBatchSchema),
    asyncHandler(async (req, res) => {
      const actor = await actorFor(req);
      const input = body<typeof PersonBatchSchema>(req);
      res.json(await tenantTx(deps, req, (trx) => upsertPersons(deps, trx, { ...actor, sourceLabel: input.sourceLabel ?? actor.sourceLabel }, input.rows, input.mode)));
    }),
  );
  r.put(
    '/roster/academic-units/batch',
    requireApiKey(deps, ['roster:write']),
    limiter,
    idempotent(deps),
    validateBody(AcademicUnitBatchSchema),
    asyncHandler(async (req, res) => {
      const actor = await actorFor(req);
      const input = body<typeof AcademicUnitBatchSchema>(req);
      res.json(await tenantTx(deps, req, (trx) => upsertAcademicUnits(trx, actor, input.rows, input.mode)));
    }),
  );
  r.put(
    '/roster/courses/batch',
    requireApiKey(deps, ['roster:write']),
    limiter,
    idempotent(deps),
    validateBody(CourseBatchSchema),
    asyncHandler(async (req, res) => {
      const actor = await actorFor(req);
      const input = body<typeof CourseBatchSchema>(req);
      res.json(await tenantTx(deps, req, (trx) => upsertCourses(trx, actor, input.rows, input.mode)));
    }),
  );
  r.put(
    '/roster/enrollments/batch',
    requireApiKey(deps, ['roster:write']),
    limiter,
    idempotent(deps),
    validateBody(EnrollmentBatchSchema),
    asyncHandler(async (req, res) => {
      const actor = await actorFor(req);
      const input = body<typeof EnrollmentBatchSchema>(req);
      res.json(await tenantTx(deps, req, (trx) => upsertEnrollments(trx, actor, input.rows, input.mode)));
    }),
  );
  r.get(
    '/roster/sync-jobs/:id',
    requireApiKey(deps, ['roster:read']),
    limiter,
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const out = await tenantTx(deps, req, async (trx) => {
        const job = await trx('roster_sync_jobs').where({ tenant_id: t.id, id: uuidParam(req, 'id') }).first();
        if (!job) throw AppError.notFound('SYNC_JOB_NOT_FOUND');
        const rows = await trx('roster_sync_rows').where({ job_id: job.id }).orderBy('row_index');
        return { job, rows };
      });
      res.json(out);
    }),
  );

  r.get(
    '/events',
    requireApiKey(deps, ['events:read']),
    limiter,
    validateQuery(EventsFeedQuerySchema),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const q = query<typeof EventsFeedQuerySchema>(req);
      const types = q.types ? q.types.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
      res.json(await tenantTx(deps, req, (trx) => readEventFeed(trx, t.id, q.since, q.limit, types)));
    }),
  );

  r.get(
    '/results',
    requireApiKey(deps, ['results:read']),
    limiter,
    validateQuery(z.object({ examCode: z.string().min(1), since: z.string().datetime().optional() })),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const q = query<ReturnType<typeof z.object>>(req) as { examCode: string; since?: string };
      const actor = await actorFor(req);
      const explicitProvider = (req.header(ProviderHeader) ?? '').trim().toLowerCase() || (actor.connectionId ? actor.provider : null);
      const rows = await tenantTx(deps, req, (trx) =>
        trx('student_exam_records as r')
          .join('exams as e', 'e.id', 'r.exam_id')
          .join('external_identities as x', function () {
            this.on('x.user_id', '=', 'r.user_id').andOn('x.tenant_id', '=', 'r.tenant_id');
          })
          .where({ 'r.tenant_id': t.id, 'e.code': q.examCode })
          .modify((qb) => {
            // SSO identities are login handles, never roster keys
            if (explicitProvider) qb.where('x.provider', explicitProvider);
            else qb.whereNot('x.provider', 'like', 'oidc:%');
          })
          .whereNull('r.superseded_at')
          .modify((qb) => {
            if (q.since) qb.where('r.published_at', '>=', new Date(q.since));
          })
          .select('e.code as examCode', 'e.exam_type as examType', 'e.academic_year as academicYear', 'e.semester', 'x.provider', 'x.external_id as studentExternalId', 'r.hall_ticket_number as hallTicketNumber', 'r.marks', 'r.max_marks as maxMarks', 'r.grade', 'r.published_at as publishedAt', 'r.result_version_id as resultVersionId'),
      );
      res.json({ examCode: q.examCode, results: rows });
    }),
  );

  r.post(
    '/webhooks',
    requireApiKey(deps, ['webhooks:manage']),
    limiter,
    validateBody(WebhookEndpointCreateSchema),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = apiKeyPrincipal(req);
      const input = body<typeof WebhookEndpointCreateSchema>(req);
      const out = await tenantTx(deps, req, (trx) => createWebhookEndpoint(deps, trx, { tenantId: t.id, url: input.url, description: input.description, eventTypes: input.eventTypes, createdBy: null, connectionId: p.connectionId }));
      res.status(201).json({ id: out.id, signingSecret: out.secret });
    }),
  );

  /**
   * Mail delivery callback from the Power Automate flow. Authenticated by the
   * tenant's callback secret (bearer) because flows cannot compute HMACs; the
   * body never carries mail content, only the outcome of a known dispatch id.
   */
  r.post(
    '/mail/callbacks',
    rateLimit(deps, { pool: 'mail-callback', limit: 1200, windowSeconds: 60, keyOf: (req) => req.ip ?? 'anon' }),
    requireCallbackToken,
    validateBody(MailCallbackSchema),
    asyncHandler(async (req, res) => {
      const cb = body<typeof MailCallbackSchema>(req);
      const presented = (req.header('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
      if (!presented) throw AppError.unauthorized('CALLBACK_TOKEN_REQUIRED');
      // The dispatch id names the tenant; the tenant's callback secret must match.
      const dispatch = (await deps.db.transaction(async (trx) => {
        await trx.raw("SELECT set_config('app.bypass_tenant','worker',true)");
        return trx('mail_dispatches').where('id', cb.dispatchId).first('tenant_id');
      })) as { tenant_id: string } | undefined;
      if (!dispatch) throw AppError.notFound('DISPATCH_NOT_FOUND');
      const result = await deps.db.transaction(async (trx) => {
        await trx.raw("SELECT set_config('app.tenant_id', ?, true)", [dispatch.tenant_id]);
        const cfgs = await trx('tenant_mail_configs').where('tenant_id', dispatch.tenant_id).whereNotNull('callback_secret_ref').select('callback_secret_ref');
        let ok = false;
        for (const c of cfgs) {
          const secret = await deps.secrets.resolve(c.callback_secret_ref);
          if (safeEqual(secret, presented)) ok = true;
        }
        if (!ok) throw AppError.unauthorized('CALLBACK_TOKEN_INVALID');
        return applyMailCallback(trx, dispatch.tenant_id, cb);
      });
      res.json({ result });
    }),
  );

  /** Download CSV template for roster batch import (Phase 7). */
  r.get(
    '/roster/templates/:entity',
    requireApiKey(deps, ['roster:read']),
    limiter,
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

  /** Preview CSV upload without persisting (dry-run) (Phase 7). */
  r.post(
    '/roster/preview',
    requireApiKey(deps, ['roster:write']),
    limiter,
    validateBody(XlsxPreviewRequestSchema),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const actor = await actorFor(req, 'XLSX');
      const input = body<typeof XlsxPreviewRequestSchema>(req);
      const result = await tenantTx(deps, req, (trx) =>
        previewRosterImport(deps, trx, t.id, input.entity, input.csvContent, input.mode, input.provider ?? actor.provider),
      );
      res.json(result);
    }),
  );

  /** Execute CSV/XLSX import through the roster service with source='XLSX' (Phase 7). */
  r.post(
    '/roster/import-xlsx',
    requireApiKey(deps, ['roster:write']),
    limiter,
    idempotent(deps),
    validateBody(XlsxImportRequestSchema),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = apiKeyPrincipal(req);
      const actor = await actorFor(req, 'XLSX');
      const input = body<typeof XlsxImportRequestSchema>(req);
      const result = await tenantTx(deps, req, (trx) =>
        executeRosterImport(
          deps,
          trx,
          t.id,
          input.entity,
          input.csvContent,
          input.mode,
          input.provider ?? actor.provider,
          null,
          input.sourceLabel ?? p.label,
        ),
      );
      res.json(result);
    }),
  );

  /** Webhook/Callback for bounce reconciliation (Phase 7). */
  r.post(
    '/mail/bounces',
    rateLimit(deps, { pool: 'mail-callback', limit: 1200, windowSeconds: 60, keyOf: (req) => req.ip ?? 'anon' }),
    requireCallbackToken,
    validateBody(MailBounceReconcileSchema),
    asyncHandler(async (req, res) => {
      const input = body<typeof MailBounceReconcileSchema>(req);
      const presented = (req.header('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
      if (!presented) throw AppError.unauthorized('CALLBACK_TOKEN_REQUIRED');

      // Dispatch matching tenant lookup
      let tenantId: string | null = null;
      if (input.providerMessageId) {
        const found = (await deps.db.transaction(async (trx) => {
          await trx.raw("SELECT set_config('app.bypass_tenant','worker',true)");
          return trx('mail_dispatches').where('provider_message_id', input.providerMessageId).first('tenant_id');
        })) as { tenant_id: string } | undefined;
        tenantId = found?.tenant_id ?? null;
      }
      if (!tenantId) {
        const found = (await deps.db.transaction(async (trx) => {
          await trx.raw("SELECT set_config('app.bypass_tenant','worker',true)");
          return trx('mail_dispatches').where('to_address', input.toAddress.toLowerCase()).orderBy('created_at', 'desc').first('tenant_id');
        })) as { tenant_id: string } | undefined;
        tenantId = found?.tenant_id ?? null;
      }
      if (!tenantId) throw AppError.notFound('DISPATCH_NOT_FOUND', 'No matching dispatch found for bounce');

      const result = await deps.db.transaction(async (trx) => {
        await trx.raw("SELECT set_config('app.tenant_id', ?, true)", [tenantId]);
        const cfgs = await trx('tenant_mail_configs').where('tenant_id', tenantId).whereNotNull('callback_secret_ref').select('callback_secret_ref');
        let ok = false;
        for (const c of cfgs) {
          const secret = await deps.secrets.resolve(c.callback_secret_ref);
          if (safeEqual(secret, presented)) ok = true;
        }
        if (!ok) throw AppError.unauthorized('CALLBACK_TOKEN_INVALID');
        return reconcileBounce(deps, trx, tenantId!, input);
      });

      res.json(result);
    }),
  );

  return r;
}
