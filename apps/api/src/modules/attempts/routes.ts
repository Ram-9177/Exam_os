import { Router, type Request } from 'express';
import { z } from 'zod';
import { AnswerSaveSchema, SubmitSchema, PrecheckItemVerifySchema } from '@examos/contracts';
import type { AppDeps } from '../../types.js';
import { asyncHandler, validateBody, body, uuidParam } from '../../lib/http.js';
import { requireTenant, tenantTx } from '../../middleware/request-context.js';
import { requireUser, requirePermission, userPrincipal } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import type { JwtService } from '../auth/jwt.js';
import { listMyExams, attemptPolicy, startPrecheck, verifyItem, practiceSave, finalizePrecheck, issueEntryGrant, admit, saveAnswer, getAnswer, heartbeat, reconnect, submit } from './service.js';
import { studentLedger, answerBooklet, verifyResult } from '../candidates/service.js';
import { releasePaperForStudent } from '../papers/service.js';
import { getOrRenderBookletPdf, getOrRenderHallTicketPdf } from '../documents/service.js';

const StartPrecheckBody = z.object({ clientBuild: z.string().max(64).nullable().default(null) });
const PracticeSaveBody = z.object({ contentDigest: z.string().regex(/^[a-f0-9]{64}$/) });
const AdmitBody = z.object({ grantToken: z.string().min(20) });

