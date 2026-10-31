import { Router, type Request } from 'express';
import { z } from 'zod';
import { CandidateApprovalSchema, ControllerAuthorizeSchema } from '@examos/contracts';
import type { AppDeps } from '../../types.js';
import { asyncHandler, validateBody, body, uuidParam } from '../../lib/http.js';
import { requireTenant, tenantTx } from '../../middleware/request-context.js';
import { requireUser, requirePermission, userPrincipal } from '../../middleware/auth.js';
import type { JwtService } from '../auth/jwt.js';
import { runForensicChecks, recordResultVersion, candidateChecklist, approveCandidate, holdCandidate, releaseHold, controllerAuthorizeAndPublish, evaluatorQueue } from './service.js';
import { getCandidatePaper } from '../papers/service.js';
import { getOrRenderBookletPdf, getOrRenderEvidencePdf } from '../documents/service.js';

const ResultItemsBody = z.object({
  items: z
    .array(
      z.object({
        questionId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
        maxMarks: z.number().min(0).max(1000),
        marks: z.number().min(0).max(1000),
        explanation: z.string().trim().min(1).max(4000),
        /** Required when the marks differ from the system's proposal: why the examiner decided otherwise. */
        overrideReason: z.string().trim().min(10).max(2000).optional(),
        criteria: z.array(z.object({ code: z.string().min(1).max(64), max: z.number().min(0), awarded: z.number().min(0), evidence: z.string().max(2000).optional() })).optional(),
      }),
    )
    .min(1)
    .max(200),
});
const HoldBody = z.object({ status: z.enum(['INTEGRITY_HOLD', 'TECHNICAL_REVIEW_REQUIRED', 'IDENTITY_REVIEW_REQUIRED', 'MARKING_MODERATION_REQUIRED']), reason: z.string().trim().min(5).max(2000) });
const ReleaseBody = z.object({ reason: z.string().trim().min(5).max(2000) });

async function examScopeOfAttempt(deps: AppDeps, req: Request): Promise<{ examId?: string }> {
  const t = requireTenant(req);
  const attemptId = uuidParam(req, 'attemptId'); // a malformed id is a 400, never a uuid cast error from PostgreSQL
  const a = await tenantTx(deps, req, (trx) => trx('exam_attempts').where({ tenant_id: t.id, id: attemptId }).first('exam_id'));
  return { examId: a?.exam_id };
}

export function candidateRoutes(deps: AppDeps, jwt: JwtService): Router {
  const r = Router();
  const user = requireUser({ deps, jwt });
  const scoped = (perm: Parameters<typeof requirePermission>[0]) =>
    asyncHandler(async (req, res, next) => {
      const scope = await examScopeOfAttempt(deps, req);
      requirePermission(perm, () => scope)(req, res, next);
    });

  r.get(
    '/queue',
    user,
    requirePermission('marks:approve', (req) => ({ examId: String(req.query['examId'] ?? '') })),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const examId = String(req.query['examId'] ?? '');
      if (!/^[0-9a-f-]{36}$/i.test(examId)) return res.status(400).json({ code: 'INVALID_ID', title: 'examId must be a UUID', status: 400 });
      res.json(await tenantTx(deps, req, (trx) => evaluatorQueue(trx, t.id, examId)));
    }),
  );
  r.post(
    '/:attemptId/forensics/run',
    user,
    scoped('examcell:candidates:read'),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      res.json(await tenantTx(deps, req, (trx) => runForensicChecks(deps, trx, t.id, uuidParam(req, 'attemptId'))));
    }),
  );
  r.post(
    '/:attemptId/result-versions',
    user,
    scoped('marks:approve'),
    validateBody(ResultItemsBody),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      res.status(201).json(await tenantTx(deps, req, (trx) => recordResultVersion(trx, t.id, p.userId, uuidParam(req, 'attemptId'), body<typeof ResultItemsBody>(req).items)));
    }),
  );
  r.get(
    '/:attemptId/paper',
    user,
    scoped('exams:read'),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      res.json(await tenantTx(deps, req, (trx) => getCandidatePaper(deps, trx, t.id, p.userId, uuidParam(req, 'attemptId'))));
    }),
  );

  r.get(
    '/:attemptId/checklist',
    user,
    scoped('examcell:candidates:read'),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      res.json(await tenantTx(deps, req, (trx) => candidateChecklist(trx, t.id, uuidParam(req, 'attemptId'))));
    }),
  );
  r.post(
    '/:attemptId/approvals',
    user,
    scoped('examcell:candidates:approve'),
    validateBody(CandidateApprovalSchema),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      res.status(201).json(await tenantTx(deps, req, (trx) => approveCandidate(trx, t.id, p.userId, uuidParam(req, 'attemptId'), body<typeof CandidateApprovalSchema>(req))));
    }),
  );
  r.post(
    '/:attemptId/holds',
    user,
    scoped('examcell:candidates:approve'),
    validateBody(HoldBody),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      res.json(await tenantTx(deps, req, (trx) => holdCandidate(trx, t.id, p.userId, uuidParam(req, 'attemptId'), body<typeof HoldBody>(req))));
    }),
  );
  r.post(
    '/:attemptId/holds/release',
    user,
    scoped('examcell:candidates:approve'),
    validateBody(ReleaseBody),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      res.json(await tenantTx(deps, req, (trx) => releaseHold(trx, t.id, p.userId, uuidParam(req, 'attemptId'), body<typeof ReleaseBody>(req).reason)));
    }),
  );
  r.post(
    '/:attemptId/authorize-publication',
    user,
    scoped('controller:publish'),
    validateBody(ControllerAuthorizeSchema),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      res.json(await tenantTx(deps, req, (trx) => controllerAuthorizeAndPublish(trx, t.id, p.userId, uuidParam(req, 'attemptId'), body<typeof ControllerAuthorizeSchema>(req))));
    }),
  );
  r.get(
    '/:attemptId/booklet.pdf',
    user,
    scoped('exams:read'),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const host = req.get('host') ?? t.slug;
      const caller = { userId: p.userId, kind: 'STAFF' as const, roles: p.grants.map((g) => g.role) };
      const result = await tenantTx(deps, req, (trx) => getOrRenderBookletPdf(deps, trx, t.id, uuidParam(req, 'attemptId'), caller, host));
      res.setHeader('Content-Type', result.contentType);
      res.setHeader('Content-Disposition', `inline; filename="${result.filename}"`);
      res.setHeader('X-Document-Sha256', result.sha256);
      res.send(result.data);
    }),
  );
  r.get(
    '/:attemptId/evidence.pdf',
    user,
    scoped('examcell:candidates:read'),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const host = req.get('host') ?? t.slug;
      const caller = { userId: p.userId, kind: 'STAFF' as const, roles: p.grants.map((g) => g.role) };
      const result = await tenantTx(deps, req, (trx) => getOrRenderEvidencePdf(deps, trx, t.id, uuidParam(req, 'attemptId'), caller, host));
      res.setHeader('Content-Type', result.contentType);
      res.setHeader('Content-Disposition', `inline; filename="${result.filename}"`);
      res.setHeader('X-Document-Sha256', result.sha256);
      res.send(result.data);
    }),
  );
  return r;
}
