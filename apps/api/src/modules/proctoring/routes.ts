import { Router, type Request } from 'express';
import { z } from 'zod';
import { ProctorEventIngestSchema, ProctorDecisionSchema, ResumeSchema, TechnicalHoldSchema } from '@examos/contracts';
import type { AppDeps } from '../../types.js';
import { asyncHandler, validateBody, body, uuidParam, validateQuery, query } from '../../lib/http.js';
import { requireTenant, tenantTx } from '../../middleware/request-context.js';
import { requireUser, requirePermission, userPrincipal } from '../../middleware/auth.js';
import type { JwtService } from '../auth/jwt.js';
import { ingestEvents, listIncidents, decideIncident, technicalHold, resumeAttempt, attemptTimeline } from './service.js';
import { AppError } from '../../lib/errors.js';

const ListQuery = z.object({ examId: z.string().uuid().optional(), status: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) });

async function examScopeOfIncident(deps: AppDeps, req: Request): Promise<{ examId?: string }> {
  const t = requireTenant(req);
  const inc = await tenantTx(deps, req, (trx) => trx('proctor_incidents').where({ tenant_id: t.id, id: req.params['id'] }).first('exam_id'));
  return { examId: inc?.exam_id };
}

export function proctorRoutes(deps: AppDeps, jwt: JwtService): Router {
  const r = Router();
  const user = requireUser({ deps, jwt });

  /**
   * Client signal ingest. The student's own client reports FOCUS_LOST etc. for
   * its own attempt; the source id is the student's user id. Signals never
   * count by themselves (spec §9).
   */
  r.post(
    '/events',
    user,
    validateBody(ProctorEventIngestSchema),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const input = body<typeof ProctorEventIngestSchema>(req);
      const out = await tenantTx(deps, req, async (trx) => {
        const attemptIds = [...new Set(input.events.map((e) => e.attemptId))];
        const owned = await trx('exam_attempts').whereIn('id', attemptIds).where({ tenant_id: t.id, user_id: p.userId }).select('id');
        if (owned.length !== attemptIds.length) throw AppError.forbidden('NOT_OWN_ATTEMPT', 'Clients may only report signals for their own attempt');
        return ingestEvents(deps, trx, t.id, `CLIENT:${p.userId}`, input.events);
      });
      res.status(202).json({ results: out });
    }),
  );

  r.get(
    '/incidents',
    user,
    requirePermission('proctor:incidents:read'),
    validateQuery(ListQuery),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const q = query<typeof ListQuery>(req);
      res.json({ incidents: await tenantTx(deps, req, (trx) => listIncidents(trx, t.id, q)) });
    }),
  );

  r.post(
    '/incidents/:id/decision',
    user,
    validateBody(ProctorDecisionSchema),
    asyncHandler(async (req, res, next) => {
      const scope = await examScopeOfIncident(deps, req);
      requirePermission('proctor:incidents:decide', () => scope)(req, res, (err?: unknown) => {
        if (err) return next(err);
        const t = requireTenant(req);
        const p = userPrincipal(req);
        tenantTx(deps, req, (trx) => decideIncident(deps, trx, t.id, p.userId, uuidParam(req, 'id'), body<typeof ProctorDecisionSchema>(req)))
          .then((out) => res.json(out))
          .catch(next);
      });
    }),
  );

  r.post(
    '/attempts/:id/technical-holds',
    user,
    requirePermission('proctor:attempts:hold'),
    validateBody(TechnicalHoldSchema),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      res.json(await tenantTx(deps, req, (trx) => technicalHold(deps, trx, t.id, p.userId, uuidParam(req, 'id'), body<typeof TechnicalHoldSchema>(req))));
    }),
  );

  r.post(
    '/attempts/:id/resume',
    user,
    requirePermission('proctor:attempts:resume'),
    validateBody(ResumeSchema),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      res.json(await tenantTx(deps, req, (trx) => resumeAttempt(deps, trx, t.id, p.userId, uuidParam(req, 'id'), body<typeof ResumeSchema>(req))));
    }),
  );

  r.get(
    '/attempts/:id/timeline',
    user,
    requirePermission('attempts:read'),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      res.json(await tenantTx(deps, req, (trx) => attemptTimeline(trx, t.id, uuidParam(req, 'id'))));
    }),
  );
  return r;
}