/** Student-facing routes: readiness check, admission, answers, submission, results. */
export function attemptRoutes(deps: AppDeps, jwt: JwtService): Router {
  const r = Router();
  const user = requireUser({ deps, jwt });
  const own = requirePermission('attempts:own');
  // Student exam routes use their own limiter pool so ERP traffic can never starve autosaves (review §4).
  const saveLimiter = rateLimit(deps, { pool: 'student-save', limit: 240, windowSeconds: 60, keyOf: (req) => (req.ctx.principal?.type === 'USER' ? req.ctx.principal.userId : req.ip ?? 'anon') });
  const deviceOf = (req: Request) => (req.header('x-device-session') ?? '').trim() || null;

  r.get(
    '/me/exams',
    user,
    own,
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      res.json({ exams: await tenantTx(deps, req, (trx) => listMyExams(trx, t.id, p.userId)) });
    }),
  );
  r.get(
    '/me/exams/:examId/hall-ticket.pdf',
    user,
    own,
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const host = req.get('host') ?? t.slug;
      const caller = { userId: p.userId, kind: 'STUDENT' as const, roles: p.grants.map((g) => g.role) };
      const result = await tenantTx(deps, req, (trx) => getOrRenderHallTicketPdf(deps, trx, t.id, uuidParam(req, 'examId'), p.userId, caller, host));
      res.setHeader('Content-Type', result.contentType);
      res.setHeader('Content-Disposition', `inline; filename="${result.filename}"`);
      res.setHeader('X-Document-Sha256', result.sha256);
      res.send(result.data);
    }),
  );
  r.get(
    '/me/ledger',
    user,
    own,
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      res.json(await tenantTx(deps, req, (trx) => studentLedger(trx, t.id, p.userId)));
    }),
  );

  /** What the readiness screen needs before it starts: policy version for consent, which checks are mandatory, which are optional. */
  r.get(
    '/attempts/:id/policy',
    user,
    own,
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      res.json(await tenantTx(deps, req, (trx) => attemptPolicy(trx, t.id, p.userId, uuidParam(req, 'id'))));
    }),
  );

  r.get(
    '/attempts/:id/paper',
    user,
    own,
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      res.json(await tenantTx(deps, req, (trx) => releasePaperForStudent(deps, trx, t.id, p.userId, uuidParam(req, 'id'))));
    }),
  );
  r.post(
    '/attempts/:id/prechecks',
    user,
    own,
    validateBody(StartPrecheckBody),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      res.status(201).json(await tenantTx(deps, req, (trx) => startPrecheck(trx, t.id, p.userId, uuidParam(req, 'id'), body<typeof StartPrecheckBody>(req).clientBuild)));
    }),
  );
  r.post(
    '/prechecks/:runId/items/verify',
    user,
    own,
    validateBody(PrecheckItemVerifySchema),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const ev = body<typeof PrecheckItemVerifySchema>(req);
      const requestUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
      const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || req.socket.remoteAddress || '';
      const checks = await tenantTx(deps, req, (trx) =>
        verifyItem(deps, trx, t.id, p.userId, uuidParam(req, 'runId'), {
          ...ev,
          requestUrl,
          clientIp,
          userAgent: req.get('user-agent') ?? undefined,
          sebConfigKeyHash: req.header('x-safeexambrowser-configkeyhash') ?? undefined,
          sebBrowserExamKeyHash: req.header('x-safeexambrowser-requesthash') ?? undefined,
        }),
      );
      res.json({ checks });
    }),
  );
  r.post(
    '/prechecks/:runId/practice-saves',
    user,
    own,
    validateBody(PracticeSaveBody),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      res.json(await tenantTx(deps, req, (trx) => practiceSave(trx, t.id, p.userId, uuidParam(req, 'runId'), body<typeof PracticeSaveBody>(req).contentDigest)));
    }),
  );
  r.post(
    '/prechecks/:runId/finalize',
    user,
    own,
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      res.json(await tenantTx(deps, req, (trx) => finalizePrecheck(deps, trx, t.id, p.userId, uuidParam(req, 'runId'))));
    }),
  );
  r.post(
    '/attempts/:id/entry-grants',
    user,
    own,
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      res.status(201).json(await tenantTx(deps, req, (trx) => issueEntryGrant(deps, trx, t.id, p.userId, uuidParam(req, 'id'))));
    }),
  );
  r.post(
    '/attempts/:id/admit',
    user,
    own,
    validateBody(AdmitBody),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      res.json(await tenantTx(deps, req, (trx) => admit(deps, trx, t.id, p.userId, uuidParam(req, 'id'), body<typeof AdmitBody>(req).grantToken)));
    }),
  );
  r.put(
    '/attempts/:id/answers/:questionId',
    user,
    own,
    saveLimiter,
    validateBody(AnswerSaveSchema),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const questionId = String(req.params['questionId']);
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(questionId)) return res.status(400).json({ code: 'INVALID_QUESTION_ID' });
      res.json(await tenantTx(deps, req, (trx) => saveAnswer(deps, trx, t.id, p.userId, uuidParam(req, 'id'), questionId, body<typeof AnswerSaveSchema>(req), deviceOf(req))));
    }),
  );
  r.get(
    '/attempts/:id/answers/:questionId',
    user,
    own,
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      res.json(await tenantTx(deps, req, (trx) => getAnswer(trx, t.id, p.userId, uuidParam(req, 'id'), String(req.params['questionId']))));
    }),
  );
  r.post(
    '/attempts/:id/heartbeat',
    user,
    own,
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      res.json(await tenantTx(deps, req, (trx) => heartbeat(deps, trx, t.id, p.userId, uuidParam(req, 'id'), deviceOf(req), req.ip ?? null)));
    }),
  );
  r.post(
    '/attempts/:id/reconnect',
    user,
    own,
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      res.json(await tenantTx(deps, req, (trx) => reconnect(deps, trx, t.id, p.userId, uuidParam(req, 'id'), deviceOf(req))));
    }),
  );
  r.post(
    '/attempts/:id/submit',
    user,
    own,
    validateBody(SubmitSchema),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      res.json(await tenantTx(deps, req, (trx) => submit(deps, trx, t.id, p.userId, uuidParam(req, 'id'), body<typeof SubmitSchema>(req).idempotencyKey)));
    }),
  );
  r.get(
    '/attempts/:id/booklet',
    user,
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const isStaff = p.grants.some((g) => ['EVALUATOR', 'MODERATOR', 'EXAM_CELL_OPERATOR', 'CONTROLLER', 'HOD'].includes(g.role));
      res.json(await tenantTx(deps, req, (trx) => answerBooklet(trx, t.id, uuidParam(req, 'id'), { userId: p.userId, isStaff })));
    }),
  );
  r.get(
    '/attempts/:id/booklet.pdf',
    user,
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const isStaff = p.grants.some((g) => ['EVALUATOR', 'MODERATOR', 'EXAM_CELL_OPERATOR', 'CONTROLLER', 'HOD'].includes(g.role));
      const host = req.get('host') ?? t.slug;
      const caller = { userId: p.userId, kind: isStaff ? ('STAFF' as const) : ('STUDENT' as const), roles: p.grants.map((g) => g.role) };
      const result = await tenantTx(deps, req, (trx) => getOrRenderBookletPdf(deps, trx, t.id, uuidParam(req, 'id'), caller, host));
      res.setHeader('Content-Type', result.contentType);
      res.setHeader('Content-Disposition', `inline; filename="${result.filename}"`);
      res.setHeader('X-Document-Sha256', result.sha256);
      res.send(result.data);
    }),
  );
  r.get(
    '/verify/:attemptId/:version',
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const version = Number(req.params['version']);
      if (!Number.isInteger(version)) return res.status(400).json({ valid: false });
      res.json(await tenantTx(deps, req, (trx) => verifyResult(trx, t.id, uuidParam(req, 'attemptId'), version)));
    }),
  );
  return r;
}
