import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  ExamCreateSchema,
  AllocationSchema,
  AdmissionExceptionSchema,
  HallTicketIssueSchema,
  PaperUpsertSchema,
  PaperSetCreateSchema,
  PaperReviewDecisionSchema,
  type ExamStatus,
  type PaperSetCreate,
} from '@examos/contracts';
import type { AppDeps } from '../../types.js';
import { asyncHandler, validateBody, body, uuidParam } from '../../lib/http.js';
import { requireTenant, tenantTx } from '../../middleware/request-context.js';
import { requireUser, requirePermission, userPrincipal, grantsAllow } from '../../middleware/auth.js';
import type { JwtService } from '../auth/jwt.js';
import { createExam, transitionExam, allocateStudents, issueHallTickets, readinessBoard, grantAdmissionException, assertExportAllowed } from './service.js';
import { listCandidates } from '../candidates/service.js';
import { getExamPaper, upsertExamPaper, submitPaperForReview, reviewPaper, createPaperSets } from '../papers/service.js';
import { getOrRenderHallTicketPdf } from '../documents/service.js';

const examScope = (req: Request) => ({ examId: req.params['id'] });
const ProviderBody = z.object({ provider: z.string().regex(/^[a-z0-9-]{2,32}$/).default('erp') });
const PaperRejectBody = PaperReviewDecisionSchema.omit({ decision: true });
const PaperSetsBody = z.object({ sets: z.array(PaperSetCreateSchema).min(1) });

