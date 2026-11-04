import { Router } from 'express';
import type { Knex } from 'knex';
import { PhotoUploadSchema, UserSignatureUploadSchema } from '@examos/contracts';
import type { AppDeps } from '../../types.js';
import { asyncHandler, validateBody, body } from '../../lib/http.js';
import { AppError } from '../../lib/errors.js';
import { requireTenant, tenantTx } from '../../middleware/request-context.js';
import { grantsAllow, requireUser, userPrincipal } from '../../middleware/auth.js';
import type { Principal } from '../../types.js';
import type { JwtService } from '../auth/jwt.js';
import { updateUserSignature, removeUserSignature } from '../users/service.js';
import {
  getStudentProfile,
  uploadStudentPhoto,
  getStudentPhoto,
  getIdCardData,
  verifyStudentByHash,
} from './service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whose profile this request acts on. A student is always themself. Staff act on
 * themselves freely; reaching another person needs users:read (or the Exam
 * Section's candidate read) and, for changes, users:write. The default for a
 * staff read without ?userId stays the first student, for the staff preview.
 */
async function resolveTargetStudentId(
  trx: Knex.Transaction,
  tenantId: string,
  principal: Extract<Principal, { type: 'USER' }>,
  queryUserId?: unknown,
  access: 'read' | 'write' = 'read',
): Promise<string> {
  if (principal.kind === 'STUDENT') return principal.userId;
  const requested = typeof queryUserId === 'string' ? queryUserId.trim() : '';
  if (requested && !UUID_RE.test(requested)) throw AppError.badRequest('INVALID_USER_ID', 'userId must be a uuid');
  if (access === 'write' && !requested) return principal.userId;
  if (requested === principal.userId) return requested;
  const allowed =
    access === 'write'
      ? grantsAllow(principal.grants, 'users:write')
      : grantsAllow(principal.grants, 'users:read') || grantsAllow(principal.grants, 'examcell:candidates:read');
  if (!allowed) throw AppError.forbidden('PERMISSION_DENIED', 'Your role cannot open another person\'s profile');
  if (requested) return requested;
  const firstStudent = await trx('users').where({ tenant_id: tenantId, kind: 'STUDENT' }).orderBy('created_at', 'asc').first('id');
  return firstStudent?.id ?? principal.userId;
}

export function profileRoutes(deps: AppDeps, jwt: JwtService): Router {
  const r = Router();
  const user = requireUser({ deps, jwt });

  r.get(
    '/profile',
    user,
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const targetUserId = await tenantTx(deps, req, (trx) =>
        resolveTargetStudentId(trx, t.id, p, req.query['userId'])
      );
      const profileData = await tenantTx(deps, req, (trx) =>
        getStudentProfile(deps, trx, t.id, targetUserId),
      );
      res.json({ profile: profileData, ...profileData });
    }),
  );

  r.post(
    '/profile/photo',
    user,
    validateBody(PhotoUploadSchema),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const input = body<typeof PhotoUploadSchema>(req);
      const targetUserId = await tenantTx(deps, req, (trx) =>
        resolveTargetStudentId(trx, t.id, p, req.query['userId'], 'write')
      );
      res.json(await tenantTx(deps, req, (trx) => uploadStudentPhoto(deps, trx, t.id, targetUserId, input, p.userId)));
    }),
  );

  r.get(
    '/profile/photo',
    user,
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const targetUserId = await tenantTx(deps, req, (trx) =>
        resolveTargetStudentId(trx, t.id, p, req.query['userId'])
      );
      const photo = await tenantTx(deps, req, (trx) => getStudentPhoto(deps, trx, t.id, targetUserId));
      res.setHeader('Content-Type', photo.mimeType);
      res.setHeader('X-Document-Sha256', photo.sha256);
      res.send(photo.data);
    }),
  );

  r.get(
    '/profile/signature',
    user,
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const targetUserId = await tenantTx(deps, req, (trx) =>
        resolveTargetStudentId(trx, t.id, p, req.query['userId'])
      );
      const row = await tenantTx(deps, req, (trx) =>
        trx('users')
          .where({ tenant_id: t.id, id: targetUserId })
          .first('signature_data_url as signatureDataUrl', 'signature_updated_at as signatureUpdatedAt')
      );
      if (!row) throw AppError.notFound('USER_NOT_FOUND', 'User not found');
      res.json(row);
    }),
  );

  r.put(
    '/profile/signature',
    user,
    validateBody(UserSignatureUploadSchema),
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const input = body<typeof UserSignatureUploadSchema>(req);
      const targetUserId = await tenantTx(deps, req, (trx) =>
        resolveTargetStudentId(trx, t.id, p, req.query['userId'], 'write')
      );
      const result = await tenantTx(deps, req, (trx) =>
        updateUserSignature(trx, {
          tenantId: t.id,
          userId: targetUserId,
          signatureDataUrl: input.signatureDataUrl,
          actorId: p.userId,
        })
      );
      res.json(result);
    }),
  );

  r.delete(
    '/profile/signature',
    user,
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const targetUserId = await tenantTx(deps, req, (trx) =>
        resolveTargetStudentId(trx, t.id, p, req.query['userId'], 'write')
      );
      const result = await tenantTx(deps, req, (trx) =>
        removeUserSignature(trx, {
          tenantId: t.id,
          userId: targetUserId,
          actorId: p.userId,
        })
      );
      res.json(result);
    }),
  );

  r.get(
    '/profile/id-card',
    user,
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const p = userPrincipal(req);
      const host = req.get('host') ?? t.slug;
      const targetUserId = await tenantTx(deps, req, (trx) =>
        resolveTargetStudentId(trx, t.id, p, req.query['userId'])
      );
      const idCardData = await tenantTx(deps, req, (trx) =>
        getIdCardData(deps, trx, t.id, targetUserId, host),
      );
      res.json({ idCard: idCardData, ...idCardData });
    }),
  );

  r.get(
    '/verify-student/:hash',
    asyncHandler(async (req, res) => {
      const t = requireTenant(req);
      const hash = req.params['hash'] ?? '';
      const verification = await tenantTx(deps, req, (trx) => verifyStudentByHash(deps, trx, t.id, hash));
      res.json({ verification });
    }),
  );

  return r;
}
