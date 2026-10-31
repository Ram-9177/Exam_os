import { Router, type Request } from 'express';
import { z } from 'zod';
import { CODE_LANGUAGE_CATALOGUE, DEFAULT_SUBJECT_LANGUAGES, SubjectCodeProfileSchema, codeLanguage } from '@examos/contracts';
import type { AppDeps } from '../../types.js';
import { asyncHandler, validateBody, body, uuidParam } from '../../lib/http.js';
import { requireTenant, tenantTx } from '../../middleware/request-context.js';
import { requireUser, requirePermission, userPrincipal } from '../../middleware/auth.js';
import { AppError } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import type { JwtService } from '../auth/jwt.js';
import { languageStatus, checkCodeQuestion } from '../evaluation/judge.js';

const ProfileBody = z.object({ profile: SubjectCodeProfileSchema.nullable() });
const examScope = (req: Request) => ({ examId: req.params['id'] });
const languagesOf = (ids: readonly string[]) => CODE_LANGUAGE_CATALOGUE.filter((l) => ids.includes(l.id)).map(({ id, label, version, group, file }) => ({ id, label, version, group, file }));

/**
 * Coding languages.
 * - GET  /coding/languages            every catalogue language and whether this deployment's sandbox has it (IT, admin)
 * - GET  /coding/subjects             each subject's coding profile (which languages its exams may use)
 * - PUT  /coding/subjects/:code       the Examination Section sets a subject's languages (null = clear)
 * - GET  /exams/:id/code-languages    what the paper editor offers for this exam's coding questions
 * - POST /exams/:id/paper/questions/:questionId/check-code   run the setter's reference solution against the tests
 */
export function codingRoutes(deps: AppDeps, jwt: JwtService): Router {
  const r = Router();
  const user = requireUser({ deps, jwt });

  r.get(
    '/coding/languages',
    user,
    requirePermission('exams:read'),
    asyncHandler(async (_req, res) => {
      res.json(await languageStatus(deps));
    }),
  );

  r.get(
    '/coding/subjects',
    user,
    requirePermission('exams:read'),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const rows = await tenantTx(deps, req, (trx) =>
        trx('courses as c').leftJoin('departments as d', 'd.id', 'c.department_id').where('c.tenant_id', t.id).where('c.status', 'ACTIVE').orderBy('c.code').limit(2000).select('c.code', 'c.name', 'd.code as departmentCode', 'c.code_profile as profile'),
      );
      res.json({ subjects: rows.map((s) => ({ ...s, profile: s.profile ?? null })), defaults: DEFAULT_SUBJECT_LANGUAGES });
    }),
  );

  r.put(
    '/coding/subjects/:code',
    user,
    requirePermission('exams:write'),
    validateBody(ProfileBody),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const code = String(req.params['code'] ?? '');
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(code)) throw AppError.notFound('COURSE_NOT_FOUND');
      const { profile } = body<typeof ProfileBody>(req);
      const out = await tenantTx(deps, req, async (trx) => {
        const course = await trx('courses').where({ tenant_id: t.id, code }).forNoKeyUpdate().first('id', 'code_profile');
        if (!course) throw AppError.notFound('COURSE_NOT_FOUND', `No subject ${code}`);
        const value = profile ? { languages: [...new Set(profile.languages)], default: profile.default ?? profile.languages[0] } : null;
        await trx('courses').where({ id: course.id }).update({ code_profile: value ? JSON.stringify(value) : null, updated_at: trx.fn.now() });
        await audit(trx, { tenantId: t.id, actorType: 'USER', actorId: p.userId, action: 'course.code_profile_set', entityType: 'course', entityId: course.id, requestId: req.ctx.requestId, metadata: { code, before: course.code_profile ?? null, after: value } });
        return value;
      });
      res.json({ code, profile: out });
    }),
  );

  r.get(
    '/exams/:id/code-languages',
    user,
    requirePermission('exams:read', examScope),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const row = await tenantTx(deps, req, (trx) => trx('exams as e').leftJoin('courses as c', 'c.id', 'e.course_id').where({ 'e.tenant_id': t.id, 'e.id': uuidParam(req, 'id') }).first('e.id', 'c.code', 'c.name', 'c.code_profile as profile'));
      if (!row) throw AppError.notFound('EXAM_NOT_FOUND');
      const profile = row.profile as { languages: string[]; default?: string } | null;
      const ids = profile?.languages ?? CODE_LANGUAGE_CATALOGUE.map((l) => l.id);
      res.json({ subject: row.code ? { code: row.code, name: row.name, restricted: !!profile } : null, languages: languagesOf(ids), default: profile?.default ?? (ids.includes('python') ? 'python' : ids[0]), defaultLabel: codeLanguage(profile?.default ?? '')?.label ?? null });
    }),
  );

  r.post(
    '/exams/:id/paper/questions/:questionId/check-code',
    user,
    requirePermission('paper:write', examScope),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const qid = String(req.params['questionId'] ?? '');
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(qid)) throw AppError.notFound('QUESTION_NOT_FOUND');
      res.json(await checkCodeQuestion(deps, t.id, p.userId, uuidParam(req, 'id'), qid, req.ctx.requestId));
    }),
  );

  return r;
}