export function examRoutes(deps: AppDeps, jwt: JwtService): Router {
  const r = Router();
  const user = requireUser({ deps, jwt });

  r.post(
    '/',
    user,
    requirePermission('exams:write'),
    validateBody(ExamCreateSchema),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const id = await tenantTx(deps, req, (trx) => createExam(trx, t.id, p.userId, body<typeof ExamCreateSchema>(req)));
      res.status(201).json({ examId: id });
    }),
  );

  // Hierarchical, filterable list so a tenant with many schools/departments never sees one flat list (second brief).
  r.get(
    '/',
    user,
    requirePermission('exams:read'),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const f = { status: req.query['status'], examType: req.query['examType'], academicYear: req.query['academicYear'], semester: req.query['semester'], departmentCode: req.query['departmentCode'], schoolCode: req.query['schoolCode'], q: req.query['q'] } as Record<string, string | undefined>;
      const rows = await tenantTx(deps, req, (trx) =>
        trx('exams as e')
          .leftJoin('courses as c', 'c.id', 'e.course_id')
          .leftJoin('departments as d', 'd.id', 'c.department_id')
          .leftJoin('schools as s', 's.id', 'd.school_id')
          .where('e.tenant_id', t.id)
          .modify((qb) => {
            if (f.status) qb.where('e.status', f.status);
            if (f.examType) qb.where('e.exam_type', f.examType);
            if (f.academicYear) qb.where('e.academic_year', f.academicYear);
            if (f.semester) qb.where('e.semester', Number(f.semester));
            if (f.departmentCode) qb.where('d.code', f.departmentCode);
            if (f.schoolCode) qb.where('s.code', f.schoolCode);
            if (f.q) qb.andWhere((w) => w.whereILike('e.title', `%${f.q}%`).orWhereILike('e.code', `%${f.q}%`));
          })
          .select('e.id', 'e.code', 'e.title', 'e.status', 'e.exam_type as examType', 'e.academic_year as academicYear', 'e.semester', 'e.security_profile as securityProfile', 'e.duration_minutes as durationMinutes', 'e.window_start_at as windowStartAt', 'e.window_end_at as windowEndAt', 'c.code as courseCode', 'c.name as courseName', 'd.code as departmentCode', 'd.name as departmentName', 's.code as schoolCode', 's.name as schoolName')
          .orderBy('e.window_start_at', 'desc')
          .limit(500),
      );
      res.json({ exams: rows });
    }),
  );

  r.get(
    '/:id',
    user,
    requirePermission('exams:read', examScope),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const exam = await tenantTx(deps, req, (trx) => trx('exams').where({ tenant_id: t.id, id: uuidParam(req, 'id') }).first());
      if (!exam) return res.status(404).json({ code: 'EXAM_NOT_FOUND' });
      const counts = await tenantTx(deps, req, (trx) => trx('exam_attempts').where({ tenant_id: t.id, exam_id: exam.id }).select('status').count<{ status: string; count: string }[]>('id as count').groupBy('status'));
      res.json({ exam, attemptCounts: Object.fromEntries(counts.map((c) => [c.status, Number(c.count)])) });
    }),
  );

  r.get(
    '/:id/paper',
    user,
    requirePermission('exams:read', examScope),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const paper = await tenantTx(deps, req, (trx) =>
        getExamPaper(deps, trx, t.id, p.userId, uuidParam(req, 'id'), { isStaff: true, requestId: req.ctx.requestId }),
      );
      if (!paper) return res.status(404).json({ code: 'PAPER_NOT_FOUND' });
      res.json({ paper });
    }),
  );

  r.put(
    '/:id/paper',
    user,
    requirePermission('paper:write', examScope),
    validateBody(PaperUpsertSchema),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const result = await tenantTx(deps, req, (trx) =>
        upsertExamPaper(deps, trx, t.id, p.userId, uuidParam(req, 'id'), body<typeof PaperUpsertSchema>(req), req.ctx.requestId),
      );
      res.json(result);
    }),
  );

  r.post(
    '/:id/paper/submit-for-review',
    user,
    requirePermission('paper:write', examScope),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const result = await tenantTx(deps, req, (trx) =>
        submitPaperForReview(deps, trx, t.id, p.userId, uuidParam(req, 'id'), req.ctx.requestId),
      );
      res.json(result);
    }),
  );

  r.post(
    '/:id/paper/approve',
    user,
    requirePermission('paper:review', examScope),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const result = await tenantTx(deps, req, (trx) =>
        reviewPaper(deps, trx, t.id, p.userId, uuidParam(req, 'id'), { decision: 'APPROVE' }, req.ctx.requestId),
      );
      res.json(result);
    }),
  );

  r.post(
    '/:id/paper/reject',
    user,
    requirePermission('paper:review', examScope),
    validateBody(PaperRejectBody),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const b = body<typeof PaperRejectBody>(req);
      const result = await tenantTx(deps, req, (trx) =>
        reviewPaper(deps, trx, t.id, p.userId, uuidParam(req, 'id'), { decision: 'REJECT', feedback: b.feedback }, req.ctx.requestId),
      );
      res.json(result);
    }),
  );

  r.post(
    '/:id/paper/sets',
    user,
    requirePermission('paper:write', examScope),
    validateBody(PaperSetsBody),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const b = body<typeof PaperSetsBody>(req);
      const result = await tenantTx(deps, req, (trx) =>
        createPaperSets(deps, trx, t.id, p.userId, uuidParam(req, 'id'), b.sets, req.ctx.requestId),
      );
      res.json(result);
    }),
  );

  for (const [path, to, perm] of [
    ['/:id/submit-for-review', 'PAPER_REVIEW', 'exams:write'],
    ['/:id/approve', 'APPROVED', 'exams:write'],
    ['/:id/schedule', 'SCHEDULED', 'exams:write'],
    ['/:id/open-precheck', 'PRECHECK', 'exams:conduct'],
    ['/:id/start', 'LIVE', 'exams:conduct'],
    ['/:id/close', 'CLOSED', 'exams:conduct'],
    ['/:id/archive', 'ARCHIVED', 'exams:write'],
    ['/:id/cancel', 'CANCELLED', 'exams:write'],
  ] as const) {
    r.post(
      path,
      user,
      requirePermission(perm, examScope),
      asyncHandler(async (req, res) => {
        const t = requireTenant(req);
        const p = userPrincipal(req);
        res.json(await tenantTx(deps, req, (trx) => transitionExam(trx, t.id, p.userId, uuidParam(req, 'id'), to as ExamStatus, req.ctx.requestId)));
      }),
    );
  }

  r.post(
    '/:id/allocations',
    user,
    requirePermission('exams:allocate', examScope),
    validateBody(AllocationSchema.merge(ProviderBody)),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const input = body<typeof AllocationSchema>(req) as z.infer<typeof AllocationSchema> & { provider: string };
      res.json(await tenantTx(deps, req, (trx) => allocateStudents(trx, t.id, p.userId, uuidParam(req, 'id'), input.provider, input)));
    }),
  );

  r.post(
    '/:id/hall-tickets',
    user,
    requirePermission('halltickets:issue', examScope),
    validateBody(HallTicketIssueSchema),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      res.json(await tenantTx(deps, req, (trx) => issueHallTickets(trx, t.id, p.userId, uuidParam(req, 'id'), body<typeof HallTicketIssueSchema>(req).numbers)));
    }),
  );

  r.get(
    '/:id/hall-tickets/:userId/pdf',
    user,
    requirePermission('exams:read', examScope),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const host = req.get('host') ?? t.slug;
      const caller = { userId: p.userId, kind: 'STAFF' as const, roles: p.grants.map((g) => g.role) };
      const result = await tenantTx(deps, req, (trx) => getOrRenderHallTicketPdf(deps, trx, t.id, uuidParam(req, 'id'), uuidParam(req, 'userId'), caller, host));
      res.setHeader('Content-Type', result.contentType);
      res.setHeader('Content-Disposition', `inline; filename="${result.filename}"`);
      res.setHeader('X-Document-Sha256', result.sha256);
      res.send(result.data);
    }),
  );

  r.get(
    '/:id/readiness',
    user,
    requirePermission('exams:conduct', examScope),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      res.json(await tenantTx(deps, req, (trx) => readinessBoard(trx, t.id, uuidParam(req, 'id'))));
    }),
  );

  r.post(
    '/:id/attempts/:attemptId/admission-exceptions',
    user,
    requirePermission('preflight:override', examScope),
    validateBody(AdmissionExceptionSchema),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const canOverrideSecurity = grantsAllow(p.grants, 'preflight:override-security', { examId: req.params['id'] });
      const id = await tenantTx(deps, req, (trx) => grantAdmissionException(trx, t.id, { userId: p.userId, canOverrideSecurity }, uuidParam(req, 'attemptId'), body<typeof AdmissionExceptionSchema>(req)));
      res.status(201).json({ exceptionId: id });
    }),
  );

  r.get(
    '/:id/candidates',
    user,
    requirePermission('examcell:candidates:read', examScope),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      res.json(await tenantTx(deps, req, (trx) => listCandidates(trx, t.id, uuidParam(req, 'id'))));
    }),
  );

  /** Export lock demonstration: script export is refused while the exam is PRECHECK/LIVE and the Examination Section is alerted. */
  r.get(
    '/:id/exports/scripts',
    user,
    requirePermission('exports:read', examScope),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const out = await tenantTx(deps, req, async (trx) => {
        await assertExportAllowed(deps, trx, t.id, uuidParam(req, 'id'), p.userId, 'scripts');
        return trx('exam_attempts as a').join('users as u', 'u.id', 'a.user_id').where({ 'a.tenant_id': t.id, 'a.exam_id': req.params['id'] }).whereIn('a.status', ['SUBMITTED', 'EXPIRED']).select('a.id as attemptId', 'u.full_name as fullName', 'a.status', 'a.sealed_at as sealedAt');
      });
      res.json({ scripts: out });
    }),
  );
  return r;
}
