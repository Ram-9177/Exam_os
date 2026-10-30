import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  EvaluatorAssignSchema,
  ModerationResolveSchema,
  RevaluationRequestSchema,
  RevaluationDecideSchema,
  SimilarityAnalysisSchema,
} from '@examos/contracts';
import type { AppDeps } from '../../types.js';
import { asyncHandler, validateBody, body, uuidParam } from '../../lib/http.js';
import { requireTenant, tenantTx } from '../../middleware/request-context.js';
import { requireUser, requirePermission, userPrincipal } from '../../middleware/auth.js';
import type { JwtService } from '../auth/jwt.js';
import {
  assignEvaluators,
  listEvaluatorAssignments,
  getEvaluatorQueue,
  recordEvaluatorMarks,
  listModerationSamples,
  resolveModeration,
  requestRevaluation,
  listRevaluationRequests,
  getStudentRevaluationStatus,
  decideRevaluationRequest,
  generateRubricProposals,
  analyzeExamSimilarity,
} from './service.js';

const ResultItemsBody = z.object({
  items: z
    .array(
      z.object({
        questionId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
        maxMarks: z.number().min(0).max(1000),
        marks: z.number().min(0).max(1000),
        explanation: z.string().trim().min(1).max(4000),
        criteria: z
          .array(
            z.object({
              code: z.string().min(1).max(64),
              max: z.number().min(0),
              awarded: z.number().min(0),
              evidence: z.string().max(2000).optional(),
            }),
          )
          .optional(),
      }),
    )
    .min(1)
    .max(200),
});

export function evaluationRoutes(deps: AppDeps, jwt: JwtService): Router {
  const r = Router();
  const user = requireUser({ deps, jwt });

  // 1. Evaluator Assignments & Workload Balancing
  r.post(
    '/exams/:id/evaluators/assign',
    user,
    requirePermission('evaluation:assign', (req) => ({ examId: req.params['id'] })),
    validateBody(EvaluatorAssignSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const examId = uuidParam(req, 'id');
      const input = body<typeof EvaluatorAssignSchema>(req);
      const result = await tenantTx(deps, req, (trx) =>
        assignEvaluators(trx, t.id, p.userId, examId, input),
      );
      res.status(201).json(result);
    }),
  );

  r.get(
    '/exams/:id/evaluators/assignments',
    user,
    requirePermission('exams:read', (req) => ({ examId: req.params['id'] })),
    asyncHandler(async (req: Request, res: Response) => {
      const t = requireTenant(req);
      const examId = uuidParam(req, 'id');
      const result = await tenantTx(deps, req, (trx) =>
        listEvaluatorAssignments(trx, t.id, examId),
      );
      res.json(result);
    }),
  );

  r.get(
    '/evaluator/me/assignments',
    user,
    requirePermission('marks:approve'),
    asyncHandler(async (req: Request, res: Response) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const examId = req.query['examId'] ? String(req.query['examId']) : undefined;
      const result = await tenantTx(deps, req, (trx) =>
        getEvaluatorQueue(trx, t.id, p.userId, examId),
      );
      res.json(result);
    }),
  );

  r.post(
    '/evaluator/me/attempts/:attemptId/marks',
    user,
    requirePermission('marks:approve'),
    validateBody(ResultItemsBody),
    asyncHandler(async (req: Request, res: Response) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const attemptId = uuidParam(req, 'attemptId');
      const { items } = body<typeof ResultItemsBody>(req);
      const result = await tenantTx(deps, req, (trx) =>
        recordEvaluatorMarks(trx, t.id, p.userId, attemptId, items),
      );
      res.status(201).json(result);
    }),
  );

  // 2. Moderation Workflow
  r.get(
    '/exams/:id/moderation/samples',
    user,
    requirePermission('evaluation:moderate', (req) => ({ examId: req.params['id'] })),
    asyncHandler(async (req: Request, res: Response) => {
      const t = requireTenant(req);
      const examId = uuidParam(req, 'id');
      const result = await tenantTx(deps, req, (trx) =>
        listModerationSamples(trx, t.id, examId),
      );
      res.json(result);
    }),
  );

  r.post(
    '/moderation/samples/:sampleId/resolve',
    user,
    requirePermission('evaluation:moderate'),
    validateBody(ModerationResolveSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const sampleId = uuidParam(req, 'sampleId');
      const input = body<typeof ModerationResolveSchema>(req);
      const result = await tenantTx(deps, req, (trx) =>
        resolveModeration(trx, t.id, p.userId, sampleId, input),
      );
      res.json(result);
    }),
  );

  // 3. Revaluation Workflow
  r.post(
    '/student/attempts/:attemptId/revaluation',
    user,
    requirePermission('attempts:own'),
    validateBody(RevaluationRequestSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const attemptId = uuidParam(req, 'attemptId');
      const input = body<typeof RevaluationRequestSchema>(req);
      const result = await tenantTx(deps, req, (trx) =>
        requestRevaluation(trx, t.id, p.userId, attemptId, input),
      );
      res.status(201).json(result);
    }),
  );

  r.get(
    '/student/attempts/:attemptId/revaluation',
    user,
    requirePermission('attempts:own'),
    asyncHandler(async (req: Request, res: Response) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const attemptId = uuidParam(req, 'attemptId');
      const result = await tenantTx(deps, req, (trx) =>
        getStudentRevaluationStatus(trx, t.id, p.userId, attemptId),
      );
      res.json({ revaluation: result });
    }),
  );

  r.get(
    '/exams/:id/revaluation-requests',
    user,
    requirePermission('revaluation:decide', (req) => ({ examId: req.params['id'] })),
    asyncHandler(async (req: Request, res: Response) => {
      const t = requireTenant(req);
      const examId = uuidParam(req, 'id');
      const result = await tenantTx(deps, req, (trx) =>
        listRevaluationRequests(trx, t.id, examId),
      );
      res.json(result);
    }),
  );

  r.post(
    '/revaluation-requests/:requestId/decide',
    user,
    requirePermission('revaluation:decide'),
    validateBody(RevaluationDecideSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const requestId = uuidParam(req, 'requestId');
      const input = body<typeof RevaluationDecideSchema>(req);
      const result = await tenantTx(deps, req, (trx) =>
        decideRevaluationRequest(trx, t.id, p.userId, requestId, input),
      );
      res.json(result);
    }),
  );

  // 4. Gate E: AI Rubric Proposals & Similarity Analysis
  r.get(
    '/candidates/:attemptId/rubric-proposals',
    user,
    requirePermission('marks:approve'),
    asyncHandler(async (req: Request, res: Response) => {
      const t = requireTenant(req);
      const attemptId = uuidParam(req, 'attemptId');
      const result = await tenantTx(deps, req, (trx) =>
        generateRubricProposals(trx, t.id, attemptId),
      );
      res.json(result);
    }),
  );

  r.post(
    '/exams/:id/similarity-analysis',
    user,
    requirePermission('exams:write', (req) => ({ examId: req.params['id'] })),
    validateBody(SimilarityAnalysisSchema),
    asyncHandler(async (req: Request, res: Response) => {
      const t = requireTenant(req);
      const examId = uuidParam(req, 'id');
      const { threshold } = body<typeof SimilarityAnalysisSchema>(req);
      const result = await tenantTx(deps, req, (trx) =>
        analyzeExamSimilarity(trx, t.id, examId, threshold),
      );
      res.json(result);
    }),
  );

  return r;
}

