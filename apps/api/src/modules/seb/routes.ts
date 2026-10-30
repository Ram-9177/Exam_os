import { Router } from 'express';
import type { AppDeps } from '../../types.js';
import { requireTenant, tenantTx } from '../../middleware/request-context.js';
import { requireUser, requirePermission, userPrincipal } from '../../middleware/auth.js';
import { asyncHandler, validateBody, body, uuidParam } from '../../lib/http.js';
import { AppError } from '../../lib/errors.js';
import type { JwtService } from '../auth/jwt.js';
import {
  SebConfigGenerateSchema,
  ExamClientPolicyUpdateSchema,
} from '@examos/contracts';
import {
  generateSebConfig,
  getSebConfigFile,
  updateExamClientPolicy,
} from './service.js';

export function sebRoutes(deps: AppDeps, jwt: JwtService): Router {
  const router = Router();
  const user = requireUser({ deps, jwt });

  // POST /exams/:id/seb-config (Staff: generate / update SEB configuration)
  router.post(
    '/exams/:id/seb-config',
    user,
    requirePermission('exams:write', (req) => ({ examId: req.params['id'] })),
    validateBody(SebConfigGenerateSchema),
    asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const principal = userPrincipal(req);
      const examId = uuidParam(req, 'id');
      const input = body<typeof SebConfigGenerateSchema>(req);
      const host = req.get('host') || 'localhost:4000';

      const result = await tenantTx(deps, req, async (trx) => {
        return generateSebConfig(deps, trx, tenant.id, examId, host, principal.userId, input);
      });

      res.status(201).json(result);
    })
  );

  // GET /exams/:id/seb-config (Staff: download SEB .seb file)
  router.get(
    '/exams/:id/seb-config',
    user,
    requirePermission('exams:read', (req) => ({ examId: req.params['id'] })),
    asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const principal = userPrincipal(req);
      const examId = uuidParam(req, 'id');
      const host = req.get('host') || 'localhost:4000';

      const file = await tenantTx(deps, req, async (trx) => {
        return getSebConfigFile(deps, trx, tenant.id, examId, host, principal.userId);
      });

      res.setHeader('Content-Type', file.mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
      res.setHeader('X-SEB-ConfigKey', file.sebConfigKey);
      res.send(file.content);
    })
  );

  // GET /student/me/exams/:examId/seb-config (Student: download SEB .seb file for their allocated exam)
  router.get(
    '/student/me/exams/:examId/seb-config',
    user,
    asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const principal = userPrincipal(req);
      const examId = uuidParam(req, 'examId');
      const host = req.get('host') || 'localhost:4000';

      const file = await tenantTx(deps, req, async (trx) => {
        // Verify student is allocated to this exam
        const allocation = await trx('exam_allocations')
          .where({ tenant_id: tenant.id, exam_id: examId, user_id: principal.userId })
          .first();
        if (!allocation) {
          throw AppError.forbidden('NOT_ALLOCATED', 'You are not allocated to this examination');
        }
        return getSebConfigFile(deps, trx, tenant.id, examId, host, principal.userId);
      });

      res.setHeader('Content-Type', file.mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
      res.setHeader('X-SEB-ConfigKey', file.sebConfigKey);
      res.send(file.content);
    })
  );

  // PUT /exams/:id/client-policy (Staff: update client builds, subnets, managed endpoint flags)
  router.put(
    '/exams/:id/client-policy',
    user,
    requirePermission('exams:write', (req) => ({ examId: req.params['id'] })),
    validateBody(ExamClientPolicyUpdateSchema),
    asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const principal = userPrincipal(req);
      const examId = uuidParam(req, 'id');
      const input = body<typeof ExamClientPolicyUpdateSchema>(req);

      const result = await tenantTx(deps, req, async (trx) => {
        return updateExamClientPolicy(deps, trx, tenant.id, examId, principal.userId, input);
      });

      res.json(result);
    })
  );

  // GET /exams/:id/client-policy (Staff: get current exam client policy)
  router.get(
    '/exams/:id/client-policy',
    user,
    requirePermission('exams:read', (req) => ({ examId: req.params['id'] })),
    asyncHandler(async (req, res) => {
      const tenant = requireTenant(req);
      const examId = uuidParam(req, 'id');

      const exam = await tenantTx(deps, req, async (trx) => {
        return trx('exams').where({ tenant_id: tenant.id, id: examId }).first();
      });
      if (!exam) throw AppError.notFound('EXAM_NOT_FOUND', 'Exam not found');

      res.json({ policy: exam.policy });
    })
  );

  return router;
}
